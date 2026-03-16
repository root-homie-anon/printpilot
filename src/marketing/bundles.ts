import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { EtsyClient } from '../etsy/client.js';
import { EtsyOAuth } from '../etsy/oauth.js';
import { getEnvOrThrow } from '../utils/env.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), 'state/marketing/bundles');
const LISTINGS_DIR = resolve(process.cwd(), 'state/listings');

const BASE_URL = 'https://api.etsy.com/v3';

const MIN_BUNDLE_SIZE = 2;
const MAX_BUNDLE_SIZE = 5;
const DEFAULT_BUNDLE_DISCOUNT = 15;
const CROSS_PROMO_MAX_LINKS = 3;

// ── Product Type Categories (for complementarity scoring) ────────────

const PRODUCT_CATEGORIES: Record<string, string[]> = {
  'planning': [
    'planner', 'weekly-planner', 'daily-planner', 'monthly-planner',
    'study-planner', 'academic-planner', 'productivity-planner',
    'wedding-planner', 'travel-planner', 'meal-planner',
  ],
  'tracking': [
    'tracker', 'habit-tracker', 'fitness-tracker', 'mood-tracker',
    'reading-tracker', 'savings-tracker', 'weight-tracker',
    'water-tracker', 'sleep-tracker', 'expense-tracker', 'period-tracker',
  ],
  'journaling': [
    'journal', 'gratitude-journal', 'daily-journal', 'bullet-journal',
    'prayer-journal', 'self-care-journal', 'mindfulness-journal',
  ],
  'worksheets': [
    'worksheet', 'budget-worksheet', 'goals-worksheet', 'checklist',
    'to-do-list', 'template', 'inventory', 'log',
  ],
};

// ── Types ────────────────────────────────────────────────────────────

export type BundleStatus = 'draft' | 'active' | 'disbanded' | 'failed';

export interface Bundle {
  id: string;
  name: string;
  productIds: string[];
  bundleListingId: number | null;
  discountPercent: number;
  niche: string;
  status: BundleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BundleCandidate {
  productIds: string[];
  niche: string;
  score: number;
  suggestedName: string;
  suggestedDiscount: number;
}

export interface ShopSection {
  id: number;
  name: string;
  niche: string;
  listingIds: number[];
}

export interface CrossPromotion {
  sourceListingId: number;
  targetListingIds: number[];
  insertedText: string;
}

export interface BundleResult {
  bundleId: string;
  bundleListingId: number | null;
  status: BundleStatus;
  productCount: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export class BundleError extends Error {
  public readonly bundleId?: string;

  constructor(message: string, bundleId?: string) {
    super(
      bundleId
        ? `Bundle error (${bundleId}): ${message}`
        : `Bundle error: ${message}`
    );
    this.name = 'BundleError';
    this.bundleId = bundleId;
  }
}

// ── Listing State Shape ──────────────────────────────────────────────

interface ListingState {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  price: number;
  status: string;
  niche?: string;
  productId?: string;
  etsyUrl?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function ensureDirectories(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

function getBundlePath(id: string): string {
  return join(STATE_DIR, `${id}.json`);
}

async function saveBundle(bundle: Bundle): Promise<void> {
  const filePath = getBundlePath(bundle.id);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
  logger.debug(`Saved bundle ${bundle.id} (status: ${bundle.status})`);
}

async function loadBundle(id: string): Promise<Bundle> {
  const filePath = getBundlePath(id);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Bundle;
  } catch {
    throw new BundleError(`Bundle not found: ${id}`, id);
  }
}

async function loadAllBundles(): Promise<Bundle[]> {
  const bundles: Bundle[] = [];
  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch {
    return bundles;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(STATE_DIR, file), 'utf-8');
      bundles.push(JSON.parse(raw) as Bundle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load bundle file ${file}: ${message}`);
    }
  }

  return bundles;
}

async function loadAllListings(): Promise<ListingState[]> {
  const listings: ListingState[] = [];
  let files: string[];
  try {
    files = await readdir(LISTINGS_DIR);
  } catch {
    return listings;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(LISTINGS_DIR, file), 'utf-8');
      listings.push(JSON.parse(raw) as ListingState);
    } catch {
      // Skip unreadable listing files
    }
  }

  return listings;
}

function getActiveListings(listings: ListingState[]): ListingState[] {
  return listings.filter((l) => l.status === 'active');
}

function groupListingsByNiche(
  listings: ListingState[]
): Map<string, ListingState[]> {
  const groups = new Map<string, ListingState[]>();

  for (const listing of listings) {
    const niche = (listing.niche ?? '').toLowerCase();
    if (!niche) {
      continue;
    }
    const existing = groups.get(niche) ?? [];
    existing.push(listing);
    groups.set(niche, existing);
  }

  return groups;
}

function getProductCategory(niche: string): string | undefined {
  const normalized = niche.toLowerCase();
  for (const [category, niches] of Object.entries(PRODUCT_CATEGORIES)) {
    if (niches.some((n) => normalized.includes(n) || n.includes(normalized))) {
      return category;
    }
  }
  return undefined;
}

function scoreComplementarity(listings: ListingState[]): number {
  if (listings.length < MIN_BUNDLE_SIZE) {
    return 0;
  }

  let score = 0;
  const categories = new Set<string>();
  const niches = new Set<string>();

  for (const listing of listings) {
    const niche = (listing.niche ?? '').toLowerCase();
    niches.add(niche);
    const category = getProductCategory(niche);
    if (category) {
      categories.add(category);
    }
  }

  // Multiple distinct categories = complementary products (best bundles)
  // e.g., planner + tracker + journal = 3 categories
  score += categories.size * 25;

  // Bonus for having diverse niches within same broad niche family
  score += Math.min(niches.size * 10, 30);

  // Ideal bundle size bonus (3-4 items)
  if (listings.length >= 3 && listings.length <= 4) {
    score += 20;
  } else if (listings.length === 2) {
    score += 10;
  }

  // Cap at 100
  return Math.min(score, 100);
}

function generateSuggestedName(
  listings: ListingState[],
  niche: string
): string {
  const categories = new Set<string>();
  for (const listing of listings) {
    const cat = getProductCategory((listing.niche ?? '').toLowerCase());
    if (cat) {
      categories.add(cat);
    }
  }

  const nicheLabel = niche
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  if (categories.size > 1) {
    const catLabels = [...categories]
      .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
      .join(' + ');
    return `${nicheLabel} ${catLabels} Bundle`;
  }

  return `${nicheLabel} Complete Bundle — ${listings.length} Products`;
}

function calculateBundleDiscount(itemCount: number): number {
  // More items = slightly higher discount
  if (itemCount >= 4) {
    return 20;
  }
  if (itemCount >= 3) {
    return 15;
  }
  return 10;
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

// ── Etsy Shop Section API Helpers ────────────────────────────────────

interface EtsyShopSection {
  shop_section_id: number;
  title: string;
}

interface EtsyShopSectionsResponse {
  count: number;
  results: EtsyShopSection[];
}

async function getEtsyShopSections(
  shopId: string,
  apiKey: string,
  accessToken: string
): Promise<EtsyShopSection[]> {
  const url = `${BASE_URL}/application/shops/${shopId}/sections`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BundleError(
      `Failed to fetch shop sections (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as EtsyShopSectionsResponse;
  return data.results;
}

async function createEtsyShopSection(
  shopId: string,
  apiKey: string,
  accessToken: string,
  title: string
): Promise<EtsyShopSection> {
  const url = `${BASE_URL}/application/shops/${shopId}/sections`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BundleError(
      `Failed to create shop section (${response.status}): ${body}`
    );
  }

  return (await response.json()) as EtsyShopSection;
}

async function updateEtsyListingSection(
  shopId: string,
  apiKey: string,
  accessToken: string,
  listingId: number,
  sectionId: number
): Promise<void> {
  const url =
    `${BASE_URL}/application/shops/${shopId}/listings/${listingId}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ shop_section_id: sectionId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BundleError(
      `Failed to assign listing ${listingId} to section ${sectionId} ` +
        `(${response.status}): ${body}`
    );
  }
}

async function updateEtsyListingDescription(
  shopId: string,
  apiKey: string,
  accessToken: string,
  listingId: number,
  description: string
): Promise<void> {
  const url =
    `${BASE_URL}/application/shops/${shopId}/listings/${listingId}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ description }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new BundleError(
      `Failed to update listing ${listingId} description ` +
        `(${response.status}): ${body}`
    );
  }
}

// ── Core Class: BundleEngine ─────────────────────────────────────────

export class BundleEngine {
  async detectBundleCandidates(): Promise<BundleCandidate[]> {
    logger.info('Scanning listings for bundle candidates');

    const allListings = await loadAllListings();
    const activeListings = getActiveListings(allListings);

    if (activeListings.length < MIN_BUNDLE_SIZE) {
      logger.info(
        `Only ${activeListings.length} active listings — need at least ` +
          `${MIN_BUNDLE_SIZE} for a bundle`
      );
      return [];
    }

    // Load existing bundles to exclude already-bundled products
    const existingBundles = await loadAllBundles();
    const bundledProductIds = new Set<string>();
    for (const bundle of existingBundles) {
      if (bundle.status === 'active') {
        for (const pid of bundle.productIds) {
          bundledProductIds.add(pid);
        }
      }
    }

    // Filter out already-bundled listings
    const availableListings = activeListings.filter(
      (l) => !l.productId || !bundledProductIds.has(l.productId)
    );

    if (availableListings.length < MIN_BUNDLE_SIZE) {
      logger.info('Not enough unbundled listings for new bundle candidates');
      return [];
    }

    // Group by broad niche family for candidate generation
    const nicheGroups = groupListingsByNiche(availableListings);
    const candidates: BundleCandidate[] = [];

    // Strategy 1: Same-niche bundles (e.g., multiple fitness trackers)
    for (const [niche, listings] of nicheGroups) {
      if (listings.length < MIN_BUNDLE_SIZE) {
        continue;
      }

      const bundleListings = listings.slice(0, MAX_BUNDLE_SIZE);
      const score = scoreComplementarity(bundleListings);
      const productIds = bundleListings
        .map((l) => l.productId)
        .filter((pid): pid is string => pid !== undefined);

      if (productIds.length < MIN_BUNDLE_SIZE) {
        continue;
      }

      candidates.push({
        productIds,
        niche,
        score,
        suggestedName: generateSuggestedName(bundleListings, niche),
        suggestedDiscount: calculateBundleDiscount(productIds.length),
      });
    }

    // Strategy 2: Cross-niche bundles within same broad category
    const categoryGroups = new Map<string, ListingState[]>();
    for (const listing of availableListings) {
      const category = getProductCategory(
        (listing.niche ?? '').toLowerCase()
      );
      if (!category) {
        continue;
      }
      const existing = categoryGroups.get(category) ?? [];
      existing.push(listing);
      categoryGroups.set(category, existing);
    }

    // Build cross-niche candidates from different categories sharing a theme
    const allCategories = [...categoryGroups.keys()];
    if (allCategories.length >= 2) {
      // Try mixing items from different categories
      const crossListings: ListingState[] = [];
      for (const category of allCategories) {
        const catListings = categoryGroups.get(category) ?? [];
        if (catListings.length > 0) {
          crossListings.push(catListings[0]);
        }
        if (crossListings.length >= MAX_BUNDLE_SIZE) {
          break;
        }
      }

      if (crossListings.length >= MIN_BUNDLE_SIZE) {
        const score = scoreComplementarity(crossListings);
        const productIds = crossListings
          .map((l) => l.productId)
          .filter((pid): pid is string => pid !== undefined);

        if (productIds.length >= MIN_BUNDLE_SIZE) {
          const primaryNiche = (crossListings[0].niche ?? 'mixed').toLowerCase();
          candidates.push({
            productIds,
            niche: primaryNiche,
            score,
            suggestedName: generateSuggestedName(crossListings, primaryNiche),
            suggestedDiscount: calculateBundleDiscount(productIds.length),
          });
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    logger.info(`Found ${candidates.length} bundle candidates`);
    return candidates;
  }

  async createBundle(candidate: BundleCandidate): Promise<BundleResult> {
    await ensureDirectories();

    logger.info(
      `Creating bundle: "${candidate.suggestedName}" ` +
        `(${candidate.productIds.length} products, ${candidate.suggestedDiscount}% off)`
    );

    // Load listing data for each product
    const allListings = await loadAllListings();
    const listingMap = new Map<string, ListingState>();
    for (const listing of allListings) {
      if (listing.productId) {
        listingMap.set(listing.productId, listing);
      }
    }

    const bundleListings: ListingState[] = [];
    for (const pid of candidate.productIds) {
      const listing = listingMap.get(pid);
      if (!listing) {
        throw new BundleError(
          `Listing not found for product ${pid} — cannot create bundle`
        );
      }
      bundleListings.push(listing);
    }

    // Calculate bundle price
    const totalIndividualPrice = bundleListings.reduce(
      (sum, l) => sum + l.price,
      0
    );
    const discountAmount = totalIndividualPrice * (candidate.suggestedDiscount / 100);
    const bundlePrice = Math.round((totalIndividualPrice - discountAmount) * 100) / 100;

    // Generate bundle listing content
    const title = this.generateBundleTitle(bundleListings);
    const description = this.generateBundleDescription(
      bundleListings,
      totalIndividualPrice,
      bundlePrice,
      candidate.suggestedDiscount
    );

    // Collect all tags from component listings, deduplicate, take top 13
    const allTags: string[] = [];
    for (const listing of bundleListings) {
      for (const tag of listing.tags) {
        if (!allTags.includes(tag.toLowerCase())) {
          allTags.push(tag.toLowerCase());
        }
      }
    }
    // Prepend bundle-specific tags
    const bundleTags = [
      'bundle',
      'printable bundle',
      'digital bundle',
      ...allTags,
    ];
    const uniqueTags = [...new Set(bundleTags)].slice(0, 13);

    // Publish bundle listing via Etsy API
    let bundleListingId: number | null = null;

    try {
      const { client } = await initEtsyAuth();

      const draftListing = await client.createDraftListing({
        title,
        description,
        price: bundlePrice,
        tags: uniqueTags,
        categoryId: 1281,
        isDigital: true,
        whoMade: 'i_did',
        whenMade: 'made_to_order',
        taxonomyId: 1281,
      });

      bundleListingId = draftListing.listingId;

      // Upload digital files from each component product
      for (const listing of bundleListings) {
        const productDir = resolve(
          process.cwd(),
          'state/products',
          listing.productId ?? ''
        );
        const pdfPath = join(productDir, 'product.pdf');

        try {
          await client.uploadDigitalFile(bundleListingId, pdfPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to upload PDF for product ${listing.productId} ` +
              `to bundle listing ${bundleListingId}: ${message}`
          );
        }
      }

      // Publish the bundle listing
      await client.publishListing(bundleListingId);
      logger.info(`Bundle listing published: ${bundleListingId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to publish bundle listing: ${message}`);

      // Save as failed bundle
      const failedBundle: Bundle = {
        id: randomUUID(),
        name: candidate.suggestedName,
        productIds: candidate.productIds,
        bundleListingId: null,
        discountPercent: candidate.suggestedDiscount,
        niche: candidate.niche,
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveBundle(failedBundle);

      return {
        bundleId: failedBundle.id,
        bundleListingId: null,
        status: 'failed',
        productCount: candidate.productIds.length,
      };
    }

    // Save bundle state
    const bundle: Bundle = {
      id: randomUUID(),
      name: candidate.suggestedName,
      productIds: candidate.productIds,
      bundleListingId,
      discountPercent: candidate.suggestedDiscount,
      niche: candidate.niche,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveBundle(bundle);

    // Write bundle listing metadata to listings dir
    if (bundleListingId !== null) {
      await mkdir(LISTINGS_DIR, { recursive: true });

      const bundleListingMeta = {
        listingId: bundleListingId,
        title,
        description,
        tags: uniqueTags,
        price: bundlePrice,
        status: 'active',
        niche: candidate.niche,
        isBundle: true,
        bundleId: bundle.id,
        componentProductIds: candidate.productIds,
        publishedAt: new Date().toISOString(),
      };

      await writeFile(
        join(LISTINGS_DIR, `${bundleListingId}.json`),
        JSON.stringify(bundleListingMeta, null, 2),
        'utf-8'
      );
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'bundle-engine',
      action: 'bundle-created',
      productId: bundle.id,
      details:
        `Created bundle "${bundle.name}" (${candidate.productIds.length} products, ` +
        `${candidate.suggestedDiscount}% off, listing ${bundleListingId})`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Bundle created: ${bundle.id} — "${bundle.name}" ` +
        `(listing ${bundleListingId})`
    );

    return {
      bundleId: bundle.id,
      bundleListingId,
      status: 'active',
      productCount: candidate.productIds.length,
    };
  }

  generateBundleTitle(products: ListingState[]): string {
    // Build a concise, appealing title from component products
    const niches = new Set<string>();
    for (const product of products) {
      const niche = (product.niche ?? '').toLowerCase();
      if (niche) {
        niches.add(niche);
      }
    }

    const nicheLabels = [...niches]
      .slice(0, 3)
      .map((n) =>
        n
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      );

    const nicheStr = nicheLabels.join(' + ');
    const count = products.length;

    return `${nicheStr} Printable Bundle — ${count} Digital Products | Instant Download`;
  }

  generateBundleDescription(
    products: ListingState[],
    originalTotal: number,
    bundlePrice: number,
    discountPercent: number
  ): string {
    const savings = Math.round((originalTotal - bundlePrice) * 100) / 100;

    const lines: string[] = [
      `✨ BUNDLE & SAVE ${discountPercent}% ✨`,
      '',
      `Get ${products.length} beautiful printable products for just ` +
        `$${bundlePrice.toFixed(2)} (save $${savings.toFixed(2)}!)`,
      '',
      '📦 THIS BUNDLE INCLUDES:',
      '',
    ];

    for (const product of products) {
      lines.push(`• ${product.title}`);
    }

    lines.push(
      '',
      '🎯 WHAT YOU GET:',
      `• ${products.length} professionally designed printable PDFs`,
      '• Instant digital download — no waiting!',
      '• Print at home or at your local print shop',
      '• US Letter (8.5 x 11) format',
      '',
      '💡 WHY BUY THE BUNDLE?',
      `• Save ${discountPercent}% compared to buying individually`,
      '• Coordinated design style across all products',
      '• Everything you need in one purchase',
      '',
      `Individual value: $${originalTotal.toFixed(2)}`,
      `Bundle price: $${bundlePrice.toFixed(2)}`,
      `You save: $${savings.toFixed(2)} (${discountPercent}% off!)`,
      '',
      '📥 INSTANT DOWNLOAD',
      'After purchase, download your files directly from Etsy. ' +
        'No physical product will be shipped.',
    );

    return lines.join('\n');
  }

  async addCrossPromotions(listingId: number): Promise<CrossPromotion | null> {
    logger.info(`Adding cross-promotions to listing ${listingId}`);

    const allListings = await loadAllListings();
    const activeListings = getActiveListings(allListings);

    // Find the source listing
    const sourceListing = activeListings.find(
      (l) => l.listingId === listingId
    );

    if (!sourceListing) {
      logger.warn(`Listing ${listingId} not found or not active`);
      return null;
    }

    const sourceNiche = (sourceListing.niche ?? '').toLowerCase();

    // Find related listings (same niche or complementary category)
    const sourceCategory = getProductCategory(sourceNiche);

    const relatedListings = activeListings
      .filter((l) => {
        if (l.listingId === listingId) {
          return false;
        }
        const lNiche = (l.niche ?? '').toLowerCase();
        const lCategory = getProductCategory(lNiche);

        // Same niche or same category
        return lNiche === sourceNiche || lCategory === sourceCategory;
      })
      .slice(0, CROSS_PROMO_MAX_LINKS);

    if (relatedListings.length === 0) {
      logger.info(`No related listings found for listing ${listingId}`);
      return null;
    }

    // Build cross-promo text
    const promoLines: string[] = [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '✨ YOU MIGHT ALSO LIKE:',
      '',
    ];

    for (const related of relatedListings) {
      const url = related.etsyUrl ?? '';
      promoLines.push(`• ${related.title}`);
      if (url) {
        promoLines.push(`  ${url}`);
      }
    }

    // Check for active bundles that include this product
    const bundles = await loadAllBundles();
    const relevantBundles = bundles.filter(
      (b) =>
        b.status === 'active' &&
        sourceListing.productId !== undefined &&
        b.productIds.includes(sourceListing.productId)
    );

    if (relevantBundles.length > 0) {
      promoLines.push('');
      promoLines.push('💰 SAVE MORE WITH A BUNDLE:');
      for (const bundle of relevantBundles) {
        promoLines.push(
          `• ${bundle.name} — Save ${bundle.discountPercent}%!`
        );
      }
    }

    const insertedText = promoLines.join('\n');

    // Append to listing description via Etsy API
    const existingDescription = sourceListing.description;

    // Remove any previous cross-promo section before appending new one
    const promoMarker = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let cleanDescription = existingDescription;
    const markerIndex = cleanDescription.indexOf(promoMarker);
    if (markerIndex !== -1) {
      cleanDescription = cleanDescription.substring(0, markerIndex).trimEnd();
    }

    const updatedDescription = cleanDescription + '\n' + insertedText;

    try {
      const { apiKey, shopId, accessToken } = await initEtsyAuth();
      await updateEtsyListingDescription(
        shopId,
        apiKey,
        accessToken,
        listingId,
        updatedDescription
      );

      logger.info(
        `Cross-promotions added to listing ${listingId}: ` +
          `${relatedListings.length} related products`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to update listing ${listingId} with cross-promotions: ${message}`
      );
      return null;
    }

    const targetListingIds = relatedListings
      .map((l) => l.listingId)
      .filter((id): id is number => id !== undefined);

    const crossPromo: CrossPromotion = {
      sourceListingId: listingId,
      targetListingIds,
      insertedText,
    };

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'bundle-engine',
      action: 'cross-promotion-added',
      productId: String(listingId),
      details:
        `Added ${relatedListings.length} cross-promotions to listing ${listingId}`,
      duration: 0,
      success: true,
    });

    return crossPromo;
  }

  async organizeShopSections(): Promise<ShopSection[]> {
    logger.info('Organizing shop sections by niche');

    const { apiKey, shopId, accessToken } = await initEtsyAuth();

    // Get existing shop sections
    const existingSections = await getEtsyShopSections(
      shopId,
      apiKey,
      accessToken
    );

    const sectionMap = new Map<string, EtsyShopSection>();
    for (const section of existingSections) {
      sectionMap.set(section.title.toLowerCase(), section);
    }

    // Load all active listings and group by niche
    const allListings = await loadAllListings();
    const activeListings = getActiveListings(allListings);
    const nicheGroups = groupListingsByNiche(activeListings);

    const organizedSections: ShopSection[] = [];

    for (const [niche, listings] of nicheGroups) {
      const sectionTitle = niche
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      // Find or create section
      let section = sectionMap.get(sectionTitle.toLowerCase());

      if (!section) {
        try {
          section = await createEtsyShopSection(
            shopId,
            apiKey,
            accessToken,
            sectionTitle
          );
          logger.info(`Created shop section: "${sectionTitle}"`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to create shop section "${sectionTitle}": ${message}`
          );
          continue;
        }
      }

      // Assign listings to the section
      const listingIds: number[] = [];
      for (const listing of listings) {
        try {
          await updateEtsyListingSection(
            shopId,
            apiKey,
            accessToken,
            listing.listingId,
            section.shop_section_id
          );
          listingIds.push(listing.listingId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to assign listing ${listing.listingId} to section ` +
              `"${sectionTitle}": ${message}`
          );
        }
      }

      organizedSections.push({
        id: section.shop_section_id,
        name: sectionTitle,
        niche,
        listingIds,
      });
    }

    // Create a "Bundles" section for bundle listings
    const bundleListings = activeListings.filter((l) => {
      // Check if listing metadata has isBundle flag
      return (l as unknown as Record<string, unknown>).isBundle === true;
    });

    if (bundleListings.length > 0) {
      let bundleSection = sectionMap.get('bundles');

      if (!bundleSection) {
        try {
          bundleSection = await createEtsyShopSection(
            shopId,
            apiKey,
            accessToken,
            'Bundles'
          );
          logger.info('Created "Bundles" shop section');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to create Bundles shop section: ${message}`
          );
        }
      }

      if (bundleSection) {
        const bundleListingIds: number[] = [];
        for (const listing of bundleListings) {
          try {
            await updateEtsyListingSection(
              shopId,
              apiKey,
              accessToken,
              listing.listingId,
              bundleSection.shop_section_id
            );
            bundleListingIds.push(listing.listingId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(
              `Failed to assign bundle listing ${listing.listingId} ` +
                `to Bundles section: ${message}`
            );
          }
        }

        organizedSections.push({
          id: bundleSection.shop_section_id,
          name: 'Bundles',
          niche: 'bundles',
          listingIds: bundleListingIds,
        });
      }
    }

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'bundle-engine',
      action: 'shop-sections-organized',
      productId: '',
      details:
        `Organized ${organizedSections.length} shop sections ` +
        `across ${activeListings.length} listings`,
      duration: 0,
      success: true,
    });

    logger.info(
      `Shop sections organized: ${organizedSections.length} sections`
    );

    return organizedSections;
  }

  async getActiveBundles(): Promise<Bundle[]> {
    await ensureDirectories();
    const allBundles = await loadAllBundles();
    return allBundles.filter((b) => b.status === 'active');
  }

  async disbandBundle(bundleId: string): Promise<BundleResult> {
    logger.info(`Disbanding bundle: ${bundleId}`);

    const bundle = await loadBundle(bundleId);

    if (bundle.status !== 'active') {
      throw new BundleError(
        `Cannot disband bundle with status "${bundle.status}"`,
        bundleId
      );
    }

    // Deactivate the bundle listing on Etsy
    if (bundle.bundleListingId !== null) {
      try {
        const { apiKey, shopId, accessToken } = await initEtsyAuth();

        const url =
          `${BASE_URL}/application/shops/${shopId}/listings/${bundle.bundleListingId}`;

        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ state: 'inactive' }),
        });

        if (!response.ok) {
          const body = await response.text();
          logger.warn(
            `Failed to deactivate bundle listing ${bundle.bundleListingId}: ${body}`
          );
        } else {
          logger.info(
            `Bundle listing ${bundle.bundleListingId} deactivated on Etsy`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to deactivate bundle listing on Etsy: ${message}`
        );
      }

      // Remove bundle listing metadata from state
      const listingMetaPath = join(
        LISTINGS_DIR,
        `${bundle.bundleListingId}.json`
      );
      try {
        await unlink(listingMetaPath);
      } catch {
        // File may not exist — that's fine
      }
    }

    // Update bundle state
    const now = new Date().toISOString();
    bundle.status = 'disbanded';
    bundle.updatedAt = now;
    await saveBundle(bundle);

    await logActivity({
      timestamp: now,
      agent: 'bundle-engine',
      action: 'bundle-disbanded',
      productId: bundleId,
      details:
        `Disbanded bundle "${bundle.name}" ` +
        `(listing ${bundle.bundleListingId})`,
      duration: 0,
      success: true,
    });

    logger.info(`Bundle ${bundleId} disbanded`);

    return {
      bundleId,
      bundleListingId: bundle.bundleListingId,
      status: 'disbanded',
      productCount: bundle.productIds.length,
    };
  }

  async refreshBundles(): Promise<BundleResult[]> {
    logger.info('Refreshing bundles — checking for new combinations');

    const results: BundleResult[] = [];

    // Check if existing bundles need updates
    const activeBundles = await this.getActiveBundles();
    const allListings = await loadAllListings();
    const activeListings = getActiveListings(allListings);
    const activeListingProductIds = new Set<string>();
    for (const listing of activeListings) {
      if (listing.productId) {
        activeListingProductIds.add(listing.productId);
      }
    }

    // Disband bundles whose component products are no longer active
    for (const bundle of activeBundles) {
      const activeProductCount = bundle.productIds.filter((pid) =>
        activeListingProductIds.has(pid)
      ).length;

      if (activeProductCount < MIN_BUNDLE_SIZE) {
        logger.info(
          `Bundle "${bundle.name}" has only ${activeProductCount} active ` +
            `products — disbanding`
        );
        try {
          const result = await this.disbandBundle(bundle.id);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to disband stale bundle ${bundle.id}: ${message}`
          );
        }
      }
    }

    // Detect and create new bundle candidates
    const candidates = await this.detectBundleCandidates();

    // Only create bundles that score above threshold
    const MIN_BUNDLE_SCORE = 30;
    const viableCandidates = candidates.filter(
      (c) => c.score >= MIN_BUNDLE_SCORE
    );

    for (const candidate of viableCandidates) {
      try {
        const result = await this.createBundle(candidate);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to create bundle for niche "${candidate.niche}": ${message}`
        );
      }
    }

    // Refresh cross-promotions on all active listings
    for (const listing of activeListings) {
      try {
        await this.addCrossPromotions(listing.listingId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `Failed to refresh cross-promotions for listing ` +
            `${listing.listingId}: ${message}`
        );
      }
    }

    logger.info(
      `Bundle refresh complete: ${results.length} bundle actions taken`
    );

    return results;
  }
}
