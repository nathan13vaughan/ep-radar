import { getJson, request, sleep } from "../http.js";

const SEARCH_URL = "https://www.seek.com.au/api/jobsearch/v5/search";
const GRAPHQL_URL = "https://www.seek.com.au/graphql";
const PAGE_SIZE = 30;

const DETAILS_QUERY = `query jobDetails($jobId: ID!, $zone: Zone!, $locale: Locale!) {
  jobDetails(id: $jobId) {
    job {
      content(platform: WEB)
      salary { label }
      workTypes { label(locale: $locale) }
      location { label(locale: $locale, type: LONG) }
    }
    companyProfile(zone: $zone) {
      companyNameSlug
      reviewsSummary { overallRating { numberOfReviews { value } value } }
    }
  }
}`;

export async function search(cfg, log) {
  const where = cfg.location.seek;
  // Seek's "Melbourne VIC" search also returns nearby regions (e.g. "Wallan, Bendigo, Goldfields & Macedon Ranges").
  const city = where.split(/[\s,]/)[0].toLowerCase();
  const jobs = new Map();
  for (const keywords of cfg.searchTerms) {
    try {
      for (let page = 1; page <= cfg.pagesPerSearch; page++) {
        const params = new URLSearchParams({
          siteKey: "AU-Main", sourcesystem: "houston", where, keywords, page, pageSize: PAGE_SIZE,
          // Relevance order (Seek's date sort drifts off-topic fast); daterange limits age instead.
          locale: "en-AU", daterange: cfg.maxAgeDays,
        });
        const { data = [] } = await getJson(`${SEARCH_URL}?${params}`, { headers: { Accept: "application/json" } });
        for (const j of data) {
          if (!(j.locations?.[0]?.label ?? "").toLowerCase().includes(city)) continue;
          jobs.set(String(j.id), {
            source: "seek",
            sourceId: String(j.id),
            title: j.title,
            company: j.companyName || j.advertiser?.description || "",
            location: j.locations?.[0]?.label ?? "",
            listedAt: j.listingDate ?? "",
            salary: j.salaryLabel ?? "",
            workType: (j.workTypes ?? []).join(", "),
            summary: j.teaser ?? "",
            url: `https://www.seek.com.au/job/${j.id}`,
          });
        }
        if (data.length < PAGE_SIZE) break;
        await sleep(cfg.requestDelayMs);
      }
    } catch (err) {
      log(`seek: search for "${keywords}" failed - ${err.message}`);
    }
  }
  return [...jobs.values()];
}

export async function details(job) {
  const res = await request(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "seek-request-brand": "seek", "seek-request-country": "AU" },
    body: JSON.stringify({
      operationName: "jobDetails",
      query: DETAILS_QUERY,
      variables: { jobId: job.sourceId, zone: "anz-1", locale: "en-AU" },
    }),
  });
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors[0].message);
  const d = data?.jobDetails;
  if (!d?.job) return {};

  const slug = d.companyProfile?.companyNameSlug;
  const reviewsUrl = slug ? `https://www.seek.com.au/companies/${slug}/reviews` : "";
  const overall = d.companyProfile?.reviewsSummary?.overallRating;
  return {
    descriptionHtml: d.job.content ?? "",
    salary: d.job.salary?.label,
    workType: d.job.workTypes?.label,
    location: d.job.location?.label,
    reviewsUrl,
    rating: overall ? { site: "Seek", value: overall.value, count: overall.numberOfReviews?.value ?? 0, url: reviewsUrl } : null,
  };
}
