"use client";
import { memo, useEffect, useRef, type ReactNode } from "react";
import {
  Activity, ArrowUpRight, BarChart3, BookCheck, Check, CircleCheck, CircleMinus, CircleX, Clock, CornerDownRight, Database, FlaskConical, History, Hourglass, Info, Landmark, Monitor, Network, ServerCog, X,
  type LucideIcon,
} from "lucide-react";
import type { DnsEvent, NodeId, QueryResult } from "@/shared/dns";
import { AMBER, CYAN, DIM, EMERALD, KIND_COLOR, KIND_LABEL, NODES, RULES, isTerminal, kindOf, type Journey, type Kind } from "@/lib/dns/visuals";
import type { HistoryRow, Run } from "@/hooks/useDnsResolver";

export const NODE_ICON: Record<NodeId, LucideIcon> = {
  client: Monitor, cache: Database, resolver: ServerCog, root: Landmark, tld: Network, auth: BookCheck,
};
const NODE_LABEL = Object.fromEntries(NODES.map((n) => [n.id, n.label])) as Record<NodeId, string>;

const KIND_ICON: Record<Kind, LucideIcon> = { query: ArrowUpRight, referral: CornerDownRight, success: Check, process: Hourglass, error: X };

/** Identifies an event kind without colour. Failure is the one kind with a solid mark. */
function KindMark({ kind }: { kind: Kind }) {
  const Icon = KIND_ICON[kind];
  if (kind === "error") {
    return (
      <span className="inline-grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm bg-error text-canvas">
        <Icon size={11} strokeWidth={3} aria-hidden />
      </span>
    );
  }
  return <Icon size={14} className="shrink-0" style={{ color: KIND_COLOR[kind] }} aria-hidden />;
}

export function Card({ title, icon: Icon, children, className = "", right }: { title: string; icon?: LucideIcon; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-line bg-card p-4 ${className}`} aria-label={title}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {Icon && <Icon size={14} className="text-accent" aria-hidden />} {title}
        </h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function SimBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-process/10 px-1.5 py-0.5 text-[11px] text-process">
      <FlaskConical size={11} aria-hidden /> Simulation
    </span>
  );
}

const isFailure = (s?: string) => !!s && s !== "NOERROR" && s !== "NODATA";
const STATUS_ICON: Record<string, LucideIcon> = { NOERROR: CircleCheck, NODATA: CircleMinus };

/** Status text with an icon, so success and failure differ by shape as well as by wording. */
function Status({ status }: { status: string }) {
  const Icon = STATUS_ICON[status] ?? CircleX;
  return (
    <span className={`inline-flex items-center gap-1 ${isFailure(status) ? "font-semibold text-error" : status === "NOERROR" ? "font-medium text-success" : "font-medium text-process"}`}>
      <Icon size={13} className="shrink-0" aria-hidden /> {status}
    </span>
  );
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false }) + "." + String(ts % 1000).padStart(3, "0");

/* ------------------------------ Current stage ------------------------------ */

export const StagePanel = memo(function StagePanel({ journey, run }: { journey: Journey; run: Run | null }) {
  const e = journey.current;
  if (!run) return <p className="text-sm text-muted">Enter a domain and press <b className="font-medium text-ink">Resolve Domain</b> to start a lookup.</p>;
  if (!e) return <p className="text-sm text-muted">{run.error ?? "Waiting for the first backend event…"}</p>;
  const kind = kindOf(e);
  const rule = RULES[e.type];
  const server = e.data?.server;
  return (
    <div aria-live="polite" className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <KindMark kind={kind} />
          <span className="text-sm font-semibold text-ink">{rule.stage}</span>
          <span className="rounded border border-line px-1 font-mono text-[10px] text-muted">{run.qtype}</span>
        </div>
        <div className="mt-1 text-xs text-muted">
          <span className="text-ink">{NODE_LABEL[e.node]}</span>
          {e.data?.rttMs != null && <span>, {e.data.rttMs} ms</span>}
          {server && <div className="truncate font-mono text-[11px]" title={`${server.name} (${server.ip})`}>{server.name} ({server.ip})</div>}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs leading-snug text-ink">{e.msg}</div>
        <p className="mt-1 text-[11px] leading-snug text-muted">{rule.explain}</p>
      </div>
    </div>
  );
});

/* -------------------------------- Stepper -------------------------------- */

const STEPS: { id: string; label: string; match: (e: DnsEvent) => boolean }[] = [
  { id: "client", label: "Client", match: (e) => e.type === "QUERY_STARTED" },
  { id: "cache", label: "Cache", match: (e) => e.type.startsWith("CACHE_") && e.type !== "CACHE_STORE" },
  { id: "root", label: "Root", match: (e) => e.type.startsWith("ROOT_") },
  { id: "tld", label: "TLD", match: (e) => e.type.startsWith("TLD_") },
  { id: "auth", label: "Authoritative", match: (e) => e.type.startsWith("AUTHORITATIVE_") || (e.type === "DNS_RESPONSE" && e.from === "auth") },
  { id: "answer", label: "Answer", match: (e) => e.type === "QUERY_COMPLETED" || e.type === "QUERY_FAILED" },
];

type StepState = "pending" | "active" | "done" | "failed" | "skipped";

function StepMarker({ state }: { state: StepState }) {
  const base = "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full transition-colors duration-300";
  if (state === "done") return <span className={`${base} bg-success/15 text-success`}><Check size={11} strokeWidth={2.5} aria-hidden /></span>;
  if (state === "failed") return <span className={`${base} bg-error text-canvas`}><X size={11} strokeWidth={3} aria-hidden /></span>;
  if (state === "active") return <span className={`${base} border border-accent shadow-[0_0_10px_var(--color-accent)]`}><span className="h-2 w-2 rounded-full bg-accent" /></span>;
  return <span className={`${base} border ${state === "skipped" ? "border-dashed border-muted/50" : "border-line"}`} />;
}

export const JourneyBar = memo(function JourneyBar({ played }: { played: DnsEvent[] }) {
  const cur = played[played.length - 1];
  const finished = !!cur && isTerminal(cur);
  const cacheHit = played.some((e) => e.type === "CACHE_HIT");
  const reached = STEPS.reduce((max, s, i) => (played.some(s.match) ? i : max), -1);
  return (
    <ol className="flex items-center gap-2 px-1" aria-label="DNS journey progress">
      {STEPS.map((s, i) => {
        const hits = played.filter(s.match);
        const last = hits[hits.length - 1];
        const isCur = !!cur && s.match(cur);
        const failed = !!last && kindOf(last) === "error";
        const state: StepState = failed ? "failed" : isCur && !finished ? "active" : last ? "done" : cacheHit && ["root", "tld", "auth"].includes(s.id) ? "skipped" : "pending";
        const text = state === "active" ? "font-medium text-accent" : state === "failed" ? "font-medium text-error" : state === "done" ? "text-ink" : "text-muted";
        return (
          <li key={s.id} className={`flex items-center gap-2 ${i < STEPS.length - 1 ? "flex-1" : ""}`} aria-current={isCur ? "step" : undefined}>
            <StepMarker state={state} />
            {/* phones show only the current step's name; the rest stay available to screen readers */}
            <span className={`whitespace-nowrap text-xs transition-colors duration-300 ${text} ${state === "skipped" ? "line-through" : ""} ${isCur ? "" : "max-sm:sr-only"}`}>{s.label}</span>
            {i < STEPS.length - 1 && <span className={`h-px min-w-2 flex-1 transition-colors duration-500 ${i < reached ? "bg-success/50" : "bg-line"}`} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
});

/* -------------------------------- Result -------------------------------- */

export const ResultPanel = memo(function ResultPanel({ run, result, className = "" }: { run: Run | null; result: QueryResult | null; className?: string }) {
  const ok = !!result && result.addresses.length > 0;
  const status = result?.status ?? (run?.error ? "ERROR" : undefined);
  const rows: [string, ReactNode][] = [
    ["Domain", run ? <span key="d" className="font-mono text-[13px]" title={run.domain}>{run.domain}</span> : "—"],
    ["Record type", run?.qtype ?? "—"],
    ["Status", status ? <Status key="s" status={status} /> : run ? <span key="s" className="text-muted">Resolving…</span> : "—"],
    ["TTL", result?.ttl != null ? `${result.ttl}s` : "—"],
    ["Duration", result ? <span key="t">{result.durationMs.toFixed(1)} ms <span className="text-muted">{result.cached ? "from cache" : "full resolution"}</span></span> : "—"],
  ];
  return (
    <Card title="Result" icon={ok ? CircleCheck : status && status !== "NOERROR" ? CircleX : Activity} right={run && <SimBadge />} className={className}>
      {ok && (
        <div className="mb-2 rounded-lg border border-success/25 bg-success/5 px-3 py-2.5">
          <div className="text-[11px] text-success">{result.qtype} address{result.addresses.length > 1 ? "es" : ""}</div>
          {result.addresses.map((a) => (
            <div key={a} className="mt-0.5 break-all bg-gradient-to-r from-accent to-success bg-clip-text font-mono text-xl font-semibold tracking-tight text-transparent">{a}</div>
          ))}
          {result.records.some((r) => r.type === "CNAME") && (
            <div className="mt-1 text-[11px] text-muted">via {result.records.filter((r) => r.type === "CNAME").map((r) => `${r.name} → ${r.value}`).join(", ")}</div>
          )}
        </div>
      )}
      {(run?.error || (result && !ok)) && (
        <div role="alert" className="mb-2 flex gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2.5 text-[13px] leading-snug text-ink">
          <CircleX size={15} className="mt-px shrink-0 text-error" aria-hidden />
          {run?.error ?? result?.error ?? (result?.status === "NODATA" ? `No ${result.qtype} record exists for this name.` : `${result?.status}: the domain could not be resolved.`)}
        </div>
      )}
      <dl className="divide-y divide-line text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 truncate text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
});

/* -------------------------------- Event log -------------------------------- */

export const EventLog = memo(function EventLog({ played, run, className = "" }: { played: DnsEvent[]; run: Run | null; className?: string }) {
  const t0 = played[0]?.ts ?? 0;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight; // keep the newest event in view
  }, [played.length]);
  return (
    <Card title="Live event log" icon={Clock} right={run?.streaming && <span className="text-[11px] text-muted">streaming…</span>} className={`flex flex-col ${className}`}>
      <ol ref={list} className="max-h-72 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-[11px] lg:max-h-none" aria-live="polite">
        {played.length === 0 && <li className="text-muted">Events appear here during a lookup.</li>}
        {played.map((e) => (
          <li key={e.seq}>
            <div className="flex items-center gap-1.5 font-mono">
              <KindMark kind={kindOf(e)} />
              <span className="font-medium" style={{ color: KIND_COLOR[kindOf(e)] }}>{e.type}</span>
              <span className="ml-auto text-muted" title={fmtTime(e.ts)}>+{e.ts - t0}ms</span>
            </div>
            <p className="mt-0.5 break-words pl-5 leading-snug text-muted">{e.msg}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
});

/* ------------------------------ Query history ------------------------------ */

export const HistoryTable = memo(function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  return (
    <Card title="Query history" icon={History}>
      <div className="max-h-64 overflow-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="sticky top-0 bg-card text-muted">
            <tr>
              {["Time", "Domain", "Type", "Status", "Address", "Duration"].map((h) => (
                <th key={h} scope="col" className="py-1.5 pr-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="text-ink">
            {rows.length === 0 && (
              <tr><td colSpan={6} className="border-t border-line py-2.5 text-muted">Lookups you run appear here.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.runId} className="border-t border-line transition-colors duration-150 hover:bg-hover">
                <td className="py-1.5 pr-3 font-mono text-muted">{fmtTime(r.ts)}</td>
                <td className="max-w-[180px] truncate py-1.5 pr-3 font-mono">{r.domain}</td>
                <td className="py-1.5 pr-3 text-muted">{r.qtype}</td>
                <td className="py-1.5 pr-3"><Status status={r.status} />{r.cached && <span className="text-muted">, cached</span>}</td>
                <td className="max-w-[200px] truncate py-1.5 pr-3 font-mono">{r.addresses.join(", ") || "—"}</td>
                <td className="py-1.5 pr-3 tabular-nums text-muted">{r.durationMs != null ? `${r.durationMs.toFixed(1)} ms` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
});

/* -------------------------------- Stats -------------------------------- */

export const StatsPanel = memo(function StatsPanel({ stats, className = "" }: { stats: { total: number; success: number; failed: number; cacheHits: number; cacheMisses: number; avgMs: number | null }; className?: string }) {
  const items: [string, string | number, string][] = [
    ["Total", stats.total, "text-ink"],
    ["Successful", stats.success, "text-success"],
    ["Failed", stats.failed, "text-error"],
    ["Cache hits", stats.cacheHits, "text-accent"],
    ["Cache misses", stats.cacheMisses, "text-process"],
    ["Avg time", stats.avgMs != null ? `${stats.avgMs.toFixed(0)} ms` : "—", "text-referral"],
  ];
  return (
    <Card title="Query statistics" icon={BarChart3} className={className}>
      {/* the 1px gap over a line-coloured background draws the dividers */}
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-line">
        {items.map(([k, v, color]) => (
          <div key={k} className="bg-card px-2.5 py-2">
            <dt className="truncate text-[11px] text-muted">{k}</dt>
            <dd className={`mt-0.5 text-lg font-semibold leading-tight tabular-nums ${v === 0 || v === "—" ? "text-muted" : color}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
});

/* -------------------------------- Legend -------------------------------- */

const STATE_KEY: [string, string][] = [["Idle", DIM], ["Waiting", AMBER], ["Active", CYAN], ["Resolved", EMERALD]];

export function Legend() {
  return (
    <div className="space-y-2.5 text-[11px] text-muted">
      <div className="grid grid-cols-1 gap-1.5">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <div key={k} className="flex items-center gap-2">
            <KindMark kind={k} />
            {KIND_LABEL[k]}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5 border-t border-line pt-2.5">
        {NODES.map((n) => {
          const Icon = NODE_ICON[n.id];
          return (
            <div key={n.id} className="flex items-center gap-1.5">
              <Icon size={12} aria-hidden className="shrink-0 text-accent" /> {n.label}
            </div>
          );
        })}
      </div>
      <p className="flex gap-1.5 border-t border-line pt-2.5 leading-snug">
        <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
        Arcs show which server the resolver talks to, not the physical route packets take. Map positions are illustrative: root and many TLD/authoritative servers are anycast, and an IP address does not reveal a server&apos;s location.
      </p>
      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-2.5">
        {STATE_KEY.map(([label, color]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1 text-error"><X size={11} strokeWidth={3} aria-hidden /> Failed</span>
      </div>
    </div>
  );
}
