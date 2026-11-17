// Config-driven mapping from backend DNS events to visual state (shared by the graph and the globe).
import type { DnsEvent, DnsEventType, NodeId, QueryResult } from "@/shared/dns";

export type Kind = "query" | "referral" | "success" | "process" | "error";
export type NodeState = "idle" | "active" | "query-sent" | "waiting" | "cache-hit" | "cache-miss" | "referral" | "resolved" | "failed";

// Same values as the @theme tokens in globals.css, for WebGL and SVG, which need literal colours.
export const CANVAS = "#080808";
export const INK = "#f5f5f5";
export const MUTED = "#a1a1aa";
export const DIM = "#8a8a8a"; // non-text marks and idle states; still 5:1 on the card background
export const LINE = "#262626";

export const CYAN = "#22d3ee";
export const SKY = "#38bdf8";
export const VIOLET = "#a78bfa";
export const EMERALD = "#34d399";
export const AMBER = "#fbbf24";
export const ROSE = "#fb7185";

// Colour is never the only cue: each kind also has a line pattern (KIND_DASH) and an icon (KIND_ICON in ui.tsx).
export const KIND_COLOR: Record<Kind, string> = {
  query: SKY,
  referral: VIOLET,
  success: EMERALD,
  process: AMBER,
  error: ROSE,
};

/** SVG dash pattern for an edge that has been visited; undefined is a solid line. */
export const KIND_DASH: Record<Kind, string | undefined> = {
  query: undefined,
  referral: "6 4",
  success: undefined,
  process: "2 4",
  error: "1 5",
};

export const KIND_LABEL: Record<Kind, string> = {
  query: "Outgoing DNS query",
  referral: "Referral / routing",
  success: "Successful response",
  process: "Processing / cache miss",
  error: "Failure / timeout",
};

export const STATE_STYLE: Record<NodeState, { label: string; color: string }> = {
  idle: { label: "Idle", color: DIM },
  active: { label: "Active", color: CYAN },
  "query-sent": { label: "Query sent", color: SKY },
  waiting: { label: "Waiting for response", color: AMBER },
  "cache-hit": { label: "Cache hit", color: EMERALD },
  "cache-miss": { label: "Cache miss", color: AMBER },
  referral: { label: "Referral received", color: VIOLET },
  resolved: { label: "Resolved", color: EMERALD },
  failed: { label: "Failed", color: ROSE }, // also gets an X wherever it appears
};

export interface NodeDef {
  id: NodeId;
  label: string;
  desc: string;
  pos: { x: number; y: number }; // graph layout
  compactPos: { x: number; y: number }; // two columns for phones, so nodes stay legible
}

export const NODES: NodeDef[] = [
  { id: "client", label: "Client", desc: "Your device's stub resolver", pos: { x: 0, y: 170 }, compactPos: { x: 0, y: 0 } },
  { id: "resolver", label: "Recursive Resolver", desc: "Walks the hierarchy on the client's behalf", pos: { x: 330, y: 170 }, compactPos: { x: 0, y: 190 } },
  { id: "cache", label: "DNS Cache", desc: "Resolver's TTL-bound answer cache", pos: { x: 330, y: 390 }, compactPos: { x: 0, y: 380 } },
  { id: "root", label: "Root DNS Server", desc: "Knows the servers for every TLD", pos: { x: 690, y: 0 }, compactPos: { x: 270, y: 0 } },
  { id: "tld", label: "TLD DNS Server", desc: "Knows the name servers for each domain", pos: { x: 690, y: 170 }, compactPos: { x: 270, y: 190 } },
  { id: "auth", label: "Authoritative Server", desc: "Holds the domain's actual records", pos: { x: 690, y: 340 }, compactPos: { x: 270, y: 380 } },
];

export const EDGES: { id: string; source: NodeId; target: NodeId }[] = [
  { id: "client-resolver", source: "client", target: "resolver" },
  { id: "resolver-cache", source: "resolver", target: "cache" },
  { id: "resolver-root", source: "resolver", target: "root" },
  { id: "resolver-tld", source: "resolver", target: "tld" },
  { id: "resolver-auth", source: "resolver", target: "auth" },
];

type Rule = {
  kind: Kind | ((e: DnsEvent) => Kind);
  stage: string;
  explain: string;
  label: (e: DnsEvent) => string;
  states: (e: DnsEvent) => Partial<Record<NodeId, NodeState>>;
};

const isOk = (e: DnsEvent) => !e.data?.rcode || e.data.rcode === "NOERROR";
const zoneName = (z?: string) => (z ? (z.includes(".") ? z : `.${z}`) : "");
const query = (stage: string, explain: string): Rule => ({
  kind: "query",
  stage,
  explain,
  label: (e) => (e.msg.startsWith("Retrying") ? "DNS Query (retry)" : "DNS Query"),
  states: (e) => ({ [e.node]: "active", resolver: "waiting" }),
});
const referral = (stage: string, explain: string): Rule => ({
  kind: "referral",
  stage,
  explain,
  label: (e) => `Referral: ${zoneName(e.data?.zone)}`,
  states: (e) => ({ [e.from!]: "referral", resolver: "referral" }),
});

export const RULES: Record<DnsEventType, Rule> = {
  QUERY_STARTED: {
    kind: "query",
    stage: "Client query",
    explain: "The client's stub resolver sends a recursive query to its configured recursive resolver.",
    label: () => "DNS Query",
    states: () => ({ client: "query-sent", resolver: "active" }),
  },
  CACHE_CHECK: {
    kind: "process",
    stage: "Cache check",
    explain: "The resolver first looks for an unexpired answer in its cache.",
    label: () => "Cache Lookup",
    states: () => ({ resolver: "waiting", cache: "active" }),
  },
  CACHE_HIT: {
    kind: "success",
    stage: "Cache hit",
    explain: "A cached answer is still within its TTL, so no root, TLD or authoritative server is contacted.",
    label: (e) => `Cache Hit · TTL ${e.data?.ttl ?? "?"}s`,
    states: () => ({ cache: "cache-hit", resolver: "active" }),
  },
  CACHE_MISS: {
    kind: "process",
    stage: "Cache miss",
    explain: "Nothing valid is cached. The resolver will walk the DNS tree iteratively, starting at the root.",
    label: () => "Cache Miss",
    states: () => ({ cache: "cache-miss", resolver: "active" }),
  },
  ROOT_QUERY: query("Querying root", "Root servers don't hold the answer, but know which name servers serve every top-level domain."),
  ROOT_REFERRAL: referral("Root referral", "The root replies with a referral: NS records (and glue addresses) for the TLD, not the final answer."),
  TLD_QUERY: query("Querying TLD", "TLD servers know which name servers are authoritative for each domain registered under them."),
  TLD_REFERRAL: referral("TLD referral", "The TLD delegates the domain to its authoritative name servers."),
  AUTHORITATIVE_QUERY: query("Querying authoritative", "The authoritative server holds the zone's actual records."),
  AUTHORITATIVE_REFERRAL: referral("Sub-zone referral", "This server delegates a sub-zone further down the tree, so the resolver follows one more referral."),
  DNS_RESPONSE: {
    kind: (e) => (!isOk(e) ? "error" : e.data?.records?.[0]?.type === "CNAME" ? "referral" : "success"),
    stage: "Answer received",
    explain: "The server returns an authoritative answer — the record, an alias (CNAME) to follow, or a definitive negative answer.",
    label: (e) => {
      const r = e.data?.records?.[0];
      if (!isOk(e)) return e.data!.rcode!;
      if (r?.type === "CNAME") return `CNAME → ${r.value}`;
      return `${r?.type ?? ""} Record Response`;
    },
    states: (e) => ({ [e.from!]: isOk(e) ? "resolved" : "failed", resolver: "active" }),
  },
  CACHE_STORE: {
    kind: "process",
    stage: "Caching answer",
    explain: "The resolver stores the answer for its TTL so repeat queries are answered instantly.",
    label: (e) => `Cache Store · TTL ${e.data?.ttl}s`,
    states: () => ({ cache: "resolved", resolver: "active" }),
  },
  QUERY_COMPLETED: {
    kind: "success",
    stage: "Answer delivered",
    explain: "The resolver returns the final answer to the client.",
    label: () => "Final Answer",
    states: () => ({ resolver: "resolved", client: "resolved" }),
  },
  QUERY_FAILED: {
    kind: "error",
    stage: "Resolution failed",
    explain: "The lookup could not produce an address; the client receives an error.",
    label: (e) => e.data?.result?.status ?? "Error",
    // NXDOMAIN/NODATA are definitive answers: the resolver did its job, the client just gets no address
    states: (e) => ({ client: "failed", resolver: e.data?.failedAt ? "failed" : "resolved", ...(e.data?.failedAt && { [e.data.failedAt]: "failed" }) }),
  },
};

export const kindOf = (e: DnsEvent): Kind => {
  const k = RULES[e.type].kind;
  return typeof k === "function" ? k(e) : k;
};

export interface ActiveEdge {
  id: string;
  forward: boolean; // true when travelling source -> target as defined in EDGES
  kind: Kind;
  label: string;
}

export function edgeFor(e: DnsEvent): ActiveEdge | null {
  if (!e.from || e.from === e.node) return null;
  const def = EDGES.find((d) => (d.source === e.from && d.target === e.node) || (d.source === e.node && d.target === e.from));
  return def ? { id: def.id, forward: def.source === e.from, kind: kindOf(e), label: RULES[e.type].label(e) } : null;
}

export interface Journey {
  states: Record<NodeId, NodeState>;
  current: DnsEvent | null;
  active: ActiveEdge | null;
  visited: Map<string, Kind>; // edge id -> last kind seen
  result: QueryResult | null;
}

const IDLE = Object.fromEntries(NODES.map((n) => [n.id, "idle"])) as Record<NodeId, NodeState>;

export function deriveJourney(events: DnsEvent[]): Journey {
  const states = { ...IDLE };
  const visited = new Map<string, Kind>();
  let active: ActiveEdge | null = null;
  for (const e of events) {
    Object.assign(states, RULES[e.type].states(e));
    active = edgeFor(e);
    if (active) visited.set(active.id, active.kind);
  }
  const current = events[events.length - 1] ?? null;
  return { states, current, active, visited, result: current?.data?.result ?? null };
}

export const isTerminal = (e: DnsEvent) => e.type === "QUERY_COMPLETED" || e.type === "QUERY_FAILED";
