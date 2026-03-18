# PrintPilot — Shopify Integration Feature Spec

## Overview

Add a Shopify sales channel to PrintPilot that allows proven Etsy winners to be promoted to an owned storefront with a single action from the dashboard. Etsy acts as the testing ground; Shopify is the graduation layer for high-margin, owned-audience sales.

---

## Goals

- Give the operator a one-click "Promote to Shopify" action from the existing dashboard
- Publish the product listing, copy, tags, and PDF file to Shopify automatically via API
- Keep the Shopify store as a curated "greatest hits" collection — only human-approved graduates
- Expand the existing marketing pipeline to drive traffic to the Shopify store

---

## New Agent: `@shopify-agent`

**Location:** `.claude/agents/shopify-agent.md`

**Responsibilities:**
- Accept a product ID as input
- Read product state from `state/products/[product-id]/`
- Map PrintPilot product schema to Shopify product schema
- Upload the rendered PDF to Shopify via Files API
- Create the product listing via Shopify Admin API
- Attach the PDF as a digital download via Digital Downloads app
- Write the resulting Shopify product URL back to `state/products/[product-id]/shopify.json`
- Notify via Telegram on success or failure

**Inputs:**
```
product-id: string
```

**Outputs:**
```
state/products/[product-id]/shopify.json
  - shopifyProductId
  - shopifyProductUrl
  - fileId
  - publishedAt
  - status: "live" | "failed"
```

---

## Dashboard Change

Add a "Promote to Shopify" button to the per-product detail view in the dashboard.

**Visibility rules:**
- Only shown when `state/products/[product-id]/etsy.json` exists and status is `live`
- Disabled (greyed out) if `shopify.json` already exists for that product (prevents duplicate listings)
- Shows "Published to Shopify ↗" link when already promoted

**On click:**
1. Dashboard calls internal API endpoint `POST /api/promote-shopify` with `{ productId }`
2. Server spawns `@shopify-agent` with the product ID
3. Dashboard shows a loading state, then confirms success with a link to the Shopify listing

---

## Shopify API Integration

**API version:** Shopify Admin REST API (latest stable)

**Required scopes:**
- `write_products` — create product listings
- `write_files` — upload PDF files
- `read_products` — verify listing after publish

**Product schema mapping:**

| PrintPilot Field | Shopify Field |
|---|---|
| `copy.title` | `product.title` |
| `copy.description` | `product.body_html` |
| `copy.tags` (array) | `product.tags` (comma-separated) |
| `scoring.price` | `variant.price` |
| `assets.pdfPath` | Digital Downloads file attachment |
| `brief.niche` | `product.product_type` |

**Digital fulfillment:**
- Use Shopify's native Digital Downloads app (free)
- File upload via `POST /admin/api/[version]/files.json`
- Attach to product after creation via Digital Downloads API
- Set fulfillment to automatic, download limit to unlimited

---

## New Environment Variables

Add to `.env` and `.env.example`:

```
# Shopify
SHOPIFY_STORE_URL=https://your-store.myshopify.com
SHOPIFY_ADMIN_API_KEY=TBD
SHOPIFY_ADMIN_API_SECRET=TBD
SHOPIFY_ACCESS_TOKEN=TBD
```

---

## Config Changes

Add to `config.json`:

```json
"shopify": {
  "enabled": true,
  "defaultStatus": "active",
  "defaultDownloadLimit": "unlimited",
  "fulfillmentMode": "automatic"
}
```

---

## Marketing Pipeline Update

Once a product is live on Shopify, the marketing pipeline should drive traffic to the Shopify URL (higher margin) in addition to or instead of the Etsy URL.

**Changes to `@marketing-agent`:**
- Check for `shopify.json` on the product before generating marketing content
- If Shopify listing exists, use Shopify URL as the primary link in Pinterest pins, emails, and blog posts
- If no Shopify listing, fall back to Etsy URL as before

---

## Project Structure Changes

```
src/
└── shopify/                    ← NEW
    ├── client.ts               ← Shopify Admin API client
    ├── publish.ts              ← product creation + file upload logic
    └── mapper.ts               ← PrintPilot → Shopify schema mapper

.claude/agents/
└── shopify-agent.md            ← NEW agent definition
```

---

## CLAUDE.md Updates

- Add `@shopify-agent` to the Agent Team table
- Add `SHOPIFY_*` vars to `.env.example` section
- Add Shopify to the Monthly Cost Estimate table (~$39/mo Basic plan)
- Note the dashboard "Promote to Shopify" action in the Orchestrator Behavior section

---

## Updated Monthly Cost Estimate

| Service | Cost |
|---|---|
| Anthropic API (Claude) | ~$20–25/mo |
| Firecrawl | ~$15/mo |
| Etsy listing fees | ~$12/mo |
| Shopify Basic plan | ~$39/mo |
| **Total** | **~$86–91/mo** |

---

## Out of Scope

- Shopify storefront design / theme customization
- Shopify SEO beyond what the existing copywriter already produces
- Inventory or physical product handling
- Automatic promotion based on metrics thresholds (manual decision only, for now)

---

## Implementation Order

1. `src/shopify/client.ts` — API client with auth
2. `src/shopify/mapper.ts` — schema mapping
3. `src/shopify/publish.ts` — file upload + product creation
4. `.claude/agents/shopify-agent.md` — agent definition
5. `POST /api/promote-shopify` endpoint in dashboard server
6. Dashboard UI — "Promote to Shopify" button + state handling
7. `@marketing-agent` update — prefer Shopify URL when available
8. `.env.example` + `config.json` + `CLAUDE.md` updates
