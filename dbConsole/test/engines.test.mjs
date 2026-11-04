import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEngineCommand } from "../src/engines.mjs";

const env = {
  HOME: "/home/node",
  LANG: "C.UTF-8",
  MONGO_ROOT_USERNAME: "mongo-user",
  MONGO_ROOT_PASSWORD: "mongo-secret",
  NEO4J_USERNAME: "neo4j-user",
  NEO4J_PASSWORD: "neo4j-secret",
  PATH: "/usr/bin",
};
const baseEnv = { HOME: "/home/node", LANG: "C.UTF-8", PATH: "/usr/bin" };

test("mongo connects to the gaming database with root credentials", () => {
  assert.deepEqual(buildEngineCommand("mongo", env), {
    command: "mongosh",
    args: [
      "--username",
      "mongo-user",
      "--password",
      "mongo-secret",
      "--authenticationDatabase",
      "admin",
      "mongodb://mongodb:27017/gaming",
    ],
    env: baseEnv,
  });
});

test("redis connects to the redis service", () => {
  assert.deepEqual(buildEngineCommand("redis", env), {
    command: "redis-cli",
    args: ["-h", "redis"],
    env: baseEnv,
  });
});

test("cassandra connects to the gaming keyspace", () => {
  assert.deepEqual(buildEngineCommand("cassandra", env), {
    command: "cqlsh",
    args: ["cassandra", "9042", "-k", "gaming"],
    env: baseEnv,
  });
});

test("neo4j receives credentials through its process environment", () => {
  assert.deepEqual(buildEngineCommand("neo4j", env), {
    command: "cypher-shell",
    args: ["-a", "bolt://neo4j:7687"],
    env: { ...baseEnv, NEO4J_USERNAME: "neo4j-user", NEO4J_PASSWORD: "neo4j-secret" },
  });
});

test("shells do not inherit credentials of other engines", () => {
  for (const engine of ["redis", "cassandra", "mongo"]) {
    assert.equal(buildEngineCommand(engine, env).env.NEO4J_PASSWORD, undefined);
    assert.equal(buildEngineCommand(engine, env).env.MONGO_ROOT_PASSWORD, undefined);
  }
});

test("unknown engines return null", () => {
  for (const engine of ["postgres", "", "constructor", "__proto__"]) {
    assert.equal(buildEngineCommand(engine, env), null);
  }
});
