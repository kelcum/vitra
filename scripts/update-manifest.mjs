// Writes the updater manifest (latest.json) for a signed release build.
//
//   node scripts/update-manifest.mjs <notes.txt> <out/latest.json> [download base URL]
//
// The build must be signed: set TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD)
// before `tauri build` so the installer gets a .sig next to it.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [notesFile, outFile, base = "https://xan.gripe/vitra/download"] = process.argv.slice(2);
if (!notesFile || !outFile) {
  console.error("usage: node scripts/update-manifest.mjs <notes.txt> <out/latest.json> [download base URL]");
  process.exit(1);
}

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const version = conf.version;
// fileURLToPath, not URL.pathname: on Windows the latter gives "/C:/…", which isn't a usable path.
const target = process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../src-tauri/target", import.meta.url));
const installer = `Vitra_${version}_x64-setup.exe`;
const sigPath = join(target, "release", "bundle", "nsis", `${installer}.sig`);
if (!existsSync(sigPath)) {
  console.error(`No signature at ${sigPath}. Build with TAURI_SIGNING_PRIVATE_KEY set.`);
  process.exit(1);
}

const signature = readFileSync(sigPath, "utf8").trim();
const platform = { signature, url: `${base.replace(/\/$/, "")}/${installer}` };
const manifest = {
  version,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${outFile} for ${version} -> ${platform.url}`);
