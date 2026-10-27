import * as THREE from "three";
import { ADVANCE_SYMBOL, paintCounter, type MapSymbol } from "./mapSymbols";

const STEPS = 42;

export interface CampaignDatum {
  id: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: string;
  focused: boolean;
  phase: number;
  token: MapSymbol;
  lofted: boolean;
  side: number;
  short: boolean;
  bare: boolean;
}

export interface CampaignArrow extends THREE.Group {
  setShown: (progress: number) => void;
  disposeArrow: () => void;
}

interface Ribbon {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  mesh: THREE.Mesh;
}

function offsetSideways(points: THREE.Vector3[], amount: number): THREE.Vector3[] {
  if (!amount) return points;
  return points.map((point, i) => {
    const ahead = points[Math.min(points.length - 1, i + 1)];
    const behind = points[Math.max(0, i - 1)];
    const tangent = ahead.clone().sub(behind);
    if (tangent.lengthSq() < 1e-8) return point;
    const normal = point.clone().normalize();
    const side = new THREE.Vector3().crossVectors(normal, tangent.normalize()).normalize();
    const taper = Math.sin((Math.PI * i) / (points.length - 1));
    return point.clone().addScaledVector(side, amount * (0.35 + 0.65 * taper));
  });
}

function slerpPoints(from: THREE.Vector3, to: THREE.Vector3, lift: number): THREE.Vector3[] {
  const start = from.clone().normalize();
  const end = to.clone().normalize();
  const radius = (from.length() + to.length()) / 2;
  const angle = start.angleTo(end);
  const sin = Math.sin(angle);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    let dir: THREE.Vector3;
    if (angle < 1e-3) {
      dir = start.clone();
    } else if (sin < 1e-3) {
      const axis = Math.abs(start.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(start, axis).normalize();
      dir = start.clone().multiplyScalar(Math.cos(Math.PI * t)).addScaledVector(side, Math.sin(Math.PI * t));
    } else {
      dir = start
        .clone()
        .multiplyScalar(Math.sin((1 - t) * angle) / sin)
        .addScaledVector(end, Math.sin(t * angle) / sin);
    }
    const bulge = Math.sin(Math.PI * t) * lift;
    points.push(dir.normalize().multiplyScalar(radius + bulge));
  }
  return points;
}

function makeRibbon(color: THREE.Color, opacity: number, order: number): Ribbon {
  const positions = new Float32Array(STEPS * 6 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })
  );
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  return { geometry, positions, mesh };
}

function writeRibbon(
  ribbon: Ribbon,
  points: THREE.Vector3[],
  visible: number,
  widthAt: (index: number, last: number) => number,
  hover: number
) {
  const last = visible;
  let count = 0;
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  const nextLeft = new THREE.Vector3();
  const nextRight = new THREE.Vector3();
  const edge = (index: number, targetL: THREE.Vector3, targetR: THREE.Vector3) => {
    const point = points[index];
    const ahead = points[Math.min(points.length - 1, index + 1)];
    const behind = points[Math.max(0, index - 1)];
    const tangent = ahead.clone().sub(behind);
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 1, 0);
    tangent.normalize();
    const normal = point.clone().normalize();
    const side = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const width = widthAt(index, last);
    targetL.copy(point).addScaledVector(side, width).addScaledVector(normal, hover);
    targetR.copy(point).addScaledVector(side, -width).addScaledVector(normal, hover);
  };

  for (let i = 0; i < last; i++) {
    edge(i, left, right);
    edge(i + 1, nextLeft, nextRight);
    const quad = [left, right, nextLeft, right, nextRight, nextLeft];
    for (const vertex of quad) {
      ribbon.positions[count * 3] = vertex.x;
      ribbon.positions[count * 3 + 1] = vertex.y;
      ribbon.positions[count * 3 + 2] = vertex.z;
      count++;
    }
  }
  ribbon.geometry.setDrawRange(0, count);
  ribbon.geometry.attributes.position.needsUpdate = true;
}

function widthAt(index: number, last: number, shaft: number, head: number) {
  const headSpan = Math.min(6, Math.max(2, Math.floor(last * 0.24)));
  const base = last - headSpan;
  if (index < base) return shaft;
  const t = (index - base) / Math.max(1, last - base);
  if (t < 0.34) return shaft + (head - shaft) * (t / 0.34);
  return head * (1 - (t - 0.34) / 0.66);
}

/** A flat campaign arrow: dark edge, colored body, unit counter on the head. */
export function createCampaignArrow(options: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  /** Focused arrows are heavier, the way a main offensive reads on a campaign map. */
  bold?: boolean;
  token?: MapSymbol;
  /** High ballistic arc instead of a ground arrow. */
  lofted?: boolean;
  /** Sideways bulge, in multiples of the shaft width, so two-way traffic splits into lanes. */
  side?: number;
  /** Small, thick cordon arrow. */
  short?: boolean;
  /** Draw without the counter. */
  bare?: boolean;
}): CampaignArrow {
  const { from, to, color } = options;
  const radius = (from.length() + to.length()) / 2;
  const angle = from.clone().normalize().angleTo(to.clone().normalize());
  const arc = Math.max(angle, 0.015) * radius;
  const weight = (options.bold ? 1.18 : 1) * (options.lofted ? 0.6 : 1) * (options.short ? 1.4 : 1);
  const shaftWidth = Math.min(radius * 0.011, Math.max(radius * 0.002, arc * 0.022)) * weight;
  const headWidth = Math.min(radius * 0.026, shaftWidth * 2.2);
  const lift = options.lofted
    ? radius * Math.min(0.32, 0.06 + angle * 0.35)
    : radius * (options.bold ? 0.014 : 0.009);
  const tokenScale = radius * (options.bold ? 0.04 : 0.03);
  const points = offsetSideways(slerpPoints(from, to, lift), (options.side ?? 0) * shaftWidth * 2.2);
  const group = new THREE.Group() as CampaignArrow;
  const outline = makeRibbon(new THREE.Color("#070b14"), 0.92, 2);
  const fill = makeRibbon(new THREE.Color(color), 0.96, 3);
  group.add(outline.mesh, fill.mesh);

  const canvas = paintCounter(options.token ?? ADVANCE_SYMBOL, color);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const token = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false })
  );
  token.renderOrder = 4;
  token.visible = false;
  group.add(token);

  group.setShown = (progress: number) => {
    const shown = Math.min(1, Math.max(0, progress));
    const visible = Math.max(1, Math.round(shown * (points.length - 1)));
    writeRibbon(outline, points, visible, (index, last) => widthAt(index, last, shaftWidth, headWidth) * 1.38, lift * 0.35);
    writeRibbon(fill, points, visible, (index, last) => widthAt(index, last, shaftWidth, headWidth), lift * 0.65);
    const tokenAt = points[Math.max(0, Math.round(visible * 0.78))];
    const normal = tokenAt.clone().normalize();
    token.position.copy(tokenAt).addScaledVector(normal, tokenScale * 0.35);
    token.scale.setScalar(tokenScale);
    token.visible = !options.bare && shown > 0.16;
  };

  group.disposeArrow = () => {
    outline.geometry.dispose();
    fill.geometry.dispose();
    (outline.mesh.material as THREE.Material).dispose();
    (fill.mesh.material as THREE.Material).dispose();
    texture.dispose();
    token.material.dispose();
  };

  group.setShown(0);
  return group;
}

/** three-globe places custom objects in a radius-100 sphere. Longitude 0 faces +X. */
export function globePolar(lat: number, lng: number, relAltitude = 0): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const radius = 100 * (1 + relAltitude);
  const sinPhi = Math.sin(phi);
  return new THREE.Vector3(
    radius * sinPhi * Math.cos(theta),
    radius * Math.cos(phi),
    radius * sinPhi * Math.sin(theta)
  );
}

/** Shell the globe keeps. The arrow inside redraws itself on a loop. */
export function mountCampaignArrow(datum: CampaignDatum): THREE.Group {
  const shell = new THREE.Group();
  const tick = () => {
    if (!shell.parent) {
      // Not mounted yet: keep waiting. Once it has been on the globe, removal ends the loop.
      if (shell.userData.attached) return;
      shell.userData.raf = requestAnimationFrame(tick);
      return;
    }
    shell.userData.attached = true;
    const arrow = shell.userData.arrow as CampaignArrow | undefined;
    if (arrow) {
      const phase = (shell.userData.phase as number) ?? 0;
      const started = (shell.userData.started as number) ?? performance.now();
      const period = shell.userData.short ? 1400 : shell.userData.lofted ? 1700 : 2100;
      arrow.setShown(arrowGrowth((performance.now() - started) / period, phase));
    }
    shell.userData.raf = requestAnimationFrame(tick);
  };
  applyCampaignArrow(shell, datum);
  shell.userData.raf = requestAnimationFrame(tick);
  return shell;
}

/**
 * Draw progress for one loop: hidden while its delay runs, then the arrow
 * grows out and holds before the next loop. Cycles counts loops since start.
 */
export function arrowGrowth(cycles: number, delay: number): number {
  const local = (((cycles - delay) % 1) + 1) % 1;
  if (cycles < delay) return 0;
  return local < 0.68 ? 1 - (1 - local / 0.68) ** 2 : 1;
}

export function applyCampaignArrow(shell: THREE.Group, datum: CampaignDatum) {
  shell.userData.phase = datum.phase;
  shell.userData.lofted = datum.lofted;
  shell.userData.short = datum.short;
  const key = `${datum.id}|${datum.focused}|${datum.color}|${datum.token}`;
  if (shell.userData.key === key) return;
  (shell.userData.arrow as CampaignArrow | undefined)?.disposeArrow();
  shell.clear();
  const arrow = createCampaignArrow({
    from: globePolar(datum.startLat, datum.startLng, 0.012),
    to: globePolar(datum.endLat, datum.endLng, 0.012),
    color: datum.color,
    bold: datum.focused,
    token: datum.token,
    lofted: datum.lofted,
    side: datum.side,
    short: datum.short,
    bare: datum.bare,
  });
  shell.add(arrow);
  shell.userData.arrow = arrow;
  shell.userData.key = key;
  shell.userData.started = performance.now();
}
