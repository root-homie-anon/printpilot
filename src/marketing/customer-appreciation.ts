import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import { PromotionsEngine, generateCouponCode } from './promotions.js';
import { renderPdf } from '../renderer/render.js';

// ── Types ───────────────────────────────────────────────────────────

export type VipStatus = 'regular' | 'returning' | 'vip';

export type AppreciationActionType =
  | 'thank-you-note'
  | 'free-product'
  | 'vip-early-access'
  | 'loyalty-coupon';

export type AppreciationActionStatus =
  | 'pending'
  | 'delivered'
  | 'failed';

export interface CustomerProfile {
  buyerId: string;
  name: string;
  email: string;
  purchaseCount: number;
  totalSpent: number;
  firstPurchaseAt: string;
  lastPurchaseAt: string;
  vipStatus: VipStatus;
  productsOwned: string[];
}

export interface AppreciationAction {
  id: string;
  buyerId: string;
  type: AppreciationActionType;
  productId: string;
  status: AppreciationActionStatus;
  createdAt: string;
  deliveredAt?: string;
  error?: string;
}

export interface VipTier {
  tierName: VipStatus;
  minPurchases: number;
  benefits: string[];
}

export interface AppreciationConfig {
  freePurchaseThreshold: number;
  vipThreshold: number;
  loyaltyCouponPercent: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export class CustomerAppreciationError extends Error {
  public readonly buyerId?: string;

  constructor(message: string, buyerId?: string) {
    super(
      buyerId
        ? `Customer appreciation error (buyer ${buyerId}): ${message}`
        : `Customer appreciation error: ${message}`
    );
    this.name = 'CustomerAppreciationError';
    this.buyerId = buyerId;
  }
}

// ── Constants ───────────────────────────────────────────────────────

const CUSTOMERS_DIR = resolve(process.cwd(), 'state/marketing/customers');
const ACTIONS_DIR = join(CUSTOMERS_DIR, 'actions');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');
const PRODUCTS_DIR = resolve(process.cwd(), 'state/products');
const THANK_YOU_DIR = resolve(process.cwd(), 'state/marketing/thank-you-notes');

const BASE_URL = 'https://api.etsy.com/v3';

const DEFAULT_CONFIG: AppreciationConfig = {
  freePurchaseThreshold: 3,
  vipThreshold: 5,
  loyaltyCouponPercent: 20,
};

const VIP_TIERS: VipTier[] = [
  {
    tierName: 'regular',
    minPurchases: 1,
    benefits: ['Standard thank-you message'],
  },
  {
    tierName: 'returning',
    minPurchases: 3,
    benefits: [
      'Surprise free product on 3rd purchase',
      'Personalized thank-you note PDF',
    ],
  },
  {
    tierName: 'vip',
    minPurchases: 5,
    benefits: [
      'Early access to new products',
      '20% loyalty coupon',
      'Personalized thank-you note PDF',
      'Priority support',
    ],
  },
];

// ── Internal Types ──────────────────────────────────────────────────

interface EtsyTransactionRaw {
  transaction_id: number;
  buyer_user_id: number;
  listing_id: number;
  price: { amount: string; divisor: number; currency_code: string };
  paid_tsf: { amount: string; divisor: number; currency_code: string };
  create_timestamp: number;
}

interface EtsyTransactionsPage {
  count: number;
  results: EtsyTransactionRaw[];
}

interface EtsyUserRaw {
  user_id: number;
  login_name: string;
  primary_email?: string;
}

interface ListingMetadata {
  listingId: number;
  etsyUrl: string;
  title: string;
  price: number;
  productId: string;
  niche: string;
  status: string;
  digitalFileUrl?: string;
}

interface MilestoneCheckResult {
  hitFreePurchaseMilestone: boolean;
  hitVipMilestone: boolean;
  newVipStatus: VipStatus;
  previousVipStatus: VipStatus;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function ensureDirectories(): Promise<void> {
  await mkdir(CUSTOMERS_DIR, { recursive: true });
  await mkdir(ACTIONS_DIR, { recursive: true });
  await mkdir(THANK_YOU_DIR, { recursive: true });
}

function getCustomerPath(buyerId: string): string {
  return join(CUSTOMERS_DIR, `${buyerId}.json`);
}

function getActionPath(actionId: string): string {
  return join(ACTIONS_DIR, `${actionId}.json`);
}

function determineVipStatus(
  purchaseCount: number,
  config: AppreciationConfig
): VipStatus {
  if (purchaseCount >= config.vipThreshold) {
    return 'vip';
  }
  if (purchaseCount >= config.freePurchaseThreshold) {
    return 'returning';
  }
  return 'regular';
}

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

async function sendEtsyMessage(
  shopId: string,
  apiKey: string,
  accessToken: string,
  recipientId: string,
  subject: string,
  body: string
): Promise<void> {
  const url = `${BASE_URL}/application/shops/${shopId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to_user_id: recipientId,
      subject,
      body,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new CustomerAppreciationError(
      `Failed to send Etsy message (${response.status}): ${responseBody}`,
      recipientId
    );
  }

  logger.debug(`Etsy message sent to ${recipientId}: "${subject}"`);
}

function generateThankYouHtml(
  buyerName: string,
  purchaseCount: number,
  vipStatus: VipStatus
): string {
  const tierLabel =
    vipStatus === 'vip'
      ? 'VIP Customer'
      : vipStatus === 'returning'
        ? 'Valued Returning Customer'
        : 'Valued Customer';

  const milestoneMessage =
    purchaseCount >= 5
      ? `This is your ${purchaseCount}th purchase — you're one of our most ` +
        'valued VIP customers!'
      : purchaseCount >= 3
        ? `This is your ${purchaseCount}th purchase — thank you for being ` +
          'a loyal returning customer!'
        : 'Thank you for choosing us!';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    @page { size: A4; margin: 0; }
    body {
      font-family: 'Georgia', serif;
      margin: 0;
      padding: 60px;
      background: #fefcf9;
      color: #2c2c2c;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: calc(297mm - 120px);
    }
    .card {
      border: 2px solid #d4a574;
      border-radius: 16px;
      padding: 60px 50px;
      max-width: 500px;
      text-align: center;
      background: #fffdf8;
    }
    .badge {
      display: inline-block;
      background: #d4a574;
      color: white;
      padding: 6px 20px;
      border-radius: 20px;
      font-size: 12px;
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 28px;
      color: #5a3e2b;
      margin: 0 0 16px;
      font-weight: normal;
    }
    .name {
      font-size: 32px;
      color: #d4a574;
      font-style: italic;
      margin: 0 0 24px;
    }
    .message {
      font-size: 16px;
      line-height: 1.8;
      color: #4a4a4a;
      margin: 0 0 32px;
    }
    .milestone {
      font-size: 14px;
      color: #8b7355;
      font-style: italic;
      margin: 0 0 24px;
    }
    .signature {
      font-size: 14px;
      color: #8b7355;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${tierLabel}</div>
    <h1>Thank You,</h1>
    <p class="name">${escapeHtml(buyerName)}</p>
    <p class="message">
      Your support means the world to us. Every purchase helps us
      continue creating products we're passionate about, and we're
      so grateful you chose to be part of that journey.
    </p>
    <p class="milestone">${milestoneMessage}</p>
    <p class="signature">With gratitude and appreciation</p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Core Class: CustomerAppreciationEngine ──────────────────────────

export class CustomerAppreciationEngine {
  private readonly config: AppreciationConfig;
  private readonly shopId: string;
  private readonly promotionsEngine: PromotionsEngine;

  constructor(config?: Partial<AppreciationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shopId = getEnvOrThrow('ETSY_SHOP_ID');
    this.promotionsEngine = new PromotionsEngine();
  }

  // ── Profile Sync ────────────────────────────────────────────────

  async syncCustomerProfiles(): Promise<number> {
    await ensureDirectories();

    logger.info('Syncing customer profiles from Etsy transactions');

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    // Fetch all transactions from Etsy
    const transactions = await this.fetchAllTransactions(
      shopId,
      apiKey,
      accessToken
    );

    logger.info(`Fetched ${transactions.length} transactions from Etsy`);

    // Group transactions by buyer
    const buyerTransactions = new Map<string, EtsyTransactionRaw[]>();

    for (const tx of transactions) {
      const buyerId = String(tx.buyer_user_id);
      const existing = buyerTransactions.get(buyerId) ?? [];
      existing.push(tx);
      buyerTransactions.set(buyerId, existing);
    }

    let updatedCount = 0;

    for (const [buyerId, txs] of buyerTransactions) {
      try {
        const existingProfile = await this.loadCustomerProfile(buyerId);
        const profile = await this.buildProfileFromTransactions(
          buyerId,
          txs,
          shopId,
          apiKey,
          accessToken,
          existingProfile
        );
        await this.saveCustomerProfile(profile);
        updatedCount++;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to sync profile for buyer ${buyerId}: ${message}`
        );
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'customer-appreciation',
      action: 'profiles-synced',
      productId: '',
      details:
        `Synced ${updatedCount} customer profiles from ` +
        `${transactions.length} transactions`,
      duration: 0,
      success: true,
    });

    logger.info(`Customer profile sync complete: ${updatedCount} profiles updated`);

    return updatedCount;
  }

  // ── Milestone Check ─────────────────────────────────────────────

  async checkMilestones(buyerId: string): Promise<MilestoneCheckResult> {
    logger.info(`Checking milestones for buyer ${buyerId}`);

    const profile = await this.loadCustomerProfileOrThrow(buyerId);
    const previousVipStatus = profile.vipStatus;
    const newVipStatus = determineVipStatus(
      profile.purchaseCount,
      this.config
    );

    const hitFreePurchaseMilestone =
      profile.purchaseCount === this.config.freePurchaseThreshold;
    const hitVipMilestone =
      profile.purchaseCount === this.config.vipThreshold;

    // Update VIP status if it changed
    if (newVipStatus !== previousVipStatus) {
      profile.vipStatus = newVipStatus;
      await this.saveCustomerProfile(profile);

      logger.info(
        `Buyer ${buyerId} upgraded from ${previousVipStatus} ` +
          `to ${newVipStatus}`
      );
    }

    const result: MilestoneCheckResult = {
      hitFreePurchaseMilestone,
      hitVipMilestone,
      newVipStatus,
      previousVipStatus,
    };

    logger.info(
      `Milestone check for ${buyerId}: ` +
        `purchases=${profile.purchaseCount}, ` +
        `free=${hitFreePurchaseMilestone}, vip=${hitVipMilestone}`
    );

    return result;
  }

  // ── Free Product Award ──────────────────────────────────────────

  async awardFreeProduct(buyerId: string): Promise<AppreciationAction> {
    await ensureDirectories();

    logger.info(`Awarding free product to buyer ${buyerId}`);

    const profile = await this.loadCustomerProfileOrThrow(buyerId);

    // Check if free product was already awarded
    const existingActions = await this.loadActionsForBuyer(buyerId);
    const alreadyAwarded = existingActions.some(
      (a) => a.type === 'free-product' && a.status === 'delivered'
    );

    if (alreadyAwarded) {
      throw new CustomerAppreciationError(
        'Free product already awarded to this buyer',
        buyerId
      );
    }

    // Find a complementary product the buyer doesn't own
    const complementaryProduct = await this.findComplementaryProduct(
      profile.productsOwned
    );

    if (!complementaryProduct) {
      throw new CustomerAppreciationError(
        'No complementary product available for this buyer',
        buyerId
      );
    }

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    // Send Etsy message with the free product download link
    const subject = 'A special gift just for you!';
    const body = [
      `Hi ${profile.name}!`,
      '',
      `We noticed this is your ${profile.purchaseCount}th purchase ` +
        'from our shop, and we wanted to say a huge THANK YOU!',
      '',
      'As a token of our appreciation, we\'d love to give you a ' +
        'complimentary copy of:',
      '',
      `"${complementaryProduct.title}"`,
      '',
      complementaryProduct.digitalFileUrl
        ? `You can download it here: ${complementaryProduct.digitalFileUrl}`
        : `Listing: ${complementaryProduct.etsyUrl}`,
      '',
      'No strings attached — it\'s our way of saying thanks for ' +
        'being such a loyal customer!',
      '',
      'Warm regards',
    ].join('\n');

    await sendEtsyMessage(
      shopId,
      apiKey,
      accessToken,
      buyerId,
      subject,
      body
    );

    const action: AppreciationAction = {
      id: randomUUID(),
      buyerId,
      type: 'free-product',
      productId: complementaryProduct.productId,
      status: 'delivered',
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    };

    await this.saveAction(action);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'customer-appreciation',
      action: 'free-product-awarded',
      productId: complementaryProduct.productId,
      details:
        `Awarded free product "${complementaryProduct.title}" ` +
        `to buyer ${buyerId} (purchase #${profile.purchaseCount})`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Free product "${complementaryProduct.title}" awarded to ` +
        `buyer ${buyerId}`
    );

    return action;
  }

  // ── VIP Early Access ────────────────────────────────────────────

  async grantVipEarlyAccess(
    buyerId: string,
    productId: string
  ): Promise<AppreciationAction> {
    await ensureDirectories();

    logger.info(
      `Granting VIP early access to buyer ${buyerId} for ` +
        `product ${productId}`
    );

    const profile = await this.loadCustomerProfileOrThrow(buyerId);

    if (profile.vipStatus !== 'vip') {
      throw new CustomerAppreciationError(
        `Buyer ${buyerId} is not VIP status ` +
          `(current: ${profile.vipStatus})`,
        buyerId
      );
    }

    // Load product details
    const productListing = await this.loadListingByProductId(productId);
    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const subject = 'VIP Early Access: New product just for you!';
    const body = [
      `Hi ${profile.name}!`,
      '',
      'As one of our valued VIP customers, you get exclusive early ' +
        'access to our newest product before it goes live in the shop:',
      '',
      `"${productListing.title}"`,
      '',
      productListing.etsyUrl
        ? `Check it out here: ${productListing.etsyUrl}`
        : 'It will be available in our shop shortly.',
      '',
      'This listing is available to you before anyone else. ' +
        'Thank you for being such an amazing supporter of our shop!',
      '',
      'Best wishes',
    ].join('\n');

    await sendEtsyMessage(
      shopId,
      apiKey,
      accessToken,
      buyerId,
      subject,
      body
    );

    const action: AppreciationAction = {
      id: randomUUID(),
      buyerId,
      type: 'vip-early-access',
      productId,
      status: 'delivered',
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    };

    await this.saveAction(action);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'customer-appreciation',
      action: 'vip-early-access-granted',
      productId,
      details:
        `VIP early access to "${productListing.title}" ` +
        `granted to buyer ${buyerId}`,
      duration: 0,
      success: true,
    });

    logger.info(
      `VIP early access granted to buyer ${buyerId} for ` +
        `product ${productId}`
    );

    return action;
  }

  // ── Loyalty Coupon ──────────────────────────────────────────────

  async sendLoyaltyCoupon(buyerId: string): Promise<AppreciationAction> {
    await ensureDirectories();

    logger.info(`Sending loyalty coupon to buyer ${buyerId}`);

    const profile = await this.loadCustomerProfileOrThrow(buyerId);

    if (profile.vipStatus !== 'vip') {
      throw new CustomerAppreciationError(
        `Buyer ${buyerId} is not VIP status ` +
          `(current: ${profile.vipStatus})`,
        buyerId
      );
    }

    // Check if a loyalty coupon was already sent recently
    const existingActions = await this.loadActionsForBuyer(buyerId);
    const recentCoupon = existingActions.find((a) => {
      if (a.type !== 'loyalty-coupon' || a.status !== 'delivered') {
        return false;
      }
      const deliveredAt = new Date(a.deliveredAt ?? a.createdAt);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return deliveredAt > thirtyDaysAgo;
    });

    if (recentCoupon) {
      throw new CustomerAppreciationError(
        'Loyalty coupon already sent within the last 30 days',
        buyerId
      );
    }

    // Create coupon via promotions engine
    const couponResult = await this.promotionsEngine.createCoupon({
      discountPercent: this.config.loyaltyCouponPercent,
      prefix: 'VIP',
      campaignName: `VIP Loyalty — ${buyerId}`,
    });

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    const subject = 'A special VIP reward just for you!';
    const body = [
      `Hi ${profile.name}!`,
      '',
      `As one of our most valued VIP customers with ` +
        `${profile.purchaseCount} purchases, we wanted to give you ` +
        'an exclusive discount:',
      '',
      `Use code: ${couponResult.couponCode}`,
      `Discount: ${this.config.loyaltyCouponPercent}% off your next purchase`,
      '',
      'This code is valid for 30 days and works on any product in our shop.',
      '',
      'Thank you for being such an incredible part of our community!',
      '',
      'Warm regards',
    ].join('\n');

    await sendEtsyMessage(
      shopId,
      apiKey,
      accessToken,
      buyerId,
      subject,
      body
    );

    const action: AppreciationAction = {
      id: randomUUID(),
      buyerId,
      type: 'loyalty-coupon',
      productId: couponResult.promotionId,
      status: 'delivered',
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    };

    await this.saveAction(action);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'customer-appreciation',
      action: 'loyalty-coupon-sent',
      productId: couponResult.promotionId,
      details:
        `Loyalty coupon ${couponResult.couponCode} ` +
        `(${this.config.loyaltyCouponPercent}% off) sent to ` +
        `VIP buyer ${buyerId}`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Loyalty coupon ${couponResult.couponCode} sent to ` +
        `buyer ${buyerId}`
    );

    return action;
  }

  // ── Thank-You Note PDF ──────────────────────────────────────────

  async generateThankYouNotePdf(
    buyerName: string,
    purchaseCount: number
  ): Promise<string> {
    await ensureDirectories();

    logger.info(
      `Generating thank-you note PDF for ${buyerName} ` +
        `(purchase #${purchaseCount})`
    );

    const vipStatus = determineVipStatus(purchaseCount, this.config);
    const html = generateThankYouHtml(buyerName, purchaseCount, vipStatus);

    const sanitizedName = buyerName
      .replace(/[^a-zA-Z0-9]/g, '-')
      .toLowerCase();
    const htmlPath = join(
      THANK_YOU_DIR,
      `thank-you-${sanitizedName}-${Date.now()}.html`
    );
    const pdfPath = join(
      THANK_YOU_DIR,
      `thank-you-${sanitizedName}-${Date.now()}.pdf`
    );

    await writeFile(htmlPath, html, 'utf-8');

    await renderPdf(htmlPath, pdfPath, {
      pageSize: 'A4',
      dpi: 300,
    });

    logger.info(`Thank-you note PDF generated: ${pdfPath}`);

    return pdfPath;
  }

  // ── Daily Transaction Processing ────────────────────────────────

  async processNewTransactions(): Promise<ProcessTransactionsResult> {
    await ensureDirectories();

    logger.info('Processing new transactions for customer appreciation');

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    // Fetch recent transactions (last 24 hours)
    const transactions = await this.fetchRecentTransactions(
      shopId,
      apiKey,
      accessToken
    );

    logger.info(
      `Found ${transactions.length} recent transactions to process`
    );

    let profilesUpdated = 0;
    let freeProductsAwarded = 0;
    let vipUpgrades = 0;
    let loyaltyCouponsSent = 0;
    let errors = 0;

    // Group by buyer
    const buyerTransactions = new Map<string, EtsyTransactionRaw[]>();

    for (const tx of transactions) {
      const buyerId = String(tx.buyer_user_id);
      const existing = buyerTransactions.get(buyerId) ?? [];
      existing.push(tx);
      buyerTransactions.set(buyerId, existing);
    }

    for (const [buyerId] of buyerTransactions) {
      try {
        // Sync this buyer's full profile first
        const allTx = await this.fetchBuyerTransactions(
          shopId,
          apiKey,
          accessToken,
          buyerId
        );
        const existingProfile = await this.loadCustomerProfile(buyerId);
        const profile = await this.buildProfileFromTransactions(
          buyerId,
          allTx,
          shopId,
          apiKey,
          accessToken,
          existingProfile
        );
        await this.saveCustomerProfile(profile);
        profilesUpdated++;

        // Check milestones
        const milestones = await this.checkMilestones(buyerId);

        // Award free product on 3rd purchase
        if (milestones.hitFreePurchaseMilestone) {
          try {
            await this.awardFreeProduct(buyerId);
            freeProductsAwarded++;
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.warn(
              `Failed to award free product to ${buyerId}: ${message}`
            );
            errors++;
          }
        }

        // Send loyalty coupon on VIP upgrade
        if (
          milestones.hitVipMilestone &&
          milestones.newVipStatus === 'vip'
        ) {
          vipUpgrades++;
          try {
            await this.sendLoyaltyCoupon(buyerId);
            loyaltyCouponsSent++;
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.warn(
              `Failed to send loyalty coupon to ${buyerId}: ${message}`
            );
            errors++;
          }
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to process transactions for buyer ${buyerId}: ${message}`
        );
        errors++;
      }
    }

    const result: ProcessTransactionsResult = {
      profilesUpdated,
      freeProductsAwarded,
      vipUpgrades,
      loyaltyCouponsSent,
      errors,
    };

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'customer-appreciation',
      action: 'transactions-processed',
      productId: '',
      details:
        `Processed ${transactions.length} transactions: ` +
        `${profilesUpdated} profiles, ` +
        `${freeProductsAwarded} free products, ` +
        `${vipUpgrades} VIP upgrades, ` +
        `${loyaltyCouponsSent} loyalty coupons, ` +
        `${errors} errors`,
      duration: 0,
      success: errors === 0,
    });

    logger.info(
      `Transaction processing complete: ` +
        `${profilesUpdated} profiles updated, ` +
        `${freeProductsAwarded} free products awarded, ` +
        `${vipUpgrades} VIP upgrades, ` +
        `${loyaltyCouponsSent} loyalty coupons sent`
    );

    return result;
  }

  // ── Query Methods ───────────────────────────────────────────────

  async getVipCustomers(): Promise<CustomerProfile[]> {
    logger.info('Fetching all VIP customers');

    const profiles = await this.loadAllCustomerProfiles();
    const vipProfiles = profiles.filter((p) => p.vipStatus === 'vip');

    logger.info(`Found ${vipProfiles.length} VIP customers`);

    return vipProfiles;
  }

  async getCustomerProfile(buyerId: string): Promise<CustomerProfile> {
    return this.loadCustomerProfileOrThrow(buyerId);
  }

  async getAppreciationHistory(
    buyerId: string
  ): Promise<AppreciationAction[]> {
    logger.info(`Fetching appreciation history for buyer ${buyerId}`);

    const actions = await this.loadActionsForBuyer(buyerId);

    logger.info(
      `Found ${actions.length} appreciation actions for buyer ${buyerId}`
    );

    return actions;
  }

  // ── Etsy Transaction Fetching ───────────────────────────────────

  private async fetchAllTransactions(
    shopId: string,
    apiKey: string,
    accessToken: string
  ): Promise<EtsyTransactionRaw[]> {
    const allTransactions: EtsyTransactionRaw[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url =
        `${BASE_URL}/application/shops/${shopId}/transactions` +
        `?limit=${limit}&offset=${offset}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CustomerAppreciationError(
          `Failed to fetch transactions (${response.status}): ${body}`
        );
      }

      const data = (await response.json()) as EtsyTransactionsPage;
      allTransactions.push(...data.results);

      if (data.results.length < limit) {
        break;
      }

      offset += limit;
    }

    return allTransactions;
  }

  private async fetchRecentTransactions(
    shopId: string,
    apiKey: string,
    accessToken: string
  ): Promise<EtsyTransactionRaw[]> {
    const oneDayAgo = Math.floor(
      (Date.now() - 24 * 60 * 60 * 1000) / 1000
    );

    const url =
      `${BASE_URL}/application/shops/${shopId}/transactions` +
      `?limit=100&min_created=${oneDayAgo}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new CustomerAppreciationError(
        `Failed to fetch recent transactions (${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as EtsyTransactionsPage;
    return data.results;
  }

  private async fetchBuyerTransactions(
    shopId: string,
    apiKey: string,
    accessToken: string,
    buyerId: string
  ): Promise<EtsyTransactionRaw[]> {
    const url =
      `${BASE_URL}/application/shops/${shopId}/transactions` +
      `?limit=100&buyer_user_id=${buyerId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new CustomerAppreciationError(
        `Failed to fetch buyer transactions (${response.status}): ${body}`,
        buyerId
      );
    }

    const data = (await response.json()) as EtsyTransactionsPage;
    return data.results;
  }

  // ── Profile Building ────────────────────────────────────────────

  private async buildProfileFromTransactions(
    buyerId: string,
    transactions: EtsyTransactionRaw[],
    shopId: string,
    apiKey: string,
    accessToken: string,
    existingProfile: CustomerProfile | null
  ): Promise<CustomerProfile> {
    // Sort transactions by date
    const sorted = [...transactions].sort(
      (a, b) => a.create_timestamp - b.create_timestamp
    );

    const purchaseCount = sorted.length;
    const totalSpent = sorted.reduce((sum, tx) => {
      const amount = parseFloat(tx.price.amount) / tx.price.divisor;
      return sum + amount;
    }, 0);

    const productsOwned = [
      ...new Set(sorted.map((tx) => String(tx.listing_id))),
    ];

    const firstPurchaseAt = sorted.length > 0
      ? new Date(sorted[0].create_timestamp * 1000).toISOString()
      : new Date().toISOString();

    const lastPurchaseAt = sorted.length > 0
      ? new Date(
          sorted[sorted.length - 1].create_timestamp * 1000
        ).toISOString()
      : new Date().toISOString();

    const vipStatus = determineVipStatus(purchaseCount, this.config);

    // Try to get buyer name from existing profile or Etsy API
    let name = existingProfile?.name ?? '';
    let email = existingProfile?.email ?? '';

    if (!name) {
      try {
        const userUrl =
          `${BASE_URL}/application/users/${buyerId}`;

        const response = await fetch(userUrl, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        if (response.ok) {
          const userData = (await response.json()) as EtsyUserRaw;
          name = userData.login_name;
          email = userData.primary_email ?? '';
        }
      } catch {
        logger.debug(`Could not fetch user details for ${buyerId}`);
      }
    }

    if (!name) {
      name = `Buyer ${buyerId}`;
    }

    return {
      buyerId,
      name,
      email,
      purchaseCount,
      totalSpent,
      firstPurchaseAt,
      lastPurchaseAt,
      vipStatus,
      productsOwned,
    };
  }

  // ── Product Selection ───────────────────────────────────────────

  private async findComplementaryProduct(
    ownedProductIds: string[]
  ): Promise<ListingMetadata | null> {
    let files: string[];
    try {
      files = await readdir(LISTINGS_DIR);
    } catch {
      logger.debug('No listings directory found');
      return null;
    }

    const ownedSet = new Set(ownedProductIds);

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const filePath = join(LISTINGS_DIR, file);
        const raw = await readFile(filePath, 'utf-8');
        const listing = JSON.parse(raw) as ListingMetadata;

        // Skip products the buyer already owns
        if (
          ownedSet.has(listing.productId) ||
          ownedSet.has(String(listing.listingId))
        ) {
          continue;
        }

        // Only select active listings
        if (listing.status !== 'active') {
          continue;
        }

        return listing;
      } catch {
        continue;
      }
    }

    return null;
  }

  private async loadListingByProductId(
    productId: string
  ): Promise<ListingMetadata> {
    let files: string[];
    try {
      files = await readdir(LISTINGS_DIR);
    } catch {
      throw new CustomerAppreciationError(
        `No listings directory found when looking for product ${productId}`
      );
    }

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const filePath = join(LISTINGS_DIR, file);
        const raw = await readFile(filePath, 'utf-8');
        const listing = JSON.parse(raw) as ListingMetadata;

        if (listing.productId === productId) {
          return listing;
        }
      } catch {
        continue;
      }
    }

    throw new CustomerAppreciationError(
      `Listing not found for product ${productId}`
    );
  }

  // ── State Persistence ───────────────────────────────────────────

  private async saveCustomerProfile(
    profile: CustomerProfile
  ): Promise<void> {
    await mkdir(CUSTOMERS_DIR, { recursive: true });
    const filePath = getCustomerPath(profile.buyerId);
    await writeFile(
      filePath,
      JSON.stringify(profile, null, 2),
      'utf-8'
    );
    logger.debug(`Saved customer profile for ${profile.buyerId}`);
  }

  private async loadCustomerProfile(
    buyerId: string
  ): Promise<CustomerProfile | null> {
    const filePath = getCustomerPath(buyerId);

    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as CustomerProfile;
    } catch {
      return null;
    }
  }

  private async loadCustomerProfileOrThrow(
    buyerId: string
  ): Promise<CustomerProfile> {
    const profile = await this.loadCustomerProfile(buyerId);

    if (!profile) {
      throw new CustomerAppreciationError(
        `Customer profile not found for buyer ${buyerId}`,
        buyerId
      );
    }

    return profile;
  }

  private async loadAllCustomerProfiles(): Promise<CustomerProfile[]> {
    let files: string[];
    try {
      files = await readdir(CUSTOMERS_DIR);
    } catch {
      logger.debug('No customers directory found');
      return [];
    }

    const profiles: CustomerProfile[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(CUSTOMERS_DIR, file), 'utf-8');
        profiles.push(JSON.parse(raw) as CustomerProfile);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to load customer profile from ${file}: ${message}`
        );
      }
    }

    return profiles;
  }

  private async saveAction(action: AppreciationAction): Promise<void> {
    await mkdir(ACTIONS_DIR, { recursive: true });
    const filePath = getActionPath(action.id);
    await writeFile(
      filePath,
      JSON.stringify(action, null, 2),
      'utf-8'
    );
    logger.debug(`Saved appreciation action ${action.id}`);
  }

  private async loadActionsForBuyer(
    buyerId: string
  ): Promise<AppreciationAction[]> {
    let files: string[];
    try {
      files = await readdir(ACTIONS_DIR);
    } catch {
      return [];
    }

    const actions: AppreciationAction[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await readFile(join(ACTIONS_DIR, file), 'utf-8');
        const action = JSON.parse(raw) as AppreciationAction;

        if (action.buyerId === buyerId) {
          actions.push(action);
        }
      } catch {
        continue;
      }
    }

    return actions;
  }
}

// ── Result Types ────────────────────────────────────────────────────

interface ProcessTransactionsResult {
  profilesUpdated: number;
  freeProductsAwarded: number;
  vipUpgrades: number;
  loyaltyCouponsSent: number;
  errors: number;
}
