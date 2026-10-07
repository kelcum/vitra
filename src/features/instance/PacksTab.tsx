import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Reorder } from "motion/react";
import { ArchiveRestore, Compass, FilePlus2, FolderOpen, GripVertical, Image, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { useContentVersion } from "../../lib/events";
import { fileSrc, formatBytes, LOADER_LABEL } from "../../lib/format";
import { toast, useDialogs, useNav } from "../../lib/store";
import type { InstanceView, ResourcePack, ShaderState } from "../../lib/types";
import { TrashDialog, useFileDrop } from "./ContentTab";

// ------------------------------------------------------------------ resource packs

export function ResourcePacksTab({ instance }: { instance: InstanceView }) {
  const [packs, setPacks] = useState<ResourcePack[] | null>(null);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const contentVersion = useContentVersion((s) => s.v);
  const navigate = useNav((s) => s.navigate);
  const saveTimer = useRef<number>(undefined);

  const load = useCallback(() => {
    api
      .listResourcePacks(instance.id)
      .then((p) => {
        setPacks(p);
        setEnabled(p.filter((x) => x.enabled).map((x) => x.fileName));
      })
      .catch((e) => toast.error("Couldn't read resource packs", errorMessage(e)));
  }, [instance.id]);
  useEffect(load, [load, contentVersion]);

  const persist = (next: string[]) => {
    setEnabled(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.setResourcePacks(instance.id, next).catch((e) => toast.error("Couldn't save pack order", errorMessage(e)));
    }, 350);
  };

  const importFiles = useCallback(
    async (paths: string[]) => {
      const zips = paths.filter((p) => p.toLowerCase().endsWith(".zip"));
      if (!zips.length) return toast.warning("Resource packs are .zip files");
      try {
        await api.importContentFiles(instance.id, "resourcepack", zips);
        load();
      } catch (e) {
        toast.error("Couldn't add the packs", errorMessage(e));
      }
    },
    [instance.id, load],
  );
  const dropping = useFileDrop(importFiles);

  const byName = new Map((packs ?? []).map((p) => [p.fileName, p]));
  const available = (packs ?? []).filter((p) => !enabled.includes(p.fileName));

  return (
    <div className="content-tab">
      <div className="content-toolbar">
        <span className="t-muted" style={{ fontSize: 13 }}>
          Packs higher in the list override the ones below. Drag to reorder.
        </span>
        <span className="spacer" />
        <IconButton label="Open folder" onClick={() => api.openInstanceFolder(instance.id, "resourcepacks")}>
          <FolderOpen />
        </IconButton>
        <Button
          icon={<FilePlus2 />}
          onClick={async () => {
            const f = await openDialog({ multiple: true, filters: [{ name: "Resource packs", extensions: ["zip"] }] });
            if (f) importFiles(Array.isArray(f) ? f : [f]);
          }}
        >
          Add files
        </Button>
        <Button icon={<Compass />} onClick={() => navigate("discover", { type: "resourcepack", target: instance.id })}>
          Browse packs
        </Button>
        <IconButton label="Recently removed" onClick={() => setTrashOpen(true)}>
          <ArchiveRestore />
        </IconButton>
      </div>
      {instance.running && <Notice tone="warning">Close the game to change resource packs. Minecraft saves its own pack list when it closes, so changes made now would be lost.</Notice>}
      {dropping && (
        <div className="drop-overlay">
          <FilePlus2 />
          Drop .zip resource packs here
        </div>
      )}

      {packs === null ? (
        <div className="content-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="content-row">
              <Skeleton w={44} h={44} r={8} />
              <Skeleton w="40%" />
            </div>
          ))}
        </div>
      ) : packs.length === 0 ? (
        <Empty
          icon={<Image />}
          title="No resource packs"
          action={
            <Button variant="primary" icon={<Compass />} onClick={() => navigate("discover", { type: "resourcepack", target: instance.id })}>
              Browse Modrinth
            </Button>
          }
        >
          Resource packs change textures, sounds and fonts. Add some from Modrinth or drop .zip files here.
        </Empty>
      ) : (
        <>
          <div className="t-label" style={{ padding: "6px 4px 0" }}>
            Enabled · {enabled.length}
          </div>
          {enabled.length === 0 ? (
            <div className="t-faint" style={{ padding: "6px 4px 10px", fontSize: 13 }}>
              No packs enabled — the game uses its default look.
            </div>
          ) : (
            <Reorder.Group axis="y" values={enabled} onReorder={persist} className="content-list" as="div">
              {enabled.map((name) => {
                const p = byName.get(name);
                if (!p) return null;
                return (
                  <Reorder.Item key={name} value={name} as="div" className="content-row content-row--drag" whileDrag={{ scale: 1.02, zIndex: 5 }}>
                    <GripVertical className="drag-handle" />
                    <PackRow pack={p} />
                    <Toggle checked onChange={() => persist(enabled.filter((x) => x !== name))} label="Disable" />
                  </Reorder.Item>
                );
              })}
            </Reorder.Group>
          )}
          {available.length > 0 && (
            <>
              <div className="t-label" style={{ padding: "12px 4px 0" }}>
                Available · {available.length}
              </div>
              <div className="content-list">
                {available.map((p) => (
                  <div key={p.fileName} className="content-row">
                    <span style={{ width: 16 }} />
                    <PackRow pack={p} />
                    <IconButton
                      label="Remove"
                      size="sm"
                      onClick={async () => {
                        await api.removeContent(instance.id, [`resourcepacks/${p.fileName}`]);
                        load();
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                    <Toggle checked={false} onChange={() => persist([p.fileName, ...enabled])} label="Enable" />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <TrashDialog instance={instance} open={trashOpen} onClose={() => setTrashOpen(false)} onRestored={load} />
    </div>
  );
}

function PackRow({ pack }: { pack: ResourcePack }) {
  return (
    <>
      {pack.icon ? (
        <img className="content-icon content-icon--pack" src={fileSrc(pack.icon)} alt="" />
      ) : (
        <div className="content-icon content-icon--empty">
          <Image style={{ width: 16 }} />
        </div>
      )}
      <div className="grow">
        <div className="row" style={{ gap: 8 }}>
          <span className="content-title truncate">{pack.title}</span>
          {pack.compatible === false && <span className="chip chip--warning">Made for another version</span>}
        </div>
        <div className="content-sub truncate">{pack.description || formatBytes(pack.size)}</div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ shaders

export function ShadersTab({ instance }: { instance: InstanceView }) {
  const [state, setState] = useState<ShaderState | null>(null);
  const [installing, setInstalling] = useState(false);
  const contentVersion = useContentVersion((s) => s.v);
  const navigate = useNav((s) => s.navigate);
  const setDialogs = useDialogs((s) => s.set);

  const load = useCallback(() => {
    api.shaderState(instance.id).then(setState).catch((e) => toast.error("Couldn't read shaders", errorMessage(e)));
  }, [instance.id]);
  useEffect(load, [load, contentVersion]);

  const importFiles = useCallback(
    async (paths: string[]) => {
      const zips = paths.filter((p) => p.toLowerCase().endsWith(".zip"));
      if (!zips.length) return toast.warning("Shader packs are .zip files");
      await api.importContentFiles(instance.id, "shader", zips).catch((e) => toast.error("Couldn't add", errorMessage(e)));
      load();
    },
    [instance.id, load],
  );
  const dropping = useFileDrop(importFiles);

  const irisPossible = ["fabric", "quilt", "neoforge"].includes(instance.loader);

  const installIris = async () => {
    setInstalling(true);
    try {
      const plan = await api.planInstall(instance.id, [{ projectId: "iris", projectType: "mod", title: "Iris Shaders" }]);
      setDialogs({ plan: { plan, title: "Install Iris for shaders" } });
    } catch (e) {
      toast.error("Couldn't prepare Iris", errorMessage(e));
    } finally {
      setInstalling(false);
    }
  };

  const select = async (pack: string | null) => {
    try {
      await api.setActiveShader(instance.id, pack);
      load();
    } catch (e) {
      toast.error("Couldn't change the shader", errorMessage(e));
    }
  };

  return (
    <div className="content-tab">
      {state && state.support === "none" && (
        <Notice tone={irisPossible ? "info" : "warning"}>
          {irisPossible ? (
            <div className="row" style={{ alignItems: "center", gap: 12 }}>
              <span className="grow">
                Shader packs need the <b>Iris</b> mod (it brings <b>Sodium</b> along for performance). Vitra won't install
                rendering mods without asking.
              </span>
              <Button size="sm" variant="primary" icon={<Sparkles />} loading={installing} onClick={installIris}>
                Review & install Iris
              </Button>
            </div>
          ) : instance.loader === "vanilla" ? (
            <>Vanilla Minecraft can't load shader packs. Create a Fabric or NeoForge instance to use Iris.</>
          ) : (
            <>Iris isn't available for {LOADER_LABEL[instance.loader]}. Shader packs work best on Fabric or NeoForge with Iris.</>
          )}
        </Notice>
      )}
      <div className="content-toolbar">
        <span className="t-muted" style={{ fontSize: 13 }}>
          {state?.support === "iris" || state?.support === "oculus"
            ? "Pick a shader pack — applied next time the game starts (or press O in-game for Iris settings)."
            : state?.support === "optifine"
              ? "OptiFine detected — choose shaders from its in-game menu."
              : "Shader packs installed for this instance."}
        </span>
        <span className="spacer" />
        <IconButton label="Open folder" onClick={() => api.openInstanceFolder(instance.id, "shaderpacks")}>
          <FolderOpen />
        </IconButton>
        <Button
          icon={<FilePlus2 />}
          onClick={async () => {
            const f = await openDialog({ multiple: true, filters: [{ name: "Shader packs", extensions: ["zip"] }] });
            if (f) importFiles(Array.isArray(f) ? f : [f]);
          }}
        >
          Add files
        </Button>
        <Button icon={<Compass />} onClick={() => navigate("discover", { type: "shader", target: instance.id })}>
          Browse shaders
        </Button>
      </div>
      {dropping && (
        <div className="drop-overlay">
          <FilePlus2 />
          Drop shader .zip files here
        </div>
      )}
      {state === null ? (
        <Skeleton h={56} r={12} />
      ) : state.packs.length === 0 ? (
        <Empty icon={<Sparkles />} title="No shader packs">
          Shader packs add realistic lighting, shadows and water. Find popular ones like Complementary or BSL on Modrinth.
        </Empty>
      ) : (
        <div className="content-list">
          <ShaderChoice title="Off" sub="Standard Minecraft lighting" active={!state.enabled || !state.active} onSelect={() => select(null)} />
          {state.packs.map((p) => (
            <ShaderChoice
              key={p.fileName}
              title={p.title}
              sub={formatBytes(p.size)}
              active={state.enabled && state.active === p.fileName}
              onSelect={() => select(p.fileName)}
              onRemove={async () => {
                await api.removeContent(instance.id, [`shaderpacks/${p.fileName}`]);
                load();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ShaderChoice({
  title,
  sub,
  active,
  onSelect,
  onRemove,
}: {
  title: string;
  sub: string;
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`content-row shader-row ${active ? "shader-row--active" : ""}`} onClick={onSelect} role="radio" aria-checked={active} tabIndex={0}>
      <span className="radio" aria-hidden />
      <div className="grow">
        <div className="content-title truncate">{title}</div>
        <div className="content-sub">{sub}</div>
      </div>
      {onRemove && (
        <IconButton
          label="Remove"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}
