import {
  maxProfileSanctions,
  type BoardPosition,
  type PlayerProfile,
  type ProfileLeaderboard,
  type ProfileSanction,
  type ProfileSanctionRecord,
  type ProfileStanding,
} from "../models/playerProfile.js";
import { SanctionPlayerNotFoundError } from "../models/sanctionErrors.js";
import type {
  ProfileDirectoryPort,
  ProfileHistoryPort,
  ProfileRankingPort,
} from "../ports/playerProfilePorts.js";

/**
 * Problema 8, consulta de trazabilidad: todo sobre un jugador en un solo pedido. Cada base se lee
 * donde viven los datos, con el playerId compartido, y no se copia nada para la ocasión:
 *
 *   MongoDB    perfil, rating por modo, standings de temporada y sanciones
 *   Redis      posición en el tablero global y regional de cada modo rankeado (problema 5)
 *   Cassandra  últimas partidas del historial (problema 6)
 */
export class PlayerProfileService {
  constructor(
    private readonly directory: ProfileDirectoryPort,
    private readonly ranking: ProfileRankingPort,
    private readonly history: ProfileHistoryPort,
  ) {}

  async profile(playerId: string, matchLimit: number): Promise<PlayerProfile> {
    const now = new Date();
    const [entry, seasonId, sanctions, recentMatches] = await Promise.all([
      this.directory.findPlayer(playerId),
      this.directory.findActiveSeasonId(),
      this.directory.findSanctions(playerId, maxProfileSanctions),
      this.history.findLatest(playerId, matchLimit),
    ]);
    if (!entry) throw new SanctionPlayerNotFoundError(playerId);

    const standings = seasonId
      ? entry.standings.filter(
          (standing) => standing.seasonId === seasonId && standing.gamesPlayed > 0,
        )
      : [];
    const leaderboards = await Promise.all(
      standings.map((standing) => this.positions(playerId, standing)),
    );

    return {
      leaderboards: leaderboards.sort((left, right) => left.mode.localeCompare(right.mode)),
      player: entry.player,
      ratings: [...entry.ratings].sort((left, right) => left.mode.localeCompare(right.mode)),
      recentMatches,
      sanctions: sanctions.map((sanction) => withInForce(sanction, now)),
      seasonId,
    };
  }

  private async positions(
    playerId: string,
    standing: ProfileStanding,
  ): Promise<ProfileLeaderboard> {
    const board = { mode: standing.mode, seasonId: standing.seasonId };
    const [global, regional] = await Promise.all([
      this.ranking.around({ ...board, region: null }, playerId, 0),
      this.ranking.around({ ...board, region: standing.region }, playerId, 0),
    ]);
    const toPosition = (window: BoardPosition | null): BoardPosition | null =>
      window ? { position: window.position, totalPlayers: window.totalPlayers } : null;
    return {
      gamesPlayed: standing.gamesPlayed,
      global: toPosition(global),
      mmr: standing.mmr,
      mode: standing.mode,
      region: standing.region,
      regional: toPosition(regional),
      seasonId: standing.seasonId,
    };
  }
}

function withInForce(sanction: ProfileSanctionRecord, now: Date): ProfileSanction {
  const inForce =
    sanction.status === "active" &&
    sanction.startsAt.getTime() <= now.getTime() &&
    (sanction.endsAt === null || sanction.endsAt.getTime() > now.getTime());
  return { ...sanction, inForce };
}
