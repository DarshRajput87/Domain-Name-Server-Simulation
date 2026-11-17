import type {
  DnsEvent, DnsEventData, DnsEventType, DnsRecord, NodeId, QueryResult, QueryType, ResultStatus, ServerRef,
} from "../src/shared/dns";
import { TimeoutError, type RR, type Transport } from "./transport";

const PER_SERVER_TIMEOUT_MS = 2000;
const QUERY_DEADLINE_MS = 15000;
const MAX_STEPS = 24;
const MAX_CNAME = 8;
const MAX_SERVERS_TRIED = 3;
const MAX_TTL = 86400;

/* --------------------------------- Cache --------------------------------- */

interface CacheEntry {
  status: ResultStatus;
  records: DnsRecord[];
  expires: number;
}

export class TtlCache {
  private map = new Map<string, CacheEntry>();
  constructor(private max = 2000) {}

  get(name: string, type: string): { entry: CacheEntry; remaining: number } | null {
    const key = `${name}|${type}`;
    const entry = this.map.get(key);
    if (!entry) return null;
    const remaining = Math.ceil((entry.expires - Date.now()) / 1000);
    if (remaining <= 0) {
      this.map.delete(key);
      return null;
    }
    return { entry, remaining };
  }

  set(name: string, type: string, status: ResultStatus, records: DnsRecord[], ttl: number) {
    if (ttl <= 0) return;
    const key = `${name}|${type}`;
    this.map.delete(key);
    this.map.set(key, { status, records, expires: Date.now() + Math.min(ttl, MAX_TTL) * 1000 });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  clear() {
    const n = this.map.size;
    this.map.clear();
    return n;
  }
}

/* -------------------------------- Resolver -------------------------------- */

class ResolveError extends Error {
  constructor(public status: ResultStatus, message: string, public node: NodeId = "resolver") {
    super(message);
  }
}

type Emit = (type: DnsEventType, node: NodeId, msg: string, data?: DnsEventData, from?: NodeId) => void;

const toRecord = (r: RR): DnsRecord => ({ name: r.name, type: r.type as DnsRecord["type"], ttl: r.ttl, value: r.data });
const tierOf = (zone: string): NodeId => (zone === "." ? "root" : zone.includes(".") ? "auth" : "tld");
const inZone = (name: string, zone: string) => zone === "." || name === zone || name.endsWith(`.${zone}`);
const label = { root: "root", tld: "TLD", auth: "authoritative" } as Record<NodeId, string>;
const QUERY_EVENT: Partial<Record<NodeId, DnsEventType>> = { root: "ROOT_QUERY", tld: "TLD_QUERY", auth: "AUTHORITATIVE_QUERY" };
const REFERRAL_EVENT: Partial<Record<NodeId, DnsEventType>> = { root: "ROOT_REFERRAL", tld: "TLD_REFERRAL", auth: "AUTHORITATIVE_REFERRAL" };

export class Resolver {
  readonly cache = new TtlCache();
  constructor(private transport: Transport) {}

  /** Full lifecycle for one client query; emits events and never throws. */
  async resolve(qid: string, domain: string, qtype: QueryType, sink: (e: DnsEvent) => void, isCancelled: () => boolean) {
    const t0 = performance.now();
    const deadline = Date.now() + QUERY_DEADLINE_MS;
    let seq = 0;
    const emit: Emit = (type, node, msg, data, from) => {
      if (!isCancelled()) sink({ qid, seq: seq++, ts: Date.now(), type, node, from, msg, ...(data && { data }) });
    };
    const finish = (status: ResultStatus, records: DnsRecord[], cached: boolean, ttl?: number, error?: string): QueryResult => {
      const addresses = records.filter((r) => r.type === qtype).map((r) => r.value);
      return { domain, qtype, status, addresses, records, ttl, cached, durationMs: +(performance.now() - t0).toFixed(1), error };
    };

    emit("QUERY_STARTED", "resolver", `Client asks resolver for ${domain} ${qtype}`, undefined, "client");
    emit("CACHE_CHECK", "cache", `Resolver checks its cache for ${domain}/${qtype}`, undefined, "resolver");

    const hit = this.cache.get(domain, qtype);
    if (hit) {
      const records = hit.entry.records.map((r) => ({ ...r, ttl: hit.remaining }));
      emit("CACHE_HIT", "resolver", `Cache hit (${hit.entry.status}), ${hit.remaining}s TTL remaining`, { records, ttl: hit.remaining, rcode: hit.entry.status }, "cache");
      const result = finish(hit.entry.status, records, true, hit.remaining);
      const ok = hit.entry.status === "NOERROR";
      emit(ok ? "QUERY_COMPLETED" : "QUERY_FAILED", "client", ok ? `Answer served from cache: ${result.addresses.join(", ")}` : `Cached negative answer: ${hit.entry.status}`, { result }, "resolver");
      return;
    }
    emit("CACHE_MISS", "resolver", "No valid cached record, starting iterative resolution at the root", undefined, "cache");

    try {
      const { status, records, ttl } = await this.iterate(domain, qtype, emit, deadline, isCancelled, 0);
      if (isCancelled()) return;
      this.cache.set(domain, qtype, status, records, ttl);
      emit("CACHE_STORE", "cache", `Resolver caches ${status === "NOERROR" ? "answer" : `negative answer (${status})`} for ${ttl}s`, { ttl, rcode: status }, "resolver");
      const result = finish(status, records, false, ttl);
      if (status === "NOERROR") emit("QUERY_COMPLETED", "client", `Final answer: ${result.addresses.join(", ")}`, { result }, "resolver");
      else emit("QUERY_FAILED", "client", status === "NXDOMAIN" ? `${domain} does not exist (NXDOMAIN)` : `${domain} has no ${qtype} record (NODATA)`, { result }, "resolver");
    } catch (err) {
      const e = err instanceof ResolveError ? err : new ResolveError("ERROR", (err as Error).message);
      emit("QUERY_FAILED", "client", e.message, { result: finish(e.status, [], false, undefined, e.message), rcode: e.status, failedAt: e.node }, "resolver");
    }
  }

  private async iterate(
    qname: string, qtype: QueryType, emit: Emit, deadline: number, isCancelled: () => boolean, depth: number,
  ): Promise<{ status: ResultStatus; records: DnsRecord[]; ttl: number }> {
    if (depth > 3) throw new ResolveError("SERVFAIL", "Too many nested name-server lookups");
    const chain: DnsRecord[] = [];
    let name = qname;
    let zone = ".";
    let servers = this.transport.roots;
    let cnames = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (isCancelled()) throw new ResolveError("ERROR", "Cancelled");
      const tier = tierOf(zone);
      const { msg, server, rttMs } = await this.ask(servers, zone, name, qtype, tier, emit, deadline);

      if (msg.rcode === "NXDOMAIN" || (msg.rcode === "NOERROR" && msg.aa && !msg.answer.length)) {
        const status: ResultStatus = msg.rcode === "NXDOMAIN" ? "NXDOMAIN" : "NODATA";
        const ttl = msg.authority.find((r) => r.type === "SOA")?.minimum ?? 60;
        emit("DNS_RESPONSE", "resolver", `${server.name} answers ${status} for ${name}`, { server, rcode: status, zone, rttMs }, tier);
        return { status, records: chain, ttl: Math.min(ttl, ...chain.map((r) => r.ttl)) };
      }
      if (msg.rcode !== "NOERROR") throw new ResolveError(msg.rcode === "REFUSED" ? "REFUSED" : "SERVFAIL", `${server.name} returned ${msg.rcode}`, tier);

      const answers = msg.answer.filter((r) => r.name === name && r.type === qtype);
      const cname = msg.answer.find((r) => r.name === name && r.type === "CNAME");
      if (answers.length) {
        const records = [...chain, ...answers.map(toRecord)];
        emit("DNS_RESPONSE", "resolver", `${server.name} returns ${answers.length} ${qtype} record(s) for ${name}`, { server, records: answers.map(toRecord), rcode: "NOERROR", zone, rttMs }, tier);
        return { status: "NOERROR", records, ttl: Math.min(...records.map((r) => r.ttl)) };
      }
      if (cname) {
        if (++cnames > MAX_CNAME) throw new ResolveError("SERVFAIL", "CNAME chain too long");
        chain.push(toRecord(cname));
        // follow in-message answers for the target if present, otherwise restart from the root
        const target = cname.data;
        const inline = msg.answer.filter((r) => r.name === target && r.type === qtype);
        emit("DNS_RESPONSE", "resolver", `${name} is an alias (CNAME) for ${target}${inline.length ? "" : ", restarting at the root"}`, { server, records: [toRecord(cname)], rcode: "NOERROR", zone, rttMs }, tier);
        if (inline.length) {
          const records = [...chain, ...inline.map(toRecord)];
          return { status: "NOERROR", records, ttl: Math.min(...records.map((r) => r.ttl)) };
        }
        name = target;
        zone = ".";
        servers = this.transport.roots;
        continue;
      }

      // Referral: NS records for a zone closer to the name than the current one
      const nsRecords = msg.authority.filter((r) => r.type === "NS");
      const child = nsRecords[0]?.name;
      if (!child || !inZone(name, child) || (zone !== "." && !inZone(child, zone)) || child === zone) {
        throw new ResolveError("SERVFAIL", `Lame or invalid response from ${server.name} for ${name}`, tier);
      }
      const nsNames = [...new Set(nsRecords.filter((r) => r.name === child).map((r) => r.data))];
      const glue = msg.additional.filter((r) => r.type === "A" && nsNames.includes(r.name));
      let next: ServerRef[] = glue.map((r) => ({ name: r.name, ip: r.data }));
      const display = child.includes(".") ? child : `.${child}`;
      emit(REFERRAL_EVENT[tier]!, "resolver", `${server.name} refers resolver to ${display} name servers: ${nsNames.slice(0, 3).join(", ")}${nsNames.length > 3 ? "â€¦" : ""}${glue.length ? "" : " (no glue)"}`, { server, zone: child, ns: nsNames.slice(0, 6), rttMs }, tier);

      if (!next.length) next = await this.resolveNsAddresses(nsNames, deadline, isCancelled, depth);
      if (!next.length) throw new ResolveError("SERVFAIL", `Could not find addresses for ${display} name servers`, tier);
      zone = child;
      servers = next;
    }
    throw new ResolveError("SERVFAIL", "Too many referrals");
  }

  /** Glueless delegation: look up NS host addresses quietly (cached), not shown as a separate journey. */
  private async resolveNsAddresses(nsNames: string[], deadline: number, isCancelled: () => boolean, depth: number) {
    for (const host of nsNames.slice(0, 2)) {
      const cached = this.cache.get(host, "A");
      let records = cached?.entry.records;
      if (!records) {
        try {
          const r = await this.iterate(host, "A", () => {}, deadline, isCancelled, depth + 1);
          this.cache.set(host, "A", r.status, r.records, r.ttl);
          records = r.records;
        } catch {
          continue;
        }
      }
      const ips = records.filter((r) => r.type === "A").map((r) => ({ name: host, ip: r.value }));
      if (ips.length) return ips;
    }
    return [];
  }

  private async ask(servers: ServerRef[], zone: string, name: string, qtype: QueryType, tier: NodeId, emit: Emit, deadline: number) {
    // spread load across servers like real resolvers do
    const order = [...servers].sort(() => Math.random() - 0.5).slice(0, MAX_SERVERS_TRIED);
    let lastErr: Error | null = null;
    for (const server of order) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const zoneLabel = zone === "." ? "the root zone" : zone;
      emit(QUERY_EVENT[tier]!, tier, `${lastErr ? `Retrying after failure (${lastErr.message}). ` : ""}Resolver asks ${label[tier]} server ${server.name} (${server.ip}) for ${name} ${qtype} [${zoneLabel}]`, { server, zone }, "resolver");
      const t = performance.now();
      try {
        const msg = await this.transport.query(server, name, qtype, Math.min(PER_SERVER_TIMEOUT_MS, remaining));
        return { msg, server, rttMs: Math.round(performance.now() - t) };
      } catch (err) {
        lastErr = err as Error;
      }
    }
    const timedOut = !lastErr || lastErr instanceof TimeoutError;
    throw new ResolveError(timedOut ? "TIMEOUT" : "ERROR", `${label[tier]} servers for ${zone} did not respond: ${lastErr?.message ?? "deadline exceeded"}`, tier);
  }
}
