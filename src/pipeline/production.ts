import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Opportunity,
  ProductBrief,
  Product,
  PipelineResult,
} from '../types/index.js';
import type { EnhancedProductBrief } from '../agents/strategist-enhanced.js';
import type { ComparisonResult } from '../agents/reference-comparator.js';
import { runAgent } from '../agents/runner.js';
import { createPendingApproval } from './approval-gate.js';
import { loadConfig } from '../utils/config.js';
import {
  atomicWriteJson,
  safeReadJson,
  sendToDeadLetterQueue,
} from '../utils/resilience.js';
import {
  sendPipelineError,
  sendDailySummary,
} from '../utils/notify.js';
import logger from '../utils/logger.js';

const STATE_BASE = resolve(process.cwd(), 'state');
const QUEUE_DIR = resolve(STATE_BASE, 'products');

async function writeProductState(
  productId: string,
  stage: string,
  data: unknown
): Promise<void> {
  const dir = resolve(QUEUE_DIR, productId);
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(resolve(dir, `${stage}.json`), data);
}

async function readProductState<T>(
  productId: string,
  stage: string
): Promise<T | null> {
  return safeReadJson<T | null>(
    resolve(QUEUE_DIR, productId, `${stage}.json`),
    null
  );
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

  // ── Velocity Guard: ramp up listing rate for new shops ──────
  // Etsy flags rapid automated listing on new shops. Start slow.
  const listingsDir = resolve(STATE_BASE, 'listings');
  let activeListingCount = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(listingsDir);
    activeListingCount = files.filter((f) => f.endsWith('.json')).length;
  } catch {
    // No listings yet
  }

  let effectiveProductsPerDay = config.pipeline.productsPerDay;
  if (activeListingCount < 20) {
    effectiveProductsPerDay = Math.min(effectiveProductsPerDay, 1);
    logger.info(
      `Velocity guard: shop has ${activeListingCount} listings, ` +
      `limiting to ${effectiveProductsPerDay}/day (ramp-up phase)`
    );
  } else if (activeListingCount < 50) {
    effectiveProductsPerDay = Math.min(effectiveProductsPerDay, 2);
  }
  // Above 50 listings: use full configured rate

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
    await sendPipelineError('research', message);
    await sendDailySummary(result);
    return result;
  }

  // ── Stage 2: Enhanced Strategy — competitive intel + pick top N ──
  let briefs: EnhancedProductBrief[] = [];
  try {
    logger.info('Stage 2: Running enhanced strategist agent');
    const strategyResult = await runAgent<EnhancedProductBrief[]>(
      'strategist-enhanced',
      {
        opportunities,
        productsPerDay: effectiveProductsPerDay,
      }
    );

    if (!strategyResult.success || !strategyResult.data) {
      throw new Error(strategyResult.error ?? 'Enhanced strategist returned no data');
    }

    briefs = strategyResult.data;
    logger.info(`Enhanced strategist selected ${briefs.length} products`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Strategy stage failed: ${message}`);
    result.errors.push(`strategy: ${message}`);
    await sendPipelineError('strategy', message);
    await sendDailySummary(result);
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

      // ── Stage 6: Reference Comparator ───────────────────
      logger.info(`Stage 6: Running reference comparator for product ${productId}`);
      try {
        const comparisonResult = await runAgent<ComparisonResult>(
          'reference-comparator',
          { productId }
        );

        if (comparisonResult.success && comparisonResult.data) {
          await writeProductState(productId, 'comparison', comparisonResult.data);

          if (!comparisonResult.data.readyToList) {
            logger.warn(
              `Product ${productId} failed reference comparison ` +
              `(alignment: ${comparisonResult.data.overallAlignment}/100). ` +
              `Proceeding to approval with comparison data.`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Reference comparator failed for ${productId}: ${message} — continuing`);
      }

      // ── Stage 7: Approval Gate ────────────────────────────
      // Pipeline creates pending approval and moves on.
      // Approval decisions + listing are handled via the dashboard.
      logger.info(`Stage 7: Approval gate for product ${productId}`);
      await createPendingApproval(productId);
      logger.info(
        `Product ${productId} queued for dashboard approval — ` +
        `review at http://localhost:${process.env.DASHBOARD_PORT ?? '3737'}/#approvals`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Product ${productId} pipeline failed: ${message}`);
      result.errors.push(`${productId}: ${message}`);

      await sendPipelineError('product-pipeline', message, productId);

      // Capture failed product for replay
      await sendToDeadLetterQueue(
        'product-pipeline',
        message,
        { productId, brief },
        productId
      ).catch(() => { /* DLQ write failure shouldn't block pipeline */ });
    }
  }

  logger.info(
    `=== Production pipeline complete: ${result.productsProcessed} processed, ` +
    `${result.approved} approved, ${result.listed} listed, ` +
    `${result.errors.length} errors ===`
  );

  // Send daily summary
  await sendDailySummary(result);

  return result;
}

export type { PipelineResult };
export default runProductionPipeline;
