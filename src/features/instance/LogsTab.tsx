import { ArrowDownToLine, Copy, FileWarning, FolderOpen, Radio, ScrollText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput, Segmented } from "../../components/ui/Controls";
import { Empty } from "../../components/ui/Feedback";
import { api, errorMessage } from "../../lib/api";
import { cx, formatBytes, relativeTime } from "../../lib/format";
import { toast, useLogs } from "../../lib/store";
import type { InstanceView, LogFile, LogLine } from "../../lib/types";

type Level = "all" | "warn" | "error";
const EMPTY: LogLine[] = [];

function levelOf(line: string): string {
  if (/\b(ERROR|FATAL)\b|Exception|^\s+at /.test(line)) return "ERROR";
  if (/\bWARN\b/.test(line)) return "WARN";
  return "INFO";
}

export function LogsTab({ instance }: { instance: InstanceView }) {
  const live = useLogs((s) => s.lines[instance.id] ?? EMPTY);
  const [files, setFiles] = useState<LogFile[]>([]);
  const [source, setSource] = useState<"live" | LogFile>("live");
  const [fileText, setFileText] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listLogs(instance.id).then(setFiles).catch(() => setFiles([]));
  }, [instance.id, instance.running]);

  useEffect(() => {
    if (source === "live") return setFileText(null);
    setFileText(null);
    api
      .readLog(instance.id, source.name, source.kind)
      .then(setFileText)
      .catch((e) => toast.error("Couldn't read the log", errorMessage(e)));
  }, [source, instance.id]);

  const lines: { level: string; text: string; thread?: string | null }[] = useMemo(() => {
    if (source === "live") return live.map((l) => ({ level: l.level, text: l.text, thread: l.thread }));
    if (fileText == null) return [];
    return fileText.split(/\r?\n/).slice(-6000).map((t) => ({ level: levelOf(t), text: t }));
  }, [source, live, fileText]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (level === "error" && !(l.level === "ERROR" || l.level === "FATAL")) return false;
      if (level === "warn" && !(l.level === "WARN" || l.level === "ERROR" || l.level === "FATAL")) return false;
      return !q || l.text.toLowerCase().includes(q);
    });
  }, [lines, level, query]);

  useEffect(() => {
    if (follow && viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="logs-tab">
      <aside className="logs-files">
        <button className={cx("logs-file", source === "live" && "logs-file--active")} onClick={() => setSource("live")}>
          <Radio className={instance.running ? "live-on" : ""} />
          <div className="grow">
            <div className="truncate">Live console</div>
            <div className="logs-file-sub">{instance.running ? "Game running" : live.length ? "Last session" : "Starts when you play"}</div>
          </div>
        </button>
        <div className="t-label" style={{ padding: "12px 10px 4px" }}>
          Files
        </div>
        {files.length === 0 && <div className="t-faint" style={{ padding: "4px 10px", fontSize: 12.5 }}>No logs yet.</div>}
        {files.map((f) => (
          <button
            key={`${f.kind}/${f.name}`}
            className={cx("logs-file", source !== "live" && source.name === f.name && "logs-file--active")}
            onClick={() => setSource(f)}
          >
            {f.kind === "crash" ? <FileWarning style={{ color: "var(--danger)" }} /> : <ScrollText />}
            <div className="grow">
              <div className="truncate">{f.name}</div>
              <div className="logs-file-sub">
                {relativeTime(f.modified)} · {formatBytes(f.size)}
              </div>
            </div>
          </button>
        ))}
      </aside>
      <section className="logs-view">
        <div className="content-toolbar" style={{ padding: "0 0 10px" }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search log" style={{ width: 220 }} />
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "All" },
              { value: "warn", label: "Warnings" },
              { value: "error", label: "Errors" },
            ]}
          />
          <span className="spacer" />
          <IconButton label={follow ? "Following new lines" : "Follow new lines"} onClick={() => setFollow((f) => !f)} className={follow ? "icon-btn--on" : ""}>
            <ArrowDownToLine />
          </IconButton>
          <IconButton
            label="Copy"
            onClick={() => {
              navigator.clipboard.writeText(shown.map((l) => l.text).join("\n"));
              toast.success("Log copied");
            }}
          >
            <Copy />
          </IconButton>
          <IconButton label="Open logs folder" onClick={() => api.openInstanceFolder(instance.id, source !== "live" && source.kind === "crash" ? "crash-reports" : "logs")}>
            <FolderOpen />
          </IconButton>
        </div>
        <div
          className="log-view selectable"
          ref={viewRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && follow) setFollow(false);
          }}
        >
          {shown.length === 0 ? (
            <Empty icon={<ScrollText />} title={source === "live" ? "Nothing logged yet" : fileText == null ? "Loading…" : "No matching lines"}>
              {source === "live" ? "Start the game and its output streams here in real time." : undefined}
            </Empty>
          ) : (
            shown.map((l, i) => (
              <div key={i} className={`log-line log-line--${l.level.toLowerCase()}`}>
                {l.thread && <span className="log-thread">[{l.thread}]</span>}
                {l.text}
              </div>
            ))
          )}
        </div>
        {source === "live" && live.length > 0 && !instance.running && (
          <div className="row" style={{ paddingTop: 8 }}>
            <span className="t-faint" style={{ fontSize: 12 }}>
              Showing the last session's output.
            </span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => useLogs.getState().clear(instance.id)}>
              Clear
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
