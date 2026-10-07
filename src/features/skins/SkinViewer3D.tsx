import { useEffect, useRef } from "react";
import * as skinview3d from "skinview3d";
import type { AnimatedCape } from "./vitraCape";

export type ViewAngle = "front" | "back" | "left" | "right";
export type AnimationKind = "idle" | "walk" | "run" | "wave" | "crouch" | "none";

const ANGLES: Record<ViewAngle, number> = { front: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 };

function makeAnimation(kind: AnimationKind) {
  switch (kind) {
    case "idle":
      return new skinview3d.IdleAnimation();
    case "walk":
      return new skinview3d.WalkingAnimation();
    case "run":
      return new skinview3d.RunningAnimation();
    case "wave":
      return new skinview3d.WaveAnimation();
    case "crouch":
      return new skinview3d.CrouchAnimation();
    default:
      return null;
  }
}

/**
 * Interactive 3D player model. Drag to rotate, scroll to zoom. Rendering is
 * paused whenever the window is hidden or the game is running.
 */
export function SkinViewer3D({
  skin,
  model,
  cape,
  elytra,
  animation,
  autoRotate,
  view,
  viewNonce,
  zoom,
  nameTag,
}: {
  skin: string;
  model: "classic" | "slim";
  /** A cape image, or a Vitra cape's frames, which play in a loop. */
  cape: string | AnimatedCape | null;
  elytra: boolean;
  animation: AnimationKind;
  autoRotate: boolean;
  view: ViewAngle;
  viewNonce: number;
  zoom: number;
  nameTag?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<skinview3d.SkinViewer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const viewer = new skinview3d.SkinViewer({
      canvas,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
      pixelRatio: "match-device",
      fov: 40,
      zoom: 0.85,
    });
    viewer.background = null;
    viewer.controls.enablePan = false;
    viewer.controls.enableDamping = true;
    viewer.controls.minDistance = 22;
    viewer.controls.maxDistance = 90;
    viewer.globalLight.intensity = 2.6;
    viewer.cameraLight.intensity = 0.9;
    viewerRef.current = viewer;

    const ro = new ResizeObserver(() => viewer.setSize(wrap.clientWidth, wrap.clientHeight));
    ro.observe(wrap);
    const syncPause = () => {
      viewer.renderPaused = document.hidden || document.documentElement.dataset.idle === "true";
    };
    const mo = new MutationObserver(syncPause);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-idle"] });
    document.addEventListener("visibilitychange", syncPause);
    return () => {
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", syncPause);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewerRef.current?.loadSkin(skin, { model: model === "slim" ? "slim" : "default" });
  }, [skin, model]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const backEquipment = elytra ? "elytra" : "cape";
    if (!cape) return void v.resetCape();
    if (typeof cape === "string") return void v.loadCape(cape, { backEquipment });
    v.loadCape(cape.frames[0], { backEquipment });
    if (cape.frames.length < 2) return;
    // Animated: redraw the cape texture in place rather than making a new one per frame.
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % cape.frames.length;
      const g = v.capeCanvas.getContext("2d")!;
      g.clearRect(0, 0, v.capeCanvas.width, v.capeCanvas.height);
      g.drawImage(cape.frames[i], 0, 0, v.capeCanvas.width, v.capeCanvas.height);
      const map = v.playerObject.cape.map ?? v.playerObject.elytra.map;
      if (map) map.needsUpdate = true;
    }, Math.max(30, cape.delay));
    return () => clearInterval(timer);
  }, [cape, elytra]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const anim = makeAnimation(animation);
    if (anim) anim.speed = animation === "run" ? 0.9 : 0.75;
    v.animation = anim;
  }, [animation]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.autoRotate = autoRotate;
    v.autoRotateSpeed = 1.4;
  }, [autoRotate]);

  useEffect(() => {
    const v = viewerRef.current;
    if (v) v.zoom = zoom;
  }, [zoom]);

  useEffect(() => {
    const v = viewerRef.current;
    if (v) v.nameTag = nameTag ?? null;
  }, [nameTag]);

  // Snap the camera to a preset angle (orbit around the model).
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const dist = v.camera.position.length();
    const a = ANGLES[view];
    v.camera.position.set(Math.sin(a) * dist, 0, Math.cos(a) * dist);
    v.playerObject.rotation.y = 0;
    v.controls.update();
  }, [view, viewNonce]);

  return (
    <div ref={wrapRef} className="skin-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

/** An original placeholder skin, drawn in code (no Mojang assets bundled). */
export function defaultSkin(accent = "#5b7cfa"): string {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const fill = (color: string, x: number, y: number, w: number, h: number) => {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
  const skin = "#d9a77f";
  const hair = "#3a2a22";
  const pants = "#2b3249";
  const shoes = "#17181f";
  const shirtDark = "#2e3d7a";
  // Head (all faces)
  fill(skin, 0, 8, 32, 8);
  fill(hair, 8, 0, 8, 8); // top
  fill(skin, 16, 0, 8, 8); // bottom
  fill(hair, 0, 8, 32, 2); // hairline all around
  fill(hair, 24, 8, 8, 6); // back of head
  fill(hair, 0, 10, 2, 3);
  fill(hair, 22, 10, 2, 3);
  fill("#ffffff", 9, 12, 2, 1);
  fill("#ffffff", 13, 12, 2, 1);
  fill("#3b4a8a", 10, 12, 1, 1);
  fill("#3b4a8a", 13, 12, 1, 1);
  fill("#b07a5a", 11, 14, 2, 1);
  // Body
  fill(accent, 16, 16, 24, 16);
  fill(shirtDark, 20, 16, 8, 4);
  fill(shirtDark, 20, 28, 8, 4);
  fill("#ffffff22", 23, 20, 2, 8);
  // Right arm: sleeve + skin
  fill(skin, 40, 16, 16, 16);
  fill(accent, 40, 20, 16, 4);
  fill(accent, 44, 16, 4, 4);
  // Left arm
  fill(skin, 32, 48, 16, 16);
  fill(accent, 32, 52, 16, 4);
  fill(accent, 36, 48, 4, 4);
  // Legs
  fill(pants, 0, 16, 16, 16);
  fill(shoes, 0, 30, 16, 2);
  fill(shoes, 8, 16, 4, 4);
  fill(pants, 16, 48, 16, 16);
  fill(shoes, 16, 62, 16, 2);
  fill(shoes, 24, 48, 4, 4);
  return c.toDataURL("image/png");
}
