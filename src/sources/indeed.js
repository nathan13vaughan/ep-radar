import { request, sleep } from "../http.js";

// Indeed's website blocks scripts, so this uses the GraphQL API behind the Indeed mobile app.
const API_URL = "https://apis.indeed.com/graphql";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "indeed-api-key": "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8",
  "indeed-locale": "en-AU",
  "indeed-co": "AU",
  "indeed-app-info": "appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1",
};
const PAGE_SIZE = 50;
const WORK_TYPES = /^(full-time|part-time|casual|permanent|temporary|fixed term|contract|locum|internship|graduate)$/i;
const UNITS = { HOUR: "per hour", DAY: "per day", WEEK: "per week", MONTH: "per month", YEAR: "per year" };

const SALARY_FIELDS = "unitOfWork range { ... on Range { min max } }";
const buildQuery = (what, where, radius, cursor) => `query GetJobData {
  jobSearch(what: ${JSON.stringify(what)}, location: {where: ${JSON.stringify(where)}, radius: ${radius}, radiusUnit: KILOMETERS}, limit: ${PAGE_SIZE}, sort: DATE${cursor ? `, cursor: ${JSON.stringify(cursor)}` : ""}) {
    pageInfo { nextCursor }
    results { job {
      key title datePublished
      description { html }
      location { formatted { long } }
      compensation { baseSalary { ${SALARY_FIELDS} } estimated { baseSalary { ${SALARY_FIELDS} } } }
      attributes { label }
      employer { name relativeCompanyPageUrl }
      recruit { viewJobUrl }
    } }
  }
}`;

function formatSalary(comp) {
  const base = comp?.baseSalary ?? comp?.estimated?.baseSalary;
  const { min, max } = base?.range ?? {};
  if (typeof min !== "number" && typeof max !== "number") return "";
  const money = (n) => "$" + (n >= 1000 ? Math.round(n).toLocaleString("en-AU") : n.toFixed(2));
  const amount = min && max && Math.abs(max - min) > 0.01 ? `${money(min)} – ${money(max)}` : money(min || max);
  return `${amount} ${UNITS[base.unitOfWork] ?? ""}${comp.baseSalary ? "" : " (Indeed estimate)"}`.trim();
}

export async function search(cfg, log) {
  const oldest = Date.now() - cfg.maxAgeDays * 864e5;
  const jobs = new Map();
  for (const what of cfg.searchTerms) {
    try {
      let cursor = null;
      for (let page = 0; page < cfg.pagesPerSearch; page++) {
        const res = await request(API_URL, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ query: buildQuery(what, cfg.location.indeed, cfg.radiusKm, cursor) }),
        });
        const { data, errors } = await res.json();
        if (errors?.length) throw new Error(errors[0].message);
        const results = data?.jobSearch?.results ?? [];
        for (const { job: j } of results) {
          if (j.datePublished && j.datePublished < oldest) continue;
          const pageUrl = j.employer?.relativeCompanyPageUrl;
          jobs.set(j.key, {
            source: "indeed",
            sourceId: j.key,
            title: j.title,
            company: j.employer?.name ?? "",
            location: j.location?.formatted?.long ?? "",
            listedAt: j.datePublished ? new Date(j.datePublished).toISOString() : "",
            salary: formatSalary(j.compensation),
            workType: j.attributes.map((a) => a.label).filter((l) => WORK_TYPES.test(l)).join(", "),
            descriptionHtml: j.description?.html ?? "",
            url: `https://au.indeed.com/viewjob?jk=${j.key}`,
            applyUrl: j.recruit?.viewJobUrl ?? "",
            companyPage: pageUrl ? `https://au.indeed.com${pageUrl}` : "",
          });
        }
        cursor = data?.jobSearch?.pageInfo?.nextCursor;
        if (!cursor || results.length < PAGE_SIZE) break;
        await sleep(cfg.requestDelayMs);
      }
    } catch (err) {
      log(`indeed: search for "${what}" failed - ${err.message}`);
    }
  }
  return [...jobs.values()];
}

// Search results already include the full description, so there is no details step.
