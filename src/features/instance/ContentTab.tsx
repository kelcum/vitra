import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArchiveRestore,
  Boxes,
  Compass,
  ExternalLink,
  FilePlus2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput, Toggle } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { Menu, Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { useContentVersion } from "../../lib/events";
import { fileSrc, formatBytes, relativeTime } from "../../lib/format";
import { toast, useDialogs, useNav } from "../../lib/store";
import type { ContentItem, InstanceView, TrashItem, UpdateInfo } from "../../lib/types";

/** Accept files dropped onto the window while this tab is open. */
export function useFileDrop(onDrop: (paths: string[]) => void, enabled = true) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "enter" || e.payload.type === "over") setHovering(true);
        else if (e.payload.type === "leave") setHovering(false);
        else if (e.payload.type === "drop") {
          setHovering(false);
          onDrop(e.payload.paths);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [onDrop, enabled]);
  return hovering;
}

export function ModsTab({ instance }: { instance: InstanceView }) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [updates, setUpdates] = useState<UpdateInfo[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const contentVersion = useContentVersion((s) => s.v);
  const navigate = useNav((s) => s.navigate);
  const setDialogs = useDialogs((s) => s.set);
  const vanilla = instance.loader === "vanilla";

  const load = useCallback(() => {
    setError(null);
    api
      .listContent(instance.id, "mod")
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  }, [instance.id]);

  useEffect(load, [load, contentVersion]);

  const importFiles = useCallback(
    async (paths: string[]) => {
      const jars = paths.filter((p) => p.toLowerCase().endsWith(".jar"));
      if (!jars.length) {
        toast.warning("Only .jar files can be added as mods");
        return;
      }
      try {
        const n = await api.importContentFiles(instance.id, "mod", jars);
        toast.success(`Added ${n} mod${n === 1 ? "" : "s"}`);
        load();
      } catch (e) {
        toast.error("Couldn't add the files", errorMessage(e));
      }
    },
    [instance.id, load],
  );
  const dropping = useFileDrop(importFiles, !vanilla);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.title} ${i.fileName}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const updateMap = useMemo(() => new Map((updates ?? []).map((u) => [u.key, u])), [updates]);

  const toggle = async (item: ContentItem, enabled: boolean) => {
    setItems((cur) => cur?.map((i) => (i.key === item.key ? { ...i, enabled } : i)) ?? null);
    try {
      await api.setContentEnabled(instance.id, item.key, enabled);
    } catch (e) {
      setItems((cur) => cur?.map((i) => (i.key === item.key ? { ...i, enabled: !enabled } : i)) ?? null);
      toast.error("Couldn't change the mod", errorMessage(e));
    }
  };

  const remove = async (item: ContentItem) => {
    try {
      await api.removeContent(instance.id, [item.key]);
      setItems((cur) => cur?.filter((i) => i.key !== item.key) ?? null);
      toast.info(`Removed ${item.title}`, "Restore it from Recently removed.");
    } catch (e) {
      toast.error("Couldn't remove", errorMessage(e));
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const u = await api.checkUpdates(instance.id, "mod");
      setUpdates(u);
      if (u.length === 0) toast.success("Everything is up to date");
    } catch (e) {
      toast.error("Update check failed", errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const updateAll = async (list: UpdateInfo[]) => {
    try {
      const plan = await api.planInstall(
        instance.id,
        list.map((u) => ({ projectId: u.projectId, versionId: u.versionId, projectType: "mod" as const, title: u.title })),
      );
      setDialogs({ plan: { plan, title: `Update ${list.length} mod${list.length === 1 ? "" : "s"}` } });
      setUpdates((cur) => cur?.filter((u) => !list.includes(u)) ?? null);
    } catch (e) {
      toast.error("Couldn't prepare the update", errorMessage(e));
    }
  };

  if (vanilla) {
    return (
      <Empty
        icon={<Boxes />}
        title="Vanilla can't load mods"
        action={<Button onClick={() => navigate("instance", { id: instance.id, tab: "settings" })}>Change mod loader</Button>}
      >
        Switch this instance to Fabric, Quilt, Forge or NeoForge in its settings — or create a new modded instance.
      </Empty>
    );
  }

  return (
    <div className="content-tab">
      <div className="content-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder={`Filter ${items?.length ?? ""} mods`} style={{ width: 260 }} />
        <span className="spacer" />
        {updates && updates.length > 0 ? (
          <Button variant="primary" icon={<RefreshCw />} onClick={() => updateAll(updates)}>
            Update all ({updates.length})
          </Button>
        ) : (
          <Button icon={<RefreshCw />} loading={checking} onClick={checkUpdates} disabled={!items?.length}>
            Check for updates
          </Button>
        )}
        <Button icon={<FilePlus2 />} onClick={async () => {
          const files = await openDialog({ multiple: true, filters: [{ name: "Mods", extensions: ["jar"] }] });
          if (files) importFiles(Array.isArray(files) ? files : [files]);
        }}>
          Add files
        </Button>
        <Button variant="primary" icon={<Compass />} onClick={() => navigate("discover", { type: "mod", target: instance.id })}>
          Browse mods
        </Button>
        <IconButton label="Recently removed" onClick={() => setTrashOpen(true)}>
          <ArchiveRestore />
        </IconButton>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      <AnimatePresence>
        {dropping && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <FilePlus2 />
            Drop .jar files to add them to {instance.name}
          </motion.div>
        )}
      </AnimatePresence>

      {items === null ? (
        <div className="content-list">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="content-row">
              <Skeleton w={40} h={40} r={10} />
              <div className="grow col" style={{ gap: 6 }}>
                <Skeleton w={`${40 + ((i * 17) % 30)}%`} />
                <Skeleton w="22%" h={11} />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty
          icon={<Boxes />}
          title="No mods yet"
          action={
            <Button variant="primary" icon={<Compass />} onClick={() => navigate("discover", { type: "mod", target: instance.id })}>
              Browse Modrinth
            </Button>
          }
        >
          Install mods from Modrinth with their dependencies resolved automatically, or drop .jar files here.
        </Empty>
      ) : (
        <div className="content-list">
          {filtered.map((item) => {
            const update = updateMap.get(item.key);
            return (
              <div key={item.key} className={`content-row ${item.enabled ? "" : "content-row--disabled"}`}>
                <ContentIcon item={item} />
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="content-title truncate">{item.title}</span>
                    {item.source === "local" && <span className="chip">Local file</span>}
                    {update && <span className="chip chip--success">Update: {update.newVersion}</span>}
                  </div>
                  <div className="content-sub truncate">
                    {item.version ?? item.fileName} · {formatBytes(item.size)} · added {relativeTime(item.modified).toLowerCase()}
                  </div>
                </div>
                {update && (
                  <Button size="sm" onClick={() => updateAll([update])}>
                    Update
                  </Button>
                )}
                <Toggle checked={item.enabled} onChange={(v) => toggle(item, v)} label={item.enabled ? "Disable" : "Enable"} />
                <Menu
                  trigger={({ ref, onClick }) => (
                    <IconButton ref={ref} label="More" size="sm" onClick={onClick}>
                      <MoreHorizontal />
                    </IconButton>
                  )}
                  items={[
                    ...(item.projectId
                      ? [{ label: "View on Modrinth", icon: <ExternalLink />, onSelect: () => api.openUrl(`https://modrinth.com/project/${item.projectId}`) }]
                      : []),
                    { label: "Remove", icon: <Trash2 />, danger: true, onSelect: () => remove(item) },
                  ]}
                />
              </div>
            );
          })}
          {filtered.length === 0 && <div className="t-faint" style={{ padding: 20, textAlign: "center" }}>No mods match "{query}".</div>}
        </div>
      )}
      <TrashDialog instance={instance} open={trashOpen} onClose={() => setTrashOpen(false)} onRestored={load} />
    </div>
  );
}

export function ContentIcon({ item }: { item: Pick<ContentItem, "iconUrl" | "localIcon" | "title"> }) {
  const src = item.iconUrl ?? fileSrc(item.localIcon);
  const [failed, setFailed] = useState(false);
  if (src && !failed) return <img className="content-icon" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return <div className="content-icon content-icon--empty">{item.title.slice(0, 1).toUpperCase()}</div>;
}

export function TrashDialog({
  instance,
  open,
  onClose,
  onRestored,
}: {
  instance: InstanceView;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(() => {
    api.listTrash(instance.id).then(setItems).catch(() => setItems([]));
  }, [instance.id]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<ArchiveRestore />}
      title="Recently removed"
      description="Removed mods and packs are kept here until you empty it."
      footer={
        <>
          <Button
            variant="danger"
            disabled={!items?.length}
            onClick={async () => {
              await api.emptyTrash(instance.id);
              load();
            }}
            style={{ marginRight: "auto" }}
          >
            Empty
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {!items?.length ? (
        <div className="t-faint" style={{ padding: "12px 0 18px" }}>
          Nothing here.
        </div>
      ) : (
        <div className="content-list" style={{ margin: 0 }}>
          {items.map((t) => (
            <div key={t.trashName} className="content-row">
              <div className="grow">
                <div className="content-title truncate">{t.title}</div>
                <div className="content-sub">
                  {t.key.split("/")[0]} · removed {relativeTime(t.removedAt).toLowerCase()}
                </div>
              </div>
              <Button
                size="sm"
                icon={<Undo2 />}
                onClick={async () => {
                  try {
                    await api.restoreTrash(instance.id, t.trashName);
                    load();
                    onRestored();
                  } catch (e) {
                    toast.error("Couldn't restore", errorMessage(e));
                  }
                }}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
