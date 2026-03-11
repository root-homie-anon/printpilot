import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
// @ts-expect-error node-cron has no type declarations
import cron from 'node-cron';
import logger from './utils/logger.js';
import { loadConfig } from './utils/config.js';
import { runResearch } from './agents/researcher.js';
import { runStrategy } from './agents/strategist.js';
import { runDesign } from './agents/designer.js';
import { runCopywriting } from './agents/copywriter.js';
import { runScoring } from './agents/scorer.js';
import { aggregateMetrics } from './tracker/metrics.js';
import { updateNicheRegistry } from './tracker/niche-updater.js';
import { logActivity } from './tracker/activity-log.js';
import type { ProductBrief } from './types/index.js';

const REQUIRED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ETSY_API_KEY',
  'ETSY_API_SECRET',
  'ETSY_SHOP_ID',
];

const REQUIRED_DIRS = [
  'state',
  'state/queue',
  'state/products',
  'state/listings',
  'state/metrics',
  'state/logs',
  'state/marketing',
  'feedback',
  'shared',
];

type CliMode = 'daily' | 'weekly' | 'dashboard' | 'health-check' | 'default';

function parseArgs(args: string[]): CliMode {
  if (args.includes('--daily')) return 'daily';
  if (args.includes('--weekly')) return 'weekly';
  if (args.includes('--dashboard')) return 'dashboard';
  if (args.includes('--health-check')) return 'health-check';
  return 'default';
}

async function checkDirExists(dirPath: string): Promise<boolean> {
  try {
    await access(resolve(process.cwd(), dirPath));
    return true;
  } catch {
    return false;
  }
}

async function runHealthCheck(): Promise<boolean> {
  logger.info('Running health checks...');
  let healthy = true;

  // Check environment variables
  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      logger.warn(`Missing environment variable: ${envVar}`);
      healthy = false;
    } else {
      logger.info(`env ${envVar} is set`);
    }
  }

  // Check required directories
  for (const dir of REQUIRED_DIRS) {
    const exists = await checkDirExists(dir);
    if (!exists) {
      logger.warn(`Missing directory: ${dir}`);
      healthy = false;
    } else {
      logger.info(`dir ${dir} exists`);
    }
  }

  // Check config.json
  try {
    const config = await loadConfig();
    logger.info(`config.json loaded (version: ${config.project.version})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`config.json failed: ${message}`);
    healthy = false;
  }

  const status = healthy ? 'HEALTHY' : 'UNHEALTHY';
  logger.info(`Health check complete: ${status}`);

  return healthy;
}

async function runDailyPipeline(): Promise<void> {
  logger.info('=== Starting daily pipeline ===');
  const pipelineStart = performance.now();

  await logActivity({
    timestamp: new Date().toISOString(),
    agent: 'orchestrator',
    action: 'daily-pipeline-start',
    success: true,
  });

  // Stage 1: Research
  logger.info('--- Stage 1: Research ---');
  const researchResult = await runResearch();
  if (!researchResult.success || !researchResult.data) {
    logger.error('Research stage failed, aborting pipeline');
    return;
  }
  logger.info(`Research found ${researchResult.data.length} opportunities`);

  // Stage 2: Strategy
  logger.info('--- Stage 2: Strategy ---');
  const strategyResult = await runStrategy();
  if (!strategyResult.success || !strategyResult.data) {
    logger.error('Strategy stage failed, aborting pipeline');
    return;
  }
  const briefs: ProductBrief[] = strategyResult.data;
  logger.info(`Strategy selected ${briefs.length} products`);

  // Stage 3-5: Design, Copy, Score (per product)
  for (const brief of briefs) {
    logger.info(`--- Processing product: ${brief.id} ---`);

    // Design
    logger.info('Stage 3: Design');
    const designResult = await runDesign(brief);
    if (!designResult.success) {
      logger.error(`Design failed for ${brief.id}, skipping`);
      continue;
    }

    // Copywriting
    logger.info('Stage 4: Copywriting');
    const copyResult = await runCopywriting(brief.id);
    if (!copyResult.success) {
      logger.error(`Copywriting failed for ${brief.id}, skipping`);
      continue;
    }

    // Scoring
    logger.info('Stage 5: Scoring');
    const scoreResult = await runScoring(brief.id);
    if (!scoreResult.success) {
      logger.error(`Scoring failed for ${brief.id}, skipping`);
      continue;
    }

    logger.info(
      `Product ${brief.id} scored: ${scoreResult.data?.recommendation ?? 'unknown'}`
    );
  }

  // Update metrics and niche registry
  await aggregateMetrics();
  await updateNicheRegistry();

  const totalDuration = Math.round(performance.now() - pipelineStart);

  await logActivity({
    timestamp: new Date().toISOString(),
    agent: 'orchestrator',
    action: 'daily-pipeline-complete',
    details: `${briefs.length} products processed in ${totalDuration}ms`,
    duration: totalDuration,
    success: true,
  });

  logger.info(`=== Daily pipeline complete: ${briefs.length} products in ${totalDuration}ms ===`);
}

async function runWeeklySynthesis(): Promise<void> {
  logger.info('=== Starting weekly synthesis ===');

  await logActivity({
    timestamp: new Date().toISOString(),
    agent: 'orchestrator',
    action: 'weekly-synthesis-start',
    success: true,
  });

  // Aggregate metrics for the week
  await aggregateMetrics();
  await updateNicheRegistry();

  logger.info('Weekly metrics aggregated and niche registry updated');

  await logActivity({
    timestamp: new Date().toISOString(),
    agent: 'orchestrator',
    action: 'weekly-synthesis-complete',
    success: true,
  });

  logger.info('=== Weekly synthesis complete ===');
}

async function startDashboard(): Promise<void> {
  logger.info('Starting dashboard server...');
  // Dashboard server is started via src/dashboard/server.ts
  logger.info('Dashboard module not yet implemented — use `npm run dashboard` directly');
}

function setupCronSchedules(): void {
  logger.info('Setting up cron schedules');

  // Daily pipeline at 06:00
  cron.schedule('0 6 * * *', () => {
    logger.info('Cron trigger: daily pipeline');
    runDailyPipeline().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Daily pipeline cron failed: ${message}`);
    });
  });

  // Weekly synthesis on Sundays at 10:00
  cron.schedule('0 10 * * 0', () => {
    logger.info('Cron trigger: weekly synthesis');
    runWeeklySynthesis().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Weekly synthesis cron failed: ${message}`);
    });
  });

  logger.info('Cron schedules active: daily@06:00, weekly@Sunday-10:00');
}

function setupGracefulShutdown(): void {
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    logActivity({
      timestamp: new Date().toISOString(),
      agent: 'orchestrator',
      action: `shutdown-${signal.toLowerCase()}`,
      success: true,
    }).finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = parseArgs(args);

  logger.info(`PrintPilot starting in "${mode}" mode`);

  try {
    const config = await loadConfig();
    logger.info(`Project: ${config.project.name} v${config.project.version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to load config: ${message}`);
    process.exit(1);
  }

  setupGracefulShutdown();

  switch (mode) {
    case 'daily':
      await runDailyPipeline();
      break;

    case 'weekly':
      await runWeeklySynthesis();
      break;

    case 'dashboard':
      await startDashboard();
      break;

    case 'health-check': {
      const healthy = await runHealthCheck();
      process.exit(healthy ? 0 : 1);
      break;
    }

    case 'default':
      logger.info('Starting in default mode: dashboard + cron schedules');
      await startDashboard();
      setupCronSchedules();
      logger.info('PrintPilot is running. Press Ctrl+C to stop.');
      break;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Fatal error: ${message}`);
  process.exit(1);
});
