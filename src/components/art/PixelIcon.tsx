import { memo } from "react";

// Original 8×8 pixel-art icons for instances. Each row is 8 characters; each
// character maps to a palette color ('.' = transparent).

interface IconDef {
  label: string;
  bg: [string, string];
  palette: Record<string, string>;
  rows: string[];
}

export const PIXEL_ICONS: Record<string, IconDef> = {
  grass: {
    label: "Grass",
    bg: ["#2d4a2a", "#1a2b19"],
    palette: { G: "#7bd35a", g: "#57a63c", D: "#97633a", d: "#6f4527", s: "#b78350" },
    rows: ["GGGGGGGG", "GgGGGgGG", "gDgGDgDg", "DDDdDDsD", "DdDDDDdD", "DsDDdDDD", "DDdDDDsD", "DDDDsDdD"],
  },
  stone: {
    label: "Stone",
    bg: ["#3b3f48", "#22252c"],
    palette: { A: "#9aa0ab", B: "#7d838f", C: "#646a75", D: "#b6bcc6" },
    rows: ["ABBABDAB", "BCABBACB", "ABDBCABA", "BACABBAD", "DBBACABB", "ABCABDBA", "BADBBACB", "ABBCABBA"],
  },
  diamond: {
    label: "Gem",
    bg: ["#1b3a4a", "#0e1f2a"],
    palette: { a: "#e7fdff", b: "#7ff0ff", c: "#3fc6e0", d: "#1f8aa8" },
    rows: ["........", "..abbb..", ".abbccc.", "abbcccdd", ".bccccd.", "..ccdd..", "...dd...", "........"],
  },
  pickaxe: {
    label: "Pickaxe",
    bg: ["#3a3248", "#211c2a"],
    palette: { h: "#c9f4ff", m: "#7fd8ec", w: "#a8743f", W: "#7a5229" },
    rows: [".hhhhh..", "hm...mh.", ".....Wm.", "....W..h", "...W....", "..W.....", ".w......", "w......."],
  },
  sword: {
    label: "Sword",
    bg: ["#462c33", "#26181c"],
    palette: { b: "#f2f5ff", s: "#b9c2d8", g: "#e7b64a", h: "#7a5229" },
    rows: [".......b", "......bs", ".....bs.", "....bs..", ".g.bs...", "..gs....", ".h.g....", "h......."],
  },
  lava: {
    label: "Lava",
    bg: ["#4a2412", "#2a1208"],
    palette: { y: "#ffe27a", o: "#ff9b3d", r: "#e2541c", R: "#a8320f" },
    rows: ["ooyooroo", "oyyorroR", "rooooyyo", "Rrroyyoo", "oorrooro", "oyorRroo", "yyoorroy", "ooyoRroo"],
  },
  ender: {
    label: "Orb",
    bg: ["#173c38", "#0b201e"],
    palette: { a: "#bff7e6", b: "#4fd6b1", c: "#1e8f7a", d: "#0d5249" },
    rows: ["..bbbb..", ".bbaacb.", "bbaccccb", "bacccdcb", "bcccdddb", "bccdddcb", ".bcddcb.", "..bbbb.."],
  },
  sapling: {
    label: "Sapling",
    bg: ["#2c3d22", "#182213"],
    palette: { l: "#8fe36a", L: "#5cae3e", t: "#8a5b33" },
    rows: ["..lll...", ".lLlll..", "lllLlll.", ".LlllL..", "...t..l.", "..lt.lL.", "...tl...", "...t...."],
  },
  pack: {
    label: "Chest",
    bg: ["#4a3518", "#2a1e0c"],
    palette: { w: "#c58a43", W: "#9a6528", d: "#5e3a12", m: "#e9e3d2" },
    rows: ["dddddddd", "dwwwwwwd", "dWWWWWWd", "dddmmddd", "dwwmmwwd", "dwwwwwwd", "dWWWWWWd", "dddddddd"],
  },
  potion: {
    label: "Potion",
    bg: ["#3a2648", "#1f1428"],
    palette: { g: "#d9e6f2", p: "#c779ff", P: "#8f45d6", h: "#f3dbff" },
    rows: ["...gg...", "...gg...", "..g..g..", ".gpppPg.", "gphpppPg", "gpppppPg", "gPpppPPg", ".gggggg."],
  },
  snow: {
    label: "Snow",
    bg: ["#2b3b52", "#17202e"],
    palette: { w: "#ffffff", s: "#cfe3f7", b: "#8fb6dc" },
    rows: ["wwswwwsw", "swwwswww", "wwwswwsw", "bwswwwwb", "bbwwbwbb", "bbbbbbbb", "sbbbsbbb", "bbsbbbsb"],
  },
  book: {
    label: "Book",
    bg: ["#3d2a1c", "#22170f"],
    palette: { c: "#7a3b2a", C: "#5a291c", p: "#efe6cf", g: "#e2b54a" },
    rows: [".cccccc.", "cCCCCCCp", "cCggCCCp", "cCCCCCCp", "cCCggCCp", "cCCCCCCp", "cCCCCCCp", ".cccccc."],
  },
};

export const ICON_KEYS = Object.keys(PIXEL_ICONS);

function PixelArt({ def }: { def: IconDef }) {
  return (
    <svg viewBox="0 0 8 8" shapeRendering="crispEdges" width="100%" height="100%" aria-hidden>
      {def.rows.flatMap((row, y) =>
        [...row].map((ch, x) => (ch === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={def.palette[ch]} />)),
      )}
    </svg>
  );
}

/** Rounded tile with a pixel icon, used for instances everywhere. */
export const InstanceIcon = memo(function InstanceIcon({ icon, size = 44, radius }: { icon: string; size?: number; radius?: number }) {
  const def = PIXEL_ICONS[icon] ?? PIXEL_ICONS.grass;
  const pad = Math.round(size * 0.18);
  return (
    <div
      className="instance-icon"
      style={{
        width: size,
        height: size,
        padding: pad,
        borderRadius: radius ?? Math.round(size * 0.28),
        background: `linear-gradient(145deg, ${def.bg[0]}, ${def.bg[1]})`,
      }}
    >
      <PixelArt def={def} />
    </div>
  );
});
