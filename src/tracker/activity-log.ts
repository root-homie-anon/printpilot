import { appendFile, readFile, rename, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';

const STATE_DIR = resolve(process.cwd(), 'state', 'logs');
const ACTIVITY_LOG_PATH = join(STATE_DIR, 'activity.jsonl');

export interface ActivityEntry {
  timestamp: string;
  agent: string;
  action: string;
  productId?: string;
  details?: string;
  duration?: number;
  success: boolean;
}

async function ensureLogDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

async function rotateIfNeeded(): Promise<void> {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rotatedPath = join(STATE_DIR, `activity-${monthKey}.jsonl`);

  let content: string;
  try {
    content = await readFile(ACTIVITY_LOG_PATH, 'utf-8');
  } catch {
    return;
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  const firstLine = JSON.parse(lines[0]) as ActivityEntry;
  const firstDate = new Date(firstLine.timestamp);
  const firstMonthKey = `${firstDate.getFullYear()}-${String(firstDate.getMonth() + 1).padStart(2, '0')}`;

  if (firstMonthKey !== monthKey) {
    logger.info(`Rotating activity log: ${firstMonthKey} → ${rotatedPath}`);
    await rename(ACTIVITY_LOG_PATH, rotatedPath);
  }
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  await ensureLogDir();
  await rotateIfNeeded();

  const line = JSON.stringify(entry) + '\n';
  await appendFile(ACTIVITY_LOG_PATH, line, 'utf-8');

  logger.info(
    `Activity logged: [${entry.agent}] ${entry.action}${entry.productId ? ` (${entry.productId})` : ''}`
  );
}

export async function getRecentActivity(days: number = 7): Promise<ActivityEntry[]> {
  await ensureLogDir();

  let content: string;
  try {
    content = await readFile(ACTIVITY_LOG_PATH, 'utf-8');
  } catch {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();

  const entries: ActivityEntry[] = [];
  const lines = content.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const entry = JSON.parse(line) as ActivityEntry;
    if (entry.timestamp >= cutoffIso) {
      entries.push(entry);
    }
  }

  return entries;
}
