import type { Loader } from "./types";

export interface PerfMod {
  slug: string;
  title: string;
  why: string;
  loaders: Loader[];
  core: boolean;
}

export const PERFORMANCE_MODS: PerfMod[] = [
  {
    slug: "sodium",
    title: "Sodium",
    why: "Replaces the rendering engine. Usually the single biggest FPS gain.",
    loaders: ["fabric", "quilt", "neoforge"],
    core: true,
  },
  {
    slug: "lithium",
    title: "Lithium",
    why: "Optimizes game logic (ticking, AI, physics) without changing gameplay.",
    loaders: ["fabric", "quilt", "neoforge"],
    core: true,
  },
  {
    slug: "ferrite-core",
    title: "FerriteCore",
    why: "Reduces memory usage, which means fewer garbage-collection stutters.",
    loaders: ["fabric", "quilt", "forge", "neoforge"],
    core: true,
  },
  {
    slug: "immediatelyfast",
    title: "ImmediatelyFast",
    why: "Speeds up HUD, text and entity rendering.",
    loaders: ["fabric", "quilt", "forge", "neoforge"],
    core: true,
  },
  {
    slug: "entityculling",
    title: "Entity Culling",
    why: "Skips drawing entities and block entities hidden behind walls.",
    loaders: ["fabric", "quilt", "forge", "neoforge"],
    core: true,
  },
  {
    slug: "moreculling",
    title: "More Culling",
    why: "Culls more block faces (leaves, glass) that can't be seen.",
    loaders: ["fabric", "quilt", "neoforge"],
    core: false,
  },
  {
    slug: "modernfix",
    title: "ModernFix",
    why: "Faster startup and lower memory use, especially with many mods.",
    loaders: ["fabric", "forge", "neoforge"],
    core: false,
  },
  {
    slug: "dynamic-fps",
    title: "Dynamic FPS",
    why: "Lowers FPS while the game is in the background — saves power and heat.",
    loaders: ["fabric", "quilt", "forge", "neoforge"],
    core: false,
  },
];

export type GraphicsPresetId = "max-fps" | "balanced" | "quality";

export interface GraphicsPreset {
  id: GraphicsPresetId;
  title: string;
  description: string;
  jvmPreset: string;
  options: Record<string, string>;
  mods: "core" | "all" | "none";
}

export const GRAPHICS_PRESETS: GraphicsPreset[] = [
  {
    id: "max-fps",
    title: "Maximum FPS",
    description: "Lowest latency and highest frame rate. Short view distance, fast graphics, no VSync.",
    jvmPreset: "balanced",
    mods: "all",
    options: {
      renderDistance: "8",
      simulationDistance: "6",
      maxFps: "260",
      enableVsync: "false",
      graphicsMode: "0",
      ao: "false",
      entityShadows: "false",
      particles: "2",
      biomeBlendRadius: "0",
      mipmapLevels: "0",
      renderClouds: "\"false\"",
      entityDistanceScaling: "0.75",
    },
  },
  {
    id: "balanced",
    title: "Balanced",
    description: "Good looks at high frame rates. A sensible default for most computers.",
    jvmPreset: "balanced",
    mods: "core",
    options: {
      renderDistance: "12",
      simulationDistance: "8",
      maxFps: "260",
      enableVsync: "false",
      graphicsMode: "1",
      ao: "true",
      entityShadows: "true",
      particles: "1",
      biomeBlendRadius: "2",
      mipmapLevels: "4",
      renderClouds: "\"fast\"",
      entityDistanceScaling: "1.0",
    },
  },
  {
    id: "quality",
    title: "Visual quality",
    description: "Far view distance and fancy graphics. Best with a dedicated GPU.",
    jvmPreset: "balanced",
    mods: "core",
    options: {
      renderDistance: "20",
      simulationDistance: "10",
      maxFps: "260",
      enableVsync: "true",
      graphicsMode: "1",
      ao: "true",
      entityShadows: "true",
      particles: "0",
      biomeBlendRadius: "5",
      mipmapLevels: "4",
      renderClouds: "\"true\"",
      entityDistanceScaling: "1.5",
    },
  },
];

export function perfModsFor(loader: Loader, which: "core" | "all"): PerfMod[] {
  return PERFORMANCE_MODS.filter((m) => m.loaders.includes(loader) && (which === "all" || m.core));
}
