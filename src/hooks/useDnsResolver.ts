"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DnsEvent, QueryResult, QueryType, ServerMessage } from "@/shared/dns";
import { deriveJourney, isTerminal } from "@/lib/dns/visuals";

export const STEP_MS = 900; // time each backend event is held on screen at 1x speed
const MAX_HISTORY = 50;

export interface Run {
  id: number;
  domain: string;
  qtype: QueryType;
  events: DnsEvent[];
  streaming: boolean;
  error?: string;
}

export interface HistoryRow {
  runId: number;
  ts: number;
  domain: string;
  qtype: QueryType;
  status: string;
  addresses: string[];
  cached: boolean;
  durationMs: number | null;
}

let runSeq = 0;

export function useDnsResolver() {
  const [run, setRun] = useState<Run | null>(null);
  const [cursor, setCursor] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const recorded = useRef(new Set<number>());

  const record = useCallback((row: HistoryRow) => {
    if (recorded.current.has(row.runId)) return;
    recorded.current.add(row.runId);
    setHistory((h) => [row, ...h].slice(0, MAX_HISTORY));
  }, []);

  const resolve = useCallback(
    async (domain: string, qtype: QueryType) => {
      abortRef.current?.abort(); // cancels the previous stream; backend is told via request abort
      const ac = new AbortController();
      abortRef.current = ac;
      const id = ++runSeq;
      const patch = (fn: (r: Run) => Run) => setRun((r) => (r?.id === id ? fn(r) : r)); // drops stale updates
      const fail = (msg: string) => {
        patch((r) => ({ ...r, error: msg, streaming: false }));
        record({ runId: id, ts: Date.now(), domain, qtype, status: "ERROR", addresses: [], cached: false, durationMs: null });
      };
      setRun({ id, domain, qtype, events: [], streaming: true });
      setCursor(0);

      try {
        const res = await fetch(`/api/resolve?${new URLSearchParams({ domain, type: qtype })}`, { signal: ac.signal, cache: "no-store" });
        if (!res.ok || !res.body) return fail(`Gateway error (HTTP ${res.status})`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const lines = buf.split("\n");
          buf = lines.pop()!;
          const batch: DnsEvent[] = [];
          for (const line of lines) {
            if (!line) continue;
            const m = JSON.parse(line) as ServerMessage;
            if (m.t === "event") batch.push(m.e);
            else if (m.t === "error") fail(m.msg);
          }
          if (batch.length) patch((r) => ({ ...r, events: [...r.events, ...batch].sort((a, b) => a.seq - b.seq) }));
        }
        patch((r) => ({ ...r, streaming: false, error: r.error ?? (r.events.some(isTerminal) ? undefined : "Stream ended before the query completed") }));
      } catch (err) {
        if (ac.signal.aborted) return;
        fail(`Cannot reach the DNS gateway: ${(err as Error).message}`);
      }
    },
    [record],
  );

  // Playback: advance one backend event per step; never overlaps because each run owns the cursor.
  useEffect(() => {
    if (!run || cursor >= run.events.length) return;
    const t = setTimeout(
      () => {
        const e = run.events[cursor];
        setCursor(cursor + 1);
        const r: QueryResult | undefined = e.data?.result;
        if (isTerminal(e) && r) {
          record({ runId: run.id, ts: e.ts, domain: r.domain, qtype: r.qtype, status: r.status, addresses: r.addresses, cached: r.cached, durationMs: r.durationMs });
        }
      },
      cursor === 0 ? 0 : STEP_MS / speed,
    );
    return () => clearTimeout(t);
  }, [run, cursor, speed, record]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const played = useMemo(() => run?.events.slice(0, cursor) ?? [], [run, cursor]);
  const journey = useMemo(() => deriveJourney(played), [played]);
  const finished = !!run && !run.streaming && cursor >= run.events.length;
  const busy = !!run && !finished && !run.error;

  const stats = useMemo(() => {
    const done = history.filter((h) => h.durationMs !== null);
    const ok = history.filter((h) => h.addresses.length > 0).length;
    return {
      total: history.length,
      success: ok,
      failed: history.length - ok,
      cacheHits: history.filter((h) => h.cached).length,
      cacheMisses: done.filter((h) => !h.cached).length,
      avgMs: done.length ? done.reduce((s, h) => s + h.durationMs!, 0) / done.length : null,
    };
  }, [history]);

  const replay = useCallback(() => setCursor(0), []);

  return { run, played, journey, speed, setSpeed, resolve, replay, busy, finished, history, stats };
}

export type DnsResolverApi = ReturnType<typeof useDnsResolver>;
