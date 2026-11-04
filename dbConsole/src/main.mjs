import { createServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 3000);
const publicPort = Number(process.env.DB_CONSOLE_PORT ?? 3002);

createServer({ env: process.env, publicPort }).listen(port, () => {
  console.log(`DB console listening on port ${port}, published on ${publicPort}`);
});
