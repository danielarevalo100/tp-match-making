import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { buildEngineCommand } from "./engines.mjs";
import { allowedOrigins, isOriginAllowed } from "./origin.mjs";
import { attachTerminal, spawnTerminal } from "./terminal.mjs";

const localPath = (path) => fileURLToPath(new URL(path, import.meta.url));

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function engineFromUrl(url) {
  const match = /^\/terminal\/([^/]+)$/.exec(url.split("?")[0]);
  return match?.[1];
}

export function createServer({ env, publicPort, spawn = spawnTerminal }) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "db-console" }));
  app.use("/vendor/xterm", express.static(localPath("../node_modules/@xterm/xterm")));
  app.use("/vendor/addon-fit", express.static(localPath("../node_modules/@xterm/addon-fit")));
  app.use(express.static(localPath("../public")));

  const server = createHttpServer(app);
  const webSockets = new WebSocketServer({ noServer: true });
  const origins = allowedOrigins(publicPort);

  server.on("upgrade", (req, socket, head) => {
    if (!isOriginAllowed(req.headers.origin, origins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const command = buildEngineCommand(engineFromUrl(req.url), env);
    if (!command) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    webSockets.handleUpgrade(req, socket, head, (webSocket) => {
      try {
        attachTerminal(webSocket, spawn(command));
      } catch (error) {
        console.error(`Could not start ${command.command}:`, error.message);
        webSocket.close(1011, "Could not start shell");
      }
    });
  });

  return server;
}
