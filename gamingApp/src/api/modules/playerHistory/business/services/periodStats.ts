import type {
  HistoryEntry,
  PeriodStats,
  PeriodWindow,
  RatingEvolution,
} from "../models/playerHistory.js";

export const maxRatingPoints = 100;

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Resume las partidas de `entries` (en cualquier orden) que terminaron dentro de `window`. Es un
 * dato derivado: siempre se calcula desde el historial, así no hay contadores que se desfasen.
 */
export function summarizePeriod(
  entries: readonly HistoryEntry[],
  window: PeriodWindow,
): PeriodStats {
  const inWindow = entries
    .filter((entry) => entry.endedAt >= window.from && entry.endedAt <= window.to)
    .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let kills = 0;
  let deaths = 0;
  const byMode = new Map<string, HistoryEntry[]>();
  for (const entry of inWindow) {
    if (entry.result === "win") wins += 1;
    else if (entry.result === "loss") losses += 1;
    else draws += 1;
    kills += entry.kills;
    deaths += entry.deaths;
    byMode.set(entry.mode, [...(byMode.get(entry.mode) ?? []), entry]);
  }

  const ratingEvolution: RatingEvolution[] = [...byMode.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mode, modeEntries]) => {
      const first = modeEntries[0];
      const last = modeEntries.at(-1);
      const from = first?.mmrBefore ?? 0;
      const to = last?.mmrAfter ?? 0;
      return {
        change: to - from,
        from,
        mode,
        points: modeEntries
          .slice(-maxRatingPoints)
          .map((entry) => ({ endedAt: entry.endedAt, mmr: entry.mmrAfter })),
        to,
      };
    });

  return {
    deaths,
    draws,
    from: window.from,
    // Sin muertes el ratio no está definido (no es infinito).
    killDeathRatio: deaths > 0 ? round(kills / deaths) : null,
    kills,
    losses,
    matches: inWindow.length,
    ratingEvolution,
    to: window.to,
    winRate: inWindow.length > 0 ? round(wins / inWindow.length) : null,
    wins,
  };
}
