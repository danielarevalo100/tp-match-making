import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";

const app = createApp({
  nodeEnv: "test",
  port: 3000,
  serviceName: "test-service",
});

describe("service API", () => {
  it("reports health", async () => {
    const response = await request(app).get("/health").expect(200);

    assert.deepEqual(response.body, {
      status: "ok",
      service: "test-service",
    });
    assert.match(response.headers["x-request-id"] ?? "", /^[0-9a-f-]{36}$/);
  });

  it("preserves a caller-provided request ID", async () => {
    const response = await request(app)
      .get("/ready")
      .set("x-request-id", "request-123")
      .expect(200);

    assert.equal(response.headers["x-request-id"], "request-123");
  });

  it("returns JSON for unknown routes", async () => {
    const response = await request(app).get("/missing").expect(404);

    assert.deepEqual(response.body, { error: "Route not found" });
  });
});
