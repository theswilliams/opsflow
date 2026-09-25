// Custom Next.js server. Its one job: stamp every request with the REAL TCP peer address so rate limiting
// and audit can tell clients apart (route handlers cannot see the socket). Any client-supplied
// `x-opsflow-peer` header is discarded first. See src/lib/net/client-ip.ts for the trust model.
import { createServer } from "node:http";
import next from "next";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME_BIND || (dev ? "localhost" : "0.0.0.0");

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();
await app.prepare();

const server = createServer((req, res) => {
  delete req.headers["x-opsflow-peer"];
  if (req.socket.remoteAddress) req.headers["x-opsflow-peer"] = req.socket.remoteAddress;
  handle(req, res);
});
server.on("upgrade", (req, socket, head) => {
  delete req.headers["x-opsflow-peer"];
  upgrade(req, socket, head);
});
server.listen(port, hostname, () => console.log(`OpsFlow ${dev ? "(dev) " : ""}listening on http://${hostname}:${port}`));
