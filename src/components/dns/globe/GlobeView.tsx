"use client";
import dynamic from "next/dynamic";
import { useState, useSyncExternalStore, type Ref } from "react";
import type { NodeId } from "@/shared/dns";
import type { Place } from "@/lib/dns/geo";
import type { Journey } from "@/lib/dns/visuals";
import type { GlobeApi } from "./GlobeScene";

const GlobeScene = dynamic(() => import("./GlobeScene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Loading 3D globe…</div>,
});

let webglCache: boolean | null = null;
function hasWebGL() {
  if (webglCache === null) {
    try {
      const c = document.createElement("canvas");
      webglCache = !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch {
      webglCache = false;
    }
  }
  return webglCache;
}
const noop = () => () => {};

interface Props {
  journey: Journey;
  places: Record<NodeId, Place>;
  stepMs: number;
  autoRotate: boolean;
  focus: Place;
  apiRef: Ref<GlobeApi>;
  fallback: React.ReactNode;
}

export default function GlobeView({ fallback, ...props }: Props) {
  const supported = useSyncExternalStore(noop, hasWebGL, () => null);
  const [lost, setLost] = useState(false);
  if (supported === null) return null;
  if (!supported || lost) {
    return (
      <div className="flex h-full flex-col">
        <p role="status" className="m-3 rounded-lg bg-surface px-3 py-2 text-xs text-muted">
          {lost ? "The WebGL context was lost." : "WebGL is not available in this browser."} Showing the 2D resolution graph instead.
        </p>
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }
  return <GlobeScene {...props} onContextLost={() => setLost(true)} />;
}
