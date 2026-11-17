import type { QueryType, ServerRef } from "../src/shared/dns";
import { ipRegistry } from "./ipRegistry";

export interface RR {
  name: string;
  type: string;
  ttl: number;
  data: string; // A/AAAA address, NS/CNAME target, SOA "mname minimum"
  minimum?: number; // SOA negative-caching TTL
}

export interface DnsMessage {
  rcode: string;
  aa: boolean;
  answer: RR[];
  authority: RR[];
  additional: RR[];
}

export interface Transport {
  /** Root server hints the iteration starts from. */
  roots: ServerRef[];
  query(server: ServerRef, name: string, qtype: QueryType, timeoutMs: number): Promise<DnsMessage>;
}

export class TimeoutError extends Error {}

/* --------------------------- Simulation: in-memory -------------------------- */
// Fictional hierarchy using documentation address space (RFC 5737 / RFC 3849).
// Nothing here leaves the machine; latency is artificial and labelled as such.

interface SimZone {
  ns: ServerRef[];
  records: Record<string, RR[]>; // owner name -> RRs (A/AAAA/CNAME)
  delegations: Record<string, SimZone>; // child zone -> zone
  dead?: boolean; // servers never answer (timeout scenario)
  generated?: boolean; // synthetic registrable domain: every name under it gets A/AAAA records
}

const rr = (name: string, type: string, data: string, ttl = 300): RR => ({ name, type, data, ttl });
const ns = (name: string, ip: string): ServerRef => ({ name, ip });

const leaf = (nsList: ServerRef[], records: RR[], dead = false): SimZone => ({
  ns: nsList,
  dead,
  delegations: {},
  records: records.reduce<Record<string, RR[]>>((acc, r) => ((acc[r.name] ??= []).push(r), acc), {}),
});

const SIM_ROOT: SimZone = {
  ns: [ns("a.sim-root.invalid", "192.0.2.1"), ns("b.sim-root.invalid", "192.0.2.2")],
  records: {},
  delegations: {
    com: {
      ns: [ns("a.sim-tld-com.invalid", "198.51.100.1")],
      records: {},
      delegations: {
        "example.com": leaf([ns("ns1.example.com", "192.0.2.53")], [
          rr("example.com", "A", "192.0.2.10"),
          rr("example.com", "AAAA", "2001:db8::10"),
          rr("www.example.com", "CNAME", "example.com", 600),
        ]),
        "acme-shop.com": leaf([ns("ns.acme-shop.com", "192.0.2.54")], [
          rr("acme-shop.com", "A", "198.51.100.20", 120),
          rr("acme-shop.com", "A", "198.51.100.21", 120),
        ]),
      },
    },
    org: {
      ns: [ns("a.sim-tld-org.invalid", "198.51.100.2")],
      records: {},
      delegations: {
        "wiki.org": leaf([ns("ns.wiki.org", "203.0.113.53")], [
          rr("wiki.org", "A", "203.0.113.30", 3600),
          rr("wiki.org", "AAAA", "2001:db8:30::1", 3600),
          rr("ns.wiki.org", "A", "203.0.113.53", 3600),
        ]),
        // glueless delegation: NS host lives in another zone, resolver must look it up first
        "glueless.org": leaf([ns("ns.wiki.org", "")], [rr("glueless.org", "A", "203.0.113.77", 300)]),
      },
    },
    net: {
      ns: [ns("a.sim-tld-net.invalid", "198.51.100.3")],
      records: {},
      delegations: {
        "cdn.net": leaf([ns("ns.cdn.net", "192.0.2.55")], [
          rr("api.cdn.net", "A", "198.51.100.40", 30),
          rr("api.cdn.net", "AAAA", "2001:db8:40::1", 30),
        ]),
      },
    },
    io: {
      ns: [ns("a.sim-tld-io.invalid", "198.51.100.4")],
      records: {},
      delegations: {
        "deadzone.io": leaf([ns("ns.deadzone.io", "192.0.2.250")], [], true),
      },
    },
  },
};

const SOA_TTL = 60;

const ALL_ZONES: { name: string; zone: SimZone }[] = [];
(function flatten(zone: SimZone, name: string) {
  ALL_ZONES.push({ name, zone });
  for (const [child, z] of Object.entries(zone.delegations)) flatten(z, child);
})(SIM_ROOT, "");

/* ---------- Synthetic zones: any other domain gets a stable, generated delegation chain ---------- */

// Two-label public suffixes that get their own delegation step (uk -> co.uk -> bbc.co.uk).
const SECOND_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.in", "co.jp", "co.nz", "com.br", "co.za"]);
// RFC 6761 / RFC 2606 reserved TLDs never resolve.
const RESERVED_TLDS = new Set(["invalid", "test", "localhost", "example"]);

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
// hosts .100-.249 keep generated servers clear of the hand-written ones above
const docIp = (prefix: string, key: string) => `${prefix}.${100 + (hash(key) % 150)}`;

function addChild(parent: SimZone, name: string, nsName: string, ip: string, generated = false): SimZone {
  const zone: SimZone = { ns: [ns(nsName, ip)], records: {}, delegations: {}, generated };
  parent.delegations[name] = zone;
  ALL_ZONES.push({ name, zone });
  return zone;
}

/** Grows the hierarchy so qname has a chain of zones from the root down to its registrable domain. */
function ensureZones(qname: string) {
  const labels = qname.split(".");
  const tld = labels[labels.length - 1];
  if (RESERVED_TLDS.has(tld)) return;
  let parent = SIM_ROOT.delegations[tld] ?? addChild(SIM_ROOT, tld, `a.sim-tld-${tld}.invalid`, docIp("198.51.100", tld));
  let depth = 2;
  const suffix = labels.slice(-2).join(".");
  if (labels.length > 2 && SECOND_LEVEL.has(suffix)) {
    parent = parent.delegations[suffix] ?? addChild(parent, suffix, `a.sim-${suffix.replace(".", "-")}.invalid`, docIp("198.51.100", suffix));
    depth = 3;
  }
  if (labels.length < depth) return;
  const domain = labels.slice(-depth).join(".");
  if (!parent.delegations[domain]) addChild(parent, domain, `ns1.${domain}`, docIp("192.0.2", domain), true);
}

function generateRecords(zone: SimZone, zoneName: string, qname: string) {
  if (!zone.generated || zone.records[qname]) return;
  if (qname === `www.${zoneName}`) {
    zone.records[qname] = [rr(qname, "CNAME", zoneName, 600)];
    return;
  }
  const { ipv4, ipv6 } = ipRegistry.get(qname);
  zone.records[qname] = [rr(qname, "A", ipv4), ...(ipv6 ? [rr(qname, "AAAA", ipv6)] : [])];
}

/** A server may host several zones; pick the deepest one it serves that encloses qname. */
function findZone(ip: string, qname: string): { zone: SimZone; name: string } | null {
  const served = ALL_ZONES.filter(
    ({ name, zone }) =>
      (!name || qname === name || qname.endsWith(`.${name}`)) &&
      zone.ns.some((s) => (s.ip || lookupSimAddr(s.name)) === ip),
  );
  return served.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

function lookupSimAddr(host: string): string {
  const walk = (z: SimZone): string | undefined =>
    z.records[host]?.find((r) => r.type === "A")?.data ?? Object.values(z.delegations).map(walk).find(Boolean);
  return walk(SIM_ROOT) ?? "";
}

const simDelay = () => new Promise((r) => setTimeout(r, 25 + Math.random() * 60));

export const simTransport: Transport = {
  roots: SIM_ROOT.ns,
  async query(server, qname, qtype, timeoutMs) {
    ensureZones(qname);
    const found = findZone(server.ip, qname);
    if (!found || found.zone.dead) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      throw new TimeoutError(`no reply from ${server.ip} in ${timeoutMs} ms (simulated)`);
    }
    await simDelay();
    const { zone, name: zoneName } = found;
    const base: DnsMessage = { rcode: "NOERROR", aa: false, answer: [], authority: [], additional: [] };
    const soa = [rr(zoneName || ".", "SOA", `sim-soa min=${SOA_TTL}`, SOA_TTL)].map((r) => ({ ...r, minimum: SOA_TTL }));

    // delegation to a child zone that contains qname -> referral with glue
    const child = Object.keys(zone.delegations).find((c) => qname === c || qname.endsWith(`.${c}`));
    if (child) {
      const sub = zone.delegations[child];
      return {
        ...base,
        authority: sub.ns.map((s) => rr(child, "NS", s.name, 172800)),
        additional: sub.ns.filter((s) => s.ip).map((s) => rr(s.name, "A", s.ip, 172800)),
      };
    }
    generateRecords(zone, zoneName, qname);
    const owned = zone.records[qname];
    if (!owned) return { ...base, aa: true, rcode: "NXDOMAIN", authority: soa };
    const cname = owned.find((r) => r.type === "CNAME");
    const answer = cname ? [cname] : owned.filter((r) => r.type === qtype);
    return { ...base, aa: true, answer, authority: answer.length ? [] : soa };
  },
};
