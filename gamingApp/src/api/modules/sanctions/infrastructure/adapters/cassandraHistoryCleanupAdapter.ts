import { BaseCassandraAdapter } from "../../../../../infrastructure/cassandra/baseCassandraAdapter.js";
import { cassandraTables } from "../../../../../shared/storageKeys.js";
import type { HistoryCleanupPort } from "../../business/ports/sanctionPorts.js";

const table = cassandraTables.matchHistoryByPlayer;
// The full primary key: each delete touches one row of one player's partition.
const deleteRow = `DELETE FROM ${table} WHERE player_id = ? AND ended_at = ? AND match_id = ?`;

export class CassandraHistoryCleanupAdapter
  extends BaseCassandraAdapter
  implements HistoryCleanupPort
{
  // Deleting a row that is already gone is a no-op, so a retry is harmless. Problem 6 derives the
  // statistics from these rows, so once they are gone the voided match no longer counts anywhere.
  deleteMatch(matchId: string, endedAt: Date, playerIds: readonly string[]): Promise<void> {
    return this.run("sanctions.deleteHistory", async () => {
      await Promise.all(
        playerIds.map((playerId) => this.client.execute(deleteRow, [playerId, endedAt, matchId])),
      );
    });
  }
}
