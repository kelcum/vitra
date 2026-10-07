import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArrowLeft,
  Boxes,
  FileDown,
  FolderOpen,
  Globe2,
  Image,
  MoreHorizontal,
  ScrollText,
  Settings2,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { PlayButton } from "../../components/PlayButton";
import { Button, IconButton } from "../../components/ui/Button";
import { TextInput, Toggle } from "../../components/ui/Controls";
import { Empty, Tabs } from "../../components/ui/Feedback";
import { ConfirmDialog, Menu, Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { formatDuration, LOADER_LABEL, relativeTime } from "../../lib/format";
import { toast, useInstances, useNav, useSettings } from "../../lib/store";
import type { InstanceView } from "../../lib/types";
import { ModsTab } from "./ContentTab";
import { LogsTab } from "./LogsTab";
import { ResourcePacksTab, ShadersTab } from "./PacksTab";
import { SettingsTab } from "./SettingsTab";
import { WorldsTab } from "./WorldsTab";
import "./instance.css";

type Tab = "mods" | "resourcepacks" | "shaders" | "worlds" | "logs" | "settings";

export default function InstancePage({ id, initialTab }: { id: string; initialTab?: string }) {
  const instance = useInstances((s) => s.instances.find((i) => i.id === id));
  const loaded = useInstances((s) => s.loaded);
  const navigate = useNav((s) => s.navigate);
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? (instance?.loader === "vanilla" ? "worlds" : "mods"));

  useEffect(() => {
    if (initialTab) setTab(initialTab as Tab);
  }, [initialTab]);

  useEffect(() => {
    if (instance) useSettings.getState().update({ selectedInstance: instance.id });
  }, [instance?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!instance) {
    return (
      <div className="page-inner">
        {loaded && (
          <div className="glass" style={{ marginTop: 24 }}>
            <Empty icon={<Boxes />} title="Instance not found" action={<Button onClick={() => navigate("library")}>Back to Library</Button>}>
              It may have been deleted.
            </Empty>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page-inner">
      <Header instance={instance} />
      <div className="glass instance-body">
        <Tabs
          value={tab}
          onChange={setTab}
          style={{ padding: "0 14px" }}
          items={[
            { id: "mods", label: "Mods", icon: <Boxes /> },
            { id: "resourcepacks", label: "Resource packs", icon: <Image /> },
            { id: "shaders", label: "Shaders", icon: <Sparkles /> },
            { id: "worlds", label: "Worlds", icon: <Globe2 /> },
            { id: "logs", label: "Logs", icon: <ScrollText /> },
            { id: "settings", label: "Settings", icon: <Settings2 /> },
          ]}
        />
        <div className="instance-tab">
          {tab === "mods" && <ModsTab instance={instance} />}
          {tab === "resourcepacks" && <ResourcePacksTab instance={instance} />}
          {tab === "shaders" && <ShadersTab instance={instance} />}
          {tab === "worlds" && <WorldsTab instance={instance} />}
          {tab === "logs" && <LogsTab instance={instance} />}
          {tab === "settings" && <SettingsTab instance={instance} />}
        </div>
      </div>
    </div>
  );
}

function Header({ instance }: { instance: InstanceView }) {
  const navigate = useNav((s) => s.navigate);
  const back = useNav((s) => s.back);
  const refresh = useInstances((s) => s.refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);

  return (
    <div className="instance-head">
      <IconButton label="Back" onClick={back} tipPos="bottom">
        <ArrowLeft />
      </IconButton>
      <InstanceIcon icon={instance.icon} size={64} />
      <div className="grow">
        <h1 className="t-title truncate" style={{ margin: 0 }}>
          {instance.name}
        </h1>
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
          <span className="chip">Minecraft {instance.gameVersion}</span>
          <span className={`chip ${instance.loader !== "vanilla" ? "chip--accent" : ""}`}>
            {LOADER_LABEL[instance.loader]} {instance.loaderVersion ?? ""}
          </span>
          {instance.modpack && <span className="chip">{instance.modpack.title}</span>}
          <span className="t-faint" style={{ fontSize: 12, marginLeft: 4 }}>
            {instance.lastPlayed ? `Played ${relativeTime(instance.lastPlayed).toLowerCase()}` : "Never played"}
            {instance.playTimeSecs > 0 && ` · ${formatDuration(instance.playTimeSecs)} total`}
          </span>
        </div>
      </div>
      <PlayButton instance={instance} size="md" />
      <IconButton label="Open game folder" onClick={() => api.openInstanceFolder(instance.id)} tipPos="bottom">
        <FolderOpen />
      </IconButton>
      <Menu
        trigger={({ ref, onClick }) => (
          <IconButton ref={ref} label="More actions" onClick={onClick} tipPos="bottom">
            <MoreHorizontal />
          </IconButton>
        )}
        items={[
          {
            label: "Repair files",
            icon: <Wrench />,
            disabled: instance.running,
            onSelect: () => api.installInstance(instance.id, true).catch((e) => toast.error("Repair failed", errorMessage(e))),
          },
          {
            label: "Back up",
            icon: <Archive />,
            onSelect: () =>
              api
                .backupInstance(instance.id)
                .then((p) => toast.success("Backup saved", p))
                .catch((e) => toast.error("Backup failed", errorMessage(e))),
          },
          { label: "Export as modpack", icon: <FileDown />, onSelect: () => setExporting(true) },
          { label: "Delete", icon: <Trash2 />, danger: true, separatorBefore: true, disabled: instance.running, onSelect: () => setConfirmDelete(true) },
        ]}
      />
      <ConfirmDialog
        open={confirmDelete}
        danger
        icon={<Trash2 />}
        title={`Delete ${instance.name}?`}
        description="This permanently removes the instance, including its worlds, mods and settings."
        confirmLabel="Delete forever"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await api.deleteInstance(instance.id);
            await refresh();
            await useSettings.getState().load();
            navigate("library");
          } catch (e) {
            toast.error("Couldn't delete", errorMessage(e));
          }
        }}
      />
      <ExportDialog instance={instance} open={exporting} onClose={() => setExporting(false)} />
    </div>
  );
}

const EXPORT_PARTS = [
  { id: "mods", label: "Mods", desc: "Modrinth mods are linked; other jars are bundled." },
  { id: "config", label: "Mod configuration", desc: "The config folder." },
  { id: "resourcepacks", label: "Resource packs", desc: "" },
  { id: "shaderpacks", label: "Shader packs", desc: "" },
  { id: "options.txt", label: "Game options", desc: "Video settings, controls and keybinds." },
];

function ExportDialog({ instance, open, onClose }: { instance: InstanceView; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(instance.name);
  const [version, setVersion] = useState("1.0.0");
  const [include, setInclude] = useState<string[]>(["mods", "config", "resourcepacks", "shaderpacks"]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<FileDown />}
      title="Export as Modrinth modpack"
      description="Creates a .mrpack file anyone can import into Vitra, Prism Launcher or the Modrinth App."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const out = await saveDialog({
                defaultPath: `${name.replace(/[<>:"/\\|?*]/g, "_")}-${version}.mrpack`,
                filters: [{ name: "Modrinth modpack", extensions: ["mrpack"] }],
              });
              if (!out) return;
              setBusy(true);
              try {
                await api.exportModpack(instance.id, { name, version, include, outPath: out });
                onClose();
              } catch (e) {
                toast.error("Export failed", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="row">
          <TextInput value={name} onChange={setName} placeholder="Pack name" className="grow" />
          <TextInput value={version} onChange={setVersion} placeholder="1.0.0" style={{ width: 110 }} />
        </div>
        <div className="glass-inset" style={{ padding: "4px 14px" }}>
          {EXPORT_PARTS.map((p) => (
            <label key={p.id} className="field" style={{ padding: "11px 0" }}>
              <div className="field-text">
                <div className="field-label">{p.label}</div>
                {p.desc && <div className="field-desc">{p.desc}</div>}
              </div>
              <Toggle
                checked={include.includes(p.id)}
                onChange={(v) => setInclude((cur) => (v ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
              />
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
