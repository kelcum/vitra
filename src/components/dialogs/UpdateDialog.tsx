import { getVersion } from "@tauri-apps/api/app";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogs, useInstances } from "../../lib/store";
import { installUpdate, useUpdate } from "../../lib/updater";
import { Button } from "../ui/Button";
import { Notice, ProgressBar } from "../ui/Feedback";
import { Modal } from "../ui/Overlay";

export function UpdateDialog() {
  const open = useDialogs((s) => s.update);
  const set = useDialogs((s) => s.set);
  const { status, update, progress, error } = useUpdate();
  const gameRunning = useInstances((s) => Object.keys(s.running).length > 0);
  const [current, setCurrent] = useState<string | null>(null);
  const busy = status === "downloading" || status === "installing";

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
  }, []);

  const notes = (update?.body ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);

  return (
    <Modal
      open={open && !!update}
      onClose={() => !busy && set({ update: false })}
      dismissable={!busy}
      icon={<ArrowUpCircle />}
      title={`Vitra ${update?.version ?? ""} is ready`}
      description={current ? `You have ${current}. Your instances, worlds and settings stay exactly as they are.` : undefined}
      footer={
        <>
          {!busy && (
            <Button variant="ghost" onClick={() => set({ update: false })}>
              Later
            </Button>
          )}
          <Button variant="primary" icon={<RefreshCw />} loading={busy} disabled={busy || gameRunning} onClick={installUpdate}>
            {status === "installing" ? "Restarting…" : status === "downloading" ? "Downloading…" : "Update & restart"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {notes.length > 0 && (
          <div className="update-notes glass-inset">
            <div className="t-label">What's new</div>
            <ul>
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {busy && (
          <div className="col" style={{ gap: 6 }}>
            <ProgressBar value={status === "installing" ? 1 : progress} />
            <span className="t-faint" style={{ fontSize: 12.5 }}>
              {status === "installing" ? "Installing. Vitra will close and reopen by itself." : "Downloading and checking the signature…"}
            </span>
          </div>
        )}
        {gameRunning && !busy && <Notice tone="warning">Close Minecraft first. Updating restarts Vitra.</Notice>}
        {status === "error" && error && <Notice tone="danger">The update didn't go through: {error}</Notice>}
      </div>
    </Modal>
  );
}
