import { api, parseError } from "./api";
import { toast, useDialogs, useInstances } from "./store";

/**
 * Launches an instance and turns account problems into the right dialog
 * instead of a raw error: no account → sign in or play the demo, account
 * without the game → demo, expired sign-in → sign in again.
 */
export async function play(instanceId: string, opts: { world?: string | null; server?: string | null; demo?: boolean } = {}) {
  try {
    await api.launch(instanceId, opts);
    await useInstances.getState().refresh();
  } catch (e) {
    const { code, message } = parseError(e);
    if (code === "NO_ACCOUNT" || code === "NOT_OWNED") {
      useDialogs.getState().set({ demoPrompt: { instanceId, world: opts.world, server: opts.server, reason: message } });
    } else if (code === "SIGN_IN_AGAIN") {
      toast.warning("Please sign in again", message);
      useDialogs.getState().set({ signIn: true });
    } else if (message !== "Cancelled") {
      toast.error("Couldn't launch Minecraft", message);
    }
  }
}

export async function stop(instanceId: string) {
  try {
    await api.stop(instanceId);
  } catch (e) {
    toast.error("Couldn't stop the game", parseError(e).message);
  }
}
