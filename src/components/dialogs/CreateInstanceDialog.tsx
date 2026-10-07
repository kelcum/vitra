import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Boxes, PackageOpen, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { LOADER_LABEL } from "../../lib/format";
import { toast, useDialogs, useInstances, useNav, useSettings } from "../../lib/store";
import type { GameVersion, Loader, LoaderVersion } from "../../lib/types";
import { ICON_KEYS, InstanceIcon } from "../art/PixelIcon";
import { Button } from "../ui/Button";
import { Segmented, Select, TextInput, Toggle } from "../ui/Controls";
import { Notice, Skeleton } from "../ui/Feedback";
import { Modal } from "../ui/Overlay";

const LOADERS: Loader[] = ["vanilla", "fabric", "quilt", "forge", "neoforge"];

export function CreateInstanceDialog() {
  const state = useDialogs((s) => s.createInstance);
  const set = useDialogs((s) => s.set);
  const settings = useSettings((s) => s.settings);
  const refresh = useInstances((s) => s.refresh);
  const navigate = useNav((s) => s.navigate);
  const open = state !== false;
  const preset = typeof state === "object" ? state : {};

  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [supported, setSupported] = useState<Set<string> | null>(null);
  const [loader, setLoader] = useState<Loader>("fabric");
  const [gameVersion, setGameVersion] = useState<string | null>(null);
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[] | null>(null);
  const [loaderVersion, setLoaderVersion] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [icon, setIcon] = useState("grass");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when opened.
  useEffect(() => {
    if (!open) return;
    setLoader((preset.loader as Loader) ?? settings?.defaultLoader ?? "fabric");
    setGameVersion(preset.gameVersion ?? settings?.defaultVersion ?? null);
    setName("");
    setNameTouched(false);
    setIcon(ICON_KEYS[Math.floor(Math.random() * ICON_KEYS.length)]);
    setError(null);
    if (!versions) {
      api
        .listGameVersions()
        .then(setVersions)
        .catch((e) => setError(errorMessage(e)));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Minecraft versions the chosen loader supports.
  useEffect(() => {
    if (!open) return;
    setSupported(null);
    if (loader === "vanilla") return;
    let cancelled = false;
    api
      .listLoaderGameVersions(loader)
      .then((v) => !cancelled && setSupported(new Set(v)))
      .catch(() => !cancelled && setSupported(new Set()));
    return () => {
      cancelled = true;
    };
  }, [loader, open]);

  const options = useMemo(() => {
    if (!versions) return [];
    return versions
      .filter((v) => (snapshots ? v.kind === "release" || v.kind === "snapshot" : v.kind === "release"))
      .filter((v) => loader === "vanilla" || !supported || supported.has(v.id))
      .map((v) => ({
        value: v.id,
        label: v.id,
        description: v.kind === "snapshot" ? "Snapshot" : new Date(v.releaseTime).toLocaleDateString(undefined, { year: "numeric", month: "short" }),
      }));
  }, [versions, snapshots, supported, loader]);

  // Default to the newest available version for this loader.
  useEffect(() => {
    if (options.length && (!gameVersion || !options.some((o) => o.value === gameVersion))) {
      setGameVersion(options[0].value);
    }
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoaderVersions(null);
    setLoaderVersion(null);
    if (!gameVersion || loader === "vanilla") return;
    let cancelled = false;
    api
      .listLoaderVersions(loader, gameVersion)
      .then((list) => {
        if (cancelled) return;
        setLoaderVersions(list);
        setLoaderVersion(list.find((l) => l.recommended)?.version ?? list[0]?.version ?? null);
      })
      .catch(() => !cancelled && setLoaderVersions([]));
    return () => {
      cancelled = true;
    };
  }, [loader, gameVersion]);

  const suggested = gameVersion ? (loader === "vanilla" ? `Minecraft ${gameVersion}` : `${LOADER_LABEL[loader]} ${gameVersion}`) : "";
  const finalName = nameTouched && name.trim() ? name.trim() : suggested;
  const loaderUnavailable = loader !== "vanilla" && loaderVersions !== null && loaderVersions.length === 0;

  const create = async () => {
    if (!gameVersion) return;
    setBusy(true);
    try {
      const inst = await api.createInstance({
        name: finalName,
        gameVersion,
        loader,
        loaderVersion: loader === "vanilla" ? null : loaderVersion,
        icon,
      });
      useSettings.getState().update({ selectedInstance: inst.id });
      await refresh();
      await api.installInstance(inst.id, false);
      set({ createInstance: false });
      navigate("instance", { id: inst.id });
    } catch (e) {
      toast.error("Couldn't create the instance", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const importPack = async () => {
    const file = await openDialog({ filters: [{ name: "Modrinth modpack", extensions: ["mrpack", "zip"] }] });
    if (!file) return;
    set({ createInstance: false });
    try {
      const inst = await api.importModpackFile(file as string);
      await refresh();
      navigate("instance", { id: inst.id });
    } catch (e) {
      toast.error("Couldn't import the modpack", errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => set({ createInstance: false })}
      icon={<Sparkles />}
      title="New instance"
      description="An instance is a separate Minecraft installation with its own mods, settings and worlds."
      size="wide"
      footer={
        <>
          <Button variant="ghost" icon={<PackageOpen />} onClick={importPack} style={{ marginRight: "auto" }}>
            Import .mrpack
          </Button>
          <Button variant="ghost" onClick={() => set({ createInstance: false })}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Boxes />}
            loading={busy}
            disabled={!gameVersion || loaderUnavailable || (loader !== "vanilla" && !loaderVersion)}
            onClick={create}
          >
            Create & install
          </Button>
        </>
      }
    >
      <div className="create-grid">
        <div className="col" style={{ gap: 18 }}>
          <div className="col">
            <span className="t-label">Mod loader</span>
            <Segmented value={loader} onChange={setLoader} options={LOADERS.map((l) => ({ value: l, label: LOADER_LABEL[l] }))} />
            <span className="t-faint" style={{ fontSize: 12.5 }}>
              {loader === "vanilla" && "The unmodified game, exactly as Mojang ships it."}
              {loader === "fabric" && "Lightweight and fast to update. Home of Sodium, Iris and most performance mods."}
              {loader === "quilt" && "A Fabric fork that also runs most Fabric mods."}
              {loader === "forge" && "The classic loader with the largest catalogue of older mods."}
              {loader === "neoforge" && "The modern successor to Forge, used by most new large modpacks."}
            </span>
          </div>

          <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
            <div className="col grow">
              <span className="t-label">Minecraft version</span>
              {versions ? (
                <Select value={gameVersion} options={options} onChange={setGameVersion} searchable placeholder="Choose a version" />
              ) : (
                <Skeleton h={36} r={12} />
              )}
              <label className="row t-faint" style={{ fontSize: 12.5, gap: 8, marginTop: 2 }}>
                <Toggle checked={snapshots} onChange={setSnapshots} label="Show snapshots" /> Show snapshots
              </label>
            </div>
            {loader !== "vanilla" && (
              <div className="col grow">
                <span className="t-label">{LOADER_LABEL[loader]} version</span>
                {loaderVersions === null ? (
                  <Skeleton h={36} r={12} />
                ) : (
                  <Select
                    value={loaderVersion}
                    onChange={setLoaderVersion}
                    searchable={loaderVersions.length > 12}
                    placeholder="Not available"
                    disabled={loaderVersions.length === 0}
                    options={loaderVersions.map((l) => ({
                      value: l.version,
                      label: l.version,
                      badge: l.recommended ? <span className="chip chip--accent">Recommended</span> : !l.stable ? <span className="chip">Beta</span> : undefined,
                    }))}
                  />
                )}
              </div>
            )}
          </div>

          {loaderUnavailable && (
            <Notice tone="warning">
              {LOADER_LABEL[loader]} isn't available for Minecraft {gameVersion} yet. Pick another version or loader.
            </Notice>
          )}
          {error && <Notice tone="danger">Couldn't load the version list: {error}</Notice>}
        </div>

        <div className="col create-side">
          <span className="t-label">Name & icon</span>
          <div className="create-preview glass-inset">
            <InstanceIcon icon={icon} size={64} />
            <div className="grow">
              <TextInput
                value={nameTouched ? name : suggested}
                onChange={(v) => {
                  setName(v);
                  setNameTouched(true);
                }}
                placeholder="Instance name"
              />
            </div>
          </div>
          <div className="icon-grid">
            {ICON_KEYS.map((k) => (
              <button key={k} className="icon-choice" aria-pressed={icon === k} onClick={() => setIcon(k)} aria-label={k}>
                <InstanceIcon icon={k} size={38} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
