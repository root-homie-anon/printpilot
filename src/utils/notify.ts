import { Telegraf } from 'telegraf';
import { getEnv } from './env.js';
import logger from './logger.js';
import type {
  PipelineResult,
  SynthesisResult,
  ListingData,
} from '../types/index.js';

let bot: Telegraf | null = null;

function getBot(): Telegraf {
  if (!bot) {
    const token = getEnv('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set');
    }
    bot = new Telegraf(token);
  }
  return bot;
}

function getChatId(): string {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID is not set');
  }
  return chatId;
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function fallbackNotify(message: string): Promise<void> {
  // Write critical notifications to a file when Telegram is down
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const alertDir = resolve(process.cwd(), 'state', 'alerts');
  await mkdir(alertDir, { recursive: true });
  const alertFile = resolve(alertDir, `alerts-${new Date().toISOString().slice(0, 10)}.log`);
  const line = `[${new Date().toISOString()}] ${message.replace(/<[^>]+>/g, '')}\n`;
  await appendFile(alertFile, line, 'utf-8');
  logger.warn('Notification written to fallback file', { file: alertFile });
}

export async function sendNotification(message: string): Promise<void> {
  try {
    const telegram = getBot();
    const chatId = getChatId();
    await telegram.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    logger.info('Notification sent', { channel: 'telegram', length: message.length });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send Telegram notification', { error: errMsg });
    // Fallback: write to alert file so nothing is lost
    await fallbackNotify(message).catch(() => { /* last resort */ });
  }
}

export async function sendMarkdownV2(message: string): Promise<void> {
  try {
    const telegram = getBot();
    const chatId = getChatId();
    await telegram.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
    logger.info('MarkdownV2 notification sent', { channel: 'telegram', length: message.length });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send MarkdownV2 notification', { error: errMsg });
    await fallbackNotify(message).catch(() => { /* last resort */ });
  }
}

export async function sendPipelineError(
  stage: string,
  error: string,
  productId?: string,
): Promise<void> {
  try {
    const ts = escapeMarkdownV2(timestamp());
    const escapedStage = escapeMarkdownV2(stage);
    const escapedError = escapeMarkdownV2(error);

    const lines = [
      `*Pipeline Error*`,
      ``,
      `*Stage:* ${escapedStage}`,
    ];

    if (productId) {
      lines.push(`*Product ID:* \`${escapeMarkdownV2(productId)}\``);
    }

    lines.push(
      `*Error:* ${escapedError}`,
      ``,
      `Check logs for details\\.`,
      `${ts}`,
    );

    await sendMarkdownV2(lines.join('\n'));
    logger.info('Pipeline error notification sent', { stage, productId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send pipeline error notification', { error: errMsg });
  }
}

export async function sendDailySummary(results: PipelineResult): Promise<void> {
  try {
    const ts = escapeMarkdownV2(timestamp());
    const errorSection = results.errors.length > 0
      ? results.errors.map((e) => `  \\- ${escapeMarkdownV2(e)}`).join('\n')
      : '  None';

    const message = [
      `*Daily Pipeline Summary*`,
      ``,
      `*Products Processed:* ${results.productsProcessed}`,
      `*Approved:* ${results.approved}`,
      `*Listed:* ${results.listed}`,
      `*Errors:* ${results.errors.length}`,
      ``,
      `*Error Details:*`,
      errorSection,
      ``,
      `${ts}`,
    ].join('\n');

    await sendMarkdownV2(message);
    logger.info('Daily summary sent via Telegram');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send daily summary', { error: errMsg });
  }
}

export async function sendWeeklySummary(synthesisResult: SynthesisResult): Promise<void> {
  try {
    const ts = escapeMarkdownV2(timestamp());
    const agentsList = synthesisResult.agentsAffected.length > 0
      ? synthesisResult.agentsAffected.map((a) => `  \\- ${escapeMarkdownV2(a)}`).join('\n')
      : '  None';

    const message = [
      `*Weekly Synthesis Summary*`,
      ``,
      `*Instructions Updated:* ${synthesisResult.instructionsUpdated}`,
      `*Patterns Found:* ${synthesisResult.patternsFound}`,
      `*Agents Affected:*`,
      agentsList,
      ``,
      `${ts}`,
    ].join('\n');

    await sendMarkdownV2(message);
    logger.info('Weekly summary sent via Telegram');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send weekly summary', { error: errMsg });
  }
}

export async function sendListingLive(listingData: ListingData): Promise<void> {
  try {
    const ts = escapeMarkdownV2(timestamp());
    const escapedTitle = escapeMarkdownV2(listingData.title);
    const escapedUrl = escapeMarkdownV2(listingData.etsyUrl);
    const escapedId = escapeMarkdownV2(listingData.listingId);

    const message = [
      `*Listing Published\\!*`,
      ``,
      `*Title:* ${escapedTitle}`,
      `*Listing ID:* \`${escapedId}\``,
      `*Price:* \\$${escapeMarkdownV2(listingData.price.toFixed(2))}`,
      `*Tags:* ${escapeMarkdownV2(listingData.tags.join(', '))}`,
      ``,
      `[View on Etsy](${escapedUrl})`,
      ``,
      `${ts}`,
    ].join('\n');

    await sendMarkdownV2(message);
    logger.info('Listing live notification sent', { listingId: listingData.listingId });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send listing live notification', { error: errMsg });
  }
}

export async function sendMarketingUpdate(
  channel: string,
  productId: string,
  status: string,
): Promise<void> {
  try {
    const ts = escapeMarkdownV2(timestamp());
    const escapedChannel = escapeMarkdownV2(channel);
    const escapedId = escapeMarkdownV2(productId);
    const escapedStatus = escapeMarkdownV2(status);

    const message = [
      `*Marketing Update*`,
      ``,
      `*Channel:* ${escapedChannel}`,
      `*Product ID:* \`${escapedId}\``,
      `*Status:* ${escapedStatus}`,
      ``,
      `${ts}`,
    ].join('\n');

    await sendMarkdownV2(message);
    logger.info('Marketing update sent via Telegram', { channel, productId, status });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send marketing update', { error: errMsg });
  }
}

export default sendNotification;
