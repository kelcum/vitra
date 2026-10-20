import { motion } from "motion/react";
import {
  Award,
  ChevronLeft,
  ChevronRight,
  Compass,
  Copy,
  ExternalLink,
  Flag,
  Flame,
  FolderOpen,
  Gem,
  Globe,
  Images,
  MapPin,
  PawPrint,
  Server,
  Settings2,
  Sparkles,
  Star,
  Swords,
  Trash2,
  Trees,
  Trophy,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Controls";
import { Empty, Notice, Skeleton } from "../../components/ui/Feedback";
import { ConfirmDialog, Modal } from "../../components/ui/Overlay";
import { api, errorMessage } from "../../lib/api";
import { useMemoryVersion } from "../../lib/events";
import { cx, fileSrc, LOADER_LABEL } from "../../lib/format";
import { toast, useNav, useSettings } from "../../lib/store";
import type { Memory, MemoryCategory, MemorySpot } from "../../lib/types";
import { useWheelScrollX } from "../../lib/wheel";
import "./memories.css";

const CATEGORY: Record<MemoryCategory, { label: string; icon: ReactNode; color: string }> = {
  treasure: { label: "Treasure", icon: <Gem />, color: "#4fd8e0" },
  nether: { label: "Nether", icon: <Flame />, color: "#ff7a52" },
  end: { label: "The End", icon: <Sparkles />, color: "#c69cff" },
  boss: { label: "Bosses", icon: <Swords />, color: "#ff5d7d" },
  biome: { label: "Biomes", icon: <Trees />, color: "#b4e05c" },
  mob: { label: "Creatures", icon: <PawPrint />, color: "#ff94c8" },
  milestone: { label: "Milestones", icon: <Flag />, color: "#ffcf5a" },
  adventure: { label: "Adventure", icon: <Compass />, color: "#73d98f" },
  challenge: { label: "Challenges", icon: <Trophy />, color: "#ffa94d" },
  advancement: { label: "Advancements", icon: <Award />, color: "#a3aec2" },
};
const ORDER = Object.keys(CATEGORY) as MemoryCategory[];

type Filter = "all" | "favorites" | MemoryCategory;

const catStyle = (c: MemoryCategory) => ({ "--cat": CATEGORY[c].color }) as CSSProperties;

function place(m: Memory) {
  return m.world ?? m.server ?? null;
}

const DIMENSIONS: Record<string, string> = {
  "minecraft:overworld": "Overworld",
  "minecraft:the_nether": "The Nether",
  "minecraft:the_end": "The End",
};

function region(s: MemorySpot) {
  const dimension = DIMENSIONS[s.dimension] ?? s.dimension;
  const biome = s.biomeName ?? s.biome;
  return biome ? `${biome}, ${dimension}` : dimension;
}

const SUBJECT: Partial<Record<MemoryCategory, string>> = { biome: "Biome", mob: "Creature" };

function dayLabel(at: number) {
  const d = new Date(at);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function Memories() {
  const version = useMemoryVersion((s) => s.v);
  const enabled = useSettings((s) => s.settings?.memories ?? true);
  const update = useSettings((s) => s.update);
  const navigate = useNav((s) => s.navigate);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const chipsRef = useWheelScrollX<HTMLDivElement>();

  useEffect(() => {
    let live = true;
    api
      .listMemories()
      .then((m) => live && setMemories(m))
      .catch((e) => {
        if (live) setMemories([]);
        toast.error("Couldn't load your memories", errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [version]);

  const all = memories ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: all.length, favorites: 0 };
    for (const m of all) {
      c[m.category] = (c[m.category] ?? 0) + 1;
      if (m.favorite) c.favorites = (c.favorites ?? 0) + 1;
    }
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((m) => {
      if (filter === "favorites" ? !m.favorite : filter !== "all" && m.category !== filter) return false;
      if (!q) return true;
      return [m.title, m.description, m.advancement, m.world, m.server, m.instanceName, CATEGORY[m.category].label, m.spot?.biomeName]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [all, filter, query]);

  const days = useMemo(() => {
    const out: { label: string; items: Memory[] }[] = [];
    for (const m of shown) {
      const label = dayLabel(m.at);
      if (out[out.length - 1]?.label === label) out[out.length - 1].items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [shown]);

  const openIndex = shown.findIndex((m) => m.id === openId);
  const open = openIndex >= 0 ? shown[openIndex] : null;

  const replace = (m: Memory) => setMemories((cur) => cur?.map((x) => (x.id === m.id ? m : x)) ?? cur);
  const toggleFavorite = async (m: Memory) => {
    try {
      replace(await api.setMemoryFavorite(m.id, !m.favorite));
    } catch (e) {
      toast.error("Couldn't update the memory", errorMessage(e));
    }
  };

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Memories</h1>
          <p>
            {memories && all.length > 0
              ? `${all.length} moment${all.length === 1 ? "" : "s"} · kept automatically while you play`
              : "Your big moments, kept automatically while you play"}
          </p>
        </div>
        {all.length > 0 && <SearchInput value={query} onChange={setQuery} placeholder="Search memories" style={{ width: 240 }} />}
        <IconButton label="Memory settings" onClick={() => navigate("settings", { section: "launcher" })}>
          <Settings2 />
        </IconButton>
      </div>

      {!enabled && (
        <Notice tone="warning" style={{ margin: "6px 8px 14px" }}>
          Memories are off, so new moments aren't kept.{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              update({ memories: true });
            }}
          >
            Turn them on
          </a>
        </Notice>
      )}

      {memories === null ? (
        <div className="memory-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="memory-card glass">
              <Skeleton h="auto" r={0} style={{ aspectRatio: "16 / 9" }} />
              <div className="memory-body">
                <Skeleton w="60%" h={16} />
                <Skeleton w="85%" h={12} />
              </div>
            </div>
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="glass">
          <Empty icon={<Images />} title="No memories yet">
            Play, and Vitra keeps a picture of your big moments: your first diamonds, the first trip to the Nether,
            beating the Ender Dragon. It works with every Minecraft version and modpack, and nothing runs inside the game.
          </Empty>
        </div>
      ) : (
        <>
          <div className="memory-filters" ref={chipsRef}>
            {(["all", "favorites", ...ORDER] as Filter[])
              .filter((f) => f === "all" || (counts[f] ?? 0) > 0)
              .map((f) => (
                <button
                  key={f}
                  className="chip memory-filter"
                  aria-pressed={filter === f}
                  style={f !== "all" && f !== "favorites" ? catStyle(f) : undefined}
                  onClick={() => setFilter(f)}
                >
                  {f === "favorites" ? <Star /> : f !== "all" ? CATEGORY[f].icon : null}
                  {f === "all" ? "All" : f === "favorites" ? "Favorites" : CATEGORY[f].label}
                  <span className="memory-filter-count">{counts[f]}</span>
                </button>
              ))}
          </div>

          {shown.length === 0 ? (
            <div className="glass">
              <Empty icon={<Images />} title="Nothing matches">
                Try another search or filter.
              </Empty>
            </div>
          ) : (
            days.map((day) => (
              <section key={day.label} className="memory-day">
                <h2 className="memory-day-label">{day.label}</h2>
                <motion.div className="memory-grid" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.03 } } }}>
                  {day.items.map((m) => (
                    <motion.div
                      key={m.id}
                      layout
                      variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
                      transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    >
                      <MemoryCard memory={m} onOpen={() => setOpenId(m.id)} onFavorite={() => toggleFavorite(m)} />
                    </motion.div>
                  ))}
                </motion.div>
              </section>
            ))
          )}
        </>
      )}

      <MemoryViewer
        memory={open}
        onClose={() => setOpenId(null)}
        onPrev={openIndex > 0 ? () => setOpenId(shown[openIndex - 1].id) : undefined}
        onNext={openIndex >= 0 && openIndex < shown.length - 1 ? () => setOpenId(shown[openIndex + 1].id) : undefined}
        onFavorite={toggleFavorite}
        onDelete={(m) => setDeleting(m)}
      />
      <ConfirmDialog
        open={!!deleting}
        danger
        icon={<Trash2 />}
        title="Delete this memory?"
        description={`"${deleting?.title}" and its picture will be gone for good.`}
        confirmLabel="Delete"
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await api.deleteMemory(deleting.id);
            if (openId === deleting.id) setOpenId(null);
            setMemories((cur) => cur?.filter((m) => m.id !== deleting.id) ?? cur);
            setDeleting(null);
          } catch (e) {
            toast.error("Couldn't delete the memory", errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function Shot({ memory, full }: { memory: Memory; full?: boolean }) {
  const src = full ? (memory.image ?? memory.thumb) : (memory.thumb ?? memory.image);
  return src ? (
    <img src={fileSrc(src)} alt="" loading={full ? "eager" : "lazy"} decoding="async" />
  ) : (
    <div className="memory-shot-art">{CATEGORY[memory.category].icon}</div>
  );
}

function MemoryCard({ memory: m, onOpen, onFavorite }: { memory: Memory; onOpen: () => void; onFavorite: () => void }) {
  const where = place(m);
  return (
    <div
      className="memory-card glass"
      style={catStyle(m.category)}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="memory-shot">
        <Shot memory={m} />
        <span className="memory-badge">
          {CATEGORY[m.category].icon}
          {CATEGORY[m.category].label}
        </span>
        <button
          className={cx("memory-fav", m.favorite && "memory-fav--on")}
          aria-label={m.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={m.favorite}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
        >
          <Star />
        </button>
      </div>
      <div className="memory-body">
        <div className="memory-title truncate">{m.title}</div>
        {m.description && <div className="memory-desc">{m.description}</div>}
        <div className="memory-meta">
          {where && (
            <span className="memory-where truncate">
              {m.server ? <Server /> : <Globe />}
              {where}
            </span>
          )}
          <span className="memory-inst truncate">{m.instanceName}</span>
          <span className="spacer" />
          <span className="memory-time">{timeOf(m.at)}</span>
        </div>
      </div>
    </div>
  );
}

function Location({ spot }: { spot: MemorySpot }) {
  const coords = `${spot.x} ${spot.y} ${spot.z}`;
  return (
    <div className="memory-location">
      <dt>
        <MapPin /> Location
      </dt>
      <dd className="truncate">{region(spot)}</dd>
      <button
        className="memory-coords"
        data-tip="Copy coordinates"
        onClick={() =>
          navigator.clipboard
            .writeText(coords)
            .then(() => toast.success("Coordinates copied", coords))
            .catch(() => toast.error("Couldn't copy the coordinates"))
        }
      >
        {coords}
        <Copy />
      </button>
    </div>
  );
}

function MemoryViewer({
  memory: m,
  onClose,
  onPrev,
  onNext,
  onFavorite,
  onDelete,
}: {
  memory: Memory | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onFavorite: (m: Memory) => void;
  onDelete: (m: Memory) => void;
}) {
  useEffect(() => {
    if (!m) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") onPrev?.();
      if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [m, onPrev, onNext]);

  const [last, setLast] = useState(m);
  useEffect(() => {
    if (m) setLast(m);
  }, [m]);
  const shown = m ?? last;
  return (
    <Modal
      open={!!m}
      onClose={onClose}
      size="xl"
      icon={shown ? <span style={{ color: CATEGORY[shown.category].color, display: "contents" }}>{CATEGORY[shown.category].icon}</span> : undefined}
      title={shown?.title}
      description={shown?.description || undefined}
      footer={
        shown && (
          <>
            <Button icon={<Star className={cx(shown.favorite && "memory-star-on")} />} onClick={() => onFavorite(shown)}>
              {shown.favorite ? "Favorite" : "Add to favorites"}
            </Button>
            {shown.image && (
              <Button icon={<ExternalLink />} onClick={() => api.openPath(shown.image!).catch((e) => toast.error("Couldn't open the picture", errorMessage(e)))}>
                Open picture
              </Button>
            )}
            <Button icon={<FolderOpen />} onClick={() => api.revealMemory(shown.id).catch((e) => toast.error("Couldn't show the file", errorMessage(e)))}>
              Show in folder
            </Button>
            <span className="spacer" />
            <Button variant="danger" icon={<Trash2 />} onClick={() => onDelete(shown)}>
              Delete
            </Button>
          </>
        )
      }
    >
      {shown && (
        <div className="memory-view" style={catStyle(shown.category)}>
          <div className="memory-view-shot">
            <Shot memory={shown} full />
            {onPrev && (
              <IconButton label="Previous" className="memory-nav memory-nav--prev" onClick={onPrev}>
                <ChevronLeft />
              </IconButton>
            )}
            {onNext && (
              <IconButton label="Next" className="memory-nav memory-nav--next" onClick={onNext}>
                <ChevronRight />
              </IconButton>
            )}
          </div>
          <dl className="memory-facts">
            <div>
              <dt>When</dt>
              <dd>{new Date(shown.at).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</dd>
            </div>
            <div>
              <dt>{shown.server ? "Server" : "World"}</dt>
              <dd className="truncate">{place(shown) ?? "Unknown"}</dd>
            </div>
            {shown.spot && <Location spot={shown.spot} />}
            <div>
              <dt>Instance</dt>
              <dd className="truncate">
                {shown.instanceName} · {shown.gameVersion} {LOADER_LABEL[shown.loader] ?? shown.loader}
              </dd>
            </div>
            <div>
              <dt>{SUBJECT[shown.category] ?? "Advancement"}</dt>
              <dd className="truncate">{shown.advancement}</dd>
            </div>
          </dl>
        </div>
      )}
    </Modal>
  );
}
