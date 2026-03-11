import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type {
  FeedbackRecord,
  FeedbackDecision,
  ScoreReport,
  ProductBrief,
  ApprovalDecision,
} from '../types/index.js';
import { sendApprovalRequest } from '../utils/notify.js';
import logger from '../utils/logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revision-requested';

export interface ApprovalData {
  productId: string;
  status: ApprovalStatus;
  decision?: FeedbackDecision;
  feedback?: FeedbackRecord;
  submittedAt: string;
  reviewedAt?: string;
}

const STATE_BASE = resolve(process.cwd(), 'state/products');
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_INTERVAL_MS = 5000; // 5 seconds

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
  };

  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`Approval saved for product ${productId}: ${data.status}`);
}

export async function createPendingApproval(productId: string): Promise<void> {
  const filePath = approvalPath(productId);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const data: ApprovalData = {
    productId,
    status: 'pending',
    submittedAt: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`Pending approval created for product ${productId}`);

  // Automatically trigger Telegram notification
  await notifyForApproval(productId);
}

export async function notifyForApproval(productId: string): Promise<void> {
  try {
    const productDir = resolve(STATE_BASE, productId);

    const briefRaw = await readFile(resolve(productDir, 'brief.json'), 'utf-8');
    const brief = JSON.parse(briefRaw) as ProductBrief;

    const scoreRaw = await readFile(resolve(productDir, 'score.json'), 'utf-8');
    const scoreReport = JSON.parse(scoreRaw) as ScoreReport;

    await sendApprovalRequest(productId, scoreReport, brief);
    logger.info(`Telegram approval notification sent for product ${productId}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to send approval notification for product ${productId}`, {
      error: errMsg,
    });
    // Don't throw — notification failure shouldn't block the pipeline
  }
}

export async function waitForApproval(
  productId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ApprovalDecision> {
  logger.info(`Waiting for approval of product ${productId} (timeout: ${timeoutMs}ms)`);

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await checkApproval(productId);

    if (status !== 'pending') {
      const filePath = approvalPath(productId);
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as ApprovalData;

      const decisionMap: Record<ApprovalStatus, FeedbackDecision> = {
        approved: 'approve',
        rejected: 'reject',
        'revision-requested': 'revise',
        pending: 'approve', // Unreachable due to the status check above
      };

      const result: ApprovalDecision = {
        decision: data.decision ?? decisionMap[status],
        feedback: data.feedback?.issues,
        decidedAt: data.reviewedAt ?? new Date().toISOString(),
      };

      logger.info(`Approval received for product ${productId}: ${result.decision}`);
      return result;
    }

    await new Promise<void>((r) => {
      setTimeout(r, POLL_INTERVAL_MS);
    });
  }

  // Timeout reached — treat as still pending, return a timeout decision
  logger.warn(`Approval timeout reached for product ${productId}`);
  const timeoutDecision: ApprovalDecision = {
    decision: 'reject',
    feedback: 'Approval timed out after 24 hours',
    decidedAt: new Date().toISOString(),
  };

  // Record the timeout as a rejection
  await submitApproval(productId, 'reject');

  return timeoutDecision;
}

export default checkApproval;
