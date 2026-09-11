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
  summary: str,
  ratings: { type: "array", items: obj({ site: str, rating: str, review_count: str, url: str }) },
  pros: strList,
  cons: strList,
  allied_health_notes: str,
  interview: obj({ overview: str, stages: strList, common_questions: strList, timeline: str, tips: strList }),
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

  const prompt = `Below are ${jobs.length} job ads. An Exercise Physiologist is deciding which to apply for. For each ad, add one entry to "jobs" with its ref and these facts. Use "" (or []) when the ad doesn't say.

- is_hospital_based: true only if the role is based in a hospital or run by a hospital/health service (inpatient wards, hospital outpatient clinics, rehab units, community teams of a public or private health service). False for private clinics, gyms, NDIS or mobile providers, aged care and corporate health, even if they mention hospitals.
- workplace: the setting in a few words, e.g. "Public hospital – inpatient mental health unit".
- employment_type: full time / part time / casual etc., and permanent vs fixed-term.
- hours: FTE or hours per week/fortnight.
- working_times: days, start and finish times, weekends, rosters or on-call.
- contract: length and reason if fixed-term or temporary.
- salary: pay as stated, including range, unit, super and salary packaging.
- award_level: award or classification, e.g. "Health Professional Level 2".
- key_requirements: up to 5 essential requirements.
- summary: two plain sentences on what the job involves.

${ads}`;

  const { jobs: results } = await askClaude(prompt, JOBS_SCHEMA, { model: cfg.ai.model, maxTurns: 4 });
  const byRef = new Map(results.map(({ ref, ...fields }) => [String(ref), fields]));
  return jobs.map((_, i) => byRef.get(String(i)) ?? null);
}

export function researchCompany(company, location, cfg) {
  const prompt = `I'm an Exercise Physiologist in Melbourne, Australia, considering a job with "${company}" (${location}).

Use web search, and fetch pages where useful, to find out:
1. What employees say about working there: ratings and review counts on SEEK, Indeed and Glassdoor (Australian sites), and the common pros and cons. Look especially for comments from allied health staff (exercise physiologists, physios, OTs) about workload, management, culture, supervision and training, rostering and work-life balance.
2. The interview and recruitment process for allied health roles there: application requirements (e.g. addressing selection criteria), interview format (panel, behavioural, clinical scenarios), common questions, referee and pre-employment checks, and how long it usually takes. For a public health service, the Victorian public health recruitment process applies, so include it.

If "${company}" is a recruitment agency or a parent brand, research the hospital or clinic it's hiring for if that's clear, otherwise the brand. About 4–6 searches is usually enough.

Fill in every field: verdict, a two-sentence summary, ratings (site, the rating exactly as shown, review count, URL), pros, cons, allied_health_notes, interview (overview, stages, common_questions, timeline, tips) and up to 8 sources you relied on. Report only what you found, use "" or [] where you found nothing, and never estimate a rating.`;

  return askClaude(prompt, COMPANY_SCHEMA, { model: cfg.ai.model, tools: ["WebSearch", "WebFetch"], maxTurns: 20, timeoutMs: 10 * 60000 });
}
