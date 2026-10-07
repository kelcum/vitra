import { convertFileSrc } from "@tauri-apps/api/core";
import type { Loader } from "./types";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

export function formatEta(secs: number | null): string | null {
  if (secs == null || !Number.isFinite(secs)) return null;
  if (secs < 1) return "almost done";
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  return `${Math.ceil(secs / 60)} min left`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const rtfShort = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

export function relativeTime(ms: number | null | undefined, short = false): string {
  if (!ms) return "Never";
  const rtf_ = short ? rtfShort : rtf;
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "Just now";
  if (abs < 3600) return rtf_.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf_.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf_.format(Math.round(diff / 86400), "day");
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const LOADER_LABEL: Record<Loader, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
};

/** Local files are served through Tauri's asset protocol. */
export function fileSrc(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http") || path.startsWith("data:")) return path;
  return convertFileSrc(path);
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [124, 156, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** WCAG relative luminance — picks readable text on accent fills. */
export function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
