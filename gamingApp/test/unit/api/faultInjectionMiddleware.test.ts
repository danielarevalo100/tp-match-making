import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Router } from "express";
import request from "supertest";

import { createApp } from "../../../src/api/app.js";
import { failDbHeader } from "../../../src/api/middlewares/faultInjectionMiddleware.js";
import { requestContext } from "../../../src/shared/requestContext.js";

type ContextBody = { failDb: string | null };

function buildTestApp() {
  const router = Router();
  router.get("/", async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    response.json({ failDb: requestContext.getStore()?.failDb ?? null });
  });

  return createApp({
    checkReadiness: async () => true,
    routes: [{ path: "/context", router }],
    serviceName: "gaming-app-test",
  });
}

describe("fault injection middleware", () => {
  const app = buildTestApp();

  it("exposes the database to fail to asynchronous handlers", async () => {
    const response = await request(app).get("/context").set(failDbHeader, "Mongo");

    assert.equal(response.status, 200);
    assert.equal((response.body as ContextBody).failDb, "mongo");
  });

  it("ignores an unknown database", async () => {
    const response = await request(app).get("/context").set(failDbHeader, "oracle");

    assert.equal((response.body as ContextBody).failDb, null);
  });

  it("leaves failDb empty when the header is absent", async () => {
    const response = await request(app).get("/context");

    assert.equal(response.status, 200);
    assert.equal((response.body as ContextBody).failDb, null);
  });
});
