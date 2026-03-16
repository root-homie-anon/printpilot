import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type {
  FeedbackRecord,
  FeedbackDecision,
  ScoreReport,
  ProductBrief,
  ApprovalDecision,
  ListingData,
} from '../types/index.js';
import { runAgent } from '../agents/runner.js';
import { sendListingLive } from '../utils/notify.js';
import { atomicWriteJson, safeReadJson } from '../utils/resilience.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revision-requested';

export interface ApprovalData {
  productId: string;
  status: ApprovalStatus;
  decision?: FeedbackDecision;
  feedback?: FeedbackRecord;
  submittedAt: string;
  reviewedAt?: string;
  revisionCount?: number;
}

const STATE_BASE = resolve(process.cwd(), 'state/products');

function approvalPath(productId: string): string {
  return resolve(STATE_BASE, productId, 'approval.json');
}

export async function checkApproval(productId: string): Promise<ApprovalStatus> {
  logger.info(`Checking approval status for product ${productId}`);

  try {
    const filePath = approvalPath(productId);
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as ApprovalData;
    logger.info(`Product ${productId} approval status: ${data.status}`);
    return data.status;
  } catch {
    logger.info(`No approval record found for product ${productId}, returning pending`);
    return 'pending';
  }
}

export async function submitApproval(
  productId: string,
  decision: FeedbackDecision,
  feedback?: FeedbackRecord
): Promise<void> {
  logger.info(`Submitting approval for product ${productId}: ${decision}`);

  const filePath = approvalPath(productId);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  let existing: ApprovalData | null = null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    existing = JSON.parse(raw) as ApprovalData;
  } catch {
    // No existing record
  }

  const statusMap: Record<FeedbackDecision, ApprovalStatus> = {
    approve: 'approved',
    reject: 'rejected',
    revise: 'revision-requested',
  };

  const data: ApprovalData = {
    productId,
    status: statusMap[decision],
    decision,
    feedback,
    submittedAt: existing?.submittedAt ?? new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    revisionCount: existing?.revisionCount ?? 0,
  };

  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`Approval saved for product ${productId}: ${data.status}`);
}

/**
 * Create a pending approval — no Telegram, just writes the state file.
 * Products stay pending indefinitely until acted on via the dashboard.
 */
export async function createPendingApproval(productId: string): Promise<void> {
  const filePath = approvalPath(productId);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const data: ApprovalData = {
    productId,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    revisionCount: 0,
  };

  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`Pending approval created for product ${productId} — awaiting dashboard review`);
}

/**
 * Process an approval decision from the dashboard.
 * - approve: optionally run listing agent if autoPublish is on
 * - reject: mark as rejected, done
 * - revise: re-run designer → copywriter → scorer, then set back to pending
 */
export async function processApprovalDecision(
  productId: string,
  decision: FeedbackDecision,
  feedback?: FeedbackRecord
): Promise<{ success: boolean; message: string; listingData?: ListingData }> {
  await submitApproval(productId, decision, feedback);

  if (decision === 'reject') {
    logger.info(`Product ${productId} rejected via dashboard`);
    return { success: true, message: 'Product rejected' };
  }

  if (decision === 'revise') {
    return await runRevisionLoop(productId, feedback?.issues);
  }

  // decision === 'approve'
  const config = await loadConfig();
  if (!config.features.autoPublish) {
    logger.info(`Product ${productId} approved but autoPublish is disabled`);
    return { success: true, message: 'Product approved (autoPublish disabled)' };
  }

  return await runListingStage(productId);
}

/**
 * Revision loop: re-run designer → copywriter → scorer with feedback,
 * then set product back to pending approval.
 */
async function runRevisionLoop(
  productId: string,
  feedbackNotes?: string
): Promise<{ success: boolean; message: string }> {
  const productDir = resolve(STATE_BASE, productId);

  // Read current brief
  const brief = await safeReadJson<ProductBrief | null>(
    resolve(productDir, 'brief.json'),
    null
  );

  if (!brief) {
    return { success: false, message: 'Cannot revise: brief not found' };
  }

  // Read existing approval to track revision count
  const approvalData = await safeReadJson<ApprovalData | null>(
    approvalPath(productId),
    null
  );
  const revisionCount = (approvalData?.revisionCount ?? 0) + 1;

  logger.info(`Starting revision loop #${revisionCount} for product ${productId}`);

  const config = await loadConfig();

  try {
    // Re-run designer with feedback context
    logger.info(`Revision: re-running designer for product ${productId}`);
    const designResult = await runAgent<{ pdfPath: string }>('designer', {
      brief,
      pageSize: config.agents.designer.pageSize,
      exportDpi: config.agents.designer.exportDpi,
      revisionFeedback: feedbackNotes,
      revisionNumber: revisionCount,
    });

    if (!designResult.success || !designResult.data) {
      throw new Error(designResult.error ?? 'Designer returned no data');
    }

    await atomicWriteJson(resolve(productDir, 'design.json'), designResult.data);

    // Re-run copywriter
    logger.info(`Revision: re-running copywriter for product ${productId}`);
    const copyResult = await runAgent<{
      title: string;
      description: string;
      tags: string[];
    }>('copywriter', {
      brief,
      productId,
      revisionFeedback: feedbackNotes,
      revisionNumber: revisionCount,
    });

    if (!copyResult.success || !copyResult.data) {
      throw new Error(copyResult.error ?? 'Copywriter returned no data');
    }

    await atomicWriteJson(resolve(productDir, 'copy.json'), copyResult.data);

    // Re-run scorer
    logger.info(`Revision: re-running scorer for product ${productId}`);
    const scoreResult = await runAgent<{
      overallScore: number;
      recommendation: string;
    }>('scorer', {
      brief,
      design: designResult.data,
      copy: copyResult.data,
      revisionNumber: revisionCount,
    });

    if (!scoreResult.success || !scoreResult.data) {
      throw new Error(scoreResult.error ?? 'Scorer returned no data');
    }

    await atomicWriteJson(resolve(productDir, 'score.json'), scoreResult.data);

    // Set back to pending with updated revision count
    const pendingData: ApprovalData = {
      productId,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      revisionCount,
    };
    await writeFile(approvalPath(productId), JSON.stringify(pendingData, null, 2), 'utf-8');

    logger.info(`Revision loop #${revisionCount} complete for product ${productId} — back to pending`);
    return {
      success: true,
      message: `Revision #${revisionCount} complete — product is back in approval queue`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Revision loop failed for product ${productId}: ${message}`);
    return { success: false, message: `Revision failed: ${message}` };
  }
}

/**
 * Run the listing agent for an approved product.
 */
async function runListingStage(
  productId: string
): Promise<{ success: boolean; message: string; listingData?: ListingData }> {
  const productDir = resolve(STATE_BASE, productId);

  const copy = await safeReadJson<{ title: string; description: string; tags: string[] } | null>(
    resolve(productDir, 'copy.json'),
    null
  );
  const design = await safeReadJson<{ pdfPath: string } | null>(
    resolve(productDir, 'design.json'),
    null
  );

  if (!copy || !design) {
    return { success: false, message: 'Cannot list: copy or design data missing' };
  }

  try {
    logger.info(`Running listing agent for approved product ${productId}`);
    const listingResult = await runAgent<ListingData>('listing-agent', {
      productId,
      copy,
      pdfPath: design.pdfPath,
    });

    if (!listingResult.success || !listingResult.data) {
      throw new Error(listingResult.error ?? 'Listing agent returned no data');
    }

    await atomicWriteJson(resolve(productDir, 'listing.json'), listingResult.data);
    await sendListingLive(listingResult.data);

    logger.info(`Product ${productId} listed at ${listingResult.data.etsyUrl}`);
    return {
      success: true,
      message: `Listed at ${listingResult.data.etsyUrl}`,
      listingData: listingResult.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Listing failed for product ${productId}: ${message}`);
    return { success: false, message: `Listing failed: ${message}` };
  }
}

export default checkApproval;
