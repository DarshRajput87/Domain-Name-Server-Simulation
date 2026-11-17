"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, CircleAlert, Eraser, Globe, Layers, LoaderCircle, Pause, RotateCcw, Rotate3d, Search, Share2, ZoomIn, ZoomOut } from "lucide-react";
import { normalizeDomain, RECORD_TYPES, type QueryType } from "@/shared/dns";
import { CLIENT_PRESETS, placeNodes, type ClientPresetId } from "@/lib/dns/geo";
import { STEP_MS, useDnsResolver } from "@/hooks/useDnsResolver";
import DnsGraph from "./DnsGraph";
import GlobeView from "./globe/GlobeView";
import type { GlobeApi } from "./globe/GlobeScene";
import { EventLog, HistoryTable, JourneyBar, Legend, ResultPanel, SimBadge, StagePanel, StatsPanel } from "./ui";

const EXAMPLES: [string, QueryType][] = [
  ["example.com", "A"], ["www.example.com", "AAAA"], ["wiki.org", "AAAA"], ["glueless.org", "A"], ["acme-shop.com", "AAAA"], ["nope.example.com", "A"], ["www.deadzone.io", "A"],
  ["google.com", "A"], ["www.bbc.co.uk", "AAAA"],
];
const SPEEDS = [0.5, 1, 2, 4];

const SEGMENTS = "flex rounded-lg border border-line bg-canvas p-0.5";
const segment = (selected: boolean) =>
  `rounded-md transition-colors duration-200 ${selected ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"}`;
const TOOL_BUTTON = "rounded-md p-1.5 text-muted transition-colors duration-200 hover:bg-hover hover:text-ink";

type Backend = { state: "checking" | "up" | "down"; detail?: string };

async function control(body: object) {
  const res = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; error?: string; removed?: number };
  if (!json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export default function Dashboard() {
  const dns = useDnsResolver();
  const { run, journey, played, speed, setSpeed, busy, finished } = dns;
  const [domain, setDomain] = useState("example.com");
  const [qtype, setQtype] = useState<QueryType>("A");
  const [view, setView] = useState<"globe" | "graph">("globe");
  const [preset, setPreset] = useState<ClientPresetId>("london");
  const [autoRotate, setAutoRotate] = useState(true);
  const [inputError, setInputError] = useState<string | null>(null);
  const [backend, setBackend] = useState<Backend>({ state: "checking" });
  const [notice, setNotice] = useState<string | null>(null);
  const globeApi = useRef<GlobeApi>(null);

  const checkBackend = useCallback(() => {
    control({ action: "ping" }).then(
      () => setBackend({ state: "up" }),
      (e: Error) => setBackend({ state: "down", detail: e.message }),
    );
  }, []);
  useEffect(checkBackend, [checkBackend]);
  useEffect(() => {
    if (run?.error?.includes("unreachable") || run?.error?.includes("lost")) checkBackend();
  }, [run?.error, checkBackend]);

  const submit = (e?: FormEvent, d = domain, t = qtype) => {
    e?.preventDefault();
    const norm = normalizeDomain(d);
    if (!norm.ok) return setInputError(norm.error);
    setInputError(null);
    setNotice(null);
    dns.resolve(norm.domain, t);
  };

  const flush = async () => {
    try {
      const r = await control({ action: "flush" });
      setNotice(`Cleared ${r.removed} cached entr${r.removed === 1 ? "y" : "ies"}.`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const stepMs = STEP_MS / speed;
  const places = useMemo(() => placeNodes(preset, run?.domain ?? domain, played), [preset, run?.domain, domain, played]);
  const focus = CLIENT_PRESETS.find((p) => p.id === preset)!.client;
  const graph = <DnsGraph journey={journey} stepMs={stepMs} />;

  return (
    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-4 px-4 py-4 sm:px-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><Globe size={16} aria-hidden /></span>
          <div className="min-w-0">
            <h1 className="truncate bg-gradient-to-r from-ink to-accent bg-clip-text text-[15px] font-semibold leading-5 tracking-tight text-transparent">DNS Resolution Observatory</h1>
            <p className="truncate text-xs leading-4 text-muted">Follow a query from your device through the DNS hierarchy and back.</p>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title={backend.detail ?? "DNS service"}>
          <span className={`h-1.5 w-1.5 rounded-full ${backend.state === "up" ? "bg-success shadow-[0_0_8px_var(--color-success)]" : backend.state === "down" ? "bg-error" : "animate-pulse bg-process"}`} />
          <span><span className="max-sm:sr-only">DNS service </span>{backend.state === "up" ? "connected" : backend.state === "down" ? "offline" : "checking…"}</span>
        </span>
      </header>

      {backend.state === "down" && (
        <div role="alert" className="flex gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-[13px] text-ink">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-error" aria-hidden />
          <p>
            The DNS TCP service is unreachable ({backend.detail}). Start it with <code className="rounded bg-hover px-1 font-mono text-xs">npm run dns-server</code> or run everything with <code className="rounded bg-hover px-1 font-mono text-xs">npm run dev</code>.{" "}
            <button onClick={checkBackend} className="underline underline-offset-2 transition-colors duration-200 hover:text-muted">Retry</button>
          </p>
        </div>
      )}

      {/* Query */}
      <section className="flex flex-col gap-2" aria-label="DNS query">
        <form onSubmit={submit} noValidate>
          <div className={`flex h-12 items-center rounded-xl border bg-surface pl-3.5 pr-1.5 transition-colors duration-200 focus-within:border-accent hover:border-white/20 ${inputError ? "border-error" : "border-line"}`}>
            <Search size={16} className="shrink-0 text-accent" aria-hidden />
            <label htmlFor="domain" className="sr-only">Domain name</label>
            <input
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!inputError}
              aria-describedby={inputError ? "domain-error" : undefined}
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[15px] text-ink outline-none placeholder:text-muted"
            />
            <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
            <label htmlFor="qtype" className="sr-only">Record type</label>
            <select
              id="qtype"
              value={qtype}
              onChange={(e) => setQtype(e.target.value as QueryType)}
              className="h-9 shrink-0 cursor-pointer rounded-md bg-transparent px-1.5 font-mono text-[13px] text-ink transition-colors duration-200 hover:bg-hover"
            >
              {RECORD_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <button
              type="submit"
              className="ml-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-query to-accent px-3 text-[13px] font-semibold text-canvas transition-[filter,transform] duration-200 hover:brightness-110 active:scale-[0.98]"
            >
              {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <Search size={14} className="max-sm:hidden" aria-hidden />}
              <span>Resolve<span className="max-sm:sr-only"> Domain</span></span>
            </button>
          </div>
          {inputError && (
            <p id="domain-error" role="alert" className="mt-1.5 flex items-center gap-1 px-1 text-xs font-medium text-error">
              <CircleAlert size={13} aria-hidden /> {inputError}
            </p>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 sm:flex-wrap" style={{ scrollbarWidth: "none" }} aria-label="Example queries">
            {EXAMPLES.map(([d, t]) => (
              <button
                key={d + t}
                type="button"
                onClick={() => (setDomain(d), setQtype(t), submit(undefined, d, t))}
                className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink/80 transition-colors duration-200 hover:bg-hover hover:text-ink"
              >
                {d} <span className="text-accent">{t}</span>
              </button>
            ))}
          </div>
          {notice && <p role="status" className="text-[11px] text-muted max-sm:order-last max-sm:w-full">{notice}</p>}
          <button type="button" onClick={flush} title="Clear the resolver cache" className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-200 hover:bg-hover hover:text-ink">
            <Eraser size={12} aria-hidden /> Flush cache
          </button>
        </div>
      </section>

      <JourneyBar played={played} />

      {/* Stage and results share one height on large screens, so their edges always line up */}
      <div className="grid gap-4 lg:h-[max(640px,calc(100vh-214px))] lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_372px]">
        <section className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-canvas" aria-label="Resolution visualization">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-2.5 py-2 text-xs">
            <div className={SEGMENTS} role="tablist" aria-label="Visualization type">
              {([["globe", "3D Globe", Globe], ["graph", "Graph", Share2]] as const).map(([v, label, Icon]) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`flex items-center gap-1.5 px-2.5 py-1 font-medium ${segment(view === v)}`}>
                  <Icon size={13} aria-hidden /> {label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-2">
              <div className={SEGMENTS} role="group" aria-label="Playback speed">
                {SPEEDS.map((s) => (
                  <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s} className={`px-2 py-1 tabular-nums ${segment(speed === s)}`}>
                    {s}×
                  </button>
                ))}
              </div>
              <button onClick={dns.replay} disabled={!finished || !run?.events.length} title="Replay lookup" aria-label="Replay lookup" className={`${TOOL_BUTTON} disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted`}>
                <RotateCcw size={14} />
              </button>
              {view === "globe" && (
                <>
                  <button onClick={() => setAutoRotate((r) => !r)} aria-pressed={autoRotate} title="Toggle globe rotation" aria-label="Toggle globe rotation" className={TOOL_BUTTON}>
                    {autoRotate ? <Pause size={14} /> : <Rotate3d size={14} />}
                  </button>
                  <button onClick={() => globeApi.current?.zoom(1)} title="Zoom in" aria-label="Zoom in" className={TOOL_BUTTON}><ZoomIn size={14} /></button>
                  <button onClick={() => globeApi.current?.zoom(-1)} title="Zoom out" aria-label="Zoom out" className={TOOL_BUTTON}><ZoomOut size={14} /></button>
                  <label className="sr-only" htmlFor="client-loc">Client location</label>
                  <select id="client-loc" value={preset} onChange={(e) => setPreset(e.target.value as ClientPresetId)}
                    className="cursor-pointer rounded-md border border-line bg-canvas px-1.5 py-1 text-xs text-ink transition-colors duration-200 hover:bg-hover" title="Illustrative client location">
                    {CLIENT_PRESETS.map((p) => <option key={p.id} value={p.id}>Client: {p.client.name}</option>)}
                  </select>
                </>
              )}
              <details data-legend className="group sm:relative">
                <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-muted transition-colors duration-200 hover:bg-hover hover:text-ink group-open:bg-hover group-open:text-ink">
                  <Layers size={13} aria-hidden /> Legend
                </summary>
                <div className="absolute z-20 mt-2 w-72 rounded-lg border border-line bg-card p-3 max-sm:inset-x-2.5 max-sm:w-auto sm:right-0">
                  <Legend />
                </div>
              </details>
            </div>
          </div>

          <div className="relative h-[56vh] max-h-[640px] min-h-[380px] lg:h-auto lg:max-h-none lg:min-h-0 lg:flex-1">
            <div className="absolute inset-0">
              {view === "globe" ? (
                <GlobeView journey={journey} places={places} stepMs={stepMs} autoRotate={autoRotate} focus={focus} apiRef={globeApi} fallback={graph} />
              ) : graph}
            </div>
            {busy && played.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <LoaderCircle size={22} className="animate-spin text-accent" aria-hidden />
              </div>
            )}
          </div>

          {/* A fixed height on large screens stops the globe resizing as messages change length */}
          <div className="border-t border-line bg-surface px-3.5 py-2.5 lg:h-[104px] lg:shrink-0 lg:overflow-y-auto">
            <StagePanel journey={journey} run={run} />
          </div>
        </section>

        <aside className="grid gap-4 md:grid-cols-2 lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          <ResultPanel run={run} result={journey.result} className="lg:shrink-0" />
          <StatsPanel stats={dns.stats} className="lg:shrink-0" />
          <EventLog played={played} run={run} className="md:col-span-2 lg:min-h-[180px] lg:flex-1" />
        </aside>
      </div>

      <HistoryTable rows={dns.history} />

      {/* Simulation note: one quiet line, with the full explanation on request */}
      <details className="group rounded-lg bg-surface px-3 py-2 text-xs text-muted">
        <summary className="flex cursor-pointer list-none items-center gap-2">
          <SimBadge />
          <span className="min-w-0 flex-1">Answers are simulated. No DNS packets leave the server.</span>
          <ChevronDown size={14} className="shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
        </summary>
        <p className="mt-2 max-w-3xl leading-relaxed">
          Answers come from an in-memory zone hierarchy that uses reserved documentation addresses (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32, then 198.18.0.0/15 once those run out). Domains listed in data/sim-domains.csv (about 1000 popular sites) answer with a snapshot of their real public IPs; any other domain gets its own new address, which is saved there too. No DNS packets leave the server, and latencies are artificial.
        </p>
      </details>
    </div>
  );
}
