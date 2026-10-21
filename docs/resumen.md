# Resumen de arquitectura

## 1. Idea general

Hay **una sola aplicación** (API REST) y **cuatro motores**: MongoDB, Redis, Cassandra y Neo4j.

> **Las bases no se comunican entre sí. Toda la comunicación pasa por la aplicación.**

No hay replicación ni transacciones entre motores. Lo que se comparte son **identificadores** (`playerId`, `matchId`, etc.), **copias deliberadas** de algunos datos y **proyecciones** (procesos que leen de un motor y escriben en otro de forma repetible).

```
cliente → API → { MongoDB, Redis, Cassandra, Neo4j }
```

| Motor | Rol | Por qué |
|---|---|---|
| **MongoDB** | Verdad durable: jugadores, modos, regiones, sanciones, reportes, partidas. | Documentos, updates puntuales, validadores e índices. |
| **Redis** | Estado vivo: colas, reservas, marcador, leaderboards, retenciones. | Scripts atómicos, estructuras ordenadas, milisegundos. |
| **Cassandra** | Datos masivos de escritura única: eventos e historial. | Partición por partida/jugador, lectura ordenada por tiempo. |
| **Neo4j** | Relaciones jugador–partida. | La consulta es un recorrido, no un join. |

Cada motor se usa porque el **patrón de acceso** lo justifica. Redis nunca es solo una caché de Mongo: guarda estado con ciclo de vida propio o resuelve algo que otro motor no puede (la posición en un ranking).

### Reglas transversales

- **Dueño y copias:** cada dato tiene un dueño; las copias se aceptan si se escriben en orden, se pueden reconstruir y hay un módulo responsable.
- **Idempotencia:** cada operación crítica recibe un id de quien llama (`ticketId`, `matchId`, `eventId`, `closureId`, `sanctionId`). Repetir con el mismo id no duplica; reusarlo con otros datos da conflicto.
- **Orden de escrituras:** primero lo durable y autoritativo, al final lo derivado. Si algo falla, el sistema queda **atrasado**, nunca adelantado.
- **Atomicidad:** dentro de un motor y dentro de un script Lua es real; entre motores no existe. Se usan **sagas**: pasos idempotentes + compensar hacia atrás o completar hacia adelante.
- **Modelado por consulta:** cada tabla/colección responde una pregunta concreta; por eso un mismo hecho aparece en varios lugares.

---

## 2. Problema 1 — Entrar a la cola

**Pide:** un jugador entra a la cola de un modo/región. No puede estar en dos colas, ni con partida activa o sanción. Escritura.

**Motores:** Mongo (solo lectura para validar), Redis (escritura).

**Flujo:** leer jugador/cuenta/modo/región/sanción en Mongo → ejecutar un script Lua en Redis → volver a chequear sanciones.

**Decisiones clave:**
- **Un solo script Lua hace control y escritura.** Verifica ticket existente (reintento o "ya en cola"), partida activa, y si no, escribe ticket + dos conjuntos ordenados. 50 pedidos simultáneos producen un solo ticket.
- **Dos colas por modo/región:** una ordenada por **MMR** (P2 busca ratings parecidos) y otra por **antigüedad** (buscar al que más espera).
- **El ticket garantiza una sola cola por jugador.** No expira; los obsoletos los resuelve P2.
- **El MMR se copia al ticket.** No puede quedar viejo: un jugador en cola no juega ni es sancionado.
- **Doble chequeo de sanción** después de encolar, para cubrir una sanción creada en el medio.

**Fallas:** alta atómica; reintento con el mismo `ticketId` devuelve el existente.

---

## 3. Problema 2 — Formar la partida

**Pide:** agrupar jugadores por rating similar, crear la partida y sacarlos de la cola. Si la espera crece, ampliar el rango. **Falla:** si alguien abandona o falla la creación, los demás vuelven a la cola **conservando antigüedad**.

**Motores:** Redis (cola, reserva, diario, partida viva), Mongo (configuración y registro durable).

**Selección:** ancla = el que más espera → rango = `min(tope, rangoInicial + paso × espera/intervalo)` → candidatos por rango de MMR → ordenar por antigüedad → si no llega al mínimo, no se escribe nada.

**Saga:**
| Paso | Acción | Si falla |
|---|---|---|
| A. Reservar (Redis, Lua) | Verifica todos los tickets, los saca de las colas, guarda snapshot y marca partida activa | No se escribió nada |
| B. Crear partida (Mongo) | Inserta por `matchId`, idempotente | Se restaura Redis |
| C. Confirmar (Redis, Lua) | Crea la partida viva y marca la formación confirmada | Se borra Mongo y se restaura Redis |

**Decisiones clave:**
- **Reserva atómica todo-o-nada**, primero: es el punto de contención y es barata de deshacer.
- **Snapshot inmutable de los tickets:** permite restaurar MMR y `enqueuedAt` originales, es decir, la antigüedad.
- **Diario de la saga en Redis:** `reservada → confirmada | revertida`. Si el proceso muere queda `reservada` y una recuperación compensa las viejas (idempotente).
- **`active_match` desde la reserva:** impide reencolarse durante la formación.
- **Abandono:** si el jugador no tiene ticket pero su partida activa apunta a una formación reservada, se registra el abandono; al confirmar se revierte y se restaura a todos menos a él.

**Límites:** el rango se mide contra el ancla; no se asignan equipos (por eso P4 recibe los resultados declarados).

---

## 4. Problema 3 — Eventos y marcador en vivo

**Pide:** recibir eventos con milisegundos, consultar el marcador al instante y conservar **todos** los eventos. 100 partidas simultáneas.

**Motores:** Cassandra (log inmutable, verdad de qué pasó), Redis (marcador vivo). Mongo no interviene.

**Flujo:** validar en Redis que la partida está viva y el jugador pertenece → escribir en Cassandra → aplicar al marcador con un script Lua.

**Decisiones clave:**
- **Cassandra primero.** Si falla Redis, el evento está a salvo y el marcador se repara. Al revés, habría puntos sin evento que los explique.
- **No hay rollback:** un evento es un hecho, no una operación a deshacer. Se repara el marcador hacia adelante.
- **El marcador no es caché del log:** agrega contadores que el log no puede leer instantáneamente (sumar toda la partición en cada lectura).
- **Idempotencia con Lua:** incrementar no es idempotente; el script anota el `eventId` y **solo suma si es nuevo**, en un paso indivisible. No se usan dos comandos separados porque una caída entre ellos perdería el conteo para siempre.
- **El script exige partida "en curso":** cuando P4 empieza a cerrar, deja de aplicar.
- **Puntos fijados al registrar:** se guardan en el log, así un recálculo futuro no cambia con las reglas.
- **Tabla:** partición = partida, orden por `timestamp + eventId` (desempata eventos del mismo ms y hace idempotente la escritura). Sin expiración.
- **Reconciliación:** lee todo el log y lo reaplica; los ya aplicados se saltean. Rellena huecos y reconstruye el marcador.

**Límite:** la reconciliación necesita la partida viva en Redis.

---

## 5. Problema 4 — Cerrar la partida y puntuar

**Pide:** dejar de aceptar eventos, guardar el fin, marcar terminada, liberar jugadores, borrar estado vivo, reconstruir el resultado y aplicar rating.

**Motores:** Redis (puerta de eventos, estado vivo, liberación), Cassandra (fin durable), Mongo (estado, snapshot, rating).

**Dos máquinas de estado separadas:**
```
Partida:    en curso → cerrando → cerrada        (→ anulada, P8)
Puntuación: sin empezar → pendiente → calculando → aplicada
                                          └→ fallida → calculando
```
Una partida puede estar **cerrada** con puntuación **fallida**. Cerrar y liberar tiene prioridad sobre calcular.

**Flujo:**
1. Validar en Mongo.
2. Redis: `en curso → cerrando` guardando `closureId`.
3. Mongo: mismo cambio + datos del cierre. *(Si falla, se revierte Redis.)*
4. **Cassandra: insertar `match_finished`** ← punto de no retorno.
5. Redis: script atómico libera a todos los jugadores de esa partida y borra las claves vivas.
6. Mongo: `cerrada`, puntuación `pendiente`.
7. Leer Cassandra por páginas, reducir eventos de juego, aplicar rating, guardar resultado final.
8. Publicar leaderboard (P5), último paso.

**Decisiones clave:**
- **El rollback termina antes de Cassandra.** Después de liberar, un jugador puede reencolarse o entrar a otra partida; reabrir dejaría estados incompatibles. Antes se compensa; después solo se completa.
- **Liberación en un solo Lua:** verifica estado y `closureId`, borra el puntero de cada jugador solo si apunta a esta partida y borra las claves vivas.
- **Recibo de liberación con 24 h:** un reintento reconoce "ya liberado" y no toca la partida nueva del jugador.
- **El resultado final sale de Cassandra, no del marcador de Redis.** Redis es para el instante; el log es la verdad.
- **Rating fijo y conmutativo:** victoria +25, derrota −25, empate 0. Procesar partidas fuera de orden da lo mismo.
- **Rating idempotente por (partida, jugador):** cada jugador guarda qué partidas ya se le aplicaron; un reintento omite los hechos.
- **Snapshot final:** MMR antes, delta y MMR después (lo usa P6).

**Fallas:** antes de Cassandra se vuelve atrás; después solo se avanza. Si falla el scoring, la partida queda cerrada, los jugadores libres y se responde 202 para reintentar.

**Límite:** no hay worker; el reintento explícito recupera lo pendiente. Se asume que el servidor de juego drena eventos antes de enviar el fin.

---

## 6. Problema 5 — Leaderboard

**Pide:** top 100 por modo/temporada, global o regional, y posición de un jugador con 5 arriba y 5 abajo, en milisegundos.

**Motores:** Redis (orden y posición), Mongo (rating, registro de temporada, perfil, catálogos).

**Lectura:** validar catálogos en Mongo → un script Lua en Redis devuelve top o posición+vecinos (juntos, para que describan el mismo instante) → Mongo trae nombres y países por id.

**Escritura (en P4):** aplicar rating en Mongo → publicar en Redis → marcar en Mongo.

**Decisiones clave:**
- **Redis aporta lo que Mongo no tiene: la posición.** Contar cuántos están por encima en un índice cuesta O(posición); el conjunto ordenado lo hace en O(log N). Medición con 50.000 jugadores: 0,26 ms vs. 6,3 ms.
- **Se publica el valor absoluto, nunca un incremento.** Cada jugador tiene una `revision`; Redis ignora publicaciones más viejas, así un reintento tardío no pisa un resultado nuevo.
- **Toda la partida se publica en una sola operación atómica:** nadie ve la partida aplicada a medias.
- **El hash de miembros guarda revisión y región:** permite **mover** a un jugador de tablero regional en vez de duplicarlo.
- **Posición ordinal**, desempate por id descendente: estable y determinista.
- **El MMR no se reinicia por temporada:** la temporada define quién figura y con qué valor quedó. Una temporada cerrada queda congelada.
- **Nombres y países no se copian a Redis.**
- **La posición no se guarda:** se calcula al consultar.
- **Reconstrucción:** recorre Mongo y republica con control de revisión; sirve para recuperar Redis o reparar una publicación pendiente, y puede correr mientras cierran partidas.

---

## 7. Problema 6 — Historial y estadísticas

**Pide:** últimas 50 partidas y estadísticas por semana/mes/temporada (partidas, victorias, kills/muertes, evolución del rating). Consulta.

**Motores:** Cassandra (historial), Mongo (perfil, temporadas y fuente de la proyección).

**Comunicación:** una **proyección** lee partidas cerradas en Mongo y escribe una fila por jugador en Cassandra. La consulta combina Mongo + Cassandra por `playerId`.

**Decisiones clave:**
- **Partición por jugador, orden por fecha descendente.** "Últimas 50" = primeras 50 filas; "desde X" = rango contiguo. El costo depende del jugador, no de la plataforma.
- **Una fila por jugador por partida:** duplicación deliberada para leer sin cruzar particiones.
- **Las estadísticas se derivan al leer, no se guardan:** no hay contadores desincronizados (ni con cierres ni con anulaciones).
- **Proyección idempotente y reanudable:** la clave completa sobrescribe las mismas filas; devuelve un cursor para continuar.
- **La evolución usa los snapshots de cada partida** (MMR antes/después), no el rating actual.
- **Ventanas móviles** (7 días, 30 días, temporada activa).

**Pendiente:** la proyección se dispara a mano; engancharla al cierre es una llamada al final de P4.

---

## 8. Problema 7 — Comportamiento irregular

**Pide:** (a) grupos que coinciden reiteradamente y uno siempre se beneficia; (b) jugadores con reportes de varios denunciantes en poco tiempo. Consulta.

**Motores:** Neo4j (grafo jugador–partida), Mongo (reportes, nombres, partidas cerradas).

**Comunicación:** proyección desde Mongo al grafo (idempotente por `MERGE`, reanudable). La consulta lee el grafo, aplica reglas en la aplicación y pide nombres a Mongo.

**Decisiones clave:**
- **El acuerdo de resultados es un patrón de relaciones:** pares que comparten partida, repetidos, con resultados opuestos. En el grafo es un recorrido de un salto; en Mongo sería un auto-join cuadrático (50 jugadores = 1.225 pares por partida); en Cassandra exigiría una tabla por par.
- **El grafo no es una copia para leer más rápido:** resuelve consultas que Mongo no puede. Lo duplicado es el hecho base, con responsable definido.
- **Los reportes se quedan en Mongo:** contar denunciantes en una ventana es agrupación, no relación.
- **Umbrales como parámetros** (mínimo de partidas, días, proporción de beneficio, denunciantes, minutos). La consigna no fija valores.
- **"Siempre se beneficia":** de los enfrentamientos del par, el que más ganó debe superar cierta proporción; empates no cuentan.
- **Ventana deslizante de reportes en la aplicación:** el criterio "poco tiempo" queda explícito y testeable.
- **Cruce de señales:** quien aparece en ambas es la alerta más fuerte.
- **Es una alerta, no una sanción** (eso es P8).

**Límite:** sin equipos modelados, dos aliados que se pasan ventajas no se detectan.

---

## 9. Problema 8 — Sanción y reversión

**Pide:** anular partidas, revertir rating del sancionado y de sus rivales, recalcular leaderboards, y un perfil completo en una consulta. **Falla:** la sanción queda registrada, pero no puede haber leaderboards con anulaciones a medias.

**Motores:** los cuatro. Mongo (sanción, diario, rating), Redis (cola y retención), Cassandra (historial), Neo4j (grafo).

**Flujo:**
1. Validar jugador, administrador, reporte y partidas.
2. **Registrar sanción en Mongo, sola.** Desde acá está en vigor.
3. Sacar al jugador de la cola (Redis).
4. **Retener** a los afectados en cada leaderboard.
5. Por partida: `anulada` en Mongo → revertir rating y temporadas → borrar historial → borrar grafo → anotar en el diario.
6. Publicar y soltar la retención, un solo Lua por tablero.
7. Marcar reversión completada.

**Decisiones clave:**
- **Sanción primero:** es lo que la consigna exige conservar. Antes solo hubo lecturas.
- **Retener antes de tocar ratings.** Si la reversión se corta a la mitad y un rival juega otra partida, P4 publicaría su rating ya restituido y el tablero quedaría anulado para unos y no para otros. Mientras está retenido, las publicaciones y reconstrucciones **lo saltean**; al final, una sola operación publica a todos: se ve la reversión completa o nada. El contador permite varias sanciones sobre el mismo jugador.
- **Anular antes que borrar:** desde `anulada`, P6/P7 la ignoran y P4 rechaza un nuevo cierre; borrar primero permitiría que una proyección la reescriba.
- **Redis al final, como en P4:** una falla deja el tablero atrasado, nunca adelantado.
- **Completar, no deshacer:** todos los pasos son repetibles; deshacer exigiría compensar las compensaciones y dejaría al tramposo con los puntos ganados.
- **El diario vive en el documento de la sanción:** dice qué falta (pasos, partidas, tableros retenidos) y permite reanudar. Se eligió Mongo por durabilidad y porque sanción + diario es una sola escritura atómica.
- **Rating:** una sola actualización atómica por participante, con guardas "se aplicó" y "no se revirtió". Se resta el delta; como el MMR no se reinicia, se ajusta la temporada de la partida **y todas las posteriores**. Si queda sin partidas válidas, se lo quita del tablero dejando una lápida para que una publicación vieja no lo reviva.
- **Perfil:** Mongo (perfil, ratings, sanciones, temporada), Redis (posiciones) y Cassandra (últimas partidas), leídos en paralelo por el mismo `playerId`.

**Fallas:** siempre la sanción queda en vigor y el tablero consistente; se reintenta el pedido o se reanuda desde el diario.

**Límites:** una retención abandonada no se libera sola; no hay worker.

---

## 10. Flujo completo

```
P1  entra a la cola        Redis (ticket + 2 colas)          ← lee Mongo
P2  se forma               Redis reserva → Mongo crea → Redis confirma
P3  eventos                Cassandra (log) → Redis (marcador)
P4  cierre                 Redis cierra → Mongo prepara → Cassandra fin
                           → Redis libera → Mongo cierra → Cassandra recalcula
                           → Mongo rating → Redis leaderboard
P5  leaderboard            Redis (posición) + Mongo (perfil)
P6  historial              Cassandra (partidas) + Mongo (perfil/temporada)
P7  irregularidades        Neo4j (relaciones) + Mongo (reportes)
P8  sanción                Mongo (sanción) → Redis (cola/retención) → Mongo (rating)
                           → Cassandra/Neo4j (borrados) → Redis (publicación)
```

### Dónde vive cada dato

| Dato | Dueño | Copias |
|---|---|---|
| Jugador y perfil | Mongo | — |
| Rating vigente | Mongo | Registro de temporada (Mongo) y leaderboard (Redis) |
| Cola y ticket | Redis | — |
| Partida (estado) | Mongo | Partida viva y snapshot de formación (Redis) |
| Eventos | Cassandra | Marcador vivo (Redis) |
| Resultado final | Mongo | Historial (Cassandra) y grafo (Neo4j) |
| Reportes y sanciones | Mongo | — |
| Posición en ranking | Nadie | Se calcula en Redis al consultar |

### Por qué cada motor

| Pregunta | Respuesta |
|---|---|
| ¿Cola en Mongo? | Hace falta verificar y escribir en un paso indivisible, buscar por rango y por antigüedad. |
| ¿Eventos solo en Redis? | Se perderían ante un reinicio y crecen sin techo. |
| ¿Marcador solo en Cassandra? | Cada lectura sumaría toda la partición. |
| ¿Leaderboard en Mongo? | La posición obliga a recorrer el índice hasta el jugador. |
| ¿Historial en Mongo? | Es masivo, inmutable y se lee "las últimas N de un jugador": eso es una partición. |
| ¿Arreglo en Mongo? | Es un patrón de relaciones repetidas: auto-join cuadrático. |
| ¿Datos repetidos? | Cada motor responde una consulta distinta; hay dueño, orden de escritura y reconstrucción. |
| ¿Sin transacciones entre motores? | No existen entre motores distintos: sagas con pasos idempotentes. |

---

## 11. Pendientes y límites globales

- **No hay workers:** formación, recuperación, reintento de cierres, reanudación de sanciones y proyecciones se disparan por endpoint. El estado durable está listo para que un worker los retome.
- **Proyecciones a Cassandra y Neo4j manuales:** engancharlas al cierre es una llamada al final de P4.
- **Sin autenticación:** se asume entorno local y servidor de juego confiable.
- **Consistencia eventual entre motores**, con ventana acotada y reparación por reconstrucción. Dentro de un motor y de un Lua es fuerte.
- **Reaplicar el esquema** cuando cambia el validador de Mongo.
