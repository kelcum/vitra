import { motion } from "motion/react";
import { Boxes, Check, Download, ExternalLink, Heart, Image, Package, RefreshCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/Button";
import { SearchInput, Select, Toggle } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton, Tabs } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { useContentVersion } from "../../lib/events";
import { formatCount, LOADER_LABEL, relativeTime } from "../../lib/format";
import { toast, useDialogs, useInstances, useNav, useSelectedInstance, useTasks } from "../../lib/store";
import { useWheelScrollX } from "../../lib/wheel";
import type { InstanceView, MrProjectDetail, MrVersion, ProjectType, SearchHit } from "../../lib/types";
import "../instance/instance.css";
import "./discover.css";

const TYPES: { id: ProjectType; label: string; icon: React.ReactNode }[] = [
  { id: "mod", label: "Mods", icon: <Boxes /> },
  { id: "modpack", label: "Modpacks", icon: <Package /> },
  { id: "resourcepack", label: "Resource packs", icon: <Image /> },
  { id: "shader", label: "Shaders", icon: <Sparkles /> },
];

const SORTS = [
  { value: "relevance", label: "Relevance" },
  { value: "downloads", label: "Most downloaded" },
  { value: "follows", label: "Most followed" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Recently updated" },
];

const PAGE = 24;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Discover({ initialType }: { initialType?: string }) {
  const params = useNav((s) => s.params);
  const instances = useInstances((s) => s.instances);
  const selected = useSelectedInstance();
  const [type, setType] = useState<ProjectType>((initialType as ProjectType) ?? "mod");
  const [targetId, setTargetId] = useState<string | null>(params.target ?? selected?.id ?? null);
  const target = instances.find((i) => i.id === targetId) ?? null;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("relevance");
  const [compatible, setCompatible] = useState(true);
  const [categories, setCategories] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<{ name: string; project_type: string; header: string }[]>([]);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<SearchHit | null>(null);
  const debounced = useDebounced(query, 300);
  const sentinel = useRef<HTMLDivElement>(null);
  const catsRef = useWheelScrollX<HTMLDivElement>();
  const contentVersion = useContentVersion((s) => s.v);
  const requestId = useRef(0);

  useEffect(() => {
    api.categories().then(setAllCategories).catch(() => {});
  }, []);
  useEffect(() => setCategories([]), [type]);

  // Which projects are already in the target instance.
  useEffect(() => {
    if (!target || type === "modpack") return setInstalled(new Set());
    api
      .listContent(target.id, type)
      .then((items) => setInstalled(new Set(items.map((i) => i.projectId).filter(Boolean) as string[])))
      .catch(() => setInstalled(new Set()));
  }, [target?.id, type, contentVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterLoader = type === "mod" && compatible && target ? target.loader : null;
  const filterVersion = compatible && target && type !== "modpack" ? target.gameVersion : null;

  const fetchPage = useCallback(
    async (offset: number) => {
      const id = ++requestId.current;
      try {
        const res = await api.search({
          query: debounced,
          projectType: type,
          loader: filterLoader,
          gameVersion: filterVersion,
          categories,
          sort,
          offset,
          limit: PAGE,
        });
        if (id !== requestId.current) return;
        setError(null);
        setTotal(res.total_hits);
        setHits((cur) => (offset === 0 ? res.hits : [...(cur ?? []), ...res.hits]));
      } catch (e) {
        if (id === requestId.current) setError(errorMessage(e));
      }
    },
    [debounced, type, filterLoader, filterVersion, categories, sort],
  );

  useEffect(() => {
    setHits(null);
    fetchPage(0);
  }, [fetchPage]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || loadingMore || !hits || hits.length >= total) return;
      setLoadingMore(true);
      await fetchPage(hits.length);
      setLoadingMore(false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hits, total, loadingMore, fetchPage]);

  const typeCategories = useMemo(
    () =>
      allCategories
        .filter((c) => c.project_type === type && c.header === "categories")
        .map((c) => c.name)
        .sort(),
    [allCategories, type],
  );

  const instanceOptions = instances.map((i) => ({
    value: i.id,
    label: i.name,
    description: `${i.gameVersion} · ${LOADER_LABEL[i.loader]}`,
    icon: <InstanceIcon icon={i.icon} size={22} radius={6} />,
  }));

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Discover</h1>
          <p>Mods, modpacks, resource packs and shaders from Modrinth.</p>
        </div>
        {type !== "modpack" && instances.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <span className="t-label">Install to</span>
            <Select value={targetId} onChange={setTargetId} options={instanceOptions} width={260} placeholder="Choose an instance" />
          </div>
        )}
      </div>

      <div className="glass discover-bar">
        <Tabs items={TYPES} value={type} onChange={setType} style={{ borderBottom: 0 }} />
        <div className="discover-filters">
          <SearchInput value={query} onChange={setQuery} placeholder={`Search ${TYPES.find((t) => t.id === type)?.label.toLowerCase()}`} size="lg" style={{ flex: 1 }} />
          <Select value={sort} onChange={setSort} options={SORTS} width={190} />
          {target && type !== "modpack" && (
            <label className="row discover-compat">
              <Toggle checked={compatible} onChange={setCompatible} label="Only compatible" />
              <span>
                Only for {type === "mod" ? `${LOADER_LABEL[target.loader]} ` : ""}
                {target.gameVersion}
              </span>
            </label>
          )}
        </div>
        {typeCategories.length > 0 && (
          <div className="discover-cats" ref={catsRef}>
            {typeCategories.map((c) => (
              <button
                key={c}
                className="chip"
                aria-pressed={categories.includes(c)}
                onClick={() => setCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))}
              >
                {c.replace(/-/g, " ")}
              </button>
            ))}
          </div>
        )}
      </div>

      {type === "mod" && target?.loader === "vanilla" && (
        <Notice tone="warning">
          {target.name} is a vanilla instance and can't load mods. Choose a modded instance above, or create one.
        </Notice>
      )}
      {!target && type !== "modpack" && (
        <Notice>Create an instance first — Discover filters results to match its version and mod loader.</Notice>
      )}
      {error && (
        <Notice tone="danger">
          <div className="row">
            <span className="grow">Couldn't reach Modrinth: {error}</span>
            <Button size="sm" icon={<RefreshCw />} onClick={() => fetchPage(0)}>
              Retry
            </Button>
          </div>
        </Notice>
      )}

      {hits === null && !error ? (
        <div className="result-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="result-card glass">
              <div className="row" style={{ gap: 14 }}>
                <Skeleton w={64} h={64} r={14} />
                <div className="grow col" style={{ gap: 8 }}>
                  <Skeleton w="55%" h={16} />
                  <Skeleton w="30%" h={11} />
                </div>
              </div>
              <Skeleton h={12} style={{ marginTop: 14 }} />
              <Skeleton w="70%" h={12} style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>
      ) : hits && hits.length === 0 ? (
        <div className="glass">
          <Empty icon={<Boxes />} title="Nothing found">
            Try a different search{compatible && target ? ", or turn off “Only compatible”" : ""}.
          </Empty>
        </div>
      ) : (
        <div className="result-grid">
          {hits?.map((h, i) => (
            <motion.div
              key={h.project_id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i % PAGE, 12) * 0.025, type: "spring", stiffness: 320, damping: 30 }}
            >
              <ResultCard hit={h} type={type} target={target} installed={installed.has(h.project_id)} onOpen={() => setDetail(h)} />
            </motion.div>
          ))}
        </div>
      )}
      <div ref={sentinel} style={{ height: 1 }} />
      {loadingMore && (
        <div className="row" style={{ justifyContent: "center", padding: 12 }}>
          <span className="spinner" />
        </div>
      )}
      <ProjectDialog hit={detail} type={type} target={target} installed={detail ? installed.has(detail.project_id) : false} onClose={() => setDetail(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ install helpers

async function installProject(
  type: ProjectType,
  projectId: string,
  title: string,
  iconUrl: string | null,
  target: InstanceView | null,
  versionId?: string,
) {
  if (type === "modpack") {
    toast.info(`Installing ${title}`, "A new instance is being created. Progress is shown in Downloads.");
    api
      .installModpack(projectId, versionId ?? null, title, iconUrl)
      // The finished install task says when it's ready.
      .then(() => useInstances.getState().refresh())
      .catch((e) => toast.error(`Couldn't install ${title}`, errorMessage(e)));
    return;
  }
  if (!target) {
    toast.warning("Choose an instance to install into");
    return;
  }
  try {
    const plan = await api.planInstall(target.id, [{ projectId, versionId: versionId ?? null, projectType: type, title }]);
    const clean = plan.conflicts.length === 0 && plan.warnings.length === 0 && plan.skipped.length === 0;
    if (clean && plan.files.length > 0) {
      // Beginner-friendly: nothing to decide, so just install.
      await api.applyPlan(plan);
      const deps = plan.files.length - 1;
      if (deps > 0) toast.info(`Installing ${title}`, `Plus ${deps} required ${deps === 1 ? "dependency" : "dependencies"}.`);
    } else {
      useDialogs.getState().set({ plan: { plan, title: `Install ${title}` } });
    }
  } catch (e) {
    toast.error(`Couldn't install ${title}`, errorMessage(e));
  }
}

function InstallButton({
  hit,
  type,
  target,
  installed,
  size = "sm",
}: {
  hit: SearchHit;
  type: ProjectType;
  target: InstanceView | null;
  installed: boolean;
  size?: "sm" | "md";
}) {
  const [busy, setBusy] = useState(false);
  const tasks = useTasks((s) => s.tasks);
  const working = Object.values(tasks).some((t) => t.state === "running" && t.title.includes(hit.title));
  if (installed && type !== "modpack")
    return (
      <Button size={size} icon={<Check />} disabled>
        Installed
      </Button>
    );
  return (
    <Button
      size={size}
      variant={size === "md" ? "primary" : "default"}
      icon={<Download />}
      loading={busy || working}
      disabled={type !== "modpack" && (!target || (type === "mod" && target.loader === "vanilla"))}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        await installProject(type, hit.project_id, hit.title, hit.icon_url, target);
        setBusy(false);
      }}
    >
      {type === "modpack" ? "Install" : "Add"}
    </Button>
  );
}

function ResultCard({
  hit,
  type,
  target,
  installed,
  onOpen,
}: {
  hit: SearchHit;
  type: ProjectType;
  target: InstanceView | null;
  installed: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="result-card glass" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        {hit.icon_url ? <img className="result-icon" src={hit.icon_url} alt="" loading="lazy" /> : <div className="result-icon result-icon--empty" />}
        <div className="grow">
          <div className="result-title truncate">{hit.title}</div>
          <div className="t-faint truncate" style={{ fontSize: 12 }}>
            by {hit.author}
          </div>
          <div className="result-stats">
            <span>
              <Download /> {formatCount(hit.downloads)}
            </span>
            <span>
              <Heart /> {formatCount(hit.follows)}
            </span>
            <span>Updated {relativeTime(new Date(hit.date_modified).getTime()).toLowerCase()}</span>
          </div>
        </div>
        <InstallButton hit={hit} type={type} target={target} installed={installed} />
      </div>
      <p className="result-desc clamp-2">{hit.description}</p>
      <div className="result-tags">
        {hit.display_categories.slice(0, 4).map((c) => (
          <span key={c} className="chip">
            {c.replace(/-/g, " ")}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ detail

function ProjectDialog({
  hit,
  type,
  target,
  installed,
  onClose,
}: {
  hit: SearchHit | null;
  type: ProjectType;
  target: InstanceView | null;
  installed: boolean;
  onClose: () => void;
}) {
  const [project, setProject] = useState<MrProjectDetail | null>(null);
  const [versions, setVersions] = useState<MrVersion[] | null>(null);
  const [onlyCompatible, setOnlyCompatible] = useState(true);
  const [tab, setTab] = useState<"about" | "versions">("about");

  useEffect(() => {
    setProject(null);
    setVersions(null);
    setTab("about");
    if (!hit) return;
    api.project(hit.project_id).then(setProject).catch((e) => toast.error("Couldn't load the project", errorMessage(e)));
  }, [hit]);

  useEffect(() => {
    if (!hit || tab !== "versions") return;
    setVersions(null);
    const useFilter = onlyCompatible && target && type !== "modpack";
    api
      .projectVersions(hit.project_id, useFilter && type === "mod" ? target!.loader : null, useFilter ? target!.gameVersion : null)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [hit, tab, onlyCompatible, target, type]);

  return (
    <Modal open={!!hit} onClose={onClose} size="xl">
      {hit && (
        <div className="project">
          <div className="project-head">
            {hit.icon_url ? <img className="result-icon" style={{ width: 76, height: 76 }} src={hit.icon_url} alt="" /> : <div className="result-icon result-icon--empty" />}
            <div className="grow">
              <h2 className="t-title" style={{ margin: 0 }}>
                {hit.title}
              </h2>
              <div className="t-muted" style={{ marginTop: 4 }}>
                {hit.description}
              </div>
              <div className="result-stats" style={{ marginTop: 8 }}>
                <span>
                  <Download /> {formatCount(hit.downloads)} downloads
                </span>
                <span>
                  <Heart /> {formatCount(hit.follows)}
                </span>
                {project?.license && <span>{project.license.name || project.license.id}</span>}
              </div>
            </div>
            <div className="col" style={{ alignItems: "flex-end", gap: 8 }}>
              <div className="row">
                <InstallButton hit={hit} type={type} target={target} installed={installed} size="md" />
                <button className="icon-btn" aria-label="Close" onClick={onClose}>
                  <X />
                </button>
              </div>
              <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => api.openUrl(`https://modrinth.com/${hit.project_type}/${hit.slug}`)}>
                modrinth.com
              </Button>
            </div>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "about", label: "About" },
              { id: "versions", label: "Versions" },
            ]}
            style={{ padding: "0 22px" }}
          />

          <div className="project-body">
            {tab === "about" ? (
              !project ? (
                <div className="col" style={{ gap: 10 }}>
                  <Skeleton h={180} r={14} />
                  {[90, 100, 75, 85].map((w, i) => (
                    <Skeleton key={i} w={`${w}%`} />
                  ))}
                </div>
              ) : (
                <>
                  {project.gallery.length > 0 && (
                    <div className="gallery">
                      {[...project.gallery]
                        .sort((a, b) => Number(b.featured) - Number(a.featured))
                        .slice(0, 8)
                        .map((g) => (
                          <img key={g.url} src={g.url} alt={g.title ?? ""} loading="lazy" />
                        ))}
                    </div>
                  )}
                  <Markdown source={project.body} />
                </>
              )
            ) : (
              <>
                {target && type !== "modpack" && (
                  <label className="row" style={{ gap: 10, marginBottom: 12, fontSize: 13 }}>
                    <Toggle checked={onlyCompatible} onChange={setOnlyCompatible} label="Only compatible" />
                    Only versions for {type === "mod" ? LOADER_LABEL[target.loader] + " " : ""}
                    {target.gameVersion}
                  </label>
                )}
                {versions === null ? (
                  <div className="col" style={{ gap: 8 }}>
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} h={52} r={12} />
                    ))}
                  </div>
                ) : versions.length === 0 ? (
                  <Empty icon={<Boxes />} title="No matching versions">
                    This project has no release for this instance's version{type === "mod" ? " and loader" : ""}.
                  </Empty>
                ) : (
                  <div className="content-list" style={{ margin: 0 }}>
                    {versions.slice(0, 60).map((v) => (
                      <div key={v.id} className="content-row">
                        <div className="grow">
                          <div className="row" style={{ gap: 8 }}>
                            <span className="content-title truncate">{v.name || v.version_number}</span>
                            {v.version_type !== "release" && <span className="chip chip--warning">{v.version_type}</span>}
                          </div>
                          <div className="content-sub truncate">
                            {v.loaders.map((l) => l[0].toUpperCase() + l.slice(1)).join(", ")} ·{" "}
                            {v.game_versions.length > 4 ? `${v.game_versions[0]} – ${v.game_versions[v.game_versions.length - 1]}` : v.game_versions.join(", ")}{" "}
                            · {relativeTime(new Date(v.date_published).getTime())}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          disabled={type !== "modpack" && !target}
                          onClick={() => installProject(type, hit.project_id, hit.title, hit.icon_url, target, v.id)}
                        >
                          Install
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
