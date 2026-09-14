import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional Claude-powered enrichment, run through the Claude Code CLI (`claude -p`) so it uses
// your Claude subscription rather than an API key:
//   - on this computer: whichever account Claude Code is logged in to
//   - on GitHub: the CLAUDE_CODE_OAUTH_TOKEN secret, created with `claude setup-token`
// extractJobs reads ads (setting, hours, times, salary, award level); researchCompany
// web-searches employee reviews and the interview process.

// Bump when the prompts or answer shapes change, so older answers are redone on the next check.
export const AI_VERSION = 2;

// Everything Claude writes here is read by someone skimming many ads, so it's asked for short
// phrases rather than prose.
const STYLE = `Write for someone skimming dozens of job ads: short, concrete phrases, not sentences. No filler, caveats or commentary. If something isn't known, use "" (or []) instead of explaining that it isn't known.`;

// An empty working directory keeps any project CLAUDE.md or settings out of these calls.
const WORKDIR = mkdtempSync(join(tmpdir(), "ep-radar-"));

class ClaudeError extends Error {
  constructor(message, fatal = false) {
    super(message);
    this.fatal = fatal; // true = every later call would fail too (not logged in, usage limit, no CLI)
  }
}
export const isFatalAiError = (err) => err instanceof ClaudeError && err.fatal;

export function aiAvailable() {
  if (process.env.GITHUB_ACTIONS && !process.env.CLAUDE_CODE_OAUTH_TOKEN) return false;
  return spawnSync("claude", ["--version"], { windowsHide: true, timeout: 30000 }).status === 0;
}

// Run one headless Claude Code call and return its schema-checked JSON. The prompt goes over
// stdin because a batch of ads can exceed Windows' command-line length limit.
function askClaude(prompt, schema, { model, tools = [], maxTurns = 4, timeoutMs = 8 * 60000 }) {
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--model", model, "--max-turns", String(maxTurns), "--permission-mode", "dontAsk",
  ];
  if (tools.length) args.push("--allowedTools", tools.join(","));

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: WORKDIR, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeError(`no answer after ${timeoutMs / 60000} minutes`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeError(`couldn't start Claude Code (${e.message})`, true));
    });
    child.on("close", () => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new ClaudeError((err || out || "no output").trim().slice(0, 300)));
      }
      if (res.is_error || res.subtype !== "success") {
        const msg = String(res.result || res.subtype || "unknown error");
        return reject(new ClaudeError(msg, /log ?in|authenticat|usage limit|rate limit|credit/i.test(msg)));
      }
      if (!res.structured_output) return reject(new ClaudeError("Claude didn't return the expected format"));
      resolve(res.structured_output);
    });
    child.stdin.end(prompt);
  });
}

const str = { type: "string" };
const strList = { type: "array", items: str };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const JOB_FIELDS = {
  is_hospital_based: { type: "boolean" },
  workplace: str,
  employment_type: str,
  hours: str,
  working_times: str,
  contract: str,
  salary: str,
  award_level: str,
  key_requirements: strList,
  summary: str,
};
const JOBS_SCHEMA = obj({ jobs: { type: "array", items: obj({ ref: str, ...JOB_FIELDS }) } });

const COMPANY_SCHEMA = obj({
  verdict: { type: "string", enum: ["Positive", "Mixed", "Negative", "Not enough information"] },
  headline: str,
  ratings: { type: "array", items: obj({ site: str, rating: str, review_count: str, url: str }) },
  pros: strList,
  cons: strList,
  interview: obj({ steps: strList, format: str, timeline: str, likely_questions: strList, tip: str }),
  sources: { type: "array", items: obj({ title: str, url: str }) },
});

// Reads a batch of ads in one call. Returns results in the same order as `jobs` (null where missing).
export async function extractJobs(jobs, cfg) {
  const ads = jobs
    .map((job, i) => `<ad ref="${i}">
Title: ${job.title}
Employer: ${job.company}
Location: ${job.location}
Listed salary: ${job.salary || "not listed"}
Listed work type: ${job.workType || "not listed"}

${job.description || job.summary || "(no description available)"}
</ad>`)
    .join("\n\n");

  const prompt = `Below are ${jobs.length} job ads for allied health and exercise roles (exercise physiology, occupational therapy, exercise science, Pilates). The reader is deciding which to apply for. For each ad, add one entry to "jobs" with its ref and these facts.

${STYLE}

- is_hospital_based: true only if the role is based in a hospital or run by a hospital/health service (inpatient wards, hospital outpatient clinics, rehab units, community teams of a public or private health service). False for private clinics, gyms, NDIS or mobile providers, aged care and corporate health, even if they mention hospitals.
- workplace: a few words, e.g. "Private hospital, mental health".
- employment_type: e.g. "Part time, permanent" or "Casual".
- hours: e.g. "0.6 FTE" or "38 hrs/week".
- working_times: e.g. "Mon–Fri 8am–4:30pm" or "Rotating roster incl. weekends".
- contract: e.g. "12 months, parental leave cover"; "" if permanent.
- salary: e.g. "$45–$52/hr + super" or "$85k–$100k + super".
- award_level: e.g. "Grade 2" or "Health Professional Level 2".
- key_requirements: up to 4, each under 6 words, e.g. "ESSA accreditation", "Driver's licence".
- summary: one sentence of at most 20 words on what the job actually involves.

${ads}`;

  const { jobs: results } = await askClaude(prompt, JOBS_SCHEMA, { model: cfg.ai.model, maxTurns: 4 });
  const byRef = new Map(results.map(({ ref, ...fields }) => [String(ref), { ...fields, key_requirements: fields.key_requirements.slice(0, 4) }]));
  return jobs.map((_, i) => byRef.get(String(i)) ?? null);
}

export async function researchCompany(company, location, cfg, person = "an allied health professional") {
  const prompt = `I'm ${person} in Melbourne, Australia, considering a job with "${company}" (${location}).

Use web search, and fetch pages where useful, to find out:
1. What employees say about working there: ratings on SEEK, Indeed and Glassdoor (Australian sites), and the most common praise and complaints, especially from allied health staff (exercise physiologists, physios, OTs).
2. How it hires allied health staff: the steps, interview format, how long it takes, and typical questions. For a public health service, the Victorian public health recruitment process applies.

If "${company}" is a recruitment agency or a parent brand, research the hospital or clinic it's hiring for if that's clear, otherwise the brand. About 4–6 searches is usually enough.

${STYLE}

- verdict: Positive, Mixed, Negative, or "Not enough information".
- headline: the single most useful takeaway, one sentence of at most 20 words, e.g. "Supportive team and good training, but high caseloads and slow pay progression."
- ratings: only sites where you found an actual score, at most 3. Use a short site name ("SEEK", "Indeed", "Glassdoor"), the rating as a number (e.g. "4.1"), the review count as a number, and the URL. Never estimate a rating.
- pros and cons: the 3 most common themes each, 2–6 words per item, e.g. "Flexible hours", "High caseload".
- interview.steps: the hiring steps in order, at most 5, 2–6 words each, e.g. "Online application + cover letter", "Panel interview", "Reference checks".
- interview.format: under 12 words, e.g. "Panel of 2–3; behavioural and clinical scenario questions".
- interview.timeline: under 6 words, e.g. "About 2–4 weeks".
- interview.likely_questions: up to 3, each under 15 words.
- interview.tip: one sentence of at most 20 words.
- sources: up to 5 pages you relied on.`;

  const r = await askClaude(prompt, COMPANY_SCHEMA, { model: cfg.ai.model, tools: ["WebSearch", "WebFetch"], maxTurns: 20, timeoutMs: 10 * 60000 });
  return {
    ...r,
    ratings: r.ratings.filter((x) => /\d/.test(x.rating)).slice(0, 3),
    pros: r.pros.slice(0, 3),
    cons: r.cons.slice(0, 3),
    interview: { ...r.interview, steps: r.interview.steps.slice(0, 5), likely_questions: r.interview.likely_questions.slice(0, 3) },
    sources: r.sources.slice(0, 5),
    version: AI_VERSION,
  };
}
