// ============================================================================
// search-core.js — shared, dependency-free, FIELD-AGNOSTIC search logic (ES module)
//
// Used by BOTH sides so there is exactly ONE source of truth:
//   * the Mini App (public/app/index.html)         -> local, real-time search
//   * the Worker   (src/worker.js, miniapp-api.js) -> validating / serializing the admin "search name"
//
// Model (never shown to normal users): an item carries a flat metadata object
//     { s: "MA", t: "LEC", n: 2, l: 3, sem: 1, v: "HALLS", doctor: "Dr Ahmed", ... }
// Admin syntax:   [value].field        e.g.  [MA].s [Lec].t [2].n [3].l [1].sem
//
// THE CORE KNOWS NO FIELD NAMES. Everything field-specific lives in DATA:
//   SEARCH_FIELDS    what each known field is (kind, aliases, dictionary, display format ...)
//   SEARCH_DICTIONARY the vocabularies for enum fields (subjects, types, variants ...)
//   SEARCH_VIEW      how results are grouped / titled / described
//   PATH_RULES       which metadata can be derived from the folder path
// Adding a field = adding an entry to SEARCH_FIELDS (and a dictionary if it is an enum).
// A field that is NOT registered still works: it is parsed, kept, serialized, indexed and matched
// as generic text.
//
// Golden rule: a field the user does not type means ANY value for that field.
// No fuzzy guessing: a word only means something if it is an explicit alias / field word.
// The only "looseness" is prefix completion of the word the user is still typing.
// ============================================================================

export const SEARCH_CORE_REV = 2;

// ----------------------------------------------------------------------------
// 1. Dictionaries (vocabularies of enum fields) — extend by adding entries.
//    Codes are STABLE identifiers stored in the data: never rename a code, rename its `name`/`label`.
//    The same alias MAY appear in two different dictionaries (e.g. "sections" is both the Section
//    type and the Sections schedule variant); the query parser resolves it from context.
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
    COURSE:     { label: "Course",     plural: "Courses",     order: 12, aliases: ["course", "courses", "crs", "كورس", "كورسات"] },
    SCHEDULE:   { label: "Schedule",   plural: "Schedules",   order: 13, aliases: ["schedule", "schedules", "class schedule", "class schedules", "جدول", "جداول", "جدول المحاضرات"] },
    APPENDIX:   { label: "Appendix",   plural: "Appendices",  order: 14, aliases: ["appendix", "appendices", "appendixes", "ملحق", "ملاحق"] }
  },

  // Variants of an item inside its type (today: the flavours of a class schedule).
  variants: {
    HALLS:    { label: "Halls",    order: 1, aliases: ["halls", "hall", "by halls", "by hall", "قاعات"] },
    GROUPS:   { label: "Groups",   order: 2, aliases: ["groups", "group", "by groups", "by group", "مجموعات"] },
    SECTIONS: { label: "Sections", order: 3, aliases: ["sections", "section", "by sections", "by section"] },
    MIDTERM:  { label: "Midterm",  order: 4, aliases: ["midterm", "midterms", "mid term", "mid terms", "ميدتيرم"] },
    FINAL:    { label: "Final",    order: 5, aliases: ["final", "finals", "final exam", "final exams", "فاينل", "نهائي"] }
  },

  // Words that carry no meaning in a query ("ma lecture of 2"). Explicit list, nothing is guessed.
  fillers: ["the", "of", "for", "and", "in", "no", "num", "number", "#"]
};

export const MAX_NUMBER = 999;       // numbers above this are treated as plain text (e.g. a year)
const MAX_RANGE_ITEMS = 60;
const MAX_TEXT_VALUE = 80;           // longest stored value of a free-text field
const CODE_RE = /^[A-Za-z0-9_]{1,16}$/;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;

// ----------------------------------------------------------------------------
// 2. Field registry — DATA, not logic.  Object order = canonical field order.
//
//    key         identifier stored in the data (lower-case, a-z0-9_)
//    label       human name ("Subject")
//    kind        "enum"   a code from a dictionary (or a free short code when no dictionary)
//                "number" one number, or (multi:true) a list/range
//                "text"   free text (also what an UNREGISTERED field behaves like)
//    dictionary  name of the vocabulary inside SEARCH_DICTIONARY (enum only)
//    aliases     other names: usable as admin tag ([x].level) AND as a query word ("level 3")
//    bare        number field that receives a bare number in a query ("ma 2") — at most one
//    multi       number field that accepts ranges/lists ([1-3].n)
//    ambiguousAliases  enum field whose aliases may deliberately map to several codes ("stat" -> STA, STB)
//    format      display of a number: "Level {v}"
//    describe    template used by describeMeta (default: "{{key.full}}")
//    parse / normalize   OPTIONAL custom hooks:  parse(raw, ctx) -> {ok,value}|{ok:false,error}
//                                                normalize(value, ctx) -> value | undefined
//
//    Query words are the key + aliases.  "level 3" / "l 3" / "sem 1" / "doctor ahmed" work for any
//    registered field; a field word only counts when a value follows it.
// ----------------------------------------------------------------------------
export const SEARCH_FIELDS = {
  s:   { key: "s", label: "Subject", kind: "enum", dictionary: "subjects", aliases: ["subj", "subject"], ambiguousAliases: true, describe: "{{s.code}} ({{s}})" },
  t:   { key: "t", label: "Type", kind: "enum", dictionary: "types", aliases: ["type"] },
  n:   { key: "n", label: "Number", kind: "number", multi: true, bare: true, aliases: ["no", "num", "number"], format: "#{v}" },
  l:   { key: "l", label: "Level", kind: "number", aliases: ["level", "lvl"], format: "Level {v}" },
  sem: { key: "sem", label: "Semester", kind: "number", aliases: ["semester"], format: "Semester {v}" },
  v:   { key: "v", label: "Variant", kind: "enum", dictionary: "variants", aliases: ["variant"] }
};

// ----------------------------------------------------------------------------
// 3. View configuration — how results are grouped, titled and described. Also DATA.
//
//    filters     order of the dependent filters (fields present in the data but not listed follow)
//    layouts     first layout whose `when` fields are all present on an item wins
//      blockBy   fields that split results into blocks      block   header segments (joined by " · ")
//      groupBy   fields that split a block into groups      group   {anchored, plain, none} templates
//      anchor    {where, keyBy, label}: items that share `keyBy` values with an item matching `where`
//                (e.g. a Lecture) get that item's label in their title ("Lecture 2 Summary")
//      title     rules, first match wins: {when?:[fields], anchored?:true, tpl}
//      sortBy    fields that order the items of a group
//      suffix    constrained fields echoed in the block header ("— Lectures · #2")
//      flatWhenConstrained   no group headings when the user already constrained one of these
//    Template placeholders:  {{field}} short value · {{field.full}} labelled ("Level 3")
//                            {{field.plural}} · {{field.code}} · {{anchor}}
// ----------------------------------------------------------------------------
export const SEARCH_VIEW = {
  filters: ["l", "s", "t", "n", "sem", "v"],
  layouts: [
    {
      id: "by-subject",
      when: ["s"],
      blockBy: ["s"],
      block: ["{{s}}"],
      groupBy: ["n"],
      group: { anchored: "{{anchor}} {{n}}", plain: "#{{n}}", none: "General" },
      anchor: { where: { t: "LEC" }, keyBy: ["s", "n"], label: "{{t}}" },
      title: [
        { anchored: true, when: ["t", "n"], tpl: "{{anchor}} {{n}} {{t}}" },
        { when: ["t"], tpl: "{{t}} {{n}}" },
        { when: ["n"], tpl: "#{{n}}" }
      ],
      sortBy: ["t"],
      suffix: ["t", "n"],
      flatWhenConstrained: ["t", "n"]
    },
    {
      // Items without a subject (class schedules, ...): described by type · level · semester, split by variant.
      id: "generic",
      when: [],
      blockBy: ["t", "l", "sem"],
      block: ["{{t}}", "{{l.full}}", "{{sem.full}}"],
      groupBy: ["v"],
      group: { anchored: "{{v}}", plain: "{{v}}", none: "General" },
      title: [
        { when: ["t", "v"], tpl: "{{t}} · {{v}}" },
        { when: ["t"], tpl: "{{t}}" },
        { when: ["v"], tpl: "{{v}}" }
      ],
      sortBy: ["v", "n"],
      suffix: ["v"],
      flatWhenConstrained: ["v"]
    }
  ]
};

// ----------------------------------------------------------------------------
// 4. Path rules — metadata that can be DERIVED from the folder path (root -> leaf names).
//    A rule is data:  { field, pattern, value }   (regex over the normalized folder name)
//                 or  { field, dictionary:true, only?:[codes] }  (folder name is an alias of the field's dictionary)
//    `when` makes a rule conditional on what was already derived; `standalone` marks rules strong
//    enough to classify a file by path alone (used by the backfill tool).  Deeper folders win.
// ----------------------------------------------------------------------------
export const PATH_RULES = [
  { field: "l",   pattern: "^(?:level|lvl) (\\d{1,2})$", value: "$1" },
  { field: "sem", pattern: "^semester (\\d{1,2})$", value: "$1" },
  { field: "t",   dictionary: true, only: ["SCHEDULE"], standalone: true },
  { field: "t",   dictionary: true, only: ["APPENDIX"] },
  { field: "v",   dictionary: true, when: { t: ["SCHEDULE"] } }
];

// ----------------------------------------------------------------------------
// 5. Normalization
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
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ownDef = (registry, key) => (registry && hasOwn(registry, key) ? registry[key] : null);
const isCode = (v) => typeof v === "string" && CODE_RE.test(v);

// ----------------------------------------------------------------------------
// 6. Lookup tables, derived from (dictionary, registry). Cached; a signature detects new fields.
// ----------------------------------------------------------------------------
const LOOKUP_CACHE = new WeakMap();   // dict -> WeakMap(registry -> {sig, lk})

function addAlias(map, alias, code) {
  const key = normalizeText(alias);
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(code);
}

function lookupSig(dict, registry) {
  let sig = "";
  for (const k of Object.keys(registry)) {
    const d = registry[k] || {};
    const size = d.dictionary && dict[d.dictionary] ? Object.keys(dict[d.dictionary]).length : 0;
    sig += k + ":" + (d.kind || "") + ":" + (d.dictionary || "") + ":" + size + ":" + (d.aliases || []).length + ":" + (d.bare ? 1 : 0) + "|";
  }
  return sig + (dict.fillers || []).length;
}

export function buildLookup(dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  let perDict = LOOKUP_CACHE.get(dict);
  if (!perDict) { perDict = new WeakMap(); LOOKUP_CACHE.set(dict, perDict); }
  const sig = lookupSig(dict, registry);
  const hit = perDict.get(registry);
  if (hit && hit.sig === sig) return hit.lk;

  const alias = new Map();        // field -> Map(normalized alias -> Set(codes))
  const aliasList = new Map();    // field -> [[alias, Set(codes)], ...]
  const order = {};               // field -> { code: sortRank }
  const enumKeys = [];            // enum fields that have a dictionary, in registry order
  const fieldWords = new Map();   // normalized query word -> field key
  const tagNames = new Map();     // lower-case admin tag name -> field key
  let bareField = null;
  let maxTokens = 1;

  for (const key of Object.keys(registry)) {
    const def = registry[key];
    if (!def) continue;
    tagNames.set(String(key).toLowerCase(), key);
    for (const a of def.aliases || []) if (!tagNames.has(String(a).toLowerCase())) tagNames.set(String(a).toLowerCase(), key);
    for (const w of [key, ...(def.aliases || [])]) {
      const nw = normalizeText(w);
      if (nw && !fieldWords.has(nw)) fieldWords.set(nw, key);
    }
    if (def.bare && def.kind === "number" && !bareField) bareField = key;
    const entries = def.kind === "enum" && def.dictionary ? dict[def.dictionary] : null;
    if (entries) {
      const map = new Map();
      const codes = Object.keys(entries);
      order[key] = {};
      codes.forEach((code, i) => {
        addAlias(map, code, code);
        for (const a of entries[code].aliases || []) addAlias(map, a, code);
        order[key][code] = Number(entries[code].order) || (100 + i);
      });
      alias.set(key, map);
      aliasList.set(key, [...map.entries()]);
      enumKeys.push(key);
      for (const k of map.keys()) maxTokens = Math.max(maxTokens, tokensOf(k).length);
    }
  }
  const fillers = new Set((dict.fillers || []).map(normalizeText).filter(Boolean));
  const lk = { alias, aliasList, order, enumKeys, fieldWords, tagNames, bareField, fillers, maxTokens };
  perDict.set(registry, { sig, lk });
  return lk;
}

// Developer helper (used by tests): returns a list of human-readable problems.
//   Same alias in two DIFFERENT fields is legal (resolved from context); `strict` reports it too.
export function validateDictionary(dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS, opts = {}) {
  const problems = [];
  const lk = buildLookup(dict, registry);
  for (const key of lk.enumKeys) {
    for (const [alias, codes] of lk.alias.get(key)) {
      if (lk.fillers.has(alias)) problems.push(`${key}: alias "${alias}" is also a filler word`);
      if (!registry[key].ambiguousAliases && codes.size > 1) problems.push(`${key}: alias "${alias}" maps to several values: ${[...codes].join(", ")}`);
    }
  }
  if (opts.strict) for (const [a, ka] of sharedAliases(dict, registry)) problems.push(`alias "${a}" is shared by fields ${ka.join(", ")}`);
  return problems;
}

// alias -> [fields that define it], only for aliases used by more than one field
export function sharedAliases(dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  const lk = buildLookup(dict, registry);
  const seen = new Map();
  for (const key of lk.enumKeys) for (const alias of lk.alias.get(key).keys()) { if (!seen.has(alias)) seen.set(alias, []); seen.get(alias).push(key); }
  return [...seen.entries()].filter(([, ks]) => ks.length > 1);
}

// ----------------------------------------------------------------------------
// 7. Values:  normalize / atoms / serialization
// ----------------------------------------------------------------------------
const toNum = (x) => (typeof x === "number" ? x : (typeof x === "string" && /^\s*\d+\s*$/.test(x) ? Number(x) : NaN));

// n is a number, or a sorted array of numbers when an item covers several (ranges / lists).
export function canonNumbers(n) {
  if (n == null) return null;
  const arr = (Array.isArray(n) ? n : [n]).map(toNum).filter((x) => Number.isInteger(x) && x >= 0 && x <= MAX_NUMBER);
  const uniq = [...new Set(arr)].sort((a, b) => a - b);
  if (!uniq.length) return null;
  return uniq.length === 1 ? uniq[0] : uniq;
}

function cleanText(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_VALUE);
  return s || undefined;
}

function uniqMany(list) {
  const out = [];
  for (const x of list) if (x !== undefined && !out.some((y) => y === x)) out.push(x);
  if (!out.length) return undefined;
  return out.length === 1 ? out[0] : out.slice(0, 20);
}

function resolveAliasUnique(map, value) {
  const codes = map && map.get(normalizeText(value));
  return codes && codes.size === 1 ? [...codes][0] : null;
}

function normalizeEnumScalar(def, value, lk, key) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return cleanText(value);
  const s = value.trim();
  if (!s) return undefined;
  const map = lk.alias.get(key);
  const entries = map && lk.order[key];
  if (isCode(s)) {
    const u = s.toUpperCase();
    if (entries && hasOwn(entries, u)) return u;
    return resolveAliasUnique(map, s) || u;           // known alias -> its code; otherwise keep the code as given
  }
  return resolveAliasUnique(map, s) || cleanText(s);   // not code-shaped: alias or plain text, never dropped
}

// One field value -> its normalized form, or undefined (= nothing storable).
//   registered enum   -> code (aliases resolved)       registered number -> number | sorted number[]
//   anything else     -> trimmed text / number / boolean (arrays of those allowed)
export function normalizeFieldValue(field, value, opts = {}) {
  const registry = opts.registry || SEARCH_FIELDS, dict = opts.dict || SEARCH_DICTIONARY;
  const def = ownDef(registry, field);
  if (def && typeof def.normalize === "function") {
    try { const r = def.normalize(value, { field, registry, dict }); return r == null ? undefined : r; } catch (_) { return undefined; }
  }
  if (value == null) return undefined;
  const kind = def ? def.kind : "text";
  if (kind === "number") { const n = canonNumbers(value); return n == null ? undefined : n; }
  if (kind === "enum") {
    const lk = buildLookup(dict, registry);
    return Array.isArray(value)
      ? uniqMany(value.map((x) => normalizeEnumScalar(def, x, lk, field)))
      : normalizeEnumScalar(def, value, lk, field);
  }
  return Array.isArray(value) ? uniqMany(value.map(cleanText)) : cleanText(value);
}

// "level" -> "l" ; "doctor" -> "doctor" ; junk / unsafe names -> null
export function canonFieldKey(raw, registry = SEARCH_FIELDS, dict = SEARCH_DICTIONARY) {
  const k = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!k) return null;
  const lk = buildLookup(dict, registry);
  if (lk.tagNames.has(k)) return lk.tagNames.get(k);
  return FIELD_KEY_RE.test(k) ? k : null;
}

function fieldRank(key, registry) {
  const keys = Object.keys(registry);
  const i = keys.indexOf(key);
  return i < 0 ? keys.length : i;
}

export function sortMetaKeys(keys, registry = SEARCH_FIELDS) {
  return [...keys].sort((a, b) => fieldRank(a, registry) - fieldRank(b, registry) || (a < b ? -1 : a > b ? 1 : 0));
}

// Accepts anything (parsed JSON from D1/KV, admin input) and returns a clean meta or null.
// EVERY field survives (registered ones get their specialised normalization, others are kept as text).
export function normalizeSearchMeta(meta, opts = {}) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const registry = opts.registry || SEARCH_FIELDS, dict = opts.dict || SEARCH_DICTIONARY;
  const tmp = {};
  for (const [rawKey, value] of Object.entries(meta)) {
    const key = canonFieldKey(rawKey, registry, dict);
    if (!key) continue;
    const v = normalizeFieldValue(key, value, { registry, dict });
    if (v === undefined) continue;
    tmp[key] = v;
  }
  const keys = sortMetaKeys(Object.keys(tmp), registry);
  if (!keys.length) return null;
  const out = {};
  for (const k of keys) out[k] = tmp[k];
  return out;
}

// Canonical JSON text for a meta object (stable key order => no phantom diffs). Used by Worker + API.
export function serializeSearchMeta(meta, opts = {}) {
  const m = normalizeSearchMeta(meta, opts);
  return m ? JSON.stringify(m) : null;
}
export function parseSearchMeta(text, opts = {}) {
  if (text == null || text === "") return null;
  try { return normalizeSearchMeta(typeof text === "string" ? JSON.parse(text) : text, opts); } catch (_) { return null; }
}

// Comparable atoms of one field value (what the matcher / facets compare):
//   number fields -> numbers, enum -> UPPERCASE codes, everything else -> normalized text.
function atomOf(def, v) {
  if (v == null || v === "") return null;
  const kind = def ? def.kind : "text";
  if (kind === "number") { const n = toNum(v); return Number.isFinite(n) ? n : null; }
  if (kind === "enum") return isCode(v) ? v.toUpperCase() : (normalizeText(v) || null);
  if (typeof v === "number") return v;
  return normalizeText(String(v)) || null;
}
export function atomsOf(field, value, opts = {}) {
  if (value == null) return [];
  const def = ownDef(opts.registry || SEARCH_FIELDS, field);
  const out = [];
  for (const v of Array.isArray(value) ? value : [value]) { const a = atomOf(def, v); if (a != null && !out.includes(a)) out.push(a); }
  return out;
}

export const metaNumbers = (meta, field) => (meta && meta[field] != null ? (Array.isArray(meta[field]) ? meta[field] : [meta[field]]) : null);

export function formatNumbers(n) {
  const a = Array.isArray(n) ? n : (n == null ? null : [n]);
  if (!a || !a.length) return "";
  if (a.length === 1) return String(a[0]);
  const contiguous = a.every((x, i) => i === 0 || x === a[i - 1] + 1);
  return contiguous ? a[0] + "–" + a[a.length - 1] : a.join(", ");
}

// ----------------------------------------------------------------------------
// 8. Display: values, templates, describe / syntax / short
// ----------------------------------------------------------------------------
export function subjectName(code, dict = SEARCH_DICTIONARY) {
  const s = dict.subjects && dict.subjects[code];
  return s ? s.name : String(code || "");
}
export function typeLabel(code, plural = false, dict = SEARCH_DICTIONARY) {
  const t = dict.types && dict.types[code];
  return t ? (plural ? t.plural || t.label : t.label) : String(code || "");
}

// mode: "short" (label / bare number) · "full" (labelled: "Level 3") · "plural" · "code"
export function displayValue(field, value, mode = "short", opts = {}) {
  if (value == null || value === "") return "";
  const registry = opts.registry || SEARCH_FIELDS, dict = opts.dict || SEARCH_DICTIONARY;
  const def = ownDef(registry, field);
  if (Array.isArray(value) && !(def && def.kind === "number")) return value.map((x) => displayValue(field, x, mode, opts)).join(", ");
  if (def && def.kind === "number") {
    const f = formatNumbers(value);
    if (mode === "short" || mode === "code") return f;
    return (def.format || (def.label ? def.label + " {v}" : "{v}")).replace("{v}", f);
  }
  if (def && def.kind === "enum" && def.dictionary && dict[def.dictionary]) {
    const e = dict[def.dictionary][value];
    if (mode === "code") return String(value);
    if (!e) return String(value);
    const short = e.label || e.name || String(value);
    return mode === "plural" ? (e.plural || short) : short;
  }
  return String(value);
}

const TPL_RE = /\{\{\s*([a-z][a-z0-9_]*)(?:\.(short|full|plural|code))?\s*\}\}/gi;
export function renderTemplate(tpl, meta, opts = {}) {
  const vars = opts.vars || {};
  const out = String(tpl).replace(TPL_RE, (_, f, mode) => {
    const key = f.toLowerCase();
    if (hasOwn(vars, key)) return String(vars[key] == null ? "" : vars[key]);
    return displayValue(key, meta ? meta[key] : null, mode || "short", opts);
  });
  return out.replace(/\s+/g, " ").trim();
}
const renderSegments = (segs, meta, opts = {}, sep = " · ") =>
  (Array.isArray(segs) ? segs : [segs]).map((s) => renderTemplate(s, meta, opts)).filter(Boolean).join(sep);

// "MA (Managerial Accounting) · Lecture · #2" / "Schedule · Level 3 · Semester 1 · Final" /  "doctor: Dr Ahmed"
export function describeMeta(meta, dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  if (!meta || typeof meta !== "object") return "—";
  const opts = { dict, registry };
  const parts = [];
  for (const key of sortMetaKeys(Object.keys(meta), registry)) {
    if (meta[key] == null) continue;
    const def = ownDef(registry, key);
    const tpl = def ? (def.describe || "{{" + key + ".full}}") : key + ": {{" + key + "}}";
    const r = renderTemplate(tpl, meta, opts);
    if (r) parts.push(r);
  }
  return parts.join(" · ") || "—";
}

// Canonical admin syntax for a meta, e.g. "[MA].s [LEC].t [2].n [3].l"
export function metaToSyntax(meta, registry = SEARCH_FIELDS) {
  if (!meta) return "";
  const out = [];
  for (const key of sortMetaKeys(Object.keys(meta), registry)) {
    const v = meta[key];
    if (v == null) continue;
    const def = ownDef(registry, key);
    let text;
    if (def && def.kind === "number") text = formatNumbers(v).replace("–", "-");
    else text = (Array.isArray(v) ? v.join(", ") : String(v)).replace(/[\[\]]/g, "");
    out.push("[" + text + "]." + key);
  }
  return out.join(" ");
}

// Compact "MA·LEC·2·3" used in admin lists.
export function shortMeta(meta, registry = SEARCH_FIELDS) {
  if (!meta) return "";
  return sortMetaKeys(Object.keys(meta), registry).map((key) => {
    const v = meta[key];
    if (v == null || v === "") return "";
    if (Array.isArray(v)) { const def = ownDef(registry, key); return def && def.kind === "number" ? v[0] + "-" + v[v.length - 1] : v.join("/"); }
    return String(v);
  }).filter((x) => x !== "").join("·");
}

// ----------------------------------------------------------------------------
// 9. Admin syntax parser:   [MA].s [Lec].t [2].n [3].l [Dr Ahmed].doctor     (any subset, any order)
//    Grammar is generic: [value].field. Registered fields use their own parser (strict: unknown
//    subjects/types are rejected so bad data never gets stored); UNREGISTERED fields are accepted as
//    text and reported as a warning, never dropped.
// ----------------------------------------------------------------------------
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

function resolveUnique(map, value, what) {
  const key = normalizeText(value);
  if (!key) return { ok: false, error: `the ${what} is empty` };
  const codes = map && map.get(key);
  if (!codes || !codes.size) return { ok: false, error: `unknown ${what} "${String(value).trim()}"` };
  if (codes.size > 1) return { ok: false, error: `"${String(value).trim()}" matches several ${what}s (${[...codes].join(", ")}) — use the exact code` };
  return { ok: true, code: [...codes][0] };
}

// raw text of ONE tag -> { ok, value } | { ok:false, error }.  Registry-driven; no field names here.
function parseFieldValue(key, def, raw, lk, ctx) {
  if (def && typeof def.parse === "function") {
    const r = def.parse(raw, ctx);
    return r && r.ok ? { ok: true, value: r.value } : { ok: false, error: (r && r.error) || `bad value for ".${key}"` };
  }
  const kind = def ? def.kind : "text";
  const what = def && def.label ? def.label.toLowerCase() : key;
  if (kind === "number") {
    const r = parseNumberSpec(raw);
    if (!r.ok) return r;
    if (!def.multi && Array.isArray(r.n)) return { ok: false, error: `".${key}" takes a single number, not a range or list` };
    return { ok: true, value: r.n };
  }
  if (kind === "enum" && lk.alias.has(key)) {
    const r = resolveUnique(lk.alias.get(key), raw, what);
    return r.ok ? { ok: true, value: r.code } : r;
  }
  if (kind === "enum") {
    const s = String(raw == null ? "" : raw).trim();
    return isCode(s) ? { ok: true, value: s.toUpperCase() } : { ok: false, error: `the ${what} must be a short code (letters/digits), got "${s.slice(0, 20)}"` };
  }
  const v = cleanText(String(raw == null ? "" : raw));
  return v === undefined ? { ok: false, error: `the value of ".${key}" is empty` } : { ok: true, value: v };
}

export function parseAdminSyntax(text, dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  const lk = buildLookup(dict, registry);
  const re = /\[([^\]]*)\]\s*\.\s*([A-Za-z][A-Za-z0-9_]*)/g;
  const meta = {};
  const warnings = [];
  let m, rest = src;
  const seen = new Set();
  while ((m = re.exec(src))) {
    rest = rest.replace(m[0], " ");
    const tag = m[2].toLowerCase();
    const known = lk.tagNames.get(tag) || null;
    const key = known || tag;
    if (!known && !FIELD_KEY_RE.test(tag)) return { ok: false, error: `bad tag ".${m[2].slice(0, 30)}" (use letters/digits, max 24)` };
    if (seen.has(key)) return { ok: false, error: `the tag ".${key}" appears twice` };
    seen.add(key);
    const r = parseFieldValue(key, known ? registry[known] : null, m[1], lk, { field: key, registry, dict });
    if (!r.ok) return r;
    meta[key] = r.value;
    if (!known) warnings.push(`Unknown field ".${tag}" — stored as custom metadata.`);
  }
  if (rest.replace(/\s+/g, "")) return { ok: false, error: `unexpected text "${rest.trim().slice(0, 40)}" — write every part as [value].tag` };
  if (!Object.keys(meta).length) return { ok: false, error: "no field found" };
  return { ok: true, meta, warnings };
}

// Admin input = the admin syntax, OR (convenience) plain words like "ma lec 2" as long as every
// word is a known alias (strict: unknown/ambiguous words are rejected, never guessed).
export function parseAdminSearchInput(text, dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  if (src.includes("[")) {
    const r = parseAdminSyntax(src, dict, registry);
    return r.ok ? { ok: true, meta: normalizeSearchMeta(r.meta, { dict, registry }), name: src.slice(0, 120), warnings: r.warnings } : r;
  }
  const q = parseQuery(src + " ", { dict, registry });     // trailing space = "no word is being typed" => no prefix guessing
  if (q.text.length) return { ok: false, error: `unknown word "${q.text[0]}" — use the codes or the [MA].s [Lec].t [2].n format` };
  const meta = {};
  for (const [field, set] of Object.entries(q.fields)) {
    const def = ownDef(registry, field);
    if (set.size > 1) {
      if (def && def.kind === "number") return { ok: false, error: `write several numbers as a range, e.g. [1-3].${field}` };
      return { ok: false, error: `the ${(def && def.label ? def.label : field).toLowerCase()} is ambiguous (${[...set].join(", ")}) — use the exact code` };
    }
    meta[field] = [...set][0];
  }
  const clean = normalizeSearchMeta(meta, { dict, registry });
  if (!clean) return { ok: false, error: "nothing recognized — use the codes or the [MA].s [Lec].t [2].n format" };
  return { ok: true, meta: clean, name: src.slice(0, 120), warnings: [] };
}

// Text listing the valid codes (shown by the bot when the admin asks for help). Generated from the registry.
export function codesHelpText(dict = SEARCH_DICTIONARY, registry = SEARCH_FIELDS) {
  const lk = buildLookup(dict, registry);
  const blocks = [];
  for (const key of lk.enumKeys) {
    const def = registry[key], entries = dict[def.dictionary];
    blocks.push(`${def.label}s (.${key}):\n` + Object.entries(entries).map(([c, v]) => `${c} — ${v.label || v.name || c}`).join("\n"));
  }
  const others = Object.keys(registry).filter((k) => !lk.alias.has(k))
    .map((k) => `.${k} — ${registry[k].label || k} (${registry[k].kind})${registry[k].aliases && registry[k].aliases.length ? ", also ." + registry[k].aliases.join(" .") : ""}`);
  if (others.length) blocks.push("Other fields:\n" + others.join("\n"));
  blocks.push("Any other [value].name is accepted and stored as custom metadata.");
  return blocks.join("\n\n");
}

// ----------------------------------------------------------------------------
// 10. Natural user query parser
//    "managerial accounting lec 2"  ->  { fields: { s:{MA}, t:{LEC}, n:{2} }, text: [] }
//    "schedule level 3 sem 1 final" ->  { fields: { t:{SCHEDULE}, l:{3}, sem:{1}, v:{FINAL} } }
//    Missing field = ANY.  Everything comes from the registry + dictionaries:
//      * a dictionary alias ("ma", "lec", "final")      -> its enum field
//      * "<field word> <value>" ("level 3", "sem 1")    -> that field
//      * a bare number                                  -> the field registered with bare:true
//    An alias shared by several fields is resolved from context (the field the query has not
//    filled yet). The word still being typed (query does not end with a space) may be a PREFIX of
//    an alias, so "m" / "ma l" / "cost a" progressively narrow. Nothing else is guessed.
// ----------------------------------------------------------------------------
export function parseQuery(raw, opts = {}) {
  const dict = opts.dict || SEARCH_DICTIONARY, registry = opts.registry || SEARCH_FIELDS;
  const lk = buildLookup(dict, registry);
  const rawStr = String(raw == null ? "" : raw);
  const norm = normalizeText(rawStr);
  const tokens = tokensOf(norm);
  const typing = opts.typing != null ? !!opts.typing : !/\s$/.test(rawStr);   // is the last word still being typed?
  const q = { fields: {}, text: [], partial: false, recognized: false, empty: !tokens.length, norm };

  const direct = [];      // unambiguous: { field, values }
  const picks = [];       // dictionary hits: { cands:[{field, codes}], prefix, tokens }

  const prefixCands = (phrase) => {
    const out = [];
    for (const key of lk.enumKeys) {
      const codes = new Set();
      for (const [alias, cs] of lk.aliasList.get(key)) if (alias === phrase || alias.startsWith(phrase)) for (const c of cs) codes.add(c);
      if (codes.size) out.push({ field: key, codes });
    }
    return out;
  };
  const exactCands = (phrase) => {
    const out = [];
    for (const key of lk.enumKeys) { const codes = lk.alias.get(key).get(phrase); if (codes) out.push({ field: key, codes }); }
    return out;
  };

  // "<field word> <value>" for any registered field; null unless a valid value follows
  const fieldWordValue = (i) => {
    const key = lk.fieldWords.get(tokens[i]);
    if (!key || i + 1 >= tokens.length) return null;
    const def = registry[key], nxt = tokens[i + 1];
    if (def.kind === "number") return /^\d+$/.test(nxt) && Number(nxt) <= MAX_NUMBER ? { key, values: [Number(nxt)], used: 2 } : null;
    if (lk.alias.has(key)) {
      const map = lk.alias.get(key), remaining = tokens.length - (i + 1);
      for (let j = Math.min(lk.maxTokens, remaining); j >= 1; j--) {
        const codes = map.get(tokens.slice(i + 1, i + 1 + j).join(" "));
        if (codes) return { key, values: [...codes], used: 1 + j };
      }
      return null;
    }
    if (lk.fieldWords.has(nxt) || lk.fillers.has(nxt)) return null;
    const a = atomOf(def, nxt);
    return a == null ? null : { key, values: [a], used: 2 };
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    // bare number -> the field configured with bare:true (otherwise plain text)
    if (/^\d+$/.test(tok)) {
      const v = Number(tok);
      if (lk.bareField && v <= MAX_NUMBER) direct.push({ field: lk.bareField, values: [v] }); else q.text.push(tok);
      i++; continue;
    }

    const remaining = tokens.length - i;
    const atTail = typing && remaining <= lk.maxTokens;

    // explicit field word + value
    const fw = fieldWordValue(i);
    if (fw) { direct.push({ field: fw.key, values: fw.values }); i += fw.used; continue; }

    // (a) multi-word phrase still being typed: "managerial a" -> prefix of "managerial acc"
    if (atTail && remaining >= 2) {
      const phrase = tokens.slice(i).join(" ");
      if (!exactCands(phrase).length) {
        const cands = prefixCands(phrase);
        if (cands.length) { picks.push({ cands, prefix: true, tokens: tokens.slice(i) }); i = tokens.length; continue; }
      }
    }

    // (b) longest exact alias starting here (any enum field)
    let matched = false;
    for (let j = Math.min(lk.maxTokens, remaining); j >= 1; j--) {
      const cands = exactCands(tokens.slice(i, i + j).join(" "));
      if (cands.length) { picks.push({ cands, prefix: false }); i += j; matched = true; break; }
    }
    if (matched) continue;

    // (c) filler words are ignored
    if (lk.fillers.has(tok)) { i++; continue; }

    // (d) last word still being typed: single-token prefix
    if (atTail && remaining === 1) {
      const cands = prefixCands(tok);
      if (cands.length) { picks.push({ cands, prefix: true, tokens: [tok] }); i++; continue; }
      // a field word typed but not yet followed by its value ("schedule level") constrains nothing yet
      if (lk.fieldWords.has(tok)) { i++; continue; }
    }

    // (e) unknown word: kept as a plain text filter, never mapped to a field
    q.text.push(tok);
    i++;
  }

  const add = (field, vals) => {
    const set = q.fields[field] || (q.fields[field] = new Set());
    for (const v of vals) set.add(v);
    q.recognized = true;
  };
  for (const d of direct) add(d.field, d.values);
  for (const p of picks) if (!p.prefix && p.cands.length === 1) add(p.cands[0].field, p.cands[0].codes);
  for (const p of picks) if (!p.prefix && p.cands.length > 1) { const c = p.cands.find((x) => !q.fields[x.field]) || p.cands[0]; add(c.field, c.codes); }
  for (const p of picks) if (p.prefix) {
    const c = p.cands.find((x) => !q.fields[x.field]);
    if (c) { add(c.field, c.codes); q.partial = true; } else q.text.push(...p.tokens);
  }
  return q;
}

// A query built from plain values:  makeQuery({ s: "MA", n: [2, 3], l: 3 })
export function makeQuery(obj = {}, opts = {}) {
  const registry = opts.registry || SEARCH_FIELDS;
  const q = { fields: {}, text: [], partial: false, recognized: false, empty: true, norm: "" };
  for (const [field, value] of Object.entries(obj || {})) {
    const atoms = atomsOf(field, value, { registry });
    if (!atoms.length) continue;
    q.fields[field] = new Set(atoms);
    q.recognized = true; q.empty = false;
  }
  return q;
}

// Search + filters: every constraint applies (AND). Same field in both -> intersection; for
// free-text fields the explicit filter selection wins (a phrase can't be intersected with a phrase).
export function combineConstraints(a = {}, b = {}, opts = {}) {
  const registry = opts.registry || SEARCH_FIELDS;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k], def = ownDef(registry, k);
    if (x && y) out[k] = !def || def.kind === "text" ? new Set(y) : new Set([...x].filter((v) => y.has(v)));
    else out[k] = new Set(x || y);
  }
  return out;
}
export function withFilters(q, filters, opts = {}) {
  const keys = Object.keys(filters || {}).filter((k) => filters[k] && filters[k].size);
  if (!keys.length) return q;
  const picked = {};
  for (const k of keys) picked[k] = filters[k];
  return { ...q, fields: combineConstraints(q.fields, picked, opts), recognized: true, empty: false };
}

// ----------------------------------------------------------------------------
// 11. Matching.  entry = { search_meta, atoms?, hay }  (see makeEntry)
//     Every field present in the query is a constraint; fields absent from the query are ANY.
// ----------------------------------------------------------------------------
const containsPhrase = (haystack, phrase) => (" " + haystack + " ").includes(" " + phrase + " ");

function matchAtoms(act, exp, textual) {
  if (!act || !act.length) return false;
  for (const a of act) {
    if (exp.has(a)) return true;
    if (textual && typeof a === "string") for (const x of exp) if (typeof x === "string" && containsPhrase(a, x)) return true;
  }
  return false;
}

// actual = raw metadata value (scalar or array); expected = Set / array / scalar of atoms
export function matchesField(actual, expected, def = null) {
  if (expected == null) return true;
  const exp = expected instanceof Set ? expected : new Set(Array.isArray(expected) ? expected : [expected]);
  const act = Array.isArray(actual) ? actual : (actual == null ? [] : [actual]);
  const atoms = act.map((x) => atomOf(def, x)).filter((x) => x != null);
  const want = new Set([...exp].map((x) => atomOf(def, x)).filter((x) => x != null));
  return matchAtoms(atoms, want, !def || def.kind === "text");
}

// Entry for the local index; atoms are computed ONCE here, never per keystroke.
export function makeEntry(meta, extra = {}, opts = {}) {
  const sm = normalizeSearchMeta(meta, opts);
  if (!sm) return null;
  const atoms = {};
  for (const k of Object.keys(sm)) atoms[k] = atomsOf(k, sm[k], opts);
  return { ...extra, search_meta: sm, atoms };
}

export function matchEntry(e, q, opts = {}) {
  const registry = opts.registry || SEARCH_FIELDS;
  for (const [field, expected] of Object.entries(q.fields || {})) {
    if (!expected) continue;
    const act = e.atoms ? (e.atoms[field] || []) : atomsOf(field, e.search_meta && e.search_meta[field], { registry });
    const def = ownDef(registry, field);
    if (!matchAtoms(act, expected, !def || def.kind === "text")) return false;
  }
  if (q.text && q.text.length) {
    const hay = e.hay || "";
    for (const w of q.text) if (!hay.includes(w)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// 12. Result engine (pure functions; the Mini App supplies the entries). Configured by SEARCH_VIEW.
// ----------------------------------------------------------------------------
const present = (e, f) => e.atoms ? !!(e.atoms[f] && e.atoms[f].length) : (e.search_meta && e.search_meta[f] != null);
const atomsFor = (e, f, registry) => (e.atoms ? (e.atoms[f] || []) : atomsOf(f, e.search_meta && e.search_meta[f], { registry }));
const layoutOf = (e, view) => view.layouts.find((l) => l.when.every((f) => present(e, f))) || view.layouts[view.layouts.length - 1];

function cartesian(lists) {
  let acc = [[]];
  for (const l of lists) { const next = []; for (const a of acc) for (const x of l) next.push([...a, x]); acc = next; }
  return acc;
}

function valueRank(field, v, dict, registry) {
  const def = ownDef(registry, field);
  if (v == null) return [2, 0, ""];
  if (typeof v === "number") return [0, v, ""];
  if (def && def.kind === "enum" && def.dictionary) {
    const lk = buildLookup(dict, registry);
    const r = lk.order[field] && lk.order[field][v];
    if (r != null) return [0, r, ""];
  }
  return [1, 0, String(v)];
}
function compareRank(a, b) { return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0); }
function compareBy(fields, getVal, dict, registry) {
  return (x, y) => {
    for (const f of fields) { const c = compareRank(valueRank(f, getVal(x, f), dict, registry), valueRank(f, getVal(y, f), dict, registry)); if (c) return c; }
    return 0;
  };
}

// Which "anchor" groups exist (e.g. which subject+number pairs contain a Lecture).
export function buildContext(entries, view = SEARCH_VIEW, registry = SEARCH_FIELDS) {
  const anchors = {};
  for (const layout of view.layouts) {
    if (!layout.anchor) continue;
    const set = (anchors[layout.id] = new Set());
    for (const e of entries) {
      if (layoutOf(e, view) !== layout || !isAnchor(e, layout, registry)) continue;
      for (const combo of cartesian(layout.anchor.keyBy.map((f) => atomsFor(e, f, registry)))) if (combo.length === layout.anchor.keyBy.length) set.add(combo.join("|"));
    }
  }
  return { anchors };
}
function isAnchor(e, layout, registry) {
  return Object.entries(layout.anchor.where).every(([f, v]) => atomsFor(e, f, registry).includes(v));
}

function titleFor(e, bucket, layout, ctx, dict, registry) {
  const meta = { ...(e.search_meta || {}), ...bucket };
  const opts = { dict, registry };
  const anchorKey = layout.anchor ? layout.anchor.keyBy.map((f) => (bucket[f] != null ? bucket[f] : (atomsFor(e, f, registry)[0]))).join("|") : null;
  const anchored = !!(layout.anchor && ctx && ctx.anchors && ctx.anchors[layout.id] && ctx.anchors[layout.id].has(anchorKey) && !isAnchor(e, layout, registry));
  const vars = anchored ? { anchor: renderTemplate(layout.anchor.label, layout.anchor.where, opts) } : {};
  for (const rule of layout.title) {
    if (rule.anchored && !anchored) continue;
    if (rule.when && !rule.when.every((f) => meta[f] != null && meta[f] !== "")) continue;
    const t = renderTemplate(rule.tpl, meta, { ...opts, vars });
    if (t) return t;
  }
  return describeMeta(e.search_meta, dict, registry);       // nothing configured matches: describe whatever fields it has
}

function suffixFor(layout, q, dict, registry) {
  const bits = [];
  for (const f of layout.suffix || []) {
    const set = q.fields && q.fields[f];
    if (!set || !set.size) continue;
    const def = ownDef(registry, f);
    if (def && def.kind === "number") {
      const nums = [...set].filter((x) => typeof x === "number").sort((a, b) => a - b);
      bits.push((def.format || "{v}").replace("{v}", nums.join(", ")));
    } else bits.push([...set].map((v) => displayValue(f, v, "plural", { dict, registry })).join(" / "));
  }
  return bits.length ? " — " + bits.join(" · ") : "";
}

// Returns an ordered list of blocks, ready to render.
//   block = { key, layout, name, suffix, count, showHeadings, groups:[{ key, heading, items:[{ e, bucket, title }] }] }
export function groupResults(matches, q, ctx, dict = SEARCH_DICTIONARY, view = SEARCH_VIEW, registry = SEARCH_FIELDS) {
  const byBlock = new Map();
  for (const e of matches) {
    const layout = layoutOf(e, view);
    const bkey = layout.id + "§" + layout.blockBy.map((f) => atomsFor(e, f, registry).join(",")).join("|");
    if (!byBlock.has(bkey)) byBlock.set(bkey, { layout, bkey, list: [] });
    byBlock.get(bkey).list.push(e);
  }
  const layoutIdx = (l) => view.layouts.indexOf(l);
  const blockVal = (b, f) => { const a = atomsFor(b.list[0], f, registry); return a.length ? a[0] : null; };
  const blocks = [...byBlock.values()].sort((a, b) =>
    (layoutIdx(a.layout) - layoutIdx(b.layout)) || compareBy(a.layout.blockBy, blockVal, dict, registry)(a, b));

  return blocks.map(({ layout, list }) => {
    const first = list[0];
    const bmeta = {};
    for (const f of layout.blockBy) { const a = atomsFor(first, f, registry); if (a.length) bmeta[f] = a[0]; }
    const name = renderSegments(layout.block, bmeta, { dict, registry }) || "Other";

    // an item with several values of a group field appears under each requested (or each of its own) value
    const buckets = new Map();   // key -> { bucket, items: [{e, bucket}] }
    for (const e of list) {
      const per = layout.groupBy.map((f) => {
        const own = atomsFor(e, f, registry), want = q.fields && q.fields[f];
        const vals = own.length ? (want ? own.filter((x) => want.has(x)) : own) : [null];
        return vals.length ? vals : own;
      });
      for (const combo of cartesian(per)) {
        const bucket = {};
        layout.groupBy.forEach((f, k) => { if (combo[k] != null) bucket[f] = combo[k]; });
        const k = layout.groupBy.map((f) => (bucket[f] == null ? "" : String(bucket[f]))).join("|");
        if (!buckets.has(k)) buckets.set(k, { bucket, items: [] });
        buckets.get(k).items.push({ e, bucket });
      }
    }
    const keys = [...buckets.keys()].sort((a, b) => compareBy(layout.groupBy, (x, f) => (buckets.get(x).bucket[f] == null ? null : buckets.get(x).bucket[f]), dict, registry)(a, b));
    const groups = keys.map((k) => {
      const { bucket, items } = buckets.get(k);
      const sorted = items.slice().sort((x, y) => compareBy(layout.sortBy || [], (it, f) => { const a = atomsFor(it.e, f, registry); return a.length ? a[0] : null; }, dict, registry)(x, y) || (x.e.i - y.e.i));
      let heading;
      if (!Object.keys(bucket).length) heading = layout.group.none;
      else {
        const anchorKey = layout.anchor ? layout.anchor.keyBy.map((f) => (bucket[f] != null ? bucket[f] : atomsFor(first, f, registry)[0])).join("|") : null;
        const hasAnchor = !!(layout.anchor && ctx && ctx.anchors && ctx.anchors[layout.id] && ctx.anchors[layout.id].has(anchorKey));
        const vars = hasAnchor ? { anchor: renderTemplate(layout.anchor.label, layout.anchor.where, { dict, registry }) } : {};
        heading = renderTemplate(hasAnchor ? layout.group.anchored : layout.group.plain, { ...bmeta, ...bucket }, { dict, registry, vars }) || layout.group.none;
      }
      return { key: k, heading, items: sorted.map(({ e, bucket: b }) => ({ e, bucket: b, title: titleFor(e, b, layout, ctx, dict, registry) })) };
    });
    const constrained = (layout.flatWhenConstrained || []).some((f) => q.fields && q.fields[f] && q.fields[f].size);
    return { key: layout.id + "§" + layout.blockBy.map((f) => (bmeta[f] == null ? "" : bmeta[f])).join("|"), layout: layout.id, name, suffix: suffixFor(layout, q, dict, registry), count: list.length, showHeadings: !constrained, groups };
  });
}

// ----------------------------------------------------------------------------
// 13. Filters: generated from the registry + the metadata that is actually loaded.
//     getFacets() returns, per field, the values that exist in the CURRENT dataset:
//       mode "chain"   (default)  option lists depend on the filters ABOVE them in the order
//                                 (Level -> Subject -> Type -> Number ...)
//       mode "faceted"            every list depends on all the OTHER filters
//     `base` = constraints coming from the search box, applied to every list.
//     Each facet also says `narrows` (false = a one-value list that every item shares: not worth a dropdown).
// ----------------------------------------------------------------------------
export function orderFields(keys, view = SEARCH_VIEW, registry = SEARCH_FIELDS) {
  const set = new Set(keys), out = [];
  for (const k of view.filters || []) if (set.delete(k)) out.push(k);
  for (const k of Object.keys(registry)) if (set.delete(k)) out.push(k);
  return out.concat([...set].sort());
}

export function discoverFields(entries, opts = {}) {
  const seen = new Set();
  for (const e of entries) for (const k of Object.keys(e.search_meta || {})) seen.add(k);
  return orderFields([...seen], opts.view || SEARCH_VIEW, opts.registry || SEARCH_FIELDS);
}

function passes(e, fields, registry) {
  for (const [field, expected] of Object.entries(fields)) {
    if (!expected) continue;
    const def = ownDef(registry, field);
    if (!matchAtoms(e.atoms ? (e.atoms[field] || []) : atomsOf(field, e.search_meta && e.search_meta[field], { registry }), expected, !def || def.kind === "text")) return false;
  }
  return true;
}

export function getFacets(entries, selected = {}, opts = {}) {
  const registry = opts.registry || SEARCH_FIELDS, dict = opts.dict || SEARCH_DICTIONARY, view = opts.view || SEARCH_VIEW;
  const order = opts.order || discoverFields(entries, { view, registry });
  const mode = opts.mode || "chain";
  const base = opts.base || {};
  const facets = [];
  order.forEach((field, idx) => {
    let cons = { ...base };
    for (const [k, v] of Object.entries(selected)) {
      if (!v || !v.size || k === field) continue;
      const pos = order.indexOf(k);
      if (mode === "faceted" || pos < 0 || pos < idx) cons = combineConstraints(cons, { [k]: v }, { registry });
    }
    const def = ownDef(registry, field);
    const opt = new Map();      // atom -> { value, label, count }
    let pool = 0, covered = 0;  // items under the current constraints / how many of them carry this field
    for (const e of entries) {
      if (!passes(e, cons, registry)) continue;
      pool++;
      if (e.search_meta && e.search_meta[field] != null) covered++;
      const raw = e.search_meta && e.search_meta[field];
      if (raw == null) continue;
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        const a = atomOf(def, v);
        if (a == null) continue;
        if (!opt.has(a)) opt.set(a, { value: a, label: displayValue(field, def && def.kind === "number" ? a : v, "short", { dict, registry }) || String(a), count: 0 });
        opt.get(a).count++;
      }
    }
    if (!opt.size) return;
    const options = [...opt.values()].sort((x, y) => compareRank(valueRank(field, x.value, dict, registry), valueRank(field, y.value, dict, registry)));
    // `narrows`: choosing a value would remove something (several values, or some items lack the field)
    facets.push({ field, label: (def && def.label) || field, selected: selected[field] ? [...selected[field]] : [], options, pool, covered, narrows: options.length > 1 || covered < pool });
  });
  return facets;
}

// ----------------------------------------------------------------------------
// 14. Path derivation: metadata that already lives in the folder tree (Level 3 > Semester 1 > ...)
// ----------------------------------------------------------------------------
const RX_CACHE = new Map();
const rx = (p) => { let r = RX_CACHE.get(p); if (!r) { r = new RegExp(p); RX_CACHE.set(p, r); } return r; };

// names = folder names root -> leaf.  Returns { meta, standalone }:
//   meta        fields derived from the path (never overrides opts.base)
//   standalone  true when a `standalone` rule matched (the path alone classifies the file)
export function derivePathInfo(names, opts = {}) {
  const dict = opts.dict || SEARCH_DICTIONARY, registry = opts.registry || SEARCH_FIELDS, rules = opts.rules || PATH_RULES;
  const base = opts.base || {};
  const lk = buildLookup(dict, registry);
  const folders = (names || []).map((n) => normalizeText(String(n == null ? "" : n).replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, ""))).filter(Boolean);
  const derived = {};
  let standalone = false;
  const known = (f) => atomsOf(f, derived[f] != null ? derived[f] : base[f], { registry });
  for (const rule of rules) {
    if (rule.when && !Object.entries(rule.when).every(([f, vals]) => known(f).some((a) => vals.includes(a)))) continue;
    let found;
    for (const name of folders) {                       // deeper folder wins
      let v;
      if (rule.pattern) {
        const m = rx(rule.pattern).exec(name);
        if (m) v = rule.value ? rule.value.replace(/\$(\d)/g, (_, k) => m[Number(k)] || "") : m[1];
      } else if (rule.dictionary) {
        const map = lk.alias.get(rule.field), codes = map && map.get(name);
        if (codes && codes.size === 1) { const c = [...codes][0]; if (!rule.only || rule.only.includes(c)) v = c; }
      }
      if (v != null) found = v;
    }
    if (found != null) { derived[rule.field] = found; if (rule.standalone) standalone = true; }
  }
  const clean = normalizeSearchMeta(derived, { dict, registry }) || {};
  const meta = {};
  for (const k of Object.keys(clean)) if (base[k] == null) meta[k] = clean[k];
  return { meta, standalone };
}
export const deriveMetaFromPath = (names, opts = {}) => derivePathInfo(names, opts).meta;

// meta typed by the admin + whatever the folder path already says (the admin's values win)
export function completeMetaFromPath(meta, names, opts = {}) {
  const base = normalizeSearchMeta(meta, opts) || {};
  return normalizeSearchMeta({ ...deriveMetaFromPath(names, { ...opts, base }), ...base }, opts);
}
