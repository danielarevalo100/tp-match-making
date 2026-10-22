import { BaseCassandraAdapter } from "../../../../../infrastructure/cassandra/baseCassandraAdapter.js";
import { cassandraTables } from "../../../../../shared/storageKeys.js";
import type { HistoryEntry, HistoryRow } from "../../business/models/playerHistory.js";
import type { PlayerHistoryStorePort } from "../../business/ports/playerHistoryPorts.js";
import { historyColumns, toHistoryEntry } from "../mappers/historyRowMapper.js";

const table = cassandraTables.matchHistoryByPlayer;
const writeConcurrency = 64;
const readPageSize = 1_000;

const insertRow = `INSERT INTO ${table}
  (player_id, ended_at, match_id, mode, region, result, kills, deaths, objectives, score,
   mmr_before, mmr_after, rating_delta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const selectLatest = `SELECT ${historyColumns} FROM ${table} WHERE player_id = ? LIMIT ?`;
const selectSince = `SELECT ${historyColumns} FROM ${table} WHERE player_id = ? AND ended_at >= ?`;

export class CassandraPlayerHistoryAdapter
  extends BaseCassandraAdapter
  implements PlayerHistoryStorePort
{
  // La clave primaria (player_id, ended_at, match_id) hace que un reintento escriba la misma fila.
  append(rows: readonly HistoryRow[]): Promise<void> {
    return this.write(async () => {
      for (let start = 0; start < rows.length; start += writeConcurrency) {
        await Promise.all(
          rows
            .slice(start, start + writeConcurrency)
            .map((row) =>
              this.client.execute(insertRow, [
                row.playerId,
                row.endedAt,
                row.matchId,
                row.mode,
                row.region,
                row.result,
                row.kills,
                row.deaths,
                row.objectives,
                row.score,
                Math.round(row.mmrBefore),
                Math.round(row.mmrAfter),
                Math.round(row.ratingDelta),
              ]),
            ),
        );
      }
    });
  }

  findLatest(playerId: string, limit: number): Promise<HistoryEntry[]> {
    return this.read(async () => {
      const result = await this.client.execute(selectLatest, [playerId, limit]);
      return result.rows.map(toHistoryEntry);
    });
  }

  findSince(playerId: string, since: Date): Promise<HistoryEntry[]> {
    return this.read(async () => {
      const entries: HistoryEntry[] = [];
      let pageState: string | undefined;
      do {
        const result = await this.client.execute(selectSince, [playerId, since], {
          fetchSize: readPageSize,
          ...(pageState ? { pageState } : {}),
        });
        entries.push(...result.rows.map(toHistoryEntry));
        pageState = result.pageState ?? undefined;
      } while (pageState);
      return entries;
    });
  }
}
