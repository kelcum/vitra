/** Minecraft names: 3 to 16 letters, numbers or underscores. */
export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** Why a name can't be used, or null when it's well-formed. */
export function nameProblem(name: string): string | null {
  if (!name) return null;
  if (/[^A-Za-z0-9_]/.test(name)) return "Only letters, numbers and underscores.";
  if (name.length < 3) return "Names need at least 3 characters.";
  if (name.length > 16) return "Names can be at most 16 characters.";
  return null;
}

const LEET: Record<string, string> = { o: "0", i: "1", l: "1", e: "3", a: "4", s: "5", t: "7" };

/**
 * Names close to `raw`, closest first: one character added, then a swapped or dropped one, then
 * two characters added, then common prefixes and suffixes. Only well-formed names, no repeats
 * (Minecraft names ignore case).
 */
export function nameIdeas(raw: string): string[] {
  const b = raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  if (!b) return [];
  const seen = new Set([b.toLowerCase()]);
  const out: string[] = [];
  const add = (n: string) => {
    if (NAME_RE.test(n) && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  };
  const first = b[0];
  const last = b[b.length - 1];

  // One character away.
  [b + "_", "_" + b, b + last, first + b, b + "x", "x" + b, b + "z", b + "o", b + "1", b + "2"].forEach(add);
  for (let i = 1; i < b.length; i++) add(b.slice(0, i) + "_" + b.slice(i));
  [...b].forEach((c, i) => LEET[c.toLowerCase()] && add(b.slice(0, i) + LEET[c.toLowerCase()] + b.slice(i + 1)));
  if (b.length > 3) {
    add(b.slice(0, -1));
    [...b].forEach((c, i) => i > 0 && /[aeiou]/i.test(c) && add(b.slice(0, i) + b.slice(i + 1)));
  }
  // Two characters away.
  [b + "__", "_" + b + "_", "x" + b + "x", b + "xd", b + "yt", b + "mc", b + "tv", b + "hd", b + "vx", b + last + last, b + "77", b + "69"].forEach(add);
  if (b.length <= 8) add(b + b);
  // Words around it.
  ["its" + b, "im" + b, "real" + b, "not" + b, "the" + b, b + "pvp", b + "lol", b + "ttv", b + "live", b + "irl"].forEach(add);
  // Long names: make room by trimming.
  if (b.length >= 15) {
    add(b.slice(0, 15) + "_");
    add(b.slice(0, 14) + "x");
  }
  return out;
}
