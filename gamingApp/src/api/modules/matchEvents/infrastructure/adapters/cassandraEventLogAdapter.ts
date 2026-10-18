import { types } from "cassandra-driver";

import { BaseCassandraAdapter } from "../../../../../infrastructure/cassandra/baseCassandraAdapter.js";
import { cassandraTables } from "../../../../../shared/storageKeys.js";
import type { EventPage, EventQuery, MatchEvent } from "../../business/models/matchEvent.js";
import type { MatchEventLogPort } from "../../business/ports/matchEventPorts.js";
import { toMatchEvent } from "../mappers/eventRowMapper.js";

const table = cassandraTables.eventsByMatch;

const insertEvent = `INSERT INTO ${table}
  (match_id, ts, event_id, event_type, player_id, target_player_id, detail, points)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export class CassandraEventLogAdapter extends BaseCassandraAdapter implements MatchEventLogPort {
  // The primary key is (match_id, ts, event_id): a retry writes the very same row. Absent columns
  // are sent as `unset` instead of null so no tombstone is created.
  append(event: MatchEvent): Promise<void> {
    return this.run("matchEvents.appendEvent", async () => {
      await this.client.execute(insertEvent, [
        event.matchId,
        new Date(event.tsMs),
        event.eventId,
        event.type,
        event.playerId,
        event.targetPlayerId ?? types.unset,
        event.detail ? JSON.stringify(event.detail) : types.unset,
        event.points,
      ]);
    });
  }

  list(matchId: string, query: EventQuery): Promise<EventPage> {
    return this.run("matchEvents.listEvents", async () => {
      const conditions = ["match_id = ?"];
      const params: unknown[] = [matchId];
      if (query.fromTsMs !== undefined) {
        conditions.push("ts >= ?");
        params.push(new Date(query.fromTsMs));
      }
      if (query.toTsMs !== undefined) {
        conditions.push("ts <= ?");
        params.push(new Date(query.toTsMs));
      }

      const result = await this.client.execute(
        `SELECT match_id, ts, event_id, event_type, player_id, target_player_id, detail, points
         FROM ${table} WHERE ${conditions.join(" AND ")}`,
        params,
        {
          fetchSize: query.limit,
          ...(query.pageState ? { pageState: query.pageState } : {}),
        },
      );
      return {
        events: result.rows.map((row) => toMatchEvent(row)),
        nextPageState: result.pageState ?? null,
      };
    });
  }
}
