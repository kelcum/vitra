import { getCurrentWebview } from "@tauri-apps/api/webview";
import { hexToRgb, luminance } from "./format";
import type { Settings } from "./types";

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const systemReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function resolvedTheme(s: Settings): "dark" | "light" {
  if (s.theme === "system") return systemDark.matches ? "dark" : "light";
  return s.theme;
}

export function resolvedMotion(s: Settings): "full" | "reduced" | "off" {
  if (s.motion === "full" && systemReducedMotion.matches) return "reduced";
  return s.motion;
}

let lastScale = 1;

export const AUTO_ACCENT = "auto";
const DEFAULT_ACCENT = "#7c9cff";
let backdropAccent: string | null = null;

export function setBackdropAccent(hex: string | null, s: Settings | null) {
  if (hex === backdropAccent) return;
  backdropAccent = hex;
  if (s && s.accent === AUTO_ACCENT) applyAppearance(s);
}

export function resolvedAccent(s: Settings): string {
  if (s.accent === AUTO_ACCENT) return backdropAccent ?? DEFAULT_ACCENT;
  return /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : DEFAULT_ACCENT;
}

export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  const theme = resolvedTheme(s);
  const motion = resolvedMotion(s);
  root.dataset.theme = theme;
  root.dataset.motion = motion;
  root.dataset.ambient = s.ambientEffects && motion !== "off" ? "on" : "off";

  const accent = resolvedAccent(s);
  const rgb = hexToRgb(accent);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-rgb", rgb.join(" "));
  root.style.setProperty("--accent-contrast", luminance(rgb) > 0.45 ? "#0b1020" : "#ffffff");
  root.style.setProperty("--accent-text", readableAccent(rgb, theme));

  const blur = Math.max(0, Math.min(60, s.blur));
  let alpha = 1 - s.transparency;
  const minAlpha = blur < 8 ? 0.72 : blur < 16 ? 0.48 : 0.2;
  if (theme === "light") alpha += 0.1;
  alpha = Math.min(0.92, Math.max(minAlpha, alpha));
  const intensity = s.glassIntensity;

  root.style.setProperty("--glass-alpha", alpha.toFixed(3));
  root.style.setProperty("--glass-alpha-base", alpha.toFixed(3));
  root.style.setProperty("--glass-blur", `${blur}px`);
  root.style.setProperty("--glass-sat", `${Math.round(100 + 90 * intensity)}%`);
  root.style.setProperty(
    "--glass-hl",
    (theme === "light" ? 0.45 + 0.4 * intensity : 0.05 + 0.2 * intensity).toFixed(3),
  );
  root.style.setProperty("--glass-edge", (0.04 + 0.11 * intensity).toFixed(3));
  root.style.setProperty("--motion-scale", motion === "full" ? "1" : motion === "reduced" ? "0.5" : "0");
  const scale = Math.min(1.4, Math.max(0.8, s.uiScale));
  if (scale !== lastScale) {
    lastScale = scale;
    getCurrentWebview().setZoom(scale).catch(() => {});
  }
  root.style.setProperty("--bg-dim", String(Math.min(0.9, Math.max(0, s.background.dim))));
}

function contrast(a: number, b: number) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function readableAccent(rgb: [number, number, number], theme: "dark" | "light"): string {
  const surface = theme === "dark" ? luminance([22, 26, 40]) : luminance([246, 248, 252]);
  const target = theme === "dark" ? 255 : 0;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = rgb.map((v) => Math.round(v + (target - v) * t)) as [number, number, number];
    if (contrast(luminance(c), surface) >= 4.5) return `rgb(${c.join(" ")})`;
  }
  return theme === "dark" ? "#ffffff" : "#000000";
}

export function onSystemAppearanceChange(cb: () => void) {
  systemDark.addEventListener("change", cb);
  systemReducedMotion.addEventListener("change", cb);
}

export const ACCENTS = [
  { name: "Glacier", value: "#7c9cff" },
  { name: "Aqua", value: "#4fd1e8" },
  { name: "Mint", value: "#5ee5a6" },
  { name: "Moss", value: "#9fd356" },
  { name: "Amber", value: "#f7b955" },
  { name: "Coral", value: "#ff8a6b" },
  { name: "Rose", value: "#ff7eb6" },
  { name: "Violet", value: "#a98bff" },
];
