import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion } from "motion/react";
import { Archive, ChevronDown, Copy, FolderOpen, HardDriveDownload, LayoutGrid, MoreHorizontal, PackageOpen, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { PlayButton } from "../../components/PlayButton";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput, TextInput } from "../../components/ui/Controls";
import { Empty } from "../../components/ui/Feedback";
import { ConfirmDialog, Menu, Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { formatDuration, LOADER_LABEL, relativeTime } from "../../lib/format";
import { toast, useDialogs, useInstances, useNav, useSettings } from "../../lib/store";
import type { InstanceView } from "../../lib/types";
import { ImportLauncherDialog } from "./ImportLauncherDialog";
import "./library.css";

export default function Library() {
  const instances = useInstances((s) => s.instances);
  const refresh = useInstances((s) => s.refresh);
  const setDialogs = useDialogs((s) => s.set);
  const navigate = useNav((s) => s.navigate);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<InstanceView | null>(null);
  const [duplicating, setDuplicating] = useState<InstanceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? instances.filter((i) => `${i.name} ${i.gameVersion} ${i.loader} ${i.modpack?.title ?? ""}`.toLowerCase().includes(q))
      : instances;
  }, [instances, query]);

  const importPack = async () => {
    const file = await openDialog({ filters: [{ name: "Modrinth modpack", extensions: ["mrpack", "zip"] }] });
    if (!file) return;
    try {
      const inst = await api.importModpackFile(file as string);
      await refresh();
      navigate("instance", { id: inst.id });
    } catch (e) {
      toast.error("Couldn't import the modpack", errorMessage(e));
    }
  };

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Library</h1>
          <p>
            {instances.length} instance{instances.length === 1 ? "" : "s"} · each with its own mods, settings and worlds
          </p>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Filter instances" style={{ width: 240 }} />
        <Menu
          trigger={({ ref, onClick }) => (
            <Button ref={ref} icon={<PackageOpen />} iconRight={<ChevronDown />} onClick={onClick}>
              Import
            </Button>
          )}
          items={[
            { label: "From another launcher", icon: <HardDriveDownload />, onSelect: () => setImporting(true) },
            { label: "Modrinth modpack file", icon: <PackageOpen />, onSelect: importPack },
          ]}
        />
        <Button variant="primary" icon={<Plus />} onClick={() => setDialogs({ createInstance: true })}>
          New instance
        </Button>
      </div>

      {instances.length === 0 ? (
        <div className="glass">
          <Empty
            icon={<LayoutGrid />}
            title="No instances yet"
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => setDialogs({ createInstance: true })}>
                Create your first instance
              </Button>
            }
          >
            Create one for any Minecraft version, with or without mods, or install a modpack from Discover.
          </Empty>
        </div>
      ) : (
        <motion.div className="instance-grid" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.035 } } }}>
          {filtered.map((inst) => (
            <motion.div
              key={inst.id}
              layout
              variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
            >
              <InstanceCard
                instance={inst}
                onDelete={() => setDeleting(inst)}
                onDuplicate={() => setDuplicating(inst)}
              />
            </motion.div>
          ))}
          <button className="instance-card instance-card--new" onClick={() => setDialogs({ createInstance: true })}>
            <Plus />
            New instance
          </button>
        </motion.div>
      )}

      <ConfirmDialog
        open={!!deleting}
        danger
        icon={<Trash2 />}
        title={`Delete ${deleting?.name}?`}
        description="This permanently removes the instance, including its worlds, mods and settings. Back it up first if you might want it later."
        confirmLabel="Delete forever"
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await api.deleteInstance(deleting.id);
            await refresh();
            await useSettings.getState().load();
            toast.info(`${deleting.name} was deleted`);
            setDeleting(null);
          } catch (e) {
            toast.error("Couldn't delete the instance", errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
      <DuplicateDialog instance={duplicating} onClose={() => setDuplicating(null)} />
      <ImportLauncherDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

function DuplicateDialog({ instance, onClose }: { instance: InstanceView | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useInstances((s) => s.refresh);
  const shown = instance ? name || `${instance.name} (copy)` : "";
  return (
    <Modal
      open={!!instance}
      onClose={() => (setName(""), onClose())}
      icon={<Copy />}
      title="Duplicate instance"
      description="Copies everything — mods, config, resource packs and worlds. The original isn't touched."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!instance) return;
              setBusy(true);
              try {
                await api.duplicateInstance(instance.id, shown);
                await refresh();
                setName("");
                onClose();
              } catch (e) {
                toast.error("Couldn't duplicate", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Duplicate
          </Button>
        </>
      }
    >
      <TextInput value={shown} onChange={setName} placeholder="Name" />
    </Modal>
  );
}

function InstanceCard({
  instance,
  onDelete,
  onDuplicate,
}: {
  instance: InstanceView;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const navigate = useNav((s) => s.navigate);
  const update = useSettings((s) => s.update);
  const selected = useSettings((s) => s.settings?.selectedInstance === instance.id);

  return (
    <div className={`instance-card glass ${selected ? "instance-card--selected" : ""}`}>
      <button
        className="instance-card-main"
        onClick={() => {
          update({ selectedInstance: instance.id });
          navigate("instance", { id: instance.id });
        }}
      >
        <div className="instance-card-top">
          <InstanceIcon icon={instance.icon} size={52} />
          {instance.running && <span className="chip chip--success">Running</span>}
        </div>
        <div className="instance-card-name truncate">{instance.name}</div>
        <div className="instance-card-meta truncate">
          {instance.gameVersion} · {LOADER_LABEL[instance.loader]}
          {instance.modpack ? ` · ${instance.modpack.title}` : ""}
        </div>
        <div className="instance-card-stats">
          <span>{instance.lastPlayed ? relativeTime(instance.lastPlayed) : instance.installedVersion ? "Never played" : "Not installed"}</span>
          {instance.playTimeSecs > 0 && <span>{formatDuration(instance.playTimeSecs)}</span>}
        </div>
      </button>
      <div className="instance-card-actions">
        <PlayButton instance={instance} size="sm" />
        <span className="spacer" />
        <IconButton label="Open folder" size="sm" onClick={() => api.openInstanceFolder(instance.id)}>
          <FolderOpen />
        </IconButton>
        <Menu
          trigger={({ ref, onClick }) => (
            <IconButton ref={ref} label="More" size="sm" onClick={onClick}>
              <MoreHorizontal />
            </IconButton>
          )}
          items={[
            { label: "Duplicate", icon: <Copy />, onSelect: onDuplicate },
            {
              label: "Back up",
              icon: <Archive />,
              onSelect: () =>
                api
                  .backupInstance(instance.id)
                  .then((p) => toast.success("Backup saved", p))
                  .catch((e) => toast.error("Backup failed", errorMessage(e))),
            },
            { label: "Delete", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: onDelete, disabled: instance.running },
          ]}
        />
      </div>
    </div>
  );
}
