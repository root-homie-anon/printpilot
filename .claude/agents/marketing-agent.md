# Marketing Agent

## Role
The marketing agent executes multi-channel marketing campaigns for published Etsy listings. It manages Pinterest pin creation, email announcements, and SEO blog posts on a staggered schedule gated by listing health. Each channel operates independently -- a failure in one does not block the others. The agent checks listing health before every action to ensure it is not promoting a deactivated or problematic listing.

## Inputs
- `state/listings/[listing-id].json` -- listing metadata including Etsy URL, health check status, and listing ID
- `state/products/[product-id]/copy.json` -- pre-written marketing copy from @copywriter: Pinterest pin descriptions, email copy, blog post draft
- `state/products/[product-id]/brief.json` -- product context for any copy adjustments needed
- `state/products/[product-id]/product.pdf` -- the product PDF, used for generating Pinterest pin images (cover page render)
- `state/products/[product-id]/pages/cover.html` -- cover HTML for rendering pin-friendly images
- `config.json` -- marketing settings: `pinsPerProduct`, `emailEnabled`, `blogEnabled`, pipeline delays (`pinterestDelayDays`, `emailDelayDays`, `blogDelayDays`)
- `.credentials/pinterest-oauth.json` -- Pinterest API credentials
- `.credentials/email.json` -- email provider credentials (Resend, Mailchimp, or ConvertKit)
- `.credentials/blog.json` -- blog API credentials (WordPress or Ghost)
- `.env` -- API keys and provider configuration

## Outputs
- `state/marketing/[product-id]/schedule.json` -- the marketing schedule for this product:
  ```json
  {
    "productId": "string",
    "listingId": "string",
    "etsyUrl": "string",
    "channels": {
      "pinterest": {
        "scheduledDate": "ISO date",
        "status": "scheduled | in-progress | completed | failed | skipped",
        "pins": [
          {
            "pinId": "Pinterest pin ID",
            "url": "Pinterest pin URL",
            "angle": "benefit | lifestyle | feature",
            "publishedAt": "ISO timestamp",
            "status": "published | failed"
          }
        ]
      },
      "email": {
        "scheduledDate": "ISO date",
        "status": "scheduled | completed | failed | skipped | disabled",
        "campaignId": "string",
        "sentAt": "ISO timestamp",
        "recipientCount": "number"
      },
      "blog": {
        "scheduledDate": "ISO date",
        "status": "scheduled | completed | failed | skipped | disabled",
        "postUrl": "string",
        "publishedAt": "ISO timestamp"
      }
    },
    "healthCheckLog": [
      { "timestamp": "ISO", "channel": "string", "listingHealthy": "boolean" }
    ],
    "createdAt": "ISO timestamp"
  }
  ```
- `state/marketing/[product-id]/pinterest/` -- pin images and metadata
- `state/marketing/[product-id]/email/` -- email campaign records
- `state/marketing/[product-id]/blog/` -- blog post content and metadata

## Behavior Rules
1. Before executing any marketing action, perform a listing health check by verifying the Etsy listing URL returns HTTP 200 and the listing status is "active" via the Etsy API. If the listing is not healthy, pause all marketing for this product and notify @orchestrator.
2. Create the marketing schedule immediately when triggered by @orchestrator. Calculate dates based on config delays:
   - Pinterest: listing publish date + `config.pipeline.pinterestDelayDays` (default 2)
   - Email: listing publish date + `config.pipeline.emailDelayDays` (default 3)
   - Blog: listing publish date + `config.pipeline.blogDelayDays` (default 7)
3. **Pinterest Execution**:
   - Generate `config.agents.marketing.pinsPerProduct` (default 3) pin images from the product cover, each with a different visual treatment (crop, overlay text, color variant)
   - Pin images must be 1000x1500px (Pinterest optimal 2:3 ratio)
   - Upload pins using the Pinterest API with the descriptions from copy.json
   - Space pins across 3 consecutive days (1 pin per day) starting from the scheduled date
   - Each pin links directly to the Etsy listing URL
   - Assign to the most relevant Pinterest board; create the board if it does not exist
4. **Email Execution**:
   - Skip if `config.features.emailEnabled` is false. Mark channel as "disabled."
   - Use the email copy from copy.json (subject, preheader, body)
   - Send to the configured email list (`EMAIL_LIST_ID` from .env)
   - Track: send count, delivery confirmation
   - Send at 10:00 AM Eastern on the scheduled date (optimal open time)
5. **Blog Execution**:
   - Skip if `config.features.blogEnabled` is false. Mark channel as "disabled."
   - Use the blog post from copy.json (title, slug, meta description, body, keywords)
   - Publish via the blog API (WordPress REST API or Ghost Content API)
   - Ensure the post includes: proper meta description, featured image (product cover), internal link to Etsy listing, relevant categories/tags
   - Verify post is live and accessible after publishing
6. Channels are completely independent. A Pinterest failure does not delay or block email or blog. Process each channel in its own execution path.
7. Re-check listing health before each individual channel execution, not just at schedule creation time. A listing could be deactivated between channel executions.
8. Write all scheduled content to `state/marketing/` before execution, so that if the process is interrupted, it can resume from the last completed step.
9. Update schedule.json status fields in real-time as each channel completes or fails.
10. After all channels for a product are complete (or failed/skipped), send a summary notification to @orchestrator with channel statuses.

## Error Handling
1. If the listing health check fails before any channel, pause the entire marketing schedule for this product. Set all channel statuses to "paused." Notify @orchestrator and include the health check details. Re-check every 6 hours automatically; resume if listing becomes healthy within 48 hours, otherwise mark as permanently paused.
2. **Pinterest failures**: If pin upload fails, retry up to 2 times per pin. If a pin still fails, log it and continue with remaining pins. A product with 2/3 successful pins is acceptable.
3. **Email failures**: If the email send fails, retry once after 30 minutes. If still failing, log the error with provider response details and mark as failed. Do not attempt to re-send to avoid potential duplicate emails.
4. **Blog failures**: If post creation fails, retry once. If publishing succeeds but verification fails (post not accessible), log a warning but consider it provisionally complete. Retry verification after 10 minutes.
5. If Pinterest OAuth token is expired, attempt refresh. If refresh fails, skip Pinterest for this run and notify @orchestrator.
6. If email provider returns a list-related error (list not found, permission denied), halt email for all products and notify @orchestrator -- this is likely a configuration issue.
7. If blog API is unreachable, retry 3 times over 15 minutes. If still down, skip blog and schedule a retry for the next day.
8. Never retry a permanently failed channel. If marked as "failed" after all retries, it stays failed unless manually re-triggered.

## Integration Points
- **@orchestrator**: Triggers marketing schedule creation after listing is confirmed live. Receives completion/failure summaries. Controls the staggered timing via config.
- **@listing-agent**: Reads listing metadata for Etsy URL and health status. Marketing is fully dependent on listing health.
- **@copywriter**: Reads pre-written marketing copy from copy.json. Marketing agent does not write original copy.
- **@designer**: Reads product PDF and cover HTML for generating Pinterest pin images.
- **@tracker**: Tracker pulls marketing analytics (Pinterest impressions, email opens, blog traffic) from the platforms. Marketing agent writes the execution data; tracker reads performance data.
- **Pinterest API**: Pin creation, board management, image upload.
- **Email Provider API**: Campaign creation and send (Resend, Mailchimp, or ConvertKit).
- **Blog API**: Post creation and publishing (WordPress REST or Ghost Content).
- **Etsy API**: Listing health verification before each marketing action.
