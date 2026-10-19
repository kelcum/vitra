import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { errorMessage } from "./api";
import { useDialogs, useSettings } from "./store";

type Status = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

interface UpdateStore {
  status: Status;
  update: Update | null;
  progress: number | null;
  error: string | null;
  lastChecked: number | null;
}

export const useUpdate = create<UpdateStore>(() => ({
  status: "idle",
  update: null,
  progress: null,
  error: null,
  lastChecked: null,
}));

let inFlight: Promise<void> | null = null;

export function checkForUpdates({ silent }: { silent: boolean }): Promise<void> {
  if (inFlight) return inFlight;
  const { status } = useUpdate.getState();
  if (status === "downloading" || status === "installing") return Promise.resolve();
  inFlight = (async () => {
    if (!silent) useUpdate.setState({ status: "checking", error: null });
    try {
      const update = await check({ timeout: 20_000 });
      useUpdate.setState({
        status: update ? "available" : "current",
        update,
        error: null,
        lastChecked: Date.now(),
      });
    } catch (e) {
      useUpdate.setState(
        silent ? { lastChecked: Date.now() } : { status: "error", error: errorMessage(e), lastChecked: Date.now() },
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function installUpdate() {
  const { update } = useUpdate.getState();
  if (!update) return;
  let total = 0;
  let done = 0;
  useUpdate.setState({ status: "downloading", progress: null, error: null });
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        done += event.data.chunkLength;
        useUpdate.setState({ progress: total ? Math.min(1, done / total) : null });
      } else if (event.event === "Finished") {
        useUpdate.setState({ status: "installing", progress: 1 });
      }
    });
  } catch (e) {
    useUpdate.setState({ status: "error", error: errorMessage(e) });
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
let started = false;
let shownThisSession = false;

export function startUpdateChecks() {
  if (started) return;
  started = true;
  const tick = async () => {
    if (!(useSettings.getState().settings?.checkUpdates ?? true)) return;
    await checkForUpdates({ silent: true });
    if (useUpdate.getState().status === "available" && !shownThisSession) {
      shownThisSession = true;
      useDialogs.getState().set({ update: true });
    }
  };
  window.setTimeout(tick, 4000);
  window.setInterval(tick, SIX_HOURS);
}
