import { Telegraf } from 'telegraf';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getEnv } from '../utils/env.js';
import logger from '../utils/logger.js';
import { submitApproval, checkApproval } from '../pipeline/approval-gate.js';
import type {
  FeedbackDecision,
  ProductBrief,
  ListingData,
} from '../types/index.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = resolve(STATE_DIR, 'products');
const LISTINGS_DIR = resolve(STATE_DIR, 'listings');

let botInstance: Telegraf | null = null;

interface PendingReply {
  productId: string;
  action: 'reject' | 'revise';
}

const pendingReplies = new Map<number, PendingReply>();

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath)) {
      return [];
    }
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath)) {
      return [];
    }
    const entries = await readdir(dirPath);
    return entries.filter((e) => e.endsWith('.json'));
  } catch {
    return [];
  }
}

export async function startBot(): Promise<void> {
  const token = getEnv('TELEGRAM_BOT_TOKEN');
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set, Telegram bot will not start');
    return;
  }

  botInstance = new Telegraf(token);
  const bot = botInstance;

  // Handle inline keyboard callback queries (Approve/Reject/Revise buttons)
  bot.on('callback_query', async (ctx) => {
    try {
      const callbackQuery = ctx.callbackQuery;
      if (!('data' in callbackQuery) || !callbackQuery.data) {
        await ctx.answerCbQuery('Invalid callback');
        return;
      }

      const data = callbackQuery.data;
      const parts = data.split('_');
      const action = parts[0] as string;
      const productId = parts.slice(1).join('_');

      if (!productId) {
        await ctx.answerCbQuery('Invalid product ID');
        return;
      }

      const decisionMap: Record<string, FeedbackDecision> = {
        approve: 'approve',
        reject: 'reject',
        revise: 'revise',
      };

      const decision = decisionMap[action];
      if (!decision) {
        await ctx.answerCbQuery('Unknown action');
        return;
      }

      if (decision === 'approve') {
        await submitApproval(productId, 'approve');
        await ctx.answerCbQuery('Product approved!');
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply(
          `Product \`${productId}\` has been *approved* and will proceed to listing\\.`,
          { parse_mode: 'MarkdownV2' },
        );
        logger.info('Product approved via Telegram', { productId });
      } else {
        // For reject/revise, ask for feedback
        const chatId = callbackQuery.from.id;
        pendingReplies.set(chatId, { productId, action: decision });
        await ctx.answerCbQuery(`Please reply with your ${decision} reason`);
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply(
          `Please reply with your reason for *${decision === 'reject' ? 'rejecting' : 'requesting revision of'}* product \`${productId}\`:`,
          { parse_mode: 'MarkdownV2' },
        );
        logger.info(`Awaiting ${decision} feedback via Telegram`, { productId });
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error handling callback query', { error: errMsg });
      try {
        await ctx.answerCbQuery('An error occurred. Check logs.');
      } catch {
        // Ignore answer callback errors
      }
    }
  });

  // Handle text messages (for reject/revise feedback replies)
  bot.on('text', async (ctx) => {
    try {
      const chatId = ctx.from.id;
      const pending = pendingReplies.get(chatId);

      if (!pending) {
        // Not a feedback reply, ignore
        return;
      }

      const feedback = ctx.message.text;
      const { productId, action } = pending;

      await submitApproval(productId, action, {
        id: `feedback-${productId}-${Date.now()}`,
        productId,
        layout: 0,
        typography: 0,
        color: 0,
        differentiation: 0,
        sellability: 0,
        issues: feedback,
        source: 'design',
        decision: action,
        createdAt: new Date().toISOString(),
      });

      pendingReplies.delete(chatId);

      const actionLabel = action === 'reject' ? 'rejected' : 'sent for revision';
      await ctx.reply(
        `Product \`${productId}\` has been *${actionLabel}*\\.\n\nFeedback: ${feedback.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')}`,
        { parse_mode: 'MarkdownV2' },
      );
      logger.info(`Product ${action}ed via Telegram with feedback`, { productId });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error handling text message', { error: errMsg });
    }
  });

  // /status command — current pipeline status
  bot.command('status', async (ctx) => {
    try {
      const productIds = await listDirectories(PRODUCTS_DIR);
      const stages: Record<string, number> = {
        brief: 0,
        design: 0,
        copy: 0,
        score: 0,
        pending: 0,
        approved: 0,
        listed: 0,
      };

      for (const id of productIds) {
        const productDir = resolve(PRODUCTS_DIR, id);
        if (existsSync(join(productDir, 'listing.json'))) {
          stages['listed']++;
        } else if (existsSync(join(productDir, 'approval.json'))) {
          const approvalRaw = await readFile(join(productDir, 'approval.json'), 'utf-8');
          const approval = JSON.parse(approvalRaw) as { status: string };
          if (approval.status === 'approved') {
            stages['approved']++;
          } else {
            stages['pending']++;
          }
        } else if (existsSync(join(productDir, 'score.json'))) {
          stages['score']++;
        } else if (existsSync(join(productDir, 'copy.json'))) {
          stages['copy']++;
        } else if (existsSync(join(productDir, 'design.json'))) {
          stages['design']++;
        } else if (existsSync(join(productDir, 'brief.json'))) {
          stages['brief']++;
        }
      }

      const lines = [
        '*Pipeline Status*',
        '',
        `Brief: ${stages['brief']}`,
        `Design: ${stages['design']}`,
        `Copy: ${stages['copy']}`,
        `Scoring: ${stages['score']}`,
        `Pending Approval: ${stages['pending']}`,
        `Approved: ${stages['approved']}`,
        `Listed: ${stages['listed']}`,
        '',
        `Total Products: ${productIds.length}`,
      ];

      await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error handling /status command', { error: errMsg });
      await ctx.reply('Failed to load pipeline status. Check logs.');
    }
  });

  // /pending command — list products awaiting approval
  bot.command('pending', async (ctx) => {
    try {
      const productIds = await listDirectories(PRODUCTS_DIR);
      const pendingProducts: string[] = [];

      for (const id of productIds) {
        const status = await checkApproval(id);
        if (status === 'pending') {
          pendingProducts.push(id);
        }
      }

      if (pendingProducts.length === 0) {
        await ctx.reply('No products pending approval\\.');
        return;
      }

      const lines = [
        `*Pending Approvals \\(${pendingProducts.length}\\)*`,
        '',
        ...pendingProducts.map((id) => {
          const escapedId = id.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
          return `\\- \`${escapedId}\``;
        }),
      ];

      await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error handling /pending command', { error: errMsg });
      await ctx.reply('Failed to load pending approvals. Check logs.');
    }
  });

  // /metrics command — quick revenue/listing summary
  bot.command('metrics', async (ctx) => {
    try {
      const listingFiles = await listJsonFiles(LISTINGS_DIR);
      let totalListings = 0;
      let activeListings = 0;
      let totalRevenue = 0;

      for (const file of listingFiles) {
        if (file.endsWith('-health.json')) continue;
        const listing = await readJsonFile<ListingData>(join(LISTINGS_DIR, file));
        if (listing) {
          totalListings++;
          if (listing.status === 'active') {
            activeListings++;
            totalRevenue += listing.price;
          }
        }
      }

      const productIds = await listDirectories(PRODUCTS_DIR);

      const lines = [
        '*Quick Metrics*',
        '',
        `Total Products: ${productIds.length}`,
        `Total Listings: ${totalListings}`,
        `Active Listings: ${activeListings}`,
        `Estimated Revenue: \\$${totalRevenue.toFixed(2).replace('.', '\\.')}`,
      ];

      await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error handling /metrics command', { error: errMsg });
      await ctx.reply('Failed to load metrics. Check logs.');
    }
  });

  // Error handling
  bot.catch((err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Telegram bot error', { error: errMsg });
  });

  // Launch in long-polling mode
  await bot.launch();
  logger.info('Telegram bot started in long-polling mode');
}

export async function stopBot(): Promise<void> {
  if (botInstance) {
    botInstance.stop('Graceful shutdown');
    botInstance = null;
    logger.info('Telegram bot stopped');
  }
}
