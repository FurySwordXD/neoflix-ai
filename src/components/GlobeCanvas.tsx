"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export interface GlobeTargets {
  /** Horizontal offset in world units; positive moves the planet right. */
  x: number;
  /** Vertical offset in world units; positive moves the planet up. */
  y: number;
  /** 0 = fully lit, 1 = heavily dimmed. */
  dim: number;
}

/** A soft round speck for the starfield (drawn, not a CSS ornament). */
function makeStarTexture(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The Earth at night as the room's one light source: a real equirectangular
 * city-lights photograph (NASA, 1994-95) wrapped on a sphere. It idles slowly,
 * spins when dragged, tilts gently toward the pointer, and travels between
 * choreographed targets so the page can stage it per section.
 */
export default function GlobeCanvas({ targets }: { targets: React.RefObject<GlobeTargets> }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
    camera.position.z = 8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const texture = new THREE.TextureLoader().load(
      "/onboarding/earth-night-lights-lg.jpg"

    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(2.55, 96, 64),
      new THREE.MeshBasicMaterial({ map: texture })
    );
    scene.add(globe);

    // A sparse, quiet starfield behind the planet.
    const starTexture = makeStarTexture();
    const starCount = 260;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 46;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 26;
      starPositions[i * 3 + 2] = -6 - Math.random() * 28;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        map: starTexture,
        color: 0xaebfe0,
        size: 0.55,
        transparent: true,
        opacity: 0.55,
        sizeAttenuation: true,
        depthWrite: false,
      })
    );
    scene.add(stars);

    // Interaction state.
    let rotation = Math.PI * 1.52; // opens facing the Atlantic and Europe's lights
    let spinVel = reduced ? 0 : 0.0016;
    let dragging = false;
    let lastX = 0;
    let tiltTarget = 0.14;
    let tilt = 0.14;
    const cur: GlobeTargets = { x: targets.current?.x ?? 0, y: targets.current?.y ?? 0, dim: targets.current?.dim ?? 0 };

    // The page's content floats above the canvas, so the drag is heard from
    // the whole window — except over real controls, which keep their events.
    const INTERACTIVE = "button, a, input, textarea, select, [role='button']";
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(INTERACTIVE)) return;
      dragging = true;
      lastX = e.clientX;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        rotation += dx * 0.005;
        spinVel = Math.max(-0.05, Math.min(0.05, dx * 0.003));
      } else if (e.pointerType !== "touch") {
        tiltTarget = 0.14 + (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 0.16;
      }
    };
    const endDrag = () => {
      dragging = false;
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    let raf = 0;
    let running = true;
    const frame = () => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const t = targets.current ?? cur;
      const k = reduced ? 1 : 0.06;
      cur.x += (t.x - cur.x) * k;
      cur.y += (t.y - cur.y) * k;
      cur.dim += (t.dim - cur.dim) * k;
      globe.position.x = cur.x;
      globe.position.y = cur.y;
      (globe.material as THREE.MeshBasicMaterial).color.setScalar(1 - 0.7 * cur.dim);

      if (!dragging) {
        rotation += spinVel;
        if (reduced) spinVel = 0;
        else spinVel += (0.0016 - spinVel) * 0.02; // ease back to the idle drift
      }
      globe.rotation.y = rotation;
      tilt += (tiltTarget - tilt) * 0.08;
      globe.rotation.x = tilt;
      if (!reduced) stars.rotation.y += 0.00012;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = Math.max(0.1, w / Math.max(1, h));
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      texture.dispose();
      starTexture.dispose();
      globe.geometry.dispose();
      (globe.material as THREE.Material).dispose();
      starGeometry.dispose();
      (stars.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [targets]);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className="fixed inset-0 z-0"
      style={{ touchAction: "pan-y" }}
    />
  );
}
