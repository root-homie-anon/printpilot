import { Telegraf } from 'telegraf';
import { getEnv } from './env.js';
import logger from './logger.js';

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

export async function sendNotification(message: string): Promise<void> {
  try {
    const telegram = getBot();
    const chatId = getChatId();
    await telegram.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    logger.info('Notification sent', { channel: 'telegram', length: message.length });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to send notification', { error: errMsg });
    throw error;
  }
}

export async function sendApprovalNotification(
  productId: string,
  title: string,
  dashboardUrl: string,
): Promise<void> {
  const message = [
    '<b>New Product Ready for Review</b>',
    '',
    `<b>Product:</b> ${title}`,
    `<b>ID:</b> <code>${productId}</code>`,
    '',
    `<a href="${dashboardUrl}">Review Dashboard</a>`,
    '',
    'Reply with your scores to approve or reject.',
  ].join('\n');

  await sendNotification(message);
}

export async function sendErrorNotification(agent: string, error: string): Promise<void> {
  const message = [
    '<b>Pipeline Error</b>',
    '',
    `<b>Agent:</b> @${agent}`,
    `<b>Error:</b> ${error}`,
    '',
    'Check logs for details.',
  ].join('\n');

  await sendNotification(message);
}

export default sendNotification;
