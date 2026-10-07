import { Fragment, memo, type ReactNode } from "react";
import { api } from "../lib/api";

/**
 * A deliberately small Markdown renderer for Modrinth descriptions.
 *
 * Descriptions are untrusted, and this webview can call the launcher's
 * backend — so raw HTML is never injected. Everything becomes React elements:
 * HTML tags are reduced to text/links/images first, links open in the system
 * browser (https only), and images are limited to Modrinth's CDN (also
 * enforced by the app's Content-Security-Policy).
 */

const ALLOWED_IMG = /^https:\/\/cdn\.modrinth\.com\//;

function decode(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function htmlToMarkdown(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, (_m, url) => `![](${url})`)
    .replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, text) => `[${text.replace(/<[^>]+>/g, "").trim() || url}](${url})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "")}\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<\/?(p|div|center|ul|ol|details|summary|table|tr|section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // images, links, bold, italic, code
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(decode(text.slice(last, m.index)));
    const k = `${key}-${i++}`;
    if (m[2] !== undefined) {
      if (ALLOWED_IMG.test(m[2])) out.push(<img key={k} src={m[2]} alt={m[1]} loading="lazy" className="md-img" />);
    } else if (m[4] !== undefined) {
      const url = m[4];
      const label = inline(m[3], k);
      out.push(
        url.startsWith("https://") ? (
          <a
            key={k}
            href={url}
            onClick={(e) => {
              e.preventDefault();
              api.openUrl(url);
            }}
          >
            {label}
          </a>
        ) : (
          <Fragment key={k}>{label}</Fragment>
        ),
      );
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k}>{inline(m[5] ?? m[6], k)}</strong>);
    else if (m[7] !== undefined) out.push(<em key={k}>{inline(m[7], k)}</em>);
    else if (m[8] !== undefined) out.push(<code key={k}>{m[8]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(decode(text.slice(last)));
  return out;
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const lines = htmlToMarkdown(source).replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length)
      blocks.push(
        <ul key={`l${blocks.length}`}>
          {list.map((li, i) => (
            <li key={i}>{inline(li, `l${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code) {
      if (line.trim().startsWith("```")) {
        blocks.push(<pre key={`c${blocks.length}`}>{code.join("\n")}</pre>);
        code = null;
      } else code.push(raw);
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as "h2";
      blocks.push(<Tag key={`h${blocks.length}`}>{inline(h[2], `h${blocks.length}`)}</Tag>);
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      list.push(li[1]);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      flushList();
      blocks.push(<hr key={`r${blocks.length}`} />);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.replace(/^>\s?/, "").trim());
  }
  flushPara();
  flushList();
  if (code) blocks.push(<pre key="cend">{(code as string[]).join("\n")}</pre>);
  return <div className="markdown selectable">{blocks}</div>;
});
