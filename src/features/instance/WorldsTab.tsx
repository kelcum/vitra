import { Archive, FolderOpen, Globe2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Empty, Skeleton } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { fileSrc, relativeTime } from "../../lib/format";
import { play } from "../../lib/launch";
import { toast } from "../../lib/store";
import type { InstanceView, WorldInfo } from "../../lib/types";

function supportsQuickPlay(version: string): boolean {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  if (parts[0] >= 25) return true;
  return parts[0] === 1 && (parts[1] ?? 0) >= 20;
}

export function WorldsTab({ instance }: { instance: InstanceView }) {
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  useEffect(() => {
    api.listWorlds(instance.id).then(setWorlds).catch(() => setWorlds([]));
  }, [instance.id, instance.lastPlayed]);
  const quickPlay = supportsQuickPlay(instance.gameVersion);

  return (
    <div className="content-tab">
      <div className="content-toolbar">
        <span className="t-muted" style={{ fontSize: 13 }}>
          {quickPlay ? "Play a world to launch straight into it — no menus." : "Quick Play needs Minecraft 1.20 or newer; Play opens the game normally."}
        </span>
        <span className="spacer" />
        <Button
          icon={<Archive />}
          onClick={() =>
            api
              .backupInstance(instance.id)
              .then((p) => toast.success("Backup saved", p))
              .catch((e) => toast.error("Backup failed", errorMessage(e)))
          }
        >
          Back up instance
        </Button>
        <IconButton label="Open saves folder" onClick={() => api.openInstanceFolder(instance.id, "saves")}>
          <FolderOpen />
        </IconButton>
      </div>
      {worlds === null ? (
        <div className="world-grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} h={86} r={16} />
          ))}
        </div>
      ) : worlds.length === 0 ? (
        <Empty icon={<Globe2 />} title="No worlds yet">
          Worlds you create in this instance appear here.
        </Empty>
      ) : (
        <div className="world-grid">
          {worlds.map((w) => (
            <div key={w.folder} className="world-card glass-inset">
              {w.icon ? <img src={fileSrc(w.icon)} alt="" /> : <div className="world-card-empty" />}
              <div className="grow">
                <div className="content-title truncate">{w.folder}</div>
                <div className="content-sub">Played {relativeTime(w.lastPlayed).toLowerCase()}</div>
              </div>
              <Button size="sm" variant="primary" icon={<Play />} disabled={instance.running} onClick={() => play(instance.id, { world: quickPlay ? w.folder : null })}>
                Play
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
