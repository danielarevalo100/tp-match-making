import type {
  AffectedSeasons,
  HeldBoard,
  ReversibleMatch,
  SeasonCatalog,
} from "../models/sanction.js";

/**
 * Season standings a match changed. Same season rule as problem 4: the season that contains
 * `createdAt`, and only for a ranked mode. MMR carries over between seasons, so every later season
 * the player has a standing in also includes the match's delta and must be shifted as well.
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
 * Boards a reversal must hold: for every affected season and mode, all the participants of the
 * voided matches (the cheater and its rivals). Sorted, so the same sanction always produces the
 * same boards.
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
