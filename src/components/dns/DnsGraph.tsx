"use client";
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  Background, BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, ReactFlow, useReactFlow, useStore,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { NodeId } from "@/shared/dns";
import { CANVAS, EDGES, KIND_COLOR, KIND_DASH, LINE, NODES, STATE_STYLE, type Journey, type Kind, type NodeState } from "@/lib/dns/visuals";
import { NODE_ICON } from "./ui";

type DnsNodeData = { id: NodeId; label: string; desc: string; state: NodeState; active: boolean };
type DnsEdgeData = { kind?: Kind; label?: string; active: boolean; forward: boolean; durMs: number; seq: number };

const DnsNode = memo(function DnsNode({ data }: NodeProps<Node<DnsNodeData>>) {
  const Icon = NODE_ICON[data.id];
  const s = STATE_STYLE[data.state];
  const failed = data.state === "failed";
  return (
    <div
      className={`w-[210px] rounded-lg border bg-card px-3 py-2.5 transition-all duration-300 ${data.active ? "scale-105" : ""}`}
      style={{ borderColor: data.state === "idle" ? LINE : s.color, boxShadow: data.active || failed ? `0 0 0 1px ${s.color}, 0 0 18px ${s.color}55` : undefined }}
      role="group"
      aria-label={`${data.label}: ${s.label}`}
    >
      {[Position.Left, Position.Right, Position.Top, Position.Bottom].map((p) => (
        <Handle key={`t${p}`} id={`t-${p}`} type="target" position={p} className="!opacity-0" />
      ))}
      {[Position.Left, Position.Right, Position.Top, Position.Bottom].map((p) => (
        <Handle key={`s${p}`} id={`s-${p}`} type="source" position={p} className="!opacity-0" />
      ))}
      <div className="flex items-center gap-2">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${failed ? "bg-error text-canvas" : "bg-hover"}`} style={failed ? undefined : { color: s.color }}>
          <Icon size={17} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{data.label}</div>
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: s.color }}>
            {failed ? <X size={11} strokeWidth={3} aria-hidden /> : <span className={`h-1.5 w-1.5 rounded-full ${data.active ? "animate-pulse" : ""}`} style={{ background: s.color }} />}
            {s.label}
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted">{data.desc}</p>
    </div>
  );
});

/** SMIL motion started explicitly: animations inserted after load would otherwise begin at document time 0. */
function Particle({ path, color, durMs, forward }: { path: string; color: string; durMs: number; forward: boolean }) {
  const ref = useRef<SVGAnimateMotionElement>(null);
  useEffect(() => ref.current?.beginElement(), []);
  return (
    <circle r={5} cx={0} cy={0} fill={color}>
      <animateMotion ref={ref} begin="indefinite" dur={`${durMs}ms`} fill="freeze" path={path} keyPoints={forward ? "0;1" : "1;0"} keyTimes="0;1" calcMode="linear" />
    </circle>
  );
}

const DnsEdge = memo(function DnsEdge(p: EdgeProps<Edge<DnsEdgeData>>) {
  const [path, lx, ly] = getBezierPath(p);
  const d = p.data!;
  const color = d.kind ? KIND_COLOR[d.kind] : LINE;
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        style={{ stroke: color, strokeWidth: d.active ? 2 : 1.5, opacity: d.active || !d.kind ? 1 : 0.6, strokeDasharray: d.active ? "6 4" : d.kind && KIND_DASH[d.kind] }}
        className={d.active ? "dns-edge-flow" : undefined}
      />
      {/* keyed by event seq so the particle restarts on every hop */}
      {d.active && <Particle key={d.seq} path={path} color={color} durMs={d.durMs} forward={d.forward} />}
      {d.active && d.label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-md border px-2 py-0.5 text-[11px] font-medium text-ink"
            style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)`, background: CANVAS, borderColor: color }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const FIT = { padding: 0.12 };

/** The fitView prop only fits once, so a resized window or rotated device would otherwise clip the graph. */
function FitOnResize({ compact }: { compact: boolean }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView(FIT)); // after any layout change has reached the store
    return () => cancelAnimationFrame(frame);
  }, [width, height, compact, fitView]);
  return null;
}

const PHONE = "(max-width: 639px)";
const onPhoneChange = (cb: () => void) => {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

const nodeTypes = { dns: DnsNode };
const edgeTypes = { dns: DnsEdge };
const HANDLES: Record<string, [Position, Position]> = {
  "client-resolver": [Position.Right, Position.Left],
  "resolver-cache": [Position.Bottom, Position.Top],
  "resolver-root": [Position.Right, Position.Left],
  "resolver-tld": [Position.Right, Position.Left],
  "resolver-auth": [Position.Right, Position.Left],
};

export default function DnsGraph({ journey, stepMs }: { journey: Journey; stepMs: number }) {
  const compact = useSyncExternalStore(onPhoneChange, () => window.matchMedia(PHONE).matches, () => false);
  const activeNodes = useMemo(() => {
    const a = journey.current;
    return new Set<NodeId>(a ? [a.node, ...(a.from ? [a.from] : [])] : []);
  }, [journey]);

  const nodes = useMemo<Node<DnsNodeData>[]>(
    () =>
      NODES.map((n) => ({
        id: n.id,
        type: "dns",
        position: compact ? n.compactPos : n.pos,
        draggable: false,
        data: { id: n.id, label: n.label, desc: n.desc, state: journey.states[n.id], active: activeNodes.has(n.id) },
      })),
    [journey, activeNodes, compact],
  );

  const { active: hop, visited } = journey;
  const seq = journey.current?.seq ?? -1;
  const edges = useMemo<Edge<DnsEdgeData>[]>(
    () =>
      EDGES.map((e) => {
        const active = hop?.id === e.id;
        // the compact layout stacks client above resolver, so that edge runs vertically
        const [sh, th] = compact && e.id === "client-resolver" ? [Position.Bottom, Position.Top] : HANDLES[e.id];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: `s-${sh}`,
          targetHandle: `t-${th}`,
          type: "dns",
          data: {
            active,
            kind: active ? hop.kind : visited.get(e.id),
            label: active ? hop.label : undefined,
            forward: active ? hop.forward : true,
            durMs: Math.max(250, stepMs * 0.8),
            seq,
          },
        };
      }),
    [hop, visited, seq, stepMs, compact],
  );

  return (
    <div className="h-full w-full" aria-label="DNS resolution graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={FIT}
        nodesConnectable={false}
        elementsSelectable={false}
        attributionPosition="bottom-left"
        colorMode="dark"
        minZoom={0.3}
      >
        <Background color={LINE} gap={24} />
        <FitOnResize compact={compact} />
      </ReactFlow>
    </div>
  );
}
