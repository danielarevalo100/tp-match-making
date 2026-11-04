import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";

import { WebSocket } from "ws";

import { createServer } from "../src/server.mjs";

const PUBLIC_PORT = 3002;
const ALLOWED_ORIGIN = `http://localhost:${PUBLIC_PORT}`;
const env = { HOME: "/tmp", LANG: "C.UTF-8", PATH: "/usr/bin" };

let server;

function fakeTerminal() {
  const terminal = {
    killed: false,
    write: () => {},
    resize: () => {},
    kill: () => {
      terminal.killed = true;
    },
    onData: (callback) => {
      terminal.emitData = callback;
    },
    onExit: () => {},
  };
  return terminal;
}

async function start(spawn = () => fakeTerminal()) {
  server = createServer({ env, publicPort: PUBLIC_PORT, spawn });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function connect(port, path, origin) {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
}

async function rejectedStatus(socket) {
  // terminate() during the handshake emits an error that this test expects.
  socket.on("error", () => {});
  const [, response] = await once(socket, "unexpected-response");
  response.resume();
  socket.terminate();
  return response.statusCode;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  server = undefined;
});

test("GET /health reports the process is alive", async () => {
  const port = await start();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "db-console" });
});

test("GET / serves the page", async () => {
  const port = await start();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
});

test("rejects a disallowed origin with 403 and spawns nothing", async () => {
  let spawned = false;
  const port = await start(() => {
    spawned = true;
    return fakeTerminal();
  });
  const socket = connect(port, "/terminal/redis", "http://evil.example");
  assert.equal(await rejectedStatus(socket), 403);
  assert.equal(spawned, false);
});

test("rejects a missing origin with 403", async () => {
  const port = await start();
  const socket = connect(port, "/terminal/redis");
  assert.equal(await rejectedStatus(socket), 403);
});

test("rejects unknown engines and paths with 404 and spawns nothing", async () => {
  let spawned = false;
  const port = await start(() => {
    spawned = true;
    return fakeTerminal();
  });
  for (const path of ["/terminal/postgres", "/terminal/constructor", "/other"]) {
    const socket = connect(port, path, ALLOWED_ORIGIN);
    assert.equal(await rejectedStatus(socket), 404, path);
  }
  assert.equal(spawned, false);
});

test("connects a known engine and kills the terminal when the socket closes", async () => {
  const terminal = fakeTerminal();
  let command;
  const port = await start((engine) => {
    command = engine.command;
    return terminal;
  });
  const socket = connect(port, "/terminal/redis", ALLOWED_ORIGIN);
  await once(socket, "open");
  assert.equal(command, "redis-cli");

  const message = once(socket, "message");
  terminal.emitData("PONG");
  const [data] = await message;
  assert.equal(data.toString(), "PONG");

  socket.close();
  await once(socket, "close");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(terminal.killed, true);
});

test("closes the socket with 1011 when the shell cannot start", async () => {
  const port = await start(() => {
    throw new Error("spawn failed");
  });
  const socket = connect(port, "/terminal/redis", ALLOWED_ORIGIN);
  const [code] = await once(socket, "close");
  assert.equal(code, 1011);
});
