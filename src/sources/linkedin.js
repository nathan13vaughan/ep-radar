import { getText, sleep } from "../http.js";
import { inlineText } from "../text.js";

// LinkedIn's public "guest" job endpoints - no login needed, but they rate-limit quickly.
const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";
// Page sizes vary (10-25 cards), so paging continues until a page comes back empty.

const pick = (html, re) => inlineText(html.match(re)?.[1]);

export async function search(cfg, log) {
  const jobs = new Map();
  for (const keywords of cfg.searchTerms) {
    try {
      let start = 0;
      for (let page = 0; page < cfg.pagesPerSearch; page++) {
        const params = new URLSearchParams({
          keywords,
          location: cfg.location.linkedin,
          distance: Math.round(cfg.radiusKm / 1.609), // LinkedIn uses miles
          f_TPR: `r${cfg.maxAgeDays * 86400}`,
          start,
        });
        const html = await getText(`${SEARCH_URL}?${params}`);
        let cards = 0;
        for (const card of html.split(/<li[\s>]/).slice(1)) {
          const id = card.match(/jobPosting:(\d+)/)?.[1];
          if (!id) continue;
          cards++;
          jobs.set(id, {
            source: "linkedin",
            sourceId: id,
            title: pick(card, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
            company: pick(card, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
            location: pick(card, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
            listedAt: card.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? "",
            salary: pick(card, /job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/),
            url: `https://www.linkedin.com/jobs/view/${id}/`,
          });
        }
        if (!cards) break;
        start += cards;
        await sleep(cfg.requestDelayMs * 2);
      }
    } catch (err) {
      log(`linkedin: search for "${keywords}" failed - ${err.message}`);
    }
    await sleep(cfg.requestDelayMs * 2);
  }
  return [...jobs.values()];
}

export async function details(job) {
  const html = await getText(DETAIL_URL + job.sourceId);
  const criteria = {};
  for (const m of html.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)) {
    criteria[inlineText(m[1])] = inlineText(m[2]);
  }
  return {
    descriptionHtml: html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "",
    workType: criteria["Employment type"],
    salary: pick(html, /compensation__salary">([\s\S]*?)<\/div>/),
  };
}
