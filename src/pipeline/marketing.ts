import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ListingData, MarketingPlan } from '../types/index.js';
import { runAgent } from '../agents/runner.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

export interface MarketingResult {
  processed: number;
  pinterest: number;
  email: number;
  blog: number;
  errors: string[];
}

const STATE_BASE = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = resolve(STATE_BASE, 'products');
const MARKETING_DIR = resolve(STATE_BASE, 'marketing');

async function getEligibleProducts(
  bufferDays: number
): Promise<Array<{ productId: string; listing: ListingData }>> {
  const eligible: Array<{ productId: string; listing: ListingData }> = [];

  let productDirs: string[];
  try {
    productDirs = await readdir(PRODUCTS_DIR);
  } catch {
    return eligible;
  }

  const now = Date.now();
  const bufferMs = bufferDays * 24 * 60 * 60 * 1000;

  for (const productId of productDirs) {
    try {
      const listingPath = resolve(PRODUCTS_DIR, productId, 'listing.json');
      const raw = await readFile(listingPath, 'utf-8');
      const listing = JSON.parse(raw) as ListingData;

      if (listing.status !== 'active') {
        continue;
      }

      const publishedAt = listing.publishedAt
        ? new Date(listing.publishedAt).getTime()
        : 0;

      if (publishedAt > 0 && now - publishedAt >= bufferMs) {
        eligible.push({ productId, listing });
      }
    } catch {
      // No listing file or invalid — skip
    }
  }

  return eligible;
}

async function loadMarketingPlan(
  productId: string
): Promise<MarketingPlan | null> {
  try {
    const filePath = resolve(MARKETING_DIR, `${productId}.json`);
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as MarketingPlan;
  } catch {
    return null;
  }
}

async function saveMarketingPlan(
  productId: string,
  plan: MarketingPlan
): Promise<void> {
  await mkdir(MARKETING_DIR, { recursive: true });
  const filePath = resolve(MARKETING_DIR, `${productId}.json`);
  await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf-8');
}

function createEmptyPlan(listingId: string): MarketingPlan {
  return {
    listingId,
    pinterest: { scheduled: false, pinCount: 0 },
    email: { scheduled: false },
    blog: { scheduled: false },
  };
}

async function checkListingHealth(
  listing: ListingData
): Promise<boolean> {
  logger.info(`Checking listing health for ${listing.listingId}`);
  const healthResult = await runAgent<{ isLive: boolean }>(
    'listing-health-checker',
    { listingId: listing.listingId, etsyUrl: listing.etsyUrl }
  );

  if (!healthResult.success || !healthResult.data) {
    logger.warn(`Health check failed for listing ${listing.listingId}`);
    return false;
  }

  return healthResult.data.isLive;
}

function daysSince(isoDate: string | undefined): number {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000);
}

export async function runMarketingPipeline(): Promise<MarketingResult> {
  const config = await loadConfig();
  const result: MarketingResult = {
    processed: 0,
    pinterest: 0,
    email: 0,
    blog: 0,
    errors: [],
  };

  if (!config.features.marketingEnabled) {
    logger.info('Marketing pipeline is disabled in config');
    return result;
  }

  logger.info('=== Marketing pipeline started ===');

  const eligible = await getEligibleProducts(
    config.pipeline.marketingBufferDays
  );

  logger.info(`Found ${eligible.length} eligible products for marketing`);

  for (const { productId, listing } of eligible) {
    result.processed++;

    // Health check before any marketing actions
    const isHealthy = await checkListingHealth(listing);
    if (!isHealthy) {
      const message = `Listing ${listing.listingId} failed health check, pausing marketing`;
      logger.warn(message);
      result.errors.push(`${productId}: ${message}`);
      continue;
    }

    let plan = await loadMarketingPlan(productId);
    if (!plan) {
      plan = createEmptyPlan(listing.listingId);
    }

    // ── Pinterest ─────────────────────────────────────────
    if (!plan.pinterest.completedAt) {
      const publishedDays = daysSince(listing.publishedAt);
      if (publishedDays >= config.pipeline.pinterestDelayDays) {
        try {
          logger.info(`Running Pinterest pins for product ${productId}`);
          const pinResult = await runAgent<{ pinCount: number }>(
            'marketing-pinterest',
            {
              productId,
              listing,
              pinsPerProduct: config.agents.marketing.pinsPerProduct,
            }
          );

          if (pinResult.success && pinResult.data) {
            plan.pinterest = {
              scheduled: true,
              pinCount: pinResult.data.pinCount,
              scheduledAt: plan.pinterest.scheduledAt ?? new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
            result.pinterest++;
            logger.info(`Pinterest: ${pinResult.data.pinCount} pins created for ${productId}`);
          } else {
            throw new Error(pinResult.error ?? 'Pinterest agent returned no data');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Pinterest failed for ${productId}: ${message}`);
          result.errors.push(`${productId}/pinterest: ${message}`);
        }
      }
    }

    // ── Email ─────────────────────────────────────────────
    if (
      config.agents.marketing.emailEnabled &&
      !plan.email.completedAt
    ) {
      const publishedDays = daysSince(listing.publishedAt);
      if (publishedDays >= config.pipeline.emailDelayDays) {
        try {
          logger.info(`Running email campaign for product ${productId}`);
          const emailResult = await runAgent<{ sent: boolean }>(
            'marketing-email',
            { productId, listing }
          );

          if (emailResult.success && emailResult.data) {
            plan.email = {
              scheduled: true,
              scheduledAt: plan.email.scheduledAt ?? new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
            result.email++;
            logger.info(`Email campaign sent for ${productId}`);
          } else {
            throw new Error(emailResult.error ?? 'Email agent returned no data');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Email failed for ${productId}: ${message}`);
          result.errors.push(`${productId}/email: ${message}`);
        }
      }
    }

    // ── Blog ──────────────────────────────────────────────
    if (
      config.agents.marketing.blogEnabled &&
      !plan.blog.completedAt
    ) {
      const publishedDays = daysSince(listing.publishedAt);
      if (publishedDays >= config.pipeline.blogDelayDays) {
        try {
          logger.info(`Running blog post for product ${productId}`);
          const blogResult = await runAgent<{ postUrl: string }>(
            'marketing-blog',
            { productId, listing }
          );

          if (blogResult.success && blogResult.data) {
            plan.blog = {
              scheduled: true,
              scheduledAt: plan.blog.scheduledAt ?? new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
            result.blog++;
            logger.info(`Blog post published for ${productId}: ${blogResult.data.postUrl}`);
          } else {
            throw new Error(blogResult.error ?? 'Blog agent returned no data');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Blog failed for ${productId}: ${message}`);
          result.errors.push(`${productId}/blog: ${message}`);
        }
      }
    }

    await saveMarketingPlan(productId, plan);
  }

  logger.info(
    `=== Marketing pipeline complete: ${result.processed} processed, ` +
    `${result.pinterest} pinterest, ${result.email} email, ${result.blog} blog, ` +
    `${result.errors.length} errors ===`
  );

  return result;
}

export default runMarketingPipeline;
