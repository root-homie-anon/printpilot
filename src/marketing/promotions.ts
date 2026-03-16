import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/promotions');
const ACTIVE_DIR = join(STATE_DIR, 'active');
const ARCHIVE_DIR = join(STATE_DIR, 'archive');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');

const COUPON_CODE_LENGTH = 6;
const COUPON_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const BASE_URL = 'https://api.etsy.com/v3';

// ── Types ────────────────────────────────────────────────────────────

export type PromotionType = 'coupon' | 'sale' | 'flash-sale' | 'recovery';
export type PromotionStatus =
  | 'draft'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface Promotion {
  id: string;
  type: PromotionType;
  discountPercent: number;
  couponCode: string;
  startDate: string;
  endDate: string;
  targetListings: number[];
  status: PromotionStatus;
  campaignName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeasonalCampaign {
  name: string;
  dateRange: { start: string; end: string };
  niches: string[];
  discountPercent: number;
  description: string;
}

export interface PromotionResult {
  promotionId: string;
  couponCode: string;
  listingsApplied: number[];
  status: PromotionStatus;
}

export interface PromotionMetrics {
  promotionId: string;
  couponCode: string;
  usageCount: number;
  revenueAttributed: number;
  startDate: string;
  endDate: string;
  status: PromotionStatus;
}

export interface CreateCouponParams {
  discountPercent: number;
  targetListings?: number[];
  prefix?: string;
  startDate?: string;
  endDate?: string;
  campaignName?: string;
}

export interface FlashSaleParams {
  listings: number[];
  hours: number;
  discountPercent: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export class PromotionError extends Error {
  public readonly promotionId?: string;

  constructor(message: string, promotionId?: string) {
    super(
      promotionId
        ? `Promotion error (${promotionId}): ${message}`
        : `Promotion error: ${message}`
    );
    this.name = 'PromotionError';
    this.promotionId = promotionId;
  }
}

// ── Seasonal Campaign Calendar ───────────────────────────────────────

const SEASONAL_CAMPAIGNS: SeasonalCampaign[] = [
  {
    name: 'New Year / Goal Setting',
    dateRange: { start: '12-26', end: '01-15' },
    niches: ['planner', 'tracker', 'goals-worksheet'],
    discountPercent: 20,
    description:
      'New year resolution season — planners, trackers, and goal worksheets.',
  },
  {
    name: "Valentine's Day",
    dateRange: { start: '02-01', end: '02-14' },
    niches: ['journal', 'planner', 'love-journal', 'couple-planner'],
    discountPercent: 15,
    description:
      'Love and relationships — journals for couples and love-themed planners.',
  },
  {
    name: 'Tax Season',
    dateRange: { start: '03-01', end: '04-15' },
    niches: [
      'budget-worksheet',
      'expense-tracker',
      'worksheet',
      'savings-tracker',
    ],
    discountPercent: 15,
    description:
      'Financial organization push — budget worksheets and expense trackers.',
  },
  {
    name: "Mother's Day",
    dateRange: { start: '04-25', end: '05-11' },
    niches: [
      'self-care-journal',
      'mindfulness-journal',
      'wellness',
      'planner',
    ],
    discountPercent: 20,
    description:
      'Wellness and self-care gifts — journals and planners for moms.',
  },
  {
    name: "Father's Day",
    dateRange: { start: '06-05', end: '06-15' },
    niches: [
      'fitness-tracker',
      'productivity-planner',
      'habit-tracker',
      'planner',
    ],
    discountPercent: 15,
    description:
      'Fitness and productivity gifts — trackers and planners for dads.',
  },
  {
    name: 'Back to School',
    dateRange: { start: '08-01', end: '09-15' },
    niches: [
      'study-planner',
      'academic-planner',
      'homework-tracker',
      'tracker',
      'planner',
    ],
    discountPercent: 25,
    description:
      'Academic season — study planners, homework trackers, and student tools.',
  },
  {
    name: 'Black Friday',
    dateRange: { start: '11-20', end: '12-02' },
    niches: [],
    discountPercent: 30,
    description:
      'Biggest sale of the year — all products eligible for maximum discounts.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

async function ensureDirectories(): Promise<void> {
  await mkdir(ACTIVE_DIR, { recursive: true });
  await mkdir(ARCHIVE_DIR, { recursive: true });
}

function getPromotionPath(id: string, archived: boolean = false): string {
  const dir = archived ? ARCHIVE_DIR : ACTIVE_DIR;
  return join(dir, `${id}.json`);
}

async function savePromotion(promotion: Promotion): Promise<void> {
  const isArchived =
    promotion.status === 'completed' || promotion.status === 'cancelled';
  const filePath = getPromotionPath(promotion.id, isArchived);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(promotion, null, 2), 'utf-8');
  logger.debug(`Saved promotion ${promotion.id} (status: ${promotion.status})`);
}

async function loadPromotion(id: string): Promise<Promotion> {
  // Try active first, then archive
  for (const dir of [ACTIVE_DIR, ARCHIVE_DIR]) {
    const filePath = join(dir, `${id}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Promotion;
    } catch {
      // Try next directory
    }
  }
  throw new PromotionError(`Promotion not found: ${id}`, id);
}

async function loadAllPromotions(dir: string): Promise<Promotion[]> {
  const promotions: Promotion[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return promotions;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      promotions.push(JSON.parse(raw) as Promotion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load promotion file ${file}: ${message}`);
    }
  }

  return promotions;
}

async function getAllActiveListingIds(): Promise<number[]> {
  const listingIds: number[] = [];
  let files: string[];
  try {
    files = await readdir(LISTINGS_DIR);
  } catch {
    return listingIds;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(LISTINGS_DIR, file), 'utf-8');
      const listing = JSON.parse(raw) as { listingId: number; status: string };
      if (listing.status === 'active') {
        listingIds.push(listing.listingId);
      }
    } catch {
      // Skip unreadable listing files
    }
  }

  return listingIds;
}

function parseCampaignDate(
  mmdd: string,
  referenceYear: number
): Date {
  const [month, day] = mmdd.split('-').map(Number);
  return new Date(referenceYear, month - 1, day);
}

function campaignMatchesNow(
  campaign: SeasonalCampaign,
  now: Date
): boolean {
  const year = now.getFullYear();
  const startDate = parseCampaignDate(campaign.dateRange.start, year);
  let endDate = parseCampaignDate(campaign.dateRange.end, year);

  // Handle year-wrapping campaigns (e.g., Dec 26 - Jan 15)
  if (endDate < startDate) {
    // If we're past the start date, the end wraps to next year
    if (now >= startDate) {
      endDate = parseCampaignDate(campaign.dateRange.end, year + 1);
    } else {
      // We might be in the wrapped portion (early in the year)
      const altStart = parseCampaignDate(campaign.dateRange.start, year - 1);
      if (now >= altStart) {
        return now <= endDate;
      }
      return false;
    }
  }

  return now >= startDate && now <= endDate;
}

function campaignStartsWithinDays(
  campaign: SeasonalCampaign,
  now: Date,
  days: number
): boolean {
  const year = now.getFullYear();
  let startDate = parseCampaignDate(campaign.dateRange.start, year);

  // If start is in the past this year, check next year
  if (startDate < now) {
    startDate = parseCampaignDate(campaign.dateRange.start, year + 1);
  }

  const diffMs = startDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}

function getListingNiche(listing: Record<string, unknown>): string {
  if (typeof listing.niche === 'string') {
    return listing.niche.toLowerCase();
  }
  return '';
}

async function getListingsForNiches(
  niches: string[]
): Promise<number[]> {
  if (niches.length === 0) {
    // Empty niches means all products (e.g., Black Friday)
    return getAllActiveListingIds();
  }

  const normalizedNiches = niches.map((n) => n.toLowerCase());
  const matchingIds: number[] = [];

  let files: string[];
  try {
    files = await readdir(LISTINGS_DIR);
  } catch {
    return matchingIds;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(LISTINGS_DIR, file), 'utf-8');
      const listing = JSON.parse(raw) as Record<string, unknown>;
      const niche = getListingNiche(listing);
      const status = listing.status as string | undefined;

      if (status !== 'active') {
        continue;
      }

      const matches = normalizedNiches.some(
        (n) => niche.includes(n) || n.includes(niche)
      );
      if (matches && typeof listing.listingId === 'number') {
        matchingIds.push(listing.listingId);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return matchingIds;
}

// ── Etsy Coupon API Helpers ──────────────────────────────────────────

interface EtsyCouponPayload {
  coupon_code: string;
  pct_discount: number;
  start_date?: number;
  end_date?: number;
  listing_ids?: number[];
}

interface EtsyCouponResponse {
  coupon_id: number;
  coupon_code: string;
  pct_discount: number;
}

async function createEtsyCoupon(
  shopId: string,
  apiKey: string,
  accessToken: string,
  payload: EtsyCouponPayload
): Promise<EtsyCouponResponse> {
  const url = `${BASE_URL}/application/shops/${shopId}/coupons`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PromotionError(
      `Etsy coupon creation failed (${response.status}): ${body}`
    );
  }

  return (await response.json()) as EtsyCouponResponse;
}

async function deleteEtsyCoupon(
  shopId: string,
  apiKey: string,
  accessToken: string,
  couponId: number
): Promise<void> {
  const url =
    `${BASE_URL}/application/shops/${shopId}/coupons/${couponId}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PromotionError(
      `Etsy coupon deletion failed (${response.status}): ${body}`
    );
  }
}

async function getEtsyCouponStats(
  shopId: string,
  apiKey: string,
  accessToken: string,
  couponId: number
): Promise<{ usage_count: number; revenue: number }> {
  const url =
    `${BASE_URL}/application/shops/${shopId}/coupons/${couponId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PromotionError(
      `Etsy coupon stats fetch failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    usage_count:
      typeof data.usage_count === 'number' ? data.usage_count : 0,
    revenue: typeof data.revenue === 'number' ? data.revenue : 0,
  };
}

// ── Etsy Client Initialization ───────────────────────────────────────

async function initEtsyAuth(): Promise<{
  client: EtsyClient;
  apiKey: string;
  shopId: string;
  accessToken: string;
}> {
  const apiKey = getEnvOrThrow('ETSY_API_KEY');
  const apiSecret = getEnvOrThrow('ETSY_API_SECRET');
  const shopId = getEnvOrThrow('ETSY_SHOP_ID');

  const client = new EtsyClient(apiKey, apiSecret, shopId);
  const oauth = new EtsyOAuth(
    apiKey,
    apiSecret,
    'http://localhost:3000/oauth/callback'
  );
  const accessToken = await oauth.getValidAccessToken();
  client.setAccessToken(accessToken);

  return { client, apiKey, shopId, accessToken };
}

// ── Core Class: PromotionsEngine ─────────────────────────────────────

export class PromotionsEngine {
  async createCoupon(params: CreateCouponParams): Promise<PromotionResult> {
    await ensureDirectories();

    const {
      discountPercent,
      targetListings,
      prefix,
      startDate,
      endDate,
      campaignName,
    } = params;

    const couponCode = generateCouponCode(prefix ?? 'PROMO');
    const now = new Date();
    const start = startDate ?? now.toISOString();
    const end =
      endDate ??
      new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const listings = targetListings ?? (await getAllActiveListingIds());

    logger.info(
      `Creating coupon ${couponCode}: ${discountPercent}% off, ` +
        `${listings.length} listings`
    );

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const payload: EtsyCouponPayload = {
      coupon_code: couponCode,
      pct_discount: discountPercent,
      start_date: Math.floor(new Date(start).getTime() / 1000),
      end_date: Math.floor(new Date(end).getTime() / 1000),
    };

    if (listings.length > 0) {
      payload.listing_ids = listings;
    }

    await createEtsyCoupon(shopId, apiKey, accessToken, payload);

    const promotion: Promotion = {
      id: randomUUID(),
      type: 'coupon',
      discountPercent,
      couponCode,
      startDate: start,
      endDate: end,
      targetListings: listings,
      status: 'active',
      campaignName,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await savePromotion(promotion);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'promotions-engine',
      action: 'coupon-created',
      productId: promotion.id,
      details:
        `Created coupon ${couponCode} (${discountPercent}% off) ` +
        `for ${listings.length} listings`,
      duration: 0,
      success: true,
    });

    logger.info(`Coupon ${couponCode} created successfully (${promotion.id})`);

    return {
      promotionId: promotion.id,
      couponCode,
      listingsApplied: listings,
      status: 'active',
    };
  }

  async createSeasonalSale(
    campaign: SeasonalCampaign
  ): Promise<PromotionResult> {
    await ensureDirectories();

    logger.info(
      `Creating seasonal sale: ${campaign.name} ` +
        `(${campaign.discountPercent}% off)`
    );

    const listings = await getListingsForNiches(campaign.niches);

    if (listings.length === 0) {
      logger.warn(
        `No matching listings found for campaign "${campaign.name}". ` +
          `Niches: ${campaign.niches.join(', ') || 'all'}`
      );
      const emptyPromotion: Promotion = {
        id: randomUUID(),
        type: 'sale',
        discountPercent: campaign.discountPercent,
        couponCode: '',
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
        targetListings: [],
        status: 'failed',
        campaignName: campaign.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await savePromotion(emptyPromotion);
      return {
        promotionId: emptyPromotion.id,
        couponCode: '',
        listingsApplied: [],
        status: 'failed',
      };
    }

    const couponCode = generateCouponCode(
      campaign.name
        .replace(/[^a-zA-Z]/g, '')
        .substring(0, 8)
        .toUpperCase()
    );

    const now = new Date();
    const year = now.getFullYear();
    const startDate = parseCampaignDate(
      campaign.dateRange.start,
      year
    );
    let endDate = parseCampaignDate(campaign.dateRange.end, year);

    if (endDate < startDate) {
      endDate = parseCampaignDate(campaign.dateRange.end, year + 1);
    }

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const payload: EtsyCouponPayload = {
      coupon_code: couponCode,
      pct_discount: campaign.discountPercent,
      start_date: Math.floor(startDate.getTime() / 1000),
      end_date: Math.floor(endDate.getTime() / 1000),
      listing_ids: listings,
    };

    await createEtsyCoupon(shopId, apiKey, accessToken, payload);

    const promotion: Promotion = {
      id: randomUUID(),
      type: 'sale',
      discountPercent: campaign.discountPercent,
      couponCode,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      targetListings: listings,
      status: 'active',
      campaignName: campaign.name,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await savePromotion(promotion);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'promotions-engine',
      action: 'seasonal-sale-created',
      productId: promotion.id,
      details:
        `Seasonal sale "${campaign.name}" — ${couponCode} ` +
        `(${campaign.discountPercent}% off, ${listings.length} listings)`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Seasonal sale "${campaign.name}" created: ${couponCode} ` +
        `(${promotion.id})`
    );

    return {
      promotionId: promotion.id,
      couponCode,
      listingsApplied: listings,
      status: 'active',
    };
  }

  async createFlashSale(
    listings: number[],
    hours: number,
    discountPercent: number
  ): Promise<PromotionResult> {
    await ensureDirectories();

    const now = new Date();
    const endDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const couponCode = generateCouponCode('FLASH');

    logger.info(
      `Creating flash sale: ${couponCode} — ${discountPercent}% off, ` +
        `${hours}h, ${listings.length} listings`
    );

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const payload: EtsyCouponPayload = {
      coupon_code: couponCode,
      pct_discount: discountPercent,
      start_date: Math.floor(now.getTime() / 1000),
      end_date: Math.floor(endDate.getTime() / 1000),
      listing_ids: listings,
    };

    await createEtsyCoupon(shopId, apiKey, accessToken, payload);

    const promotion: Promotion = {
      id: randomUUID(),
      type: 'flash-sale',
      discountPercent,
      couponCode,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      targetListings: listings,
      status: 'active',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await savePromotion(promotion);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'promotions-engine',
      action: 'flash-sale-created',
      productId: promotion.id,
      details:
        `Flash sale ${couponCode} (${discountPercent}% off, ${hours}h, ` +
        `${listings.length} listings)`,
      duration: 0,
      success: true,
    });

    logger.info(`Flash sale created: ${couponCode} (${promotion.id})`);

    return {
      promotionId: promotion.id,
      couponCode,
      listingsApplied: listings,
      status: 'active',
    };
  }

  async recoverAbandonedFavorites(): Promise<PromotionResult> {
    await ensureDirectories();

    logger.info('Creating recovery coupon for abandoned favorites');

    const { client, apiKey, shopId, accessToken } = await initEtsyAuth();
    const now = new Date();
    const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const couponCode = generateCouponCode('COMEBACK');
    const discountPercent = 10;

    // Get all active listings to apply the recovery coupon broadly
    const activeListings = await getAllActiveListingIds();

    if (activeListings.length === 0) {
      logger.warn('No active listings found for recovery coupon');
      return {
        promotionId: '',
        couponCode: '',
        listingsApplied: [],
        status: 'failed',
      };
    }

    const payload: EtsyCouponPayload = {
      coupon_code: couponCode,
      pct_discount: discountPercent,
      start_date: Math.floor(now.getTime() / 1000),
      end_date: Math.floor(endDate.getTime() / 1000),
      listing_ids: activeListings,
    };

    await createEtsyCoupon(shopId, apiKey, accessToken, payload);

    const promotion: Promotion = {
      id: randomUUID(),
      type: 'recovery',
      discountPercent,
      couponCode,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      targetListings: activeListings,
      status: 'active',
      campaignName: 'Abandoned Favorites Recovery',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await savePromotion(promotion);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'promotions-engine',
      action: 'recovery-coupon-created',
      productId: promotion.id,
      details:
        `Recovery coupon ${couponCode} (${discountPercent}% off, ` +
        `${activeListings.length} listings, 7-day window)`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Recovery coupon created: ${couponCode} (${promotion.id})`
    );

    return {
      promotionId: promotion.id,
      couponCode,
      listingsApplied: activeListings,
      status: 'active',
    };
  }

  async createRepeatBuyerCoupon(buyerId: string): Promise<PromotionResult> {
    await ensureDirectories();

    logger.info(`Creating repeat buyer coupon for buyer: ${buyerId}`);

    const now = new Date();
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const couponCode = generateCouponCode('THANKYOU');
    const discountPercent = 15;
    const activeListings = await getAllActiveListingIds();

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const payload: EtsyCouponPayload = {
      coupon_code: couponCode,
      pct_discount: discountPercent,
      start_date: Math.floor(now.getTime() / 1000),
      end_date: Math.floor(endDate.getTime() / 1000),
    };

    if (activeListings.length > 0) {
      payload.listing_ids = activeListings;
    }

    await createEtsyCoupon(shopId, apiKey, accessToken, payload);

    const promotion: Promotion = {
      id: randomUUID(),
      type: 'coupon',
      discountPercent,
      couponCode,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      targetListings: activeListings,
      status: 'active',
      campaignName: `Repeat Buyer Thank You — ${buyerId}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await savePromotion(promotion);

    await logActivity({
      timestamp: now.toISOString(),
      agent: 'promotions-engine',
      action: 'repeat-buyer-coupon-created',
      productId: promotion.id,
      details:
        `Repeat buyer coupon ${couponCode} (${discountPercent}% off) ` +
        `for buyer ${buyerId}`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Repeat buyer coupon created: ${couponCode} for ${buyerId} ` +
        `(${promotion.id})`
    );

    return {
      promotionId: promotion.id,
      couponCode,
      listingsApplied: activeListings,
      status: 'active',
    };
  }

  async getUpcomingCampaigns(): Promise<SeasonalCampaign[]> {
    const now = new Date();
    return SEASONAL_CAMPAIGNS.filter((campaign) =>
      campaignStartsWithinDays(campaign, now, 30)
    );
  }

  async getActiveCampaigns(): Promise<Promotion[]> {
    await ensureDirectories();
    const promotions = await loadAllPromotions(ACTIVE_DIR);
    return promotions.filter((p) => p.status === 'active');
  }

  async endCampaign(promotionId: string): Promise<PromotionResult> {
    logger.info(`Ending campaign: ${promotionId}`);

    const promotion = await loadPromotion(promotionId);

    if (promotion.status !== 'active') {
      throw new PromotionError(
        `Cannot end promotion with status "${promotion.status}"`,
        promotionId
      );
    }

    // Archive the promotion
    const now = new Date().toISOString();
    promotion.status = 'completed';
    promotion.endDate = now;
    promotion.updatedAt = now;

    // Move file from active to archive
    const activePath = getPromotionPath(promotionId, false);
    const archivePath = getPromotionPath(promotionId, true);

    try {
      await mkdir(ARCHIVE_DIR, { recursive: true });
      await rename(activePath, archivePath);
    } catch {
      // If rename fails, save directly to archive
      await savePromotion(promotion);
    }

    // Update the archived file with final status
    await writeFile(
      archivePath,
      JSON.stringify(promotion, null, 2),
      'utf-8'
    );

    await logActivity({
      timestamp: now,
      agent: 'promotions-engine',
      action: 'campaign-ended',
      productId: promotionId,
      details:
        `Ended campaign "${promotion.campaignName ?? promotion.couponCode}" ` +
        `(${promotion.type})`,
      duration: 0,
      success: true,
    });

    logger.info(`Campaign ${promotionId} ended and archived`);

    return {
      promotionId,
      couponCode: promotion.couponCode,
      listingsApplied: promotion.targetListings,
      status: 'completed',
    };
  }

  async checkAndLaunchCampaigns(): Promise<PromotionResult[]> {
    logger.info('Checking for campaigns to launch');

    const now = new Date();
    const results: PromotionResult[] = [];

    // Check which seasonal campaigns should be active now
    const activeCampaigns = SEASONAL_CAMPAIGNS.filter((campaign) =>
      campaignMatchesNow(campaign, now)
    );

    if (activeCampaigns.length === 0) {
      logger.info('No seasonal campaigns to launch today');
      return results;
    }

    // Load existing active promotions to avoid duplicates
    const existingPromotions = await this.getActiveCampaigns();
    const existingNames = new Set(
      existingPromotions
        .map((p) => p.campaignName)
        .filter((n): n is string => n !== undefined)
    );

    for (const campaign of activeCampaigns) {
      if (existingNames.has(campaign.name)) {
        logger.info(
          `Campaign "${campaign.name}" already active, skipping`
        );
        continue;
      }

      try {
        const result = await this.createSeasonalSale(campaign);
        results.push(result);
        logger.info(`Launched seasonal campaign: ${campaign.name}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to launch campaign "${campaign.name}": ${message}`
        );
      }
    }

    // Also check for expired active promotions and end them
    const allActive = await this.getActiveCampaigns();
    for (const promotion of allActive) {
      if (new Date(promotion.endDate) < now) {
        try {
          await this.endCampaign(promotion.id);
          logger.info(
            `Auto-ended expired promotion: ${promotion.id} ` +
              `(${promotion.campaignName ?? promotion.couponCode})`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to auto-end promotion ${promotion.id}: ${message}`
          );
        }
      }
    }

    logger.info(
      `Campaign check complete: ${results.length} new campaigns launched`
    );

    return results;
  }

  async getPromotionMetrics(
    promotionId: string
  ): Promise<PromotionMetrics> {
    logger.info(`Fetching metrics for promotion: ${promotionId}`);

    const promotion = await loadPromotion(promotionId);

    // Default metrics when API call is not possible
    let usageCount = 0;
    let revenueAttributed = 0;

    try {
      const { apiKey, shopId, accessToken } = await initEtsyAuth();

      // Etsy coupons are identified by code; retrieve stats
      // Note: Etsy API may require coupon_id, which we derive from the code
      const url =
        `${BASE_URL}/application/shops/${shopId}/coupons` +
        `?coupon_code=${promotion.couponCode}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as {
          results: Array<{
            coupon_id: number;
            usage_count?: number;
          }>;
        };
        if (data.results.length > 0) {
          const couponData = data.results[0];
          const couponId = couponData.coupon_id;
          const stats = await getEtsyCouponStats(
            shopId,
            apiKey,
            accessToken,
            couponId
          );
          usageCount = stats.usage_count;
          revenueAttributed = stats.revenue;
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `Could not fetch live metrics for ${promotionId}: ${message}`
      );
    }

    return {
      promotionId,
      couponCode: promotion.couponCode,
      usageCount,
      revenueAttributed,
      startDate: promotion.startDate,
      endDate: promotion.endDate,
      status: promotion.status,
    };
  }
}

// ── Exported Utility ─────────────────────────────────────────────────

export function generateCouponCode(prefix: string): string {
  let suffix = '';
  for (let i = 0; i < COUPON_CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * COUPON_CODE_CHARS.length);
    suffix += COUPON_CODE_CHARS[index];
  }
  const sanitizedPrefix = prefix
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return `${sanitizedPrefix}-${suffix}`;
}
