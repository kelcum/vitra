import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderSearch, HardDriveDownload } from "lucide-react";
import { useEffect, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { Button } from "../../components/ui/Button";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, formatDuration, LOADER_LABEL } from "../../lib/format";
import { toast, useInstances, useNav } from "../../lib/store";
import type { ExternalInstance, Loader } from "../../lib/types";

/** Copies instances from Prism Launcher / MultiMC. The originals aren't touched. */
export function ImportLauncherDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useInstances((s) => s.refresh);
  const navigate = useNav((s) => s.navigate);
  const [found, setFound] = useState<ExternalInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = (folder?: string) => {
    setFound(null);
    setError(null);
    api
      .findExternalInstances(folder ?? null)
      .then(setFound)
      .catch((e) => {
        setFound([]);
        setError(errorMessage(e));
      });
  };

  useEffect(() => {
    if (open) scan();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseFolder = async () => {
    const dir = await openDialog({ directory: true, title: "Choose an instance folder or a launcher's folder" });
    if (dir) scan(dir as string);
  };

  const importOne = async (ext: ExternalInstance) => {
    // The copy runs as a background task with its own progress card.
    onClose();
    try {
      const inst = await api.importExternalInstance(ext.path);
      await refresh();
      toast.success(`Imported ${inst.name}`, "Downloading any missing game files…");
      navigate("instance", { id: inst.id });
      await api.installInstance(inst.id, false);
    } catch (e) {
      if (errorMessage(e) !== "Cancelled") toast.error(`Couldn't import ${ext.name}`, errorMessage(e));
      refresh();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<HardDriveDownload />}
      title="Import from another launcher"
      description="Prism, MultiMC, CurseForge, Modrinth App, ATLauncher, GDLauncher and the Minecraft Launcher. Mods, config, packs, shaders and worlds are copied into a new Vitra instance; the original stays exactly as it is."
      size="wide"
      footer={
        <>
          <Button variant="ghost" icon={<FolderSearch />} onClick={chooseFolder} style={{ marginRight: "auto" }}>
            Choose folder…
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {found === null ? (
        <div className="col" style={{ gap: 8 }}>
          <Skeleton h={56} r={12} />
          <Skeleton h={56} r={12} />
        </div>
      ) : found.length === 0 ? (
        !error && (
          <Empty icon={<FolderSearch />} title="No instances found">
            Vitra checked where Prism, MultiMC, CurseForge, Modrinth App, ATLauncher, GDLauncher and the Minecraft Launcher keep their
            instances. If yours are somewhere else, choose the folder.
          </Empty>
        )
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {[...new Set(found.map((f) => f.source))].map((source) => (
            <div key={source} className="col" style={{ gap: 6 }}>
              <div className="t-label">{source}</div>
              <div className="plan-list glass-inset">
          {found.filter((f) => f.source === source).map((ext) => (
            <div key={ext.path} className="plan-row">
              <InstanceIcon icon={ext.loader === "vanilla" ? "grass" : "diamond"} size={36} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {ext.name}
                </div>
                <div className="t-faint truncate" style={{ fontSize: 12.5 }}>
                  {ext.problem ??
                    [
                      ext.gameVersion || null,
                      `${LOADER_LABEL[ext.loader as Loader] ?? ext.loader}${ext.loaderVersion && ext.loader !== "vanilla" ? ` ${ext.loaderVersion}` : ""}`,
                      ext.modCount ? `${ext.modCount} mods` : null,
                      ext.worldCount ? `${ext.worldCount} world${ext.worldCount === 1 ? "" : "s"}` : null,
                      formatBytes(ext.sizeBytes),
                      ext.playTimeSecs > 60 ? `${formatDuration(ext.playTimeSecs)} played` : null,
                      ext.note,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                </div>
              </div>
              {ext.importedAs && <span className="chip">Already imported</span>}
              <Button size="sm" variant={ext.importedAs ? "ghost" : "primary"} disabled={!!ext.problem} onClick={() => importOne(ext)}>
                {ext.importedAs ? "Import again" : "Import"}
              </Button>
            </div>
          ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
