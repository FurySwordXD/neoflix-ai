import { createRoot, extend, flushSync, useLoader, useThree, type Catalogue } from "@react-three/fiber";
import { Suspense, useInsertionEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Internals, staticFile, useCurrentFrame, useDelayRender, useRemotionEnvironment, useVideoConfig } from "remotion";
import * as THREE from "three";
import { arrowGrowth, createCampaignArrow } from "../src/lib/campaignArrow";
import { motionLegs, type MotionLeg } from "../src/lib/mapMotion";
import { actorSymbol, paintCounter, symbolFor, type MapSymbol } from "../src/lib/mapSymbols";
import type { MapPlace } from "../src/lib/types";
import { CATEGORY_COLORS } from "../src/lib/ui";
import { latLngToVector, type GlobeAim } from "./geo";
import type { VideoLayout } from "./videoLayout";
import type { VideoEvent } from "./types";

// This file uses the low-level createRoot() API, so fiber's built-in
// extend(THREE) inside <Canvas> never runs — registration here is required.
// The cast only silences the Catalogue check (THREE exports non-constructors
// like REVISION); JSX element typing is derived from typeof THREE statically,
// so it is unaffected.
extend(THREE as unknown as Catalogue);

const STAR_COUNT = 160;

function Starfield() {
  const geometry = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3);
    let seed = 42;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < STAR_COUNT; i++) {
      const radius = 8;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  return (
    <points geometry={geometry}>
      <pointsMaterial color="#dbe7ff" size={0.02} sizeAttenuation depthWrite={false} />
    </points>
  );
}

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          glowColor: { value: new THREE.Color("#38bdf8") },
        },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vWorld;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          varying vec3 vWorld;
          uniform vec3 glowColor;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vWorld);
            float fresnel = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 2.6);
            gl_FragColor = vec4(glowColor, fresnel * 0.9);
          }
        `,
      }),
    []
  );

  return (
    <mesh scale={1.14} material={material}>
      <sphereGeometry args={[1, 64, 64]} />
    </mesh>
  );
}

function Earth() {
  const [colorMap, bumpMap] = useLoader(THREE.TextureLoader, [
    staticFile("globe/earth-night.jpg"),
    staticFile("globe/earth-topology.png"),
  ]);
  const tuned = useRef(false);
  if (!tuned.current) {
    colorMap.colorSpace = THREE.SRGBColorSpace;
    colorMap.anisotropy = 8;
    bumpMap.colorSpace = THREE.NoColorSpace;
    bumpMap.anisotropy = 4;
    tuned.current = true;
  }

  return (
    <mesh>
      <sphereGeometry args={[1, 96, 96]} />
      <meshStandardMaterial
        map={colorMap}
        emissiveMap={colorMap}
        emissive="#d6e4ff"
        emissiveIntensity={0.72}
        bumpMap={bumpMap}
        bumpScale={0.04}
        roughness={0.9}
        metalness={0}
      />
    </mesh>
  );
}

function Marker({
  event,
  active,
  frame,
  scaleBoost = 1,
}: {
  event: VideoEvent;
  active: boolean;
  frame: number;
  scaleBoost?: number;
}) {
  const color = CATEGORY_COLORS[event.category];
  const symbol = symbolFor(event.category, event.motion);
  const position = useMemo(
    () => latLngToVector(event.location.lat, event.location.lng, 1.03),
    [event.location.lat, event.location.lng]
  );
  const texture = useMemo(() => {
    const map = new THREE.CanvasTexture(paintCounter(symbol, color));
    map.colorSpace = THREE.SRGBColorSpace;
    return map;
  }, [symbol, color]);
  const battle = active && event.motion?.kind === "impact";
  const pop = battle ? Math.min(1, frame / 8) : 1;
  const beat = active ? 1 + Math.sin(frame * (battle ? 0.45 : 0.2)) * (battle ? 0.08 : 0.04) : 1;
  const scale = (active ? 0.078 : 0.042) * pop * beat * scaleBoost;

  return (
    <sprite position={position} scale={scale} renderOrder={4}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

/**
 * Great-circle hop. Every sample is a point on the sphere, then pushed outward,
 * so the line cannot chord through the earth the way a bezier between the endpoints does.
 */
class GlobeArcCurve extends THREE.Curve<THREE.Vector3> {
  private readonly start: THREE.Vector3;
  private readonly end: THREE.Vector3;
  private readonly angle: number;
  private readonly peak: number;

  constructor(start: THREE.Vector3, end: THREE.Vector3) {
    super();
    this.start = start.clone().normalize();
    this.end = end.clone().normalize();
    this.angle = this.start.angleTo(this.end);
    // A few percent of altitude. Higher than this, the apex clears the limb and
    // the line appears to leave the globe and get cut off in space.
    this.peak = 0.006 + (this.angle / Math.PI) * 0.014;
  }

  getPoint(t: number, target = new THREE.Vector3()) {
    const { start, end, angle } = this;
    const ground = 1.016;
    if (angle < 1e-3) return target.copy(start).multiplyScalar(ground);
    const sin = Math.sin(angle);
    // Antipodal pairs make the slerp weight explode; bend via an equator instead.
    if (sin < 1e-3) {
      const axis = Math.abs(start.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(start, axis).normalize();
      const dir = start.clone().multiplyScalar(Math.cos(Math.PI * t)).addScaledVector(side, Math.sin(Math.PI * t));
      return target.copy(dir).multiplyScalar(ground + this.peak);
    }
    const dir = start
      .clone()
      .multiplyScalar(Math.sin((1 - t) * angle) / sin)
      .addScaledVector(end, Math.sin(t * angle) / sin);
    const radius = ground + Math.sin(Math.PI * t) * this.peak;
    return target.copy(dir).multiplyScalar(radius);
  }
}

function Arc({ from, to, color, opacity }: { from: VideoEvent; to: VideoEvent; color: string; opacity: number }) {
  const geometry = useMemo(() => {
    const start = latLngToVector(from.location.lat, from.location.lng, 1);
    const end = latLngToVector(to.location.lat, to.location.lng, 1);
    if (start.angleTo(end) < 0.04) return null;
    const curve = new GlobeArcCurve(start, end);
    return new THREE.TubeGeometry(curve, 80, 0.005, 8, false);
  }, [from, to]);

  if (!geometry) return null;
  return (
    <mesh geometry={geometry} renderOrder={2}>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-4}
      />
    </mesh>
  );
}

function placeOf(event: VideoEvent): MapPlace {
  return { name: event.location.name, lat: event.location.lat, lng: event.location.lng };
}

/** Expanding ring in the tangent plane. Radius is set during render so the frame is ready to capture. */
function ShockRings({
  lat,
  lng,
  maxDeg,
  cycle,
  color,
  frame,
}: {
  lat: number;
  lng: number;
  maxDeg: number;
  cycle: number;
  color: string;
  frame: number;
}) {
  const position = useMemo(() => latLngToVector(lat, lng, 1.025), [lat, lng]);
  const quaternion = useMemo(() => {
    const normal = position.clone().normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  }, [position]);

  return (
    <group position={position} quaternion={quaternion}>
      {[0, 0.5].map((phase) => {
        const t = (frame / cycle + phase) % 1;
        const degrees = 0.45 + t * maxDeg;
        const radius = Math.sin((degrees * Math.PI) / 180);
        return (
          <mesh key={phase} scale={radius} renderOrder={3}>
            <ringGeometry args={[0.78, 1, 64]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={(1 - t) * 0.9}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function CampaignRoute({
  leg,
  color,
  token,
  frame,
}: {
  leg: MotionLeg;
  color: string;
  token: MapSymbol;
  frame: number;
}) {
  const { from, to, lofted, side, short, bare } = leg;
  const arrow = useMemo(
    () =>
      createCampaignArrow({
        from: latLngToVector(from.lat, from.lng, 1.012),
        to: latLngToVector(to.lat, to.lng, 1.012),
        color,
        bold: true,
        token,
        lofted,
        side,
        short,
        bare,
      }),
    [from.lat, from.lng, to.lat, to.lng, color, token, lofted, side, short, bare]
  );
  const period = short ? 42 : lofted ? 50 : 54;
  arrow.setShown(arrowGrowth(frame / period, leg.delay ?? 0));
  return <primitive object={arrow} />;
}

function MapMotion({ event, frame }: { event: VideoEvent; frame: number }) {
  const motion = event.motion;
  if (!motion) return null;
  const origin = placeOf(event);
  const color = CATEGORY_COLORS[event.category];
  if (motion.kind === "spread" || motion.kind === "impact") {
    return (
      <ShockRings
        lat={origin.lat}
        lng={origin.lng}
        maxDeg={motion.kind === "spread" ? motion.radius : 4.5}
        cycle={motion.kind === "spread" ? 56 : 20}
        color={color}
        frame={frame}
      />
    );
  }
  const legs = motionLegs(origin, motion);
  const token = actorSymbol(motion);
  return (
    <group>
      {motion.kind === "encircle" ? (
        <ShockRings
          lat={origin.lat}
          lng={origin.lng}
          maxDeg={motion.radius * 1.05}
          cycle={46}
          color={color}
          frame={frame}
        />
      ) : null}
      {motion.kind === "launch" ? (
        <ShockRings lat={motion.to.lat} lng={motion.to.lng} maxDeg={2.6} cycle={40} color={color} frame={frame} />
      ) : null}
      {legs.map((leg) => (
        <CampaignRoute
          key={`${leg.from.lat},${leg.from.lng}-${leg.to.lat},${leg.to.lng}`}
          leg={leg}
          color={color}
          token={token}
          frame={frame}
        />
      ))}
    </group>
  );
}

interface EarthSceneProps {
  events: VideoEvent[];
  frame: number;
  revealed: number;
  activeIndex: number;
  aim: GlobeAim;
  shift: number;
  illustrateId: string | null;
  motionFrame: number;
  layout: VideoLayout;
}

/**
 * Draws one globe frame, then releases Remotion's delayRender.
 * ThreeCanvas waits for an effect inside react-three-fiber that never runs during
 * client-side rendering, so the frame is advanced here instead.
 */
function ReadyFrame({ onPainted }: { onPainted: () => void }) {
  const advance = useThree((state) => state.advance);
  useLayoutEffect(() => {
    advance(performance.now());
    onPainted();
  });
  return null;
}

function GlobeCanvas({
  width,
  height,
  fov,
  camZ,
  children,
}: {
  width: number;
  height: number;
  fov: number;
  camZ: number;
  children: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<ReturnType<typeof createRoot> | null>(null);
  const childrenRef = useRef(children);
  const contextsRef = useRef(Internals.useRemotionContexts());
  childrenRef.current = children;
  contextsRef.current = Internals.useRemotionContexts();
  const frame = useCurrentFrame();
  const { isRendering } = useRemotionEnvironment();
  const { delayRender, continueRender } = useDelayRender();

  // Release the root in an insertion-effect cleanup: these survive StrictMode
  // effect replay and HMR, unlike useLayoutEffect cleanups which unmount the
  // root, force-loss the WebGL context, and break the immediately-replayed
  // createRoot on the same canvas ("Cannot read properties of null (reading
  // 'precision')" from a context-lost renderer).
  useInsertionEffect(() => {
    return () => {
      const root = rootRef.current;
      rootRef.current = null;
      root?.unmount();
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Reuse the root across effect re-runs (size changes, StrictMode replay):
    // createRoot twice on one canvas triggers the "should only be called once"
    // path, and a fresh renderer on a disposed canvas loses its context.
    let root = rootRef.current;
    if (!root) {
      root = createRoot(canvas);
      rootRef.current = root;
    }
    root
      .configure({
        size: { width, height, top: 0, left: 0 },
        dpr: 1,
        frameloop: "never",
        gl: { antialias: true, alpha: false, preserveDrawingBuffer: true },
        camera: { fov, position: [0, 0.06, camZ], near: 0.1, far: 40 },
        onCreated: ({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.25;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.setClearColor("#050810");
        },
      })
      .catch((err: unknown) => {
        console.error("[EarthScene] Globe canvas configure failed:", err);
      });
  }, [width, height, fov, camZ]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const handle = isRendering ? delayRender(`Globe frame ${frame}`) : null;
    let released = false;
    let cancelled = false;
    const release = () => {
      if (released || handle === null) return;
      released = true;
      continueRender(handle);
    };
    const draw = () => {
      const current = rootRef.current;
      if (cancelled || !current || current.ready.status !== "fulfilled") return;
      flushSync(() => {
        current.render(
          <Internals.RemotionContextProvider contexts={contextsRef.current}>
            <Suspense fallback={null}>
              <ReadyFrame onPainted={release} />
              {childrenRef.current}
            </Suspense>
          </Internals.RemotionContextProvider>
        );
      });
    };
    if (root && root.ready.status === "fulfilled") draw();
    else root?.ready.then(() => draw(), () => { });
    return () => {
      cancelled = true;
      release();
    };
  });

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: "block", width, height, backgroundColor: "#050810" }}
    />
  );
}

export function EarthScene({
  events,
  frame,
  revealed,
  activeIndex,
  aim,
  shift,
  illustrateId,
  motionFrame,
  layout,
}: EarthSceneProps) {
  const { width, height } = useVideoConfig();
  // XYZ matches aimAt(): pitch first, then yaw, lands the target on the camera.
  const rotation = useMemo(
    () => new THREE.Euler(aim.pitch, aim.yaw, 0, "XYZ"),
    [aim.pitch, aim.yaw]
  );
  const visible = events.slice(0, revealed);
  const illustrated = illustrateId ? events.find((event) => event.id === illustrateId) : null;

  // Landscape keeps the classic framing (camera y 0.06, fov 35) but a touch
  // closer than before. Portrait is a close-up: the globe bleeds past the
  // frame edges and the aimed event sits at the center of the strip above
  // the bottom sheet, with the sheet overlapping the globe's lower limb.
  // All offsets are world units — the globe is radius 1, and the visible
  // world height is 2·tan(fov/2)·distance; pixel values here would fling
  // the scene out of the frustum.
  const CAM_Y = 0.06;
  const LAND_FOV = 35;
  const LAND_CAM_Z = 3.2;
  // World height of one full frame measured at the globe's facing surface
  // (distance camZ − 1), the plane markers live on — the reference for
  // keeping marker sizes consistent across orientations.
  const LAND_SURFACE_H = 2 * Math.tan((LAND_FOV * Math.PI) / 360) * (LAND_CAM_Z - 1);
  let camZ = LAND_CAM_Z;
  let fov = LAND_FOV;
  let groupY = -0.05;
  let markerScale = 1;
  if (layout.portrait) {
    // Globe + atmosphere (diameter ≈ 2.3) spanning 150% of the frame width.
    const globeSpan = 3;
    const visibleW = 2.3 / globeSpan;
    const visibleH = (visibleW * height) / width;
    fov = 40;
    camZ = visibleH / (2 * Math.tan((fov * Math.PI) / 360));
    // Center the aimed event point in the strip above the sheet. Projection
    // is measured at the surface plane (camZ − 1), not the center plane, so
    // the point lands where the fraction says despite the perspective.
    const strip = Math.max(0.2, 1 - layout.panelHeight / height);
    const surfaceH = 2 * Math.tan((fov * Math.PI) / 360) * (camZ - 1);
    groupY = CAM_Y + (0.5 - strip / 2) * surfaceH;
    // Match the markers' on-screen size to the landscape framing.
    markerScale = Math.min(1.6, Math.max(1, surfaceH / LAND_SURFACE_H));
  }

  return (
    <GlobeCanvas width={width} height={height} fov={fov} camZ={camZ}>
      <color attach="background" args={["#050810"]} />
      <ambientLight intensity={0.22} />
      <directionalLight position={[1.2, 0.4, 4]} intensity={1.15} color="#f4f8ff" />
      <directionalLight position={[-3.2, -0.6, -2]} intensity={0.28} color="#7dd3fc" />
      <Starfield />
      <group position={[shift * layout.slideScale, groupY, 0]}>
        <group rotation={rotation}>
          <Earth />
          {visible.map((event, index) => (
            <Marker
              key={event.id}
              event={event}
              active={index === activeIndex}
              frame={frame}
              scaleBoost={markerScale}
            />
          ))}
          {visible.slice(1).map((event, index) => {
            const from = visible[index];
            const newest = index + 1 === visible.length - 1;
            return (
              <Arc
                key={`${from.id}-${event.id}`}
                from={from}
                to={event}
                color={CATEGORY_COLORS[event.category]}
                opacity={newest ? 0.95 : 0.38}
              />
            );
          })}
          {illustrated?.motion ? <MapMotion event={illustrated} frame={motionFrame} /> : null}
        </group>
        <Atmosphere />
      </group>
    </GlobeCanvas>
  );
}
