import { getText, request, sleep } from "../http.js";
import { inlineText } from "../text.js";

// Hospitals' own careers sites (plus the Victorian Government job board). Many hospital roles
// appear here before, or instead of, Seek/Indeed/LinkedIn. Each site is listed in config.json
// under "careerSites" with the job-board system it runs on. Search boxes on these systems are
// unreliable, so each adapter lists every open job and the title filter is applied locally.

const OTHER_STATES = /\b(NSW|QLD|WA|SA|TAS|NT|ACT|New South Wales|Queensland|Western Australia|South Australia|Tasmania|Sydney|Brisbane|Perth|Adelaide|Hobart|Darwin|Canberra)\b/i;
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

const getJson = async (url) => (await request(url, { headers: { Accept: "application/json" } })).json();
const postJson = async (url, body) => (await request(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) })).json();

const isoOrEmpty = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString() : "");
const auDate = (s = "") => {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? isoOrEmpty(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]))) : "";
};
const daysAgo = (s = "") => {
  if (/today/i.test(s)) return new Date().toISOString();
  if (/yesterday/i.test(s)) return isoOrEmpty(new Date(Date.now() - 864e5));
  const m = s.match(/(\d+)\+?\s*days?/i);
  return m ? isoOrEmpty(new Date(Date.now() - m[1] * 864e5)) : "";
};

// Cut an HTML fragment starting at `marker` and ending at the first `endRe` match (or maxLen chars).
function sliceFrom(html, marker, endRe, maxLen = 30000) {
  const i = html.indexOf(marker);
  if (i < 0) return "";
  const rest = html.slice(html.indexOf(">", i) + 1, i + maxLen);
  const end = rest.search(endRe);
  return end > 0 ? rest.slice(0, end) : rest;
}

// Contents of every <span> opened by `openRe`, respecting nested spans (SuccessFactors job pages).
function spanContents(html, openRe) {
  const out = [];
  let m;
  while ((m = openRe.exec(html))) {
    const tagRe = /<(\/?)span\b[^>]*>/gi;
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length;
    let t;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (!depth) {
        end = t.index;
        break;
      }
    }
    out.push(html.slice(m.index + m[0].length, end));
    openRe.lastIndex = end;
  }
  return out;
}

const ADAPTERS = {
  async workday(site) {
    const out = [];
    let total;
    for (let offset = 0; ; offset += 20) {
      // limit above 20 is rejected; total is only returned on the first page
      const j = await postJson(`https://${site.host}/wday/cxs/${site.tenant}/${site.site}/jobs`, {
        appliedFacets: site.facets ?? {}, limit: 20, offset, searchText: "",
      });
      total ??= j.total;
      for (const p of j.jobPostings ?? []) {
        out.push({
          id: p.externalPath,
          title: p.title,
          location: p.locationsText ?? "",
          listedAt: daysAgo(p.postedOn),
          workType: p.timeType ?? "",
          url: `https://${site.host}/${site.site}${p.externalPath}`,
          detail: { kind: "workday", url: `https://${site.host}/wday/cxs/${site.tenant}/${site.site}${p.externalPath}` },
        });
      }
      if (!j.jobPostings?.length || offset + 20 >= total) break;
      await sleep(300);
    }
    return out;
  },

  async smartrecruiters(site) {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${site.company}/postings?limit=100&offset=${offset}${site.query ? `&${site.query}` : ""}`);
      for (const p of j.content ?? []) {
        out.push({
          id: p.id,
          title: p.name,
          company: p.customField?.find((f) => f.fieldLabel === "Hospital/Service")?.valueLabel,
          location: p.location?.fullLocation ?? "",
          listedAt: p.releasedDate ?? "",
          workType: p.typeOfEmployment?.label ?? "",
          url: `https://jobs.smartrecruiters.com/${site.company}/${p.id}`,
          detail: { kind: "smartrecruiters", url: `https://api.smartrecruiters.com/v1/companies/${site.company}/postings/${p.id}` },
        });
      }
      if (!j.content?.length || offset + 100 >= j.totalFound) break;
      await sleep(300);
    }
    return out;
  },

  // SuccessFactors "career site builder" - HTML search results pages.
  async successfactors(site) {
    const out = new Map();
    for (let start = 0; start < 2000; ) {
      const html = await getText(`https://${site.host}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${start}`);
      const rows = [...html.matchAll(/<tr class="data-row[\s\S]*?<\/tr>/g)].map((m) => m[0]);
      let added = 0;
      for (const row of rows) {
        const a = row.match(/<a (?=[^>]*class="jobTitle-link")[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/);
        if (!a || out.has(a[1])) continue;
        out.set(a[1], {
          id: a[1],
          title: inlineText(a[2]),
          location: inlineText(row.match(/class="job(?:Location|Facility)[^"]*"[^>]*>([^<]*)/)?.[1]),
          listedAt: isoOrEmpty(new Date(inlineText(row.match(/class="jobDate[^"]*"[^>]*>([^<]*)/)?.[1]))),
          url: `https://${site.host}${a[1]}`,
          detail: { kind: "successfactors", url: `https://${site.host}${a[1]}` },
        });
        added++;
      }
      if (!added) break;
      start += rows.length;
      await sleep(300);
    }
    return [...out.values()];
  },

  // Newer SuccessFactors sites with a JSON search API.
  async "successfactors-v1"(site) {
    const out = [];
    let total = 1;
    for (let pageNumber = 0; pageNumber * 10 < total && pageNumber < 100; pageNumber++) {
      const j = await postJson(`https://${site.host}/services/recruiting/v1/jobs`, {
        locale: "en_GB", pageNumber, sortBy: "recent", keywords: "", location: "", facetFilters: {},
        brand: "", skills: [], categoryId: 0, alertId: "", rcmCandidateId: "",
      });
      total = j.totalJobs ?? 0;
      if (!j.jobSearchResult?.length) break;
      for (const { response: r } of j.jobSearchResult) {
        const url = `https://${site.host}/job/${r.urlTitle}/${r.id}-en_GB`;
        out.push({
          id: String(r.id),
          title: r.unifiedStandardTitle,
          location: inlineText(r.jobLocationShort?.[0] || r.custworklocation_obj?.[0] || ""),
          listedAt: auDate(r.unifiedStandardStart),
          url,
          detail: { kind: "successfactors", url },
        });
      }
      await sleep(300);
    }
    return out;
  },

  // Older SuccessFactors: one XML file with every job, descriptions included.
  async "successfactors-xml"(site) {
    const xml = await getText(`https://career10.successfactors.com/career?company=${site.company}&career_ns=job_listing_summary&resultType=XML`);
    const tag = (x, name) => (x.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1] ?? "").trim();
    return [...xml.matchAll(/<Job>([\s\S]*?)<\/Job>/g)].map(([, x]) => {
      const req = tag(x, "ReqId");
      return {
        id: req,
        title: inlineText(tag(x, "JobTitle")),
        location: "",
        listedAt: auDate(tag(x, "Posted-Date")),
        workType: [...x.matchAll(/<value>([^<]*)<\/value>/g)].map((m) => m[1]).join(" / "),
        descriptionHtml: tag(x, "Job-Description"),
        url: `https://career10.successfactors.com/career?company=${site.company}&career_ns=job_listing&career_job_req_id=${req}`,
      };
    });
  },

  // LiveHire / Humanforce: the sitemap is the full list. URLs look like
  // /job/{id}/{id}/physiotherapist-grade-2-community-rehabilitation, so the title is the last segment.
  async livehire(site) {
    const sitemap = await getText(`https://${site.host}/sitemap.xml`);
    return [...sitemap.matchAll(/<loc>([^<]+\/job\/([^<]+))<\/loc>/g)].map(([, url, path]) => {
      const parts = path.split("/");
      return {
        id: parts.slice(0, -1).join("/"),
        title: decodeURIComponent(parts.at(-1)).replace(/-/g, " "),
        location: "",
        url,
        detail: { kind: "livehire", url },
      };
    });
  },

  async pageup(site) {
    const html = await getText(`https://careers.pageuppeople.com/${site.instance}/cw/en/listing/?page=1&page-items=500`);
    return [...html.matchAll(/class="job-link" href="([^"]+)">([^<]*)<\/a>\s*<\/td>\s*<td>\s*<span class="location">([^<]*)<\/span>/g)].map(([, href, title, location]) => ({
      id: href,
      title: inlineText(title),
      location: inlineText(location),
      url: `https://careers.pageuppeople.com${href}`,
      detail: { kind: "pageup", url: `https://careers.pageuppeople.com${href}` },
    }));
  },

  // Oracle Taleo Business Edition. Search needs keywords; results redirect to /jobs/search/{id}.
  async taleo(site, cfg) {
    const out = new Map();
    for (const keywords of site.keywords ?? ["exercise physiologist"]) {
      const res = await request(`https://${site.host}/jobs/search?keywords=${encodeURIComponent(keywords)}`);
      const base = res.url;
      let html = await res.text();
      const pages = Math.round(Number(html.match(/jPaginateNumPages" class="ghost">([\d.]+)/)?.[1] ?? 1));
      for (let page = 1; page <= pages; page++) {
        if (page > 1) html = await getText(`${base}/page${page}`);
        for (const m of html.matchAll(/href="([^"]+)" class="job_link font_bold">([^<]*)<\/a>[\s\S]*?class="location">\s*([^<]*?)\s*<\/span>/g)) {
          const location = inlineText(m[3]);
          out.set(m[1], {
            id: m[1],
            title: inlineText(m[2]),
            company: /hospital|clinic/i.test(location) ? location.split(",")[0] : undefined,
            location,
            url: m[1],
            detail: { kind: "taleo", url: m[1] },
          });
        }
      }
      await sleep(cfg.requestDelayMs);
    }
    return [...out.values()];
  },

  // Victorian Government jobs board, filtered to the health occupation group.
  async careersvic(site, cfg) {
    const out = new Map();
    for (const keywords of site.keywords ?? ["exercise physiologist"]) {
      for (let page = 0; page < 10; page++) {
        const html = await getText(`https://www.careers.vic.gov.au/jobs?keywords=${encodeURIComponent(keywords)}&occupation%5B%5D=6301&page=${page}`);
        const cards = [...html.matchAll(/href="(\/job\/[^"]+)"><h3>([^<]*)<\/h3><\/a>\s*<p[^>]*>([^<]*)<\/p>([\s\S]*?)(?=<div class="views-row"|<\/main>)/g)];
        if (!cards.length) break;
        for (const [, href, title, org, rest] of cards) {
          const f = Object.fromEntries([...rest.matchAll(/<strong>([^<:]+):<\/strong><\/p>\s*<p>([^<]*)/g)].map((m) => [m[1].trim(), inlineText(m[2])]));
          out.set(href, {
            id: href,
            title: inlineText(title),
            company: inlineText(org),
            location: f.Location ?? "",
            workType: f["Work Type"] ?? "",
            salary: f.Salary ?? "",
            url: `https://www.careers.vic.gov.au${href}`,
            detail: { kind: "careersvic", url: `https://www.careers.vic.gov.au${href}` },
          });
        }
        await sleep(cfg.requestDelayMs);
      }
    }
    return [...out.values()];
  },
};

export async function search(cfg, log) {
  const jobs = [];
  for (const site of cfg.careerSites ?? []) {
    const adapter = ADAPTERS[site.type];
    if (!adapter) {
      log(`careers: unknown site type "${site.type}" for ${site.name}`);
      continue;
    }
    // National employers list jobs by suburb only; "locationMatch" keeps just the Melbourne ones.
    const keep = site.locationMatch ? new RegExp(site.locationMatch, "i") : null;
    try {
      const found = await adapter(site, cfg);
      for (const j of found) {
        if (OTHER_STATES.test(j.location) || (keep && !keep.test(j.location))) continue;
        jobs.push({
          ...j,
          source: "careers",
          sourceId: `${site.name}:${j.id}`,
          siteName: site.name,
          company: j.company || site.name,
          summary: "",
        });
      }
    } catch (err) {
      log(`careers: ${site.name} failed - ${err.message}`);
    }
    await sleep(cfg.requestDelayMs);
  }
  return jobs;
}

export async function details(job) {
  const { kind, url } = job.detail ?? {};
  switch (kind) {
    case "workday": {
      const info = (await getJson(url)).jobPostingInfo ?? {};
      return {
        descriptionHtml: info.jobDescription,
        listedAt: info.startDate ? isoOrEmpty(new Date(info.startDate)) : undefined,
        workType: info.timeType,
        location: info.location,
      };
    }
    case "smartrecruiters": {
      const j = await getJson(url);
      const s = j.jobAd?.sections ?? {};
      return {
        descriptionHtml: [s.jobDescription, s.qualifications, s.additionalInformation].map((x) => x?.text).filter(Boolean).join("\n"),
        applyUrl: j.applyUrl,
      };
    }
    case "successfactors": {
      const html = (await getText(url)).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
      let desc = spanContents(html, /<span\b[^>]*itemprop="description"[^>]*>/g).join("\n");
      if (inlineText(desc).length < 300) {
        const longest = spanContents(html, /<span\b[^>]*class="rtltextaligneligible"[^>]*>/g).sort((a, b) => b.length - a.length)[0];
        if (longest && longest.length > desc.length) desc = longest;
      }
      const posted = html.match(/itemprop="datePosted"\s+content="([^"]+)"/)?.[1];
      return { descriptionHtml: desc, listedAt: posted ? isoOrEmpty(new Date(posted)) : undefined };
    }
    case "livehire": {
      const html = await getText(url);
      const ld = JSON.parse(html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "{}");
      const labels = Object.fromEntries([...html.matchAll(/class="icon-label">([^<]*)<\/span><span[^>]*class="value">([^<]*)/g)].map((m) => [m[1].replace(":", "").trim(), inlineText(m[2])]));
      return {
        title: ld.title,
        descriptionHtml: ld.description,
        listedAt: ld.datePosted ? isoOrEmpty(new Date(ld.datePosted)) : undefined,
        workType: labels["Work Type"] || ld.employmentType,
        location: labels.Location,
      };
    }
    case "pageup":
      return { descriptionHtml: sliceFrom(await getText(url), 'id="job-content"', /<footer|id="footer"|<\/main>/i) };
    case "taleo":
      return { descriptionHtml: sliceFrom(await getText(url), 'class="job_description"', /class="job_apply|id="footer"|<footer/i) };
    case "careersvic":
      return { descriptionHtml: sliceFrom(await getText(url), "field--name-description", /<\/article>|<footer/i) };
    default:
      return {};
  }
}
