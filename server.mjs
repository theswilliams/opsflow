// Custom Next.js server. Its one job: stamp every request with the REAL TCP peer address so rate limiting
// and audit can tell clients apart (route handlers cannot see the socket). Any client-supplied
// `x-opsflow-peer` header is discarded first. See src/lib/net/client-ip.ts for the trust model.
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import next from "next";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME_BIND || (dev ? "localhost" : "0.0.0.0");

// A per-process secret: lets the application distinguish headers stamped HERE from headers a client made up.
const peerSecret = randomBytes(32).toString("hex");
process.env.OPSFLOW_PEER_SECRET = peerSecret;
const stamp = (req) => {
  delete req.headers["x-opsflow-peer"];
  delete req.headers["x-opsflow-peer-mac"];
  const peer = req.socket.remoteAddress;
  if (peer) {
    req.headers["x-opsflow-peer"] = peer;
    req.headers["x-opsflow-peer-mac"] = createHmac("sha256", peerSecret).update(peer).digest("hex");
  }
};

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();
const upgrade = app.getUpgradeHandler();

const server = createServer((req, res) => {
  stamp(req);
  handle(req, res);
});
server.on("upgrade", (req, socket, head) => {
  stamp(req);
  upgrade(req, socket, head);
});
server.listen(port, hostname, () => console.log(`OpsFlow ${dev ? "(dev) " : ""}listening on http://${hostname}:${port}`));
