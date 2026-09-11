import { normalize } from "./text.js";

const HOSPITAL_EMPLOYER = /hospital|local health (district|network)|\blhd\b|\blhn\b|health service\b|\bhhs\b|regional health|district health/i;
const HOSPITAL_TITLE = /hospital|inpatient|\bwards?\b|\bacute\b|sub-?acute|cardiac rehab|pulmonary rehab|cardiopulmonary|rehabilitation (unit|ward|centre)/i;
const HOSPITAL_PHRASE = /\b(public|private|our|regional|district|base|rural)\s+hospitals?\b|hospital and health service|local health (district|network)/i;
const HOSPITAL_WORD = /\bhospitals?\b/gi;
const SETTING_WORDS = /\binpatients?\b|\bwards?\b|\bacute\b|sub-?acute|outpatient clinic|hospital in the home|\bmultidisciplinary\b/gi;

const hasAny = (text, words) => words.some((w) => text.includes(w.toLowerCase()));

export function titleMatches(title = "", cfg) {
  const t = title.toLowerCase();
  if (!hasAny(t, cfg.titleKeywords) || hasAny(t, cfg.titleExclude)) return false;
  // Soft exclusions only bite when the title isn't clearly an EP role,
  // so "Exercise Physiologist / Registered Nurse" still gets through.
  return t.includes("exercise physiolog") || !hasAny(t, cfg.titleExcludeUnlessEp);
}

// Generic titles ("Allied Health Clinician") that are worth opening; kept only if the ad mentions EPs.
export const broadTitleMatch = (title = "", cfg) =>
  hasAny(title.toLowerCase(), cfg.broadTitleKeywords) && !hasAny(title.toLowerCase(), cfg.titleExclude);
export const mentionsEp = (text = "") => /exercise physiolog/i.test(text);

// Heuristic evidence that a role is hospital-based. Used on its own when AI is off,
// and to decide which listings are worth an AI check when it's on.
export function hospitalScore(job, cfg) {
  const reasons = [];
  let score = 0;
  const employer = job.company ?? "";
  const known = cfg.hospitalEmployers.find((k) => employer.toLowerCase().includes(k.toLowerCase()));
  if (known || HOSPITAL_EMPLOYER.test(employer)) {
    score += 3;
    reasons.push(`employer looks like a hospital or health service`);
  }
  if (HOSPITAL_TITLE.test(job.title ?? "")) {
    score += 2;
    reasons.push("title mentions a hospital setting");
  }
  const text = job.description ?? "";
  if (HOSPITAL_PHRASE.test(text)) {
    score += 2;
    reasons.push("ad describes the employer's own hospital or health service");
  }
  const mentions = (text.match(HOSPITAL_WORD) ?? []).length;
  if (mentions) {
    score += Math.min(mentions, 3);
    reasons.push(`ad mentions "hospital" ${mentions}×`);
  }
  const settings = new Set((text.match(SETTING_WORDS) ?? []).map((w) => w.toLowerCase()));
  if (settings.size >= 2) {
    score += 1;
    reasons.push(`ad describes ${[...settings].slice(0, 3).join(", ")} work`);
  }
  return { score, reasons };
}

export const companyKey = (company) => normalize(company);
export const dedupeKey = (job) => `${normalize(job.title)}|${normalize(job.company)}`;

const words = (s = "") => new Set(normalize(s).split(" ").filter((w) => w.length > 3));
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

// The same role advertised on more than one site. Employer names often differ between
// sites ("NSW Health" vs "Sydney Local Health District"), so fall back to comparing the ad text.
export function sameRole(a, b) {
  if (normalize(a.title) !== normalize(b.title)) return false;
  // Chains post the same ad per clinic ("Kieser - Camberwell", "Kieser - Narre Warren"): different suburbs, different jobs.
  const sa = suburb(a.location);
  const sb = suburb(b.location);
  if (sa && sb && sa !== sb) return false;
  return normalize(a.company) === normalize(b.company) || overlap(a.description, b.description) >= 0.6;
}

// "Camberwell, Melbourne VIC" / "Camberwell, Victoria, Australia" / "Melton VIC 3337" -> "camberwell" / "melton".
// Returns "" for city-wide labels like "Melbourne VIC" or "Greater Melbourne Area".
function suburb(location = "") {
  const first = normalize(location.split(",")[0].replace(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b|\d{4}/g, ""));
  return /^(greater )?melbourne( area)?$|^victoria$|^australia$/.test(first) ? "" : first;
}
