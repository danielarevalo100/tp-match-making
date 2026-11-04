import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedOrigins, isOriginAllowed } from "../src/origin.mjs";

const allowed = allowedOrigins(3002);

test("accepts localhost and 127.0.0.1 on the published port", () => {
  assert.equal(isOriginAllowed("http://localhost:3002", allowed), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:3002", allowed), true);
});

test("rejects other origins", () => {
  for (const origin of [
    "http://evil.example",
    "http://localhost:3001",
    "https://localhost:3002",
    "http://localhost:3002.evil.example",
    "null",
  ]) {
    assert.equal(isOriginAllowed(origin, allowed), false, origin);
  }
});

test("rejects a missing origin", () => {
  assert.equal(isOriginAllowed(undefined, allowed), false);
});
