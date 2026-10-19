import { motion } from "motion/react";
import { Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { cx, formatDuration } from "../lib/format";
import { play, stop } from "../lib/launch";
import { activeTaskFor, useInstances, useTasks } from "../lib/store";
import type { InstanceView } from "../lib/types";
import { ProgressRing } from "./ui/Feedback";
import "./play-button.css";

function useElapsed(since: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  return since ? Math.max(0, (now - since) / 1000) : 0;
}

export function PlayButton({ instance, size = "lg" }: { instance: InstanceView; size?: "lg" | "md" | "sm" }) {
  const tasks = useTasks((s) => s.tasks);
  const runningInfo = useInstances((s) => s.running[instance.id]);
  const task = activeTaskFor(tasks, instance.id);
  const running = !!runningInfo;
  const elapsed = useElapsed(runningInfo?.startedAt);
  const busy = !!task && !running;

  let label = "Play";
  let sub: string | null = null;
  if (running) {
    label = "Stop";
    sub = `Playing · ${formatDuration(elapsed)}`;
  } else if (task) {
    label = task.kind === "launch" ? "Launching" : task.kind === "install" ? "Installing" : "Working";
    sub = task.stage;
  } else if (!instance.installedVersion) {
    sub = "Downloads on first launch";
  }

  return (
    <motion.button
      className={cx("play-btn", `play-btn--${size}`, running && "play-btn--running", busy && "play-btn--busy")}
      onClick={() => (running ? stop(instance.id) : !busy && play(instance.id))}
      whileTap={busy ? undefined : { scale: 0.97 }}
      aria-busy={busy || undefined}
    >
      {busy && task?.progress != null && (
        <span className="play-btn-fill" style={{ transform: `scaleX(${task.progress})` }} aria-hidden />
      )}
      <span className="play-btn-icon">
        {busy ? <ProgressRing value={task?.progress ?? null} size={size === "lg" ? 24 : 18} /> : running ? <Square /> : <Play />}
      </span>
      <span className="play-btn-text">
        <span className="play-btn-label">{label}</span>
        {size === "lg" && sub && <span className="play-btn-sub truncate">{sub}</span>}
      </span>
    </motion.button>
  );
}
