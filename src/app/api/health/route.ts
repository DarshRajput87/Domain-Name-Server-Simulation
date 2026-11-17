import { connection } from "next/server";
import { gateway, gatewayTarget } from "@/server/dnsGateway";

/** Liveness/readiness probe for load balancers and container healthchecks. 200 only when the DNS TCP service answers. */
export async function GET() {
  await connection(); // always run at request time, never prerender at build
  try {
    const r = await gateway.request({ t: "ping" }, "pong", 1500);
    return Response.json({ ok: true, dns: { target: gatewayTarget, version: r.version } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { ok: false, dns: { target: gatewayTarget, error: (err as Error).message } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
