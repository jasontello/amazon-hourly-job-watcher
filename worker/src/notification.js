import { WATCH_CONFIG } from "./config.js";

export function directApplicationUrl(opportunity) {
  const query = new URLSearchParams({
    jobId: opportunity.jobId,
    page: "pre-consent",
    scheduleId: opportunity.scheduleId,
    locale: "en-US",
    country: "US",
  });
  return `https://hiring.amazon.com/application/?${query}`;
}

function formatDetectedAt(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: WATCH_CONFIG.timezone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(date);
}

function scheduleLine(opportunity) {
  const hours =
    opportunity.hoursPerWeek === null
      ? "hours not listed"
      : `${opportunity.hoursPerWeek} hrs/week`;
  return (
    `- ${opportunity.scheduleType} | ${opportunity.scheduleText} | ${hours} | ` +
    `${opportunity.payDisplay} | starts ${opportunity.firstDay}`
  );
}

export function formatNotification(opportunities) {
  if (!opportunities.length) throw new Error("At least one opportunity is required");
  const first = opportunities[0];
  if (opportunities.length === 1) {
    return [
      first.title,
      `Location: ${first.location}`,
      `Shift: ${first.scheduleType} | ${first.scheduleText}`,
      `Hours/type: ${first.hoursPerWeek ?? "Not listed"} hrs/week | ${first.employmentType}`,
      `Pay: ${first.payDisplay}`,
      `Posted by Amazon: ${first.postedAt}`,
      `Detected: ${formatDetectedAt(first.detectedAt)}`,
      `First day: ${first.firstDay}`,
      `Apply: ${directApplicationUrl(first)}`,
    ].join("\n");
  }
  return [
    first.title,
    `Location: ${first.location}`,
    `${opportunities.length} new selectable schedules:`,
    ...opportunities.map(scheduleLine),
    `Employment: ${[...new Set(opportunities.map((item) => item.employmentType))].join(", ")}`,
    `Posted by Amazon: ${first.postedAt}`,
    `Detected: ${formatDetectedAt(first.detectedAt)}`,
    `Apply now: ${directApplicationUrl(first)}`,
  ].join("\n");
}

export async function sendNtfy(env, opportunities, preferred) {
  if (!env.NTFY_TOPIC) throw new Error("NTFY_TOPIC secret is not configured");
  const first = opportunities[0];
  const server = String(env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  if (!server.startsWith("https://")) throw new Error("NTFY_SERVER must use HTTPS");
  const url = `${server}/${encodeURIComponent(env.NTFY_TOPIC)}`;
  const applicationUrl = directApplicationUrl(first);
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: preferred ? "Amazon Flex job available" : "Amazon warehouse job available",
    Priority: preferred ? "urgent" : "high",
    Tags: preferred ? "rotating_light,package" : "package",
    Click: applicationUrl,
    Actions: `view, Apply now, ${applicationUrl}, clear=true`,
    ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formatNotification(opportunities),
  });
  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}

