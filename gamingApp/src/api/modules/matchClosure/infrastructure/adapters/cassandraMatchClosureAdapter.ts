import { types } from "cassandra-driver";

import { BaseCassandraAdapter } from "../../../../../infrastructure/cassandra/baseCassandraAdapter.js";
import { cassandraTables } from "../../../../../shared/storageKeys.js";
import { matchEventTypes } from "../../../matchEvents/business/models/matchEvent.js";
import type {
  MatchFinishedEvent,
  ScoringEvent,
  ScoringEventPage,
} from "../../business/models/matchClosure.js";
import type { MatchClosureLogPort } from "../../business/ports/matchClosurePorts.js";

const table = cassandraTables.eventsByMatch;
const insertFinished = `INSERT INTO ${table}
  (match_id, ts, event_id, event_type, player_id, target_player_id, detail, points)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const listEvents = `SELECT event_type, player_id, target_player_id, points
  FROM ${table} WHERE match_id = ?`;

export class CassandraMatchClosureAdapter
  extends BaseCassandraAdapter
  implements MatchClosureLogPort
{
  appendFinished(event: MatchFinishedEvent): Promise<void> {
    return this.write(async () => {
      await this.client.execute(insertFinished, [
        event.matchId,
        new Date(event.tsMs),
        event.eventId,
        event.type,
        types.unset,
        types.unset,
        JSON.stringify({
          closureId: event.closureId,
          reason: event.reason,
          results: event.results,
        }),
        0,
      ]);
    });
  }

  listScoringEvents(matchId: string, limit: number, pageState?: string): Promise<ScoringEventPage> {
    return this.read(async () => {
      const result = await this.client.execute(listEvents, [matchId], {
        fetchSize: limit,
        ...(pageState ? { pageState } : {}),
      });
      const events = result.rows.flatMap((row): ScoringEvent[] => {
        const type = row["event_type"] as string;
        if (!(matchEventTypes as readonly string[]).includes(type)) return [];
        const player = row["player_id"] as types.Uuid | null;
        if (!player) throw new Error(`Gameplay event ${type} has no player_id.`);
        const target = row["target_player_id"] as types.Uuid | null;
        return [
          {
            playerId: player.toString(),
            points: (row["points"] as number | null) ?? 0,
            targetPlayerId: target?.toString() ?? null,
            type: type as ScoringEvent["type"],
          },
        ];
      });
      return { events, nextPageState: result.pageState ?? null };
    });
  }
}
