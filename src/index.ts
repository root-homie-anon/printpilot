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
import { startBot, stopBot } from './notifications/telegram-bot.js';
import { sendDailySummary } from './utils/notify.js';
import { registerAllAgents } from './agents/register-all.js';
import type { ProductBrief, PipelineResult } from './types/index.js';

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

  const result: PipelineResult = {
    productsProcessed: 0,
    approved: 0,
    listed: 0,
    errors: [],
  };

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
    result.errors.push('research: stage failed');
    await sendDailySummary(result);
    return;
  }
  logger.info(`Research found ${researchResult.data.length} opportunities`);

  // Stage 2: Strategy
  logger.info('--- Stage 2: Strategy ---');
  const strategyResult = await runStrategy();
  if (!strategyResult.success || !strategyResult.data) {
    logger.error('Strategy stage failed, aborting pipeline');
    result.errors.push('strategy: stage failed');
    await sendDailySummary(result);
    return;
  }
  const briefs: ProductBrief[] = strategyResult.data;
  logger.info(`Strategy selected ${briefs.length} products`);

  // Stage 3-5: Design, Copy, Score (per product) — run in parallel
  const productResults = await Promise.allSettled(
    briefs.map(async (brief) => {
      logger.info(`--- Processing product: ${brief.id} ---`);
      result.productsProcessed++;

      // Design
      logger.info(`Stage 3: Design for ${brief.id}`);
      const designResult = await runDesign(brief);
      if (!designResult.success) {
        throw new Error(`design failed: ${designResult.error}`);
      }

      // Copywriting
      logger.info(`Stage 4: Copywriting for ${brief.id}`);
      const copyResult = await runCopywriting(brief.id);
      if (!copyResult.success) {
        throw new Error(`copywriting failed: ${copyResult.error}`);
      }

      // Scoring
      logger.info(`Stage 5: Scoring for ${brief.id}`);
      const scoreResult = await runScoring(brief.id);
      if (!scoreResult.success) {
        throw new Error(`scoring failed: ${scoreResult.error}`);
      }

      logger.info(
        `Product ${brief.id} scored: ${scoreResult.data?.recommendation ?? 'unknown'}`
      );
    })
  );

  for (const [i, settled] of productResults.entries()) {
    if (settled.status === 'rejected') {
      const brief = briefs[i];
      const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      logger.error(`Product ${brief?.id} failed: ${message}`);
      result.errors.push(`${brief?.id}: ${message}`);
    }
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

  // Send daily summary via Telegram
  await sendDailySummary(result);

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

  // Run the synthesizer (feedback ingestion + instruction updates)
  const { runSynthesis } = await import('./synthesizer/run.js');
  const synthesisResult = await runSynthesis();

  logger.info(`Synthesis complete: ${synthesisResult.patternsFound} patterns, ${synthesisResult.instructionsUpdated} updates`);

  await logActivity({
    timestamp: new Date().toISOString(),
    agent: 'orchestrator',
    action: 'weekly-synthesis-complete',
    details: `${synthesisResult.patternsFound} patterns, ${synthesisResult.instructionsUpdated} updates`,
    success: true,
  });

  logger.info('=== Weekly synthesis complete ===');
}

async function startDashboard(): Promise<void> {
  logger.info('Starting dashboard server...');
  const { startDashboardServer } = await import('./dashboard/server.js');
  await startDashboardServer();
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

    // Stop the Telegram bot
    stopBot()
      .then(() => {
        return logActivity({
          timestamp: new Date().toISOString(),
          agent: 'orchestrator',
          action: `shutdown-${signal.toLowerCase()}`,
          success: true,
        });
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function startTelegramBot(): Promise<void> {
  try {
    await startBot();
    logger.info('Telegram bot is running');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to start Telegram bot: ${message}`);
    // Don't crash — the bot is optional
  }
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

  registerAllAgents();
  setupGracefulShutdown();

  switch (mode) {
    case 'daily':
      await startTelegramBot();
      await runDailyPipeline();
      await stopBot();
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
      logger.info('Starting in default mode: dashboard + cron schedules + Telegram bot');
      await startTelegramBot();
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
