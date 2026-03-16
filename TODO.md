# PrintPilot — TODO

---

## Phase 2: Post-Launch Growth (after pipeline is live + validated)

### 10. Pinterest Marketing
- Enable `pinterestEnabled: true` in config.json
- Add `PINTEREST_ACCESS_TOKEN` to .env
- Creates 3 pins per product, fires Day+2 after listing goes live
- Drives traffic from Pinterest → Etsy listing
- Code complete: `src/marketing/pinterest.ts`, scheduler, marketing pipeline
- **Trigger:** after 10-20 listings are live and performing on Etsy search
- **Rationale:** Pinterest is free, high ROI for printables. Visual platform = ideal for planner/journal previews. But only worth the effort once you have a catalog to drive traffic to

### 11. Email Marketing
- Enable `emailEnabled: true` in config.json
- Add `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_LIST_ID` to .env
- Pick provider: Resend (simple), Mailchimp (established), or ConvertKit (creator-focused)
- Fires Day+3 after listing. Includes: welcome series, weekly digest, abandoned favorites, post-purchase
- Code complete: `src/marketing/email.ts`, `src/marketing/email-sequences.ts`
- Client stubs exist but need real API wiring for chosen provider
- **Trigger:** after building an email list (add opt-in to PDF inserts or Etsy shop announcement)
- **Rationale:** owned audience > platform dependency. Email converts 3-5x better than social. But need actual subscribers first

### 12. Blog / SEO Content
- Enable `blogEnabled: true` in config.json
- Add `BLOG_PLATFORM`, `BLOG_API_URL`, `BLOG_API_KEY` to .env
- Pick platform: WordPress or Ghost
- Auto-generates SEO blog posts per product targeting long-tail keywords
- Fires Day+7 after listing
- Code complete: `src/marketing/blog.ts`
- Client stubs exist but need real API wiring for chosen platform
- **Trigger:** after 30+ listings, when you want organic Google traffic
- **Rationale:** SEO is slow but compounds. Each blog post is a permanent traffic source. Not worth the setup cost until you have enough products to justify a content site

### 13. Multi-Shop Strategy
- Route products to 2-3 niche-clustered Etsy shops for specialist authority
- Suggested clusters:
  - Shop 1 (Productivity): planners, trackers, goal setting, habits, study
  - Shop 2 (Wellness): journals, self-care, fitness, wellness, gratitude
  - Shop 3 (Finance/Education): budget, expense, homework, tax
- Config change: add `shops[]` array with id, name, niches per shop
- Listing agent: niche → shop routing lookup (currently hardcoded to one ETSY_SHOP_ID)
- Marketing pipeline: run promotions/bundles per shop
- Dashboard: aggregate across shops with per-shop breakdown
- OAuth: one credential set per shop
- **Trigger:** split when hitting ~100 listings with clear niche performance data
- **Rationale:** niche authority and specialist buyer trust — a shop named "ZenPlannerCo" selling only wellness planners converts better than a generic shop selling everything. Each shop builds its own review base and Star Seller eligibility within its niche
- **Important:** Etsy ToS allows multiple shops for legitimate business reasons (different niches/brands). All shops must comply independently — never use multi-shop to evade enforcement

---

## Done

### Session 4 (2026-03-15)
- [x] Dashboard-only approval system
  - Removed Telegram from approval critical path
  - Pipeline creates pending approval and moves on (no polling/timeout)
  - Dashboard: PDF preview, copy preview, scores, comparison data, integrated feedback
  - Approve triggers listing agent, Revise triggers designer → copywriter → scorer loop
  - Reject marks product done
- [x] Telegram bot simplified to notifications-only
  - Removed inline approve/reject/revise buttons and callback handlers
  - Kept: /status, /pending, /metrics commands (with dashboard links)
  - Removed dead `sendApprovalRequest()` from notify.ts
- [x] Marketing channels disabled by default
  - Added `pinterestEnabled` flag to config schema + marketing pipeline
  - Set pinterest/email/blog all to `false` in config.json
  - Channels activate by flipping config flag + adding credentials
- [x] Dashboard port fixed to 3737 in config.json

### Session 3 (2026-03-15)
- [x] 1. Post-Purchase Sequence (`src/marketing/post-purchase.ts`)
  - 4-step buyer journey: thank you → check-in → review request → cross-sell
  - Niche-specific message templates, related product discovery
- [x] 2. Promotions & Sales Engine (`src/marketing/promotions.ts`)
  - 7 seasonal campaigns, coupon generation, flash sales
  - Abandoned favorites recovery, repeat buyer rewards
- [x] 3. Listing Optimization Loop (`src/marketing/listing-optimizer.ts`)
  - Performance tracking, AI title/tag rewrites, price adjustments, A/B testing
- [x] 4. Bundle Strategy (`src/marketing/bundles.ts`)
  - Auto-detect related products, bundle listings, cross-promos, shop sections
- [x] 5. Full Email Sequences (`src/marketing/email-sequences.ts`)
  - Welcome series (5 emails), weekly digest, abandonment recovery, niche segments
- [x] 6. Campaign Calendar (`src/marketing/campaign-calendar.ts`)
  - Unified calendar, 4 templates, full-year auto-scheduling, conflict detection
- [x] 7. Customer Appreciation (`src/marketing/customer-appreciation.ts`)
  - VIP tiers (regular → returning → VIP), milestone detection, free product rewards
- [x] 8. Social Proof Acceleration (`src/marketing/social-proof.ts`)
  - Review PDF inserts, incentive cards, micro-influencer outreach
- [x] 9. Referral / Share Incentive (`src/marketing/referrals.ts`)
  - Share cards in PDFs, trackable referral links, referrer reward coupons
- [x] E2E pipeline discrepancy fixes
  - Wired enhanced strategist + reference comparator into production pipeline
  - Fixed ScoreReport type alignment, approval gate filename, agent registrations
  - Wired all marketing modules into marketing pipeline
- [x] Production error handling hardening
  - `src/utils/resilience.ts`: retry, timeout, circuit breaker, atomic writes, DLQ
  - Agent runner: per-agent timeouts + DLQ capture
  - Etsy client: retry + circuit breaker + 30s timeout on all API calls
  - Marketing pipeline: each engine isolated (one failure doesn't block others)
  - Notifications: fallback to file alerts when Telegram is down
  - Cron scripts: Telegram alerts on failure, DLQ monitoring, always run health check

### Session 2 (2026-03-15)
- [x] Competitive intelligence system (`src/research/competitive-intel.ts`)
- [x] Listing agent (`src/agents/listing-agent.ts`)
- [x] Reference comparator (`src/agents/reference-comparator.ts`)
- [x] Enhanced strategist (`src/agents/strategist-enhanced.ts`)
- [x] Dashboard on port 3737
