// ===========================================================================
// search-core.js — shared, dependency-free search logic (ES module)
//
// Used by BOTH sides so there is exactly ONE source of truth:
//   * the Mini App (public/app/index.html)         -> local, real-time search
//   * the Worker   (src/worker.js, miniapp-api.js) -> validating the admin "search name"
//
// Internal model (never shown to normal users):
//     { s: "MA", t: "LEC", n: 2 }      s = Subject   t = Type   n = Number
//   Admin syntax:   [MA].s [Lec].t [2].n
//
// Golden rule: a field the user does not type means ANY value for that field.
// No fuzzy guessing: a word only means something if it is an explicit alias in
// SEARCH_DICTIONARY. The only "looseness" is prefix completion of the word the
// user is still typing (so "m" / "ma l" narrow progressively).
// ===========================================================================

export const SEARCH_CORE_REV = 1;

// ----------------------------------------------------------------------------
// 1. Central dictionary — extend it by adding entries; nothing else needs to change.
//    Aliases are written naturally; they are normalized (case, punctuation,
//    Arabic letter variants) when the lookup tables are built.
//    Codes are STABLE identifiers stored in the data: never rename a code,
//    rename its `name` instead.
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

  // `order` controls sorting inside a result group. `plural` is used in headers.
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
    COURSE:     { label: "Course",     plural: "Courses",     order: 12, aliases: ["course", "courses", "crs", "كورس", "كورسات"] }
  },

  // Words that carry no meaning in a query ("ma lecture of 2"). Explicit list, nothing is guessed.
  fillers: ["the", "of", "for", "and", "in", "no", "num", "number", "#"]
};

export const MAX_NUMBER = 999;       // numbers above this are treated as plain text (e.g. a year)
const MAX_RANGE_ITEMS = 60;

// ----------------------------------------------------------------------------
// 2. Normalization
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

// ----------------------------------------------------------------------------
// 3. Lookup tables (built once per dictionary object)
// ----------------------------------------------------------------------------
const LOOKUP_CACHE = new WeakMap();

function addAlias(map, alias, code) {
  const key = normalizeText(alias);
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(code);
}

export function buildLookup(dict = SEARCH_DICTIONARY) {
  const hit = LOOKUP_CACHE.get(dict);
  if (hit) return hit;
  const subj = new Map(), type = new Map();
  const subjCodes = Object.keys(dict.subjects || {});
  const typeCodes = Object.keys(dict.types || {});
  for (const code of subjCodes) {
    addAlias(subj, code, code);
    for (const a of dict.subjects[code].aliases || []) addAlias(subj, a, code);
  }
  for (const code of typeCodes) {
    addAlias(type, code, code);
    for (const a of dict.types[code].aliases || []) addAlias(type, a, code);
  }
  const fillers = new Set((dict.fillers || []).map(normalizeText).filter(Boolean));
  let maxTokens = 1;
  for (const k of [...subj.keys(), ...type.keys()]) maxTokens = Math.max(maxTokens, tokensOf(k).length);
  const typeOrder = {};
  typeCodes.forEach((c, i) => { typeOrder[c] = Number(dict.types[c].order) || (100 + i); });
  const subjectOrder = {};
  subjCodes.forEach((c, i) => { subjectOrder[c] = i; });
  const lk = { subj, type, fillers, maxTokens, typeOrder, subjectOrder, subjAliasList: [...subj.entries()], typeAliasList: [...type.entries()] };
  LOOKUP_CACHE.set(dict, lk);
  return lk;
}

// Developer helper (used by tests): returns a list of human-readable problems.
export function validateDictionary(dict = SEARCH_DICTIONARY) {
  const problems = [];
  const lk = buildLookup(dict);
  for (const [alias, codes] of lk.subj) {
    if (lk.type.has(alias)) problems.push(`alias "${alias}" is both a subject and a type`);
    if (lk.fillers.has(alias)) problems.push(`alias "${alias}" is also a filler word`);
    void codes;
  }
  for (const alias of lk.type.keys()) if (lk.fillers.has(alias)) problems.push(`type alias "${alias}" is also a filler word`);
  for (const [alias, codes] of lk.type) if (codes.size > 1) problems.push(`type alias "${alias}" maps to several types: ${[...codes].join(", ")}`);
  return problems;
}

// ----------------------------------------------------------------------------
// 4. Meta helpers  { s, t, n }
// ----------------------------------------------------------------------------
// n is a number, or a sorted array of numbers when an item covers several (ranges / lists).
export function canonNumbers(n) {
  const arr = (Array.isArray(n) ? n : [n]).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= MAX_NUMBER);
  const uniq = [...new Set(arr)].sort((a, b) => a - b);
  if (!uniq.length) return null;
  return uniq.length === 1 ? uniq[0] : uniq;
}

// Accepts anything (parsed JSON from D1/KV, admin input) and returns a clean meta or null.
export function normalizeSearchMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (typeof meta.s === "string" && /^[A-Za-z0-9_]{1,16}$/.test(meta.s)) out.s = meta.s.toUpperCase();
  if (typeof meta.t === "string" && /^[A-Za-z0-9_]{1,16}$/.test(meta.t)) out.t = meta.t.toUpperCase();
  if (meta.n != null) { const n = canonNumbers(meta.n); if (n != null) out.n = n; }
  return Object.keys(out).length ? out : null;
}

export const metaNumbers = (meta) => (meta && meta.n != null ? (Array.isArray(meta.n) ? meta.n : [meta.n]) : null);

export function formatNumbers(n) {
  const a = metaNumbers({ n });
  if (!a || !a.length) return "";
  if (a.length === 1) return String(a[0]);
  const contiguous = a.every((x, i) => i === 0 || x === a[i - 1] + 1);
  return contiguous ? a[0] + "–" + a[a.length - 1] : a.join(", ");
}

export function subjectName(code, dict = SEARCH_DICTIONARY) {
  const s = dict.subjects && dict.subjects[code];
  return s ? s.name : String(code || "");
}
export function typeLabel(code, plural = false, dict = SEARCH_DICTIONARY) {
  const t = dict.types && dict.types[code];
  return t ? (plural ? t.plural || t.label : t.label) : String(code || "");
}

// "MA · Lecture · 2" — short human summary used in admin confirmations.
export function describeMeta(meta, dict = SEARCH_DICTIONARY) {
  if (!meta) return "—";
  const parts = [];
  if (meta.s) parts.push(meta.s + " (" + subjectName(meta.s, dict) + ")");
  if (meta.t) parts.push(typeLabel(meta.t, false, dict));
  if (meta.n != null) parts.push("#" + formatNumbers(meta.n));
  return parts.join(" · ");
}

// Canonical admin syntax for a meta, e.g. "[MA].s [LEC].t [2].n"
export function metaToSyntax(meta) {
  if (!meta) return "";
  const out = [];
  if (meta.s) out.push("[" + meta.s + "].s");
  if (meta.t) out.push("[" + meta.t + "].t");
  if (meta.n != null) out.push("[" + (Array.isArray(meta.n) ? formatNumbers(meta.n).replace("–", "-") : meta.n) + "].n");
  return out.join(" ");
}

// ----------------------------------------------------------------------------
// 5. Admin syntax parser:   [MA].s [Lec].t [2].n      (any subset, any order)
//    Strict on purpose: unknown subjects/types are rejected so bad data never gets stored.
// ----------------------------------------------------------------------------
const FIELD_ALIASES = { s: "s", subj: "s", subject: "s", t: "t", type: "t", n: "n", no: "n", num: "n", number: "n" };

export function parseNumberSpec(raw) {
  const norm = String(raw == null ? "" : raw)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u060C\u061B;،]/g, ",").replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!norm) return { ok: false, error: "the number is empty" };
  const out = [];
  for (const part of norm.split(",")) {
    if (!part) continue;
    let m;
    if ((m = /^(\d{1,4})$/.exec(part))) out.push(Number(m[1]));
    else if ((m = /^(\d{1,4})-(\d{1,4})$/.exec(part))) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a) return { ok: false, error: `bad range "${part}" (the end is smaller than the start)` };
      if (b - a + 1 > MAX_RANGE_ITEMS) return { ok: false, error: `range "${part}" is too long (max ${MAX_RANGE_ITEMS} numbers)` };
      for (let x = a; x <= b; x++) out.push(x);
    } else return { ok: false, error: `"${part}" is not a number (use 2, 1-3 or 1,2,5)` };
  }
  if (out.length > MAX_RANGE_ITEMS) return { ok: false, error: `too many numbers (max ${MAX_RANGE_ITEMS})` };
  if (out.some((x) => x > MAX_NUMBER)) return { ok: false, error: `numbers must be between 0 and ${MAX_NUMBER}` };
  const n = canonNumbers(out);
  return n == null ? { ok: false, error: "no valid number found" } : { ok: true, n };
}

function resolveUnique(map, value, what, dict) {
  const key = normalizeText(value);
  if (!key) return { ok: false, error: `the ${what} is empty` };
  const codes = map.get(key);
  if (!codes || !codes.size) return { ok: false, error: `unknown ${what} "${String(value).trim()}"` };
  if (codes.size > 1) return { ok: false, error: `"${String(value).trim()}" matches several ${what}s (${[...codes].join(", ")}) — use the exact code` };
  void dict;
  return { ok: true, code: [...codes][0] };
}

export function parseAdminSyntax(text, dict = SEARCH_DICTIONARY) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  const lk = buildLookup(dict);
  const re = /\[([^\]]*)\]\s*\.\s*([A-Za-z]+)/g;
  const meta = {};
  let m, rest = src;
  const seen = new Set();
  while ((m = re.exec(src))) {
    rest = rest.replace(m[0], " ");
    const field = FIELD_ALIASES[m[2].toLowerCase()];
    if (!field) return { ok: false, error: `unknown tag ".${m[2]}" (use .s .t .n)` };
    if (seen.has(field)) return { ok: false, error: `the tag ".${field}" appears twice` };
    seen.add(field);
    if (field === "s") { const r = resolveUnique(lk.subj, m[1], "subject", dict); if (!r.ok) return r; meta.s = r.code; }
    else if (field === "t") { const r = resolveUnique(lk.type, m[1], "type", dict); if (!r.ok) return r; meta.t = r.code; }
    else { const r = parseNumberSpec(m[1]); if (!r.ok) return r; meta.n = r.n; }
  }
  if (rest.replace(/\s+/g, "")) return { ok: false, error: `unexpected text "${rest.trim().slice(0, 40)}" — write every part as [value].tag` };
  if (!Object.keys(meta).length) return { ok: false, error: "no field found" };
  return { ok: true, meta };
}

// Admin input = the admin syntax, OR (convenience) plain words like "ma lec 2" as long as every
// word is a known alias (strict: unknown/ambiguous words are rejected, never guessed).
export function parseAdminSearchInput(text, dict = SEARCH_DICTIONARY) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  if (src.includes("[")) {
    const r = parseAdminSyntax(src, dict);
    return r.ok ? { ok: true, meta: normalizeSearchMeta(r.meta), name: src.slice(0, 120) } : r;
  }
  const q = parseQuery(src + " ", { dict });     // trailing space = "no word is being typed" => no prefix guessing
  if (q.text.length) return { ok: false, error: `unknown word "${q.text[0]}" — use the codes or the [MA].s [Lec].t [2].n format` };
  for (const [k, label] of [["s", "subject"], ["t", "type"]]) {
    if (q[k] && q[k].size > 1) return { ok: false, error: `the ${label} is ambiguous (${[...q[k]].join(", ")}) — use the exact code` };
  }
  if (q.n && q.n.size > 1) return { ok: false, error: "write several numbers as a range, e.g. [1-3].n" };
  const meta = {};
  if (q.s) meta.s = [...q.s][0];
  if (q.t) meta.t = [...q.t][0];
  if (q.n) meta.n = [...q.n][0];
  const clean = normalizeSearchMeta(meta);
  if (!clean) return { ok: false, error: "nothing recognized — use the codes or the [MA].s [Lec].t [2].n format" };
  return { ok: true, meta: clean, name: src.slice(0, 120) };
}

// Text listing the valid codes (shown by the bot when the admin asks for help).
export function codesHelpText(dict = SEARCH_DICTIONARY) {
  const subs = Object.entries(dict.subjects).map(([c, v]) => `${c} — ${v.name}`).join("\n");
  const types = Object.entries(dict.types).map(([c, v]) => `${c} — ${v.label}`).join("\n");
  return "Subjects:\n" + subs + "\n\nTypes:\n" + types;
}

// ----------------------------------------------------------------------------
// 6. Natural user query parser
//    "managerial accounting lec 2"  ->  { s:{MA}, t:{LEC}, n:{2}, text:[] }
//    Missing field  = ANY.
//    The word still being typed (query does not end with a space) may be a PREFIX of a
//    known alias, so "m" / "ma l" / "cost a" progressively narrow. Nothing else is guessed.
// ----------------------------------------------------------------------------
export function parseQuery(raw, opts = {}) {
  const dict = opts.dict || SEARCH_DICTIONARY;
  const lk = buildLookup(dict);
  const rawStr = String(raw == null ? "" : raw);
  const norm = normalizeText(rawStr);
  const tokens = tokensOf(norm);
  const typing = opts.typing != null ? !!opts.typing : !/\s$/.test(rawStr);   // is the last word still being typed?
  const q = { s: null, t: null, n: null, text: [], partial: false, recognized: false, empty: !tokens.length, norm };
  const addTo = (field, codes) => {
    q[field] = q[field] || new Set();
    for (const c of codes) q[field].add(c);
    q.recognized = true;
  };

  // aliases that START WITH the typed phrase
  const prefixMatch = (list, phrase) => {
    const out = new Set();
    for (const [alias, codes] of list) if (alias === phrase || alias.startsWith(phrase)) for (const c of codes) out.add(c);
    return out;
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    // numbers
    if (/^\d+$/.test(tok)) {
      const v = Number(tok);
      if (v <= MAX_NUMBER) { addTo("n", [v]); i++; continue; }
      q.text.push(tok); i++; continue;
    }

    const remaining = tokens.length - i;
    const atTail = typing && remaining <= lk.maxTokens;

    // (a) multi-word phrase still being typed: "managerial a" -> prefix of "managerial acc"
    if (atTail && remaining >= 2 && !lk.subj.has(tokens.slice(i).join(" ")) && !lk.type.has(tokens.slice(i).join(" "))) {
      const phrase = tokens.slice(i).join(" ");
      let hit = null;
      if (!q.s) { const c = prefixMatch(lk.subjAliasList, phrase); if (c.size) hit = ["s", c]; }
      if (!hit && !q.t) { const c = prefixMatch(lk.typeAliasList, phrase); if (c.size) hit = ["t", c]; }
      if (hit) { addTo(hit[0], hit[1]); q.partial = true; i = tokens.length; continue; }
    }

    // (b) longest exact alias starting here
    let matched = false;
    for (let j = Math.min(lk.maxTokens, remaining); j >= 1; j--) {
      const phrase = tokens.slice(i, i + j).join(" ");
      const sc = lk.subj.get(phrase), tc = lk.type.get(phrase);
      if (sc && !(q.s && !tc)) { addTo("s", sc); i += j; matched = true; break; }
      if (tc) { addTo("t", tc); i += j; matched = true; break; }
      if (sc) { addTo("s", sc); i += j; matched = true; break; }
    }
    if (matched) continue;

    // (c) filler words are ignored
    if (lk.fillers.has(tok)) { i++; continue; }

    // (d) last word still being typed: single-token prefix
    if (atTail && remaining === 1) {
      let hit = null;
      if (!q.s) { const c = prefixMatch(lk.subjAliasList, tok); if (c.size) hit = ["s", c]; }
      if (!hit && !q.t) { const c = prefixMatch(lk.typeAliasList, tok); if (c.size) hit = ["t", c]; }
      if (hit) { addTo(hit[0], hit[1]); q.partial = true; i++; continue; }
    }

    // (e) unknown word: kept as a plain text filter, never mapped to a subject/type
    q.text.push(tok);
    i++;
  }
  return q;
}

// ----------------------------------------------------------------------------
// 7. Matching + grouping (pure functions; the Mini App supplies the entries)
//    entry = { id, i, f, s, t, n: number[]|null, hay: string }
// ----------------------------------------------------------------------------
export function matchEntry(e, q) {
  if (q.s && !(e.s && q.s.has(e.s))) return false;
  if (q.t && !(e.t && q.t.has(e.t))) return false;
  if (q.n) {
    if (!e.n || !e.n.length) return false;
    let ok = false;
    for (const x of e.n) if (q.n.has(x)) { ok = true; break; }
    if (!ok) return false;
  }
  if (q.text.length) {
    const hay = e.hay || "";
    for (const w of q.text) if (!hay.includes(w)) return false;
  }
  return true;
}

// Which (subject, number) pairs contain a lecture — lets non-lecture items read "Lecture 2 Summary".
export function buildContext(entries) {
  const lec = new Set();
  for (const e of entries) if (e.t === "LEC" && e.n) for (const x of e.n) lec.add(e.s + "|" + x);
  return { lec };
}

function itemTitle(e, n, ctx, dict) {
  const label = e.t ? typeLabel(e.t, false, dict) : "";
  const num = n != null ? String(n) : "";
  if (!e.t) return num ? "#" + num : "Item";
  if (e.t === "LEC") return num ? `${label} ${num}` : label;
  if (num && ctx && ctx.lec.has(e.s + "|" + n)) return `Lecture ${num} ${label}`;
  return num ? `${label} ${num}` : label;
}

// Returns an ordered list of subject blocks, ready to render.
//   block = { s, name, suffix, count, groups:[{ key, heading, items:[{ e, title }] }] }
export function groupResults(matches, q, ctx, dict = SEARCH_DICTIONARY) {
  const lk = buildLookup(dict);
  const bySubject = new Map();
  for (const e of matches) {
    const key = e.s || "";
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(e);
  }
  const subjects = [...bySubject.keys()].sort((a, b) => (lk.subjectOrder[a] ?? 999) - (lk.subjectOrder[b] ?? 999));
  const showHeadings = !q.t && !q.n;     // "ma" -> grouped by number; "ma lec" / "ma 2" -> flat

  const blocks = [];
  for (const s of subjects) {
    const list = bySubject.get(s);
    // an item with several numbers appears under each requested number (or each of its own)
    const buckets = new Map();   // n|"" -> [{e,n}]
    for (const e of list) {
      const nums = e.n && e.n.length ? (q.n ? e.n.filter((x) => q.n.has(x)) : e.n) : [null];
      for (const n of nums) {
        const k = n == null ? "" : String(n);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({ e, n });
      }
    }
    const keys = [...buckets.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : Number(a) - Number(b)));
    const groups = keys.map((k) => {
      const items = buckets.get(k)
        .sort((x, y) => (lk.typeOrder[x.e.t] ?? 999) - (lk.typeOrder[y.e.t] ?? 999) || (x.e.i - y.e.i))
        .map(({ e, n }) => ({ e, n, title: itemTitle(e, n, ctx, dict) }));
      const hasLec = k !== "" && ctx && ctx.lec.has(s + "|" + k);
      const heading = k === "" ? "General" : hasLec ? `Lecture ${k}` : `#${k}`;
      return { key: k, heading, items };
    });
    const bits = [];
    if (q.t) bits.push([...q.t].map((c) => typeLabel(c, true, dict)).join(" / "));
    if (q.n) bits.push("#" + [...q.n].sort((a, b) => a - b).join(", "));
    blocks.push({
      s,
      name: s ? subjectName(s, dict) : "Other",
      suffix: bits.length ? " — " + bits.join(" · ") : "",
      count: list.length,
      showHeadings,
      groups
    });
  }
  return blocks;
}
