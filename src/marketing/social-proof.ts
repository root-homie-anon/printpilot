import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { renderPdf } from '../renderer/render.js';
import { generateCouponCode } from './promotions.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/social-proof');
const INFLUENCER_DIR = join(STATE_DIR, 'influencers');
const PRODUCTS_DIR = resolve(process.cwd(), 'state/products');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');
const INSERTS_DIR = join(STATE_DIR, 'inserts');

const BASE_URL = 'https://api.etsy.com/v3';

// ── Types ────────────────────────────────────────────────────────────

export type ReviewInsertType = 'review-page' | 'incentive-card';

export type InfluencerStatus =
  | 'identified'
  | 'contacted'
  | 'accepted'
  | 'completed';

export interface ReviewInsert {
  productId: string;
  type: ReviewInsertType;
  htmlContent: string;
  pdfPath: string;
}

export interface InfluencerOutreach {
  id: string;
  influencerName: string;
  platform: string;
  handle: string;
  niche: string;
  status: InfluencerStatus;
  productSent: boolean;
  reviewReceived: boolean;
  productId?: string;
  contactedAt?: string;
  acceptedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialProofConfig {
  incentiveDiscountPercent: number;
  influencerFreeProducts: number;
  reviewPageEnabled: boolean;
}

export interface ReviewStats {
  productId: string;
  totalReviews: number;
  averageRating: number;
  reviewVelocity: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export class SocialProofError extends Error {
  public readonly productId?: string;

  constructor(message: string, productId?: string) {
    super(
      productId
        ? `Social proof error (${productId}): ${message}`
        : `Social proof error: ${message}`
    );
    this.name = 'SocialProofError';
    this.productId = productId;
  }
}

export class InfluencerOutreachError extends Error {
  public readonly outreachId: string;

  constructor(outreachId: string, message: string) {
    super(`Influencer outreach error (${outreachId}): ${message}`);
    this.name = 'InfluencerOutreachError';
    this.outreachId = outreachId;
  }
}

// ── Internal Types ───────────────────────────────────────────────────

interface ListingMetadata {
  listingId: number;
  etsyUrl: string;
  title: string;
  price: number;
  productId: string;
  niche: string;
  status: string;
}

interface ProductState {
  productId: string;
  title: string;
  niche: string;
  pdfPath?: string;
  listingId?: number;
}

interface EtsyReviewsResponse {
  count: number;
  results: Array<{
    rating: number;
    created_timestamp: number;
    review: string;
  }>;
}

interface InfluencerCandidate {
  name: string;
  platform: string;
  handle: string;
  niche: string;
  followerCount?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SocialProofConfig = {
  incentiveDiscountPercent: 20,
  influencerFreeProducts: 2,
  reviewPageEnabled: true,
};

async function ensureDirectories(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await mkdir(INFLUENCER_DIR, { recursive: true });
  await mkdir(INSERTS_DIR, { recursive: true });
}

async function initEtsyAuth(): Promise<{
  client: EtsyClient;
  apiKey: string;
  shopId: string;
  accessToken: string;
}> {
  const apiKey = getEnvOrThrow('ETSY_API_KEY');
  const apiSecret = getEnvOrThrow('ETSY_API_SECRET');
  const shopId = getEnvOrThrow('ETSY_SHOP_ID');

  const client = new EtsyClient(apiKey, apiSecret, shopId);
  const oauth = new EtsyOAuth(
    apiKey,
    apiSecret,
    'http://localhost:3000/oauth/callback'
  );
  const accessToken = await oauth.getValidAccessToken();
  client.setAccessToken(accessToken);

  return { client, apiKey, shopId, accessToken };
}

async function loadProductState(productId: string): Promise<ProductState> {
  const productDir = join(PRODUCTS_DIR, productId);
  const statePath = join(productDir, 'state.json');

  let raw: string;
  try {
    raw = await readFile(statePath, 'utf-8');
  } catch {
    throw new SocialProofError(
      `Product state not found: ${statePath}`,
      productId
    );
  }

  return JSON.parse(raw) as ProductState;
}

async function loadListingByProductId(
  productId: string
): Promise<ListingMetadata | null> {
  let files: string[];
  try {
    files = await readdir(LISTINGS_DIR);
  } catch {
    return null;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    try {
      const raw = await readFile(join(LISTINGS_DIR, file), 'utf-8');
      const listing = JSON.parse(raw) as ListingMetadata;
      if (listing.productId === productId) {
        return listing;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ── SocialProofEngine ────────────────────────────────────────────────

export class SocialProofEngine {
  private readonly config: SocialProofConfig;
  private readonly shopId: string;

  constructor(config?: Partial<SocialProofConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shopId = getEnvOrThrow('ETSY_SHOP_ID');
  }

  // ── Review Insert Generation ─────────────────────────────────────

  async generateReviewRequestPage(
    productId: string,
    productTitle: string
  ): Promise<ReviewInsert> {
    logger.info(
      `Generating review request page for product ${productId}`
    );

    const listing = await loadListingByProductId(productId);
    const reviewUrl = listing
      ? `${listing.etsyUrl}#reviews`
      : `https://www.etsy.com/your/purchases`;

    const htmlContent = this.buildReviewPageHtml(
      productTitle,
      reviewUrl
    );

    const htmlPath = join(INSERTS_DIR, `${productId}-review-page.html`);
    const pdfPath = join(INSERTS_DIR, `${productId}-review-page.pdf`);

    await ensureDirectories();
    await writeFile(htmlPath, htmlContent, 'utf-8');

    await renderPdf(htmlPath, pdfPath, {
      pageSize: 'A4',
      margins: { top: 20, right: 20, bottom: 20, left: 20 },
    });

    const insert: ReviewInsert = {
      productId,
      type: 'review-page',
      htmlContent,
      pdfPath,
    };

    await this.saveInsertMetadata(insert);

    logger.info(
      `Review request page generated for product ${productId}: ${pdfPath}`
    );

    return insert;
  }

  async generateIncentiveCard(
    productId: string,
    couponCode: string
  ): Promise<ReviewInsert> {
    logger.info(
      `Generating incentive card for product ${productId}`
    );

    const discountPercent = this.config.incentiveDiscountPercent;
    const htmlContent = this.buildIncentiveCardHtml(
      couponCode,
      discountPercent
    );

    const htmlPath = join(
      INSERTS_DIR,
      `${productId}-incentive-card.html`
    );
    const pdfPath = join(
      INSERTS_DIR,
      `${productId}-incentive-card.pdf`
    );

    await ensureDirectories();
    await writeFile(htmlPath, htmlContent, 'utf-8');

    await renderPdf(htmlPath, pdfPath, {
      pageSize: 'A4',
      margins: { top: 20, right: 20, bottom: 20, left: 20 },
    });

    const insert: ReviewInsert = {
      productId,
      type: 'incentive-card',
      htmlContent,
      pdfPath,
    };

    await this.saveInsertMetadata(insert);

    logger.info(
      `Incentive card generated for product ${productId}: ${pdfPath}`
    );

    return insert;
  }

  async appendToProduct(
    productPdfPath: string,
    insertHtml: string
  ): Promise<string> {
    logger.info(
      `Appending insert to product PDF: ${productPdfPath}`
    );

    const insertId = randomUUID().slice(0, 8);
    const insertHtmlPath = join(
      INSERTS_DIR,
      `temp-insert-${insertId}.html`
    );
    const insertPdfPath = join(
      INSERTS_DIR,
      `temp-insert-${insertId}.pdf`
    );

    await ensureDirectories();
    await writeFile(insertHtmlPath, insertHtml, 'utf-8');

    await renderPdf(insertHtmlPath, insertPdfPath, {
      pageSize: 'A4',
      margins: { top: 20, right: 20, bottom: 20, left: 20 },
    });

    // Read both PDFs and concatenate using a combined HTML approach
    // Since we render HTML to PDF, we create a combined document
    const originalHtmlPath = productPdfPath.replace('.pdf', '.html');
    let originalHtml: string;
    try {
      originalHtml = await readFile(originalHtmlPath, 'utf-8');
    } catch {
      throw new SocialProofError(
        `Original HTML source not found at ${originalHtmlPath}. ` +
          'Cannot append insert without source HTML.'
      );
    }

    // Append the insert HTML before the closing body tag
    const combinedHtml = originalHtml.replace(
      '</body>',
      `<div style="page-break-before: always;"></div>\n${insertHtml}\n</body>`
    );

    const combinedHtmlPath = originalHtmlPath;
    await writeFile(combinedHtmlPath, combinedHtml, 'utf-8');

    // Re-render the combined PDF
    await renderPdf(combinedHtmlPath, productPdfPath, {
      pageSize: 'A4',
      margins: { top: 10, right: 10, bottom: 10, left: 10 },
    });

    logger.info(
      `Insert appended to product PDF: ${productPdfPath}`
    );

    return productPdfPath;
  }

  async processNewProducts(productIds: string[]): Promise<void> {
    logger.info(
      `Processing ${productIds.length} products for social proof inserts`
    );

    for (const productId of productIds) {
      try {
        const product = await loadProductState(productId);

        if (!this.config.reviewPageEnabled) {
          logger.debug(
            `Review page disabled, skipping for product ${productId}`
          );
          continue;
        }

        // Generate review request page
        const reviewInsert = await this.generateReviewRequestPage(
          productId,
          product.title
        );

        // Generate incentive card with a unique coupon
        const couponCode = generateCouponCode('REVIEW');
        const incentiveInsert = await this.generateIncentiveCard(
          productId,
          couponCode
        );

        // Append inserts to product PDF if path exists
        if (product.pdfPath) {
          const combinedInsertHtml = [
            reviewInsert.htmlContent,
            '<div style="page-break-before: always;"></div>',
            incentiveInsert.htmlContent,
          ].join('\n');

          await this.appendToProduct(product.pdfPath, combinedInsertHtml);

          logger.info(
            `Social proof inserts appended to product ${productId}`
          );
        } else {
          logger.warn(
            `No PDF path found for product ${productId}, ` +
              'inserts generated but not appended'
          );
        }

        await logActivity({
          timestamp: new Date().toISOString(),
          agent: 'social-proof-engine',
          action: 'inserts-generated',
          productId,
          details:
            `Generated review page and incentive card ` +
            `(coupon: ${couponCode}) for "${product.title}"`,
          duration: 0,
          success: true,
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to process social proof for product ${productId}: ${message}`
        );

        await logActivity({
          timestamp: new Date().toISOString(),
          agent: 'social-proof-engine',
          action: 'inserts-failed',
          productId,
          details: `Social proof insert generation failed: ${message}`,
          duration: 0,
          success: false,
        });
      }
    }

    logger.info(
      `Social proof processing complete for ${productIds.length} products`
    );
  }

  // ── Influencer Outreach ──────────────────────────────────────────

  async identifyInfluencers(
    niche: string
  ): Promise<InfluencerOutreach[]> {
    logger.info(`Identifying micro-influencers for niche: "${niche}"`);

    const { client } = await initEtsyAuth();

    // Search Etsy for sellers in the niche with moderate review counts
    const etsyResults = await client.searchListings(niche, {
      limit: 25,
      sortBy: 'score',
    });

    const candidates: InfluencerCandidate[] = [];

    // Identify sellers with moderate following (not too big, not too small)
    const seenSellers = new Set<string>();

    for (const listing of etsyResults) {
      // Use favorites as a proxy for influence
      if (
        listing.favorites >= 10 &&
        listing.favorites <= 5000
      ) {
        const sellerHandle = this.extractSellerHandle(listing.url);
        if (sellerHandle && !seenSellers.has(sellerHandle)) {
          seenSellers.add(sellerHandle);
          candidates.push({
            name: sellerHandle,
            platform: 'etsy',
            handle: sellerHandle,
            niche,
            followerCount: listing.favorites,
          });
        }
      }
    }

    // Limit to configured number of free products
    const selectedCandidates = candidates.slice(
      0,
      this.config.influencerFreeProducts
    );

    const outreachRecords: InfluencerOutreach[] = [];
    const now = new Date().toISOString();

    for (const candidate of selectedCandidates) {
      const outreach: InfluencerOutreach = {
        id: randomUUID(),
        influencerName: candidate.name,
        platform: candidate.platform,
        handle: candidate.handle,
        niche: candidate.niche,
        status: 'identified',
        productSent: false,
        reviewReceived: false,
        createdAt: now,
        updatedAt: now,
      };

      await this.saveOutreachRecord(outreach);
      outreachRecords.push(outreach);
    }

    logger.info(
      `Identified ${outreachRecords.length} micro-influencers ` +
        `for niche "${niche}"`
    );

    return outreachRecords;
  }

  async contactInfluencer(
    influencer: InfluencerOutreach,
    productId: string
  ): Promise<InfluencerOutreach> {
    logger.info(
      `Contacting influencer ${influencer.influencerName} ` +
        `for product ${productId}`
    );

    if (influencer.status !== 'identified') {
      throw new InfluencerOutreachError(
        influencer.id,
        `Cannot contact influencer with status "${influencer.status}"`
      );
    }

    const product = await loadProductState(productId);

    const apiKey = getEnvOrThrow('ETSY_API_KEY');
    const apiSecret = getEnvOrThrow('ETSY_API_SECRET');

    const oauth = new EtsyOAuth(
      apiKey,
      apiSecret,
      'http://localhost:3000/oauth/callback'
    );
    const accessToken = await oauth.getValidAccessToken();

    const messageBody = this.buildOutreachMessage(
      influencer.influencerName,
      product.title,
      product.niche
    );

    const url =
      `${BASE_URL}/application/shops/${this.shopId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to_user_id: influencer.handle,
        subject: `Collaboration opportunity — ${product.title}`,
        body: messageBody,
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new InfluencerOutreachError(
        influencer.id,
        `Failed to send outreach message (${response.status}): ${responseBody}`
      );
    }

    const now = new Date().toISOString();
    influencer.status = 'contacted';
    influencer.productId = productId;
    influencer.contactedAt = now;
    influencer.updatedAt = now;

    await this.saveOutreachRecord(influencer);

    await logActivity({
      timestamp: now,
      agent: 'social-proof-engine',
      action: 'influencer-contacted',
      productId,
      details:
        `Contacted ${influencer.influencerName} ` +
        `(@${influencer.handle} on ${influencer.platform}) ` +
        `for product "${product.title}"`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Outreach message sent to ${influencer.influencerName} ` +
        `for product ${productId}`
    );

    return influencer;
  }

  async trackInfluencerReview(
    outreachId: string
  ): Promise<InfluencerOutreach> {
    logger.info(`Tracking influencer review for outreach ${outreachId}`);

    const outreach = await this.loadOutreachRecord(outreachId);

    if (!outreach.productId) {
      throw new InfluencerOutreachError(
        outreachId,
        'No product associated with this outreach'
      );
    }

    const listing = await loadListingByProductId(outreach.productId);

    if (!listing) {
      logger.warn(
        `No listing found for product ${outreach.productId}, ` +
          'cannot track reviews'
      );
      return outreach;
    }

    // Check for new reviews on the listing
    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const url =
      `${BASE_URL}/application/listings/${listing.listingId}/reviews`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.warn(
        `Failed to fetch reviews for listing ${listing.listingId}`
      );
      return outreach;
    }

    const data = (await response.json()) as EtsyReviewsResponse;

    // Check for reviews after the contact date
    if (outreach.contactedAt && data.results.length > 0) {
      const contactedDate = new Date(outreach.contactedAt).getTime();
      const recentReviews = data.results.filter(
        (r) => r.created_timestamp * 1000 > contactedDate
      );

      if (recentReviews.length > 0 && !outreach.reviewReceived) {
        const now = new Date().toISOString();
        outreach.reviewReceived = true;
        outreach.status = 'completed';
        outreach.completedAt = now;
        outreach.updatedAt = now;

        await this.saveOutreachRecord(outreach);

        await logActivity({
          timestamp: now,
          agent: 'social-proof-engine',
          action: 'influencer-review-received',
          productId: outreach.productId,
          details:
            `Review received from ${outreach.influencerName} ` +
            `(@${outreach.handle}) for product ${outreach.productId}`,
          duration: 0,
          success: true,
        });

        logger.info(
          `Review received from influencer ${outreach.influencerName} ` +
            `for product ${outreach.productId}`
        );
      }
    }

    return outreach;
  }

  // ── Review Stats ─────────────────────────────────────────────────

  async getReviewStats(productId: string): Promise<ReviewStats> {
    logger.info(`Fetching review stats for product ${productId}`);

    const listing = await loadListingByProductId(productId);

    if (!listing) {
      return {
        productId,
        totalReviews: 0,
        averageRating: 0,
        reviewVelocity: 0,
      };
    }

    const { apiKey, accessToken } = await initEtsyAuth();

    const url =
      `${BASE_URL}/application/listings/${listing.listingId}/reviews`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.warn(
        `Failed to fetch reviews for listing ${listing.listingId}`
      );
      return {
        productId,
        totalReviews: 0,
        averageRating: 0,
        reviewVelocity: 0,
      };
    }

    const data = (await response.json()) as EtsyReviewsResponse;

    const totalReviews = data.count;
    const averageRating =
      totalReviews > 0
        ? data.results.reduce((sum, r) => sum + r.rating, 0) / totalReviews
        : 0;

    const reviewVelocity = this.calculateReviewVelocity(data.results);

    const stats: ReviewStats = {
      productId,
      totalReviews,
      averageRating: Math.round(averageRating * 100) / 100,
      reviewVelocity,
    };

    // Save stats to state
    await ensureDirectories();
    const statsPath = join(STATE_DIR, `${productId}-stats.json`);
    await writeFile(statsPath, JSON.stringify(stats, null, 2), 'utf-8');

    logger.info(
      `Review stats for ${productId}: ${totalReviews} reviews, ` +
        `${stats.averageRating} avg rating, ` +
        `${reviewVelocity} reviews/week`
    );

    return stats;
  }

  async getReviewVelocity(productId: string): Promise<number> {
    logger.debug(
      `Calculating review velocity for product ${productId}`
    );

    const stats = await this.getReviewStats(productId);
    return stats.reviewVelocity;
  }

  // ── Daily Cycle ──────────────────────────────────────────────────

  async runSocialProofCycle(): Promise<void> {
    logger.info('Starting daily social proof cycle');

    // 1. Find new products that need inserts
    const newProductIds = await this.findUnprocessedProducts();
    if (newProductIds.length > 0) {
      logger.info(
        `Found ${newProductIds.length} new products to process`
      );
      await this.processNewProducts(newProductIds);
    } else {
      logger.info('No new products to process');
    }

    // 2. Check influencer responses
    const activeOutreach = await this.getActiveOutreach();
    for (const outreach of activeOutreach) {
      try {
        await this.trackInfluencerReview(outreach.id);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to track influencer review for ` +
            `${outreach.influencerName}: ${message}`
        );
      }
    }

    // 3. Track review stats for all listed products
    const listedProductIds = await this.getListedProductIds();
    for (const productId of listedProductIds) {
      try {
        await this.getReviewStats(productId);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to fetch review stats for ${productId}: ${message}`
        );
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'social-proof-engine',
      action: 'daily-cycle-complete',
      details:
        `Processed ${newProductIds.length} new products, ` +
        `tracked ${activeOutreach.length} influencer outreach records, ` +
        `updated stats for ${listedProductIds.length} listings`,
      duration: 0,
      success: true,
    });

    logger.info('Daily social proof cycle complete');
  }

  async getInfluencerOutreachHistory(): Promise<InfluencerOutreach[]> {
    logger.debug('Loading influencer outreach history');

    let files: string[];
    try {
      files = await readdir(INFLUENCER_DIR);
    } catch {
      logger.debug('No influencer outreach directory found');
      return [];
    }

    const outreachRecords: InfluencerOutreach[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(INFLUENCER_DIR, file), 'utf-8');
        outreachRecords.push(JSON.parse(raw) as InfluencerOutreach);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to load outreach record from ${file}: ${message}`
        );
      }
    }

    // Sort by creation date, newest first
    outreachRecords.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return outreachRecords;
  }

  // ── HTML Builders ────────────────────────────────────────────────

  private buildReviewPageHtml(
    productTitle: string,
    reviewUrl: string
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      color: #333;
      background: #fff;
      padding: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      max-width: 500px;
      text-align: center;
    }
    h1 {
      font-size: 24px;
      color: #d35400;
      margin-bottom: 8px;
    }
    .subtitle {
      font-size: 14px;
      color: #666;
      margin-bottom: 32px;
      font-style: italic;
    }
    .steps {
      text-align: left;
      margin: 24px 0;
    }
    .step {
      display: flex;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    .step-number {
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #d35400;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 16px;
      margin-right: 14px;
      margin-top: 2px;
    }
    .step-text {
      font-size: 14px;
      line-height: 1.5;
      color: #444;
    }
    .step-text strong {
      color: #333;
    }
    .qr-placeholder {
      width: 120px;
      height: 120px;
      border: 2px dashed #ccc;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 24px auto;
      font-size: 11px;
      color: #999;
      text-align: center;
      padding: 8px;
    }
    .review-url {
      font-size: 11px;
      color: #888;
      word-break: break-all;
      margin-top: 8px;
    }
    .heart-message {
      margin-top: 32px;
      padding: 20px;
      background: #fef9f4;
      border-radius: 8px;
      border: 1px solid #f0e0d0;
    }
    .heart-message p {
      font-size: 13px;
      color: #555;
      line-height: 1.6;
    }
    .heart-icon {
      font-size: 24px;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>We'd Love Your Feedback!</h1>
    <p class="subtitle">${this.escapeHtml(productTitle)}</p>

    <div class="steps">
      <div class="step">
        <div class="step-number">1</div>
        <div class="step-text">
          <strong>Go to your Etsy Purchases</strong><br>
          Open Etsy and navigate to your account. Click on
          "Purchases and reviews" in your account menu.
        </div>
      </div>

      <div class="step">
        <div class="step-number">2</div>
        <div class="step-text">
          <strong>Find this order</strong><br>
          Locate "${this.escapeHtml(productTitle)}" in your purchase
          history. Click "Leave a review" next to the item.
        </div>
      </div>

      <div class="step">
        <div class="step-number">3</div>
        <div class="step-text">
          <strong>Share your experience</strong><br>
          Choose your star rating and write a brief review. Mentioning
          how you use the product helps other shoppers decide!
        </div>
      </div>

      <div class="step">
        <div class="step-number">4</div>
        <div class="step-text">
          <strong>Submit your review</strong><br>
          Click "Post your review" and you're done! Your feedback
          makes a real difference.
        </div>
      </div>
    </div>

    <div class="qr-placeholder">
      QR Code<br>${this.escapeHtml(reviewUrl)}
    </div>
    <p class="review-url">${this.escapeHtml(reviewUrl)}</p>

    <div class="heart-message">
      <div class="heart-icon">&#10084;</div>
      <p>
        Your feedback helps small creators like us continue making
        products you love. Every review — whether it's a quick star
        rating or a detailed note — genuinely helps other shoppers
        and means the world to us. Thank you!
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  private buildIncentiveCardHtml(
    couponCode: string,
    discountPercent: number
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      color: #333;
      background: #fff;
      padding: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      max-width: 480px;
      border: 2px solid #d35400;
      border-radius: 12px;
      padding: 40px;
      text-align: center;
      background: linear-gradient(135deg, #fef9f4 0%, #fff 100%);
    }
    .card h2 {
      font-size: 22px;
      color: #d35400;
      margin-bottom: 12px;
    }
    .card .offer {
      font-size: 16px;
      color: #555;
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .coupon-box {
      display: inline-block;
      background: #d35400;
      color: #fff;
      padding: 14px 32px;
      border-radius: 6px;
      font-size: 22px;
      font-weight: bold;
      letter-spacing: 3px;
      margin: 16px 0;
    }
    .discount {
      font-size: 36px;
      font-weight: bold;
      color: #d35400;
      margin: 16px 0 8px;
    }
    .instructions {
      font-size: 13px;
      color: #888;
      margin-top: 24px;
      line-height: 1.5;
    }
    .divider {
      border: none;
      border-top: 1px dashed #ddd;
      margin: 24px 0;
    }
    .fine-print {
      font-size: 11px;
      color: #aaa;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>Thank You for Your Purchase!</h2>
    <p class="offer">
      We hope you love your new printable! As a thank you,
      here's <strong>${discountPercent}% off</strong> your next order
      from our shop.
    </p>

    <div class="discount">${discountPercent}% OFF</div>

    <div class="coupon-box">${this.escapeHtml(couponCode)}</div>

    <hr class="divider">

    <p class="instructions">
      Use the code above at checkout on your next purchase
      from our shop. The discount applies to any item in our store.
    </p>

    <p class="fine-print">
      One use per customer. Cannot be combined with other offers.
      Valid for 60 days from purchase date.
    </p>
  </div>
</body>
</html>`;
  }

  private buildOutreachMessage(
    influencerName: string,
    productTitle: string,
    niche: string
  ): string {
    return [
      `Hi ${influencerName}!`,
      '',
      `I came across your work in the ${niche} space and I'm ` +
        `really impressed by what you create. I think we share a ` +
        `similar audience and aesthetic.`,
      '',
      `I'd love to send you a complimentary copy of my latest ` +
        `product, "${productTitle}". No strings attached — I just ` +
        `think you'd genuinely enjoy it based on your work.`,
      '',
      'If you find it useful, feel free to share it with your ' +
        'audience. But absolutely no obligation — I just want to ' +
        'get it in front of people who appreciate quality printable ' +
        'products.',
      '',
      'Would you like me to send the digital file over?',
      '',
      'Thanks for considering!',
    ].join('\n');
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private extractSellerHandle(listingUrl: string): string | null {
    // Etsy listing URLs: https://www.etsy.com/listing/123/...
    // Shop URLs: https://www.etsy.com/shop/ShopName
    const shopMatch = listingUrl.match(/etsy\.com\/shop\/([^/?]+)/);
    if (shopMatch) {
      return shopMatch[1];
    }

    // For listing URLs, we can't extract the shop name directly
    // Return null and let the caller handle it
    return null;
  }

  private calculateReviewVelocity(
    reviews: Array<{ created_timestamp: number }>
  ): number {
    if (reviews.length < 2) {
      return reviews.length;
    }

    const timestamps = reviews
      .map((r) => r.created_timestamp * 1000)
      .sort((a, b) => a - b);

    const oldestMs = timestamps[0];
    const newestMs = timestamps[timestamps.length - 1];
    const spanWeeks =
      (newestMs - oldestMs) / (1000 * 60 * 60 * 24 * 7);

    if (spanWeeks <= 0) {
      return reviews.length;
    }

    return Math.round((reviews.length / spanWeeks) * 100) / 100;
  }

  private async findUnprocessedProducts(): Promise<string[]> {
    let productDirs: string[];
    try {
      productDirs = await readdir(PRODUCTS_DIR);
    } catch {
      return [];
    }

    const unprocessed: string[] = [];

    for (const dir of productDirs) {
      const insertMetaPath = join(
        INSERTS_DIR,
        `${dir}-review-page.html`
      );

      try {
        await readFile(insertMetaPath, 'utf-8');
        // Insert already exists, skip
      } catch {
        // No insert yet — check if this product has a valid state
        try {
          await loadProductState(dir);
          unprocessed.push(dir);
        } catch {
          // Not a valid product directory
        }
      }
    }

    return unprocessed;
  }

  private async getActiveOutreach(): Promise<InfluencerOutreach[]> {
    const all = await this.getInfluencerOutreachHistory();
    return all.filter(
      (o) => o.status === 'contacted' || o.status === 'accepted'
    );
  }

  private async getListedProductIds(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(LISTINGS_DIR);
    } catch {
      return [];
    }

    const productIds: string[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(LISTINGS_DIR, file), 'utf-8');
        const listing = JSON.parse(raw) as ListingMetadata;
        if (listing.status === 'active' && listing.productId) {
          productIds.push(listing.productId);
        }
      } catch {
        continue;
      }
    }

    return productIds;
  }

  // ── State Persistence ────────────────────────────────────────────

  private async saveInsertMetadata(insert: ReviewInsert): Promise<void> {
    await ensureDirectories();
    const filePath = join(
      INSERTS_DIR,
      `${insert.productId}-${insert.type}-meta.json`
    );
    await writeFile(filePath, JSON.stringify(insert, null, 2), 'utf-8');
    logger.debug(
      `Saved insert metadata for ${insert.productId} (${insert.type})`
    );
  }

  private async saveOutreachRecord(
    outreach: InfluencerOutreach
  ): Promise<void> {
    await ensureDirectories();
    const filePath = join(INFLUENCER_DIR, `${outreach.id}.json`);
    await writeFile(
      filePath,
      JSON.stringify(outreach, null, 2),
      'utf-8'
    );
    logger.debug(
      `Saved outreach record ${outreach.id} ` +
        `(${outreach.influencerName}, status: ${outreach.status})`
    );
  }

  private async loadOutreachRecord(
    outreachId: string
  ): Promise<InfluencerOutreach> {
    const filePath = join(INFLUENCER_DIR, `${outreachId}.json`);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new InfluencerOutreachError(
        outreachId,
        `Outreach record not found: ${filePath}`
      );
    }

    return JSON.parse(raw) as InfluencerOutreach;
  }
}
