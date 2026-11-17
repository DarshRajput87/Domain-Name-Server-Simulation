// Protocol handling for one client connection, independent of how messages travel.
// The TCP server runs one session per socket; the embedded mode (serverless hosts) runs one in-process.
import { isQueryType, normalizeDomain, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../src/shared/dns";
import type { Resolver } from "./resolver";

// The Next.js gateway multiplexes every visitor over one session, so this is effectively a global limit.
const MAX_INFLIGHT = Math.max(1, Number(process.env.DNS_MAX_INFLIGHT) || 64);

export function createSession(resolver: Resolver, send: (m: ServerMessage) => void, isClosed: () => boolean = () => false) {
  const inflight = new Map<string, { cancelled: boolean }>();

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
        if (inflight.size >= MAX_INFLIGHT) return send({ t: "error", qid, code: "BUSY", msg: "Too many concurrent queries" });
        const state = { cancelled: false };
        inflight.set(qid, state);
        const isCancelled = () => state.cancelled || isClosed();
        resolver
          .resolve(qid, norm.domain, m.qtype, (e) => send({ t: "event", e }), isCancelled)
          .finally(() => inflight.delete(qid));
        return;
      }
      default:
        send({ t: "error", code: "BAD_REQUEST", msg: "Unknown message" });
    }
  };

  const close = () => inflight.forEach((s) => (s.cancelled = true));
  return { handle, close };
}
