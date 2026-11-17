import net from "node:net";
import type { ClientMessage, ServerMessage } from "../src/shared/dns";
import { Resolver } from "./resolver";
import { createSession } from "./session";
import { simTransport } from "./transport";

const MAX_LINE = 4096;

export function startServer(port = Number(process.env.DNS_TCP_PORT ?? 7053), host = process.env.DNS_TCP_HOST ?? "127.0.0.1") {
  const resolver = new Resolver(simTransport);

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = "";
    const send = (m: ServerMessage) => void (sock.writable && sock.write(JSON.stringify(m) + "\n"));
    const session = createSession(resolver, send, () => sock.destroyed);

    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_LINE * 4 && !buf.includes("\n")) return sock.destroy();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          session.handle(JSON.parse(line) as ClientMessage);
        } catch {
          send({ t: "error", code: "BAD_REQUEST", msg: "Malformed JSON" });
        }
      }
    });
    sock.on("close", session.close);
    sock.on("error", () => {});
  });

  return new Promise<net.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
