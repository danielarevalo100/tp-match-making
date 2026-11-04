import pty from "node-pty";

const MAX_TERMINAL_SIZE = 1000;

function isTerminalSize(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_TERMINAL_SIZE;
}

export function parseClientMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (message?.type === "input" && typeof message.data === "string") {
    return { type: "input", data: message.data };
  }
  if (message?.type === "resize" && isTerminalSize(message.cols) && isTerminalSize(message.rows)) {
    return { type: "resize", cols: message.cols, rows: message.rows };
  }
  return null;
}

export function spawnTerminal({ command, args, env }) {
  return pty.spawn(command, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: env.HOME,
    env,
  });
}

export function attachTerminal(socket, terminal) {
  let exited = false;

  terminal.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  terminal.onExit(() => {
    exited = true;
    socket.close();
  });
  socket.on("message", (raw) => {
    const message = parseClientMessage(raw.toString());
    if (!message || exited) return;
    if (message.type === "input") terminal.write(message.data);
    else terminal.resize(message.cols, message.rows);
  });
  socket.on("close", () => {
    if (!exited) terminal.kill();
  });
  socket.on("error", () => socket.terminate());
}
