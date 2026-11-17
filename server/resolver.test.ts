// Integration tests over the real TCP protocol: `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DnsEvent, ServerMessage } from "../src/shared/dns";
import { startServer } from "./index";

const csv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dns-sim-")), "domains.csv");
process.env.DNS_SIM_CSV = csv;

let server: net.Server;
let port: number;
before(async () => {
  server = await startServer(0);
  port = (server.address() as net.AddressInfo).port;
});
after(() => server.close());

let n = 0;
function run(domain: string, qtype: string, extra: object[] = []): Promise<{ events: DnsEvent[]; errors: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const qid = `t${++n}`;
    const sock = net.connect(port, "127.0.0.1");
    const events: DnsEvent[] = [];
    const errors: ServerMessage[] = [];
    let buf = "";
    const end = () => {
      sock.end();
      resolve({ events, errors });
    };
    sock.on("connect", () => {
      for (const m of extra) sock.write(JSON.stringify(m) + "\n");
      sock.write(JSON.stringify({ t: "resolve", qid, domain, qtype }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as ServerMessage;
        buf = buf.slice(i + 1);
        if (m.t === "error") {
          errors.push(m);
          end();
        }
        if (m.t === "event") {
          events.push(m.e);
          if (m.e.type === "QUERY_COMPLETED" || m.e.type === "QUERY_FAILED") end();
        }
      }
    });
    sock.on("error", reject);
  });
}
const types = (ev: DnsEvent[]) => ev.map((e) => e.type);
const last = (ev: DnsEvent[]) => ev[ev.length - 1];

test("cache miss walks root -> TLD -> authoritative, then cache hit", async () => {
  const miss = await run("example.com", "A", [{ t: "flush" }]);
  assert.deepEqual(types(miss.events), [
    "QUERY_STARTED", "CACHE_CHECK", "CACHE_MISS", "ROOT_QUERY", "ROOT_REFERRAL", "TLD_QUERY", "TLD_REFERRAL",
    "AUTHORITATIVE_QUERY", "DNS_RESPONSE", "CACHE_STORE", "QUERY_COMPLETED",
  ]);
  assert.equal(miss.events.find((e) => e.type === "ROOT_REFERRAL")!.data!.zone, "com");
  assert.equal(miss.events.find((e) => e.type === "TLD_REFERRAL")!.data!.zone, "example.com");
  const r = last(miss.events).data!.result!;
  assert.deepEqual(r.addresses, ["192.0.2.10"]);
  assert.equal(r.cached, false);
  assert.ok(miss.events.every((e, i) => e.seq === i));

  const hit = await run("example.com", "A");
  assert.deepEqual(types(hit.events), ["QUERY_STARTED", "CACHE_CHECK", "CACHE_HIT", "QUERY_COMPLETED"]);
  assert.equal(last(hit.events).data!.result!.cached, true);
  assert.ok(last(hit.events).data!.result!.ttl! <= 300);
  assert.ok(!hit.events.some((e) => ["root", "tld", "auth"].includes(e.node)));
});

test("AAAA, CNAME restart, NXDOMAIN, NODATA, glueless", async () => {
  const v6 = await run("wiki.org", "AAAA");
  assert.deepEqual(last(v6.events).data!.result!.addresses, ["2001:db8:30::1"]);

  const alias = await run("www.example.com", "AAAA", [{ t: "flush" }]);
  assert.equal(types(alias.events).filter((t) => t === "ROOT_QUERY").length, 2);
  assert.deepEqual(last(alias.events).data!.result!.addresses, ["2001:db8::10"]);

  const nx = await run("nope.example.com", "A");
  assert.equal(last(nx.events).type, "QUERY_FAILED");
  assert.equal(last(nx.events).data!.result!.status, "NXDOMAIN");

  const nxTld = await run("foo.invalid", "A");
  assert.equal(last(nxTld.events).data!.result!.status, "NXDOMAIN");
  assert.equal(nxTld.events.find((e) => e.type === "DNS_RESPONSE")!.from, "root");

  const nodata = await run("acme-shop.com", "AAAA");
  assert.equal(last(nodata.events).data!.result!.status, "NODATA");

  const glueless = await run("glueless.org", "A");
  assert.deepEqual(last(glueless.events).data!.result!.addresses, ["203.0.113.77"]);
});

test("any other domain gets a generated, stable answer", async () => {
  const a = await run("google.com", "A", [{ t: "flush" }]);
  assert.equal(last(a.events).type, "QUERY_COMPLETED", last(a.events).msg);
  assert.match(last(a.events).data!.result!.addresses[0], /^203\.0\.113\.\d+$/);
  const again = await run("google.com", "A", [{ t: "flush" }]);
  assert.deepEqual(last(again.events).data!.result!.addresses, last(a.events).data!.result!.addresses);

  const v6 = await run("mail.some-new-site.dev", "AAAA");
  assert.match(last(v6.events).data!.result!.addresses[0], /^2001:db8:/);

  const ips = new Set<string>();
  for (const d of ["a.com", "b.com", "c.org", "d.net", "e.io", "f.dev"]) ips.add(last((await run(d, "A")).events).data!.result!.addresses[0]);
  assert.equal(ips.size, 6, "each domain gets its own address");
  const rows = fs.readFileSync(csv, "utf8").trim().split("\n");
  assert.equal(rows[0], "domain,ipv4,ipv6");
  assert.ok(rows.some((r) => r.startsWith(`google.com,${last(a.events).data!.result!.addresses[0]},`)), "assignment saved to CSV");

  const sld = await run("www.bbc.co.uk", "A");
  const t = types(sld.events);
  assert.ok(t.includes("AUTHORITATIVE_REFERRAL"), "co.uk adds a delegation step");
  assert.equal(t.filter((x) => x === "ROOT_QUERY").length, 2, "www CNAME restarts at the root");
  assert.equal(last(sld.events).type, "QUERY_COMPLETED");
});

test("unresponsive authoritative server times out", { timeout: 20000 }, async () => {
  const r = await run("www.deadzone.io", "A");
  assert.equal(last(r.events).type, "QUERY_FAILED");
  assert.equal(last(r.events).data!.result!.status, "TIMEOUT");
  assert.equal(last(r.events).data!.failedAt, "auth");
});

test("validation errors", async () => {
  const bad = await run("bad domain", "A");
  assert.equal(bad.errors[0].t === "error" && bad.errors[0].code, "INVALID_DOMAIN");
  const mx = await run("example.com", "MX");
  assert.equal(mx.errors[0].t === "error" && mx.errors[0].code, "UNSUPPORTED_TYPE");
});

