#!/usr/bin/env node
// Writes public/app/background/photos.json: the list of photos and music the Mini App background should use.
// The app reads this small static file instead of calling the GitHub API, so there is no API rate limit and no extra request.
//
//   node tools/build-gallery-manifest.mjs            write the file
//   node tools/build-gallery-manifest.mjs --check    exit 1 if the file is out of date (for CI)
//
// Run from the project root (the folder that contains public/). Uses the same filters as the app: formats, maxImageBytes, maxAudioBytes, maxPhotos.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig, pickFromEntries } from "../public/app/background/gallery.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BG = path.join(ROOT, "public/app/background");
const raw = JSON.parse(fs.readFileSync(path.join(BG, "gallery-config.json"), "utf8"));
const cfg = { ...normalizeConfig(raw), projectPath: "" };                    // locally the project root IS the root
const name = cfg.manifest || "photos.json";

function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name), rel = base + "/" + e.name;
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile()) out.push({ path: rel, type: "blob", size: fs.statSync(abs).size });
  }
  return out;
}
const entries = [
  ...walk(path.join(ROOT, cfg.photosFolder), cfg.photosFolder, []),
  ...walk(path.join(ROOT, cfg.musicFolder), cfg.musicFolder, [])
];
const { photos, music } = pickFromEntries(entries, cfg);
const strip = (list, folder) => list.map((p) => p.slice(folder.length + 1));
const json = JSON.stringify({ v: 1, photos: strip(photos, cfg.photosFolder), music: strip(music, cfg.musicFolder) }) + "\n";
const out = path.join(BG, name);

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (cur !== json) { console.error(`${path.relative(ROOT, out)} is out of date — run: node tools/build-gallery-manifest.mjs`); process.exit(1); }
  console.log("manifest is up to date"); process.exit(0);
}
fs.writeFileSync(out, json);
console.log(`${path.relative(ROOT, out)}: ${photos.length} photos, ${music.length} music file(s)`);
