"use client";
import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { X } from "lucide-react";
import { AdditiveBlending, BufferAttribute, Quaternion, Vector3, type BufferGeometry, type Mesh, type Group, type CubicBezierCurve3 } from "three";
import type { NodeId } from "@/shared/dns";
import type { Place } from "@/lib/dns/geo";
import { CYAN, EDGES, KIND_COLOR, KIND_DASH, NODES, STATE_STYLE, type Journey, type Kind } from "@/lib/dns/visuals";
import { arcCurve, latLonToVec3, R } from "./math";

const Z = new Vector3(0, 0, 1);
const NODE_LABEL = Object.fromEntries(NODES.map((n) => [n.id, n.label])) as Record<NodeId, string>;
const TRAIL = 18;
// resolver sits between client and servers, so its side of the hierarchy reads left to right
const LABEL_SIDE: Record<NodeId, "left" | "right"> = { client: "left", resolver: "left", cache: "left", root: "right", tld: "right", auth: "right" };
const LABEL_GAP = 16; // marker to label
const LABEL_PAD = 6; // between labels, and to the canvas edge

/* -------------------------------- Markers -------------------------------- */

export interface MarkerModel {
  id: NodeId;
  place: Place;
  color: string;
  active: boolean;
  stateLabel: string;
  failed: boolean;
  detail?: string;
}

/** Which locations are drawn and how; shared by the 3D markers and the DOM label overlay. */
export function markersFor(journey: Journey, places: Record<NodeId, Place>): MarkerModel[] {
  const cur = journey.current;
  const activeNodes = new Set<NodeId>(cur ? [cur.node, ...(cur.from ? [cur.from] : [])] : []);
  return NODES.filter((n) => n.id !== "cache" && (n.id === "client" || n.id === "resolver" || journey.states[n.id] !== "idle")).map((n) => {
    const st = STATE_STYLE[journey.states[n.id]];
    const isServer = n.id === "root" || n.id === "tld" || n.id === "auth";
    const server = isServer && cur && (cur.node === n.id || cur.from === n.id) ? cur.data?.server : undefined;
    return {
      id: n.id,
      place: places[n.id],
      color: n.id === "client" && journey.states.client === "idle" ? CYAN : st.color,
      active: activeNodes.has(n.id),
      stateLabel: st.label,
      failed: journey.states[n.id] === "failed",
      detail: server?.name,
    };
  });
}

type LabelSlot = { el?: HTMLDivElement | null; line?: SVGLineElement | null };
export type LabelRefs = { current: Map<NodeId, LabelSlot> };

/** Plain DOM labels (outside the Canvas) with leader lines to their markers, positioned every frame by LabelProjector. */
export function GlobeLabels({ markers, refs }: { markers: MarkerModel[]; refs: LabelRefs }) {
  const slot = (id: NodeId) => {
    const s = refs.current.get(id) ?? {};
    refs.current.set(id, s);
    return s;
  };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <svg className="absolute inset-0 h-full w-full">
        {markers.map((m) => (
          <line key={m.id} ref={(l) => void (slot(m.id).line = l)} stroke={m.color} strokeOpacity={m.active ? 0.7 : 0.35} strokeWidth={1} opacity={0} />
        ))}
      </svg>
      {markers.map((m) => (
        <div
          key={m.id}
          ref={(el) => void (slot(m.id).el = el)}
          className="absolute left-0 top-0 whitespace-nowrap rounded-md border bg-canvas/70 px-2 py-1 text-[11px] leading-tight text-ink opacity-0 backdrop-blur-sm will-change-transform"
          style={{ borderColor: m.failed || m.active ? m.color : `${m.color}44` }}
        >
          <div className="font-medium">{NODE_LABEL[m.id]}</div>
          <div className="flex items-center gap-1 text-[10px]" style={{ color: m.color }}>
            {m.failed && <X size={10} strokeWidth={3} />}
            {m.stateLabel}
          </div>
          {m.active && m.detail && <div className="max-w-52 truncate font-mono text-[10px] text-muted">{m.detail}</div>}
          {m.active && <div className="text-[10px] text-muted max-sm:hidden">{m.place.name}, illustrative location</div>}
        </div>
      ))}
    </div>
  );
}

interface LabelBox {
  el: HTMLDivElement;
  line: SVGLineElement;
  mx: number; // marker, in canvas pixels
  my: number;
  x: number;
  y: number;
  w: number;
  h: number;
  left: boolean;
  opacity: number;
}

const overlapX = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w + LABEL_PAD && b.x < a.x + a.w + LABEL_PAD;

/** Stacks labels that would collide, then pulls the stack back inside the canvas. */
function separate(boxes: LabelBox[], height: number) {
  boxes.sort((a, b) => a.y - b.y);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < boxes.length; j++) {
      for (let i = 0; i < j; i++) {
        if (overlapX(boxes[i], boxes[j])) boxes[j].y = Math.max(boxes[j].y, boxes[i].y + boxes[i].h + LABEL_PAD);
      }
    }
  }
  for (let j = boxes.length - 1; j >= 0; j--) {
    let bottom = height - LABEL_PAD;
    for (let k = j + 1; k < boxes.length; k++) if (overlapX(boxes[j], boxes[k])) bottom = Math.min(bottom, boxes[k].y - LABEL_PAD);
    boxes[j].y = Math.max(LABEL_PAD, Math.min(boxes[j].y, bottom - boxes[j].h));
  }
}

function LabelProjector({ places, refs }: { places: Record<NodeId, Place>; refs: LabelRefs }) {
  const v = useMemo(() => new Vector3(), []);
  const camDir = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    camDir.copy(camera.position).normalize();
    const boxes: LabelBox[] = [];
    refs.current.forEach(({ el, line }, id) => {
      if (!el || !line) return;
      const p = places[id];
      const pos = latLonToVec3(p.lat, p.lon, R * 1.003);
      const facing = pos.clone().normalize().dot(camDir);
      if (facing <= 0) {
        el.style.opacity = "0";
        line.setAttribute("opacity", "0");
        return;
      }
      v.copy(pos).project(camera);
      const mx = ((v.x + 1) / 2) * size.width;
      const my = ((1 - v.y) / 2) * size.height;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = LABEL_SIDE[id] === "left";
      const x = Math.max(LABEL_PAD, Math.min(left ? mx - LABEL_GAP - w : mx + LABEL_GAP, size.width - w - LABEL_PAD));
      boxes.push({ el, line, mx, my, x, y: my - h / 2, w, h, left, opacity: Math.min(1, facing * 5) });
    });
    separate(boxes, size.height);
    for (const b of boxes) {
      const opacity = b.opacity.toFixed(2);
      b.el.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`;
      b.el.style.opacity = opacity;
      b.line.setAttribute("x1", b.mx.toFixed(1));
      b.line.setAttribute("y1", b.my.toFixed(1));
      b.line.setAttribute("x2", (b.left ? b.x + b.w : b.x).toFixed(1));
      b.line.setAttribute("y2", (b.y + b.h / 2).toFixed(1));
      b.line.setAttribute("opacity", opacity);
    }
  });
  return null;
}
function Marker({ place, color, active }: MarkerModel) {
  const pos = useMemo(() => latLonToVec3(place.lat, place.lon, R * 1.003), [place]);
  const quat = useMemo(() => new Quaternion().setFromUnitVectors(Z, pos.clone().normalize()), [pos]);
  const pulse = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!pulse.current) return;
    const t = (clock.elapsedTime * (active ? 1.4 : 0.6)) % 1;
    pulse.current.scale.setScalar(1 + t * (active ? 3 : 1.5));
    (pulse.current.material as { opacity: number }).opacity = (1 - t) * (active ? 0.9 : 0.35);
  });
  return (
    <group>
      <mesh position={pos}>
        <sphereGeometry args={[active ? 0.02 : 0.014, 16, 16]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh ref={pulse} position={pos} quaternion={quat}>
        <ringGeometry args={[0.014, 0.019, 32]} />
        <meshBasicMaterial color={color} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function CacheRing({ place, color, active }: { place: Place; color: string; active: boolean }) {
  const pos = useMemo(() => latLonToVec3(place.lat, place.lon, R * 1.004), [place]);
  const quat = useMemo(() => new Quaternion().setFromUnitVectors(Z, pos.clone().normalize()), [pos]);
  const ref = useRef<Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.z += dt * (active ? 4 : 0.5);
  });
  return (
    <group position={pos} quaternion={quat}>
      <mesh ref={ref}>
        <ringGeometry args={[0.03, 0.036, 6, 1, 0, Math.PI * 1.6]} />
        <meshBasicMaterial color={color} transparent opacity={active ? 1 : 0.6} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------- Particle ------------------------------- */

const Particle = memo(function Particle({ curve, forward, color, durMs }: { curve: CubicBezierCurve3; forward: boolean; color: string; durMs: number }) {
  const head = useRef<Group>(null);
  const trail = useRef<BufferGeometry>(null);
  const progress = useRef(0);
  const positions = useMemo(() => new Float32Array(TRAIL * 3), []);
  const tmp = useMemo(() => new Vector3(), []);

  useFrame((_, dt) => {
    progress.current = Math.min(1, progress.current + (dt * 1000) / durMs);
    const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
    const at = (p: number) => curve.getPoint(forward ? p : 1 - p, tmp);
    const p = ease(progress.current);
    head.current?.position.copy(at(p));
    for (let i = 0; i < TRAIL; i++) {
      const v = at(Math.max(0, p - i * 0.012));
      positions.set([v.x, v.y, v.z], i * 3);
    }
    const attr = trail.current?.getAttribute("position") as BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  });

  return (
    <group>
      <group ref={head}>
        <mesh>
          <sphereGeometry args={[0.014, 16, 16]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.035, 16, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.35} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <points>
        <bufferGeometry ref={trail}>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={color} size={0.022} transparent opacity={0.7} blending={AdditiveBlending} depthWrite={false} sizeAttenuation toneMapped={false} />
      </points>
    </group>
  );
});

/* ---------------------------------- Arcs ---------------------------------- */

function Arc({ curve, kind, active }: { curve: CubicBezierCurve3; kind: Kind; active: boolean }) {
  const points = useMemo(() => curve.getPoints(80), [curve]);
  const ref = useRef<{ material: { dashOffset: number } }>(null);
  useFrame((_, dt) => {
    if (active && ref.current) ref.current.material.dashOffset -= dt * 0.6;
  });
  return (
    <Line
      ref={ref as never}
      points={points}
      color={KIND_COLOR[kind]}
      lineWidth={active ? 2.6 : 1.8}
      transparent
      opacity={active ? 1 : 0.7}
      dashed={active || !!KIND_DASH[kind]} // visited arcs keep their kind's pattern, as on the graph
      dashSize={active ? 0.05 : 0.03}
      gapSize={0.025}
      toneMapped={false}
    />
  );
}

/* -------------------------------- Network -------------------------------- */

export const Network = memo(function Network({ places, journey, stepMs, markers, labelRefs }: { places: Record<NodeId, Place>; journey: Journey; stepMs: number; markers: MarkerModel[]; labelRefs: LabelRefs }) {
  const curves = useMemo(() => {
    const v = (id: NodeId) => latLonToVec3(places[id].lat, places[id].lon, R * 1.003);
    return Object.fromEntries(EDGES.filter((e) => e.id !== "resolver-cache").map((e) => [e.id, arcCurve(v(e.source), v(e.target))]));
  }, [places]);

  const cur = journey.current;
  const active = journey.active && curves[journey.active.id] ? journey.active : null;
  const cacheActive = !!cur && (cur.node === "cache" || cur.from === "cache");

  return (
    <group>
      {markers.map((m) => <Marker key={m.id} {...m} />)}
      <CacheRing place={places.cache} color={STATE_STYLE[journey.states.cache].color} active={cacheActive} />
      {EDGES.map((e) => {
        const curve = curves[e.id];
        const kind = active?.id === e.id ? active.kind : journey.visited.get(e.id);
        return curve && kind ? <Arc key={e.id} curve={curve} kind={kind} active={active?.id === e.id} /> : null;
      })}
      {active && cur && (
        <Particle key={cur.seq} curve={curves[active.id]} forward={active.forward} color={KIND_COLOR[active.kind]} durMs={Math.max(300, stepMs * 0.85)} />
      )}
      <LabelProjector places={places} refs={labelRefs} />
    </group>
  );
});