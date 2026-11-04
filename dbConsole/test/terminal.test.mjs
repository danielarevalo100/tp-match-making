import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { attachTerminal, parseClientMessage } from "../src/terminal.mjs";

function fakeTerminal() {
  const terminal = {
    written: [],
    resized: [],
    killed: false,
    write: (data) => terminal.written.push(data),
    resize: (cols, rows) => terminal.resized.push([cols, rows]),
    kill: () => {
      terminal.killed = true;
    },
    onData: (callback) => {
      terminal.emitData = callback;
    },
    onExit: (callback) => {
      terminal.emitExit = callback;
    },
  };
  return terminal;
}

function fakeSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.sent = [];
  socket.closed = false;
  socket.terminated = false;
  socket.send = (data) => socket.sent.push(data);
  socket.close = () => {
    socket.closed = true;
  };
  socket.terminate = () => {
    socket.terminated = true;
  };
  return socket;
}

function connected() {
  const socket = fakeSocket();
  const terminal = fakeTerminal();
  attachTerminal(socket, terminal);
  return { socket, terminal };
}

test("parses valid input and resize messages", () => {
  assert.deepEqual(parseClientMessage('{"type":"input","data":"ls"}'), {
    type: "input",
    data: "ls",
  });
  assert.deepEqual(parseClientMessage('{"type":"resize","cols":120,"rows":40}'), {
    type: "resize",
    cols: 120,
    rows: 40,
  });
});

test("rejects invalid messages", () => {
  for (const raw of [
    "not json",
    "null",
    '{"type":"exec","data":"ls"}',
    '{"type":"input","data":1}',
    '{"type":"resize","cols":0,"rows":40}',
    '{"type":"resize","cols":80.5,"rows":40}',
    '{"type":"resize","cols":80,"rows":100000}',
  ]) {
    assert.equal(parseClientMessage(raw), null, raw);
  }
});

test("sends terminal output to an open socket", () => {
  const { socket, terminal } = connected();
  terminal.emitData("hello");
  assert.deepEqual(socket.sent, ["hello"]);
});

test("does not send output to a closed socket", () => {
  const { socket, terminal } = connected();
  socket.readyState = 3;
  terminal.emitData("hello");
  assert.deepEqual(socket.sent, []);
});

test("forwards input and resize messages to the terminal", () => {
  const { socket, terminal } = connected();
  socket.emit("message", Buffer.from('{"type":"input","data":"ls"}'));
  socket.emit("message", Buffer.from('{"type":"resize","cols":100,"rows":30}'));
  assert.deepEqual(terminal.written, ["ls"]);
  assert.deepEqual(terminal.resized, [[100, 30]]);
});

test("ignores invalid messages", () => {
  const { socket, terminal } = connected();
  socket.emit("message", Buffer.from("not json"));
  assert.deepEqual(terminal.written, []);
  assert.deepEqual(terminal.resized, []);
});

test("kills the terminal when the socket closes", () => {
  const { socket, terminal } = connected();
  socket.emit("close");
  assert.equal(terminal.killed, true);
});

test("closes the socket when the terminal exits and does not kill it again", () => {
  const { socket, terminal } = connected();
  terminal.emitExit({ exitCode: 0 });
  assert.equal(socket.closed, true);
  socket.emit("close");
  assert.equal(terminal.killed, false);
});

test("ignores messages after the terminal exits", () => {
  const { socket, terminal } = connected();
  terminal.emitExit({ exitCode: 0 });
  socket.emit("message", Buffer.from('{"type":"input","data":"ls"}'));
  assert.deepEqual(terminal.written, []);
});

test("terminates the socket on a socket error", () => {
  const { socket } = connected();
  socket.emit("error", new Error("invalid frame"));
  assert.equal(socket.terminated, true);
});
