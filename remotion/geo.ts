import * as THREE from "three";

/**
 * Equirectangular position on a Three.js sphere.
 * Matches SphereGeometry's default UVs: texture u=0 is longitude -180,
 * and the +Z axis (toward the camera) is longitude -90.
 */
export function latLngToVector(lat: number, lng: number, radius = 1): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  return new THREE.Vector3(
    -radius * Math.cos(theta) * sinPhi,
    radius * Math.cos(phi),
    radius * Math.sin(theta) * sinPhi
  );
}

export interface GlobeAim {
  yaw: number;
  pitch: number;
}

/**
 * Pitch then yaw (Euler order XYZ) that turns this coordinate toward the camera.
 * XYZ, not YXZ: applying pitch before yaw is what lands the marker on +Z.
 */
export function aimAt(lat: number, lng: number): GlobeAim {
  const point = latLngToVector(lat, lng, 1);
  const yaw = -Math.atan2(point.x, point.z);
  const z = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
  const pitch = Math.atan2(point.y, z);
  return { yaw, pitch };
}

export function lerpAngle(from: number, to: number, t: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * t;
}
