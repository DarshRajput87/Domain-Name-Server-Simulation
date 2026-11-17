import { gateway, gatewayTarget } from "@/server/dnsGateway";

/** Control channel, kept separate from the resolution event stream: { action: "ping" | "flush" }. */
export async function POST(req: Request) {
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.action === "ping") {
      const r = await gateway.request({ t: "ping" }, "pong");
      return Response.json({ ok: true, version: r.version, target: gatewayTarget });
    }
    if (body.action === "flush") {
      const r = await gateway.request({ t: "flush" }, "flushed");
      return Response.json({ ok: true, removed: r.removed });
    }
    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: `DNS service unreachable at ${gatewayTarget}: ${(err as Error).message}` }, { status: 503 });
  }
}
