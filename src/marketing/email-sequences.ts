import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';
import { getEnvOrThrow } from '../utils/env.js';
import { EmailClient } from './email.js';
import type { EmailProvider, CampaignData, CampaignStats } from './email.js';
import type { Product } from '../types/index.js';

// ── Types ───────────────────────────────────────────────────────────

export type SequenceType = 'welcome' | 'digest' | 'abandonment' | 'niche-update';

export type EmailStepStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export type SequenceStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface EmailStep {
  index: number;
  subject: string;
  bodyTemplate: string;
  delayDays: number;
  status: EmailStepStatus;
  sentAt?: string;
  campaignId?: string;
  error?: string;
}

export interface EmailSequence {
  id: string;
  type: SequenceType;
  subscriberId: string;
  steps: EmailStep[];
  status: SequenceStatus;
  startedAt: string;
  completedAt?: string;
  pausedAt?: string;
  metadata?: Record<string, string>;
}

export interface SubscriberSegment {
  id: string;
  name: string;
  niches: string[];
  subscriberIds: string[];
  criteria: SegmentCriteria;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentCriteria {
  minPurchases?: number;
  nicheInterests?: string[];
  lastActiveWithinDays?: number;
  hasAbandoned?: boolean;
}

export interface DigestConfig {
  dayOfWeek: number;
  maxProducts: number;
  includeTopSellers: boolean;
}

export interface SubscriberProfile {
  id: string;
  email: string;
  name: string;
  niches: string[];
  purchaseHistory: string[];
  browseHistory: string[];
  subscribedAt: string;
}

export interface SequenceMetrics {
  sequenceId: string;
  totalSteps: number;
  stepsSent: number;
  stepsFailed: number;
  stepsPending: number;
  openRate: number;
  clickRate: number;
  conversionRate: number;
}

export interface ProcessSequencesResult {
  sent: number;
  failed: number;
  skipped: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export class EmailSequenceError extends Error {
  public readonly sequenceId: string;

  constructor(sequenceId: string, message: string) {
    super(`Email sequence error for ${sequenceId}: ${message}`);
    this.name = 'EmailSequenceError';
    this.sequenceId = sequenceId;
  }
}

export class SegmentError extends Error {
  public readonly segmentId: string;

  constructor(segmentId: string, message: string) {
    super(`Segment error for ${segmentId}: ${message}`);
    this.name = 'SegmentError';
    this.segmentId = segmentId;
  }
}

// ── Constants ───────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/email-sequences');
const SEGMENTS_DIR = resolve(STATE_DIR, 'segments');
const PRODUCTS_DIR = resolve(process.cwd(), 'state/products');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');

const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  dayOfWeek: 1, // Monday
  maxProducts: 5,
  includeTopSellers: true,
};

// ── Welcome Series Templates ────────────────────────────────────────

const WELCOME_STEPS: Omit<EmailStep, 'status'>[] = [
  {
    index: 0,
    subject: 'Welcome to PrintPilot! Here\'s your free sample',
    bodyTemplate: 'welcome-free-sample',
    delayDays: 0,
  },
  {
    index: 1,
    subject: 'Here\'s what we create (and why you\'ll love it)',
    bodyTemplate: 'welcome-showcase',
    delayDays: 2,
  },
  {
    index: 2,
    subject: 'Our top sellers — picked just for you',
    bodyTemplate: 'welcome-top-sellers',
    delayDays: 4,
  },
  {
    index: 3,
    subject: 'A special welcome gift — just for you',
    bodyTemplate: 'welcome-discount',
    delayDays: 7,
  },
  {
    index: 4,
    subject: 'Complete your collection with these picks',
    bodyTemplate: 'welcome-recommendations',
    delayDays: 14,
  },
];

// ── Abandonment Series Templates ────────────────────────────────────

const ABANDONMENT_STEPS: Omit<EmailStep, 'status' | 'delayDays'>[] = [
  {
    index: 0,
    subject: 'Still thinking about it?',
    bodyTemplate: 'abandonment-reminder',
  },
  {
    index: 1,
    subject: 'See why others love these products',
    bodyTemplate: 'abandonment-social-proof',
  },
  {
    index: 2,
    subject: 'A little something to help you decide',
    bodyTemplate: 'abandonment-discount',
  },
];

// Abandonment delays in fractional days (1 hour = 1/24 day)
const ABANDONMENT_DELAYS: number[] = [
  1 / 24, // 1 hour
  1,      // 1 day
  3,      // 3 days
];

// ── EmailSequenceEngine ─────────────────────────────────────────────

export class EmailSequenceEngine {
  private readonly emailClient: EmailClient;
  private readonly digestConfig: DigestConfig;
  private readonly listId: string;

  constructor(digestConfig?: Partial<DigestConfig>) {
    const provider = getEnvOrThrow('EMAIL_PROVIDER') as EmailProvider;
    const apiKey = getEnvOrThrow('EMAIL_API_KEY');
    this.listId = getEnvOrThrow('EMAIL_LIST_ID');

    this.emailClient = new EmailClient(provider, apiKey);
    this.digestConfig = { ...DEFAULT_DIGEST_CONFIG, ...digestConfig };
  }

  // ── Welcome Sequence ────────────────────────────────────────────────

  async startWelcomeSequence(subscriberId: string): Promise<EmailSequence> {
    logger.info(
      `Starting welcome sequence for subscriber ${subscriberId}`
    );

    const now = new Date();
    const sequenceId = `welcome-${subscriberId}-${now.getTime()}`;

    const steps: EmailStep[] = WELCOME_STEPS.map((template) => ({
      ...template,
      status: 'pending' as EmailStepStatus,
    }));

    const sequence: EmailSequence = {
      id: sequenceId,
      type: 'welcome',
      subscriberId,
      steps,
      status: 'active',
      startedAt: now.toISOString(),
    };

    await this.saveSequence(sequence);

    logger.info(
      `Welcome sequence ${sequenceId} created with ${steps.length} steps`
    );

    return sequence;
  }

  // ── Weekly Digest ───────────────────────────────────────────────────

  async sendWeeklyDigest(): Promise<EmailSequence[]> {
    logger.info('Generating weekly digest');

    const products = await this.loadRecentProducts();
    const segments = await this.loadAllSegments();
    const sequences: EmailSequence[] = [];

    if (products.length === 0) {
      logger.info('No new products this week, skipping digest');
      return sequences;
    }

    const limitedProducts = products.slice(0, this.digestConfig.maxProducts);

    if (segments.length === 0) {
      // Send to all subscribers as a single digest
      const sequence = await this.createDigestSequence(
        'all-subscribers',
        limitedProducts
      );
      sequences.push(sequence);
    } else {
      // Send segmented digests
      for (const segment of segments) {
        const nicheProducts = limitedProducts.filter((p) =>
          segment.niches.some(
            (n) => n.toLowerCase() === p.niche.toLowerCase()
          )
        );

        const productsToSend =
          nicheProducts.length > 0 ? nicheProducts : limitedProducts;

        for (const subscriberId of segment.subscriberIds) {
          const sequence = await this.createDigestSequence(
            subscriberId,
            productsToSend,
            segment.id
          );
          sequences.push(sequence);
        }
      }
    }

    logger.info(
      `Weekly digest created: ${sequences.length} sequences for ` +
        `${limitedProducts.length} products`
    );

    return sequences;
  }

  // ── Abandonment Sequence ────────────────────────────────────────────

  async startAbandonmentSequence(
    subscriberId: string,
    productIds: string[]
  ): Promise<EmailSequence> {
    logger.info(
      `Starting abandonment sequence for subscriber ${subscriberId} ` +
        `with ${productIds.length} products`
    );

    const now = new Date();
    const sequenceId = `abandonment-${subscriberId}-${now.getTime()}`;

    const steps: EmailStep[] = ABANDONMENT_STEPS.map((template, i) => ({
      ...template,
      delayDays: ABANDONMENT_DELAYS[i],
      status: 'pending' as EmailStepStatus,
    }));

    const sequence: EmailSequence = {
      id: sequenceId,
      type: 'abandonment',
      subscriberId,
      steps,
      status: 'active',
      startedAt: now.toISOString(),
      metadata: {
        productIds: productIds.join(','),
      },
    };

    await this.saveSequence(sequence);

    logger.info(
      `Abandonment sequence ${sequenceId} created with ${steps.length} steps`
    );

    return sequence;
  }

  // ── Niche Update ────────────────────────────────────────────────────

  async sendNicheUpdate(
    niche: string,
    products: Product[]
  ): Promise<EmailSequence[]> {
    logger.info(
      `Sending niche update for "${niche}" with ${products.length} products`
    );

    const segments = await this.loadAllSegments();
    const sequences: EmailSequence[] = [];

    // Find subscribers interested in this niche
    const interestedSubscribers = new Set<string>();
    for (const segment of segments) {
      if (
        segment.niches.some(
          (n) => n.toLowerCase() === niche.toLowerCase()
        )
      ) {
        for (const subId of segment.subscriberIds) {
          interestedSubscribers.add(subId);
        }
      }
    }

    if (interestedSubscribers.size === 0) {
      logger.info(
        `No subscribers interested in niche "${niche}", skipping update`
      );
      return sequences;
    }

    for (const subscriberId of interestedSubscribers) {
      const now = new Date();
      const sequenceId = `niche-${niche}-${subscriberId}-${now.getTime()}`;

      const step: EmailStep = {
        index: 0,
        subject: `New ${niche} designs just dropped!`,
        bodyTemplate: 'niche-update',
        delayDays: 0,
        status: 'pending',
      };

      const sequence: EmailSequence = {
        id: sequenceId,
        type: 'niche-update',
        subscriberId,
        steps: [step],
        status: 'active',
        startedAt: now.toISOString(),
        metadata: {
          niche,
          productIds: products.map((p) => p.id).join(','),
        },
      };

      await this.saveSequence(sequence);
      sequences.push(sequence);
    }

    logger.info(
      `Niche update for "${niche}": ${sequences.length} sequences created ` +
        `for ${interestedSubscribers.size} subscribers`
    );

    return sequences;
  }

  // ── Subscriber Segmentation ─────────────────────────────────────────

  async segmentSubscribers(): Promise<SubscriberSegment[]> {
    logger.info('Analyzing subscribers for segmentation');

    const profiles = await this.loadSubscriberProfiles();
    const nicheMap = new Map<string, string[]>();

    for (const profile of profiles) {
      for (const niche of profile.niches) {
        const normalized = niche.toLowerCase();
        const existing = nicheMap.get(normalized) ?? [];
        existing.push(profile.id);
        nicheMap.set(normalized, existing);
      }
    }

    const segments: SubscriberSegment[] = [];
    const now = new Date().toISOString();

    for (const [niche, subscriberIds] of nicheMap) {
      const segmentId = `segment-${niche.replace(/\s+/g, '-')}`;

      const segment: SubscriberSegment = {
        id: segmentId,
        name: `${capitalize(niche)} Enthusiasts`,
        niches: [niche],
        subscriberIds,
        criteria: {
          nicheInterests: [niche],
        },
        createdAt: now,
        updatedAt: now,
      };

      await this.saveSegment(segment);
      segments.push(segment);
    }

    logger.info(
      `Segmentation complete: ${segments.length} segments created ` +
        `from ${profiles.length} subscribers`
    );

    return segments;
  }

  // ── Process All Active Sequences ────────────────────────────────────

  async processAllSequences(): Promise<ProcessSequencesResult> {
    logger.info('Processing all active email sequences');

    const sequences = await this.loadAllSequences();
    const now = new Date();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const sequence of sequences) {
      if (sequence.status !== 'active') {
        continue;
      }

      let modified = false;
      const sequenceStart = new Date(sequence.startedAt);

      for (const step of sequence.steps) {
        if (step.status !== 'pending') {
          continue;
        }

        const dueAt = addFractionalDays(sequenceStart, step.delayDays);
        if (dueAt > now) {
          skipped++;
          continue;
        }

        try {
          const content = await this.generateEmailContent(
            step,
            sequence.subscriberId,
            await this.resolveProductsForSequence(sequence)
          );

          const campaignData: CampaignData = {
            subject: step.subject,
            htmlBody: content.html,
            textBody: content.text,
            listId: this.listId,
            tags: [sequence.type, `step-${step.index}`],
          };

          const result = await this.emailClient.sendCampaign(campaignData);

          step.status = 'sent';
          step.sentAt = now.toISOString();
          step.campaignId = result.campaignId;
          sent++;
          modified = true;

          logger.info(
            `Sent step ${step.index} of sequence ${sequence.id} ` +
              `(campaign ${result.campaignId})`
          );
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          step.status = 'failed';
          step.error = message;
          failed++;
          modified = true;

          logger.error(
            `Failed to send step ${step.index} of sequence ` +
              `${sequence.id}: ${message}`
          );
        }
      }

      // Check if all steps are done
      const allDone = sequence.steps.every(
        (s) =>
          s.status === 'sent' ||
          s.status === 'failed' ||
          s.status === 'cancelled'
      );
      if (allDone) {
        sequence.status = 'completed';
        sequence.completedAt = now.toISOString();
        modified = true;
        logger.info(`Sequence ${sequence.id} completed`);
      }

      if (modified) {
        await this.saveSequence(sequence);
      }
    }

    const result: ProcessSequencesResult = { sent, failed, skipped };

    logger.info(
      `Email sequences processed: ${sent} sent, ` +
        `${failed} failed, ${skipped} not yet due`
    );

    return result;
  }

  // ── Email Content Generation ────────────────────────────────────────

  async generateEmailContent(
    step: EmailStep,
    subscriberId: string,
    products: Product[]
  ): Promise<GeneratedEmail> {
    logger.debug(
      `Generating email content for template "${step.bodyTemplate}" ` +
        `subscriber ${subscriberId}`
    );

    switch (step.bodyTemplate) {
      case 'welcome-free-sample':
        return this.buildWelcomeFreeSample(subscriberId);

      case 'welcome-showcase':
        return this.buildWelcomeShowcase(products);

      case 'welcome-top-sellers':
        return this.buildWelcomeTopSellers(subscriberId, products);

      case 'welcome-discount':
        return this.buildWelcomeDiscount(subscriberId);

      case 'welcome-recommendations':
        return this.buildWelcomeRecommendations(subscriberId, products);

      case 'digest-weekly':
        return this.buildDigest(products);

      case 'abandonment-reminder':
        return this.buildAbandonmentReminder(products);

      case 'abandonment-social-proof':
        return this.buildAbandonmentSocialProof(products);

      case 'abandonment-discount':
        return this.buildAbandonmentDiscount(products);

      case 'niche-update':
        return this.buildNicheUpdate(products);

      default:
        throw new EmailSequenceError(
          subscriberId,
          `Unknown body template: ${step.bodyTemplate}`
        );
    }
  }

  // ── Sequence Metrics ────────────────────────────────────────────────

  async getSequenceMetrics(sequenceId: string): Promise<SequenceMetrics> {
    logger.debug(`Fetching metrics for sequence ${sequenceId}`);

    const sequence = await this.loadSequence(sequenceId);
    const totalSteps = sequence.steps.length;
    const stepsSent = sequence.steps.filter((s) => s.status === 'sent').length;
    const stepsFailed = sequence.steps.filter((s) => s.status === 'failed').length;
    const stepsPending = sequence.steps.filter((s) => s.status === 'pending').length;

    let totalOpens = 0;
    let totalClicks = 0;
    let totalSent = 0;

    for (const step of sequence.steps) {
      if (step.campaignId) {
        try {
          const stats = await this.emailClient.getCampaignStats(
            step.campaignId
          );
          totalSent += stats.sent;
          totalOpens += stats.opened;
          totalClicks += stats.clicked;
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to fetch stats for campaign ${step.campaignId}: ${message}`
          );
        }
      }
    }

    const openRate = totalSent > 0 ? totalOpens / totalSent : 0;
    const clickRate = totalSent > 0 ? totalClicks / totalSent : 0;
    // Conversion rate requires purchase tracking — estimate from clicks
    const conversionRate = totalClicks > 0 ? totalClicks * 0.05 / totalSent : 0;

    return {
      sequenceId,
      totalSteps,
      stepsSent,
      stepsFailed,
      stepsPending,
      openRate,
      clickRate,
      conversionRate,
    };
  }

  // ── Pause / Resume ─────────────────────────────────────────────────

  async pauseSequence(sequenceId: string): Promise<void> {
    logger.info(`Pausing sequence ${sequenceId}`);

    const sequence = await this.loadSequence(sequenceId);

    if (sequence.status !== 'active') {
      throw new EmailSequenceError(
        sequenceId,
        `Cannot pause sequence with status "${sequence.status}"`
      );
    }

    sequence.status = 'paused';
    sequence.pausedAt = new Date().toISOString();
    await this.saveSequence(sequence);

    logger.info(`Sequence ${sequenceId} paused`);
  }

  async resumeSequence(sequenceId: string): Promise<void> {
    logger.info(`Resuming sequence ${sequenceId}`);

    const sequence = await this.loadSequence(sequenceId);

    if (sequence.status !== 'paused') {
      throw new EmailSequenceError(
        sequenceId,
        `Cannot resume sequence with status "${sequence.status}"`
      );
    }

    sequence.status = 'active';
    sequence.pausedAt = undefined;
    await this.saveSequence(sequence);

    logger.info(`Sequence ${sequenceId} resumed`);
  }

  // ── Active Sequences ────────────────────────────────────────────────

  async getActiveSequences(): Promise<EmailSequence[]> {
    const all = await this.loadAllSequences();
    return all.filter((s) => s.status === 'active');
  }

  // ── Email Content Builders ──────────────────────────────────────────

  private buildWelcomeFreeSample(subscriberId: string): GeneratedEmail {
    const html = [
      '<h1>Welcome to PrintPilot!</h1>',
      '<p>We\'re so glad you joined us. As a thank you, here\'s a free ',
      'printable sample from our collection.</p>',
      '<p><a href="{{free_sample_url}}">Download Your Free Sample</a></p>',
      '<p>This is just a taste of the beautifully designed planners, ',
      'trackers, journals, and worksheets we create.</p>',
      '<p>Over the next two weeks, we\'ll share our best work and a ',
      'special offer just for new subscribers.</p>',
      '<p>Happy printing!</p>',
    ].join('\n');

    const text = [
      'Welcome to PrintPilot!',
      '',
      'We\'re so glad you joined us. As a thank you, here\'s a free ',
      'printable sample from our collection.',
      '',
      'Download your free sample: {{free_sample_url}}',
      '',
      'This is just a taste of the beautifully designed planners, ',
      'trackers, journals, and worksheets we create.',
      '',
      'Happy printing!',
    ].join('\n');

    return { html, text };
  }

  private buildWelcomeShowcase(products: Product[]): GeneratedEmail {
    const productList = products
      .slice(0, 6)
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(p.niche)}</li>`
      )
      .join('\n');

    const html = [
      '<h1>Here\'s What We Create</h1>',
      '<p>At PrintPilot, we design printable digital products that help ',
      'you organize, plan, and track your goals — beautifully.</p>',
      '<h2>Our Product Range</h2>',
      '<ul>',
      '<li><strong>Planners</strong> — Daily, weekly, and monthly layouts</li>',
      '<li><strong>Trackers</strong> — Habit, fitness, budget, and more</li>',
      '<li><strong>Journals</strong> — Guided prompts and freeform pages</li>',
      '<li><strong>Worksheets</strong> — Goal-setting, reflection, and productivity</li>',
      '</ul>',
      products.length > 0 ? '<h2>Recent Designs</h2><ul>' : '',
      products.length > 0 ? productList : '',
      products.length > 0 ? '</ul>' : '',
      '<p>Every product is designed for instant download and easy printing.</p>',
    ].join('\n');

    const text = [
      'Here\'s What We Create',
      '',
      'At PrintPilot, we design printable digital products that help ',
      'you organize, plan, and track your goals — beautifully.',
      '',
      'Our Product Range:',
      '- Planners: Daily, weekly, and monthly layouts',
      '- Trackers: Habit, fitness, budget, and more',
      '- Journals: Guided prompts and freeform pages',
      '- Worksheets: Goal-setting, reflection, and productivity',
      '',
      'Every product is designed for instant download and easy printing.',
    ].join('\n');

    return { html, text };
  }

  private buildWelcomeTopSellers(
    subscriberId: string,
    products: Product[]
  ): GeneratedEmail {
    const topProducts = products
      .sort((a, b) => b.scores.sellability - a.scores.sellability)
      .slice(0, 5);

    const productHtml = topProducts
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong> — ` +
          `rated ${p.scores.sellability}/5 by our team</li>`
      )
      .join('\n');

    const html = [
      '<h1>Our Top Sellers — Picked For You</h1>',
      '<p>Based on what our customers love most, here are our ',
      'highest-rated products:</p>',
      '<ul>',
      productHtml,
      '</ul>',
      '<p><a href="{{shop_url}}">Browse the full collection</a></p>',
    ].join('\n');

    const text = [
      'Our Top Sellers — Picked For You',
      '',
      'Based on what our customers love most, here are our ',
      'highest-rated products:',
      '',
      ...topProducts.map(
        (p) => `- ${p.title} — rated ${p.scores.sellability}/5`
      ),
      '',
      'Browse the full collection: {{shop_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildWelcomeDiscount(subscriberId: string): GeneratedEmail {
    const html = [
      '<h1>A Special Welcome Gift</h1>',
      '<p>You\'ve been with us for a week now, and we want to say ',
      'thanks with an exclusive offer.</p>',
      '<h2>15% Off Your First Purchase</h2>',
      '<p>Use code <strong>WELCOME15</strong> at checkout.</p>',
      '<p>This code expires in 7 days, so don\'t wait too long!</p>',
      '<p><a href="{{shop_url}}">Shop Now</a></p>',
    ].join('\n');

    const text = [
      'A Special Welcome Gift',
      '',
      'You\'ve been with us for a week now, and we want to say ',
      'thanks with an exclusive offer.',
      '',
      '15% Off Your First Purchase',
      'Use code WELCOME15 at checkout.',
      '',
      'This code expires in 7 days, so don\'t wait too long!',
      '',
      'Shop now: {{shop_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildWelcomeRecommendations(
    subscriberId: string,
    products: Product[]
  ): GeneratedEmail {
    const recommendations = products.slice(0, 4);

    const productHtml = recommendations
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(p.niche)}</li>`
      )
      .join('\n');

    const html = [
      '<h1>Complete Your Collection</h1>',
      '<p>Based on your interests, we think you\'ll love these:</p>',
      '<ul>',
      productHtml,
      '</ul>',
      '<p>Each one is designed with the same care and quality you\'ve ',
      'come to expect from PrintPilot.</p>',
      '<p><a href="{{shop_url}}">See all products</a></p>',
    ].join('\n');

    const text = [
      'Complete Your Collection',
      '',
      'Based on your interests, we think you\'ll love these:',
      '',
      ...recommendations.map((p) => `- ${p.title} (${p.niche})`),
      '',
      'See all products: {{shop_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildDigest(products: Product[]): GeneratedEmail {
    const productHtml = products
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong> — ${escapeHtml(p.niche)}</li>`
      )
      .join('\n');

    const html = [
      '<h1>This Week\'s New Designs</h1>',
      '<p>Here\'s what we\'ve been working on this week:</p>',
      '<ul>',
      productHtml,
      '</ul>',
      '<p><a href="{{shop_url}}">Browse the full collection</a></p>',
    ].join('\n');

    const text = [
      'This Week\'s New Designs',
      '',
      'Here\'s what we\'ve been working on this week:',
      '',
      ...products.map((p) => `- ${p.title} (${p.niche})`),
      '',
      'Browse the full collection: {{shop_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildAbandonmentReminder(products: Product[]): GeneratedEmail {
    const productNames = products.map((p) => p.title).join(', ');

    const html = [
      '<h1>Still Thinking About It?</h1>',
      `<p>We noticed you were checking out: <strong>${escapeHtml(productNames)}</strong></p>`,
      '<p>These items are still available and waiting for you.</p>',
      '<p><a href="{{cart_url}}">Return to your cart</a></p>',
    ].join('\n');

    const text = [
      'Still Thinking About It?',
      '',
      `We noticed you were checking out: ${productNames}`,
      '',
      'These items are still available and waiting for you.',
      '',
      'Return to your cart: {{cart_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildAbandonmentSocialProof(products: Product[]): GeneratedEmail {
    const productHtml = products
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong> — ` +
          `overall score: ${p.scores.sellability}/5</li>`
      )
      .join('\n');

    const html = [
      '<h1>See Why Others Love These Products</h1>',
      '<p>The items in your cart are some of our most popular designs:</p>',
      '<ul>',
      productHtml,
      '</ul>',
      '<p>Our customers consistently rate them highly for quality, ',
      'design, and usability.</p>',
      '<p><a href="{{cart_url}}">Complete your purchase</a></p>',
    ].join('\n');

    const text = [
      'See Why Others Love These Products',
      '',
      'The items in your cart are some of our most popular designs:',
      '',
      ...products.map(
        (p) => `- ${p.title} — overall score: ${p.scores.sellability}/5`
      ),
      '',
      'Complete your purchase: {{cart_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildAbandonmentDiscount(products: Product[]): GeneratedEmail {
    const html = [
      '<h1>A Little Something to Help You Decide</h1>',
      '<p>We\'d love for you to try our products, so here\'s a ',
      'special offer:</p>',
      '<h2>10% Off Your Cart</h2>',
      '<p>Use code <strong>COMEBACK10</strong> at checkout.</p>',
      '<p>This offer expires in 48 hours.</p>',
      '<p><a href="{{cart_url}}">Complete your purchase</a></p>',
    ].join('\n');

    const text = [
      'A Little Something to Help You Decide',
      '',
      'We\'d love for you to try our products, so here\'s a special offer:',
      '',
      '10% Off Your Cart',
      'Use code COMEBACK10 at checkout.',
      '',
      'This offer expires in 48 hours.',
      '',
      'Complete your purchase: {{cart_url}}',
    ].join('\n');

    return { html, text };
  }

  private buildNicheUpdate(products: Product[]): GeneratedEmail {
    const niche = products[0]?.niche ?? 'printables';

    const productHtml = products
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.title)}</strong></li>`
      )
      .join('\n');

    const html = [
      `<h1>New ${escapeHtml(capitalize(niche))} Designs Just Dropped!</h1>`,
      '<p>We\'ve just added fresh designs to our collection:</p>',
      '<ul>',
      productHtml,
      '</ul>',
      '<p>As someone who loves ' + escapeHtml(niche) + ' products, we thought ',
      'you\'d want to see these first.</p>',
      '<p><a href="{{shop_url}}">Check them out</a></p>',
    ].join('\n');

    const text = [
      `New ${capitalize(niche)} Designs Just Dropped!`,
      '',
      'We\'ve just added fresh designs to our collection:',
      '',
      ...products.map((p) => `- ${p.title}`),
      '',
      `As someone who loves ${niche} products, we thought ` +
        'you\'d want to see these first.',
      '',
      'Check them out: {{shop_url}}',
    ].join('\n');

    return { html, text };
  }

  // ── Product Resolution ──────────────────────────────────────────────

  private async resolveProductsForSequence(
    sequence: EmailSequence
  ): Promise<Product[]> {
    const productIdStr = sequence.metadata?.productIds;
    if (!productIdStr) {
      return this.loadRecentProducts();
    }

    const productIds = productIdStr.split(',').filter(Boolean);
    const products: Product[] = [];

    for (const productId of productIds) {
      try {
        const product = await this.loadProduct(productId);
        products.push(product);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to load product ${productId}: ${message}`
        );
      }
    }

    return products;
  }

  // ── Digest Sequence Helper ──────────────────────────────────────────

  private async createDigestSequence(
    subscriberId: string,
    products: Product[],
    segmentId?: string
  ): Promise<EmailSequence> {
    const now = new Date();
    const sequenceId = `digest-${subscriberId}-${now.getTime()}`;

    const step: EmailStep = {
      index: 0,
      subject: 'This Week\'s New Designs from PrintPilot',
      bodyTemplate: 'digest-weekly',
      delayDays: 0,
      status: 'pending',
    };

    const metadata: Record<string, string> = {
      productIds: products.map((p) => p.id).join(','),
    };
    if (segmentId) {
      metadata.segmentId = segmentId;
    }

    const sequence: EmailSequence = {
      id: sequenceId,
      type: 'digest',
      subscriberId,
      steps: [step],
      status: 'active',
      startedAt: now.toISOString(),
      metadata,
    };

    await this.saveSequence(sequence);
    return sequence;
  }

  // ── State Persistence ───────────────────────────────────────────────

  private getSequencePath(sequenceId: string): string {
    return join(STATE_DIR, `${sequenceId}.json`);
  }

  private getSegmentPath(segmentId: string): string {
    return join(SEGMENTS_DIR, `${segmentId}.json`);
  }

  private async saveSequence(sequence: EmailSequence): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true });
    const filePath = this.getSequencePath(sequence.id);
    await writeFile(filePath, JSON.stringify(sequence, null, 2), 'utf-8');
    logger.debug(`Saved email sequence ${sequence.id}`);
  }

  private async loadSequence(sequenceId: string): Promise<EmailSequence> {
    const filePath = this.getSequencePath(sequenceId);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new EmailSequenceError(
        sequenceId,
        `Sequence file not found: ${filePath}`
      );
    }

    return JSON.parse(raw) as EmailSequence;
  }

  private async loadAllSequences(): Promise<EmailSequence[]> {
    let files: string[];
    try {
      files = await readdir(STATE_DIR);
    } catch {
      logger.debug('No email sequences state directory found');
      return [];
    }

    const sequences: EmailSequence[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      // Skip segment files (they live in a subdirectory, but be safe)
      if (file.startsWith('segment-')) {
        continue;
      }

      try {
        const raw = await readFile(join(STATE_DIR, file), 'utf-8');
        sequences.push(JSON.parse(raw) as EmailSequence);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to load sequence from ${file}: ${message}`);
      }
    }

    return sequences;
  }

  private async saveSegment(segment: SubscriberSegment): Promise<void> {
    await mkdir(SEGMENTS_DIR, { recursive: true });
    const filePath = this.getSegmentPath(segment.id);
    await writeFile(filePath, JSON.stringify(segment, null, 2), 'utf-8');
    logger.debug(`Saved segment ${segment.id}`);
  }

  private async loadAllSegments(): Promise<SubscriberSegment[]> {
    let files: string[];
    try {
      files = await readdir(SEGMENTS_DIR);
    } catch {
      logger.debug('No segments directory found');
      return [];
    }

    const segments: SubscriberSegment[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(SEGMENTS_DIR, file), 'utf-8');
        segments.push(JSON.parse(raw) as SubscriberSegment);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to load segment from ${file}: ${message}`);
      }
    }

    return segments;
  }

  // ── Product / Subscriber Loaders ────────────────────────────────────

  private async loadProduct(productId: string): Promise<Product> {
    const filePath = join(PRODUCTS_DIR, productId, 'product.json');

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new EmailSequenceError(
        productId,
        `Product file not found: ${filePath}`
      );
    }

    return JSON.parse(raw) as Product;
  }

  private async loadRecentProducts(): Promise<Product[]> {
    let dirs: string[];
    try {
      dirs = await readdir(PRODUCTS_DIR);
    } catch {
      logger.debug('No products directory found');
      return [];
    }

    const products: Product[] = [];
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    for (const dir of dirs) {
      try {
        const filePath = join(PRODUCTS_DIR, dir, 'product.json');
        const raw = await readFile(filePath, 'utf-8');
        const product = JSON.parse(raw) as Product;

        if (new Date(product.createdAt) >= oneWeekAgo) {
          products.push(product);
        }
      } catch {
        // Skip unreadable product directories
        continue;
      }
    }

    return products.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  private async loadSubscriberProfiles(): Promise<SubscriberProfile[]> {
    const profilesDir = resolve(
      process.cwd(),
      'state/marketing/subscribers'
    );

    let files: string[];
    try {
      files = await readdir(profilesDir);
    } catch {
      logger.debug('No subscriber profiles directory found');
      return [];
    }

    const profiles: SubscriberProfile[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(profilesDir, file), 'utf-8');
        profiles.push(JSON.parse(raw) as SubscriberProfile);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to load subscriber profile from ${file}: ${message}`
        );
      }
    }

    return profiles;
  }
}

// ── Internal Types ──────────────────────────────────────────────────

interface GeneratedEmail {
  html: string;
  text: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function addFractionalDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  const milliseconds = days * 24 * 60 * 60 * 1000;
  result.setTime(result.getTime() + milliseconds);
  return result;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
