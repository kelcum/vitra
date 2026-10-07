// Mirrors the Rust types serialized over IPC (camelCase).

export type Theme = "dark" | "light" | "system";
export type Motion = "full" | "reduced" | "off";
export type Loader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";
export type ProjectType = "mod" | "modpack" | "resourcepack" | "shader";

export interface Background {
  kind: "liquid" | "aurora" | "panorama" | "screenshot" | "image";
  value: string | null;
  dim: number;
}

export interface Settings {
  theme: Theme;
  accent: string;
  glassIntensity: number;
  blur: number;
  transparency: number;
  background: Background;
  motion: Motion;
  ambientEffects: boolean;
  uiScale: number;
  startupPage: string;
  onGameLaunch: "keep" | "minimize" | "hide";
  reopenOnExit: boolean;
  showNews: boolean;
  checkUpdates: boolean;
  /** Vitra badges and capes in Fabric instances. */
  cosmetics: boolean;
  notifications: { downloads: boolean; crashes: boolean; gameUpdates: boolean };
  gameDataDir: string | null;
  downloadConcurrency: number;
  defaultMemoryMb: number;
  defaultJvmArgs: string;
  defaultVersion: string | null;
  defaultLoader: Loader;
  msaClientId: string | null;
  activeAccount: string | null;
  selectedInstance: string | null;
  onboarded: boolean;
}

export interface WindowSettings {
  custom: boolean;
  width: number;
  height: number;
  fullscreen: boolean;
}

export interface ModpackRef {
  projectId: string | null;
  versionId: string | null;
  title: string;
  iconUrl: string | null;
}

export interface Instance {
  id: string;
  name: string;
  icon: string;
  gameVersion: string;
  loader: Loader;
  loaderVersion: string | null;
  createdAt: number;
  lastPlayed: number | null;
  playTimeSecs: number;
  javaPath: string | null;
  memoryMb: number | null;
  jvmPreset: string;
  jvmArgs: string;
  gameArgs: string;
  window: WindowSettings;
  gameDir: string | null;
  installedVersion: string | null;
  performancePreset: string | null;
  modpack: ModpackRef | null;
  /** Source folder when imported from another launcher. */
  importedFrom?: string | null;
}

/** An instance found in Prism Launcher / MultiMC. */
export interface ExternalInstance {
  source: string;
  path: string;
  name: string;
  gameVersion: string;
  loader: Loader;
  loaderVersion: string | null;
  modCount: number;
  worldCount: number;
  sizeBytes: number;
  playTimeSecs: number;
  importedAs: string | null;
  /** Something worth knowing before importing. */
  note: string | null;
  problem: string | null;
}

export interface InstanceView extends Instance {
  path: string;
  /** Where the game actually runs (custom folder or the default one). */
  resolvedGameDir: string;
  running: boolean;
}

export interface TaskSnapshot {
  id: string;
  kind: string;
  title: string;
  stage: string;
  instanceId: string | null;
  progress: number | null;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSec: number;
  etaSecs: number | null;
  state: "running" | "done" | "failed" | "cancelled";
  error: string | null;
  startedAt: number;
}

export interface GameVersion {
  id: string;
  kind: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface LoaderVersion {
  version: string;
  stable: boolean;
  recommended: boolean;
}

export interface JavaInstall {
  path: string;
  version: string;
  major: number;
  arch: string;
  vendor: string;
  source: "managed" | "system";
  component: string | null;
}

export interface Account {
  uuid: string;
  name: string;
  ownsGame: boolean;
  addedAt: number;
  skinUrl: string | null;
  skinVariant: string | null;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface SavedSkin {
  id: string;
  name: string;
  model: "classic" | "slim";
  addedAt: number;
  dataUrl: string;
}

export interface CapeView {
  id: string;
  alias: string;
  active: boolean;
  dataUrl: string | null;
}

/** A cape from Vitra's cape server: 2:1 cape textures stacked top to bottom, one per frame. */
export interface VitraCape {
  id: string;
  url: string;
  w: number;
  h: number;
  frames: number;
  delay: number;
}

export interface CapePreset {
  slug: string;
  name: string;
  cape: VitraCape;
}

export interface CosmeticsStatus {
  cape: VitraCape | null;
  presets: CapePreset[];
}

export interface ProfileView {
  uuid: string;
  name: string;
  skinDataUrl: string | null;
  skinModel: "classic" | "slim";
  capes: CapeView[];
}

export interface WorldInfo {
  instanceId: string;
  instanceName: string;
  folder: string;
  lastPlayed: number;
  icon: string | null;
  path: string;
}

export interface ContentItem {
  key: string;
  fileName: string;
  enabled: boolean;
  size: number;
  title: string;
  version: string | null;
  iconUrl: string | null;
  localIcon: string | null;
  projectId: string | null;
  versionId: string | null;
  source: "modrinth" | "local";
  modified: number;
}

export interface TrashItem {
  trashName: string;
  key: string;
  title: string;
  removedAt: number;
  wasEnabled: boolean;
}

export interface PlannedFile {
  projectId: string;
  versionId: string;
  title: string;
  iconUrl: string | null;
  versionNumber: string;
  fileName: string;
  url: string;
  sha1: string | null;
  sha512: string | null;
  size: number;
  projectType: ProjectType;
  reason: "requested" | "dependency" | "update";
  requiredBy: string | null;
  replaces: string | null;
}

export interface InstallPlan {
  instanceId: string;
  files: PlannedFile[];
  warnings: string[];
  conflicts: string[];
  skipped: string[];
}

export interface PlanRequest {
  projectId: string;
  versionId?: string | null;
  projectType: ProjectType;
  title?: string | null;
}

export interface UpdateInfo {
  key: string;
  projectId: string;
  title: string;
  currentVersion: string | null;
  newVersion: string;
  versionId: string;
  projectType: ProjectType;
}

export interface SearchHit {
  project_id: string;
  project_type: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  categories: string[];
  display_categories: string[];
  versions: string[];
  downloads: number;
  follows: number;
  icon_url: string | null;
  date_modified: string;
  latest_version: string;
  gallery: string[];
  featured_gallery: string | null;
  color: number | null;
}

export interface SearchResult {
  hits: SearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  date_published: string;
  downloads: number;
  files: { url: string; filename: string; primary: boolean; size: number; hashes: Record<string, string> }[];
}

export interface MrProjectDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  icon_url: string | null;
  project_type: string;
  downloads: number;
  followers: number;
  categories: string[];
  game_versions: string[];
  loaders: string[];
  license?: { id: string; name: string } | null;
  source_url?: string | null;
  issues_url?: string | null;
  wiki_url?: string | null;
  discord_url?: string | null;
  gallery: { url: string; featured: boolean; title: string | null }[];
  client_side?: string;
  server_side?: string;
  updated: string;
}

export interface ResourcePack {
  fileName: string;
  title: string;
  description: string;
  packFormat: number | null;
  icon: string | null;
  enabled: boolean;
  order: number | null;
  compatible: boolean | null;
  size: number;
}

export interface ShaderState {
  packs: { fileName: string; title: string; size: number }[];
  active: string | null;
  enabled: boolean;
  support: "iris" | "oculus" | "optifine" | "none";
}

export interface SystemInfo {
  os: string;
  cpu: string;
  cores: number;
  threads: number;
  totalMemoryMb: number;
  availableMemoryMb: number;
  gpus: string[];
  launcherMemoryMb: number;
  recommendedVanillaMb: number;
  recommendedModdedMb: number;
}

export interface PatchNote {
  id: string;
  title: string;
  version: string;
  kind: string;
  date: string;
  shortText: string;
  image: string | null;
  contentPath: string;
}

export interface TextBlock {
  kind: "h" | "p" | "li";
  text: string;
}

export interface LogLine {
  level: string;
  thread: string | null;
  text: string;
  time: number;
}

export interface LogFile {
  name: string;
  kind: "log" | "crash";
  modified: number;
  size: number;
}

export interface GameExit {
  instanceId: string;
  code: number | null;
  crashed: boolean;
  killed: boolean;
  crashReport: string | null;
  tail: string[];
  playedSecs: number;
}

export interface RunningInfo {
  instanceId: string;
  pid: number;
  startedAt: number;
}

export interface StorageInfo {
  dataDir: string;
  launcherDir: string;
  instancesMb: number;
  librariesMb: number;
  assetsMb: number;
  versionsMb: number;
  runtimesMb: number;
  cacheMb: number;
  backupsMb: number;
}

/** A server on the Servers page: featured (curated) or added by the player. */
export interface ServerEntry {
  id: string;
  name: string;
  address: string;
  category: string | null;
  description: string | null;
  featured: boolean;
  hidden: boolean;
}

/** Live Server List Ping result. */
export interface ServerStatus {
  latencyMs: number;
  version: string;
  protocol: number;
  playersOnline: number;
  playersMax: number;
  /** A string with § codes or a chat component. */
  motd: unknown;
  favicon: string | null;
}

/** A skin found by player name or link, not yet saved to the library. */
export interface FoundSkin {
  name: string;
  source: "player" | "link";
  dataUrl: string;
  model: "classic" | "slim";
}
