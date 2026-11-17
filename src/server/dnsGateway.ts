// Server-only: one persistent, multiplexed NDJSON connection from Next.js to the DNS TCP service.
import net from "node:net";
import type { ClientMessage, ServerMessage } from "@/shared/dns";
import { Resolver } from "../../server/resolver";
import { createSession } from "../../server/session";
import { simTransport } from "../../server/transport";

const HOST = process.env.DNS_TCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DNS_TCP_PORT ?? 7053);
const CONNECT_TIMEOUT_MS = 3000;

type Listener = (m: ServerMessage) => void;

class DnsGateway {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private byQid = new Map<string, Listener>();
  private control = new Set<Listener>();

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect({ host: HOST, port: PORT });
      sock.setNoDelay(true);
      sock.setTimeout(CONNECT_TIMEOUT_MS, () => sock.destroy(new Error(`timed out connecting to DNS service at ${HOST}:${PORT}`)));
      let buf = "";
      sock.once("connect", () => {
        sock.setTimeout(0);
        this.sock = sock;
        resolve(sock);
      });
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            this.dispatch(JSON.parse(line) as ServerMessage);
          } catch {
            /* ignore malformed line */
          }
        }
      });
      sock.on("error", (err) => reject(err));
      sock.on("close", () => {
        if (this.sock === sock) this.sock = null;
        const down: ServerMessage = { t: "error", code: "BACKEND_UNAVAILABLE", msg: "Connection to DNS service lost" };
        this.byQid.forEach((l) => l(down));
        this.byQid.clear();
      });
    }).finally(() => (this.connecting = null));
    return this.connecting;
  }

  protected dispatch(m: ServerMessage) {
    const qid = m.t === "event" ? m.e.qid : m.t === "error" ? m.qid : undefined;
    if (qid) this.byQid.get(qid)?.(m);
    else this.control.forEach((l) => l(m));
  }

  async send(m: ClientMessage) {
    const sock = await this.connect();
    sock.write(JSON.stringify(m) + "\n");
  }

  subscribe(qid: string, l: Listener) {
    this.byQid.set(qid, l);
    return () => void this.byQid.delete(qid);
  }

  /** Request/response for control messages (ping, flush). */
  async request<T extends ServerMessage["t"]>(m: ClientMessage, expect: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      const l: Listener = (r) => {
        if (r.t !== expect) return;
        cleanup();
        resolve(r as Extract<ServerMessage, { t: T }>);
      };
      const timer = setTimeout(() => (cleanup(), reject(new Error("DNS service did not reply"))), timeoutMs);
      const cleanup = () => (clearTimeout(timer), this.control.delete(l));
      this.control.add(l);
      this.send(m).catch((e) => (cleanup(), reject(e)));
    });
  }
}

/**
 * Serverless hosts (Vercel) cannot run a long-lived TCP service, so the resolver runs in-process instead.
 * Same protocol and code path as the TCP server, minus the socket. The cache lives per function instance.
 */
class EmbeddedGateway extends DnsGateway {
  // Deliver asynchronously, like a socket would, so callers can subscribe before the first event arrives.
  private session = createSession(new Resolver(simTransport), (m) => queueMicrotask(() => this.dispatch(m)));

  override async send(m: ClientMessage) {
    this.session.handle(m);
  }
}

// DNS_MODE: "tcp" (default) talks to the separate service; "embedded" runs it in-process (default on Vercel).
const MODE = process.env.DNS_MODE ?? (process.env.VERCEL ? "embedded" : "tcp");

// Survive Next.js dev hot reloads without leaking sockets.
const g = globalThis as typeof globalThis & { __dnsGateway?: DnsGateway };
export const gateway = (g.__dnsGateway ??= MODE === "embedded" ? new EmbeddedGateway() : new DnsGateway());
export const gatewayTarget = MODE === "embedded" ? "embedded (in-process)" : `${HOST}:${PORT}`;
