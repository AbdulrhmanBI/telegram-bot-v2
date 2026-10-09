// ============================================================================
// search-core.js — shared, dependency-free, FIELD-AGNOSTIC search engine (ES module)
//
// Used by BOTH sides so there is exactly ONE source of truth:
//   * the Mini App (public/app/index.html)         -> local, real-time search + filters
//   * the Worker   (src/worker.js, miniapp-api.js) -> validating / serializing the admin "search name"
//
// The engine knows only the GENERIC model:
//
//     meta   = { <field>: <value>, ... }          any keys   e.g. { s:"MA", t:"LEC", n:2, l:3 }
//     admin  =  [value].field [value].field ...    any fields
//     query  = every field the user mentions is a constraint; fields not mentioned are ANY
//
// Nothing in the parser / normalizer / matcher / index / filters mentions "s", "t" or "n".
// What a field MEANS comes from configuration only:
//
//     SEARCH_FIELDS      field registry   (kind, natural-language words, bare-number, path derivation …)
//     SEARCH_DICTIONARY  values + aliases for the fields that use a dictionary
//     SEARCH_PROFILES    how results are grouped / titled
//
// Add a field  = add one entry to SEARCH_FIELDS   (and a dictionary if it is an enum).
// Unknown fields are never discarded: they are preserved as generic text metadata.
// ============================================================================

export const SEARCH_CORE_REV = 2;
export const MAX_NUMBER = 999;                 // numbers above this are treated as plain text (e.g. a year)
const MAX_RANGE_ITEMS = 60;
const MAX_FIELDS_PER_ITEM = 16;
const MAX_TEXT = 80;

// ----------------------------------------------------------------------------
// 1. Dictionary — values and aliases of the enum fields. Extend freely.
//    Codes are STABLE identifiers stored in the data: never rename a code, rename its label.
//    Entry shape: { name|label, plural?, order?, aliases: [...] }
// ----------------------------------------------------------------------------
export const SEARCH_DICTIONARY = {
  subjects: {
    // ---- Level 3 · Semester 1 ----
    COST: { name: "Cost Accounting", aliases: ["cost", "cost acc", "cost accounting", "تكاليف", "محاسبة التكاليف"] },
    PF:   { name: "Public Finance", aliases: ["pf", "public finance", "public", "المالية العامة"] },
    STA:  { name: "Applied Statistics (A)", aliases: ["sta", "stat", "stats", "statistics", "applied stat", "applied statistics", "stat a", "stats a", "statistics a", "applied stat a", "applied statistics a", "احصاء", "الاحصاء"] },
    IEC:  { name: "International Economics", aliases: ["iec", "inteco", "international eco", "international economics", "intl eco", "اقتصاد دولي", "الاقتصاد الدولي"] },
    FM:   { name: "Financial Management", aliases: ["fm", "financial management", "الادارة المالية"] },
    FI:   { name: "Financial Institutions", aliases: ["fi", "financial institutions", "institutions", "المؤسسات المالية"] },
    // ---- Level 3 · Semester 2 ----
    TAX:  { name: "Tax Accounting", aliases: ["tax", "taxes", "tax acc", "tax accounting", "ضرائب", "المحاسبة الضريبية"] },
    AUD:  { name: "Auditing & Assurance", aliases: ["aud", "audit", "auditing", "auditing assurance", "auditing and assurance", "المراجعة"] },
    MM:   { name: "Material Management", aliases: ["mm", "material", "materials", "material management", "ادارة المواد"] },
    IB:   { name: "International Business", aliases: ["ib", "international business", "business", "ادارة الاعمال الدولية"] },
    EDP:  { name: "Economic Development & Planning", aliases: ["edp", "economic dev", "economic development", "economic dev planning", "economic development planning", "economic development and planning", "تخطيط", "التنمية الاقتصادية"] },
    STB:  { name: "Applied Statistics (B)", aliases: ["stb", "stat", "stats", "statistics", "applied stat", "applied statistics", "stat b", "stats b", "statistics b", "applied stat b", "applied statistics b"] },
    // ---- Level 4 · Accounting · Semester 1 ----
    AIS:  { name: "Accounting Information Systems", aliases: ["ais", "accounting information systems", "accounting information system", "نظم المعلومات المحاسبية"] },
    FR:   { name: "Financial Reporting", aliases: ["fr", "financial reporting", "reporting", "التقارير المالية"] },
    CSYS: { name: "Cost Accounting Systems", aliases: ["csys", "cost", "cost sys", "cost system", "cost systems", "cost acc sys", "cost accounting sys", "cost accounting system", "cost accounting systems"] },
    MA:   { name: "Managerial Accounting", aliases: ["ma", "managerial", "managerial acc", "managerial accounting", "management accounting", "محاسبة ادارية"] },
    AMA:  { name: "Advanced Managerial Accounting", aliases: ["ama", "adv ma", "adv managerial", "adv managerial acc", "adv managerial accounting", "advanced managerial", "advanced managerial acc", "advanced managerial accounting", "advanced ma"] },
    ACST: { name: "Accounting Studies", aliases: ["acst", "accounting studies", "دراسات محاسبية", "دراسات"] }
  },

  types: {
    LEC:        { label: "Lecture",    plural: "Lectures",    order: 1,  aliases: ["lec", "lecs", "lecture", "lectures", "محاضرة", "محاضرات"] },
    REC:        { label: "Record",     plural: "Records",     order: 2,  aliases: ["rec", "recs", "record", "records", "recording", "recordings", "تسجيل", "تسجيلات"] },
    SEC:        { label: "Section",    plural: "Sections",    order: 3,  aliases: ["sec", "secs", "section", "sections", "سكشن", "سيكشن"] },
    SUMMARY:    { label: "Summary",    plural: "Summaries",   order: 4,  aliases: ["summary", "summ", "sum", "summaries", "ملخص", "ملخصات"] },
    QUESTIONS:  { label: "Questions",  plural: "Questions",   order: 5,  aliases: ["question", "questions", "qs", "اسئلة", "سؤال"] },
    REVIEW:     { label: "Review",     plural: "Reviews",     order: 6,  aliases: ["review", "reviews", "revision", "rev", "مراجعة"] },
    ASSIGNMENT: { label: "Assignment", plural: "Assignments", order: 7,  aliases: ["assignment", "assignments", "asg", "hw", "homework", "تكليف"] },
    QUIZ:       { label: "Quiz",       plural: "Quizzes",     order: 8,  aliases: ["quiz", "quizzes", "كويز"] },
    EXAM:       { label: "Exam",       plural: "Exams",       order: 9,  aliases: ["exam", "exams", "امتحان", "امتحانات"] },
    NOTES:      { label: "Notes",      plural: "Notes",       order: 10, aliases: ["note", "notes"] },
    BOOK:       { label: "Book",       plural: "Books",       order: 11, aliases: ["book", "books", "كتاب", "كتب"] },
    COURSE:     { label: "Course",     plural: "Courses",     order: 12, aliases: ["course", "courses", "crs", "كورس", "كورسات"] },
    SCHEDULE:   { label: "Schedule",   plural: "Schedules",   order: 13, aliases: ["schedule", "schedules", "class schedule", "class schedules", "جدول", "جداول", "جدول المحاضرات"] },
    APPENDIX:   { label: "Appendix",   plural: "Appendices",  order: 14, aliases: ["appendix", "appendices", "ملحق", "ملاحق"] }
  },

  // Sub-kind of an item (used by schedules today: by halls / by groups / …)
  variants: {
    HALLS:    { label: "By halls",    order: 1, aliases: ["halls", "hall", "by halls", "by hall", "قاعات", "بالقاعات"] },
    GROUPS:   { label: "By groups",   order: 2, aliases: ["groups", "by groups", "by group", "جروبات", "مجموعات"] },
    SECTIONS: { label: "Sections",    order: 3, aliases: ["sections", "by sections", "سكاشن"] },
    MIDTERM:  { label: "Mid-term",    order: 4, aliases: ["midterm", "midterms", "mid term", "mid terms", "ميد", "ميدتيرم", "نصف الترم"] },
    FINAL:    { label: "Final exams", order: 5, aliases: ["final", "finals", "final exam", "final exams", "فاينال", "الفاينال", "نهائي"] }
  },

  // Words that carry no meaning in a query ("ma lecture of 2"). Explicit list, nothing is guessed.
  fillers: ["the", "of", "for", "and", "in"]
};

// ----------------------------------------------------------------------------
// 2. Field registry — DATA, not logic.
//    kind        "enum"   value comes from a dictionary          (dictionary: "<name>")
//                "number" integer, or range/list  1-3  1,3,5
//                "text"   free text (also the fallback for fields that are NOT registered)
//    words       natural-language words that introduce the field in a query: "level 3", "dr ahmed".
//                They also work as admin tags:  [3].level
//    bare        a bare number in a query ("ma 2") belongs to this field (at most one field)
//    chip        how a value is shown in short form ("Level {{v}}")
//    fromPath    regex (on the normalized folder name) that derives the value from the folder tree,
//                nearest ancestor wins — so admins never type it
//    filterOrder position in the dependent filter chain (lower = earlier); filter:false hides it
// ----------------------------------------------------------------------------
export const SEARCH_FIELDS = {
  s:   { label: "Subject",  kind: "enum",   dictionary: "subjects", words: ["subject"], filterOrder: 30 },
  t:   { label: "Type",     kind: "enum",   dictionary: "types",    words: ["type"],    filterOrder: 40 },
  n:   { label: "Number",   kind: "number", bare: true, words: ["number", "no", "num"], chip: "#{{v}}", filterOrder: 60 },
  l:   { label: "Level",    kind: "number", words: ["level", "lvl", "l"], chip: "Level {{v}}", fromPath: "^level (\\d+)\\b", filterOrder: 10 },
  sem: { label: "Semester", kind: "number", words: ["semester", "sem"], chip: "Semester {{v}}", fromPath: "^semester (\\d+)\\b", filterOrder: 20 },
  v:   { label: "Variant",  kind: "enum",   dictionary: "variants", filterOrder: 50 },
  doctor: { label: "Doctor", kind: "text", words: ["doctor", "dr"], filterOrder: 70 },
  group:  { label: "Group",  kind: "text", words: ["group"],        filterOrder: 80 }
};

// ----------------------------------------------------------------------------
// 3. Result profiles — how matches are grouped and titled. Data, evaluated by a small template engine.
//    The FIRST profile whose `when` matches an item is used (`when: {}` matches everything).
//
//    blockBy / blockTitle   one result block per distinct value-combination of the blockBy fields
//    blockSuffix            parts built from the QUERY constraints, appended to the block title
//    groupBy / groupTitle   sub-groups inside a block (headings hidden if the query constrains headingsUnlessQuery)
//    anchor                 an item kind that "owns" its siblings: { where, by, title } — a Summary that
//                           shares (s,n) with a Lecture reads "Lecture 2 Summary"
//    itemTitle              {{field}} {{field:plural}} {{field:chip}} {{anchor}} {{a|b|'literal'}} {{x?}} (optional)
//    A template is a string or an array of parts; a part with an empty (non-optional) placeholder is
//    dropped, the surviving parts are joined with " · ".
// ----------------------------------------------------------------------------
export const SEARCH_PROFILES = [
  {
    id: "schedule", order: 20,
    when: { t: "SCHEDULE" },
    blockBy: ["t", "l", "sem"],
    blockTitle: ["{{t}}", "{{l:chip}}", "{{sem:chip}}"],              // Schedule · Level 3 · Semester 1
    blockSuffix: [],
    groupBy: [],
    itemTitle: ["{{v|t}}"],
    sortBy: ["v"]
  },
  {
    id: "default", order: 10,
    when: {},
    blockBy: ["s"],
    blockTitle: ["{{s|'Other'}}"],
    blockSuffix: ["{{t:plural}}", "{{n:chip}}"],                         // Managerial Accounting — Lectures · #2
    groupBy: ["n"],
    groupTitle: ["{{anchor|n:chip|'General'}}"],                        // Lecture 3 | #3 | General
    headingsUnlessQuery: ["t", "n"],
    anchor: { where: { t: "LEC" }, by: ["s", "n"], title: ["{{t}} {{n}}"] },
    itemTitle: ["{{t}} {{n?}}"],                                        // Summary 2 | Book
    itemTitleAnchored: ["{{anchor}} {{t}}"],                            // Lecture 2 Summary
    sortBy: ["t"]
  }
];

const DEFAULT_CFG = { dict: SEARCH_DICTIONARY, fields: SEARCH_FIELDS, profiles: SEARCH_PROFILES, emptyTitle: "File" };

function asCfg(x) {
  if (!x) return DEFAULT_CFG;
  if (x.fields && x.dict) return x;
  if (x.subjects || x.types || x.variants) return { ...DEFAULT_CFG, dict: x };      // legacy: a bare dictionary
  return DEFAULT_CFG;
}

// ----------------------------------------------------------------------------
// 4. Normalization
// ----------------------------------------------------------------------------
export function normalizeText(input) {
  let s = String(input == null ? "" : input);
  try { s = s.normalize("NFKC"); } catch (_) {}
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))     // Arabic-Indic digits
       .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));    // Persian digits
  s = s.toLowerCase();
  s = s.replace(/\p{M}+/gu, "").replace(/\u0640/g, "");                          // diacritics + tatweel
  s = s.replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")                          // أ إ آ ٱ -> ا
       .replace(/\u0649/g, "\u064A")                                              // ى -> ي
       .replace(/\u0629/g, "\u0647");                                             // ة -> ه
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");                                         // punctuation / emoji -> space
  s = s.replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2"); // lec2 -> lec 2
  return s.replace(/\s+/g, " ").trim();
}
const tokensOf = (norm) => (norm ? norm.split(" ") : []);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ----------------------------------------------------------------------------
// 5. Compiled lookups, derived ONLY from the configuration (cached per cfg object)
// ----------------------------------------------------------------------------
let CACHE = new WeakMap();
export function resetSearchCache() { CACHE = new WeakMap(); }     // call after editing SEARCH_FIELDS/DICTIONARY at runtime

function addAlias(map, alias, code) {
  const key = normalizeText(alias);
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(code);
}

function compile(cfgIn) {
  const cfg = asCfg(cfgIn);
  const hit = CACHE.get(cfg);
  if (hit) return hit;
  const keys = Object.keys(cfg.fields);
  const c = { cfg, keys, enums: {}, aliasLists: {}, orders: {}, phrases: new Map(), words: new Map(), bare: null, maxTokens: 1, fromPath: {}, fillers: null, kind: {} };
  for (const key of keys) {
    const f = cfg.fields[key];
    const entries = f.kind === "enum" && f.dictionary ? cfg.dict[f.dictionary] : null;
    c.kind[key] = f.kind === "number" ? "number" : entries ? "enum" : "text";
    if (entries) {
      const map = new Map();
      c.orders[key] = {};
      Object.keys(entries).forEach((code, idx) => {
        c.orders[key][code] = entries[code].order != null ? Number(entries[code].order) : 1000 + idx;
        addAlias(map, code, code);
        for (const a of entries[code].aliases || []) addAlias(map, a, code);
      });
      c.enums[key] = map;
      c.aliasLists[key] = [...map.entries()];
      for (const [alias, codes] of map) {
        if (!c.phrases.has(alias)) c.phrases.set(alias, []);
        c.phrases.get(alias).push({ field: key, codes });
        c.maxTokens = Math.max(c.maxTokens, tokensOf(alias).length);
      }
    }
    for (const w of f.words || []) { const nw = normalizeText(w); if (nw && !c.words.has(nw)) c.words.set(nw, key); }
    if (f.bare && !c.bare) c.bare = key;
    if (f.fromPath) { try { c.fromPath[key] = new RegExp(f.fromPath, "i"); } catch (_) {} }
  }
  c.fillers = new Set((cfg.dict.fillers || []).map(normalizeText).filter(Boolean));
  CACHE.set(cfg, c);
  return c;
}

// Developer helper (used by tests): returns problems + the intentional cross-field ambiguities.
export function validateConfig(cfgIn) {
  const c = compile(cfgIn);
  const problems = [], ambiguous = [];
  for (const [phrase, cands] of c.phrases) {
    if (cands.length > 1) ambiguous.push({ phrase, fields: cands.map((x) => x.field) });
    if (c.fillers.has(phrase)) problems.push(`alias "${phrase}" is also a filler word`);
    if (c.words.has(phrase)) problems.push(`alias "${phrase}" is also the field word of "${c.words.get(phrase)}"`);
  }
  for (const key of c.keys) if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) problems.push(`field key "${key}" is not a valid key`);
  if (c.keys.filter((k) => cfgIn && false).length) problems.push("unreachable");
  return { problems, ambiguous };
}

const kindOf = (c, key) => c.kind[key] || "text";
const maxOf = (c, key) => { const f = c.cfg.fields[key]; return f && Number.isFinite(f.max) ? f.max : MAX_NUMBER; };
const labelOfField = (c, key) => (c.cfg.fields[key] && c.cfg.fields[key].label) || key;

// ----------------------------------------------------------------------------
// 6. Values: parse / normalize / format — all driven by the registry
// ----------------------------------------------------------------------------
// `max` is configurable per field (SEARCH_FIELDS[x].max, e.g. a "year" field); default MAX_NUMBER.
export function canonNumbers(n, max = MAX_NUMBER) {
  const arr = asArray(n).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= max);
  const uniq = [...new Set(arr)].sort((a, b) => a - b);
  if (!uniq.length) return null;
  return uniq.length === 1 ? uniq[0] : uniq;
}

export function parseNumberSpec(raw, max = MAX_NUMBER) {
  const norm = String(raw == null ? "" : raw)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u060C\u061B;،]/g, ",").replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!norm) return { ok: false, error: "the number is empty" };
  const out = [];
  for (const part of norm.split(",")) {
    if (!part) continue;
    let m;
    if ((m = /^(\d{1,6})$/.exec(part))) out.push(Number(m[1]));
    else if ((m = /^(\d{1,6})-(\d{1,6})$/.exec(part))) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a) return { ok: false, error: `bad range "${part}" (the end is smaller than the start)` };
      if (b - a + 1 > MAX_RANGE_ITEMS) return { ok: false, error: `range "${part}" is too long (max ${MAX_RANGE_ITEMS} numbers)` };
      for (let x = a; x <= b; x++) out.push(x);
    } else return { ok: false, error: `"${part}" is not a number (use 2, 1-3 or 1,2,5)` };
  }
  if (out.length > MAX_RANGE_ITEMS) return { ok: false, error: `too many numbers (max ${MAX_RANGE_ITEMS})` };
  if (out.some((x) => x > max)) return { ok: false, error: `numbers must be between 0 and ${max}` };
  const n = canonNumbers(out, max);
  return n == null ? { ok: false, error: "no valid number found" } : { ok: true, n };
}

const cleanText = (v) => String(v).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

// One value -> canonical stored form (number | CODE | string). null = unusable.
function normalizeScalar(c, key, value) {
  if (value == null) return null;
  const kind = kindOf(c, key);
  if (kind === "number") {
    if (typeof value === "number") return canonNumbers(value, maxOf(c, key));
    const r = parseNumberSpec(value, maxOf(c, key));
    return r.ok ? r.n : null;
  }
  const str = cleanText(value);
  if (!str) return null;
  if (kind === "enum") {
    const hit = c.enums[key].get(normalizeText(str));
    if (hit && hit.size === 1) return [...hit][0];
    return /^[A-Za-z0-9_]{1,24}$/.test(str) ? str.toUpperCase() : null;      // keep codes even if the dictionary dropped them
  }
  return str;                                                                  // text / unknown field: keep as written
}

export function normalizeFieldValue(key, value, cfgIn) {
  const c = compile(cfgIn);
  if (Array.isArray(value)) {
    if (kindOf(c, key) === "number") return canonNumbers(value.map((x) => (typeof x === "number" ? x : Number(x))), maxOf(c, key));
    const out = [...new Set(value.map((x) => normalizeScalar(c, key, x)).filter((x) => x != null))].slice(0, MAX_RANGE_ITEMS);
    return out.length ? (out.length === 1 ? out[0] : out) : null;
  }
  return normalizeScalar(c, key, value);
}

// Generic: keeps EVERY key, normalizes each value through the registry. Returns null when nothing is left.
export function normalizeSearchMeta(meta, cfgIn) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out = {};
  let count = 0;
  for (const [rawKey, value] of Object.entries(meta)) {
    const key = String(rawKey).toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) continue;
    const v = normalizeFieldValue(key, value, cfgIn);
    if (v == null) continue;
    out[key] = v;
    if (++count >= MAX_FIELDS_PER_ITEM) break;
  }
  return count ? out : null;
}

// Registry order first, then any other keys alphabetically => stable text for diffs / storage.
function orderedKeys(c, meta) {
  const known = c.keys.filter((k) => meta[k] != null);
  const rest = Object.keys(meta).filter((k) => !c.keys.includes(k)).sort();
  return [...known, ...rest];
}
export function serializeSearchMeta(meta, cfgIn) {
  const m = normalizeSearchMeta(meta, cfgIn);
  if (!m) return null;
  const c = compile(cfgIn), o = {};
  for (const k of orderedKeys(c, m)) o[k] = m[k];
  return JSON.stringify(o);
}

export function formatNumbers(n) {
  const a = asArray(n);
  if (!a.length) return "";
  if (a.length === 1) return String(a[0]);
  const contiguous = a.every((x, i) => i === 0 || x === a[i - 1] + 1);
  return contiguous ? a[0] + "–" + a[a.length - 1] : a.join(", ");
}

// mode: "value" | "plural" | "chip"
export function formatValue(key, value, mode = "value", cfgIn) {
  const c = compile(cfgIn);
  const f = c.cfg.fields[key];
  if (kindOf(c, key) === "enum") {
    const e = c.cfg.dict[f.dictionary] && c.cfg.dict[f.dictionary][value];
    if (!e) return String(value);
    const label = e.label || e.name || String(value);
    return mode === "plural" ? (e.plural || label) : label;
  }
  return String(value);
}
function formatValues(c, key, values, mode) {
  const vals = asArray(values);
  if (!vals.length) return "";
  let s;
  if (kindOf(c, key) === "number") s = formatNumbers(vals.map(Number).sort((a, b) => a - b));
  else s = vals.map((v) => formatValue(key, v, mode, c.cfg)).join(" / ");
  const f = c.cfg.fields[key];
  return mode === "chip" && f && f.chip ? f.chip.replace("{{v}}", s) : s;
}

// "Subject: MA (Managerial Accounting) · Type: LEC (Lecture) · Number: 2"  (admin confirmations)
export function describeMeta(meta, cfgIn) {
  const m = normalizeSearchMeta(meta, cfgIn);
  if (!m) return "—";
  const c = compile(cfgIn);
  return orderedKeys(c, m).map((k) => {
    const v = m[k];
    let shown;
    if (kindOf(c, k) === "enum") shown = asArray(v).map((x) => { const l = formatValue(k, x, "value", c.cfg); return l !== String(x) ? `${x} (${l})` : String(x); }).join(", ");
    else if (kindOf(c, k) === "number") shown = formatNumbers(v);
    else shown = asArray(v).join(", ");
    return `${labelOfField(c, k)}: ${shown}`;
  }).join(" · ");
}

// Short form for lists: "MA·LEC·2"
export function shortMeta(meta, cfgIn) {
  const m = normalizeSearchMeta(meta, cfgIn);
  if (!m) return "";
  const c = compile(cfgIn);
  return orderedKeys(c, m).map((k) => (kindOf(c, k) === "number" ? formatNumbers(m[k]).replace("–", "-") : asArray(m[k]).join("/"))).join("·");
}

// Canonical admin syntax: "[MA].s [LEC].t [2].n"
export function metaToSyntax(meta, cfgIn) {
  const m = normalizeSearchMeta(meta, cfgIn);
  if (!m) return "";
  const c = compile(cfgIn);
  return orderedKeys(c, m).map((k) => {
    const v = m[k];
    const text = kindOf(c, k) === "number" ? formatNumbers(v).replace("–", "-").replace(/, /g, ",") : asArray(v).join(",");
    return "[" + text.replace(/[\[\]]/g, "") + "]." + k;
  }).join(" ");
}

// Derive fields from the folder tree (e.g. "Level 3" > "Semester 1" => l:3, sem:1). Nearest ancestor wins.
export function deriveFromPath(names, cfgIn) {
  const c = compile(cfgIn);
  const list = asArray(names).map(normalizeText);
  const out = {};
  for (const key of Object.keys(c.fromPath)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = c.fromPath[key].exec(list[i]);
      if (m) { out[key] = kindOf(c, key) === "number" ? Number(m[1]) : m[1]; break; }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// 7. Admin syntax parser — generic grammar:  [value].field  (any field, any order, any subset)
// ----------------------------------------------------------------------------
export function resolveFieldKey(tag, cfgIn) {
  const c = compile(cfgIn);
  const t = String(tag).toLowerCase();
  if (c.cfg.fields[t]) return t;
  const w = c.words.get(normalizeText(t));
  return w || t;
}

function parseFieldValue(c, key, raw) {
  const label = labelOfField(c, key).toLowerCase();
  const kind = kindOf(c, key);
  if (kind === "number") {
    const r = parseNumberSpec(raw, maxOf(c, key));
    return r.ok ? { ok: true, value: r.n } : { ok: false, error: `${label}: ${r.error}` };
  }
  if (kind === "enum") {
    const norm = normalizeText(raw);
    if (!norm) return { ok: false, error: `the ${label} is empty` };
    const codes = c.enums[key].get(norm);
    if (!codes || !codes.size) return { ok: false, error: `unknown ${label} "${String(raw).trim()}"` };
    if (codes.size > 1) return { ok: false, error: `"${String(raw).trim()}" matches several ${label}s (${[...codes].join(", ")}) — use the exact code` };
    return { ok: true, value: [...codes][0] };
  }
  const v = cleanText(raw);
  return v ? { ok: true, value: v } : { ok: false, error: `the ${label} is empty` };
}

export function parseAdminSyntax(text, cfgIn) {
  const c = compile(cfgIn);
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  const re = /\[([^\]]*)\]\s*\.\s*([A-Za-z][A-Za-z0-9_]*)/g;
  const meta = {}, warnings = [], seen = new Set();
  let m, rest = src;
  while ((m = re.exec(src))) {
    rest = rest.replace(m[0], " ");
    const key = resolveFieldKey(m[2], c.cfg);
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) return { ok: false, error: `bad field name ".${m[2]}"` };
    if (seen.has(key)) return { ok: false, error: `the tag ".${key}" appears twice` };
    seen.add(key);
    if (!c.cfg.fields[key]) warnings.push(`Unknown field ".${key}" — stored as custom metadata.`);
    const r = parseFieldValue(c, key, m[1]);
    if (!r.ok) return r;
    meta[key] = r.value;
  }
  if (rest.replace(/\s+/g, "")) return { ok: false, error: `unexpected text "${rest.trim().slice(0, 40)}" — write every part as [value].field` };
  if (!Object.keys(meta).length) return { ok: false, error: "no field found" };
  return { ok: true, meta, warnings };
}

// Admin input = the admin syntax, OR (convenience) plain words like "ma lec 2" / "schedule level 3"
// as long as every word is known (strict: unknown/ambiguous words are rejected, never guessed).
export function parseAdminSearchInput(text, cfgIn) {
  const c = compile(cfgIn);
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  if (src.includes("[")) {
    const r = parseAdminSyntax(src, c.cfg);
    if (!r.ok) return r;
    const meta = normalizeSearchMeta(r.meta, c.cfg);
    return meta ? { ok: true, meta, name: src.slice(0, 120), warnings: r.warnings } : { ok: false, error: "no usable value" };
  }
  const q = parseQuery(src + " ", { cfg: c.cfg, typing: false });
  if (q.text.length) return { ok: false, error: `unknown word "${q.text[0]}" — use the codes or the [MA].s [Lec].t [2].n format` };
  const meta = {};
  for (const [key, set] of Object.entries(q.fields)) {
    if (set.size > 1) {
      return { ok: false, error: kindOf(c, key) === "number"
        ? "write several numbers as a range, e.g. [1-3].n"
        : `the ${labelOfField(c, key).toLowerCase()} is ambiguous (${[...set].join(", ")}) — use the exact code` };
    }
    meta[key] = [...set][0];
  }
  const clean = normalizeSearchMeta(meta, c.cfg);
  if (!clean) return { ok: false, error: "nothing recognized — use the codes or the [MA].s [Lec].t [2].n format" };
  return { ok: true, meta: clean, name: src.slice(0, 120), warnings: [] };
}

// Text listing the valid codes (shown by the bot when the admin asks for help). Generated from the config.
export function codesHelpText(cfgIn) {
  const c = compile(cfgIn);
  const blocks = [];
  for (const key of c.keys) {
    const f = c.cfg.fields[key];
    if (kindOf(c, key) === "enum") {
      const entries = c.cfg.dict[f.dictionary];
      blocks.push(`${f.label} (.${key}):\n` + Object.entries(entries).map(([code, e]) => `${code} — ${e.label || e.name || code}`).join("\n"));
    } else {
      blocks.push(`${f.label} (.${key}) — ${kindOf(c, key) === "number" ? "a number, or a range like 1-3" : "free text"}`);
    }
  }
  blocks.push("Any other field is stored as custom text, e.g. [2026].year");
  return blocks.join("\n\n");
}

// ----------------------------------------------------------------------------
// 8. Natural user query parser
//    "managerial accounting lec 2"  ->  fields: { s:{MA}, t:{LEC}, n:{2} }
//    "schedule level 3 sem 1 final" ->  fields: { t:{SCHEDULE}, l:{3}, sem:{1}, v:{FINAL} }
//    Missing field = ANY.  Also understood: explicit  field:value  (e.g. year:2026, n:1-3).
//    The word still being typed (query does not end with a space) may be a PREFIX of a known alias.
//    Nothing else is guessed: unknown words stay plain text filters.
// ----------------------------------------------------------------------------
export function parseQuery(raw, opts = {}) {
  const c = compile(opts.cfg || opts.dict);
  const cfg = c.cfg;
  let rawStr = String(raw == null ? "" : raw);
  const typing = opts.typing != null ? !!opts.typing : !/\s$/.test(rawStr);
  const q = { fields: {}, text: [], partial: false, recognized: false, empty: false, norm: "" };
  const add = (key, vals) => {
    const set = q.fields[key] || (q.fields[key] = new Set());
    for (const v of vals) set.add(v);
    q.recognized = true;
  };

  // explicit  field:value  (any field, registered or not)
  rawStr = rawStr.replace(/(^|\s)([A-Za-z][A-Za-z0-9_]{0,23}):(\S+)/g, (all, pre, rk, val) => {
    if (/^(https?|ftp|tg)$/i.test(rk)) return all;
    const key = resolveFieldKey(rk, cfg);
    const kind = kindOf(c, key);
    let vals = null;
    if (kind === "number") { const r = parseNumberSpec(val, maxOf(c, key)); if (r.ok) vals = asArray(r.n); }
    else if (kind === "enum") { const hit = c.enums[key].get(normalizeText(val)); if (hit) vals = [...hit]; }
    else { const nv = normalizeText(val); if (nv) vals = [nv]; }
    if (!vals) return all;
    add(key, vals);
    return pre;
  });

  const norm = normalizeText(rawStr);
  q.norm = norm;
  const tokens = tokensOf(norm);
  q.empty = !tokens.length && !q.recognized;

  // first field (registry order) that is still unconstrained and has an alias starting with `phrase`
  const prefixHit = (phrase) => {
    for (const key of c.keys) {
      if (q.fields[key] || !c.aliasLists[key]) continue;
      const out = new Set();
      for (const [alias, codes] of c.aliasLists[key]) if (alias.startsWith(phrase)) for (const code of codes) out.add(code);
      if (out.size) return [key, out];
    }
    return null;
  };

  const pendings = [];                  // phrases that belong to several fields: resolved after the scan
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const remaining = tokens.length - i;
    const atTail = typing && remaining <= c.maxTokens;

    // (1) field word followed by its value:  "level 3"  "sem 1"  "doctor ahmed"  "variant final"
    const wk = c.words.get(tok);
    if (wk && i + 1 < tokens.length) {
      const next = tokens[i + 1], kind = kindOf(c, wk);
      if (kind === "number" && /^\d+$/.test(next) && Number(next) <= maxOf(c, wk)) { add(wk, [Number(next)]); i += 2; continue; }
      if (kind === "enum") {
        let hit = null;
        for (let j = Math.min(c.maxTokens, tokens.length - i - 1); j >= 1 && !hit; j--) {
          const codes = c.enums[wk].get(tokens.slice(i + 1, i + 1 + j).join(" "));
          if (codes) hit = { codes, j };
        }
        if (hit) { add(wk, hit.codes); i += 1 + hit.j; continue; }
      }
      if (kind === "text") { add(wk, [next]); i += 2; continue; }
    }

    // (2) bare number -> the field configured with bare:true
    if (/^\d+$/.test(tok)) {
      if (c.bare && Number(tok) <= maxOf(c, c.bare)) add(c.bare, [Number(tok)]); else q.text.push(tok);
      i++; continue;
    }

    // (3) multi-word phrase still being typed: "managerial a" -> prefix of "managerial acc"
    if (atTail && remaining >= 2 && !c.phrases.has(tokens.slice(i).join(" "))) {
      const hit = prefixHit(tokens.slice(i).join(" "));
      if (hit) { add(hit[0], hit[1]); q.partial = true; i = tokens.length; continue; }
    }

    // (4) longest exact alias starting here
    let matched = false;
    for (let j = Math.min(c.maxTokens, remaining); j >= 1; j--) {
      const cands = c.phrases.get(tokens.slice(i, i + j).join(" "));
      if (!cands) continue;
      if (cands.length === 1) add(cands[0].field, cands[0].codes); else pendings.push(cands);
      i += j; matched = true; break;
    }
    if (matched) continue;

    // (5) filler words are ignored
    if (c.fillers.has(tok)) { i++; continue; }

    // (6) the last word, still being typed: prefix of a known alias
    if (atTail && remaining === 1) {
      const hit = prefixHit(tok);
      if (hit) { add(hit[0], hit[1]); q.partial = true; i++; continue; }
    }

    // (7) a field word with no usable value ("ma level") carries no filter: ignore it
    if (wk) { i++; continue; }
    if (atTail && remaining === 1 && tok.length >= 2) {                 // "lev" typed on the way to "level 3"
      let isWordPrefix = false;
      for (const w of c.words.keys()) if (w.startsWith(tok)) { isWordPrefix = true; break; }
      if (isWordPrefix) { i++; q.partial = true; continue; }
    }

    // (8) unknown word: kept as a plain text filter, never mapped to a field
    q.text.push(tok);
    i++;
  }

  // phrases that fit several fields ("sections" = type SEC or variant SECTIONS): the first field the
  // user has not already constrained wins, so "schedule sections" -> variant, "ma sections" -> type.
  for (const cands of pendings) {
    const pick = cands.find((x) => !q.fields[x.field]) || cands[0];
    add(pick.field, pick.codes);
  }
  return q;
}

// ----------------------------------------------------------------------------
// 9. Entries, constraints, matching (generic: iterates the query's keys)
// ----------------------------------------------------------------------------
function comparable(c, key, value) {
  const kind = kindOf(c, key);
  const vals = asArray(value);
  if (kind === "number") return vals.map(Number);
  if (kind === "enum") return vals.map((v) => String(v).toUpperCase());
  return vals.map((v) => normalizeText(v));
}

// meta -> entry with precomputed comparable values (built once per item, queried many times)
export function makeEntry(base, meta, cfgIn) {
  const c = compile(cfgIn);
  const m = meta || {};
  const norm = {};
  for (const key of Object.keys(m)) norm[key] = comparable(c, key, m[key]);
  return { ...base, meta: m, norm };
}

// the expected-set a UI value (filter selection) stands for
export function expectedFor(key, value, cfgIn) {
  const c = compile(cfgIn);
  return new Set(comparable(c, key, value));
}

// every field in `a` and in `b` is a constraint; a field in both = intersection
export function mergeConstraints(a, b) {
  const out = {};
  for (const src of [a || {}, b || {}]) {
    for (const [key, set] of Object.entries(src)) {
      if (!out[key]) out[key] = new Set(set);
      else out[key] = new Set([...out[key]].filter((x) => set.has(x)));
    }
  }
  return out;
}

export function filtersToConstraints(filters, cfgIn) {
  const out = {};
  for (const [key, value] of Object.entries(filters || {})) if (value != null && value !== "") out[key] = expectedFor(key, value, cfgIn);
  return out;
}

// What the engine really filters by: the query's fields, where a CHOSEN filter wins for the same field
// ("ma" + Subject filter FM => FM). Fields neither mentions stay ANY.
export function effectiveConstraints(queryFields, filters, cfgIn) {
  return { ...(queryFields || {}), ...filtersToConstraints(filters, cfgIn) };
}

function matchField(itemVals, expected, kind) {
  if (!itemVals || !itemVals.length) return false;                      // a constrained field the item lacks => no match
  if (kind === "text") {
    for (const want of expected) for (const have of itemVals) if (have === want || (" " + have + " ").includes(" " + want + " ")) return true;
    return false;
  }
  for (const v of itemVals) if (expected.has(v)) return true;
  return false;
}

// Rule: every field present in the query is a constraint; absent fields are ANY.
export function matchFields(e, fields, cfgIn) {
  const c = compile(cfgIn);
  for (const key of Object.keys(fields || {})) {
    if (!matchField(e.norm && e.norm[key], fields[key], kindOf(c, key))) return false;
  }
  return true;
}

export function matchEntry(e, q, cfgIn) {
  if (!matchFields(e, q.fields, cfgIn)) return false;
  if (q.text && q.text.length) {
    const hay = e.hay || "";
    for (const w of q.text) if (!hay.includes(w)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// 10. Dynamic filters — fields and values discovered from the registry + the loaded data.
//     Dependent chain (by filterOrder):  each dropdown lists only values that exist in the dataset
//     left by the query's other constraints and by the filters chosen BEFORE it.
// ----------------------------------------------------------------------------
export function filterFieldOrder(entries, cfgIn) {
  const c = compile(cfgIn);
  const registered = c.keys.filter((k) => c.cfg.fields[k].filter !== false)
    .map((k, i) => ({ k, o: c.cfg.fields[k].filterOrder != null ? c.cfg.fields[k].filterOrder : 100 + i }))
    .sort((a, b) => a.o - b.o).map((x) => x.k);
  const seen = new Set(registered);
  const found = new Set();
  for (const e of entries) for (const k of Object.keys(e.meta || {})) if (!seen.has(k)) found.add(k);
  return [...registered, ...[...found].sort()];
}

function optionsFor(pool, key, c) {
  const kind = kindOf(c, key);
  const map = new Map();
  for (const e of pool) {
    const raw = asArray(e.meta && e.meta[key]), cmp = (e.norm && e.norm[key]) || [];
    raw.forEach((shown, i) => {
      const value = cmp[i];
      if (value == null) return;
      const hit = map.get(value);
      if (hit) hit.count++;
      else map.set(value, { value, label: kind === "enum" ? formatValue(key, shown, "value", c.cfg) : String(shown), count: 1 });
    });
  }
  const list = [...map.values()];
  if (kind === "number") list.sort((a, b) => a.value - b.value);
  else if (kind === "enum") list.sort((a, b) => ((c.orders[key] || {})[a.value] ?? 9999) - ((c.orders[key] || {})[b.value] ?? 9999));
  else list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

export function buildFilterModel(entries, state = {}, cfgIn) {
  const c = compile(cfgIn);
  const order = filterFieldOrder(entries, c.cfg);
  const queryFields = state.query || {}, filters = state.filters || {};
  const model = [];
  order.forEach((key, idx) => {
    const cons = {};
    for (const [k, set] of Object.entries(queryFields)) if (k !== key) cons[k] = set;
    for (const k of order.slice(0, idx)) if (filters[k] != null) cons[k] = expectedFor(k, filters[k], c.cfg);     // a chosen filter overrides what the query said about that field
    const pool = entries.filter((e) => matchFields(e, cons, c.cfg));
    const options = optionsFor(pool, key, c);
    if (!options.length) return;
    model.push({ key, label: labelOfField(c, key), kind: kindOf(c, key), options, selected: filters[key] != null ? filters[key] : null });
  });
  return model;
}

// Drops selected values that no longer exist after another filter / the query changed.
export function sanitizeFilters(entries, state = {}, cfgIn) {
  const c = compile(cfgIn);
  const order = filterFieldOrder(entries, c.cfg);
  const queryFields = state.query || {};
  const out = {};
  for (const [idx, key] of order.entries()) {
    const want = (state.filters || {})[key];
    if (want == null) continue;
    const cons = {};
    for (const [k, set] of Object.entries(queryFields)) if (k !== key) cons[k] = set;
    for (const k of order.slice(0, idx)) if (out[k] != null) cons[k] = expectedFor(k, out[k], c.cfg);
    const opts = optionsFor(entries.filter((e) => matchFields(e, cons, c.cfg)), key, c);
    const cmp = comparable(c, key, want)[0];
    if (opts.some((o) => o.value === cmp)) out[key] = want;
  }
  return out;
}

// ----------------------------------------------------------------------------
// 11. Results: profiles + templates (no field or value is special-cased here)
// ----------------------------------------------------------------------------
function whenMatches(when, meta) {
  for (const [k, want] of Object.entries(when || {})) {
    const have = asArray(meta[k]).map(String), wants = asArray(want).map(String);
    if (!have.some((x) => wants.includes(x))) return false;
  }
  return true;
}
function profileFor(cfg, meta) {
  const list = cfg.profiles || [];
  return list.find((p) => whenMatches(p.when, meta)) || list[list.length - 1];
}

function renderParts(c, tpl, ctx) {
  const parts = Array.isArray(tpl) ? tpl : tpl == null ? [] : [tpl];
  const out = [];
  for (const part of parts) {
    let dropped = false;
    const text = String(part).replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, exprIn) => {
      let expr = exprIn, optional = false;
      if (expr.endsWith("?")) { optional = true; expr = expr.slice(0, -1).trim(); }
      for (const alt of expr.split("|")) {
        const a = alt.trim();
        let val = "";
        if (/^'.*'$/.test(a) || /^".*"$/.test(a)) val = a.slice(1, -1);
        else if (a === "anchor") val = ctx.anchor || "";
        else { const [key, mode] = a.split(":"); val = formatValues(c, key, ctx.get(key), mode || "value"); }
        if (val) return val;
      }
      if (!optional) dropped = true;
      return "";
    }).replace(/\s+/g, " ").trim();
    if (!dropped && text) out.push(text);
  }
  return out.join(" · ");
}

const metaCtx = (meta, over, anchor) => ({
  anchor,
  get: (key) => (over && Object.prototype.hasOwnProperty.call(over, key) ? asArray(over[key]) : asArray(meta[key]))
});
const queryCtx = (fields) => ({ anchor: "", get: (key) => (fields[key] ? [...fields[key]] : []) });

function anchorKeys(profile, meta, over) {
  // all value-combinations of the anchor's `by` fields (a field may hold several values, e.g. n:[1,2,3])
  let combos = [[]];
  for (const f of profile.anchor.by) {
    const vals = over && Object.prototype.hasOwnProperty.call(over, f) ? asArray(over[f]) : asArray(meta[f]);
    if (!vals.length) return [];
    combos = combos.flatMap((p) => vals.map((v) => [...p, String(v)]));
  }
  return combos.map((x) => x.join("|"));
}

// Which items "own" their siblings (e.g. the lecture a summary belongs to). Built once per dataset.
export function buildContext(entries, cfgIn) {
  const cfg = asCfg(cfgIn);
  const anchors = {};
  for (const p of cfg.profiles || []) if (p.anchor) anchors[p.id] = new Set();
  for (const e of entries) {
    const p = profileFor(cfg, e.meta || {});
    if (!p || !p.anchor || !whenMatches(p.anchor.where, e.meta || {})) continue;
    for (const k of anchorKeys(p, e.meta, null)) anchors[p.id].add(k);
  }
  return { anchors };
}

function sortValue(c, key, meta) {
  const v = asArray(meta[key])[0];
  if (v == null) return Infinity;
  if (kindOf(c, key) === "number") return Number(v);
  if (kindOf(c, key) === "enum") return (c.orders[key] || {})[v] ?? 9999;
  return String(v).toLowerCase();
}
const cmpVals = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y));
    return x < y ? -1 : 1;
  }
  return 0;
};

// matches -> ordered blocks ready to render.
//   block = { key, profile, title, suffix, count, showHeadings, groups:[{ key, heading, items:[{ e, title }] }] }
export function groupResults(matches, q, ctx, cfgIn) {
  const c = compile(cfgIn);
  const cfg = c.cfg;
  const qf = (q && q.fields) || {};
  const byBlock = new Map();
  for (const e of matches) {
    const meta = e.meta || {};
    const p = profileFor(cfg, meta);
    const bkey = p.id + "||" + (p.blockBy || []).map((f) => asArray(meta[f]).join(",")).join("|");
    if (!byBlock.has(bkey)) byBlock.set(bkey, { p, entries: [] });
    byBlock.get(bkey).entries.push(e);
  }

  const blocks = [];
  for (const [bkey, { p, entries }] of byBlock) {
    const first = entries[0].meta || {};
    const gb = p.groupBy || [];
    const buckets = new Map();
    for (const e of entries) {
      const meta = e.meta || {};
      // an item holding several values (n:[1,2,3]) appears under each of them (only the queried ones if constrained)
      let combos = [{}];
      for (const f of gb) {
        let vals = asArray(meta[f]);
        if (qf[f] && vals.length) { const kept = vals.filter((v) => qf[f].has(kindOf(c, f) === "enum" ? String(v).toUpperCase() : kindOf(c, f) === "text" ? normalizeText(v) : Number(v))); if (kept.length) vals = kept; }
        if (!vals.length) vals = [null];
        combos = combos.flatMap((o) => vals.map((v) => ({ ...o, [f]: v })));
      }
      for (const over of combos) {
        const gk = gb.map((f) => (over[f] == null ? "" : String(over[f]))).join("|");
        if (!buckets.has(gk)) buckets.set(gk, { over, items: [] });
        buckets.get(gk).items.push({ e, over });
      }
    }
    const groups = [...buckets.entries()]
      .sort((a, b) => cmpVals(gb.map((f) => (a[1].over[f] == null ? Infinity : kindOf(c, f) === "number" ? Number(a[1].over[f]) : String(a[1].over[f]))), gb.map((f) => (b[1].over[f] == null ? Infinity : kindOf(c, f) === "number" ? Number(b[1].over[f]) : String(b[1].over[f])))))
      .map(([gk, { over, items }]) => {
        const sortBy = p.sortBy || [];
        items.sort((x, y) => cmpVals(sortBy.map((f) => sortValue(c, f, x.e.meta || {})), sortBy.map((f) => sortValue(c, f, y.e.meta || {}))) || (x.e.i - y.e.i));
        const hasAnchor = (e, o) => p.anchor && ctx && ctx.anchors && ctx.anchors[p.id] && anchorKeys(p, e.meta || {}, o).some((k) => ctx.anchors[p.id].has(k));
        const anchorText = (e, o) => (hasAnchor(e, o) ? renderParts(c, p.anchor.title, metaCtx({ ...(e.meta || {}), ...p.anchor.where }, o, "")) : "");
        const heading = gb.length ? renderParts(c, p.groupTitle, metaCtx(items[0].e.meta || {}, over, anchorText(items[0].e, over))) : "";
        return {
          key: gk, heading,
          items: items.map(({ e, over: o }) => {
            const meta = e.meta || {};
            const anchored = p.itemTitleAnchored && hasAnchor(e, o) && !whenMatches(p.anchor.where, meta);
            const title = renderParts(c, anchored ? p.itemTitleAnchored : p.itemTitle, metaCtx(meta, o, anchored ? anchorText(e, o) : "")) || cfg.emptyTitle || "File";
            return { e, title };
          })
        };
      });

    const suffixText = renderParts(c, p.blockSuffix, queryCtx(qf));
    blocks.push({
      key: bkey, profile: p.id, order: p.order || 0,
      title: renderParts(c, p.blockTitle, metaCtx(first, null, "")) || "Other",
      suffix: suffixText ? " — " + suffixText : "",
      count: entries.length,
      showHeadings: gb.length > 0 && !(p.headingsUnlessQuery || []).some((k) => qf[k]),
      groups,
      _sort: [p.order || 0, ...(p.blockBy || []).map((f) => sortValue(c, f, first))]
    });
  }
  blocks.sort((a, b) => cmpVals(a._sort, b._sort));
  for (const b of blocks) delete b._sort;
  return blocks;
}
