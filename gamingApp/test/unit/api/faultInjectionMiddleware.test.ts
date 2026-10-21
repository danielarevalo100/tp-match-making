import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Router } from "express";
import request from "supertest";

import { createApp } from "../../../src/api/app.js";
import { failAtHeader } from "../../../src/api/middlewares/faultInjectionMiddleware.js";
import { requestContext } from "../../../src/shared/requestContext.js";

type ContextBody = { failAt: string | null };

function buildTestApp() {
  const router = Router();
  router.get("/", async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.json({ failAt: requestContext.getStore()?.failAt ?? null });
  });

  return createApp({
    checkReadiness: async () => true,
    routes: [{ path: "/context", router }],
    serviceName: "gaming-app-test",
  });
}

describe("fault injection middleware", () => {
  const app = buildTestApp();

  it("exposes the requested failure step to asynchronous handlers", async () => {
    const response = await request(app).get("/context").set(failAtHeader, "players.create");

    assert.equal(response.status, 200);
    assert.equal((response.body as ContextBody).failAt, "players.create");
  });

  it("leaves failAt empty when the header is absent", async () => {
    const response = await request(app).get("/context");

    assert.equal(response.status, 200);
    assert.equal((response.body as ContextBody).failAt, null);
  });
});
