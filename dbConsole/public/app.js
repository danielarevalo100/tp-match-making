const terminals = document.getElementById("terminals");
const empty = document.getElementById("empty");
const buttons = document.querySelectorAll("button[data-engine]");
const sessions = new Map();
let activeSession = null;

function send(session, message) {
  if (session.socket?.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify(message));
  }
}

function connect(session) {
  session.reconnect.hidden = true;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/terminal/${session.engine}`);
  session.socket = socket;

  socket.addEventListener("open", () => {
    send(session, { type: "resize", cols: session.terminal.cols, rows: session.terminal.rows });
    session.terminal.focus();
  });
  socket.addEventListener("message", (event) => session.terminal.write(event.data));
  socket.addEventListener("close", () => {
    session.terminal.write("\r\n\x1b[33m[Sesión terminada]\x1b[0m\r\n");
    session.reconnect.hidden = false;
  });
}

function createSession(engine) {
  const element = document.createElement("section");
  element.className = "session";

  const reconnect = document.createElement("button");
  reconnect.type = "button";
  reconnect.className = "reconnect";
  reconnect.textContent = "Reconectar";
  reconnect.hidden = true;

  const host = document.createElement("div");
  host.className = "terminal-host";

  element.append(reconnect, host);
  terminals.append(element);

  const terminal = new Terminal({ cursorBlink: true, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  const session = { engine, element, reconnect, terminal, fit, socket: null };
  terminal.onData((data) => send(session, { type: "input", data }));
  terminal.onResize(({ cols, rows }) => send(session, { type: "resize", cols, rows }));
  reconnect.addEventListener("click", () => {
    terminal.reset();
    connect(session);
  });
  return session;
}

function open(engine) {
  empty.hidden = true;
  const isNew = !sessions.has(engine);
  if (isNew) sessions.set(engine, createSession(engine));

  for (const session of sessions.values()) session.element.hidden = session.engine !== engine;
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.engine === engine));
  }

  activeSession = sessions.get(engine);
  activeSession.fit.fit();
  if (isNew) connect(activeSession);
  activeSession.terminal.focus();
}

for (const button of buttons) {
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => open(button.dataset.engine));
}

window.addEventListener("resize", () => activeSession?.fit.fit());
