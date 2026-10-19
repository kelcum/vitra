import type { CSSProperties, ReactNode } from "react";

const COLORS: Record<string, string> = {
  black: "#000000",
  dark_blue: "#0000AA",
  dark_green: "#00AA00",
  dark_aqua: "#00AAAA",
  dark_red: "#AA0000",
  dark_purple: "#AA00AA",
  gold: "#FFAA00",
  gray: "#AAAAAA",
  dark_gray: "#555555",
  blue: "#5555FF",
  green: "#55FF55",
  aqua: "#55FFFF",
  red: "#FF5555",
  light_purple: "#FF55FF",
  yellow: "#FFFF55",
  white: "#FFFFFF",
};
const CODE_COLORS = "0123456789abcdef".split("").reduce<Record<string, string>>((m, c, i) => {
  m[c] = Object.values(COLORS)[i];
  return m;
}, {});

interface Style {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
}
interface Run {
  text: string;
  style: Style;
}

function legacyRuns(raw: string, base: Style): Run[] {
  const text = raw.replace(/[-]/g, "");
  const runs: Run[] = [];
  let style: Style = { ...base };
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, style: { ...style } });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "§" || i + 1 >= text.length) {
      buf += ch;
      continue;
    }
    const code = text[i + 1].toLowerCase();
    if (code === "x" && /^(§[0-9a-f]){6}$/i.test(text.slice(i + 2, i + 14))) {
      flush();
      const hex = text.slice(i + 2, i + 14).replace(/§/g, "");
      style = { color: `#${hex}` };
      i += 13;
      continue;
    }
    flush();
    if (CODE_COLORS[code]) style = { color: CODE_COLORS[code] };
    else if (code === "l") style.bold = true;
    else if (code === "o") style.italic = true;
    else if (code === "n") style.underlined = true;
    else if (code === "m") style.strikethrough = true;
    else if (code === "r") style = { ...base };
    i += 1;
  }
  flush();
  return runs;
}

type Component = string | { text?: string; color?: string; bold?: boolean; italic?: boolean; underlined?: boolean; strikethrough?: boolean; extra?: Component[]; translate?: string } | Component[];

function componentRuns(c: Component, inherited: Style, depth = 0): Run[] {
  if (depth > 24) return [];
  if (typeof c === "string") return legacyRuns(c, inherited);
  if (Array.isArray(c)) return c.flatMap((x) => componentRuns(x, inherited, depth + 1));
  if (!c || typeof c !== "object") return [];
  const style: Style = { ...inherited };
  if (typeof c.color === "string") style.color = COLORS[c.color] ?? (/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : style.color);
  for (const k of ["bold", "italic", "underlined", "strikethrough"] as const) {
    if (typeof c[k] === "boolean") style[k] = c[k];
  }
  const own = legacyRuns(c.text ?? c.translate ?? "", style);
  const kids = (c.extra ?? []).flatMap((x) => componentRuns(x, style, depth + 1));
  return [...own, ...kids];
}

function toLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const r of runs) {
    r.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, style: r.style });
    });
  }
  for (const line of lines) {
    while (line.length && !line[0].text.trim()) line.shift();
    while (line.length && !line[line.length - 1].text.trim()) line.pop();
    if (line.length) {
      line[0] = { ...line[0], text: line[0].text.trimStart() };
      const last = line.length - 1;
      line[last] = { ...line[last], text: line[last].text.trimEnd() };
    }
  }
  return lines.filter((l) => l.length).slice(0, 2);
}

function styleOf(s: Style): CSSProperties {
  const deco = [s.underlined && "underline", s.strikethrough && "line-through"].filter(Boolean).join(" ");
  return {
    color: s.color,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}

export function Motd({ value, className }: { value: unknown; className?: string }) {
  const lines = toLines(componentRuns((value ?? "") as Component, { color: COLORS.gray }));
  if (!lines.length) return null;
  return (
    <div className={className}>
      {lines.map((line, i) => (
        <div key={i} className="motd-line">
          {line.map((r, j): ReactNode => (
            <span key={j} style={styleOf(r.style)}>
              {r.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function plainText(s: string): string {
  return s.replace(/§[0-9a-fk-orx]/gi, "").trim();
}
