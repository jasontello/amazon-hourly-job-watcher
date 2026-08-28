import assert from "node:assert/strict";
import test from "node:test";

import {
  AmazonHourlyClient,
  buildOpportunities,
  cardMatches,
  isPreferred,
  matchOpportunityToProfile,
  parseScheduleText,
} from "../src/amazon.js";
import { WATCH_CONFIG } from "../src/config.js";
import {
  directApplicationUrl,
  formatNotification,
  sendNotification,
} from "../src/notification.js";

test("calls the runtime fetch function without rebinding its receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function runtimeFetch() {
    assert.equal(this, undefined);
    return Promise.resolve(Response.json({ data: { ok: true } }));
  };
  try {
    const client = new AmazonHourlyClient({
      amazonApiUrl: "https://example.test/graphql",
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 1_000,
      retryAttempts: 1,
    });
    assert.deepEqual(await client.post("test", "query test { ok }", {}), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matches target warehouse roles only", () => {
  assert.equal(
    cardMatches({
      city: "Vacaville",
      state: "CA",
      jobTitle: "Fulfillment Center Warehouse Associate",
    }),
    true,
  );
  assert.equal(
    cardMatches({ city: "Tracy", state: "CA", jobTitle: "Warehouse Associate" }),
    false,
  );
  assert.equal(
    cardMatches({ city: "Oakley", state: "CA", jobTitle: "Area Manager" }),
    false,
  );
  assert.equal(
    cardMatches({
      city: "West Sacramento",
      state: "CA",
      jobTitle: "Delivery Station Warehouse Associate",
    }),
    true,
  );
});

function rawOpportunity({
  city = "Oakley",
  state = "CA",
  siteId = [],
  scheduleType = "PART_TIME",
  scheduleTypeL10N = "Part Time",
  scheduleText = "Sun, Mon, Tue 7:00 AM - 5:00 PM",
  hoursPerWeek = 30,
} = {}) {
  return buildOpportunities(
    {
      jobId: "JOB-US-123",
      jobTitle: "Delivery Station Warehouse Associate",
      city,
      state,
      locationName: `${city}, ${state}`,
      jobTypeL10N: scheduleTypeL10N,
    },
    { mostRecentPostedDate: "2026-08-23", siteId },
    [
      {
        scheduleId: "SCH-US-456",
        employmentType: "Regular",
        scheduleType,
        scheduleTypeL10N,
        scheduleText,
        hoursPerWeek,
        totalPayRate: 22.5,
        totalPayRateL10N: "$22.50",
        firstDayOnSite: "2026-09-01",
      },
    ],
    new Date("2026-08-23T19:30:00Z"),
  )[0];
}

test("accepts Jason schedules that leave three Tue-Fri days free", () => {
  const jason = WATCH_CONFIG.profiles.find((profile) => profile.id === "jason");
  const sundayMondayTuesday = matchOpportunityToProfile(rawOpportunity(), jason);
  assert.deepEqual(sundayMondayTuesday.otherJobDays, ["Wed", "Thu", "Fri"]);

  const sundayWednesdaySaturday = matchOpportunityToProfile(
    rawOpportunity({ scheduleText: "Sun, Wed, Sat 7:00 AM - 5:00 PM" }),
    jason,
  );
  assert.deepEqual(sundayWednesdaySaturday.otherJobDays, ["Tue", "Thu", "Fri"]);

  const incompatible = matchOpportunityToProfile(
    rawOpportunity({ scheduleText: "Mon, Tue, Wed 7:00 AM - 5:00 PM" }),
    jason,
  );
  assert.equal(incompatible, null);
});

test("rejects full-time and sleep-disrupting fixed shifts for Jason", () => {
  const jason = WATCH_CONFIG.profiles.find((profile) => profile.id === "jason");
  assert.equal(
    matchOpportunityToProfile(
      rawOpportunity({ scheduleType: "FULL_TIME", scheduleTypeL10N: "Full Time" }),
      jason,
    ),
    null,
  );
  for (const scheduleText of [
    "Sun, Mon, Tue 1:20 AM - 11:50 AM",
    "Sun, Mon, Tue 6:30 PM - 5:00 AM",
    "Sun, Mon, Tue 7:30 PM - 11:30 PM",
  ]) {
    assert.equal(matchOpportunityToProfile(rawOpportunity({ scheduleText }), jason), null);
  }
});

test("allows Flex for Jason but labels its unknown hours for verification", () => {
  const jason = WATCH_CONFIG.profiles.find((profile) => profile.id === "jason");
  const opportunity = matchOpportunityToProfile(
    rawOpportunity({
      scheduleType: "FLEX_TIME",
      scheduleTypeL10N: "Flex Time",
      scheduleText: "Flexible Shifts",
      hoursPerWeek: 19,
    }),
    jason,
  );
  assert.equal(isPreferred(opportunity), true);
  assert.equal(opportunity.isFlexible, true);
  assert.match(opportunity.fitSummary, /verify daytime options/i);
  assert.match(directApplicationUrl(opportunity), /jobId=JOB-US-123/);
  assert.match(formatNotification([opportunity]), /For Jason/);
  assert.match(formatNotification([opportunity]), /\$22.50\/hour/);
});

test("requires exact DSM4 site and prefers its full-time day shift", () => {
  const friend = WATCH_CONFIG.profiles.find((profile) => profile.id === "friend_dsm4");
  const opportunity = matchOpportunityToProfile(
    rawOpportunity({
      city: "West Sacramento",
      siteId: ["SITE-DSM4"],
      scheduleType: "FULL_TIME",
      scheduleTypeL10N: "Full Time",
      scheduleText: "Sun, Mon, Tue, Wed 7:30 AM - 6:00 PM",
      hoursPerWeek: 40,
    }),
    friend,
  );
  assert.equal(opportunity.profileId, "friend_dsm4");
  assert.equal(isPreferred(opportunity), true);
  assert.match(formatNotification([opportunity]), /SITE-DSM4/);
  assert.equal(
    matchOpportunityToProfile(
      rawOpportunity({ city: "West Sacramento", siteId: ["SITE-DSM1"] }),
      friend,
    ),
    null,
  );
});

test("parses split day schedules and rejects any unsafe segment", () => {
  assert.equal(
    parseScheduleText("Sun, Mon, Thu 2:00 PM - 6:00 PM\nMon 7:30 PM - 11:30 PM").valid,
    false,
  );
  const parsed = parseScheduleText(
    "Tue, Thu 3:30 AM - 7:30 AM\nSun, Mon, Tue, Thu 9:30 AM - 1:30 PM",
  );
  assert.equal(parsed.valid, false);
});

test("groups multiple schedules into one concise message", () => {
  const jason = WATCH_CONFIG.profiles.find((profile) => profile.id === "jason");
  const first = matchOpportunityToProfile(rawOpportunity(), jason);
  const second = {
    ...matchOpportunityToProfile(
      rawOpportunity({ scheduleText: "Sat, Sun, Mon 8:00 AM - 4:00 PM" }),
      jason,
    ),
    scheduleId: "SCH-US-789",
  };
  const opportunities = [first, second];
  const message = formatNotification(opportunities);
  assert.match(message, /2 new selectable schedules/);
  assert.match(message, /other-job days available/);
});

test("prefers Telegram when its secrets are configured", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(options.body);
    return Response.json({ ok: true });
  };
  try {
    const jason = WATCH_CONFIG.profiles.find((profile) => profile.id === "jason");
    const opportunities = [
      matchOpportunityToProfile(
        rawOpportunity({
          scheduleType: "FLEX_TIME",
          scheduleTypeL10N: "Flex Time",
          scheduleText: "Flexible Shifts",
        }),
        jason,
      ),
    ];
    await sendNotification(
      { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "12345" },
      opportunities,
      true,
    );
    assert.match(requestedUrl, /api\.telegram\.org\/bottest-token\/sendMessage/);
    assert.equal(requestedBody.chat_id, "12345");
    assert.match(requestedBody.text, /PREFERRED AMAZON DAY JOB/);
    assert.match(requestedBody.reply_markup.inline_keyboard[0][0].url, /scheduleId=SCH-US-456/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
