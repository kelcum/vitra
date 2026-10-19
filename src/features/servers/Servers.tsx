import { AnimatePresence, motion } from "motion/react";
import { Copy, Eye, EyeOff, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Server, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Select, TextInput } from "../../components/ui/Controls";
import { Notice, Skeleton } from "../../components/ui/Feedback";
import { ConfirmDialog, Menu, Modal, type MenuItem } from "../../components/ui/Overlay";
import { InstanceIcon } from "../../components/art/PixelIcon";
import { api, errorMessage } from "../../lib/api";
import { cx, LOADER_LABEL } from "../../lib/format";
import { play } from "../../lib/launch";
import { toast, useInstances, useSelectedInstance } from "../../lib/store";
import type { ServerEntry, ServerStatus } from "../../lib/types";
import { Motd, plainText } from "./Motd";
import "./servers.css";

type Ping = { status: ServerStatus | null; error: string | null; at: number };
const PING_TTL = 60_000;
const pingCache = new Map<string, Ping>();

function usePings(addresses: string[]) {
  const [, setTick] = useState(0);
  const run = useCallback(async (addrs: string[], force = false) => {
    const todo = addrs.filter((a) => force || !pingCache.has(a) || Date.now() - pingCache.get(a)!.at > PING_TTL);
    if (force) todo.forEach((a) => pingCache.delete(a));
    setTick((t) => t + 1);
    await Promise.all(
      todo.map(async (a) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            pingCache.set(a, { status: await api.pingServer(a), error: null, at: Date.now() });
            break;
          } catch (e) {
            if (attempt === 1) pingCache.set(a, { status: null, error: errorMessage(e), at: Date.now() });
            else await new Promise((r) => setTimeout(r, 1200));
          }
        }
        setTick((t) => t + 1);
      }),
    );
  }, []);
  const key = addresses.join("|");
  useEffect(() => {
    run(addresses);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { get: (a: string) => pingCache.get(a), refresh: () => run(addresses, true) };
}

const formatPlayers = (s: ServerStatus) => s.playersOnline.toLocaleString();

function PingBars({ ms }: { ms: number }) {
  const level = ms < 80 ? 4 : ms < 150 ? 3 : ms < 300 ? 2 : 1;
  return (
    <span className={`ping ping--${level}`} data-tip={`${ms} ms`} aria-label={`${ms} ms ping`}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= level ? "on" : ""} />
      ))}
    </span>
  );
}

function Favicon({ ping, name, size }: { ping?: Ping; name: string; size: number }) {
  if (ping?.status?.favicon) return <img className="server-favicon" src={ping.status.favicon} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="server-favicon server-favicon--empty" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function Servers() {
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [category, setCategory] = useState("All");
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<ServerEntry | "new" | null>(null);
  const [removing, setRemoving] = useState<ServerEntry | null>(null);
  const instances = useInstances((s) => s.instances);
  const selected = useSelectedInstance();
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const playWith = instanceId ?? selected?.id ?? instances[0]?.id ?? null;

  const load = useCallback(() => api.listServers().then(setServers).catch((e) => toast.error("Couldn't load servers", errorMessage(e))), []);
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => (servers ?? []).filter((s) => !s.hidden), [servers]);
  const hidden = useMemo(() => (servers ?? []).filter((s) => s.hidden), [servers]);
  const pings = usePings(visible.map((s) => s.address));

  const categories = useMemo(() => {
    const set = new Set(visible.filter((s) => s.featured).map((s) => s.category!));
    return ["All", ...(visible.some((s) => !s.featured) ? ["Yours"] : []), ...set];
  }, [visible]);
  useEffect(() => {
    if (!categories.includes(category)) setCategory("All");
  }, [categories, category]);

  const hero = useMemo(() => {
    const featured = visible.filter((s) => s.featured);
    if (featured.some((s) => !pings.get(s.address))) return featured[0] ?? null;
    return featured.reduce<ServerEntry | null>((best, s) => {
      const n = pings.get(s.address)?.status?.playersOnline ?? -1;
      const b = best ? (pings.get(best.address)?.status?.playersOnline ?? -1) : -2;
      return n > b ? s : best;
    }, null);
  }, [visible, pings]);

  const filtered = visible.filter((s) => (category === "All" ? true : category === "Yours" ? !s.featured : s.category === category));
  const yours = filtered.filter((s) => !s.featured);
  const featured = filtered.filter((s) => s.featured && (category !== "All" || s.id !== hero?.id));

  const join = (s: ServerEntry) => {
    if (!playWith) {
      toast.info("Create an instance first", "Servers launch through one of your instances.");
      return;
    }
    const inst = instances.find((i) => i.id === playWith);
    toast.info(`Joining ${s.name}`, inst ? `Starting ${inst.name}…` : undefined);
    play(playWith, { server: s.address });
  };

  const setHidden = async (s: ServerEntry, value: boolean) => {
    try {
      await api.setServerHidden(s.id, value);
      await load();
      if (value) toast.info(`${s.name} hidden`, "Show hidden servers at the bottom of the page.");
    } catch (e) {
      toast.error("Couldn't update", errorMessage(e));
    }
  };

  const actions = (s: ServerEntry): MenuItem[] => [
    {
      label: "Copy address",
      icon: <Copy />,
      onSelect: () => navigator.clipboard.writeText(s.address).then(() => toast.success("Address copied", s.address)),
    },
    ...(!s.featured ? [{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(s) }] : []),
    s.hidden
      ? { label: "Show again", icon: <Eye />, onSelect: () => setHidden(s, false) }
      : { label: "Hide", icon: <EyeOff />, onSelect: () => setHidden(s, true) },
    ...(!s.featured ? [{ label: "Remove", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => setRemoving(s) }] : []),
  ];

  return (
    <div className="page-inner servers">
      <div className="page-head">
        <div className="grow">
          <h1 className="t-title">Servers</h1>
          <p>Jump straight into the biggest servers, or keep your own here.</p>
        </div>
        {instances.length > 0 && (
          <div className="servers-playwith">
            <span className="t-label">Play with</span>
            <Select
              value={playWith}
              onChange={setInstanceId}
              width={220}
              options={instances.map((i) => ({
                value: i.id,
                label: i.name,
                description: `${i.gameVersion} · ${LOADER_LABEL[i.loader]}`,
              }))}
              renderValue={(o) => (
                <span className="row" style={{ gap: 8 }}>
                  <InstanceIcon icon={instances.find((i) => i.id === o.value)?.icon ?? "grass"} size={20} />
                  <span className="truncate">{o.label}</span>
                </span>
              )}
            />
          </div>
        )}
        <IconButton label="Refresh status" tipPos="bottom" onClick={pings.refresh}>
          <RefreshCw />
        </IconButton>
        <Button icon={<Plus />} onClick={() => setEditing("new")}>
          Add server
        </Button>
      </div>

      {servers === null ? (
        <Skeleton h={190} r={28} />
      ) : (
        <>
          {category === "All" && hero && <Hero server={hero} ping={pings.get(hero.address)} onJoin={() => join(hero)} actions={actions(hero)} />}

          <div className="filter-chips" role="tablist">
            {categories.map((c) => (
              <button key={c} role="tab" aria-selected={c === category} className="filter-chip" onClick={() => setCategory(c)}>
                {c === category && <motion.span layoutId="filter-chip" className="filter-chip-bg" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                {c}
              </button>
            ))}
          </div>

          {yours.length > 0 && (
            <section className="col" style={{ gap: 12 }}>
              <h2 className="servers-section">Your servers</h2>
              <Grid servers={yours} pings={pings} onJoin={join} actions={actions} />
            </section>
          )}
          {featured.length > 0 && (
            <section className="col" style={{ gap: 12 }}>
              {yours.length > 0 && <h2 className="servers-section">Popular</h2>}
              <Grid servers={featured} pings={pings} onJoin={join} actions={actions} />
            </section>
          )}
          {category === "Yours" && yours.length === 0 && (
            <Notice>Add a server with the button above and it shows up here.</Notice>
          )}

          {hidden.length > 0 && (
            <div className="servers-hidden">
              <button className="servers-hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeOff /> : <Eye />}
                {showHidden ? "Hide" : "Show"} {hidden.length} hidden server{hidden.length === 1 ? "" : "s"}
              </button>
              <AnimatePresence initial={false}>
                {showHidden && (
                  <motion.div
                    className="servers-hidden-list"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 34 }}
                  >
                    {hidden.map((s) => (
                      <div key={s.id} className="hidden-row glass-inset">
                        <Server />
                        <span className="grow truncate">
                          <b>{s.name}</b> <span className="t-faint">{s.address}</span>
                        </span>
                        <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => setHidden(s, false)}>
                          Show again
                        </Button>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </>
      )}

      <ServerDialog
        server={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        danger
        icon={<Trash2 />}
        title={`Remove ${removing?.name}?`}
        description="It's only removed from Vitra. Your worlds and the server itself aren't affected."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api.removeServer(removing.id);
            await load();
            setRemoving(null);
          } catch (e) {
            toast.error("Couldn't remove", errorMessage(e));
          }
        }}
      />
    </div>
  );
}

function Hero({ server, ping, onJoin, actions }: { server: ServerEntry; ping?: Ping; onJoin: () => void; actions: MenuItem[] }) {
  const s = ping?.status;
  return (
    <motion.div className="servers-hero glass" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 30 }}>
      {s?.favicon && <img className="servers-hero-wash" src={s.favicon} alt="" />}
      <div className="servers-hero-main">
        <Favicon ping={ping} name={server.name} size={104} />
        <div className="grow col" style={{ gap: 6 }}>
          <span className="chip chip--accent servers-hero-tag">Most played right now</span>
          <h2 className="servers-hero-name">{server.name}</h2>
          <div className="servers-hero-address selectable">{server.address}</div>
          {s ? <Motd value={s.motd} className="motd motd--hero" /> : <p className="t-muted" style={{ margin: 0 }}>{server.description}</p>}
        </div>
        <div className="servers-hero-side">
          {s ? (
            <>
              <div className="servers-hero-count t-num">{formatPlayers(s)}</div>
              <div className="servers-hero-count-label">
                <span className="live-dot" /> playing now
              </div>
            </>
          ) : ping?.error ? (
            <div className="t-faint">Offline</div>
          ) : (
            <Skeleton w={140} h={40} r={12} />
          )}
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <Menu
              trigger={({ ref, onClick }) => (
                <IconButton ref={ref} label="More" onClick={onClick}>
                  <MoreHorizontal />
                </IconButton>
              )}
              items={actions}
            />
            <Button variant="primary" size="lg" icon={<Play />} onClick={onJoin}>
              Play
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function Grid({
  servers,
  pings,
  onJoin,
  actions,
}: {
  servers: ServerEntry[];
  pings: { get: (a: string) => Ping | undefined };
  onJoin: (s: ServerEntry) => void;
  actions: (s: ServerEntry) => MenuItem[];
}) {
  return (
    <motion.div className="server-grid" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.03 } } }}>
      {servers.map((s) => (
        <motion.div key={s.id} layout variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
          <ServerCard server={s} ping={pings.get(s.address)} onJoin={() => onJoin(s)} actions={actions(s)} />
        </motion.div>
      ))}
    </motion.div>
  );
}

function ServerCard({ server, ping, onJoin, actions }: { server: ServerEntry; ping?: Ping; onJoin: () => void; actions: MenuItem[] }) {
  const s = ping?.status;
  const offline = !!ping?.error;
  return (
    <div className={cx("server-card glass", offline && "server-card--offline")}>
      <div className="server-card-head">
        <Favicon ping={ping} name={server.name} size={52} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="server-name truncate">{server.name}</div>
          <div className="server-address truncate">{server.address}</div>
        </div>
        {s ? (
          <span className="players-pill t-num" data-tip={s.playersMax > s.playersOnline ? `${s.playersOnline.toLocaleString()} / ${s.playersMax.toLocaleString()}` : undefined}>
            <span className="live-dot" />
            {formatPlayers(s)}
          </span>
        ) : offline ? (
          <span className="chip">Offline</span>
        ) : (
          <Skeleton w={64} h={24} r={12} />
        )}
      </div>
      <div className="server-motd">
        {s ? (
          <Motd value={s.motd} className="motd" />
        ) : offline ? (
          <span className="t-faint" style={{ fontSize: 12.5 }}>{ping?.error}</span>
        ) : (
          <>
            <Skeleton w="80%" h={11} />
            <Skeleton w="55%" h={11} />
          </>
        )}
      </div>
      <div className="server-card-foot">
        {server.category ? <span className="chip">{server.category}</span> : <span className="chip chip--accent">Yours</span>}
        {s && <span className="server-version truncate">{plainText(s.version)}</span>}
        <span className="spacer" />
        {s && <PingBars ms={s.latencyMs} />}
        <Menu
          trigger={({ ref, onClick }) => (
            <IconButton ref={ref} label="More" size="sm" onClick={onClick}>
              <MoreHorizontal />
            </IconButton>
          )}
          items={actions}
        />
        <Button size="sm" icon={<Play />} onClick={onJoin}>
          Play
        </Button>
      </div>
    </div>
  );
}

function ServerDialog({ server, onClose, onSaved }: { server: ServerEntry | "new" | null; onClose: () => void; onSaved: () => void }) {
  const editing = server && server !== "new" ? server : null;
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Ping | null>(null);

  useEffect(() => {
    if (!server) return;
    setName(editing?.name ?? "");
    setAddress(editing?.address ?? "");
    setError(null);
    setPreview(null);
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = address.trim();
    setPreview(null);
    if (!server || a.length < 4 || !a.includes(".")) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .pingServer(a)
        .then((status) => !cancelled && setPreview({ status, error: null, at: Date.now() }))
        .catch((e) => !cancelled && setPreview({ status: null, error: errorMessage(e), at: Date.now() }));
    }, 550);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [address, server]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = name.trim() || address.trim();
      if (editing) await api.editServer(editing.id, n, address);
      else await api.addServer(n, address);
      pingCache.delete(address.trim());
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!server}
      onClose={onClose}
      icon={<Server />}
      title={editing ? "Edit server" : "Add a server"}
      description="Any Java Edition server address works, with or without a port."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!address.trim()} onClick={save}>
            {editing ? "Save" : "Add server"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="col">
          <span className="t-label">Address</span>
          <TextInput value={address} onChange={setAddress} placeholder="play.example.com" icon={<Server />} autoFocus onKeyDown={(e) => e.key === "Enter" && save()} />
        </div>
        <div className="col">
          <span className="t-label">Name</span>
          <TextInput value={name} onChange={setName} placeholder={address.trim() || "My server"} onKeyDown={(e) => e.key === "Enter" && save()} />
        </div>
        {preview?.status && (
          <div className="server-preview glass-inset">
            <Favicon ping={preview} name={name || address} size={44} />
            <div className="grow" style={{ minWidth: 0 }}>
              <Motd value={preview.status.motd} className="motd motd--left" />
              <div className="t-faint" style={{ fontSize: 12, marginTop: 4 }}>
                <Users style={{ width: 12, height: 12, verticalAlign: -2 }} /> {formatPlayers(preview.status)} online · {plainText(preview.status.version)} · {preview.status.latencyMs} ms
              </div>
            </div>
          </div>
        )}
        {preview?.error && <Notice tone="warning">{preview.error} You can still add it.</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

