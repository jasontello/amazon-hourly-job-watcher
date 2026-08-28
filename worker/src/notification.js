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
    `${opportunity.payDisplay} | starts ${opportunity.firstDay}\n  ${opportunity.fitSummary}`
  );
}

export function formatNotification(opportunities) {
  if (!opportunities.length) throw new Error("At least one opportunity is required");
  const first = opportunities[0];
  if (opportunities.length === 1) {
    return [
      first.profileLabel,
      first.title,
      `Location: ${first.location}`,
      ...(first.siteIds?.length ? [`Site: ${first.siteIds.join(", ")}`] : []),
      `Shift: ${first.scheduleType} | ${first.scheduleText}`,
      `Why it fits: ${first.fitSummary}`,
      `Hours/type: ${first.hoursPerWeek ?? "Not listed"} hrs/week | ${first.employmentType}`,
      `Pay: ${first.payDisplay}`,
      `Posted by Amazon: ${first.postedAt}`,
      `Detected: ${formatDetectedAt(first.detectedAt)}`,
      `First day: ${first.firstDay}`,
      `Apply: ${directApplicationUrl(first)}`,
    ].join("\n");
  }
  return [
    first.profileLabel,
    first.title,
    `Location: ${first.location}`,
    ...(first.siteIds?.length ? [`Site: ${first.siteIds.join(", ")}`] : []),
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
    Title: preferred ? "Preferred Amazon day job" : "Amazon day-shift job available",
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

export async function sendTelegram(env, opportunities, preferred) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets are required");
  }
  const first = opportunities[0];
  const applicationUrl = directApplicationUrl(first);
  const title = preferred ? "PREFERRED AMAZON DAY JOB" : "AMAZON DAY-SHIFT JOB";
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${title}\n\n${formatNotification(opportunities)}`,
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: "Apply now", url: applicationUrl }]],
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Telegram returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
}

export async function sendDiscord(env, opportunities, preferred) {
  const webhookUrl = String(env.DISCORD_WEBHOOK_URL || "").trim();
  if (!/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//.test(webhookUrl)) {
    throw new Error("DISCORD_WEBHOOK_URL must be an official Discord HTTPS webhook URL");
  }
  const first = opportunities[0];
  const applicationUrl = directApplicationUrl(first);
  const title = preferred ? "Preferred Amazon day job" : "Amazon day-shift job available";
  const description = formatNotification(opportunities);
  const separator = description.lastIndexOf("\nApply");
  const withoutApplyLine = separator >= 0 ? description.slice(0, separator) : description;
  const response = await fetch(`${webhookUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Amazon Job Watcher",
      content: `**${title} — ${first.profileLabel}**`,
      embeds: [
        {
          title: first.title,
          url: applicationUrl,
          description: withoutApplyLine.slice(0, 4_096),
          color: preferred ? 0xff9900 : 0x3498db,
          footer: { text: "Tap the title to apply on Amazon. The watcher never applies automatically." },
        },
      ],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Discord returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
}

export async function sendNotification(env, opportunities, preferred) {
  if (env.DISCORD_WEBHOOK_URL) {
    return sendDiscord(env, opportunities, preferred);
  }
  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID) {
    return sendTelegram(env, opportunities, preferred);
  }
  return sendNtfy(env, opportunities, preferred);
}
