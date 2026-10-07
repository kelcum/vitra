import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { fileSrc } from "../../lib/format";
import { setBackdropAccent } from "../../lib/appearance";
import { useSettings } from "../../lib/store";
import "./background.css";

/** Deterministic blocky skyline so the art is identical on every launch. */
function terrainPath(seed: number, width: number, base: number, amp: number, step: number): string {
  let h = base;
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  let d = `M0 ${width} L0 ${h}`;
  for (let x = 0; x <= width; x += step) {
    const r = rand();
    if (r < 0.35) h -= step * (r < 0.12 ? 2 : 1);
    else if (r > 0.65) h += step * (r > 0.88 ? 2 : 1);
    h = Math.max(base - amp, Math.min(base + amp, h));
    d += ` L${x} ${h} L${x + step} ${h}`;
  }
  return `${d} L${width} ${width} Z`;
}

function Aurora() {
  const layers = useMemo(
    () => [
      { d: terrainPath(7, 1600, 640, 70, 32), cls: "bg-terrain bg-terrain--far" },
      { d: terrainPath(23, 1600, 720, 60, 40), cls: "bg-terrain bg-terrain--mid" },
      { d: terrainPath(91, 1600, 800, 46, 48), cls: "bg-terrain bg-terrain--near" },
    ],
    [],
  );
  return (
    <>
      <div className="bg-aurora ambient">
        <div className="bg-blob bg-blob--a" />
        <div className="bg-blob bg-blob--b" />
        <div className="bg-blob bg-blob--c" />
      </div>
      <div className="bg-stars" />
      <svg className="bg-terrain-svg parallax" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice" aria-hidden>
        {layers.map((l, i) => (
          <path key={i} d={l.d} className={l.cls} style={{ ["--depth" as string]: i + 1 }} />
        ))}
      </svg>
    </>
  );
}

/**
 * The most vivid color in an image, adjusted to work as an accent. Samples a
 * tiny copy so it costs well under a millisecond.
 */
function vividColor(img: HTMLImageElement): string | null {
  try {
    const w = 48;
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    // Score 24 hue buckets by saturation, ignoring near-greys, blacks and whites.
    const buckets = Array.from({ length: 24 }, () => ({ score: 0, r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d < 0.08 || l < 0.12 || l > 0.9) continue;
      const sat = d / (1 - Math.abs(2 * l - 1));
      let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue = (hue * 60 + 360) % 360;
      const k = buckets[Math.floor(hue / 15) % 24];
      k.score += sat * sat;
      k.r += data[i];
      k.g += data[i + 1];
      k.b += data[i + 2];
      k.n += 1;
    }
    const best = buckets.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.n < (w * h) / 60) return null;
    return normalizeAccent(best.r / best.n, best.g / best.n, best.b / best.n);
  } catch {
    // A cross-origin image taints the canvas; keep the default accent.
    return null;
  }
}

/** Keep the hue, but force a bright, saturated tone that reads well on glass. */
function normalizeAccent(r: number, g: number, b: number): string {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const s = 0.82;
  const l = 0.7;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [rr, gg, bb].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

/** Liquify-style backdrop: a vivid image blurred into soft color fields. */
function Liquid({ src }: { src: string | null }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [src]);
  if (!src) {
    return (
      <div className="bg-liquid bg-liquid--art">
        <div className="bg-liquid-field" />
      </div>
    );
  }
  return (
    <div className={`bg-liquid ${loaded ? "bg-liquid--ready" : ""}`}>
      <img
        src={fileSrc(src)}
        crossOrigin="anonymous"
        alt=""
        onLoad={(e) => {
          setLoaded(true);
          setBackdropAccent(vividColor(e.currentTarget), useSettings.getState().settings);
        }}
      />
    </div>
  );
}

function Panorama({ faces }: { faces: string[] }) {
  const [size, setSize] = useState(() => Math.max(window.innerWidth, window.innerHeight) + 4);
  useEffect(() => {
    const onResize = () => setSize(Math.max(window.innerWidth, window.innerHeight) + 4);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const half = size / 2;
  const transforms = [
    `translateZ(${-half}px)`,
    `rotateY(-90deg) translateZ(${-half}px)`,
    `rotateY(180deg) translateZ(${-half}px)`,
    `rotateY(90deg) translateZ(${-half}px)`,
    `rotateX(-90deg) translateZ(${-half}px)`,
    `rotateX(90deg) translateZ(${-half}px)`,
  ];
  return (
    <div className="bg-panorama" style={{ perspective: half }}>
      <div className="bg-panorama-tilt">
        <div className="bg-panorama-cube ambient" style={{ width: size, height: size, marginLeft: -half, marginTop: -half }}>
          {faces.map((src, i) => (
            <img key={i} src={fileSrc(src)} style={{ width: size, height: size, transform: transforms[i] }} alt="" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Background() {
  const bg = useSettings((s) => s.settings?.background);
  const motion = useSettings((s) => s.settings?.motion);
  const ref = useRef<HTMLDivElement>(null);
  const [panorama, setPanorama] = useState<string[] | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [liquidSrc, setLiquidSrc] = useState<string | null | undefined>(undefined);
  const kind = bg?.kind ?? "liquid";

  useEffect(() => {
    if (kind === "panorama") {
      api.panorama().then(setPanorama).catch(() => setPanorama([]));
    } else if (kind === "screenshot") {
      api.recentScreenshots(1).then((s) => setScreenshot(s[0] ?? null)).catch(() => setScreenshot(null));
    } else if (kind === "liquid") {
      // Latest screenshot, else the title panorama, else built-in color fields.
      (async () => {
        const shots = await api.recentScreenshots(1).catch(() => [] as string[]);
        if (shots[0]) return shots[0];
        const faces = await api.panorama().catch(() => [] as string[]);
        return faces[0] ?? null;
      })().then(setLiquidSrc);
    }
    if (kind !== "liquid") setBackdropAccent(null, useSettings.getState().settings);
  }, [kind]);

  // Gentle pointer parallax (skipped when motion is reduced).
  useEffect(() => {
    if (motion !== "full") return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const onMove = (e: PointerEvent) => {
      x = e.clientX / window.innerWidth - 0.5;
      y = e.clientY / window.innerHeight - 0.5;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          ref.current?.style.setProperty("--px", x.toFixed(3));
          ref.current?.style.setProperty("--py", y.toFixed(3));
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [motion]);

  let content: React.ReactNode;
  if (kind === "liquid") content = liquidSrc === undefined ? null : <Liquid src={liquidSrc} />;
  else if (kind === "panorama" && panorama && panorama.length === 6) content = <Panorama faces={panorama} />;
  else if (kind === "screenshot" && screenshot)
    content = <img className="bg-image bg-image--kenburns ambient parallax" src={fileSrc(screenshot)} alt="" />;
  else if (kind === "image" && bg?.value) content = <img className="bg-image parallax" src={fileSrc(bg.value)} alt="" />;
  else content = <Aurora />;

  return (
    <div className="bg-root" ref={ref} aria-hidden>
      {content}
      <div className="bg-dim" />
      <div className="bg-vignette" />
      <div className="bg-noise" />
    </div>
  );
}
