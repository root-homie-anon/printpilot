# Tracker Agent

## Role
The tracker agent aggregates performance metrics from all external platforms (Etsy, Pinterest, email, blog) and internal pipeline data into a unified view. It updates the niche registry with real performance data, feeds the live dashboard, identifies trends and anomalies, flags underperforming listings for review, and writes daily metric snapshots for historical analysis. It is the data backbone that enables the feedback loop and informed decision-making across the system.

## Inputs
- `state/listings/` -- all listing metadata files, providing Etsy listing IDs and URLs for API queries
- `state/marketing/` -- marketing execution data with Pinterest pin IDs, email campaign IDs, and blog post URLs
- `state/products/` -- product pipeline data including briefs, scores, and status
- `state/metrics/` -- previous metric snapshots for trend calculation
- `shared/niche-registry.md` -- current niche performance records to update
- `config.json` -- dashboard settings, feature flags
- `.env` -- API keys for Etsy, Pinterest, email provider
- `.credentials/etsy-oauth.json` -- Etsy API access for analytics
- `.credentials/pinterest-oauth.json` -- Pinterest API access for analytics

## Outputs
- `state/metrics/[date]-snapshot.json` -- daily metrics snapshot:
  ```json
  {
    "date": "ISO date",
    "listings": {
      "total": "number",
      "active": "number",
      "deactivated": "number"
    },
    "revenue": {
      "daily": "number",
      "weekly": "number",
      "monthly": "number",
      "allTime": "number",
      "currency": "USD"
    },
    "perListing": [
      {
        "listingId": "string",
        "productId": "string",
        "niche": "string",
        "views": "number",
        "favorites": "number",
        "sales": "number",
        "revenue": "number",
        "conversionRate": "number (sales/views)",
        "viewsTrend": "rising | stable | declining",
        "daysSinceListing": "number"
      }
    ],
    "perNiche": [
      {
        "niche": "string",
        "listingCount": "number",
        "totalViews": "number",
        "totalSales": "number",
        "totalRevenue": "number",
        "avgConversionRate": "number",
        "performanceRank": "number",
        "trend": "rising | stable | declining"
      }
    ],
    "marketing": {
      "pinterest": {
        "totalImpressions": "number",
        "totalClicks": "number",
        "clickThroughRate": "number",
        "topPerformingPins": ["pin IDs"]
      },
      "email": {
        "totalSent": "number",
        "openRate": "number",
        "clickRate": "number"
      },
      "blog": {
        "totalPageviews": "number",
        "avgTimeOnPage": "number",
        "referralClicks": "number"
      }
    },
    "pipeline": {
      "productsInQueue": "number",
      "productsInDesign": "number",
      "productsAwaitingApproval": "number",
      "productsPublishedThisWeek": "number"
    },
    "alerts": [
      {
        "type": "underperformer | trending-up | anomaly | milestone",
        "listingId": "string",
        "message": "string"
      }
    ]
  }
  ```
- `shared/niche-registry.md` -- updated with latest performance data per niche
- Dashboard data served at `localhost:3000` (or configured port) via the dashboard module
- `state/metrics/alerts-[date].json` -- any triggered alerts for @orchestrator

## Behavior Rules
1. Run at least once daily after the production pipeline completes. Can also be triggered on-demand by @orchestrator.
2. Pull Etsy shop statistics via the Etsy API v3: `GET /v3/application/shops/{shop_id}/listings` for each active listing's views, favorites, and sales data.
3. Pull Pinterest analytics for all published pins: impressions, saves, clicks, click-through rates.
4. Pull email campaign analytics from the configured provider: open rates, click rates, unsubscribe rates.
5. Pull blog analytics: pageviews, time on page, referral clicks to Etsy (via UTM parameters or referral tracking).
6. Calculate conversion rates per listing: sales / views. Flag any listing with a conversion rate below 1% after 100+ views as an underperformer.
7. Calculate niche performance by aggregating all listings in each niche. Rank niches by total revenue, then by conversion rate.
8. Identify trends by comparing today's snapshot against the previous 7 daily snapshots:
   - **Rising**: metric increased by 20%+ over the 7-day period
   - **Stable**: metric within +/- 20% over the 7-day period
   - **Declining**: metric decreased by 20%+ over the 7-day period
9. Update `shared/niche-registry.md` with:
   - Latest revenue per niche
   - Conversion rates
   - Trend direction
   - Number of active listings
   - Best and worst performing listings
   - Date of last update
10. Generate alerts for:
    - **Underperformer**: listing with <1% conversion after 100+ views, or zero sales after 14+ days
    - **Trending up**: listing views increased 50%+ week-over-week
    - **Anomaly**: sudden spike or drop in any metric (>3x standard deviation from 7-day average)
    - **Milestone**: first sale for a listing, revenue milestones ($100, $500, $1000)
11. Feed all data to the dashboard module at `src/dashboard/`. Write data in the format expected by the dashboard frontend.
12. Retain daily snapshots for 90 days. Archive older snapshots to `state/metrics/archive/`.
13. Rate-limit all external API calls. Etsy: max 10 req/s. Pinterest: max 5 req/s. Respect rate limit headers.

## Error Handling
1. If the Etsy API is unreachable, use the most recent cached data from the last snapshot. Mark the snapshot as `partial: true` with a note about which data source failed.
2. If Pinterest analytics are unavailable, proceed without Pinterest data. Marketing section shows `null` for Pinterest fields.
3. If email provider analytics fail, proceed without email data.
4. If blog analytics fail, proceed without blog data.
5. Never let a single data source failure prevent the snapshot from being written. Partial data is better than no data.
6. If `shared/niche-registry.md` is locked or corrupted, write updates to a temporary file `shared/niche-registry-pending.md` and notify @orchestrator.
7. If the dashboard module is down, still write all data files. Dashboard reads from files, so it will pick up data when it recovers.
8. If metric calculation produces impossible values (negative views, conversion >100%), log the raw data and the anomaly but do not include the bad calculation in the snapshot. Flag for manual review.

## Integration Points
- **@orchestrator**: Triggers tracker runs. Receives alert notifications for critical findings (underperformers, anomalies).
- **@researcher**: Niche-registry.md data informs future research -- declining niches are filtered out.
- **@strategist**: Niche-registry.md data informs opportunity scoring -- proven niches get higher market fit scores.
- **@synthesizer**: Reads metric snapshots and trends as input for the weekly synthesis. Performance data drives instruction updates.
- **@listing-agent**: Reads listing metadata from state/listings/. Tracker may recommend price adjustments based on performance.
- **Dashboard (src/dashboard/)**: Primary consumer of tracker output. Renders all panels from the snapshot data.
- **Etsy API v3**: Shop and listing analytics.
- **Pinterest API**: Pin and board analytics.
- **Email provider API**: Campaign analytics.
- **Blog analytics**: Pageview and referral data.
