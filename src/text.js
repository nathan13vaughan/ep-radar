const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•", middot: "·",
};

export function decodeEntities(s = "") {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[e.toLowerCase()] ?? match;
  });
}

// Strip an HTML fragment to readable plain text, keeping paragraph and list breaks.
export function htmlToText(html = "") {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h\d|li|ul|ol|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Inline HTML (a card title, a label) to a single clean line.
export const inlineText = (html) => (html ? decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "");

export const normalize = (s = "") => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
