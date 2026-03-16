import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import logger from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';

// ── Types ───────────────────────────────────────────────────────────

export type MarketingChannel = 'pinterest' | 'email' | 'blog';
export type ActionStatus = 'scheduled' | 'executing' | 'completed' | 'failed' | 'skipped';

export interface ScheduledAction {
  channel: MarketingChannel;
  scheduledDate: string;
  status: ActionStatus;
  data: Record<string, string>;
  completedAt?: string;
  error?: string;
}

export interface MarketingSchedule {
  productId: string;
  actions: ScheduledAction[];
}

export interface ExecutionResult {
  productId: string;
  channel: MarketingChannel;
  success: boolean;
  error?: string;
}

// ── Errors ──────────────────────────────────────────────────────────

export class SchedulerError extends Error {
  public readonly productId: string;

  constructor(productId: string, message: string) {
    super(`Scheduler error for product ${productId}: ${message}`);
    this.name = 'SchedulerError';
    this.productId = productId;
  }
}

// ── Callbacks for channel execution ─────────────────────────────────

export interface ChannelExecutors {
  pinterest: (productId: string, data: Record<string, string>) => Promise<void>;
  email: (productId: string, data: Record<string, string>) => Promise<void>;
  blog: (productId: string, data: Record<string, string>) => Promise<void>;
}

// ── Core functions ──────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing');

function getSchedulePath(productId: string): string {
  return resolve(STATE_DIR, productId, 'schedule.json');
}

export async function scheduleMarketing(
  productId: string,
  listingUrl: string
): Promise<MarketingSchedule> {
  logger.info(`Scheduling marketing for product ${productId}`);

  const config = await loadConfig();
  const pipelineConfig = config.pipeline;
  const marketingConfig = config.agents.marketing;

  const now = new Date();
  const actions: ScheduledAction[] = [];

  // Pinterest pins — delayed by pinterestDelayDays from listing date
  if (marketingConfig.pinterestEnabled && marketingConfig.pinsPerProduct > 0) {
    const pinterestDate = addDays(now, pipelineConfig.pinterestDelayDays);
    actions.push({
      channel: 'pinterest',
      scheduledDate: pinterestDate.toISOString(),
      status: 'scheduled',
      data: {
        listingUrl,
        pinCount: String(marketingConfig.pinsPerProduct),
      },
    });
  }

  // Email notification — delayed by emailDelayDays from listing date
  if (marketingConfig.emailEnabled) {
    const emailDate = addDays(now, pipelineConfig.emailDelayDays);
    actions.push({
      channel: 'email',
      scheduledDate: emailDate.toISOString(),
      status: 'scheduled',
      data: {
        listingUrl,
      },
    });
  }

  // Blog post — delayed by blogDelayDays from listing date
  if (marketingConfig.blogEnabled) {
    const blogDate = addDays(now, pipelineConfig.blogDelayDays);
    actions.push({
      channel: 'blog',
      scheduledDate: blogDate.toISOString(),
      status: 'scheduled',
      data: {
        listingUrl,
      },
    });
  }

  const schedule: MarketingSchedule = { productId, actions };

  await saveSchedule(schedule);

  logger.info(
    `Marketing scheduled for product ${productId}: ` +
      `${actions.length} actions across ${actions.map((a) => a.channel).join(', ')}`
  );

  return schedule;
}

export async function getScheduledActions(
  productId: string
): Promise<ScheduledAction[]> {
  logger.debug(`Loading scheduled actions for product ${productId}`);

  const schedule = await loadSchedule(productId);
  return schedule.actions;
}

export async function executeScheduledActions(
  executors: ChannelExecutors
): Promise<ExecutionResult[]> {
  logger.info('Executing due marketing actions');

  const { readdir } = await import('node:fs/promises');
  const results: ExecutionResult[] = [];

  let productDirs: string[];
  try {
    productDirs = await readdir(STATE_DIR);
  } catch {
    logger.info('No marketing state directory found, nothing to execute');
    return results;
  }

  const now = new Date();

  for (const productId of productDirs) {
    let schedule: MarketingSchedule;
    try {
      schedule = await loadSchedule(productId);
    } catch {
      logger.warn(`Failed to load schedule for ${productId}, skipping`);
      continue;
    }

    let modified = false;

    for (const action of schedule.actions) {
      if (action.status !== 'scheduled') {
        continue;
      }

      const scheduledDate = new Date(action.scheduledDate);
      if (scheduledDate > now) {
        continue;
      }

      logger.info(`Executing ${action.channel} action for product ${productId}`);
      action.status = 'executing';
      modified = true;

      try {
        await executors[action.channel](productId, action.data);
        action.status = 'completed';
        action.completedAt = new Date().toISOString();

        results.push({
          productId,
          channel: action.channel,
          success: true,
        });

        logger.info(`Successfully executed ${action.channel} for product ${productId}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        action.status = 'failed';
        action.error = message;

        results.push({
          productId,
          channel: action.channel,
          success: false,
          error: message,
        });

        logger.error(
          `Failed to execute ${action.channel} for product ${productId}: ${message}`
        );
      }
    }

    if (modified) {
      await saveSchedule(schedule);
    }
  }

  logger.info(
    `Marketing execution complete: ${results.length} actions processed, ` +
      `${results.filter((r) => r.success).length} succeeded, ` +
      `${results.filter((r) => !r.success).length} failed`
  );

  return results;
}

// ── Internal helpers ────────────────────────────────────────────────

async function loadSchedule(productId: string): Promise<MarketingSchedule> {
  const schedulePath = getSchedulePath(productId);
  const raw = await readFile(schedulePath, 'utf-8');
  return JSON.parse(raw) as MarketingSchedule;
}

async function saveSchedule(schedule: MarketingSchedule): Promise<void> {
  const schedulePath = getSchedulePath(schedule.productId);
  const dir = dirname(schedulePath);
  await mkdir(dir, { recursive: true });
  await writeFile(schedulePath, JSON.stringify(schedule, null, 2), 'utf-8');
  logger.debug(`Saved marketing schedule for product ${schedule.productId}`);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}
