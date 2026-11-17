import { CubicBezierCurve3, Vector3 } from "three";

export const R = 1;

export function latLonToVec3(lat: number, lon: number, r = R) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

function slerp(a: Vector3, b: Vector3, t: number) {
  const theta = a.angleTo(b);
  if (theta < 1e-4) return a.clone().lerp(b, t);
  const s = Math.sin(theta);
  return a.clone().multiplyScalar(Math.sin((1 - t) * theta) / s).add(b.clone().multiplyScalar(Math.sin(t * theta) / s));
}

/** Great-circle-following arc lifted above the surface; height grows with distance. */
export function arcCurve(a: Vector3, b: Vector3) {
  const h = 0.06 + a.distanceTo(b) * 0.32;
  const c1 = slerp(a, b, 0.25).normalize().multiplyScalar(R + h);
  const c2 = slerp(a, b, 0.75).normalize().multiplyScalar(R + h);
  return new CubicBezierCurve3(a, c1, c2, b);
}
