import { PlayerNotFoundError } from "../../../players/business/models/playerErrors.js";
import type { HistoryEntry, PeriodWindow, PlayerHistoryView } from "../models/playerHistory.js";
import type { PlayerDirectoryPort, PlayerHistoryStorePort } from "../ports/playerHistoryPorts.js";
import { summarizePeriod } from "./periodStats.js";

export const historyLimit = 50;
const dayMs = 86_400_000;

/**
 * Historial y estadísticas del jugador (problema 6), solo lectura. Lee, en este orden:
 *   1. MongoDB   que el jugador exista, y qué temporada está activa (catálogo)
 *   2. Cassandra las últimas 50 partidas, y todas desde el inicio del período más largo
 * Las dos lecturas de Cassandra son porciones de una partición (`player_id`), así que no dependen
 * de cuántas partidas tenga la plataforma. Los períodos son móviles: semana = últimos 7 días,
 * mes = últimos 30 días, temporada = desde el inicio de la temporada activa hasta ahora.
 */
export class PlayerHistoryService {
  constructor(
    private readonly directory: PlayerDirectoryPort,
    private readonly history: PlayerHistoryStorePort,
  ) {}

  async getHistory(playerId: string, now: Date = new Date()): Promise<PlayerHistoryView> {
    const player = await this.directory.findPlayer(playerId);
    if (!player) throw new PlayerNotFoundError(playerId);
    const season = await this.directory.findActiveSeason();

    const week: PeriodWindow = { from: new Date(now.getTime() - 7 * dayMs), to: now };
    const month: PeriodWindow = { from: new Date(now.getTime() - 30 * dayMs), to: now };
    const seasonWindow: PeriodWindow | null =
      season && season.startsAt <= now
        ? { from: season.startsAt, to: season.endsAt < now ? season.endsAt : now }
        : null;

    const earliest = [week.from, month.from, seasonWindow?.from ?? month.from].reduce((a, b) =>
      a < b ? a : b,
    );
    const [matches, sinceEarliest]: [HistoryEntry[], HistoryEntry[]] = await Promise.all([
      this.history.findLatest(playerId, historyLimit),
      this.history.findSince(playerId, earliest),
    ]);

    return {
      matches,
      player,
      stats: {
        month: summarizePeriod(sinceEarliest, month),
        season:
          season && seasonWindow
            ? { ...summarizePeriod(sinceEarliest, seasonWindow), seasonId: season.id }
            : null,
        week: summarizePeriod(sinceEarliest, week),
      },
    };
  }
}
