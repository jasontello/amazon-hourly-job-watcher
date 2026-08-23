import assert from "node:assert/strict";
import test from "node:test";

import { buildOpportunities, cardMatches, isPreferred } from "../src/amazon.js";
import { directApplicationUrl, formatNotification } from "../src/notification.js";

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
});

test("builds a preferred Flex opportunity and schedule-specific application URL", () => {
  const [opportunity] = buildOpportunities(
    {
      jobId: "JOB-US-123",
      jobTitle: "Delivery Station Warehouse Associate",
      city: "Oakley",
      state: "CA",
      locationName: "Oakley, CA",
      jobTypeL10N: "Flex Time",
    },
    { mostRecentPostedDate: "2026-08-23" },
    [
      {
        scheduleId: "SCH-US-456",
        employmentType: "Regular",
        scheduleTypeL10N: "Flex Time",
        scheduleText: "Flexible Shifts",
        hoursPerWeek: 19,
        totalPayRate: 22.5,
        totalPayRateL10N: "$22.50",
        firstDayOnSite: "2026-09-01",
      },
    ],
    new Date("2026-08-23T19:30:00Z"),
  );
  assert.equal(isPreferred(opportunity), true);
  assert.match(directApplicationUrl(opportunity), /jobId=JOB-US-123/);
  assert.match(directApplicationUrl(opportunity), /scheduleId=SCH-US-456/);
  assert.match(formatNotification([opportunity]), /Flexible Shifts/);
  assert.match(formatNotification([opportunity]), /\$22.50\/hour/);
});

test("groups multiple schedules into one concise message", () => {
  const opportunities = buildOpportunities(
    {
      jobId: "JOB-US-123",
      jobTitle: "Warehouse Associate",
      city: "Vacaville",
      state: "CA",
      locationName: "Vacaville, CA",
    },
    {},
    [
      { scheduleId: "SCH-1", scheduleType: "PART_TIME", scheduleText: "Morning" },
      { scheduleId: "SCH-2", scheduleType: "FULL_TIME", scheduleText: "Night" },
    ],
    new Date("2026-08-23T19:30:00Z"),
  );
  const message = formatNotification(opportunities);
  assert.match(message, /2 new selectable schedules/);
  assert.match(message, /Morning/);
  assert.match(message, /Night/);
});

