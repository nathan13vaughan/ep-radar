import { request, sleep } from "./http.js";

// Where each role is and how far it is from home, using free OpenStreetMap services:
// Nominatim turns "Camberwell, Melbourne VIC" into coordinates, and the public OSRM server
// gives the driving distance and time (free-flow, no traffic). Both ask for light use, so
// every answer is cached in the database and new lookups are made at most once a second.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const MELBOURNE_BOX = "144.30,-37.35,145.95,-38.60"; // Greater Melbourne: left, top, right, bottom
const CBD = { lat: -37.8136, lng: 144.9631, label: "Melbourne CBD" };
const HEADERS = { "User-Agent": "EP-Radar/1.0 (personal job search; github.com/nathan13vaughan/ep-radar)", Accept: "application/json" };
const MISS_RETRY_DAYS = 30;
const GENERIC = /^(greater melbourne( area)?|melbourne( cbd)?|victoria|australia|aus|vic|cbd & inner suburbs|melbourne & regional)$/i;

let lastCall = 0;
let lookups = 0;
async function politely(url) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  lookups++;
  return (await request(url, { headers: HEADERS, retries: 1 })).json();
}

// Searches to try for a job, most precise first. `approx` says what the answer really points at.
function candidates(job) {
  const parts = (job.location ?? "")
    .replace(/^VIC\s*-\s*/i, "")
    .split(",")
    .map((p) => p.replace(/\b(VIC|AUS)\b|\b\d{4}\b/gi, "").replace(/\s{2,}/g, " ").trim())
    .filter((p) => p && !GENERIC.test(p));
  const list = [];
  if (parts.length) list.push({ query: parts.join(", "), approx: false });
  if (parts.length > 1) list.push({ query: parts[0], approx: false });
  for (const p of parts) {
    const inner = p.match(/\(([^)]+)\)/)?.[1]; // "VCCC (Parkville)" -> "Parkville"
    if (inner) list.push({ query: inner, approx: false });
  }
  if (job.company) list.push({ query: job.company, approx: "employer" });
  return list.map((c) => ({ ...c, key: `geo:${c.query.toLowerCase()}, victoria, australia`, query: `${c.query}, Victoria, Australia` }));
}

// "Monash Health, Clayton" or "Camberwell": the place's name plus its suburb, without street numbers.
function placeLabel(hit) {
  const a = hit.address ?? {};
  const suburb = a.suburb ?? a.town ?? a.city_district ?? a.village ?? a.city ?? "";
  const name = hit.name || suburb || hit.display_name.split(",")[0];
  return [...new Set([name, suburb].filter(Boolean))].join(", ");
}

const homeKey = (cfg) => `geo:${cfg.home.query.toLowerCase()}`;
const routeKey = (a, b) => `route:${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
const fresh = (cached) => cached && (!cached.miss || Date.now() - Date.parse(cached.at) < MISS_RETRY_DAYS * 864e5);

async function geocode(key, query, db, limit) {
  const cached = db.getPlace(key);
  if (fresh(cached)) return cached.miss ? null : cached;
  if (lookups >= limit) return null;
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", addressdetails: "1", countrycodes: "au", viewbox: MELBOURNE_BOX, bounded: "1" });
  const [hit] = await politely(`${NOMINATIM}?${params}`);
  const place = hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: placeLabel(hit) } : { miss: true, at: new Date().toISOString() };
  db.savePlace(key, place);
  return hit ? place : null;
}

async function route(home, point, db, limit) {
  const key = routeKey(home, point);
  if (db.getPlace(key) || lookups >= limit) return;
  const res = await politely(`${OSRM}${home.lng},${home.lat};${point.lng},${point.lat}?overview=false`);
  const r = res.routes?.[0];
  if (res.code === "Ok" && r) db.savePlace(key, { km: Math.round(r.distance / 100) / 10, mins: Math.round(r.duration / 60) });
}

// Looks up any places and routes not already cached, up to cfg.maxLocationLookupsPerRun.
export async function refreshPlaces(jobs, db, cfg, log) {
  lookups = 0;
  const limit = cfg.maxLocationLookupsPerRun ?? 300;
  const home = await geocode(homeKey(cfg), cfg.home.query, db, limit);
  if (!home) return log(`travel: couldn't find "${cfg.home.query}" on the map`);
  let failed = 0;
  for (const job of jobs) {
    if (lookups >= limit) break;
    try {
      let point = null;
      for (const c of candidates(job)) if ((point = await geocode(c.key, c.query, db, limit))) break;
      await route(home, point ?? CBD, db, limit);
    } catch {
      failed++;
    }
  }
  if (lookups || failed) log(`travel: ${lookups} new map lookup(s)${failed ? `, ${failed} failed` : ""}${lookups >= limit ? " (limit reached, the rest next check)" : ""}`);
}

export function homePlace(db, cfg) {
  const home = cfg.home && db.getPlace(homeKey(cfg));
  return home && !home.miss ? { label: cfg.home.label, lat: home.lat, lng: home.lng } : null;
}

// Cached location and trip for a job (no network). Null until its place has been looked up.
export function placeFor(job, db, cfg) {
  const home = homePlace(db, cfg);
  if (!home) return null;
  let point = null;
  let approx = false;
  for (const c of candidates(job)) {
    const cached = db.getPlace(c.key);
    if (!cached) return null; // not looked up yet
    if (!cached.miss) {
      point = cached;
      approx = c.approx;
      break;
    }
  }
  if (!point) {
    point = CBD; // the ad only says "Melbourne"
    approx = "city";
  }
  const trip = db.getPlace(routeKey(home, point));
  return { lat: point.lat, lng: point.lng, label: point.label, approx, km: trip?.km ?? null, mins: trip?.mins ?? null };
}
