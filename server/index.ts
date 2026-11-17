import net from "node:net";
import { isQueryType, normalizeDomain, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../src/shared/dns";
import { Resolver } from "./resolver";
import { simTransport } from "./transport";

// The Next.js gateway multiplexes every visitor over one connection, so this is effectively a global limit.
const MAX_INFLIGHT_PER_CONN = Math.max(1, Number(process.env.DNS_MAX_INFLIGHT) || 64);
const MAX_LINE = 4096;

export function startServer(port = Number(process.env.DNS_TCP_PORT ?? 7053), host = process.env.DNS_TCP_HOST ?? "127.0.0.1") {
  const resolver = new Resolver(simTransport);

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    const inflight = new Map<string, { cancelled: boolean }>();
    let buf = "";
    const send = (m: ServerMessage) => sock.writable && sock.write(JSON.stringify(m) + "\n");

    const handle = (m: ClientMessage) => {
      switch (m.t) {
        case "ping":
          return send({ t: "pong", version: PROTOCOL_VERSION });
        case "flush":
          return send({ t: "flushed", removed: resolver.cache.clear() });
        case "cancel":
          if (inflight.has(m.qid)) inflight.get(m.qid)!.cancelled = true;
          return;
        case "resolve": {
          const { qid } = m;
          if (typeof qid !== "string" || !qid || inflight.has(qid)) return send({ t: "error", qid, code: "BAD_REQUEST", msg: "Missing or duplicate query id" });
          if (!isQueryType(m.qtype)) return send({ t: "error", qid, code: "UNSUPPORTED_TYPE", msg: `Record type "${m.qtype}" is not supported (use A or AAAA)` });
          const norm = normalizeDomain(String(m.domain ?? ""));
          if (!norm.ok) return send({ t: "error", qid, code: "INVALID_DOMAIN", msg: norm.error });
          if (inflight.size >= MAX_INFLIGHT_PER_CONN) return send({ t: "error", qid, code: "BUSY", msg: "Too many concurrent queries" });
          const state = { cancelled: false };
          inflight.set(qid, state);
          const isCancelled = () => state.cancelled || sock.destroyed;
          resolver
            .resolve(qid, norm.domain, m.qtype, (e) => send({ t: "event", e }), isCancelled)
            .finally(() => inflight.delete(qid));
          return;
        }
        default:
          send({ t: "error", code: "BAD_REQUEST", msg: "Unknown message" });
      }
    };

    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_LINE * 4 && !buf.includes("\n")) return sock.destroy();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line) as ClientMessage);
        } catch {
          send({ t: "error", code: "BAD_REQUEST", msg: "Malformed JSON" });
        }
      }
    });
    sock.on("close", () => inflight.forEach((s) => (s.cancelled = true)));
    sock.on("error", () => {});
  });

  return new Promise<net.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
