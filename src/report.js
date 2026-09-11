import { readFileSync, writeFileSync } from "node:fs";
import { companyKey, sameRole } from "./filter.js";

const SOURCE_NAMES = { seek: "Seek", indeed: "Indeed", linkedin: "LinkedIn" };
const TEMPLATE = readFileSync(new URL("./report-template.html", import.meta.url), "utf8");

// Merge the same role advertised on several sites into one card.
function groupJobs(jobs) {
  const groups = [];
  for (const job of [...jobs].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))) {
    const source = { name: job.siteName ?? SOURCE_NAMES[job.source] ?? job.source, url: job.url };
    const group = groups.find((g) => sameRole(g, job));
    if (!group) {
      groups.push({ ...job, sources: [source] });
      continue;
    }
    group.sources.push(source);
    if (job.lastSeen > group.lastSeen) group.lastSeen = job.lastSeen;
    group.isHospital ||= job.isHospital;
    for (const k of ["salary", "workType", "rating", "reviewsUrl", "ai", "companyPage", "applyUrl"]) group[k] ||= job[k];
    if ((job.description?.length ?? 0) > (group.description?.length ?? 0)) group.description = job.description;
  }
  return groups;
}

// Rough yearly figure from an advertised salary, used for sorting and the median.
// Hourly rates assume a 38-hour week. Returns null when there's no usable number.
export function annualSalary(text = "") {
  const t = text.toLowerCase().replace(/,/g, "");
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s?(k)?\b/g)]
    .map((m) => Number(m[1]) * (m[2] ? 1000 : 1))
    .filter((n) => n >= 20)
    .slice(0, 2);
  if (!nums.length) return null;
  const mid = (Math.min(...nums) + Math.max(...nums)) / 2;
  let yearly = mid;
  if (/hour|p\.?h\b|\/hr|hourly/.test(t) || mid < 200) yearly = mid * 38 * 52;
  else if (/week|p\.?w\b/.test(t) || mid < 5000) yearly = mid * 52;
  return yearly >= 20000 && yearly <= 400000 ? Math.round(yearly) : null;
}

// Work type from the ad text, for listings with no structured field (common on hospital sites).
function workTypeFromText(text = "") {
  const found = new Map();
  for (const m of text.matchAll(/\b(full[- ]time|part[- ]time|casual|fixed[- ]term|permanent|temporary)\b/gi)) {
    const label = m[1].toLowerCase().replace(/[- ]/, " ");
    found.set(label, label[0].toUpperCase() + label.slice(1));
  }
  return [...found.values()].slice(0, 3).join(", ");
}

function toCard(job, research) {
  const ai = job.ai ?? {};
  const x = job.extracted ?? {};
  const q = encodeURIComponent(job.company);
  const seekReviews = job.rating?.url || job.reviewsUrl;
  const salary = job.salary || ai.salary || "";
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    listedAt: job.listedAt || job.firstSeen,
    firstSeen: job.firstSeen,
    lastSeen: job.lastSeen,
    sources: job.sources,
    isHospital: Boolean(job.isHospital),
    hospitalReasons: job.hospitalReasons ?? [],
    workplace: ai.workplace ?? "",
    salary,
    salaryAnnual: annualSalary(salary),
    salaryDetail: ai.salary && ai.salary !== job.salary ? ai.salary : "",
    workType: job.workType || ai.employment_type || workTypeFromText(job.description),
    workTypeDetail: job.workType && ai.employment_type ? ai.employment_type : "",
    hours: ai.hours || [x.fte, x.hours, x.daysPerWeek].filter(Boolean).join(" · "),
    times: ai.working_times || [x.days, x.times, ...(x.notes ?? [])].filter(Boolean).join(" · "),
    contract: ai.contract || x.contract || "",
    award: ai.award_level || x.award || "",
    summary: ai.summary || job.summary || "",
    requirements: ai.key_requirements ?? [],
    description: job.description ?? "",
    seekRating: job.rating ?? null,
    research: research ?? null,
    links: [
      seekReviews && { label: "Seek reviews", url: seekReviews },
      job.companyPage
        ? { label: "Indeed reviews", url: `${job.companyPage}/reviews` }
        : { label: "Indeed reviews", url: `https://au.indeed.com/companies/search?q=${q}` },
      job.companyPage && { label: "Indeed interviews", url: `${job.companyPage}/interviews` },
      { label: "Glassdoor", url: `https://www.glassdoor.com.au/Reviews/company-reviews.htm?sc.keyword=${q}` },
      { label: "Interview experiences", url: `https://www.google.com/search?q=${encodeURIComponent(`"${job.company}" interview process allied health`)}` },
      job.applyUrl && { label: "Employer's job page", url: job.applyUrl },
    ].filter(Boolean),
  };
}

// meta: { city, careerSites } for the headline; { repo, branch } when published from GitHub,
// which turns on the report's "Search now" button.
export function writeReport(file, jobs, companies, meta = {}) {
  const cards = groupJobs(jobs.filter((j) => !j.excluded)).map((job) => toCard(job, companies[companyKey(job.company)]));
  const data = JSON.stringify({
    generatedAt: new Date().toISOString(),
    city: meta.city ?? "",
    careerSites: meta.careerSites ?? 0,
    repo: meta.repo ?? "",
    branch: meta.branch ?? "",
    workflow: "check-jobs.yml",
    jobs: cards,
  });
  writeFileSync(file, TEMPLATE.replace("__DATA__", () => data.replace(/</g, "\\u003c")));
}
