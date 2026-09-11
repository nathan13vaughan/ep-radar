// Pattern-based extraction of hours, times and contract details from ad text.
// Works without AI; when AI is on its answers are preferred in the report.

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

export function extractDetails(raw = "") {
  const t = raw.replace(/\s+/g, " ");
  const x = {};

  const fte =
    t.match(/\b(0?\.\d{1,2}|1(?:\.0{1,2})?)\s*(?:FTE|EFT)\b/i) ??
    t.match(/\b(?:FTE|EFT)\s*(?:of|:)?\s*(0?\.\d{1,2}|1(?:\.0{1,2})?)\b/i);
  if (fte) x.fte = `${fte[1]} FTE`;

  const hours = t.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:hours|hrs)\s*(?:per|a|each|every|\/)\s*(week|fortnight)/i);
  if (hours) x.hours = `${hours[1]} hrs/${hours[2].toLowerCase()}`;

  const perWeek = t.match(/\b([1-5]|one|two|three|four|five)\s*days?\s*(?:per|a|each|\/)\s*(week|fortnight)/i);
  if (perWeek) x.daysPerWeek = `${WORD_NUMBERS[perWeek[1].toLowerCase()] ?? perWeek[1]} days/${perWeek[2].toLowerCase()}`;

  const span = t.match(/\b(Mon(?:day)?)\s*(?:to|-|–|through)\s*(Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/i);
  if (span) x.days = `${span[1]} to ${span[2]}`;

  const times = new Set();
  for (const m of t.matchAll(/\b(\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m\.?)\s*(?:-|–|to)\s*(\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m\.?)/gi)) {
    times.add(`${m[1]} – ${m[2]}`);
    if (times.size === 3) break;
  }
  if (times.size) x.times = [...times].join(", ");

  const notes = [];
  if (/\bno weekends?\b|weekends? off|monday to friday only/i.test(t)) notes.push("No weekends");
  else if (/\bweekends?\b/i.test(t)) notes.push("Weekends mentioned");
  if (/\broster(ed)?\b|rotating roster|rotational/i.test(t)) notes.push("Rostered");
  if (/\bon[- ]call\b/i.test(t)) notes.push("On-call mentioned");
  if (/\bflexib(le|ility)\b[^.]{0,40}\b(hours|days|schedule|working|arrangements?)\b/i.test(t)) notes.push("Flexible hours mentioned");
  if (notes.length) x.notes = notes;

  const TERM = "fixed[- ]term|temporary|contract|backfill|locum";
  const LENGTH = "(\\d{1,2}|six|twelve)[- ]?(months?|weeks?|years?)";
  const termFirst = t.match(new RegExp(`\\b(${TERM})\\b[^.;]{0,50}?\\b${LENGTH}\\b`, "i"));
  const lengthFirst = t.match(new RegExp(`\\b${LENGTH}\\b[^.;]{0,25}?\\b(${TERM})\\b`, "i"));
  // Skip benefit lines such as "12 weeks paid parental leave".
  if (termFirst && !/paid|leave/i.test(termFirst[0])) x.contract = `${termFirst[1]}, ${termFirst[2]} ${termFirst[3]}`;
  else if (lengthFirst && !/paid|leave/i.test(lengthFirst[0])) x.contract = `${lengthFirst[3]}, ${lengthFirst[1]} ${lengthFirst[2]}`;

  const award = t.match(/\b(Health Professional (?:Level|Grade) ?[1-5]|AHP ?[1-5]|HP ?[1-5]|(?:Level|Grade) ?[1-5](?: ?\/ ?[1-5])?)\b/i);
  if (award) x.award = award[1];

  return x;
}
