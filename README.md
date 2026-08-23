# Amazon Hourly Job Watcher

A hosted watcher for Amazon hourly warehouse jobs in **Oakley, California** and **Vacaville,
California**, with urgent alerts for Flex Time / FlexPT / Flexible Shifts schedules.

It checks Amazon's official hourly hiring feed every five minutes, detects new matching schedules,
stores what it has already reported, and sends an ntfy push notification to an iPhone. It never logs
in, fills out an application, or applies automatically.

## Notification contents

- Job title and location
- Shift type and exact schedule text
- Hours per week and employment type
- Hourly pay when Amazon lists it
- Amazon's posting date and the exact detection time
- First-day date when available
- A direct official Amazon application URL with the job and schedule preselected

When one posting contains several new schedules, the watcher groups them into one push to avoid alert
spam. It stores each schedule ID separately, so a Flex schedule added later to an existing posting
creates a fresh alert.

## Architecture

```text
Cloudflare Cron Trigger (every 5 minutes)
  -> one strongly consistent Durable Object
  -> Amazon official hourly-jobs GraphQL feed
  -> exact city/state + warehouse keyword filters
  -> job details and selectable schedules
  -> compare with Durable Object seen-schedule state
  -> ntfy push to iPhone
  -> persist successfully delivered schedule IDs

GitHub
  -> source control + Python/Node tests + Worker bundle validation
```

Cloudflare is the continuous runtime because Amazon currently blocks GitHub-hosted runner IPs from
the hourly hiring feed. A live Cloudflare egress test confirmed that the official feed is reachable
from the Worker runtime. The Worker uses web-platform APIs and has no production dependencies.

## iPhone setup with ntfy

1. Install [ntfy from the iOS App Store](https://apps.apple.com/us/app/ntfy/id1625396347).
2. Create a long, hard-to-guess topic, such as `amazon-oakley-vacaville-` followed by a UUID.
   A topic on public `ntfy.sh` acts like a password: anyone who knows it can subscribe.
3. Subscribe to that exact topic in the ntfy app and allow notifications.
4. Keep the topic handy for the Cloudflare secret setup below.

## Deploy to Cloudflare

Requirements: Node.js 20 or newer and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler whoami
```

`wrangler login` opens Cloudflare's OAuth page. `whoami` must show the intended account before any
deployment.

Add the ntfy topic as an encrypted Worker secret:

```bash
npx wrangler secret put NTFY_TOPIC
```

Paste the exact topic when prompted. Optional secrets:

```bash
# Only when a private/self-hosted ntfy server requires a bearer token
npx wrangler secret put NTFY_TOKEN

# Enables the protected manual POST /run endpoint
npx wrangler secret put WATCHER_TOKEN
```

Deploy the Worker and its five-minute cron trigger:

```bash
npm run deploy
```

The first deployment creates the SQLite-backed Durable Object automatically. Cron changes can take
up to 15 minutes to propagate globally.

### Verify production

The deploy command prints a `workers.dev` URL. Check its health endpoint:

```bash
curl https://amazon-hourly-job-watcher.<your-subdomain>.workers.dev/health
```

Stream logs while a cron runs:

```bash
npm run tail
```

If `WATCHER_TOKEN` is configured, trigger an immediate check:

```bash
curl -X POST \
  -H 'Authorization: Bearer YOUR_WATCHER_TOKEN' \
  https://amazon-hourly-job-watcher.<your-subdomain>.workers.dev/run
```

The root endpoint and `/health` expose only service status. `/run` is disabled unless its secret is
set and rejects requests without the exact bearer token.

## First-run behavior

The first live run notifies you about matching jobs already open. That is intentional: an existing
opening is still actionable. After ntfy accepts a push, the Worker records all schedules included in
that notification.

If a notification fails, those schedule IDs are not marked delivered, so the next cron retries. If a
later schedule is added to an old job posting, only that unseen schedule triggers a new push.

## Change locations or keywords

Edit [`config.json`](config.json):

```json
{
  "locations": [
    { "city": "Oakley", "state": "CA" },
    { "city": "Vacaville", "state": "CA" }
  ],
  "include_keywords": [
    "warehouse",
    "fulfillment center",
    "sortation center",
    "delivery station",
    "package sorter"
  ],
  "preferred_shift_keywords": [
    "flex_time",
    "flex time",
    "flexible shifts",
    "flexpt",
    "flex pt"
  ]
}
```

The Worker and local Python CLI share this one config file. Location matching is exact and
case-insensitive. A job must match one configured city/state pair and one `include_keywords` entry.
Preferred shift keywords do not exclude other warehouse jobs; they set matching Flex pushes to
ntfy's **urgent** priority instead of **high**.

After a config change:

```bash
npm test
npm run deploy
```

## Test and run locally

The repository includes Worker unit tests and an independent Python 3.11+ CLI for live dry runs.

```bash
npm test
npx wrangler deploy --dry-run
python3 -m unittest discover -s tests -v
python3 -m amazon_job_watcher --dry-run
```

The Python `--dry-run` queries Amazon and prints unseen matches as JSON. It does not send a push or
modify `state/seen_jobs.json`.

Additional local Python commands:

```bash
# Send one sample push
NTFY_TOPIC='your-topic' python3 -m amazon_job_watcher --test-notification

# Record current local matches without notifying
python3 -m amazon_job_watcher --baseline

# Use another configuration file
python3 -m amazon_job_watcher --config path/to/config.json --dry-run
```

The local Python state file is separate from Cloudflare production state.

## Reliability and safety

- **Strongly consistent coordination:** every cron targets one Durable Object, with a transactional
  run lease to prevent overlapping or duplicate cron executions.
- **Schedule-level deduplication:** successful deliveries are keyed by Amazon schedule ID.
- **Grouped pushes:** all new schedules for one job become one notification.
- **Delivery ordering:** schedules are stored only after ntfy returns success.
- **Retries:** transient network errors, HTTP 403/408/429, and server errors use bounded exponential
  backoff with jitter.
- **Rate limiting:** Amazon requests are spaced by at least one second; only matching cards trigger
  detail and schedule calls.
- **Schema checks:** unexpected API responses fail loudly without corrupting deduplication state.
- **Timeouts:** every Amazon request has an abort timeout, and the cron records its last error.
- **Retention:** delivered schedule records expire after 365 days.
- **Secrets:** ntfy and manual-trigger credentials are encrypted Worker secrets, never source code.
- **No auto-apply:** the program reads public listings and sends official links only.

Worker observability is enabled in [`wrangler.jsonc`](wrangler.jsonc), and `/health` returns the last
run's status and counts. Positions can fill between detection and opening the application URL.

## Cost and timing

The Worker runs every five minutes, a deliberately conservative rate. Cloudflare's free Workers,
Cron Triggers, and Durable Objects allowances are sufficient for this small personal workload on
eligible accounts. If an account is not eligible for the free Durable Objects/Cron allowance,
Cloudflare will show the plan requirement before deployment; do not upgrade without reviewing the
current price.

To change the interval, edit [`wrangler.jsonc`](wrangler.jsonc):

```jsonc
"triggers": { "crons": ["*/10 * * * *"] }
```

Do not poll more often than every five minutes. Cron execution can drift slightly, so this is
near-real-time rather than a hard real-time guarantee.

## Data source and limitations

The watcher uses `https://hiring.amazon.com/graphql`, the structured hourly-job and schedule feed used
by Amazon's official hiring site. Amazon currently reports a posting **date**, not a precise posting
timestamp; pushes include that date and the watcher's precise detection time.

This project is independent and is not affiliated with or endorsed by Amazon, Cloudflare, or ntfy.
Use it responsibly and follow the applicable site and service terms.

