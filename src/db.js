import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Jobs and company research are stored as JSON blobs; only the columns we query on are broken out.
export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key);
    CREATE TABLE IF NOT EXISTS companies (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      researched_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS places (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);

  const readJob = (row) => ({ ...JSON.parse(row.data), lastSeen: row.last_seen, notified: Boolean(row.notified) });
  const stmt = {
    count: db.prepare("SELECT COUNT(*) AS n FROM jobs"),
    get: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    all: db.prepare("SELECT * FROM jobs"),
    touch: db.prepare("UPDATE jobs SET last_seen = ? WHERE id = ?"),
    save: db.prepare("INSERT OR REPLACE INTO jobs (id, dedupe_key, notified, last_seen, data) VALUES (?, ?, 0, ?, ?)"),
    update: db.prepare("UPDATE jobs SET data = ? WHERE id = ?"),
    notify: db.prepare("UPDATE jobs SET notified = 1 WHERE id = ?"),
    getCompany: db.prepare("SELECT * FROM companies WHERE key = ?"),
    allCompanies: db.prepare("SELECT * FROM companies"),
    saveCompany: db.prepare("INSERT OR REPLACE INTO companies (key, name, researched_at, data) VALUES (?, ?, ?, ?)"),
    getPlace: db.prepare("SELECT data FROM places WHERE key = ?"),
    savePlace: db.prepare("INSERT OR REPLACE INTO places (key, data) VALUES (?, ?)"),
  };

  return {
    jobCount: () => stmt.count.get().n,
    getJob: (id) => {
      const row = stmt.get.get(id);
      return row ? readJob(row) : null;
    },
    allJobs: () => stmt.all.all().map(readJob),
    touch: (id, when) => stmt.touch.run(when, id),
    saveJob: (job) => stmt.save.run(job.id, job.dedupeKey, job.lastSeen, JSON.stringify(job)),
    // Rewrites a known job's details without touching its notified flag or last-seen time.
    updateJob: (job) => stmt.update.run(JSON.stringify(job), job.id),
    markNotified: (id) => stmt.notify.run(id),
    getCompany: (key) => {
      const row = stmt.getCompany.get(key);
      return row ? { ...JSON.parse(row.data), researchedAt: row.researched_at } : null;
    },
    allCompanies: () =>
      Object.fromEntries(stmt.allCompanies.all().map((r) => [r.key, { ...JSON.parse(r.data), researchedAt: r.researched_at }])),
    saveCompany: (key, name, data) => stmt.saveCompany.run(key, name, new Date().toISOString(), JSON.stringify(data)),
    // Cached map lookups: "geo:<search>" -> coordinates, "route:<from>><to>" -> distance and time.
    getPlace: (key) => {
      const row = stmt.getPlace.get(key);
      return row ? JSON.parse(row.data) : null;
    },
    savePlace: (key, data) => stmt.savePlace.run(key, JSON.stringify(data)),
  };
}
