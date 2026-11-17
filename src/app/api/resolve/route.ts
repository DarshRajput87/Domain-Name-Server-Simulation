import { randomUUID } from "node:crypto";
import { gateway, gatewayTarget } from "@/server/dnsGateway";
import type { ServerMessage } from "@/shared/dns";

const STREAM_TIMEOUT_MS = 20000;

/** Streams DNS lifecycle events for one query as NDJSON (ServerMessage per line). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? "";
  const qtype = url.searchParams.get("type") ?? "A";
  const qid = randomUUID().slice(0, 8);
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (m: ServerMessage) => !closed && controller.enqueue(enc.encode(JSON.stringify(m) + "\n"));
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        unsubscribe();
        controller.close();
      };
      const unsubscribe = gateway.subscribe(qid, (m) => {
        write(m);
        if (m.t === "error" || (m.t === "event" && (m.e.type === "QUERY_COMPLETED" || m.e.type === "QUERY_FAILED"))) close();
      });
      const timer = setTimeout(() => {
        write({ t: "error", qid, code: "BACKEND_UNAVAILABLE", msg: "DNS service stopped responding" });
        gateway.send({ t: "cancel", qid }).catch(() => {});
        close();
      }, STREAM_TIMEOUT_MS);
      cleanup = () => {
        if (closed) return;
        gateway.send({ t: "cancel", qid }).catch(() => {});
        closed = true;
        clearTimeout(timer);
        unsubscribe();
      };
      req.signal.addEventListener("abort", cleanup);
      gateway.send({ t: "resolve", qid, domain, qtype }).catch((err: Error) => {
        write({ t: "error", qid, code: "BACKEND_UNAVAILABLE", msg: `DNS service unreachable at ${gatewayTarget} (${err.message}). Start it with "npm run dns-server".` });
        close();
      });
    },
    cancel: () => cleanup(),
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
