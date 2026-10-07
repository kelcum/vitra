import { create } from "zustand";
import { api, errorMessage } from "./api";
import { applyAppearance } from "./appearance";
import type {
  Account,
  GameExit,
  InstallPlan,
  InstanceView,
  LogLine,
  RunningInfo,
  Settings,
  TaskSnapshot,
} from "./types";

// ------------------------------------------------------------------ settings

let saveTimer: number | undefined;
/** Edits made since the last save. */
let unsaved: Partial<Settings> = {};

interface SettingsStore {
  settings: Settings | null;
  load: () => Promise<Settings>;
  update: (patch: Partial<Settings>) => void;
  replace: (s: Settings) => void;
  external: (s: Settings) => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: null,
  load: async () => {
    const s = await api.getSettings();
    applyAppearance(s);
    set({ settings: s });
    return s;
  },
  // Optimistic: the UI updates instantly, the file write is debounced.
  update: (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    unsaved = { ...unsaved, ...patch };
    applyAppearance(next);
    set({ settings: next });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      unsaved = {};
      api.saveSettings(get().settings ?? next).catch((e) => toast.error("Couldn't save settings", errorMessage(e)));
    }, 250);
  },
  // Settings the backend changed: take them, keeping edits that are still waiting to be saved.
  external: (s) => {
    const next = { ...s, ...unsaved };
    applyAppearance(next);
    set({ settings: next });
  },
  replace: (s) => {
    applyAppearance(s);
    set({ settings: s });
  },
}));

// ------------------------------------------------------------------ navigation

export type Page = "home" | "library" | "instance" | "discover" | "servers" | "skins" | "performance" | "settings";

interface NavStore {
  page: Page;
  params: Record<string, string>;
  history: { page: Page; params: Record<string, string> }[];
  navigate: (page: Page, params?: Record<string, string>) => void;
  back: () => void;
}

export const useNav = create<NavStore>((set, get) => ({
  page: "home",
  params: {},
  history: [],
  navigate: (page, params = {}) => {
    const { page: cur, params: curParams, history } = get();
    if (cur === page && JSON.stringify(curParams) === JSON.stringify(params)) return;
    set({ page, params, history: [...history.slice(-20), { page: cur, params: curParams }] });
  },
  back: () => {
    const h = get().history;
    const prev = h[h.length - 1];
    if (prev) set({ page: prev.page, params: prev.params, history: h.slice(0, -1) });
    else set({ page: "home", params: {} });
  },
}));

// ------------------------------------------------------------------ instances

interface InstanceStore {
  instances: InstanceView[];
  loaded: boolean;
  running: Record<string, RunningInfo>;
  refresh: () => Promise<void>;
  setRunning: (r: RunningInfo[]) => void;
}

export const useInstances = create<InstanceStore>((set) => ({
  instances: [],
  loaded: false,
  running: {},
  refresh: async () => {
    const instances = await api.listInstances();
    set({ instances, loaded: true });
  },
  setRunning: (list) => set({ running: Object.fromEntries(list.map((r) => [r.instanceId, r])) }),
}));

/** The instance the Play button targets. */
export function useSelectedInstance(): InstanceView | null {
  const instances = useInstances((s) => s.instances);
  const selected = useSettings((s) => s.settings?.selectedInstance);
  return instances.find((i) => i.id === selected) ?? instances[0] ?? null;
}

// ------------------------------------------------------------------ tasks

interface TaskStore {
  tasks: Record<string, TaskSnapshot>;
  upsert: (t: TaskSnapshot) => void;
  dismiss: (id: string) => void;
}

export const useTasks = create<TaskStore>((set) => ({
  tasks: {},
  upsert: (t) => set((s) => ({ tasks: { ...s.tasks, [t.id]: t } })),
  dismiss: (id) =>
    set((s) => {
      const next = { ...s.tasks };
      delete next[id];
      return { tasks: next };
    }),
}));

export function activeTaskFor(tasks: Record<string, TaskSnapshot>, instanceId: string | undefined) {
  if (!instanceId) return undefined;
  return Object.values(tasks)
    .filter((t) => t.instanceId === instanceId && t.state === "running")
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

// ------------------------------------------------------------------ accounts

interface AccountStore {
  accounts: Account[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useAccounts = create<AccountStore>((set) => ({
  accounts: [],
  loaded: false,
  refresh: async () => set({ accounts: await api.listAccounts(), loaded: true }),
}));

export function useActiveAccount(): Account | null {
  const accounts = useAccounts((s) => s.accounts);
  const active = useSettings((s) => s.settings?.activeAccount);
  return accounts.find((a) => a.uuid === active) ?? accounts[0] ?? null;
}

// ------------------------------------------------------------------ game logs

const MAX_LINES = 5000;

interface LogStore {
  lines: Record<string, LogLine[]>;
  append: (id: string, lines: LogLine[]) => void;
  clear: (id: string) => void;
}

export const useLogs = create<LogStore>((set) => ({
  lines: {},
  append: (id, lines) =>
    set((s) => {
      const cur = s.lines[id] ?? [];
      const next = cur.length + lines.length > MAX_LINES ? [...cur, ...lines].slice(-MAX_LINES) : [...cur, ...lines];
      return { lines: { ...s.lines, [id]: next } };
    }),
  clear: (id) => set((s) => ({ lines: { ...s.lines, [id]: [] } })),
}));

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warning";
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;
export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    window.setTimeout(() => get().dismiss(id), t.kind === "error" ? 9000 : 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// A failing background task reports its error, and so does the screen that started it. The same
// error text within a few seconds is shown once.
const recentErrors = new Map<string, number>();
const ERROR_REPEAT_MS = 4000;

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push({ kind: "info", title, body }),
  success: (title: string, body?: string) => useToasts.getState().push({ kind: "success", title, body }),
  warning: (title: string, body?: string) => useToasts.getState().push({ kind: "warning", title, body }),
  error: (title: string, body?: string) => {
    const key = body || title;
    const now = Date.now();
    if (now - (recentErrors.get(key) ?? 0) < ERROR_REPEAT_MS) return;
    recentErrors.set(key, now);
    useToasts.getState().push({ kind: "error", title, body });
  },
};

// ------------------------------------------------------------------ dialogs

interface DialogStore {
  crash: GameExit | null;
  signIn: boolean;
  update: boolean;
  createInstance: boolean | { gameVersion?: string; loader?: string };
  plan: { plan: InstallPlan; title: string } | null;
  demoPrompt: { instanceId: string; world?: string | null; server?: string | null; reason: string } | null;
  set: (patch: Partial<Omit<DialogStore, "set">>) => void;
}

export const useDialogs = create<DialogStore>((set) => ({
  crash: null,
  signIn: false,
  update: false,
  createInstance: false,
  plan: null,
  demoPrompt: null,
  set: (patch) => set(patch),
}));

// Dev-only handle for automated UI checks (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vitra = { useSettings, useNav, useInstances, useTasks, useDialogs };
}
