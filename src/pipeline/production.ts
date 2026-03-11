import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Opportunity,
  ProductBrief,
  Product,
  ListingData,
} from '../types/index.js';
import { runAgent } from '../agents/runner.js';
import { checkApproval, createPendingApproval } from './approval-gate.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

export interface PipelineResult {
  productsProcessed: number;
  approved: number;
  listed: number;
  errors: string[];
}

const STATE_BASE = resolve(process.cwd(), 'state');
const QUEUE_DIR = resolve(STATE_BASE, 'products');

async function writeProductState(
  productId: string,
  stage: string,
  data: unknown
): Promise<void> {
  const dir = resolve(QUEUE_DIR, productId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, `${stage}.json`),
    JSON.stringify(data, null, 2),
    'utf-8'
  );
}

async function readProductState<T>(
  productId: string,
  stage: string
): Promise<T | null> {
  try {
    const filePath = resolve(QUEUE_DIR, productId, `${stage}.json`);
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function sendNotification(message: string): Promise<void> {
  const config = await loadConfig();
  if (config.notifications.channel === 'telegram') {
    logger.info(`[Telegram notification] ${message}`);
    // Telegram integration would fire here
  }
}

export async function runProductionPipeline(): Promise<PipelineResult> {
  const config = await loadConfig();
  const result: PipelineResult = {
    productsProcessed: 0,
    approved: 0,
    listed: 0,
    errors: [],
  };

  logger.info('=== Production pipeline started ===');

  // ── Stage 1: Research ───────────────────────────────────────
  let opportunities: Opportunity[] = [];
  try {
    logger.info('Stage 1: Running researcher agent');
    const researchResult = await runAgent<Opportunity[]>('researcher', {
      maxOpportunities: config.agents.researcher.maxOpportunitiesPerRun,
      minReviewCount: config.agents.researcher.minReviewCount,
      targetPriceRange: config.agents.researcher.targetPriceRange,
    });

    if (!researchResult.success || !researchResult.data) {
      throw new Error(researchResult.error ?? 'Researcher returned no data');
    }

    opportunities = researchResult.data;
    logger.info(`Researcher found ${opportunities.length} opportunities`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Research stage failed: ${message}`);
    result.errors.push(`research: ${message}`);
    await sendNotification(`Production pipeline: research stage failed - ${message}`);
    return result;
  }

  // ── Stage 2: Strategy — pick top N ─────────────────────────
  let briefs: ProductBrief[] = [];
  try {
    logger.info('Stage 2: Running strategist agent');
    const strategyResult = await runAgent<ProductBrief[]>('strategist', {
      opportunities,
      productsPerDay: config.pipeline.productsPerDay,
    });

    if (!strategyResult.success || !strategyResult.data) {
      throw new Error(strategyResult.error ?? 'Strategist returned no data');
    }

    briefs = strategyResult.data;
    logger.info(`Strategist selected ${briefs.length} products`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Strategy stage failed: ${message}`);
    result.errors.push(`strategy: ${message}`);
    await sendNotification(`Production pipeline: strategy stage failed - ${message}`);
    return result;
  }

  // ── Process each product through remaining stages ──────────
  for (const brief of briefs) {
    const productId = brief.id || randomUUID();
    result.productsProcessed++;

    try {
      await writeProductState(productId, 'brief', brief);

      // ── Stage 3: Design ───────────────────────────────────
      logger.info(`Stage 3: Running designer for product ${productId}`);
      const designResult = await runAgent<{ pdfPath: string }>('designer', {
        brief,
        pageSize: config.agents.designer.pageSize,
        exportDpi: config.agents.designer.exportDpi,
      });

      if (!designResult.success || !designResult.data) {
        throw new Error(designResult.error ?? 'Designer returned no data');
      }

      await writeProductState(productId, 'design', designResult.data);

      // ── Stage 4: Copywriting ──────────────────────────────
      logger.info(`Stage 4: Running copywriter for product ${productId}`);
      const copyResult = await runAgent<{
        title: string;
        description: string;
        tags: string[];
      }>('copywriter', { brief, productId });

      if (!copyResult.success || !copyResult.data) {
        throw new Error(copyResult.error ?? 'Copywriter returned no data');
      }

      await writeProductState(productId, 'copy', copyResult.data);

      // ── Stage 5: Scoring ──────────────────────────────────
      logger.info(`Stage 5: Running scorer for product ${productId}`);
      const scoreResult = await runAgent<{
        overallScore: number;
        recommendation: string;
      }>('scorer', {
        brief,
        design: designResult.data,
        copy: copyResult.data,
      });

      if (!scoreResult.success || !scoreResult.data) {
        throw new Error(scoreResult.error ?? 'Scorer returned no data');
      }

      await writeProductState(productId, 'score', scoreResult.data);

      // ── Stage 6: Approval Gate ────────────────────────────
      logger.info(`Stage 6: Approval gate for product ${productId}`);
      await createPendingApproval(productId);

      if (config.notifications.approvalRequired) {
        await sendNotification(
          `New product ready for review: ${productId}\n` +
          `Niche: ${brief.niche}\n` +
          `Score: ${scoreResult.data.overallScore}\n` +
          `Recommendation: ${scoreResult.data.recommendation}`
        );
      }

      const approvalStatus = await checkApproval(productId);

      if (approvalStatus === 'approved') {
        result.approved++;

        // ── Stage 7: Listing ──────────────────────────────
        if (config.features.autoPublish) {
          logger.info(`Stage 7: Running listing agent for product ${productId}`);
          const listingResult = await runAgent<ListingData>('listing-agent', {
            productId,
            copy: copyResult.data,
            pdfPath: designResult.data.pdfPath,
          });

          if (!listingResult.success || !listingResult.data) {
            throw new Error(listingResult.error ?? 'Listing agent returned no data');
          }

          await writeProductState(productId, 'listing', listingResult.data);
          result.listed++;

          logger.info(
            `Product ${productId} listed at ${listingResult.data.etsyUrl}`
          );
        } else {
          logger.info(
            `Product ${productId} approved but autoPublish is disabled`
          );
        }
      } else {
        logger.info(
          `Product ${productId} awaiting approval (status: ${approvalStatus})`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Product ${productId} pipeline failed: ${message}`);
      result.errors.push(`${productId}: ${message}`);

      await sendNotification(
        `Product pipeline failed for ${productId}: ${message}`
      );
    }
  }

  logger.info(
    `=== Production pipeline complete: ${result.productsProcessed} processed, ` +
    `${result.approved} approved, ${result.listed} listed, ` +
    `${result.errors.length} errors ===`
  );

  return result;
}

export default runProductionPipeline;
