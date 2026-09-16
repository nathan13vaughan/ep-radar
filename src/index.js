import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import * as seek from "./sources/seek.js";
import * as indeed from "./sources/indeed.js";
import * as linkedin from "./sources/linkedin.js";
import * as careers from "./sources/careers.js";
import { openDb } from "./db.js";
import { broadTitleMatch, categoriesFor, companyKey, dedupeKey, hospitalScore, roleFor, sameRole, titleMatches } from "./filter.js";
import { extractDetails } from "./extract.js";
import { htmlToText } from "./text.js";
import { AI_VERSION, aiAvailable, extractJobs, isFatalAiError, researchCompany } from "./research.js";
import { notifyJobs, send } from "./notify.js";
import { writeReport } from "./report.js";
import { homePlace, placeFor, refreshPlaces } from "./geo.js";
import { sleep } from "./http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // no .env - AI features stay off unless ANTHROPIC_API_KEY is set elsewhere
}

const SOURCES = { seek, indeed, linkedin, careers };
const REPORT_PATH = join(ROOT, "report.html");
// On GitHub Actions, REPORT_URL points at the published site so notifications can link to it.
const REPORT_URL = process.env.REPORT_URL || pathToFileURL(REPORT_PATH).href;
const args = new Set(process.argv.slice(2));
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
// On GitHub the ntfy topic comes from a repository secret, so it never appears in the code.
if (process.env.NTFY_TOPIC) cfg.notifications.ntfyTopic = process.env.NTFY_TOPIC;
// Every enabled role category (EP, OT, ...) contributes its search terms.
cfg.searchTerms = [...new Set(cfg.categories.filter((c) => c.enabled !== false).flatMap((c) => c.searchTerms))];

// Categories always come from config.json as it is now, so saved jobs follow category changes
// (e.g. a category that's been removed stops showing straight away).
const withCategories = (job) => {
  const categories = categoriesFor(job, cfg);
  return { ...job, categories, excluded: !categories.length };
};
const log = (...parts) => console.log(`[${new Date().toLocaleString("en-AU")}]`, ...parts);

const HELP = `EP Job Observer - hospital Exercise Physiologist jobs from Seek, Indeed and LinkedIn

  node src/index.js                 check once, notify about new jobs, update report.html
  node src/index.js --watch         keep running and check every ${cfg.checkEveryMinutes} minutes
  node src/index.js --open          open the report when done
  node src/index.js --report-only   rebuild report.html from saved jobs without searching
  node src/index.js --places-only   look up travel distances for open roles, then rebuild the report
  node src/index.js --no-notify     don't send notifications this run
  node src/index.js --no-ai         skip Claude research this run
  node src/index.js --test-notify   send a test notification`;

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// Run fn over items with at most `limit` running at once.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function buildJob(id, listing, extra, now) {
  const filled = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== ""));
  const job = { ...listing, ...filled, id, firstSeen: now, lastSeen: now };
  job.description = htmlToText(job.descriptionHtml || job.summary || "");
  delete job.descriptionHtml;
  // Generic titles ("Allied Health Clinician") count only if the ad names one of the roles;
  // the rest are saved (so they aren't fetched again) but hidden.
  job.categories = categoriesFor(job, cfg);
  job.excluded = !job.categories.length;
  job.extracted = extractDetails(`${job.title}\n${job.description}`);
  const { score, reasons } = hospitalScore(job, cfg);
  job.hospitalScore = score;
  job.hospitalReasons = reasons;
  job.isHospital = score >= cfg.hospitalScoreThreshold;
  job.dedupeKey = dedupeKey(job);
  return job;
}

async function runOnce(db) {
  const now = new Date().toISOString();
  const firstRun = db.jobCount() === 0;
  let useAi = cfg.ai.enabled && !args.has("--no-ai") && aiAvailable();
  const stopAiIfFatal = (err) => {
    if (isFatalAiError(err)) {
      useAi = false;
      log(`Claude isn't available, skipping AI for the rest of this run - ${err.message}`);
    }
  };
  log(`Checking for jobs (AI research ${useAi ? "on" : "off"})`);

  // 1. Search every source, keep matching titles, fetch full details for listings we haven't seen.
  const fresh = [];
  const known = [];
  for (const [name, source] of Object.entries(SOURCES)) {
    if (!cfg.sources[name]) continue;
    const listings = await source.search(cfg, log);
    const relevant = listings.filter((j) => titleMatches(j.title, cfg) || broadTitleMatch(j.title, cfg));
    log(`${name}: ${listings.length} listings, ${relevant.length} with a matching title`);
    for (const listing of relevant) {
      const id = `${name}:${listing.sourceId}`;
      const existing = db.getJob(id);
      if (existing) {
        db.touch(id, now);
        // Re-categorise, in case the categories in config.json changed since it was saved.
        const categories = categoriesFor(existing, cfg);
        if (String(categories) !== String(existing.categories)) {
          Object.assign(existing, { categories, excluded: !categories.length });
          db.updateJob(existing);
        }
        known.push(existing);
        continue;
      }
      let extra = {};
      if (source.details) {
        try {
          extra = await source.details(listing);
        } catch (err) {
          log(`${name}: couldn't load details for "${listing.title}" - ${err.message}`);
        }
        await sleep(cfg.requestDelayMs);
      }
      fresh.push(buildJob(id, listing, extra, now));
    }
  }

  // 2. Let Claude read the ads (new ones first, then any open ones it hasn't read yet): confirms
  //    hospital-based and pulls out hours, times and pay. Several ads per call, a few calls at once.
  if (useAi) {
    const queue = [...fresh, ...known.filter((j) => j.aiVersion !== AI_VERSION)]
      .filter((j) => !j.excluded && (!cfg.hospitalOnly || j.hospitalScore > 0))
      .slice(0, cfg.ai.maxJobsPerRun);
    if (queue.length) log(`Reading ${queue.length} ad(s) with Claude`);
    await mapLimit(chunk(queue, cfg.ai.adsPerCall), cfg.ai.parallelCalls, async (batch) => {
      if (!useAi) return;
      try {
        const results = await extractJobs(batch, cfg);
        batch.forEach((job, i) => {
          if (!results[i]) return;
          job.ai = results[i];
          job.aiVersion = AI_VERSION;
          job.isHospital = results[i].is_hospital_based;
        });
      } catch (err) {
        log(`Couldn't read ${batch.length} ad(s) with Claude - ${err.message}`);
        stopAiIfFatal(err);
      }
    });
    for (const job of known) if (job.ai) db.updateJob(job);
  }
  for (const job of fresh) db.saveJob(job);

  // 3. Research reviews + interview process for employers with open roles. Cached per employer,
  //    and capped per run, so a big backlog is worked through over several checks.
  if (useAi) {
    const employers = new Map();
    for (const job of db.allJobs()) {
      const wanted = job.isHospital || !cfg.hospitalOnly;
      if (wanted && !job.excluded && job.lastSeen === now && job.company) employers.set(companyKey(job.company), job);
    }
    const due = [...employers].filter(([key]) => {
      const cached = db.getCompany(key);
      const stale = Date.now() - Date.parse(cached?.researchedAt) > cfg.ai.companyCacheDays * 864e5;
      return !cached || cached.version !== AI_VERSION || stale;
    });
    await mapLimit(due.slice(0, cfg.ai.maxCompaniesPerRun), cfg.ai.parallelCalls, async ([key, job]) => {
      if (!useAi) return;
      log(`Researching reviews and interview process: ${job.company}`);
      try {
        db.saveCompany(key, job.company, await researchCompany(job.company, job.location, cfg, roleFor(job, cfg)));
      } catch (err) {
        log(`Research failed for ${job.company} - ${err.message}`);
        stopAiIfFatal(err);
      }
    });
    if (due.length > cfg.ai.maxCompaniesPerRun) log(`${due.length - cfg.ai.maxCompaniesPerRun} employer(s) left to research on later checks`);
  }

  // 4. Where is each open role, and how far is it from home? Cached, so only new places are looked up.
  if (cfg.home) {
    try {
      // Every role the report shows as open (seen in the last 3 days, not just this run), newest
      // first so new roles get a map straight away if the lookup limit is reached.
      const open = db.allJobs().map(withCategories)
        .filter((j) => !j.excluded && Date.now() - Date.parse(j.lastSeen) < 3 * 864e5)
        .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
      await refreshPlaces(open, db, cfg, log);
    } catch (err) {
      log(`travel: couldn't work out distances - ${err.message}`);
    }
  }

  // 5. Notify - once per role, even when it's advertised on several sites.
  const targets = fresh.filter((j) => !j.excluded && (j.isHospital || !cfg.hospitalOnly));
  const alreadyNotified = db.allJobs().filter((j) => j.notified);
  const toNotify = [];
  for (const job of targets) {
    if ([...alreadyNotified, ...toNotify].some((other) => sameRole(job, other))) continue;
    toNotify.push(job);
  }
  if (toNotify.length && !args.has("--no-notify")) {
    if (firstRun) {
      // Don't fire dozens of toasts for jobs that were already open before the observer started.
      await send(cfg, `Found ${toNotify.length} open roles`,["From now on you'll be notified about new ones.", "Click to open the report."], REPORT_URL);
    } else {
      await notifyJobs(cfg, toNotify, REPORT_URL);
    }
  }
  for (const job of toNotify) db.markNotified(job.id);

  const hospital = targets.filter((j) => j.isHospital).length;
  log(`Done: ${fresh.length} new listing(s), ${targets.length} relevant (${hospital} hospital-based), ${known.length} already known, ${toNotify.length} notified`);
}

function openFile(file) {
  spawn("cmd.exe", ["/c", "start", "", file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function main() {
  if (args.has("--help") || args.has("-h")) return console.log(HELP);
  if (args.has("--test-notify")) {
    await send(cfg, "EP Job Observer", ["Notifications are working.", "Click to open the report."], REPORT_URL);
    return log("Test notification sent");
  }

  const db = openDb(join(ROOT, "data", "jobs.db"));
  const rebuildReport = () => {
    const jobs = db.allJobs().map(withCategories).map((j) => ({ ...j, place: cfg.home ? placeFor(j, db, cfg) : null }));
    writeReport(REPORT_PATH, jobs, db.allCompanies(), {
      city: cfg.location.seek.split(/[\s,]/)[0],
      home: cfg.home ? homePlace(db, cfg) : null,
      categories: cfg.categories
        .filter((c) => c.enabled !== false)
        .map(({ id, label, short, plural, color }) => ({ id, label, short, plural, color })),
      careerSites: cfg.sources.careers ? cfg.careerSites.length : 0,
      checkEveryMinutes: cfg.checkEveryMinutes,
    });
    log(`Report updated: ${REPORT_PATH}`);
  };

  if (args.has("--places-only")) {
    // Fill in travel distances for open roles without searching (e.g. after changing "home").
    const open = db.allJobs().map(withCategories)
      .filter((j) => !j.excluded && Date.now() - Date.parse(j.lastSeen) < 3 * 864e5)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
    await refreshPlaces(open, db, cfg, log);
  } else if (!args.has("--report-only")) {
    await runOnce(db);
  }
  rebuildReport();
  if (args.has("--open")) openFile(REPORT_PATH);

  if (args.has("--watch")) {
    for (;;) {
      log(`Next check in ${cfg.checkEveryMinutes} minutes (Ctrl+C to stop)`);
      await sleep(cfg.checkEveryMinutes * 60000);
      try {
        await runOnce(db);
        rebuildReport();
      } catch (err) {
        log(`Check failed - ${err.stack ?? err.message}`);
      }
    }
  }
}

main().catch((err) => {
  log(`Fatal error - ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
