import { spawn } from "node:child_process";

// Windows toast notifications, sent through PowerShell's registered app id so no extra install is needed.
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const xmlEscape = (s = "") => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export function desktop(title, lines, url) {
  if (process.platform !== "win32") return Promise.resolve();
  const link = url ? ` activationType="protocol" launch="${xmlEscape(url)}"` : "";
  const texts = [title, ...lines].filter(Boolean).slice(0, 3).map((t) => `<text>${xmlEscape(t)}</text>`).join("");
  const actions = url ? `<actions><action content="Open" activationType="protocol" arguments="${xmlEscape(url)}"/></actions>` : "";
  const xml = `<toast${link}><visual><binding template="ToastGeneric">${texts}</binding></visual>${actions}</toast>`;
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
      stdio: "ignore",
      windowsHide: true,
    });
    ps.on("exit", resolve);
    ps.on("error", resolve);
  });
}

// Phone push via ntfy (https://ntfy.sh) - install the ntfy app and subscribe to your topic.
async function ntfy(cfg, title, message, url) {
  const { ntfyServer, ntfyTopic } = cfg.notifications;
  await fetch(ntfyServer.replace(/\/$/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: ntfyTopic, title, message, tags: ["hospital"], ...(url?.startsWith("http") ? { click: url } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
}

export async function send(cfg, title, lines, url) {
  if (cfg.notifications.desktop) await desktop(title, lines, url);
  if (cfg.notifications.ntfyTopic) {
    try {
      await ntfy(cfg, title, lines.filter(Boolean).join("\n"), url);
    } catch (err) {
      console.error(`ntfy notification failed - ${err.message}`);
    }
  }
}

export async function notifyJobs(cfg, jobs, reportUrl) {
  const individual = jobs.slice(0, 3);
  for (const job of individual) {
    const pay = [job.salary || job.ai?.salary, job.workType || job.ai?.employment_type].filter(Boolean).join(" · ");
    const tag = job.isHospital ? "New hospital EP job" : "New EP job";
    await send(cfg, `${tag}: ${job.title}`,[`${job.company} · ${job.location}`, pay], job.url);
  }
  const rest = jobs.length - individual.length;
  if (rest > 0) await send(cfg, `${rest} more new EP job${rest === 1 ? "" : "s"}`, ["Open the report to see them all."], reportUrl);
}
