import { BaseCassandraAdapter } from "../../../../../infrastructure/cassandra/baseCassandraAdapter.js";
import { cassandraTables } from "../../../../../shared/storageKeys.js";
import type { HistoryCleanupPort } from "../../business/ports/sanctionPorts.js";

const table = cassandraTables.matchHistoryByPlayer;
// La clave primaria completa: cada delete toca una fila de la partición de un jugador.
const deleteRow = `DELETE FROM ${table} WHERE player_id = ? AND ended_at = ? AND match_id = ?`;

export class CassandraHistoryCleanupAdapter
  extends BaseCassandraAdapter
  implements HistoryCleanupPort
{
  // Borrar una fila que ya no está no hace nada, así un reintento es inofensivo. El problema 6
  // calcula las estadísticas con estas filas, así que sin ellas la partida anulada ya no cuenta.
  deleteMatch(matchId: string, endedAt: Date, playerIds: readonly string[]): Promise<void> {
    return this.write(async () => {
      await Promise.all(
        playerIds.map((playerId) => this.client.execute(deleteRow, [playerId, endedAt, matchId])),
      );
    });
  }
}
