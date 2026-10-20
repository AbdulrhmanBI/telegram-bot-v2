#!/usr/bin/env node
// ============================================================================
// backfill-search-meta.mjs — one-time helper (the bot now does this itself: 🔎 فلاتر البحث ← 🪄 وسم وتصحيح; prefer that)
//
// Reads a content snapshot (the JSON the bot produces with /backup, same shape as the KV "db"),
// derives { s, t, n } for every file from WHERE it lives (subject folder > type folder > "Lec 3"),
// and writes:
//   <out>.json       the same snapshot + search_name / search_meta on the files it could classify
//   <out>.report.md  what was tagged, what was NOT (with paths) so you can review it
//
// Nothing is guessed: a file is tagged only when its subject folder AND its type folder are
// recognized. Everything else is listed in the report and left untouched.
//
// Usage:   node tools/backfill-search-meta.mjs db.json [out.json]
// Apply:   send the produced out.json to the bot with /restore  (take a /backup first!)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { normalizeText, parseQuery, metaToSyntax, canonNumbers, deriveFromPath, formatValue } from "../public/app/search-core.js";
const subjectName = (c) => formatValue("s", c);
const typeLabel = (c) => formatValue("t", c);

const [, , inFile, outArg] = process.argv;
if (!inFile) { console.error("usage: node tools/backfill-search-meta.mjs <snapshot.json> [out.json]"); process.exit(1); }
const outFile = outArg || inFile.replace(/(\.json)?$/i, "") + ".with-search.json";
const reportFile = outFile.replace(/\.json$/i, "") + ".report.md";

const db = JSON.parse(fs.readFileSync(inFile, "utf8"));
const nodes = db.nodes || {};
const kids = (n) => (n.children_rows || []).flat();

// Ambiguous folder names that need a human decision are pinned here (normalized folder name -> code).
const SUBJECT_OVERRIDES = {
  "applied stat": "STA"          // Level 3 · Semester 1 ("Applied Statistics (B)" is the semester-2 one)
};

// Type folders (first level under a subject).
const TOP_TYPES = [
  [/^lectures?$/, "LEC"], [/^records?$/, "REC"], [/^sections?$/, "SEC"], [/^summar/, "SUMMARY"],
  [/^books?$/, "BOOK"], [/^(exams?|mid ?terms?|final exams?)$/, "EXAM"],
  [/^quiz/, "QUIZ"], [/^notes?$/, "NOTES"], [/^final rev/, "REVIEW"], [/^test bank$/, "QUESTIONS"],
  [/^appendix$/, "APPENDIX"]
];
const IGNORED_TOP = /^(by halls|by groups)$/;

// "Class schedule" folders: their sub-folders are the schedule VARIANTS (names taken from the real tree).
const SCHEDULE_FOLDER = /^class schedule$/;
const VARIANT_FOLDERS = [
  [/^by halls?$/, "HALLS"], [/^by groups?$/, "GROUPS"], [/^sections?$/, "SECTIONS"],
  [/^mid ?terms?$/, "MIDTERM"], [/^final exams?$/, "FINAL"]
];
// Folder names whose number is a real item number ("Lec 3", "Rec 2", "Ch 4", "L 1", "Rev. Ch 2" ...)
const NUMBERED = /^(lec|lecture|rec|record|sec|section|ch|chapter|l|rev|revision|rev ch|revision on ch|formula ch)\b/;

function subjectOf(folderName) {
  const norm = normalizeText(folderName);
  if (SUBJECT_OVERRIDES[norm]) return SUBJECT_OVERRIDES[norm];
  const q = parseQuery(folderName + " ");
  const keys = Object.keys(q.fields);
  if (q.fields.s && q.fields.s.size === 1 && keys.length === 1 && !q.text.length) return [...q.fields.s][0];
  return null;
}

function numberOf(folderName) {
  const norm = normalizeText(folderName);
  if (!NUMBERED.test(norm)) return null;
  const nums = (norm.match(/\d+/g) || []).map(Number).slice(0, 2);
  // "formula ch 1/2" -> both chapters; "ch 3 p1" -> 3 (the part number is not an item number)
  if (/\b\d+ \d+$/.test(norm) && /formula/.test(norm)) return canonNumbers(nums);
  return canonNumbers(nums.slice(0, 1));
}

// subject folders = children of every "Semester N" folder
const subjects = [];
(function walk(id, trail) {
  const n = nodes[String(id)];
  if (!n) return;
  if (/^semester\b/i.test(String(n.name || "").trim())) { for (const c of kids(n)) subjects.push({ id: c, trail: [...trail, n.name] }); return; }
  for (const c of kids(n)) walk(c, [...trail, n.name]);
})(db.root_id || 1, []);

const stats = { tagged: 0, total: 0, skipped: {} };
const bySubject = {};
const unresolved = [];
const seenIds = new Map();             // telegram file id -> number of placements (info only)

const skip = (why, pathStr, f) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; unresolved.push({ why, path: pathStr, file: f }); };
const cleanName = (n) => String(n || "").replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, "").trim();
const schedules = { tagged: 0, byKey: {} };

// Class schedule: t=SCHEDULE, l/sem come from the folder tree, v from the sub-folder name.
function tagSchedule(sub) {
  const sn = nodes[String(sub.id)];
  const derived = deriveFromPath(sub.trail);                 // e.g. ["", "Level 3", "Semester 1"] -> { l:3, sem:1 }
  const label = [...sub.trail.slice(1), cleanName(sn.name)].join(" > ");
  (function visit(id, below, variant) {
    const n = nodes[String(id)];
    if (!n) return;
    for (const f of n.files || []) {
      stats.total++;
      const where = [label, ...below].join(" > ");
      if (below.length && !variant) { skip("schedule sub-folder not recognized: " + below[0], where, f); continue; }
      const meta = { t: "SCHEDULE", ...derived };
      if (variant) meta.v = variant;
      f.search_meta = meta;
      f.search_name = metaToSyntax(meta);
      stats.tagged++; schedules.tagged++;
      const k = f.search_name; schedules.byKey[k] = (schedules.byKey[k] || 0) + 1;
    }
    for (const c of kids(n)) {
      const cn = cleanName(nodes[String(c)].name);
      const v = variant || (VARIANT_FOLDERS.find(([re]) => re.test(normalizeText(cn))) || [])[1] || null;
      visit(c, [...below, cn], v);
    }
  })(sub.id, [], null);
}

for (const sub of subjects) {
  const sn = nodes[String(sub.id)];
  if (SCHEDULE_FOLDER.test(normalizeText(cleanName(sn.name)))) { tagSchedule(sub); continue; }
  const code = subjectOf(String(sn.name || ""));
  const label = [...sub.trail.slice(1), sn.name].join(" > ");
  if (!code) {
    // still count its files so the report is honest
    (function count(id, p) { const n = nodes[String(id)]; if (!n) return; for (const f of n.files || []) { stats.total++; skip("subject folder not recognized: " + sn.name, p, f); } for (const c of kids(n)) count(c, p + " > " + nodes[String(c)].name); })(sub.id, label);
    continue;
  }
  bySubject[code] = bySubject[code] || { tagged: 0, byType: {}, missed: 0 };

  (function visit(id, below) {
    const n = nodes[String(id)];
    if (!n) return;
    for (const f of n.files || []) {
      stats.total++;
      const where = [label, ...below].join(" > ");
      if (!below.length) { skip("file sits directly in the subject folder", where, f); bySubject[code].missed++; continue; }
      const top = normalizeText(below[0]);
      if (IGNORED_TOP.test(top)) { skip("non-content folder (" + below[0] + ")", where, f); bySubject[code].missed++; continue; }
      const hit = TOP_TYPES.find(([re]) => re.test(top));
      if (!hit) { skip("type folder not recognized: " + below[0], where, f); bySubject[code].missed++; continue; }
      let num = null;
      for (const part of below.slice(1)) { num = numberOf(part); if (num != null) break; }
      const meta = { s: code, t: hit[1], ...deriveFromPath(sub.trail) };      // l / sem from the tree (never typed)
      if (num != null) meta.n = num;
      // Identity belongs to the PLACEMENT: the same Telegram file under "Lec 1" and "Lec 2" (or under
      // two subjects) legitimately gets a different identity in each place.
      seenIds.set(String(f.id), (seenIds.get(String(f.id)) || 0) + 1);
      f.search_meta = meta;
      f.search_name = metaToSyntax(meta);
      stats.tagged++;
      bySubject[code].tagged++;
      bySubject[code].byType[hit[1]] = (bySubject[code].byType[hit[1]] || 0) + 1;
    }
    for (const c of kids(n)) visit(c, [...below, String(nodes[String(c)].name || "").replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, "").trim()]);
  })(sub.id, []);
}

fs.writeFileSync(outFile, JSON.stringify(db));

const fname = (f) => (f.file_name || f.caption || f.type || "file").toString().replace(/\s+/g, " ").slice(0, 50);
let md = `# Search metadata backfill report\n\nInput: \`${path.basename(inFile)}\`  →  Output: \`${path.basename(outFile)}\`\n\n`;
md += `**Files seen:** ${stats.total}  ·  **tagged:** ${stats.tagged}  ·  **left untagged:** ${stats.total - stats.tagged}\n\n`;
md += `## Per subject\n\n| Code | Subject | Tagged | Not tagged | Types |\n|---|---|---:|---:|---|\n`;
for (const [code, v] of Object.entries(bySubject)) {
  md += `| ${code} | ${subjectName(code)} | ${v.tagged} | ${v.missed} | ${Object.entries(v.byType).map(([t, c]) => `${typeLabel(t)} ${c}`).join(", ")} |\n`;
}
md += `\n## Class schedules (${schedules.tagged} tagged)\n\n`;
for (const [k, c] of Object.entries(schedules.byKey)) md += `- ${c} × \`${k}\`\n`;
md += `\n## Why files were NOT tagged\n\n`;
for (const [why, c] of Object.entries(stats.skipped).sort((a, b) => b[1] - a[1])) md += `- ${c} × ${why}\n`;
const multi = [...seenIds.values()].filter((c) => c > 1).length;
if (multi) md += `\n_${multi} Telegram files appear in more than one folder; each placement was tagged from its own path._\n`;
md += `\n## Untagged files (review these)\n\n`;
for (const u of unresolved.slice(0, 400)) md += `- ${u.path} — ${fname(u.file)}  _(${u.why})_\n`;
if (unresolved.length > 400) md += `\n… and ${unresolved.length - 400} more.\n`;
fs.writeFileSync(reportFile, md);

console.log(`tagged ${stats.tagged}/${stats.total} files`);
console.log("wrote", outFile);
console.log("wrote", reportFile);
