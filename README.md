# EP Job Observer

Watches **Seek**, **Indeed**, **LinkedIn** and Melbourne hospitals' own careers sites for **Exercise Physiology, Occupational Therapy, Exercise Science and Pilates** roles in **Melbourne**. It notifies you when a new one appears and keeps a report with everything you'd want to know before applying. Each role is tagged with its category, and the report has a tab for each one. Hospital-based roles are tagged too.

For each role you get:

| | Where it comes from |
|---|---|
| Salary | The listing (Seek/Indeed/LinkedIn), plus anything stated in the ad |
| Full time / part time / casual | The listing's work type, plus permanent vs fixed-term from the ad |
| Hours and times | FTE, hours per week, days, start/finish times, weekends, rosters and on-call, taken from the ad text |
| Award level | E.g. "Health Professional Level 2", from the ad |
| Company reviews | Seek's star rating and review count, plus (with AI on) a summary of reviews on Seek, Indeed and Glassdoor with pros and cons |
| Interview process | With AI on: stages, timeline, questions people were asked, and tips, researched on the web |

## Quick start

Needs Node.js 22.13 or newer (you have Node 24).

```bash
npm install
npm run check
```

The first check collects everything currently open and shows **one** summary notification. After that, you're notified only about roles that are new since the last check. The report opens in your browser (`report.html`).

In the report you can:
- search, filter by work type, and sort by date, pay or employer rating;
- save roles and mark the ones you've applied for (this is remembered in your browser);
- move through roles with ↑/↓ and press `/` to search;
- switch between light and dark themes with the sun/moon button.

## Turn on AI research (recommended)

Review summaries, the interview process, and the most reliable reading of hours and times all use Claude with web search. This runs through **Claude Code on your Claude subscription**, so no API key is needed:

- **On this computer:** if you're logged in to Claude Code (run `claude` once and log in), it just works.
- **On GitHub:** run `claude setup-token` in a terminal and log in; it prints a token that lasts a year. Then add that token as a repository secret by running the command below and pasting it when asked:

  ```bash
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo nathan13vaughan/ep-radar
  ```

The work counts toward your subscription's usage limits, so it's kept small:
- each employer is researched once every 30 days;
- ads are read six at a time;
- each check researches at most 6 employers, so a backlog is cleared over a few checks.

The limits are in `config.json` under `ai`. Without Claude, everything else still works, and each job card links to the employer's Seek, Indeed and Glassdoor reviews and interview pages.

## Keep it running

**Option A: Windows Task Scheduler (recommended).** Runs every 2 hours in the background while you're logged in:

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -EveryHours 2
```

Remove it with `scripts\uninstall-task.ps1`. The log is at `logs\observer.log`.

**Option B: GitHub (check from your phone, PC can be off).** `.github/workflows/check-jobs.yml` runs the checker on GitHub every 2 hours. It publishes the report to GitHub Pages and keeps the jobs database on a separate `state` branch, so you're only alerted about new roles. Setup:
1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages → Source** and choose **GitHub Actions**.
3. In **Settings → Secrets and variables → Actions**, add these secrets if you want them:
   - `CLAUDE_CODE_OAUTH_TOKEN`: Claude research on your subscription (see "Turn on AI research").
   - `NTFY_TOPIC`: phone alerts through the ntfy app.
4. On the **Actions** tab, open **Check for EP jobs** and click **Run workflow** for the first check.

The report is then at `https://<your-username>.github.io/<repo-name>/`. On your phone, use **Add to Home Screen** to open it like an app.

To search right away instead of waiting for the next scheduled check, tap **Search now** in the report. It either links to GitHub's **Run workflow** button, or with one-time setup starts the search itself.

For one-tap search, create a fine-grained GitHub token with:
- **Repository access:** this repo only.
- **Permissions:** Actions → Read and write.

Paste it into the report once. It's kept only in that browser, and all it can do is start this repo's search. The report shows the search's progress and reloads itself when the new results are published. Desktop pop-up notifications only work on Windows, so on GitHub, alerts come through ntfy. GitHub pauses scheduled runs if a repository has had no activity for 60 days; if that happens, re-enable the workflow on the Actions tab.

**Option C: leave a terminal open**

```bash
npm run watch
```

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Check once, notify, open the report |
| `npm run watch` | Check every `checkEveryMinutes` until you stop it |
| `npm run report` | Rebuild and open the report without searching |
| `npm run test-notify` | Send a test notification |

Flags for `node src/index.js`: `--watch`, `--open`, `--report-only`, `--no-notify`, `--no-ai`, `--test-notify`.

## Settings (`config.json`)

- `location`: where to search, written the way each site expects: `Melbourne VIC` for Seek and Indeed, and `Melbourne, Victoria, Australia` for LinkedIn. `radiusKm` sets the search distance on Indeed and LinkedIn.
- `categories`: the kinds of role to find: Exercise Physiology, Occupational Therapy, Exercise Science and Pilates. Each has:
  - `searchTerms`: what's searched on each site;
  - `titlePatterns`: which job titles belong to it (regular expressions, so `\\bOTs?\\b` matches "OT" as a word);
  - `mentionPatterns`: what an ad must say for a generic title to count;
  - a `label`, a short tag and a `color` for the report.

  Set `"enabled": false` on a category to stop searching for it, or copy one to add another role type (e.g. Physiotherapy).
- `titleExclude`: titles to drop. It also drops ads for other cities that are posted under "Melbourne" (e.g. "Relocation Opportunity to Canberra"). `titleExcludeUnlessRole` words, such as "nurse", only drop a title when it doesn't also name one of the roles outright.
- `broadTitleKeywords`: generic titles (e.g. "Allied Health Clinician") that are opened and kept only if the ad names one of the roles.
- `hospitalOnly`: set to `true` to be notified only about hospital-based roles (off by default).
- `hospitalEmployers`: employer names always treated as hospitals (add your local health service).
- `hospitalScoreThreshold`: how much evidence the keyword check needs before calling a role hospital-based when AI is off.
- `notifications.ntfyTopic`: to get alerts **on your phone**, install the free [ntfy](https://ntfy.sh) app, subscribe to a hard-to-guess topic name (e.g. `ep-jobs-8f3k2`), and put the same name here.

## How it decides a role is hospital-based

A keyword check scores each ad: does the employer look like a hospital or health service (e.g. "Local Health District", "Hospital and Health Service", "Ramsay Health")? Does the title or ad mention hospital, inpatient, ward or acute settings? With AI on, Claude reads the ad and makes the final call. So a private clinic that only mentions "hospital referrals" is excluded, and a Queensland Government ad for a Hospital and Health Service is included. Each job card shows why it passed ("Hospital check" under *Full ad*), and the **Hospital roles only** filter narrows the report to them.

## Hospital careers sites

Many hospitals post roles on their own careers site before, or instead of, the big job boards. The `careers` source reads these sites directly:
- Bayside Health (Alfred and Peninsula), Monash, Eastern, Western, Austin and Northern Health
- the Royal Melbourne, Royal Children's and Royal Women's hospitals, and Peter Mac
- St Vincent's, Cabrini, Mercy, Epworth, Ramsay, Calvary and Healthscope
- the Victorian Government job board (Careers.Vic)

Each site is listed under `careerSites` in `config.json` with the job-board system it runs on (Workday, SuccessFactors, SmartRecruiters, PageUp, Taleo or LiveHire). If a hospital moves to a new system, that entry will start logging errors while every other site keeps working. Set `"careers": false` under `sources` to switch the whole group off.

## Good to know

- Seek and LinkedIn are read through their public web endpoints, and Indeed through its mobile-app API. None of these is an official API, so a site can change without warning. If a source starts failing, the log will say so and the other sites keep working.
- It checks politely (a pause between requests, every 2 hours by default). Keep the frequency modest; LinkedIn in particular rate-limits heavy use.
- Everything is stored locally in `data/jobs.db`. Delete that file to start fresh.
