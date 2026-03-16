import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import type { Product } from '../types/index.js';

// ── Types ───────────────────────────────────────────────────────────

export type SequenceStepType =
  | 'thank-you'
  | 'check-in'
  | 'review-request'
  | 'cross-sell';

export type StepStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface SequenceStep {
  type: SequenceStepType;
  status: StepStatus;
  scheduledAt: string;
  sentAt?: string;
  error?: string;
  messageContent?: string;
}

export interface PostPurchaseSequence {
  sequenceId: string;
  buyerId: string;
  orderId: string;
  productId: string;
  productTitle: string;
  niche: string;
  steps: SequenceStep[];
  createdAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface PostPurchaseConfig {
  thankYouDelayMinutes: number;
  checkInDelayDays: number;
  reviewRequestDelayDays: number;
  crossSellDelayDays: number;
}

export interface EtsyOrder {
  orderId: string;
  buyerId: string;
  productId: string;
  productTitle: string;
  niche: string;
  buyerName: string;
  purchasedAt: string;
}

export interface EtsyMessage {
  recipientId: string;
  subject: string;
  body: string;
}

export interface RelatedProduct {
  productId: string;
  title: string;
  price: number;
  etsyUrl: string;
  niche: string;
}

// ── Errors ──────────────────────────────────────────────────────────

export class PostPurchaseError extends Error {
  public readonly sequenceId: string;

  constructor(sequenceId: string, message: string) {
    super(`Post-purchase error for sequence ${sequenceId}: ${message}`);
    this.name = 'PostPurchaseError';
    this.sequenceId = sequenceId;
  }
}

export class EtsyMessageError extends Error {
  public readonly recipientId: string;
  public readonly statusCode: number;

  constructor(recipientId: string, statusCode: number, message: string) {
    super(
      `Etsy message error for recipient ${recipientId} ` +
        `(${statusCode}): ${message}`
    );
    this.name = 'EtsyMessageError';
    this.recipientId = recipientId;
    this.statusCode = statusCode;
  }
}

// ── Constants ───────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/post-purchase');
const PRODUCTS_DIR = resolve(process.cwd(), 'state/products');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');

const DEFAULT_CONFIG: PostPurchaseConfig = {
  thankYouDelayMinutes: 0,
  checkInDelayDays: 3,
  reviewRequestDelayDays: 7,
  crossSellDelayDays: 14,
};

const BASE_URL = 'https://api.etsy.com/v3';

// ── PostPurchaseEngine ──────────────────────────────────────────────

export class PostPurchaseEngine {
  private readonly config: PostPurchaseConfig;
  private readonly shopId: string;

  constructor(config?: Partial<PostPurchaseConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shopId = getEnvOrThrow('ETSY_SHOP_ID');
  }

  async initializeSequence(order: EtsyOrder): Promise<PostPurchaseSequence> {
    logger.info(
      `Initializing post-purchase sequence for order ${order.orderId}`
    );

    const now = new Date();
    const sequenceId = `pp-${order.orderId}`;

    const steps: SequenceStep[] = [
      {
        type: 'thank-you',
        status: 'pending',
        scheduledAt: addMinutes(
          now,
          this.config.thankYouDelayMinutes
        ).toISOString(),
      },
      {
        type: 'check-in',
        status: 'pending',
        scheduledAt: addDays(
          now,
          this.config.checkInDelayDays
        ).toISOString(),
      },
      {
        type: 'review-request',
        status: 'pending',
        scheduledAt: addDays(
          now,
          this.config.reviewRequestDelayDays
        ).toISOString(),
      },
      {
        type: 'cross-sell',
        status: 'pending',
        scheduledAt: addDays(
          now,
          this.config.crossSellDelayDays
        ).toISOString(),
      },
    ];

    const sequence: PostPurchaseSequence = {
      sequenceId,
      buyerId: order.buyerId,
      orderId: order.orderId,
      productId: order.productId,
      productTitle: order.productTitle,
      niche: order.niche,
      steps,
      createdAt: now.toISOString(),
    };

    await this.saveSequence(sequence);

    logger.info(
      `Post-purchase sequence ${sequenceId} created with ${steps.length} steps`
    );

    return sequence;
  }

  async processQueue(): Promise<ProcessQueueResult> {
    logger.info('Processing post-purchase queue');

    const sequences = await this.loadAllSequences();
    const now = new Date();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const sequence of sequences) {
      if (sequence.completedAt || sequence.cancelledAt) {
        continue;
      }

      let modified = false;

      for (let i = 0; i < sequence.steps.length; i++) {
        const step = sequence.steps[i];

        if (step.status !== 'pending') {
          continue;
        }

        const scheduledAt = new Date(step.scheduledAt);
        if (scheduledAt > now) {
          skipped++;
          continue;
        }

        try {
          await this.sendMessage(sequence, step);
          this.markStepComplete(sequence, i);
          sent++;
          modified = true;
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          step.status = 'failed';
          step.error = message;
          failed++;
          modified = true;

          logger.error(
            `Failed to send ${step.type} for sequence ` +
              `${sequence.sequenceId}: ${message}`
          );
        }
      }

      // Check if all steps are done
      const allDone = sequence.steps.every(
        (s) => s.status === 'sent' || s.status === 'failed' || s.status === 'cancelled'
      );
      if (allDone) {
        sequence.completedAt = now.toISOString();
        modified = true;
        logger.info(`Sequence ${sequence.sequenceId} completed`);
      }

      if (modified) {
        await this.saveSequence(sequence);
      }
    }

    const result: ProcessQueueResult = { sent, failed, skipped };

    logger.info(
      `Post-purchase queue processed: ${sent} sent, ` +
        `${failed} failed, ${skipped} not yet due`
    );

    return result;
  }

  async sendMessage(
    sequence: PostPurchaseSequence,
    step: SequenceStep
  ): Promise<void> {
    logger.info(
      `Sending ${step.type} message for sequence ${sequence.sequenceId}`
    );

    let messageBody: string;

    switch (step.type) {
      case 'thank-you':
        messageBody = this.generateThankYouMessage(
          sequence.productTitle,
          sequence.niche
        );
        break;
      case 'check-in':
        messageBody = this.generateCheckInMessage(
          sequence.productTitle,
          sequence.niche
        );
        break;
      case 'review-request':
        messageBody = this.generateReviewRequest(
          sequence.productTitle,
          sequence.niche
        );
        break;
      case 'cross-sell': {
        const related = await this.findRelatedProducts(
          sequence.productId,
          sequence.niche
        );
        messageBody = this.generateCrossSell(
          sequence.productTitle,
          related
        );
        break;
      }
      default: {
        const exhaustive: never = step.type;
        throw new PostPurchaseError(
          sequence.sequenceId,
          `Unknown step type: ${exhaustive as string}`
        );
      }
    }

    step.messageContent = messageBody;

    const etsyMessage: EtsyMessage = {
      recipientId: sequence.buyerId,
      subject: this.getSubjectForStep(step.type, sequence.productTitle),
      body: messageBody,
    };

    await this.sendEtsyMessage(etsyMessage);

    logger.info(
      `${step.type} message sent for sequence ${sequence.sequenceId}`
    );
  }

  generateThankYouMessage(productTitle: string, niche: string): string {
    const usageTips = this.getUsageTips(niche);

    return [
      `Thank you so much for purchasing "${productTitle}"! ` +
        `I'm thrilled you chose it and I hope it serves you well.`,
      '',
      'Here are a few tips to get the most out of your download:',
      '',
      ...usageTips.map((tip, i) => `${i + 1}. ${tip}`),
      '',
      'If you have any questions at all, don\'t hesitate to reach out. ' +
        'I\'m always happy to help!',
      '',
      'Warm regards',
    ].join('\n');
  }

  generateCheckInMessage(productTitle: string, niche: string): string {
    const checkInPrompt = this.getCheckInPrompt(niche);

    return [
      `Hi there! I wanted to check in and see how you're enjoying ` +
        `"${productTitle}".`,
      '',
      checkInPrompt,
      '',
      'If anything isn\'t working as expected or you need help with the ' +
        'file, just let me know. I want to make sure you\'re getting the ' +
        'most out of your purchase.',
      '',
      'Best wishes',
    ].join('\n');
  }

  generateReviewRequest(productTitle: string, niche: string): string {
    const specificPrompt = this.getReviewPrompt(niche);

    return [
      `Hi! I hope you've been enjoying "${productTitle}" over the ` +
        'past week.',
      '',
      'If you have a moment, I\'d love to hear your thoughts in a ' +
        'quick review. It really helps other shoppers find products ' +
        'that work for them.',
      '',
      'A few things you might mention:',
      specificPrompt,
      '',
      'Of course, only if you\'re happy with it! And if there\'s ' +
        'anything I can improve, I\'d rather hear from you directly ' +
        'so I can make it right.',
      '',
      'Thank you so much!',
    ].join('\n');
  }

  generateCrossSell(
    productTitle: string,
    relatedProducts: RelatedProduct[]
  ): string {
    if (relatedProducts.length === 0) {
      return [
        `Hi! Since you enjoyed "${productTitle}", I wanted to let ` +
          'you know I\'m always creating new designs.',
        '',
        'Feel free to check out my shop for the latest additions. ' +
          'I\'d love for you to find something else you love!',
        '',
        'Thanks again for your support!',
      ].join('\n');
    }

    const productLines = relatedProducts
      .slice(0, 3)
      .map(
        (p) =>
          `- ${p.title} ($${p.price.toFixed(2)}) — ${p.etsyUrl}`
      );

    return [
      `Hi! Since you purchased "${productTitle}", I thought you ` +
        'might like these related items from my shop:',
      '',
      ...productLines,
      '',
      'Each one is designed with the same attention to detail ' +
        'you\'ll recognize from your purchase.',
      '',
      'Thanks for being a wonderful customer!',
    ].join('\n');
  }

  async findRelatedProducts(
    productId: string,
    niche: string
  ): Promise<RelatedProduct[]> {
    logger.debug(
      `Finding related products for ${productId} in niche "${niche}"`
    );

    const related: RelatedProduct[] = [];

    let listingFiles: string[];
    try {
      listingFiles = await readdir(LISTINGS_DIR);
    } catch {
      logger.debug('No listings directory found');
      return related;
    }

    for (const file of listingFiles) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const filePath = join(LISTINGS_DIR, file);
        const raw = await readFile(filePath, 'utf-8');
        const listing = JSON.parse(raw) as ListingMetadata;

        // Skip the same product
        if (listing.productId === productId) {
          continue;
        }

        // Match by niche
        if (
          listing.niche &&
          listing.niche.toLowerCase() === niche.toLowerCase()
        ) {
          related.push({
            productId: listing.productId,
            title: listing.title,
            price: listing.price,
            etsyUrl: listing.etsyUrl,
            niche: listing.niche,
          });
        }
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    logger.debug(
      `Found ${related.length} related products for niche "${niche}"`
    );

    return related;
  }

  markStepComplete(
    sequence: PostPurchaseSequence,
    stepIndex: number
  ): void {
    const step = sequence.steps[stepIndex];

    if (!step) {
      throw new PostPurchaseError(
        sequence.sequenceId,
        `Invalid step index: ${stepIndex}`
      );
    }

    step.status = 'sent';
    step.sentAt = new Date().toISOString();

    logger.debug(
      `Step ${stepIndex} (${step.type}) marked complete for ` +
        `sequence ${sequence.sequenceId}`
    );
  }

  async cancelSequence(sequenceId: string): Promise<void> {
    logger.info(`Cancelling sequence ${sequenceId}`);

    const sequence = await this.loadSequence(sequenceId);

    for (const step of sequence.steps) {
      if (step.status === 'pending') {
        step.status = 'cancelled';
      }
    }

    sequence.cancelledAt = new Date().toISOString();
    await this.saveSequence(sequence);

    logger.info(`Sequence ${sequenceId} cancelled`);
  }

  async getActiveSequences(): Promise<PostPurchaseSequence[]> {
    const all = await this.loadAllSequences();
    return all.filter((s) => !s.completedAt && !s.cancelledAt);
  }

  // ── Etsy Messaging ─────────────────────────────────────────────────

  private async sendEtsyMessage(message: EtsyMessage): Promise<void> {
    const apiKey = getEnvOrThrow('ETSY_API_KEY');
    const apiSecret = getEnvOrThrow('ETSY_API_SECRET');

    const oauth = new EtsyOAuth(
      apiKey,
      apiSecret,
      'http://localhost:3000/oauth/callback'
    );
    const accessToken = await oauth.getValidAccessToken();

    const url =
      `${BASE_URL}/application/shops/${this.shopId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to_user_id: message.recipientId,
        subject: message.subject,
        body: message.body,
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new EtsyMessageError(
        message.recipientId,
        response.status,
        responseBody
      );
    }

    logger.debug(
      `Etsy message sent to ${message.recipientId}: "${message.subject}"`
    );
  }

  // ── Message Helpers ────────────────────────────────────────────────

  private getSubjectForStep(
    stepType: SequenceStepType,
    productTitle: string
  ): string {
    const shortTitle =
      productTitle.length > 40
        ? productTitle.slice(0, 37) + '...'
        : productTitle;

    switch (stepType) {
      case 'thank-you':
        return `Thank you for your purchase of ${shortTitle}!`;
      case 'check-in':
        return `How are you enjoying ${shortTitle}?`;
      case 'review-request':
        return `Quick question about ${shortTitle}`;
      case 'cross-sell':
        return 'You might also like these...';
      default: {
        const exhaustive: never = stepType;
        return `Message about ${exhaustive as string}`;
      }
    }
  }

  private getUsageTips(niche: string): string[] {
    const nicheKey = niche.toLowerCase();

    if (nicheKey.includes('planner')) {
      return [
        'Print on US Letter or A4 paper for the best results.',
        'Consider using a heavier paper weight (24-32 lb) ' +
          'for a more premium feel.',
        'Use a 3-hole punch to add pages to a binder, ' +
          'or bind with a spiral binding for easy flipping.',
        'Print only the sections you need — ' +
          'you can always reprint individual pages.',
      ];
    }

    if (nicheKey.includes('journal')) {
      return [
        'Print single-sided for writing comfort, ' +
          'or double-sided to save paper.',
        'Leave the cover page blank on the back for a clean look.',
        'Consider laminating the cover for durability.',
        'Set aside a consistent time each day for the best habit-building.',
      ];
    }

    if (nicheKey.includes('tracker')) {
      return [
        'Print fresh copies whenever you need a reset — ' +
          'the file is yours forever.',
        'Try placing it somewhere visible as a daily reminder.',
        'Use colored pens or highlighters to make tracking more fun.',
        'Start with just one metric to build consistency ' +
          'before adding more.',
      ];
    }

    if (nicheKey.includes('worksheet') || nicheKey.includes('template')) {
      return [
        'Print as many copies as you need — the file is unlimited use.',
        'Consider printing on cardstock for a sturdier feel.',
        'Fill it out digitally using a PDF annotation app ' +
          'if you prefer not to print.',
        'Keep a completed copy as a reference for future use.',
      ];
    }

    // Generic tips
    return [
      'Print on high-quality paper for the best experience.',
      'You can reprint as many times as you like — ' +
        'the file is yours to keep.',
      'If you prefer digital use, try annotating the PDF ' +
        'on a tablet or computer.',
      'Don\'t hesitate to reach out if you need a different format.',
    ];
  }

  private getCheckInPrompt(niche: string): string {
    const nicheKey = niche.toLowerCase();

    if (nicheKey.includes('planner')) {
      return (
        'Have you had a chance to start planning with it? ' +
        'I\'d love to know if the layout is working well for ' +
        'your routine.'
      );
    }

    if (nicheKey.includes('journal')) {
      return (
        'Have you had a chance to start writing in it? ' +
        'I hope the prompts and layout feel natural for ' +
        'your journaling style.'
      );
    }

    if (nicheKey.includes('tracker')) {
      return (
        'Have you started tracking yet? Even a few days of data ' +
        'can be really motivating to look back on.'
      );
    }

    return (
      'Have you had a chance to use it yet? I\'d love to hear ' +
      'how it\'s fitting into your workflow.'
    );
  }

  private getReviewPrompt(niche: string): string {
    const nicheKey = niche.toLowerCase();

    if (nicheKey.includes('planner')) {
      return [
        '- How the layout works for your daily/weekly planning',
        '- Whether the sections cover what you need',
        '- How the print quality turned out',
      ].join('\n');
    }

    if (nicheKey.includes('journal')) {
      return [
        '- Whether the prompts helped your journaling practice',
        '- How the design feels when you\'re writing',
        '- If the page count is right for your needs',
      ].join('\n');
    }

    if (nicheKey.includes('tracker')) {
      return [
        '- Whether the tracker helped you stay consistent',
        '- How easy it was to fill in each day',
        '- If the format works for your tracking goals',
      ].join('\n');
    }

    return [
      '- How the design and layout worked for you',
      '- Whether it met your expectations',
      '- How the print quality turned out',
    ].join('\n');
  }

  // ── State Persistence ──────────────────────────────────────────────

  private getSequencePath(sequenceId: string): string {
    // Extract orderId from sequenceId (format: pp-{orderId})
    const orderId = sequenceId.startsWith('pp-')
      ? sequenceId.slice(3)
      : sequenceId;
    return join(STATE_DIR, `${orderId}.json`);
  }

  private async saveSequence(
    sequence: PostPurchaseSequence
  ): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true });
    const filePath = this.getSequencePath(sequence.sequenceId);
    await writeFile(
      filePath,
      JSON.stringify(sequence, null, 2),
      'utf-8'
    );
    logger.debug(`Saved sequence ${sequence.sequenceId}`);
  }

  private async loadSequence(
    sequenceId: string
  ): Promise<PostPurchaseSequence> {
    const filePath = this.getSequencePath(sequenceId);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new PostPurchaseError(
        sequenceId,
        `Sequence file not found: ${filePath}`
      );
    }

    return JSON.parse(raw) as PostPurchaseSequence;
  }

  private async loadAllSequences(): Promise<PostPurchaseSequence[]> {
    let files: string[];
    try {
      files = await readdir(STATE_DIR);
    } catch {
      logger.debug('No post-purchase state directory found');
      return [];
    }

    const sequences: PostPurchaseSequence[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(STATE_DIR, file), 'utf-8');
        sequences.push(JSON.parse(raw) as PostPurchaseSequence);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to load sequence from ${file}: ${message}`);
      }
    }

    return sequences;
  }
}

// ── Internal Types ──────────────────────────────────────────────────

interface ListingMetadata {
  listingId: number;
  etsyUrl: string;
  title: string;
  price: number;
  productId: string;
  niche: string;
}

interface ProcessQueueResult {
  sent: number;
  failed: number;
  skipped: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function addMinutes(date: Date, minutes: number): Date {
  const result = new Date(date.getTime());
  result.setMinutes(result.getMinutes() + minutes);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}
