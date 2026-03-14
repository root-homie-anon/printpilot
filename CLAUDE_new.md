# PrintPilot — Master Project File

## System Overview
PrintPilot is a fully automated digital product business engine. It researches trending niches using eRank (keyword search volume, competition scores, trend data) and Apify (live Etsy listing data, competitor shop analysis, bestseller scraping), designs printable PDF products (planners, trackers, journals, worksheets) via an HTML→PDF pipeline, scores each product against market data, surfaces them for human visual approval, publishes approved listings to Etsy via the official API, and drives multi-channel marketing on a staggered schedule. A weekly feedback synthesis loop auto-updates agent instructions based on your design reviews, compounding quality over time. The system runs daily on a cron schedule, indefinitely, with minimal human input beyond the approval gate.

### Research Stack
- **eRank Pro** ($9.99/mo) — keyword search volume, competition scores, CTR rates, trend data, estimated sales velocity. Data derived from aggregated seller behaviour via official Etsy API access. Tells us what's being searched and what's selling.
- **Apify** (~$3-5/mo) — live Etsy listing scraper via MCP. Pulls raw listing data: titles, prices, favorites, review counts, images, seller info from search results and bestseller pages. Tells us what's listed and how it looks.
- **Google Trends** (free) — macro trend signals to catch rising niches early.
- **Alura API** (waitlist) — when available, will supplement or replace eRank with richer data. Join waitlist at alura.io/api.

### Monthly Operating Cost
| Service | Cost |
|---------|------|
| Claude API | ~$15-20 |
| eRank Pro | $9.99 |
| Apify | ~$3-5 |
| Etsy listing fees ($0.20 × ~60 listings) | ~$12 |
| **Total** | **~$40-47/mo** |

---

## Session Start Hook
On every session start, fire the agent factory hook:
```
bash ~/.claude/hooks/session-start.sh "printpilot" "$(pwd)"
```
This loads existing agents, offers to create new ones if needed, and prepares the session.

---

## Orchestrator Behavior

This file is the root orchestrator. On session start:

1. Fire the session-start hook
2. Load state from `state/` if it exists
3. Ask the user: continue existing run, start a new one, or initialize a new sub-project
4. Spawn subagents scoped to their domain — they share no state unless explicitly passed
5. Multiple subagents can run in parallel where pipelines allow

### Daily Run Sequence
```
06:00  @orchestrator wakes, checks queue
06:05  @researcher runs — eRank keyword data + Apify listing scrape + Google Trends
07:00  @strategist runs — scores opportunities, picks top 1-3, generates product briefs
07:30  @designer runs — generates HTML/CSS, Puppeteer renders to PDF
08:30  @copywriter runs — writes Etsy title, description, 13 tags per product
09:00  @scorer runs — compiles approval report with market metrics + design scores
09:15  YOU notified via Telegram — quick review form (< 2 min per product)

[On approval]
10:00  @listing-agent publishes to Etsy

[2 days later — after listing confirmed live and healthy]
Day+2  @marketing-agent: Pinterest pins go live
Day+3  @marketing-agent: Email list notification
Day+7  @marketing-agent: SEO blog post published
```

### Weekly Run (Sundays)
```
10:00  YOU receive weekly deep-review batch — annotate designs in detail
12:00  @synthesizer ingests all daily scores + weekly annotations
12:30  Agent instruction files auto-updated
12:35  Changelog notification sent — summary of what changed and why
```

---

## Agent Team
All agents live in `.claude/agents/` and are shared across the project.

| Agent | Role |
|-------|------|
| `@orchestrator` | Drives daily + weekly schedules, manages state, routes between agents, sends notifications |
| `@researcher` | Queries eRank for keyword/trend data + Apify MCP for live listing data + Google Trends. Builds ranked opportunity queue. |
| `@strategist` | Scores opportunities, selects top picks, generates structured product briefs |
| `@designer` | Generates HTML/CSS templates per brief, invokes Puppeteer to render multi-page PDFs |
| `@copywriter` | Writes SEO-optimized Etsy titles, descriptions, tags, and marketing copy per product |
| `@scorer` | Aggregates market metrics + design QA into approval report dashboard |
| `@listing-agent` | Publishes approved products to Etsy via API, monitors listing health |
| `@marketing-agent` | Generates and schedules Pinterest pins, email campaigns, blog posts — gated on listing health |
| `@tracker` | Aggregates all performance metrics into the dashboard, monitors revenue and trends |
| `@synthesizer` | Weekly: ingests feedback, extracts patterns, auto-updates agent instruction files, emits changelog |

---

## Project Structure

```
printpilot/
├── CLAUDE.md                        ← this file, root orchestrator
├── .claude/
│   └── agents/
│       ├── orchestrator.md
│       ├── researcher.md
│       ├── strategist.md
│       ├── designer.md
│       ├── copywriter.md
│       ├── scorer.md
│       ├── listing-agent.md
│       ├── marketing-agent.md
│       ├── tracker.md
│       └── synthesizer.md
├── .env                             ← secrets, never committed
├── .env.example                     ← committed, documents required vars
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
├── src/
│   ├── agents/                      ← agent runner logic
│   ├── pipeline/                    ← pipeline orchestration
│   │   ├── production.ts            ← research → design → approve → publish
│   │   └── marketing.ts             ← staggered marketing rollout
│   ├── research/                    ← research integrations
│   │   ├── erank.ts                 ← eRank API client (keywords, trends, competition)
│   │   ├── apify.ts                 ← Apify MCP client (live listing scraping)
│   │   ├── google-trends.ts         ← Google Trends client
│   │   └── alura.ts                 ← Alura API client (stub, ready for when API opens)
│   ├── renderer/                    ← HTML→PDF rendering via Puppeteer
│   │   ├── render.ts
│   │   ├── templates/               ← base HTML/CSS design templates
│   │   └── reference-library/       ← scraped visual references per niche
│   ├── etsy/                        ← Etsy API client
│   ├── marketing/                   ← Pinterest, email, blog integrations
│   ├── dashboard/                   ← tracking dashboard web UI
│   ├── feedback/                    ← daily quick form + weekly annotation UI
│   └── synthesizer/                 ← feedback ingestion + instruction updater
├── scripts/
│   ├── cron-daily.sh                ← triggers daily pipeline
│   ├── cron-weekly.sh               ← triggers weekly synthesis
│   └── health-check.sh
├── state/                           ← runtime state, gitignored
│   ├── queue/                       ← opportunity queue
│   ├── products/                    ← per-product state files
│   ├── listings/                    ← live listing metadata
│   └── marketing/                   ← scheduled content state
├── feedback/                        ← persistent feedback store, gitignored
│   ├── daily/                       ← quick review records
│   ├── weekly/                      ← deep annotation records
│   └── synthesized/                 ← extracted patterns + instruction diffs
├── shared/
│   ├── design-system.md             ← typography, spacing, color palette rules
│   ├── niche-registry.md            ← known niches, performance history
│   └── agent-changelog.md           ← running log of instruction updates
└── config.json
```

---

## config.json Schema

```json
{
  "project": {
    "name": "PrintPilot",
    "slug": "printpilot",
    "version": "1.0.0"
  },
  "pipeline": {
    "productsPerDay": 2,
    "marketingBufferDays": 2,
    "pinterestDelayDays": 2,
    "emailDelayDays": 3,
    "blogDelayDays": 7
  },
  "credentials": {
    "etsyOAuth": ".credentials/etsy-oauth.json",
    "pinterestOAuth": ".credentials/pinterest-oauth.json",
    "emailProvider": ".credentials/email.json",
    "blogApi": ".credentials/blog.json"
  },
  "agents": {
    "designer": {
      "pageSize": "A4",
      "exportDpi": 300,
      "referenceLibraryPath": "src/renderer/reference-library"
    },
    "researcher": {
      "maxOpportunitiesPerRun": 10,
      "minReviewCount": 50,
      "targetPriceRange": [3, 25],
      "erankPlan": "pro",
      "apifyActors": {
        "searchScraper": "etsy-products-search-scraper",
        "shopScraper": "etsy-shop-scraper",
        "bestsellerScraper": "etsy-best-sellers-scraper"
      },
      "aluraApiEnabled": false
    },
    "marketing": {
      "pinsPerProduct": 3,
      "emailEnabled": true,
      "blogEnabled": true
    }
  },
  "notifications": {
    "channel": "telegram",
    "approvalRequired": true,
    "weeklyReviewDay": "sunday"
  },
  "features": {
    "autoPublish": false,
    "autoSynthesize": true,
    "dashboardEnabled": true,
    "marketingEnabled": true
  }
}
```

---

## Pipelines

### Production Pipeline
```
researcher → strategist → designer → copywriter → scorer → [APPROVAL GATE] → listing-agent
```
- Each stage writes output to `state/products/[product-id]/`
- Failures at any stage halt that product, notify via Telegram, move to next
- Approval gate fires Telegram notification with scoring dashboard link
- listing-agent confirms Etsy URL live before handing off to marketing pipeline

### Marketing Pipeline (offset by config.marketingBufferDays)
```
listing-agent confirms live → marketing-agent health check → Pinterest → Email → Blog
```
- Each channel gated individually — Pinterest failure doesn't block email
- All scheduled content written to `state/marketing/` before execution
- If listing URL fails health check, entire marketing pipeline pauses and notifies

### Learning Pipeline (weekly)
```
synthesizer ingests feedback/ → extracts patterns → diffs agent instructions → auto-applies → emits changelog
```
- Changelog written to `shared/agent-changelog.md`
- Telegram notification with summary of changes
- No human approval required — fully auto-applied

---

## Feedback System

### Daily Quick Review (< 2 min)
Triggered when a product hits the approval gate. Form fields:
- Layout quality (1–5)
- Typography (1–5)
- Color / aesthetic match to top sellers (1–5)
- Differentiation from competitors (1–5)
- Overall sellability (1–5)
- Specific issues (freetext)
- Problem source: design / spec / research
- Decision: approve / reject / revise

### Weekly Deep Review
Batch of that week's products sent Sunday morning. Per-product:
- Page-level annotations (mark specific areas)
- Detailed notes per section
- Comparison against reference designs
- Suggestions for instruction improvements

### Synthesizer Rules
- Runs every Sunday after weekly review window closes
- Minimum 3 data points required before updating any instruction
- Changes scoped to specific agent + niche combination where possible
- All changes logged with reasoning to `shared/agent-changelog.md`
- Telegram notification: "7 instruction updates applied this week" with diff summary

---

## Tracking Dashboard
Live web UI at `localhost:3000` (or deployed URL). Panels:
- Products in pipeline (per stage)
- Live listings count + total estimated monthly revenue
- Per-listing: views, favorites, conversion rate, revenue
- Niche performance leaderboard
- Design quality score trend over time
- Agent activity log (last 7 days)
- Marketing content scheduled queue
- Feedback score history

---

## GitHub Workflow

- `main` — production, protected, no direct pushes
- `dev` — integration branch
- `feature/[slug]` — per-feature branches, PR into dev
- `release/[version]` — cut from dev, merge into main

CI runs on every PR: lint → typecheck → test → build.
Deployments trigger automatically on merge to `main`.

---

## Shared Resources

### API Keys
All shared keys in `.env` at project root. See `.env.example` for required vars.

### .env.example
```
# Anthropic
ANTHROPIC_API_KEY=

# Etsy
ETSY_API_KEY=
ETSY_API_SECRET=
ETSY_SHOP_ID=

# Research — eRank
ERANK_API_KEY=
ERANK_PLAN=pro

# Research — Apify
APIFY_API_TOKEN=

# Research — Alura (when API becomes available)
ALURA_API_KEY=

# Pinterest
PINTEREST_ACCESS_TOKEN=

# Email (e.g. Resend, Mailchimp, ConvertKit)
EMAIL_PROVIDER=
EMAIL_API_KEY=
EMAIL_LIST_ID=

# Blog (e.g. WordPress, Ghost)
BLOG_API_URL=
BLOG_API_KEY=

# Notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_SECRET=
```

### Shared Utilities
```
shared/
├── design-system.md       ← typography, spacing, color palette rules
├── niche-registry.md      ← known niches with performance history
└── agent-changelog.md     ← running log of all instruction updates
```

---

## Automation Assumptions
- Everything is automated unless explicitly noted as human-handled
- Human touchpoints: daily approval gate (< 2 min), weekly deep review (30–60 min)
- All long-running tasks are async with state written to `state/`
- Agents are stateless — all context passed explicitly per invocation
- Marketing pipeline always checks listing health before firing
- Errors surface to Telegram immediately
- No manual steps in the critical path outside designated review windows

---

## Code Standards
- TypeScript strict mode — no `any`, explicit return types
- Naming: kebab-case files, PascalCase classes/types, camelCase functions, UPPER_SNAKE_CASE constants
- Formatting: Prettier, single quotes, semicolons, 2-space indent, 100 char line width
- Imports: external libs → internal utils → services → types
- Async: always async/await, never callbacks
- Errors: custom error classes per domain

---

## Initialization Checklist
- [ ] Clone repo and run `npm install`
- [ ] Copy `.env.example` → `.env` and fill in all values
- [ ] Set up Etsy OAuth credentials via Developer Portal
- [ ] Set up Pinterest OAuth credentials
- [ ] Sign up for eRank Pro and add API key
- [ ] Sign up for Apify and add API token — confirm MCP server at `mcp.apify.com` is accessible
- [ ] Join Alura API waitlist at alura.io/api (future upgrade)
- [ ] Configure Telegram bot and get chat ID
- [ ] Configure email provider and list ID
- [ ] Configure blog API (WordPress/Ghost)
- [ ] Run `bash ~/.claude/hooks/session-start.sh "printpilot" "$(pwd)"`
- [ ] Verify all agents load correctly
- [ ] Run `scripts/health-check.sh` to confirm all integrations live
- [ ] Confirm CI pipeline is green
- [ ] Set cron jobs: `scripts/cron-daily.sh` at 06:00, `scripts/cron-weekly.sh` at 10:00 Sunday
