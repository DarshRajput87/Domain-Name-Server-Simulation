// Production supervisor: runs the DNS TCP service and the Next.js standalone server in one process tree.
// If either child exits, the other is stopped and this process exits non-zero, so the platform restarts the container.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;

function run(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[supervisor] ${name} exited (${signal ?? code}); stopping`);
    stop(code || 1);
  });
  children.push(child);
}

function stop(exitCode) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 5000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => process.exit(exitCode));
}

process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));

run("dns-tcp", ["dist/dns-server.mjs"]);
// In the Docker image server.js sits at the app root; in a local checkout it is under .next/standalone.
const web = fs.existsSync(path.join(root, "server.js")) ? "server.js" : ".next/standalone/server.js";
run("web", [web]);
