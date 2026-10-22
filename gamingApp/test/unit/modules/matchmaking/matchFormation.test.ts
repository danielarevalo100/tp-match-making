import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { FormationMode } from "../../../../src/api/modules/matchmaking/business/models/matchFormation.js";
import type { QueueTicket } from "../../../../src/api/modules/matchmaking/business/models/queueTicket.js";
import {
  acceptedRatingRange,
  MatchFormationService,
} from "../../../../src/api/modules/matchmaking/business/services/matchFormationService.js";
import { InjectedFailureError } from "../../../../src/shared/errors.js";
import { requestContext } from "../../../../src/shared/requestContext.js";
import { failOnce } from "../../../support/failOnce.js";
import { InMemoryEligibilityRepository } from "../../../support/inMemory/inMemoryEligibilityRepository.js";
import { InMemoryMatchRepository } from "../../../support/inMemory/inMemoryMatchRepository.js";
import { InMemoryMatchmakingQueue } from "../../../support/inMemory/inMemoryMatchmakingQueue.js";

const mode: FormationMode = {
  expandEverySeconds: 15,
  id: "ranked_1v1",
  initialRatingRange: 50,
  maxPlayers: 2,
  maxRatingRange: 400,
  minPlayers: 2,
  ratingRangeStep: 50,
};

function ticket(playerId: string, mmr: number, enqueuedAt: number): QueueTicket {
  return {
    enqueuedAt,
    mmr,
    mode: "ranked_1v1",
    playerId,
    region: "LATAM",
    ticketId: `t-${playerId}`,
  };
}

describe("acceptedRatingRange", () => {
  it("starts at the initial range, widens by step and is capped", () => {
    assert.equal(acceptedRatingRange(0, mode), 50);
    assert.equal(acceptedRatingRange(14_999, mode), 50);
    assert.equal(acceptedRatingRange(15_000, mode), 100);
    assert.equal(acceptedRatingRange(45_000, mode), 200);
    assert.equal(acceptedRatingRange(3_600_000, mode), 400);
  });
});

describe("MatchFormationService", () => {
  let queue: InMemoryMatchmakingQueue;
  let matches: InMemoryMatchRepository;
  let service: MatchFormationService;
  const input = { mode: "ranked_1v1", region: "LATAM" };

  beforeEach(() => {
    queue = new InMemoryMatchmakingQueue();
    matches = new InMemoryMatchRepository();
    service = new MatchFormationService(new InMemoryEligibilityRepository(), queue, matches);
  });

  const enqueue = (...tickets: QueueTicket[]) => {
    for (const t of tickets) queue.tickets.set(t.playerId, t);
  };

  it("forms a match from players with similar rating and empties the queue", async () => {
    enqueue(ticket("a", 1_000, Date.now() - 1_000), ticket("b", 1_030, Date.now()));

    const result = await service.form(input);

    assert.equal(result.status, "formed");
    assert.equal(queue.tickets.size, 0);
    assert.equal(matches.matches.size, 1);
    const matchId = result.status === "formed" ? result.matchId : "";
    assert.equal(queue.activeMatches.get("a"), matchId);
    assert.deepEqual(queue.liveMatches.get(matchId), ["a", "b"]);
  });

  it("does not match players outside the range until the wait widens it", async () => {
    const now = Date.now();
    enqueue(ticket("a", 1_000, now), ticket("b", 1_120, now));
    assert.equal((await service.form(input)).status, "not_enough_players");
    assert.equal(queue.tickets.size, 2);

    enqueue(ticket("a", 1_000, now - 30_000)); // esperó 30s -> rango 150
    assert.equal((await service.form(input)).status, "formed");
  });

  it("restores everyone with their original enqueuedAt when creating the match fails", async () => {
    const a = ticket("a", 1_000, 1_000);
    const b = ticket("b", 1_010, 2_000);
    enqueue(a, b);

    await assert.rejects(
      requestContext.run({ failDb: "mongo" }, () => service.form(input)),
      InjectedFailureError,
    );

    assert.deepEqual(queue.tickets.get("a"), a);
    assert.deepEqual(queue.tickets.get("b"), b);
    assert.equal(queue.activeMatches.size, 0);
    assert.equal(matches.matches.size, 0);
    assert.equal(queue.liveMatches.size, 0);
  });

  it("restores everyone when the commit fails", async () => {
    enqueue(ticket("a", 1_000, 1_000), ticket("b", 1_010, 2_000));

    failOnce(queue, "commitFormation", "redis");
    await assert.rejects(service.form(input), InjectedFailureError);

    assert.equal(queue.tickets.size, 2);
    assert.equal(queue.tickets.get("a")?.enqueuedAt, 1_000);
    assert.equal(matches.matches.size, 0);
  });

  it("returns the remaining players to the queue when one leaves during the formation", async () => {
    const b = ticket("b", 1_010, 2_000);
    enqueue(ticket("a", 1_000, 1_000), b);
    const originalCommit = queue.commitFormation.bind(queue);
    queue.commitFormation = async (...args) => {
      await queue.leave("a"); // "a" se va después de la reserva, antes del commit
      return originalCommit(...args);
    };

    const result = await service.form(input);

    assert.equal(result.status, "rolled_back");
    assert.deepEqual(result.status === "rolled_back" && result.restored, ["b"]);
    assert.deepEqual(queue.tickets.get("b"), b);
    assert.equal(queue.tickets.has("a"), false);
    assert.equal(queue.activeMatches.size, 0);
    assert.equal(matches.matches.size, 0);
  });

  it("recovers a formation left reserved and is idempotent", async () => {
    enqueue(ticket("a", 1_000, 1_000), ticket("b", 1_010, 2_000));
    matches.create = async () => {
      throw new Error("mongo down");
    };
    failOnce(queue, "restoreFormation", "redis");
    await assert.rejects(service.form(input), /mongo down/);
    // La compensación falló (inyectada) -> sigue reservada, nadie en la cola.
    assert.equal(queue.tickets.size, 0);

    const first = await service.recoverStaleFormations(0);
    assert.equal(first.recovered.length, 1);
    assert.equal(queue.tickets.size, 2);

    const second = await service.recoverStaleFormations(0);
    assert.equal(second.recovered.length, 0);
    assert.equal(queue.tickets.size, 2);
  });
});
