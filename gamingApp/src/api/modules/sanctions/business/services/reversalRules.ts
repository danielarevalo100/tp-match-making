import type {
  AffectedSeasons,
  HeldBoard,
  ReversibleMatch,
  SeasonCatalog,
} from "../models/sanction.js";

/**
 * Standings de temporada que cambió una partida. Misma regla de temporada que el problema 4: la
 * temporada que contiene `createdAt`, y solo para un modo rankeado. El MMR se arrastra entre
 * temporadas, así que cada temporada posterior en la que el jugador tenga standing también
 * incluye el delta de la partida y hay que corregirla.
 */
export function affectedSeasons(
  catalog: SeasonCatalog,
  mode: string,
  playedAt: Date,
): AffectedSeasons {
  if (!catalog.rankedModes.includes(mode)) return { matchSeasonId: null, seasonIds: [] };
  const time = playedAt.getTime();
  const seasons = catalog.seasons
    .filter((season) => season.endsAt.getTime() >= time)
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  const matchSeason = seasons.find((season) => season.startsAt.getTime() <= time);
  return {
    matchSeasonId: matchSeason?.id ?? null,
    seasonIds: seasons.map((season) => season.id),
  };
}

/**
 * Tableros que tiene que retener una reversión: por cada temporada y modo afectados, todos los
 * participantes de las partidas anuladas (el tramposo y sus rivales). Ordenados, así la misma
 * sanción siempre produce los mismos tableros.
 */
export function heldBoards(
  matches: readonly ReversibleMatch[],
  seasonsByMatch: ReadonlyMap<string, AffectedSeasons>,
): HeldBoard[] {
  const boards = new Map<string, { mode: string; players: Set<string>; seasonId: string }>();
  for (const match of matches) {
    for (const seasonId of seasonsByMatch.get(match.id)?.seasonIds ?? []) {
      const key = `${seasonId}|${match.mode}`;
      const board = boards.get(key) ?? { mode: match.mode, players: new Set(), seasonId };
      for (const participant of match.participants) board.players.add(participant.playerId);
      boards.set(key, board);
    }
  }
  return [...boards.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, board]) => ({
      mode: board.mode,
      playerIds: [...board.players].sort(),
      seasonId: board.seasonId,
    }));
}
