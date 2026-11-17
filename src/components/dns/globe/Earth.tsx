"use client";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { AdditiveBlending, BackSide, NoColorSpace, Vector3, type Mesh } from "three";
import { R } from "./math";

export const SUN_DIR = new Vector3(1, 0.35, 0.8).normalize();

const earthVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const earthFrag = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specMap;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  vec3 vivid(vec3 c, float amount) {
    float grey = dot(c, vec3(0.299, 0.587, 0.114));
    return clamp(mix(vec3(grey), c, amount), 0.0, 1.0);
  }
  void main() {
    vec3 n = normalize(vNormalW);
    float d = dot(n, sunDir);
    float dayMix = smoothstep(-0.18, 0.28, d);
    float water = texture2D(specMap, vUv).r;
    // richer land, and oceans pushed toward deep blue
    vec3 albedo = vivid(texture2D(dayMap, vUv).rgb, 1.55);
    albedo = mix(albedo, albedo * vec3(0.5, 0.95, 1.5), water);
    vec3 day = albedo * (0.12 + 1.05 * max(d, 0.0));
    vec3 lights = texture2D(nightMap, vUv).rgb * vec3(1.0, 0.72, 0.38) * 2.2;
    vec3 night = albedo * 0.06 + lights;
    vec3 col = mix(night, day, dayMix);
    // ocean glint
    vec3 h = normalize(sunDir + vViewDir);
    col += vec3(0.7, 0.9, 1.0) * water * pow(max(dot(n, h), 0.0), 70.0) * 0.5 * dayMix;
    // atmospheric rim
    float fres = pow(1.0 - max(dot(n, vViewDir), 0.0), 3.0);
    col += vec3(0.13, 0.6, 1.0) * fres * (0.3 + 0.6 * dayMix);
    gl_FragColor = vec4(col, 1.0);
  }`;

const atmoVert = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const atmoFrag = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float i = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
    gl_FragColor = vec4(0.13, 0.6, 1.0, 1.0) * i;
  }`;

export function Earth() {
  const [day, night, spec, clouds] = useTexture([
    "/textures/earth_atmos_2048.jpg",
    "/textures/earth_lights_2048.png",
    "/textures/earth_specular_2048.jpg",
    "/textures/earth_clouds_1024.png",
  ]);
  const cloudRef = useRef<Mesh>(null);
  const uniforms = useMemo(() => {
    // shader writes sRGB directly, so sample raw texel values
    for (const t of [day, night, spec]) t.colorSpace = NoColorSpace;
    for (const t of [day, night, clouds]) t.anisotropy = 4;
    return { dayMap: { value: day }, nightMap: { value: night }, specMap: { value: spec }, sunDir: { value: SUN_DIR } };
  }, [day, night, spec, clouds]);

  useFrame((_, dt) => {
    if (cloudRef.current) cloudRef.current.rotation.y += dt * 0.006;
  });

  return (
    <group>
      <mesh>
        <sphereGeometry args={[R, 96, 96]} />
        <shaderMaterial vertexShader={earthVert} fragmentShader={earthFrag} uniforms={uniforms} />
      </mesh>
      <mesh ref={cloudRef}>
        <sphereGeometry args={[R * 1.012, 64, 64]} />
        <meshLambertMaterial alphaMap={clouds} transparent opacity={0.35} depthWrite={false} color="#ffffff" />
      </mesh>
      <Atmosphere />
    </group>
  );
}

export function Atmosphere() {
  return (
    <mesh scale={1.16}>
      <sphereGeometry args={[R, 64, 64]} />
      <shaderMaterial vertexShader={atmoVert} fragmentShader={atmoFrag} blending={AdditiveBlending} side={BackSide} transparent depthWrite={false} />
    </mesh>
  );
}

/** Used if textures fail to load: still a readable, lit globe. */
export function PlainEarth() {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[R, 64, 64]} />
        <meshStandardMaterial color="#12306b" emissive="#0a1a3d" roughness={0.8} wireframe={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[R * 1.002, 36, 18]} />
        <meshBasicMaterial color="#22d3ee" wireframe transparent opacity={0.25} />
      </mesh>
      <Atmosphere />
    </group>
  );
}
