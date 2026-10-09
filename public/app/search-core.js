// ============================================================================
// Shared search core.
// Admin metadata and explicit `value.field` chains are open-ended: any valid field
// key is accepted and retained in order. SEARCH_FIELDS/SEARCH_DICTIONARY only
// supply backward-compatible natural-language shortcuts such as `ma lec 2`.
// ============================================================================

export const SEARCH_CORE_REV = 3;

export const SEARCH_DICTIONARY = {
  subjects: {
    COST: { name: "Cost Accounting", aliases: ["cost", "cost acc", "cost accounting", "تكاليف", "محاسبة التكاليف"] },
    PF: { name: "Public Finance", aliases: ["pf", "public finance", "public", "المالية العامة"] },
    STA: { name: "Applied Statistics (A)", aliases: ["sta", "stat", "stats", "statistics", "applied stat", "applied statistics", "stat a", "stats a", "statistics a", "applied stat a", "applied statistics a", "احصاء", "الاحصاء"] },
    IEC: { name: "International Economics", aliases: ["iec", "inteco", "international eco", "international economics", "intl eco", "اقتصاد دولي", "الاقتصاد الدولي"] },
    FM: { name: "Financial Management", aliases: ["fm", "financial management", "الادارة المالية"] },
    FI: { name: "Financial Institutions", aliases: ["fi", "financial institutions", "institutions", "المؤسسات المالية"] },
    TAX: { name: "Tax Accounting", aliases: ["tax", "taxes", "tax acc", "tax accounting", "ضرائب", "المحاسبة الضريبية"] },
    AUD: { name: "Auditing & Assurance", aliases: ["aud", "audit", "auditing", "auditing assurance", "auditing and assurance", "المراجعة"] },
    MM: { name: "Material Management", aliases: ["mm", "material", "materials", "material management", "ادارة المواد"] },
    IB: { name: "International Business", aliases: ["ib", "international business", "business", "ادارة الاعمال الدولية"] },
    EDP: { name: "Economic Development & Planning", aliases: ["edp", "economic dev", "economic development", "economic dev planning", "economic development planning", "economic development and planning", "تخطيط", "التنمية الاقتصادية"] },
    STB: { name: "Applied Statistics (B)", aliases: ["stb", "stat", "stats", "statistics", "applied stat", "applied statistics", "stat b", "stats b", "statistics b", "applied stat b", "applied statistics b"] },
    AIS: { name: "Accounting Information Systems", aliases: ["ais", "accounting information systems", "accounting information system", "نظم المعلومات المحاسبية"] },
    FR: { name: "Financial Reporting", aliases: ["fr", "financial reporting", "reporting", "التقارير المالية"] },
    CSYS: { name: "Cost Accounting Systems", aliases: ["csys", "cost", "cost sys", "cost system", "cost systems", "cost acc sys", "cost accounting sys", "cost accounting system", "cost accounting systems"] },
    MA: { name: "Managerial Accounting", aliases: ["ma", "managerial", "managerial acc", "managerial accounting", "management accounting", "محاسبة ادارية"] },
    AMA: { name: "Advanced Managerial Accounting", aliases: ["ama", "adv ma", "adv managerial", "adv managerial acc", "adv managerial accounting", "advanced managerial", "advanced managerial acc", "advanced managerial accounting", "advanced ma"] },
    ACST: { name: "Accounting Studies", aliases: ["acst", "accounting studies", "دراسات محاسبية", "دراسات"] }
  },
  types: {
    LEC: { label: "Lecture", plural: "Lectures", order: 1, aliases: ["lec", "lecs", "lecture", "lectures", "محاضرة", "محاضرات"] },
    REC: { label: "Record", plural: "Records", order: 2, aliases: ["rec", "recs", "record", "records", "recording", "recordings", "تسجيل", "تسجيلات"] },
    SEC: { label: "Section", plural: "Sections", order: 3, aliases: ["sec", "secs", "section", "sections", "سكشن", "سيكشن"] },
    SUMMARY: { label: "Summary", plural: "Summaries", order: 4, aliases: ["summary", "summ", "sum", "summaries", "ملخص", "ملخصات"] },
    QUESTIONS: { label: "Questions", plural: "Questions", order: 5, aliases: ["question", "questions", "qs", "اسئلة", "سؤال"] },
    REVIEW: { label: "Review", plural: "Reviews", order: 6, aliases: ["review", "reviews", "revision", "rev", "مراجعة"] },
    ASSIGNMENT: { label: "Assignment", plural: "Assignments", order: 7, aliases: ["assignment", "assignments", "asg", "hw", "homework", "تكليف"] },
    QUIZ: { label: "Quiz", plural: "Quizzes", order: 8, aliases: ["quiz", "quizzes", "كويز"] },
    EXAM: { label: "Exam", plural: "Exams", order: 9, aliases: ["exam", "exams", "امتحان", "امتحانات"] },
    NOTES: { label: "Notes", plural: "Notes", order: 10, aliases: ["note", "notes"] },
    BOOK: { label: "Book", plural: "Books", order: 11, aliases: ["book", "books", "كتاب", "كتب"] },
    COURSE: { label: "Course", plural: "Courses", order: 12, aliases: ["course", "courses", "crs", "كورس", "كورسات"] },
    SCHEDULE: { label: "Class Schedule", plural: "Class Schedules", order: 13, aliases: ["schedule", "schedules", "class schedule", "class schedules", "جدول", "جداول", "جدول المحاضرات"] },
    APPENDIX: { label: "Appendix", plural: "Appendices", order: 14, aliases: ["appendix", "appendices", "ملحق", "ملاحق"] }
  },
  variants: {
    HALLS: { label: "By halls", aliases: ["halls", "hall", "by halls"] },
    GROUPS: { label: "By groups", aliases: ["groups", "group", "by groups"] },
    SECTIONS: { label: "By sections", aliases: ["sections", "section groups", "by sections"] },
    MIDTERM: { label: "Midterm", aliases: ["midterm", "mid term", "mid-term"] },
    FINAL: { label: "Final", aliases: ["final", "final exam", "finals"] }
  },
  fillers: ["the", "of", "for", "and", "in", "no", "num", "#"]
};

// `role` controls optional presentation semantics only. Parser, normalization,
// serialization, and matching are all generic over every registry entry.
export const SEARCH_FIELDS = {
  s: { label: "Subject", kind: "enum", dictionary: "subjects", role: "subject", aliases: ["subj", "subject"], order: 10 },
  t: { label: "Type", kind: "enum", dictionary: "types", role: "type", aliases: ["type"], order: 20 },
  n: { label: "Number", kind: "number", role: "number", aliases: ["no", "num", "number"], bare: true, order: 30 },
  l: { label: "Level", kind: "number", role: "level", aliases: ["level", "lvl"], barePrefix: true, order: 40 },
  sem: { label: "Semester", kind: "number", role: "semester", aliases: ["semester", "term", "sem"], order: 50 },
  v: { label: "Variant", kind: "enum", dictionary: "variants", role: "variant", aliases: ["variant", "edition"], order: 60 }
};

export const MAX_NUMBER = 999;
const MAX_RANGE_ITEMS = 60;
const tokensOf = (norm) => (norm ? norm.split(" ") : []);

export function normalizeText(input) {
  let s = String(input == null ? "" : input);
  try { s = s.normalize("NFKC"); } catch (_) {}
  return s.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .toLowerCase().replace(/\p{M}+/gu, "").replace(/\u0640/g, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627").replace(/\u0649/g, "\u064A").replace(/\u0629/g, "\u0647")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/\s+/g, " ").trim();
}

function fieldEntries() { return Object.entries(SEARCH_FIELDS).sort((a, b) => (a[1].order ?? 1000) - (b[1].order ?? 1000)); }
export function fieldKeyForRole(role) { return fieldEntries().find(([, d]) => d.role === role)?.[0] || null; }
export function fieldLabel(key) { return SEARCH_FIELDS[key]?.label || key; }

const LOOKUP_CACHE = new WeakMap();
function fieldRegistrySignature() {
  return JSON.stringify(fieldEntries().map(([key, def]) => [key, def.label, def.kind, def.dictionary, def.role, def.order, def.aliases, !!def.bare, !!def.barePrefix]));
}
function addAlias(map, alias, code) {
  const key = normalizeText(alias);
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(code);
}
function aliasesForValue(code, value) { return [code, value?.label, value?.name, ...(value?.aliases || [])].filter(Boolean); }

export function buildLookup(dict = SEARCH_DICTIONARY) {
  const signature = fieldRegistrySignature();
  const cached = LOOKUP_CACHE.get(dict);
  if (cached && cached.signature === signature) return cached.lookup;
  const valueMaps = {}, valueAliasLists = {}, fieldCues = new Map(), fieldDefByAlias = new Map();
  let maxTokens = 1;
  const subj = new Map(), type = new Map();
  const subjectOrder = {}, typeOrder = {};

  for (const [key, def] of fieldEntries()) {
    for (const alias of [key, ...(def.aliases || [])]) {
      const normalized = normalizeText(alias);
      // Single-character field names are syntax labels, not natural-language cues.
      if (normalized && normalized.length > 1) {
        if (!fieldCues.has(normalized)) fieldCues.set(normalized, key);
        fieldDefByAlias.set(normalized, key);
      }
    }
    if (def.kind !== "enum") continue;
    const values = dict[def.dictionary] || {};
    const map = new Map();
    const valueCodes = Object.keys(values);
    valueCodes.forEach((code, i) => {
      for (const alias of aliasesForValue(code, values[code])) addAlias(map, alias, code);
      if (def.role === "subject") subjectOrder[code] = i;
      if (def.role === "type") typeOrder[code] = Number(values[code].order) || (100 + i);
    });
    valueMaps[key] = map;
    valueAliasLists[key] = [...map.entries()];
    for (const alias of map.keys()) maxTokens = Math.max(maxTokens, tokensOf(alias).length);
  }
  const fillers = new Set((dict.fillers || []).map(normalizeText).filter(Boolean));
  for (const alias of fieldCues.keys()) maxTokens = Math.max(maxTokens, tokensOf(alias).length);
  const lk = { subj: valueMaps.s || subj, type: valueMaps.t || type, valueMaps, valueAliasLists, fieldCues, fieldDefByAlias, fillers, maxTokens, typeOrder, subjectOrder, subjAliasList: valueAliasLists.s || [], typeAliasList: valueAliasLists.t || [] };
  LOOKUP_CACHE.set(dict, { signature, lookup: lk });
  return lk;
}

export function validateDictionary(dict = SEARCH_DICTIONARY) {
  const problems = [], lk = buildLookup(dict);
  for (const [alias] of lk.subj) {
    if (lk.type.has(alias)) problems.push(`alias "${alias}" is both a subject and a type`);
    if (lk.fillers.has(alias)) problems.push(`alias "${alias}" is also a filler word`);
  }
  for (const alias of lk.type.keys()) if (lk.fillers.has(alias)) problems.push(`type alias "${alias}" is also a filler word`);
  for (const [alias, codes] of lk.type) if (codes.size > 1) problems.push(`type alias "${alias}" maps to several types: ${[...codes].join(", ")}`);
  return problems;
}

export function canonNumbers(value) {
  const values = (Array.isArray(value) ? value : [value]).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= MAX_NUMBER);
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted.length === 1 ? sorted[0] : sorted;
}
export const metaNumbers = (meta) => {
  const key = fieldKeyForRole("number") || fieldEntries().find(([, def]) => def.kind === "number")?.[0];
  const value = key && meta ? meta[key] : null;
  return value == null ? null : (Array.isArray(value) ? value : [value]);
};
export function formatNumbers(n) {
  const values = metaNumbers({ n });
  if (!values?.length) return "";
  if (values.length === 1) return String(values[0]);
  return values.every((x, i) => i === 0 || x === values[i - 1] + 1) ? `${values[0]}–${values[values.length - 1]}` : values.join(", ");
}

// Metadata field names are intentionally open-ended. SEARCH_FIELDS is only for the
// legacy natural-language shortcuts and optional presentation labels. Object order
// is meaningful: the admin defines a left-to-right chain in the search name.
function sortedMetaKeys(meta) { return Object.keys(meta || {}); }
export function orderedSearchMeta(meta, dict = SEARCH_DICTIONARY) {
  const clean = normalizeSearchMeta(meta, dict);
  return clean || null;
}
function cleanGenericMetaValue(value) {
  if (value == null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const clean = value.trim().slice(0, 160);
    return clean ? clean : undefined;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (Array.isArray(item) || (item && typeof item === "object")) continue;
      const v = cleanGenericMetaValue(item);
      if (v === undefined) continue;
      if (!out.some(x => typeof x === typeof v && String(x) === String(v))) out.push(v);
    }
    return out.length ? (out.length === 1 ? out[0] : out) : undefined;
  }
  return undefined;
}
export function normalizeSearchMeta(meta, dict = SEARCH_DICTIONARY) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out = {};
  for (const [sourceKey, value] of Object.entries(meta)) {
    const key = String(sourceKey).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key)) continue;
    const normalized = cleanGenericMetaValue(value);
    if (normalized !== undefined) out[key] = normalized;
  }
  return Object.keys(out).length ? out : null;
}

export function subjectName(code, dict = SEARCH_DICTIONARY) { return dict.subjects?.[code]?.name || dict.subjects?.[String(code || "").toUpperCase()]?.name || String(code || ""); }
export function typeLabel(code, plural = false, dict = SEARCH_DICTIONARY) {
  const item = dict.types?.[code] || dict.types?.[String(code || "").toUpperCase()];
  return item ? (plural ? item.plural || item.label : item.label) : String(code || "");
}
function enumLabel(key, value, dict = SEARCH_DICTIONARY) {
  const def = SEARCH_FIELDS[key];
  const item = def?.dictionary ? (dict[def.dictionary]?.[value] || dict[def.dictionary]?.[String(value ?? "").toUpperCase()]) : null;
  return item?.label || item?.name || String(value ?? "");
}
function printableFieldValue(key, value) {
  if (value == null) return "";
  if (SEARCH_FIELDS[key]?.kind === "number") {
    const nums = (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (nums.length > 1 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `${nums[0]}–${nums[nums.length - 1]}`;
    return nums.length ? nums.join(", ") : String(value);
  }
  return Array.isArray(value) ? value.join(", ") : String(value);
}
export function describeMeta(meta, dict = SEARCH_DICTIONARY) {
  const clean = normalizeSearchMeta(meta, dict);
  return clean ? metaToSyntax(clean) : "—";
}
function genericValueToSyntax(value) {
  if (Array.isArray(value)) {
    if (value.every(v => Number.isInteger(Number(v)) && String(v).trim() !== "")) {
      const nums = [...new Set(value.map(Number))].sort((a, b) => a - b);
      if (nums.length > 1 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)) return `${nums[0]}-${nums[nums.length - 1]}`;
      return nums.join(",");
    }
    return `[${value.map(String).join("|")}]`;
  }
  const raw = String(value);
  return /^[^\s.\[\]]+$/.test(raw) ? raw : `[${raw.replace(/\]/g, "\\]")}]`;
}
export function metaToSyntax(meta) {
  const clean = normalizeSearchMeta(meta);
  if (!clean) return "";
  return Object.entries(clean).map(([key, value]) => `${genericValueToSyntax(value)}.${key}`).join(" ");
}

export function parseNumberSpec(raw) {
  const norm = String(raw == null ? "" : raw).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[\u060C\u061B;،]/g, ",").replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!norm) return { ok: false, error: "the number is empty" };
  const out = [];
  for (const part of norm.split(",")) {
    if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split("-").map(Number);
      if (a > b || b > MAX_NUMBER || b - a + 1 > MAX_RANGE_ITEMS) return { ok: false, error: `invalid range "${part}"` };
      for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part); if (n > MAX_NUMBER) return { ok: false, error: `number must be between 0 and ${MAX_NUMBER}` }; out.push(n);
    } else return { ok: false, error: `invalid number "${part}"` };
  }
  const n = canonNumbers(out);
  return n == null ? { ok: false, error: "no valid number found" } : { ok: true, n };
}

function resolveUnique(map, raw, what, dict = SEARCH_DICTIONARY) {
  const key = normalizeText(raw), codes = map?.get(key);
  if (!codes?.size) return { ok: false, error: `unknown ${what} "${raw}"` };
  if (codes.size > 1) return { ok: false, error: `ambiguous ${what} "${raw}" (${[...codes].join(", ")}) — use the exact code` };
  return { ok: true, code: [...codes][0] };
}
function parseGenericNumericList(value) {
  const normalized = String(value).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!/^\d+(?:[-,]\d+)+$/.test(normalized)) return null;
  const out = [];
  for (const part of normalized.split(",")) {
    if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split("-").map(Number);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a || b - a + 1 > MAX_RANGE_ITEMS) return null;
      for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part); if (!Number.isSafeInteger(n)) return null; out.push(n);
    } else return null;
  }
  const values = [...new Set(out)].sort((a, b) => a - b);
  return values.length === 1 ? values[0] : values;
}
function parseGenericSyntaxValue(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return undefined;
  if (value.includes("|")) {
    const parts = value.split("|").map(x => x.trim()).filter(Boolean);
    return parts.length > 1 ? parts : (parts[0] || undefined);
  }
  if (/^\d+$/.test(value)) { const n = Number(value); return Number.isSafeInteger(n) ? n : value.slice(0, 160); }
  const numericList = parseGenericNumericList(value);
  if (numericList != null) return numericList;
  return value.slice(0, 160);
}
function parseFieldSyntaxTokens(text) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  const re = /(?:\[([^\]]+)\]|([^\s.\[\]]+))\s*\.\s*([A-Za-z][A-Za-z0-9_-]{0,31})/g;
  const meta = {}; const seen = new Set(); let m; let rest = src; let count = 0;
  while ((m = re.exec(src))) {
    const key = String(m[3]).toLowerCase();
    const value = parseGenericSyntaxValue(m[1] !== undefined ? m[1] : m[2]);
    if (value === undefined) return { ok: false, error: `empty value for field ".${key}"` };
    if (seen.has(key)) return { ok: false, error: `field ".${key}" appears twice; combine its values in one value` };
    seen.add(key); meta[key] = value; count++;
    rest = rest.replace(m[0], " ");
  }
  if (!count) return { ok: false, error: "no value.field parts found" };
  if (rest.replace(/[\s,]+/g, "")) return { ok: false, error: `unexpected text "${rest.trim().slice(0, 40)}" — use value.field, e.g. ma.s rec.t 1.n` };
  return { ok: true, meta: orderedSearchMeta(meta) };
}
export function parseAdminSyntax(text, dict = SEARCH_DICTIONARY) {
  return parseFieldSyntaxTokens(text);
}
function looksLikeFieldSyntax(text) {
  return /(?:\[[^\]]+\]|[^\s.\[\]]+)\s*\.\s*[A-Za-z][A-Za-z0-9_-]{0,31}(?=$|\s)/.test(String(text == null ? "" : text).trim());
}

export function parseAdminSearchInput(text, dict = SEARCH_DICTIONARY) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return { ok: false, error: "empty" };
  if (src.includes("[") || looksLikeFieldSyntax(src)) {
    const r = parseAdminSyntax(src, dict);
    return r.ok ? { ok: true, meta: normalizeSearchMeta(r.meta, dict), name: src.slice(0, 120) } : r;
  }
  const q = parseQuery(src + " ", { dict });
  if (q.text.length) return { ok: false, error: `unknown word "${q.text[0]}" — use value.field syntax such as ma.s rec.t 1.n` };
  for (const [key, def] of fieldEntries()) {
    if (q[key] && q[key].size > 1) {
      if (def.kind === "number") return { ok: false, error: `write several ${def.label.toLowerCase()} values as a range/list in admin syntax` };
      return { ok: false, error: `the ${def.label.toLowerCase()} is ambiguous (${[...q[key]].join(", ")}) — use the exact code` };
    }
  }
  const meta = {};
  for (const [key, def] of fieldEntries()) if (q[key]?.size) meta[key] = [...q[key]][0];
  const clean = normalizeSearchMeta(meta, dict);
  if (!clean) return { ok: false, error: "nothing recognized — use value.field syntax such as ma.s rec.t 1.n" };
  return { ok: true, meta: clean, name: src.slice(0, 120) };
}
export function codesHelpText(dict = SEARCH_DICTIONARY) {
  const subjects = Object.entries(dict.subjects || {}).map(([code, v]) => `${code} — ${v.name}`).join("\n");
  const types = Object.entries(dict.types || {}).map(([code, v]) => `${code} — ${v.label}`).join("\n");
  return "Known subjects (for natural search):\n" + subjects + "\n\nKnown content types (for natural search):\n" + types + "\n\nCustom search names use VALUE.FIELD. Field keys are yours to choose and do not need registration.\nExamples: ma.s rec.t 1.n\n[Class Schedule].t 3.l 1.sem\nValues with spaces go in [square brackets].\nFields are matched together in the order you write them, from left to right.";
}

function mapValueAt(map, tokens, i, remaining, typing, maxTokens) {
  const atTail = typing && remaining <= maxTokens;
  for (let j = Math.min(maxTokens, remaining); j >= 1; j--) {
    const phrase = tokens.slice(i, i + j).join(" "), hit = map.get(phrase);
    if (hit) return { codes: hit, length: j, partial: false };
  }
  if (atTail) {
    for (let j = Math.min(maxTokens, remaining); j >= 1; j--) {
      const phrase = tokens.slice(i, i + j).join(" ");
      const found = new Set();
      for (const [alias, codes] of map) if (alias.startsWith(phrase)) for (const code of codes) found.add(code);
      if (found.size) return { codes: found, length: j, partial: true };
    }
  }
  return null;
}
function searchableValueAppearsLater(tokens, from, lk) {
  const maps = Object.values(lk.valueMaps || {});
  for (let i = from; i < tokens.length; i++) {
    for (let len = Math.min(lk.maxTokens, tokens.length - i); len > 0; len--) {
      const phrase = tokens.slice(i, i + len).join(" ");
      if (maps.some(map => map.has(phrase))) return true;
    }
  }
  return false;
}
function qAdd(q, key, values) { q[key] = q[key] || new Set(); for (const v of values) q[key].add(v); q.recognized = true; }
function queryFromStructuredSyntax(parsed, norm = "") {
  const q = { text: [], partial: false, recognized: true, empty: false, norm, fieldOrder: Object.keys(parsed.meta) };
  for (const [key, value] of Object.entries(parsed.meta)) q[key] = new Set(Array.isArray(value) ? value : [value]);
  return q;
}
export function parseQuery(raw, opts = {}) {
  const dict = opts.dict || SEARCH_DICTIONARY, rawStr = String(raw == null ? "" : raw);
  // Explicit value.field chains use arbitrary field keys, independently from natural-query defaults.
  if (looksLikeFieldSyntax(rawStr)) {
    const parsed = parseFieldSyntaxTokens(rawStr);
    if (parsed.ok) return queryFromStructuredSyntax(parsed, normalizeText(rawStr));
  }
  const lk = buildLookup(dict), norm = normalizeText(rawStr), tokens = tokensOf(norm);
  const typing = opts.typing != null ? !!opts.typing : !/\s$/.test(rawStr);
  const q = { text: [], partial: false, recognized: false, empty: !tokens.length, norm };
  for (const [key] of fieldEntries()) q[key] = null;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i], remaining = tokens.length - i;

    // Explicit field cue, e.g. "level 3", "sem 1", "variant halls", "doctor tamer".
    let cue = lk.fieldCues.get(tok), cueLength = 1;
    if (!cue && typing && remaining > 1) {
      for (let len = Math.min(lk.maxTokens, remaining - 1); len > 1; len--) {
        const phrase = tokens.slice(i, i + len).join(" "), f = lk.fieldCues.get(phrase);
        if (f) { cue = f; cueLength = len; break; }
      }
    }
    if (cue) {
      const def = SEARCH_FIELDS[cue], valueStart = i + cueLength;
      if (valueStart < tokens.length) {
        if (def.kind === "number" && /^\d+$/.test(tokens[valueStart])) {
          const val = Number(tokens[valueStart]); if (val <= MAX_NUMBER) qAdd(q, cue, [val]); else q.text.push(tokens[valueStart]);
          i = valueStart + 1; continue;
        }
        if (def.kind === "enum") {
          const map = lk.valueMaps[cue];
          const found = mapValueAt(map || new Map(), tokens, valueStart, tokens.length - valueStart, typing, lk.maxTokens);
          if (found) { qAdd(q, cue, found.codes); if (found.partial) q.partial = true; i = valueStart + found.length; continue; }
        }
        if (def.kind === "text") { qAdd(q, cue, [tokens[valueStart]]); i = valueStart + 1; continue; }
      }
      // Keep an incomplete cue as text rather than swallowing it.
      q.text.push(...tokens.slice(i, valueStart)); i = valueStart; continue;
    }

    let matchedPhrase = false;
    // While the final multi-word phrase is being typed, prefer one partial alias
    // over splitting it into several independent words ("managerial a" -> MA).
    const atTail = typing && remaining <= lk.maxTokens;
    if (atTail && remaining >= 2) {
      const phrase = tokens.slice(i).join(" ");
      const exactExists = fieldEntries().some(([key, def]) => def.kind === "enum" && lk.valueMaps[key]?.has(phrase));
      if (!exactExists) {
        const priority = (def) => def.role === "subject" ? -10 : def.role === "type" ? -5 : 0;
        const ordered = fieldEntries().filter(([, def]) => def.kind === "enum").sort((a, b) => priority(a[1]) - priority(b[1]));
        for (const [key] of ordered) {
          const map = lk.valueMaps[key], found = new Set();
          for (const [alias, codes] of map || []) if (alias.startsWith(phrase)) for (const code of codes) found.add(code);
          if (found.size) { qAdd(q, key, found); q.partial = true; i = tokens.length; matchedPhrase = true; break; }
        }
        if (matchedPhrase) continue;
      }
    }

    // Numbers without an explicit cue: a leading number before a subject denotes Level;
    // otherwise preserve the existing rule that numbers constrain the item's number.
    if (/^\d+$/.test(tok)) {
      const value = Number(tok);
      if (value <= MAX_NUMBER) {
        const levelKey = i === 0 ? fieldEntries().find(([key, def]) => def.barePrefix && searchableValueAppearsLater(tokens, i + 1, lk))?.[0] : null;
        const numberKey = fieldEntries().find(([, def]) => def.bare)?.[0] || fieldKeyForRole("number") || fieldEntries().find(([, def]) => def.kind === "number")?.[0];
        qAdd(q, levelKey || numberKey, [value]);
      } else q.text.push(tok);
      i++; continue;
    }

    // Parse field values naturally. Subject first preserves deliberate subject aliases such as "cost".
    let matched = false;
    const priority = (def) => def.role === "subject" ? -10 : def.role === "type" ? -5 : 0;
    const valueFieldOrder = fieldEntries().filter(([, def]) => def.kind === "enum").sort((a, b) => priority(a[1]) - priority(b[1]));
    for (const [key] of valueFieldOrder) {
      const map = lk.valueMaps[key];
      const found = mapValueAt(map || new Map(), tokens, i, remaining, typing, lk.maxTokens);
      if (!found) continue;
      // If "cost" resolves to a subject, don't reinterpret the same phrase as another enum field.
      qAdd(q, key, found.codes); if (found.partial) q.partial = true;
      i += found.length; matched = true; break;
    }
    if (matched) continue;
    if (lk.fillers.has(tok)) { i++; continue; }
    q.text.push(tok); i++;
  }
  return q;
}

function valueForEntry(e, key) {
  if (e?.meta && Object.prototype.hasOwnProperty.call(e.meta, key)) return e.meta[key];
  return e?.[key];
}
function valuesOverlap(actual, expectedSet, key, q) {
  if (actual == null) return false;
  const vals = Array.isArray(actual) ? actual : [actual];
  for (const value of vals) {
    for (const expected of expectedSet) {
      if (String(value) === String(expected)) return true;
      if (normalizeText(value) && normalizeText(value) === normalizeText(expected)) return true;
      if (Number.isFinite(Number(value)) && Number.isFinite(Number(expected)) && String(value).trim() !== "" && String(expected).trim() !== "" && Number(value) === Number(expected)) return true;
      // Natural-language aliases are only a convenience layer for the old shortcut search.
      // Explicit value.field matching stays strictly generic and never reinterprets values.
      if (!q?.fieldOrder && SEARCH_FIELDS[key]?.kind === "enum") {
        const map = buildLookup().valueMaps[key];
        const actualCodes = map?.get(normalizeText(value));
        const expectedCodes = map?.get(normalizeText(expected));
        if (actualCodes && expectedCodes && [...actualCodes].some(code => expectedCodes.has(code))) return true;
      }
      if (SEARCH_FIELDS[key]?.kind === "text" && normalizeText(value).includes(normalizeText(expected))) return true;
    }
  }
  return false;
}
export function matchEntry(e, q) {
  // Check the explicitly supplied chain first, in the exact left-to-right order entered.
  // Remaining Set-valued constraints are natural-language search fields.
  const checked = new Set();
  const order = Array.isArray(q?.fieldOrder) ? q.fieldOrder : [];
  for (const key of order) {
    const expected = q[key];
    if (!(expected instanceof Set)) continue;
    checked.add(key);
    if (!valuesOverlap(valueForEntry(e, key), expected, key, q)) return false;
  }
  for (const [key, expected] of Object.entries(q || {})) {
    if (!(expected instanceof Set) || checked.has(key)) continue;
    if (!valuesOverlap(valueForEntry(e, key), expected, key, q)) return false;
  }
  if (q.text?.length) {
    const hay = e.hay || "";
    for (const word of q.text) if (!hay.includes(word)) return false;
  }
  return true;
}

export function buildContext(entries) {
  const lec = new Set(), subjectKey = fieldKeyForRole("subject"), typeKey = fieldKeyForRole("type"), numberKey = fieldKeyForRole("number");
  for (const e of entries) {
    const type = valueForEntry(e, typeKey), nums = valueForEntry(e, numberKey), subject = valueForEntry(e, subjectKey) || "";
    if (String(type || "").toUpperCase() === "LEC" && nums != null) for (const n of Array.isArray(nums) ? nums : [nums]) lec.add(subject + "|" + n);
  }
  return { lec };
}
function itemTitle(e, n, ctx, dict) {
  const typeKey = fieldKeyForRole("type"), subjectKey = fieldKeyForRole("subject"), numberKey = fieldKeyForRole("number");
  const type = valueForEntry(e, typeKey), subject = valueForEntry(e, subjectKey) || "", label = type ? enumLabel(typeKey, type, dict) : "", num = n != null ? String(n) : "";
  if (!type) return num ? "#" + num : "Item";
  if (String(type || "").toUpperCase() === "LEC") return num ? `${label} ${num}` : label;
  if (num && ctx?.lec?.has(subject + "|" + n)) return `Lecture ${num} ${label}`;
  return num ? `${label} ${num}` : label;
}
function entryNumbers(entry) {
  const key = fieldKeyForRole("number");
  const value = valueForEntry(entry, key);
  return value == null ? null : (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isFinite);
}
function genericHeadingForNoSubject(entry, dict) {
  const typeKey = fieldKeyForRole("type"), type = valueForEntry(entry, typeKey);
  if (type) return enumLabel(typeKey, type, dict);
  for (const [key, def] of fieldEntries()) if (def.kind === "enum" && valueForEntry(entry, key) != null) return `${def.label}: ${enumLabel(key, valueForEntry(entry, key), dict)}`;
  return "Other";
}
export function groupResults(matches, q, ctx, dict = SEARCH_DICTIONARY) {
  // A value.field query is deliberately rendered generically. Do not assume that
  // any custom field means subject/type/number; those semantics belong only to the
  // optional plain-language shortcut mode below.
  if (Array.isArray(q?.fieldOrder) && q.fieldOrder.length) {
    const queryMeta = {};
    for (const key of q.fieldOrder) {
      const set = q[key];
      if (set instanceof Set) queryMeta[key] = set.size === 1 ? [...set][0] : [...set];
    }
    const queryLabel = metaToSyntax(queryMeta);
    const items = matches.map(e => ({ e, n: null, title: String(e?.f?.nm || (e?.f?.c ? String(e.f.c).split("\n")[0] : "") || e?.f?.t || "File") }));
    return [{ s: "", name: "Search results", suffix: queryLabel ? " — " + queryLabel : "", count: matches.length, showHeadings: false, groups: [{ key: "", heading: "Results", items }] }];
  }
  const lk = buildLookup(dict), subjectKey = fieldKeyForRole("subject"), typeKey = fieldKeyForRole("type"), numberKey = fieldKeyForRole("number");
  const bySubject = new Map();
  for (const entry of matches) {
    const subject = valueForEntry(entry, subjectKey) || "";
    const key = subject || `@${genericHeadingForNoSubject(entry, dict)}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(entry);
  }
  const subjects = [...bySubject.keys()].sort((a, b) => {
    const aa = a.startsWith("@"), bb = b.startsWith("@");
    if (aa !== bb) return aa ? 1 : -1;
    return (lk.subjectOrder[a] ?? 999) - (lk.subjectOrder[b] ?? 999) || a.localeCompare(b);
  });
  const showHeadings = !q[typeKey] && !q[numberKey];
  const blocks = [];
  for (const subject of subjects) {
    const list = bySubject.get(subject), subjectCode = subject.startsWith("@") ? "" : subject;
    const buckets = new Map();
    for (const entry of list) {
      const allNumbers = entryNumbers(entry), wanted = q[numberKey];
      const nums = allNumbers?.length ? (wanted ? allNumbers.filter(x => wanted.has(x)) : allNumbers) : [null];
      for (const n of nums) {
        const key = n == null ? "" : String(n);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ e: entry, n });
      }
    }
    const keys = [...buckets.keys()].sort((a, b) => a === "" ? 1 : b === "" ? -1 : Number(a) - Number(b));
    const groups = keys.map(key => {
      const items = buckets.get(key).sort((a, b) => (lk.typeOrder[valueForEntry(a.e, typeKey)] ?? 999) - (lk.typeOrder[valueForEntry(b.e, typeKey)] ?? 999) || ((a.e.i ?? 0) - (b.e.i ?? 0)))
        .map(({ e, n }) => ({ e, n, title: itemTitle(e, n, ctx, dict) }));
      const hasLecture = key !== "" && ctx?.lec?.has((subjectCode || "") + "|" + key);
      return { key, heading: key === "" ? "General" : hasLecture ? `Lecture ${key}` : `#${key}`, items };
    });
    const bits = [];
    if (q[typeKey] && subjectCode) bits.push([...q[typeKey]].map(code => typeLabel(code, true, dict)).join(" / "));
    if (q[numberKey]) bits.push("#" + [...q[numberKey]].sort((a, b) => a - b).join(", "));
    for (const [key, def] of fieldEntries()) {
      if (key === subjectKey || key === typeKey || key === numberKey || !q[key]) continue;
      bits.push(`${def.label}: ${[...q[key]].map(v => printableFieldValue(key, v)).join(", ")}`);
    }
    const knownKeys = new Set(fieldEntries().map(([key]) => key));
    for (const key of (q.fieldOrder || Object.keys(q))) {
      if (knownKeys.has(key) || !(q[key] instanceof Set)) continue;
      bits.push(`${key}: ${[...q[key]].map(v => String(v)).join(", ")}`);
    }
    let name = subjectCode ? subjectName(subjectCode, dict) : (list.length ? genericHeadingForNoSubject(list[0], dict) : "Other");
    // A type-only heading is already the block name; don't repeat it as a suffix.
    if (!subjectCode && q[typeKey]) name = [...q[typeKey]].map(code => enumLabel(typeKey, code, dict)).join(" / ");
    blocks.push({ s: subjectCode, name, suffix: bits.length ? " — " + bits.join(" · ") : "", count: list.length, showHeadings, groups });
  }
  return blocks;
}
