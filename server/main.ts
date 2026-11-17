import type { AddressInfo } from "node:net";
import { startServer } from "./index";

startServer().then(
  (s) => {
    const a = s.address() as AddressInfo;
    console.log(`[dns-tcp] listening on ${a.address}:${a.port} (in-memory DNS simulation)`);
    const shutdown = (signal: string) => {
      console.log(`[dns-tcp] ${signal} received, shutting down`);
      s.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref(); // open client sockets must not block exit
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  },
  (err: Error) => {
    console.error("[dns-tcp] failed to start:", err.message);
    process.exit(1);
  },
);
