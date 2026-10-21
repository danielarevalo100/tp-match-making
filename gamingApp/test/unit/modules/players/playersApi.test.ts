import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import request from "supertest";

import { createApp } from "../../../../src/api/app.js";
import { PlayersService } from "../../../../src/api/modules/players/business/services/playersService.js";
import { PlayersController } from "../../../../src/api/modules/players/presentation/controllers/playersController.js";
import { createPlayersRouter } from "../../../../src/api/modules/players/presentation/routers/playersRouter.js";
import { InMemoryCatalogRepository } from "../../../support/inMemory/inMemoryCatalogRepository.js";
import { InMemoryPlayersRepository } from "../../../support/inMemory/inMemoryPlayersRepository.js";

type PlayerBody = {
  accountStatus: string;
  country: string;
  email: string;
  id: string;
  ratings: Record<string, { mmr: number }>;
  region: string;
  registeredAt: string;
  updatedAt: string;
  username: string;
};

type PlayerPageBody = {
  items: PlayerBody[];
  nextCursor: string | null;
};

type ErrorBody = {
  error: string;
  field?: string;
};

function buildTestApp() {
  const players = new InMemoryPlayersRepository();
  const playersService = new PlayersService(players, new InMemoryCatalogRepository());

  return {
    app: createApp({
      checkReadiness: async () => true,
      routes: [
        { path: "/players", router: createPlayersRouter(new PlayersController(playersService)) },
      ],
      serviceName: "gaming-app-test",
    }),
    players,
  };
}

const now = new Date("2026-10-13T12:00:00.000Z");

describe("players API", () => {
  let context = buildTestApp();

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now });
    context = buildTestApp();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  async function registerPlayer() {
    return request(context.app).post("/players").send({
      birthDate: "1995-04-12",
      country: "ar",
      email: "PLAYER@EXAMPLE.COM",
      password: "a-secure-password",
      username: "Player_ONE",
    });
  }

  it("registers a player with normalized identifiers and initial ratings", async () => {
    const response = await registerPlayer();
    const player = response.body as PlayerBody;

    assert.equal(response.status, 201);
    assert.equal(player.username, "player_one");
    assert.equal(player.email, "player@example.com");
    assert.equal(player.country, "AR");
    assert.equal(player.region, "LATAM");
    assert.equal("passwordHash" in player, false);
    assert.equal(player.ratings.ranked_1v1?.mmr, 1_000);
    assert.equal(player.registeredAt, now.toISOString());
    assert.match(context.players.items[0]?.passwordHash ?? "", /^scrypt\$/);
  });

  it("rejects duplicate normalized usernames", async () => {
    await registerPlayer();
    const response = await request(context.app).post("/players").send({
      country: "BR",
      email: "other@example.com",
      password: "a-secure-password",
      username: "PLAYER_ONE",
    });

    assert.equal(response.status, 409);
    assert.equal((response.body as ErrorBody).field, "username");
  });

  it("updates profile fields and derives region again", async () => {
    const player = (await registerPlayer()).body as PlayerBody;
    const response = await request(context.app).patch(`/players/${player.id}`).send({
      country: "br",
      email: "NEW@EXAMPLE.COM",
    });
    const updated = response.body as PlayerBody;

    assert.equal(response.status, 200);
    assert.equal(updated.email, "new@example.com");
    assert.equal(updated.country, "BR");
    assert.equal(updated.region, "BR");
  });

  it("updates account status", async () => {
    const player = (await registerPlayer()).body as PlayerBody;
    mock.timers.tick(60_000);
    const response = await request(context.app)
      .patch(`/players/${player.id}/status`)
      .send({ status: "inactive" });
    const updated = response.body as PlayerBody;

    assert.equal(response.status, 200);
    assert.equal(updated.accountStatus, "inactive");
    assert.equal(updated.updatedAt, new Date(now.getTime() + 60_000).toISOString());
  });

  it("lists and retrieves players without exposing password hashes", async () => {
    const player = (await registerPlayer()).body as PlayerBody;
    const getResponse = await request(context.app).get(`/players/${player.id}`);
    const listResponse = await request(context.app).get("/players?limit=10");
    const page = listResponse.body as PlayerPageBody;

    assert.equal(getResponse.status, 200);
    assert.equal("passwordHash" in (getResponse.body as PlayerBody), false);
    assert.equal(listResponse.status, 200);
    assert.equal(page.items.length, 1);
    assert.equal("passwordHash" in (page.items[0] ?? {}), false);
  });

  it("rejects invalid request bodies", async () => {
    const response = await request(context.app).post("/players").send({
      country: "ARG",
      email: "not-an-email",
      password: "short",
      username: "invalid spaces",
    });

    assert.equal(response.status, 400);
    assert.equal((response.body as ErrorBody).error, "VALIDATION_ERROR");
  });
});
