import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { FeedbackRecord, FeedbackDecision } from '../types/index.js';
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
}

export default checkApproval;
