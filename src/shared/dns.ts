// Shared DNS types + wire protocol. Imported by the TCP server, the Next.js gateway and the UI.

export const RECORD_TYPES = ["A", "AAAA"] as const;
export type QueryType = (typeof RECORD_TYPES)[number];
export type RecordType = QueryType | "CNAME" | "NS" | "SOA";

export type NodeId = "client" | "cache" | "resolver" | "root" | "tld" | "auth";

export type DnsEventType =
  | "QUERY_STARTED"
  | "CACHE_CHECK"
  | "CACHE_HIT"
  | "CACHE_MISS"
  | "ROOT_QUERY"
  | "ROOT_REFERRAL"
  | "TLD_QUERY"
  | "TLD_REFERRAL"
  | "AUTHORITATIVE_QUERY"
  | "AUTHORITATIVE_REFERRAL" // extra delegation below the TLD (e.g. co.uk -> example.co.uk)
  | "DNS_RESPONSE"
  | "CACHE_STORE"
  | "QUERY_COMPLETED"
  | "QUERY_FAILED";

export type ResultStatus =
  | "NOERROR"
  | "NODATA" // name exists, no record of the requested type
  | "NXDOMAIN"
  | "SERVFAIL"
  | "REFUSED"
  | "TIMEOUT"
  | "ERROR";

export interface DnsRecord {
  name: string;
  type: RecordType;
  ttl: number;
  value: string;
}

export interface ServerRef {
  name: string;
  ip: string;
}

export interface QueryResult {
  domain: string;
  qtype: QueryType;
  status: ResultStatus;
  addresses: string[];
  records: DnsRecord[];
  ttl?: number;
  cached: boolean;
  durationMs: number;
  error?: string;
}

/** Only the fields relevant to an event are present. */
export interface DnsEventData {
  zone?: string; // zone being queried, or zone delegated to in a referral
  server?: ServerRef;
  ns?: string[];
  records?: DnsRecord[];
  rcode?: ResultStatus;
  ttl?: number;
  rttMs?: number;
  result?: QueryResult;
  failedAt?: NodeId;
}

export interface DnsEvent {
  qid: string;
  seq: number;
  ts: number;
  type: DnsEventType;
  node: NodeId; // node the event happens at / is addressed to
  from?: NodeId; // sender, when the event travels along an edge
  msg: string;
  data?: DnsEventData;
}

/* ---------- Newline-delimited JSON protocol (TCP and HTTP stream) ---------- */

export type ClientMessage =
  | { t: "resolve"; qid: string; domain: string; qtype: string }
  | { t: "cancel"; qid: string }
  | { t: "flush" }
  | { t: "ping" };

export type ServerMessage =
  | { t: "event"; e: DnsEvent }
  | { t: "error"; qid?: string; code: ErrorCode; msg: string }
  | { t: "flushed"; removed: number }
  | { t: "pong"; version: number };

export type ErrorCode = "INVALID_DOMAIN" | "UNSUPPORTED_TYPE" | "BAD_REQUEST" | "BACKEND_UNAVAILABLE" | "BUSY";

export const PROTOCOL_VERSION = 1;

export function isQueryType(t: string): t is QueryType {
  return (RECORD_TYPES as readonly string[]).includes(t);
}

/** Normalises user input to an ASCII (punycode) FQDN without trailing dot. */
export function normalizeDomain(input: string): { ok: true; domain: string } | { ok: false; error: string } {
  let d = input.trim().toLowerCase().replace(/\.$/, "");
  if (!d) return { ok: false, error: "Enter a domain name." };
  if (/\s/.test(d)) return { ok: false, error: "Domain names cannot contain spaces." };
  if (/^[a-z]+:\/\//.test(d) || /[\/@:?#]/.test(d)) return { ok: false, error: "Enter a bare domain, not a URL." };
  try {
    d = new URL(`http://${d}`).hostname; // IDN -> punycode
  } catch {
    return { ok: false, error: "Invalid domain name." };
  }
  if (d.length > 253) return { ok: false, error: "Domain exceeds 253 characters." };
  const labels = d.split(".");
  for (const l of labels) {
    if (!/^[a-z0-9_](?:[a-z0-9-_]{0,61}[a-z0-9])?$/.test(l)) return { ok: false, error: `Invalid label "${l || "(empty)"}".` };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, error: "IP addresses are not domain names." };
  return { ok: true, domain: d };
}
