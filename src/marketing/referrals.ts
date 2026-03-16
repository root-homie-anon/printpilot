import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { generateCouponCode } from './promotions.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/referrals');
const PROGRAMS_DIR = join(STATE_DIR, 'programs');
const LINKS_DIR = join(STATE_DIR, 'links');
const REWARDS_DIR = join(STATE_DIR, 'rewards');
const CARDS_DIR = join(STATE_DIR, 'cards');
const PRODUCTS_DIR = resolve(process.cwd(), 'state/products');

const BASE_URL = 'https://api.etsy.com/v3';
const SHORT_CODE_LENGTH = 8;
const SHORT_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

const DEFAULT_SHARE_DISCOUNT_PERCENT = 15;
const DEFAULT_REFERRER_REWARD_PERCENT = 10;
const DEFAULT_TRACKING_BASE_URL = 'https://printpilot.link/r';

// ── Types ────────────────────────────────────────────────────────────

export type ReferralPlatform =
  | 'pinterest'
  | 'instagram'
  | 'facebook'
  | 'email';

export type ProgramStatus = 'active' | 'paused' | 'ended';
export type RewardStatus = 'pending' | 'issued' | 'redeemed' | 'expired';

export interface ReferralProgram {
  id: string;
  name: string;
  discountPercent: number;
  platform: ReferralPlatform;
  status: ProgramStatus;
  createdAt: string;
}

export interface ReferralLink {
  id: string;
  programId: string;
  buyerId: string;
  url: string;
  shortCode: string;
  platform: ReferralPlatform;
  clicks: number;
  conversions: number;
  revenue: number;
  createdAt: string;
}

export interface ReferralCard {
  productId: string;
  htmlContent: string;
  pdfPath: string;
}

export interface ReferralReward {
  id: string;
  referrerId: string;
  referredBuyerId: string;
  orderId: string;
  couponCode: string;
  status: RewardStatus;
  createdAt: string;
  redeemedAt?: string;
}

export interface ReferralConfig {
  shareDiscountPercent: number;
  referrerRewardPercent: number;
  trackingBaseUrl: string;
}

export interface ReferralStats {
  programId: string;
  totalLinks: number;
  totalClicks: number;
  totalConversions: number;
  totalRevenue: number;
  conversionRate: number;
}

export interface TopReferrer {
  buyerId: string;
  totalConversions: number;
  totalRevenue: number;
  linkCount: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export class ReferralError extends Error {
  public readonly referralId?: string;

  constructor(message: string, referralId?: string) {
    super(
      referralId
        ? `Referral error (${referralId}): ${message}`
        : `Referral error: ${message}`
    );
    this.name = 'ReferralError';
    this.referralId = referralId;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function ensureDirectories(): Promise<void> {
  await mkdir(PROGRAMS_DIR, { recursive: true });
  await mkdir(LINKS_DIR, { recursive: true });
  await mkdir(REWARDS_DIR, { recursive: true });
  await mkdir(CARDS_DIR, { recursive: true });
}

function generateShortCode(): string {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * SHORT_CODE_CHARS.length);
    code += SHORT_CODE_CHARS[index];
  }
  return code;
}

async function saveJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function loadJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function loadAllFromDir<T>(dir: string): Promise<T[]> {
  const items: T[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return items;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      items.push(JSON.parse(raw) as T);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load file ${file}: ${message}`);
    }
  }

  return items;
}

function getPlatformShareText(platform: ReferralPlatform): string {
  switch (platform) {
    case 'pinterest':
      return 'Share on Pinterest';
    case 'instagram':
      return 'Share on Instagram';
    case 'facebook':
      return 'Share on Facebook';
    case 'email':
      return 'Share with a friend';
    default: {
      const exhaustive: never = platform;
      return `Share on ${exhaustive as string}`;
    }
  }
}

// ── Etsy Coupon Creation ─────────────────────────────────────────────

async function createEtsyRewardCoupon(
  couponCode: string,
  discountPercent: number
): Promise<void> {
  const apiKey = getEnvOrThrow('ETSY_API_KEY');
  const apiSecret = getEnvOrThrow('ETSY_API_SECRET');
  const shopId = getEnvOrThrow('ETSY_SHOP_ID');

  const oauth = new EtsyOAuth(
    apiKey,
    apiSecret,
    'http://localhost:3000/oauth/callback'
  );
  const accessToken = await oauth.getValidAccessToken();

  const now = new Date();
  const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const url = `${BASE_URL}/application/shops/${shopId}/coupons`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      coupon_code: couponCode,
      pct_discount: discountPercent,
      start_date: Math.floor(now.getTime() / 1000),
      end_date: Math.floor(endDate.getTime() / 1000),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReferralError(
      `Etsy coupon creation failed (${response.status}): ${body}`
    );
  }
}

// ── Core Class: ReferralEngine ───────────────────────────────────────

export class ReferralEngine {
  private readonly config: ReferralConfig;

  constructor(config?: Partial<ReferralConfig>) {
    this.config = {
      shareDiscountPercent:
        config?.shareDiscountPercent ?? DEFAULT_SHARE_DISCOUNT_PERCENT,
      referrerRewardPercent:
        config?.referrerRewardPercent ?? DEFAULT_REFERRER_REWARD_PERCENT,
      trackingBaseUrl:
        config?.trackingBaseUrl ?? DEFAULT_TRACKING_BASE_URL,
    };
  }

  async createProgram(
    name: string,
    platform: ReferralPlatform,
    discountPercent: number
  ): Promise<ReferralProgram> {
    await ensureDirectories();

    const program: ReferralProgram = {
      id: randomUUID(),
      name,
      discountPercent,
      platform,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    const filePath = join(PROGRAMS_DIR, `${program.id}.json`);
    await saveJson(filePath, program);

    await logActivity({
      timestamp: program.createdAt,
      agent: 'referral-engine',
      action: 'program-created',
      details:
        `Created referral program "${name}" on ${platform} ` +
        `(${discountPercent}% discount)`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Referral program "${name}" created on ${platform} (${program.id})`
    );

    return program;
  }

  async generateReferralLink(
    buyerId: string,
    programId: string
  ): Promise<ReferralLink> {
    await ensureDirectories();

    // Verify program exists and is active
    const program = await this.loadProgram(programId);
    if (program.status !== 'active') {
      throw new ReferralError(
        `Program "${program.name}" is not active (status: ${program.status})`,
        programId
      );
    }

    const shortCode = generateShortCode();
    const url = `${this.config.trackingBaseUrl}/${shortCode}`;

    const link: ReferralLink = {
      id: randomUUID(),
      programId,
      buyerId,
      url,
      shortCode,
      platform: program.platform,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      createdAt: new Date().toISOString(),
    };

    const filePath = join(LINKS_DIR, `${link.id}.json`);
    await saveJson(filePath, link);

    await logActivity({
      timestamp: link.createdAt,
      agent: 'referral-engine',
      action: 'link-generated',
      details:
        `Generated referral link for buyer ${buyerId} ` +
        `(program: ${program.name}, code: ${shortCode})`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Referral link generated: ${shortCode} for buyer ${buyerId} ` +
        `(program: ${program.name})`
    );

    return link;
  }

  async generateShareCard(
    productId: string,
    referralLink: ReferralLink
  ): Promise<ReferralCard> {
    await ensureDirectories();

    const program = await this.loadProgram(referralLink.programId);
    const shareText = getPlatformShareText(referralLink.platform);
    const discountPercent = program.discountPercent;

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    .share-card {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      max-width: 500px;
      margin: 40px auto;
      padding: 32px;
      border: 2px solid #e0e0e0;
      border-radius: 12px;
      text-align: center;
      background: linear-gradient(135deg, #fafafa 0%, #f0f0f0 100%);
    }
    .share-card h2 {
      font-size: 22px;
      color: #333;
      margin: 0 0 12px 0;
    }
    .share-card .discount {
      font-size: 36px;
      font-weight: 700;
      color: #e85d3a;
      margin: 16px 0;
    }
    .share-card .cta {
      font-size: 16px;
      color: #555;
      margin: 12px 0 24px 0;
      line-height: 1.5;
    }
    .share-card .link-box {
      display: inline-block;
      padding: 12px 24px;
      background: #333;
      color: #fff;
      border-radius: 6px;
      font-size: 14px;
      font-family: monospace;
      letter-spacing: 0.5px;
      margin: 8px 0;
    }
    .share-card .qr-placeholder {
      width: 120px;
      height: 120px;
      margin: 20px auto;
      border: 2px dashed #ccc;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #999;
      font-size: 12px;
    }
    .share-card .footer {
      font-size: 12px;
      color: #999;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="share-card">
    <h2>${shareText}</h2>
    <div class="discount">${discountPercent}% OFF</div>
    <div class="cta">
      Share this link with friends and they get
      ${discountPercent}% off their next order!
    </div>
    <div class="link-box">${referralLink.url}</div>
    <div class="qr-placeholder">QR Code</div>
    <div class="footer">
      You'll earn a reward when your friends make a purchase.
    </div>
  </div>
</body>
</html>`.trim();

    const pdfPath = join(
      CARDS_DIR,
      `${productId}-${referralLink.shortCode}.pdf`
    );

    const card: ReferralCard = {
      productId,
      htmlContent,
      pdfPath,
    };

    // Save the HTML for later rendering
    const htmlPath = join(
      CARDS_DIR,
      `${productId}-${referralLink.shortCode}.html`
    );
    await writeFile(htmlPath, htmlContent, 'utf-8');

    logger.info(
      `Share card generated for product ${productId} ` +
        `(link: ${referralLink.shortCode})`
    );

    return card;
  }

  async appendShareCardToProduct(
    productPdfPath: string,
    cardHtml: string
  ): Promise<void> {
    // Save the card HTML alongside the product for rendering
    // Actual PDF append requires Puppeteer rendering + pdf-lib merge,
    // which is handled by the renderer pipeline
    const cardPath = productPdfPath.replace(/\.pdf$/, '-share-card.html');
    await writeFile(cardPath, cardHtml, 'utf-8');

    logger.info(
      `Share card HTML saved for PDF append: ${cardPath}`
    );

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'referral-engine',
      action: 'share-card-appended',
      details: `Share card HTML saved for product PDF: ${productPdfPath}`,
      duration: 0,
      success: true,
    });
  }

  async processNewProducts(productIds: string[]): Promise<ReferralCard[]> {
    await ensureDirectories();

    const activePrograms = await this.getActivePrograms();
    const cards: ReferralCard[] = [];

    if (activePrograms.length === 0) {
      logger.info('No active referral programs — skipping share card generation');
      return cards;
    }

    // Use the first active program for generic share cards
    const program = activePrograms[0];

    for (const productId of productIds) {
      try {
        // Create a generic referral link for the product
        const link = await this.generateReferralLink(
          `product-${productId}`,
          program.id
        );
        const card = await this.generateShareCard(productId, link);
        cards.push(card);

        logger.info(
          `Share card created for new product ${productId}`
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to create share card for product ${productId}: ${message}`
        );
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'referral-engine',
      action: 'new-products-processed',
      details:
        `Processed ${productIds.length} products, ` +
        `generated ${cards.length} share cards`,
      duration: 0,
      success: cards.length > 0,
    });

    return cards;
  }

  async trackClick(shortCode: string): Promise<ReferralLink> {
    const link = await this.findLinkByShortCode(shortCode);

    link.clicks += 1;

    const filePath = join(LINKS_DIR, `${link.id}.json`);
    await saveJson(filePath, link);

    logger.debug(`Click tracked for referral link ${shortCode} (total: ${link.clicks})`);

    return link;
  }

  async trackConversion(
    shortCode: string,
    orderId: string
  ): Promise<ReferralReward> {
    const link = await this.findLinkByShortCode(shortCode);

    link.conversions += 1;

    const filePath = join(LINKS_DIR, `${link.id}.json`);
    await saveJson(filePath, link);

    logger.info(
      `Conversion tracked for referral link ${shortCode} ` +
        `(order: ${orderId}, total conversions: ${link.conversions})`
    );

    // Create reward for the referrer
    const reward = await this.rewardReferrer(link.id, orderId);

    return reward;
  }

  async rewardReferrer(
    referralLinkId: string,
    orderId: string
  ): Promise<ReferralReward> {
    await ensureDirectories();

    const link = await this.loadLink(referralLinkId);
    const couponCode = generateCouponCode('REFER');

    // Create the coupon on Etsy
    try {
      await createEtsyRewardCoupon(
        couponCode,
        this.config.referrerRewardPercent
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to create Etsy reward coupon for referrer ` +
          `${link.buyerId}: ${message}`
      );
      throw new ReferralError(
        `Failed to create reward coupon: ${message}`,
        referralLinkId
      );
    }

    const reward: ReferralReward = {
      id: randomUUID(),
      referrerId: link.buyerId,
      referredBuyerId: `buyer-${orderId}`,
      orderId,
      couponCode,
      status: 'issued',
      createdAt: new Date().toISOString(),
    };

    const filePath = join(REWARDS_DIR, `${reward.id}.json`);
    await saveJson(filePath, reward);

    await logActivity({
      timestamp: reward.createdAt,
      agent: 'referral-engine',
      action: 'reward-issued',
      details:
        `Reward coupon ${couponCode} issued to referrer ${link.buyerId} ` +
        `(${this.config.referrerRewardPercent}% off, order: ${orderId})`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Reward coupon ${couponCode} issued to referrer ${link.buyerId} ` +
        `for order ${orderId}`
    );

    return reward;
  }

  async getReferralStats(programId: string): Promise<ReferralStats> {
    // Verify program exists
    await this.loadProgram(programId);

    const allLinks = await loadAllFromDir<ReferralLink>(LINKS_DIR);
    const programLinks = allLinks.filter((l) => l.programId === programId);

    const totalClicks = programLinks.reduce((sum, l) => sum + l.clicks, 0);
    const totalConversions = programLinks.reduce(
      (sum, l) => sum + l.conversions,
      0
    );
    const totalRevenue = programLinks.reduce((sum, l) => sum + l.revenue, 0);
    const conversionRate =
      totalClicks > 0 ? totalConversions / totalClicks : 0;

    return {
      programId,
      totalLinks: programLinks.length,
      totalClicks,
      totalConversions,
      totalRevenue,
      conversionRate,
    };
  }

  async getTopReferrers(limit: number): Promise<TopReferrer[]> {
    const allLinks = await loadAllFromDir<ReferralLink>(LINKS_DIR);

    // Aggregate by buyerId
    const referrerMap = new Map<
      string,
      { conversions: number; revenue: number; linkCount: number }
    >();

    for (const link of allLinks) {
      const existing = referrerMap.get(link.buyerId) ?? {
        conversions: 0,
        revenue: 0,
        linkCount: 0,
      };
      existing.conversions += link.conversions;
      existing.revenue += link.revenue;
      existing.linkCount += 1;
      referrerMap.set(link.buyerId, existing);
    }

    const referrers: TopReferrer[] = [];
    for (const [buyerId, stats] of referrerMap) {
      referrers.push({
        buyerId,
        totalConversions: stats.conversions,
        totalRevenue: stats.revenue,
        linkCount: stats.linkCount,
      });
    }

    // Sort by conversions descending, then by revenue descending
    referrers.sort((a, b) => {
      if (b.totalConversions !== a.totalConversions) {
        return b.totalConversions - a.totalConversions;
      }
      return b.totalRevenue - a.totalRevenue;
    });

    return referrers.slice(0, limit);
  }

  async getBuyerReferralLinks(buyerId: string): Promise<ReferralLink[]> {
    const allLinks = await loadAllFromDir<ReferralLink>(LINKS_DIR);
    return allLinks.filter((l) => l.buyerId === buyerId);
  }

  async runReferralCycle(): Promise<{
    conversionsProcessed: number;
    rewardsIssued: number;
  }> {
    logger.info('Running daily referral cycle');

    const allRewards = await loadAllFromDir<ReferralReward>(REWARDS_DIR);
    const pendingRewards = allRewards.filter((r) => r.status === 'pending');

    let rewardsIssued = 0;

    for (const reward of pendingRewards) {
      try {
        const couponCode = generateCouponCode('REFER');

        await createEtsyRewardCoupon(
          couponCode,
          this.config.referrerRewardPercent
        );

        reward.couponCode = couponCode;
        reward.status = 'issued';

        const filePath = join(REWARDS_DIR, `${reward.id}.json`);
        await saveJson(filePath, reward);

        rewardsIssued++;

        logger.info(
          `Pending reward ${reward.id} issued: coupon ${couponCode} ` +
            `for referrer ${reward.referrerId}`
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to issue pending reward ${reward.id}: ${message}`
        );
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'referral-engine',
      action: 'referral-cycle-complete',
      details:
        `Daily referral cycle: ${pendingRewards.length} pending rewards checked, ` +
        `${rewardsIssued} issued`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Referral cycle complete: ${rewardsIssued} rewards issued ` +
        `out of ${pendingRewards.length} pending`
    );

    return {
      conversionsProcessed: pendingRewards.length,
      rewardsIssued,
    };
  }

  async getActivePrograms(): Promise<ReferralProgram[]> {
    const allPrograms = await loadAllFromDir<ReferralProgram>(PROGRAMS_DIR);
    return allPrograms.filter((p) => p.status === 'active');
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private async loadProgram(programId: string): Promise<ReferralProgram> {
    const filePath = join(PROGRAMS_DIR, `${programId}.json`);
    try {
      return await loadJson<ReferralProgram>(filePath);
    } catch {
      throw new ReferralError(
        `Referral program not found: ${programId}`,
        programId
      );
    }
  }

  private async loadLink(linkId: string): Promise<ReferralLink> {
    const filePath = join(LINKS_DIR, `${linkId}.json`);
    try {
      return await loadJson<ReferralLink>(filePath);
    } catch {
      throw new ReferralError(
        `Referral link not found: ${linkId}`,
        linkId
      );
    }
  }

  private async findLinkByShortCode(shortCode: string): Promise<ReferralLink> {
    const allLinks = await loadAllFromDir<ReferralLink>(LINKS_DIR);
    const link = allLinks.find((l) => l.shortCode === shortCode);

    if (!link) {
      throw new ReferralError(
        `Referral link not found for short code: ${shortCode}`
      );
    }

    return link;
  }
}
