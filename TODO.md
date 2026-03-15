# PrintPilot — Next Session TODO

## Priority 1: Marketing Engine (Build These)

### 1. Post-Purchase Sequence (`src/marketing/post-purchase.ts`)
- Etsy Message to Buyers integration
- Thank you + usage tips (immediate after purchase)
- "How's it going?" check-in (Day 3)
- Review request with specific prompt (Day 7)
- Cross-sell related products (Day 14)
- Reviews are the #1 lever for Etsy search rank — this is highest priority

### 2. Promotions & Sales Engine (`src/marketing/promotions.ts`)
- Etsy coupon code generation via API
- Abandoned favorites recovery (coupon to users who favorited but didn't buy)
- Seasonal sale campaigns tied to calendar:
  - New Year / goal setting (Jan)
  - Valentine's Day (Feb)
  - Back to School (Aug-Sep)
  - Black Friday / Cyber Monday (Nov)
  - Mother's Day, Father's Day
  - Tax season (budget worksheets)
- "Thank you" coupons for repeat buyers
- Flash sale support

### 3. Listing Optimization Loop (`src/marketing/listing-optimizer.ts`)
- Track views → favorites → sales conversion per listing
- If conversion low after 14 days, AI rewrites title/tags
- Price adjustment: high views + low sales = test lower price
- Low views = re-run competitive intel on tags/title
- A/B testing framework for titles

## Priority 2: Bundle & Cross-Sell

### 4. Bundle Strategy
- Auto-detect related products in same niche
- Create bundle listings (e.g., "Complete Wellness Planner Bundle")
- In-listing cross-promotion in descriptions
- Etsy shop sections organized by niche

## Priority 3: Email Funnel Expansion

### 5. Full Email Sequences (not just announcements)
- Welcome sequence for new subscribers (3-5 emails)
- Weekly "new products" digest
- Niche-specific segmented lists
- Favorite/cart abandonment reminders via email

## Priority 4: Seasonal Campaign Calendar

### 6. Campaign Calendar System
- Pre-built campaign templates for key dates
- Auto-launch sales 1 week before each event
- Niche-aware timing (fitness in Jan, budget in tax season)

## Priority 5: Customer Appreciation & Retention

### 7. Customer Appreciation Program
- Repeat buyer tracking
- Surprise free product for 3rd purchase
- VIP early access to new products for top buyers
- Thank-you note PDF included in downloads

### 8. Social Proof Acceleration
- Review-request PDF page appended to every product
- "Leave a review, get 20% off next order" insert
- Micro-influencer outreach for early reviews

### 9. Referral / Share Incentive
- "Share on Pinterest, get 15% off" card in download
- Trackable referral links per customer

---

## Already Done This Session

- [x] Dashboard running on port 3737 (moved from 3000)
- [x] Competitive intelligence system (`src/research/competitive-intel.ts`)
  - Scrapes top sellers, extracts best practices (photos, descriptions, tags, pricing)
  - Pricing strategy that undercuts weakest top sellers
- [x] Listing agent (`src/agents/listing-agent.ts`)
  - Full publish flow: approval check → draft → upload PDF → cover images → publish → health check
  - Taxonomy mapping, cover image generation, price resolution, retry logic
- [x] Reference comparator (`src/agents/reference-comparator.ts`)
  - Verifies output matches winning patterns before listing
  - Design/copy/pricing alignment scoring, go/no-go gate
- [x] Enhanced strategist (`src/agents/strategist-enhanced.ts`)
  - Intel-driven briefs with real sections, competitive pricing, photo/copy guidance
  - AI-generated specific sections instead of generic "Page 2"
