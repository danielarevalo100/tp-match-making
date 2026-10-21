import neo4j from "neo4j-driver";

import {
  BaseNeo4jAdapter,
  toNumber,
} from "../../../../../infrastructure/neo4j/baseNeo4jAdapter.js";
import type { ClosedMatch } from "../../../playerHistory/business/models/playerHistory.js";
import type { OpposingPair } from "../../business/models/fraud.js";
import type { MatchGraphPort } from "../../business/ports/fraudPorts.js";

const writeBatchSize = 250;

// MERGE by id makes the load idempotent: the same match again changes nothing.
const upsertMatches = `
UNWIND $matches AS row
MERGE (match:Match {id: row.matchId})
  SET match.mode = row.mode, match.region = row.region, match.endedAtMs = toInteger(row.endedAtMs)
WITH match, row
UNWIND row.players AS entry
MERGE (player:Player {id: entry.playerId})
MERGE (player)-[played:PLAYED]->(match)
  SET played.result = entry.result, played.ratingDelta = toInteger(entry.ratingDelta)
`;

// Players on opposite sides of a decided match; "a.id < b.id" visits each pair only once.
const findOpposingPairs = `
MATCH (a:Player)-[ra:PLAYED]->(match:Match)<-[rb:PLAYED]-(b:Player)
WHERE a.id < b.id
  AND match.endedAtMs >= $sinceMs
  AND ($mode IS NULL OR match.mode = $mode)
  AND ((ra.result = 'win' AND rb.result = 'loss') OR (ra.result = 'loss' AND rb.result = 'win'))
WITH a, b, count(match) AS matches, sum(CASE WHEN ra.result = 'win' THEN 1 ELSE 0 END) AS winsA
WHERE matches >= $minMatches
RETURN a.id AS playerA, b.id AS playerB, matches, winsA, matches - winsA AS winsB
ORDER BY matches DESC
LIMIT $limit
`;

export class Neo4jMatchGraphAdapter extends BaseNeo4jAdapter implements MatchGraphPort {
  async upsertMatches(matches: readonly ClosedMatch[]): Promise<void> {
    for (let start = 0; start < matches.length; start += writeBatchSize) {
      await this.query("fraud.upsertMatches", "write", upsertMatches, {
        matches: matches.slice(start, start + writeBatchSize).map((match) => ({
          endedAtMs: match.endedAt.getTime(),
          matchId: match.id,
          mode: match.mode,
          players: match.players.map((player) => ({
            playerId: player.playerId,
            ratingDelta: player.ratingDelta,
            result: player.result,
          })),
          region: match.region,
        })),
      });
    }
  }

  async findOpposingPairs(query: {
    limit: number;
    minMatches: number;
    mode?: string;
    since: Date;
  }): Promise<OpposingPair[]> {
    const records = await this.query("fraud.findOpposingPairs", "read", findOpposingPairs, {
      limit: neo4j.int(query.limit),
      minMatches: neo4j.int(query.minMatches),
      mode: query.mode ?? null,
      sinceMs: neo4j.int(query.since.getTime()),
    });
    return records.map((record) => ({
      matches: toNumber(record.get("matches")),
      playerA: record.get("playerA") as string,
      playerB: record.get("playerB") as string,
      winsA: toNumber(record.get("winsA")),
      winsB: toNumber(record.get("winsB")),
    }));
  }
}
