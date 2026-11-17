"use client";
import { Component, Suspense, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { Vector3 } from "three";
import type { NodeId } from "@/shared/dns";
import type { Place } from "@/lib/dns/geo";
import { CANVAS, type Journey } from "@/lib/dns/visuals";
import { Earth, PlainEarth, SUN_DIR } from "./Earth";
import { GlobeLabels, markersFor, Network, type LabelRefs } from "./Network";
import { latLonToVec3 } from "./math";

export interface GlobeApi {
  zoom(dir: 1 | -1): void;
}

interface Props {
  journey: Journey;
  places: Record<NodeId, Place>;
  stepMs: number;
  autoRotate: boolean;
  focus: Place; // camera eases toward this point when it changes
  apiRef: Ref<GlobeApi>;
  onContextLost: () => void;
}

class TextureBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <PlainEarth /> : this.props.children;
  }
}

type Controls = { update(): void; addEventListener(t: "start", f: () => void): void; removeEventListener(t: "start", f: () => void): void };

const MIN_D = 1.45;
const MAX_D = 6;

function CameraRig({ focus, apiRef }: { focus: Place; apiRef: Ref<GlobeApi> }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as Controls | null;
  const target = useRef<Vector3 | null>(null);

  useImperativeHandle(apiRef, () => ({
    zoom(dir) {
      const d = camera.position.length() * (dir > 0 ? 0.82 : 1.22);
      camera.position.setLength(Math.min(MAX_D, Math.max(MIN_D, d)));
      controls?.update();
    },
  }), [camera, controls]);

  useEffect(() => {
    target.current = latLonToVec3(focus.lat + 12, focus.lon, 1).normalize();
  }, [focus]);

  // keep the whole globe in view on portrait screens
  const aspect = useThree((s) => s.size.width / s.size.height);
  useEffect(() => {
    camera.position.setLength(aspect >= 1 ? 2.9 : Math.min(MAX_D, (3.2 / aspect) * 0.85));
  }, [aspect, camera]);

  useEffect(() => {
    if (!controls) return;
    const stop = () => (target.current = null); // user takes over: never fight their drag
    controls.addEventListener("start", stop);
    return () => controls.removeEventListener("start", stop);
  }, [controls]);

  useFrame((_, dt) => {
    if (!target.current) return;
    const len = camera.position.length();
    const dir = camera.position.clone().normalize().lerp(target.current, Math.min(1, dt * 2.5)).normalize();
    camera.position.copy(dir.multiplyScalar(len));
    controls?.update();
    if (dir.normalize().angleTo(target.current) < 0.002) target.current = null;
  });
  return null;
}

export default function GlobeScene({ journey, places, stepMs, autoRotate, focus, apiRef, onContextLost }: Props) {
  const markers = useMemo(() => markersFor(journey, places), [journey, places]);
  const labelRefs = useRef(new Map()) as LabelRefs;
  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [0, 0.8, 3.1], fov: 45, near: 0.05, far: 200 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => gl.domElement.addEventListener("webglcontextlost", onContextLost, { once: true })}
        aria-label="3D globe showing the DNS query journey"
        role="img"
      >
        <color attach="background" args={[CANVAS]} />
        <ambientLight intensity={0.25} />
        <directionalLight position={SUN_DIR.clone().multiplyScalar(5)} intensity={1.6} />
        <Stars radius={60} depth={40} count={2500} factor={3} saturation={0} fade speed={0.4} />
        <TextureBoundary>
          <Suspense fallback={<PlainEarth />}>
            <Earth />
          </Suspense>
        </TextureBoundary>
        <Network places={places} journey={journey} stepMs={stepMs} markers={markers} labelRefs={labelRefs} />
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.08} minDistance={MIN_D} maxDistance={MAX_D} autoRotate={autoRotate} autoRotateSpeed={0.35} rotateSpeed={0.5} zoomSpeed={0.6} />
        <CameraRig focus={focus} apiRef={apiRef} />
      </Canvas>
      <GlobeLabels markers={markers} refs={labelRefs} />
    </div>
  );
}
