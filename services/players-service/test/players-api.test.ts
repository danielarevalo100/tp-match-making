import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { GetPlayer } from "../src/application/use-cases/get-player.js";
import { ListPlayers } from "../src/application/use-cases/list-players.js";
import { RegisterPlayer } from "../src/application/use-cases/register-player.js";
import { UpdatePlayerProfile } from "../src/application/use-cases/update-player-profile.js";
import { UpdatePlayerStatus } from "../src/application/use-cases/update-player-status.js";
import { PlayerController } from "../src/presentation/http/controllers/player-controller.js";
import {
  FakePasswordHasher,
  FixedClock,
  FixedIdGenerator,
  InMemoryCatalogRepository,
  InMemoryPlayerRepository,
} from "./support/in-memory-repositories.js";

const playerId = "6a634799-3b19-4f68-9bc2-9d9c2ecf1938";

function buildTestApp() {
  const players = new InMemoryPlayerRepository();
  const catalogs = new InMemoryCatalogRepository();
  const clock = new FixedClock(new Date("2026-10-13T12:00:00.000Z"));
  const controller = new PlayerController(
    new RegisterPlayer(players, catalogs, new FakePasswordHasher(), clock, new FixedIdGenerator()),
    new GetPlayer(players),
    new ListPlayers(players),
    new UpdatePlayerProfile(players, catalogs, clock),
    new UpdatePlayerStatus(players, clock),
  );

  return {
    app: createApp({
      checkReadiness: async () => true,
      playerController: controller,
      serviceName: "players-service-test",
    }),
    players,
  };
}

describe("players API", () => {
  let context = buildTestApp();

  beforeEach(() => {
    context = buildTestApp();
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

    assert.equal(response.status, 201);
    assert.equal(response.body.username, "player_one");
    assert.equal(response.body.email, "player@example.com");
    assert.equal(response.body.country, "AR");
    assert.equal(response.body.region, "LATAM");
    assert.equal(response.body.passwordHash, undefined);
    assert.equal(response.body.ratings.ranked_1v1.mmr, 1_000);
    assert.equal(context.players.items[0]?.passwordHash, "hashed:a-secure-password");
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
    assert.equal(response.body.field, "username");
  });

  it("updates profile fields and derives region again", async () => {
    await registerPlayer();
    const response = await request(context.app).patch(`/players/${playerId}`).send({
      country: "br",
      email: "NEW@EXAMPLE.COM",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.email, "new@example.com");
    assert.equal(response.body.country, "BR");
    assert.equal(response.body.region, "BR");
  });

  it("updates account status", async () => {
    await registerPlayer();
    const response = await request(context.app)
      .patch(`/players/${playerId}/status`)
      .send({ status: "inactive" });

    assert.equal(response.status, 200);
    assert.equal(response.body.accountStatus, "inactive");
  });

  it("lists and retrieves players without exposing password hashes", async () => {
    await registerPlayer();
    const getResponse = await request(context.app).get(`/players/${playerId}`);
    const listResponse = await request(context.app).get("/players?limit=10");

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.passwordHash, undefined);
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.items.length, 1);
    assert.equal(listResponse.body.items[0].passwordHash, undefined);
  });

  it("rejects invalid request bodies", async () => {
    const response = await request(context.app).post("/players").send({
      country: "ARG",
      email: "not-an-email",
      password: "short",
      username: "invalid spaces",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_ERROR");
  });
});
