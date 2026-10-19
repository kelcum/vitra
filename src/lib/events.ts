import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { api } from "./api";
import { formatDuration } from "./format";
import type { Account, GameExit, LogLine, Memory, Settings, TaskSnapshot } from "./types";
import { toast, useAccounts, useDialogs, useInstances, useLogs, useNav, useSettings, useTasks, useToasts } from "./store";

/** Bumped whenever an instance's installed content changes. */
export const useContentVersion = create<{ v: number; bump: () => void }>((set) => ({
  v: 0,
  bump: () => set((s) => ({ v: s.v + 1 })),
}));

/** Bumped whenever a memory is saved. */
export const useMemoryVersion = create<{ v: number; bump: () => void }>((set) => ({
  v: 0,
  bump: () => set((s) => ({ v: s.v + 1 })),
}));

/** Memories made in each running game, announced when it closes. */
const newMemories = new Map<string, Memory[]>();

// Backups aren't here: the Back up menu item says where the file went.
const NOTIFY_KINDS = new Set(["install", "modpack", "content", "java", "export", "copy"]);

// Ambient motion (and the 3D skin viewer) pauses whenever nobody is looking:
// game running, window hidden/minimized/unfocused, or no input for a minute.
let minimized = false;
let focused = document.hasFocus();
let lastInput = Date.now();
const INACTIVE_MS = 60_000;

function updateIdle() {
  const gameRunning = Object.keys(useInstances.getState().running).length > 0;
  const inactive = Date.now() - lastInput > INACTIVE_MS;
  const idle = gameRunning || document.hidden || minimized || !focused || inactive;
  const value = String(idle);
  if (document.documentElement.dataset.idle !== value) document.documentElement.dataset.idle = value;
}

function trackActivity() {
  const onInput = () => {
    lastInput = Date.now();
    if (document.documentElement.dataset.idle === "true") updateIdle();
  };
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    window.addEventListener(ev, onInput, { passive: true });
  }
  window.addEventListener("focus", () => ((focused = true), onInput()));
  window.addEventListener("blur", () => ((focused = false), updateIdle()));
  window.setInterval(updateIdle, 5000);
}

async function refreshRunning() {
  useInstances.getState().setRunning(await api.runningInstances());
  updateIdle();
}

let wired = false;

export async function wireEvents() {
  if (wired) return;
  wired = true;

  document.addEventListener("visibilitychange", updateIdle);
  trackActivity();
  // Minimized windows don't always report `hidden`; treat minimize as idle too.
  const win = getCurrentWindow();
  win.onResized(async () => {
    minimized = await win.isMinimized().catch(() => false);
    updateIdle();
  });

  await listen<TaskSnapshot>("task://update", ({ payload: t }) => {
    useTasks.getState().upsert(t);
    const notify = useSettings.getState().settings?.notifications.downloads ?? true;
    if (t.state === "done") {
      if (["install", "modpack", "content", "copy"].includes(t.kind)) useInstances.getState().refresh();
      if (notify && NOTIFY_KINDS.has(t.kind)) toast.success(doneTitle(t));
      window.setTimeout(() => useTasks.getState().dismiss(t.id), 6000);
    } else if (t.state === "failed" && t.kind !== "launch") {
      toast.error(`${t.title} failed`, t.error ?? undefined);
    } else if (t.state === "cancelled") {
      window.setTimeout(() => useTasks.getState().dismiss(t.id), 2500);
    }
  });

  await listen<{ instanceId: string; lines: LogLine[] }>("game://log", ({ payload }) => {
    useLogs.getState().append(payload.instanceId, payload.lines);
  });

  await listen<{ instanceId: string }>("game://started", ({ payload }) => {
    useLogs.getState().clear(payload.instanceId);
    refreshRunning();
    useInstances.getState().refresh();
  });

  await listen<GameExit>("game://exited", ({ payload }) => {
    refreshRunning();
    useInstances.getState().refresh();
    const s = useSettings.getState().settings;
    const made = newMemories.get(payload.instanceId) ?? [];
    newMemories.delete(payload.instanceId);
    if (payload.crashed) {
      if (s?.notifications.crashes ?? true) useDialogs.getState().set({ crash: payload });
    } else if (made.length > 0) {
      useToasts.getState().push({
        kind: "success",
        title: made.length === 1 ? "A new memory" : `${made.length} new memories`,
        body: made.length === 1 ? made[0].title : `${made[0].title} and ${made.length - 1} more`,
        action: { label: "View", run: () => useNav.getState().navigate("memories") },
      });
    } else if (!payload.killed && payload.playedSecs > 60) {
      toast.info("Thanks for playing", `Session length: ${formatDuration(payload.playedSecs)}`);
    }
  });

  await listen<Account>("auth://success", async ({ payload }) => {
    await useAccounts.getState().refresh();
    await useSettings.getState().load();
    useDialogs.getState().set({ signIn: false });
    toast.success(`Signed in as ${payload.name}`, payload.ownsGame ? undefined : "This account doesn't own Java Edition — you can play the demo.");
  });

  await listen<{ instanceId: string }>("content://changed", () => useContentVersion.getState().bump());
  await listen<Memory>("memory://added", ({ payload }) => {
    newMemories.set(payload.instanceId, [...(newMemories.get(payload.instanceId) ?? []), payload]);
    useMemoryVersion.getState().bump();
  });
  await listen("instances://changed", () => useInstances.getState().refresh());
  // The backend changed a setting (selected instance after an install, active account, …).
  await listen<Settings>("settings://changed", ({ payload }) => useSettings.getState().external(payload));

  // Pick up anything already running/in progress (e.g. after a reload).
  await refreshRunning();
  for (const t of await api.listTasks()) useTasks.getState().upsert(t);
}

function doneTitle(t: TaskSnapshot): string {
  if (t.kind === "install") return t.title.replace(/^Installing/, "Installed").replace(/^Repairing/, "Repaired");
  if (t.kind === "modpack") return t.title.replace(/^(Installing|Importing)/, "Ready:");
  if (t.kind === "content") return t.title.replace(/^Installing/, "Installed");
  if (t.kind === "backup") return "Backup saved";
  if (t.kind === "export") return "Modpack exported";
  if (t.kind === "copy") return t.title.startsWith("Importing") ? t.title.replace(/^Importing/, "Imported") : "Instance duplicated";
  return `${t.title} — done`;
}
