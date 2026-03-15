import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { scrapeListingDetails } from './etsy-scraper.js';
import type { ListingDetail } from './types.js';

// --- Exported interfaces ---

export interface CompetitiveIntel {
  niche: string;
  analyzedAt: string;
  topSellers: SellerProfile[];
  bestPractices: NicheBestPractices;
  pricingStrategy: PricingStrategy;
  referenceListings: ReferenceListingData[];
}

export interface SellerProfile {
  shopName: string;
  shopSales: number;
  avgPrice: number;
  avgReviews: number;
  listingCount: number;
  strengths: string[];
}

export interface NicheBestPractices {
  photoPatterns: {
    coverStyle: string;
    imageCount: number;
    mockupTypes: string[];
    thumbnailApproach: string;
  };
  descriptionPatterns: {
    avgLength: number;
    structure: string[];
    commonEmojis: boolean;
    keySellingPoints: string[];
  };
  titlePatterns: {
    avgLength: number;
    frontLoadedKeywords: string[];
    commonFormats: string[];
  };
  tagPatterns: {
    commonTags: string[];
    tagCategories: { broad: string[]; specific: string[]; longTail: string[] };
  };
  productPatterns: {
    avgPageCount: number;
    commonSections: string[];
    layoutStyle: string;
    colorSchemes: string[];
    fontStyles: string[];
  };
}

export interface PricingStrategy {
  priceDistribution: {
    min: number;
    max: number;
    median: number;
    p25: number;
    p75: number;
  };
  tiers: {
    budget: { range: [number, number]; sellerCount: number; avgReviews: number };
    mid: { range: [number, number]; sellerCount: number; avgReviews: number };
    premium: { range: [number, number]; sellerCount: number; avgReviews: number };
  };
  recommendedPrice: number;
  recommendedTier: 'budget' | 'mid' | 'premium';
  priceReasoning: string;
  undercutTarget: number;
  undercutMargin: number;
}

export interface ReferenceListingData {
  url: string;
  title: string;
  price: number;
  reviews: number;
  favorites: number;
  tags: string[];
  descriptionExcerpt: string;
  imageUrls: string[];
  whyReference: string;
  structuralPatterns: string[];
}

// --- Custom errors ---

class CompetitiveIntelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompetitiveIntelError';
  }
}

// --- Constants ---

const DEFAULT_MAX_REFS = 5;
const MIN_LISTINGS_FOR_ANALYSIS = 2;
const SCRAPE_CONCURRENCY = 3;
const HIGH_REVIEW_THRESHOLD = 100;
const DESCRIPTION_EXCERPT_LENGTH = 500;

// --- Helper functions ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function scrapeInBatches(
  urls: string[],
  concurrency: number,
): Promise<ListingDetail[]> {
  const results: ListingDetail[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((url) => scrapeListingDetails(url)),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value.title) {
        results.push(result.value);
      } else if (result.status === 'rejected') {
        const message = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        logger.warn(`Failed to scrape listing: ${message}`);
      }
    }
  }

  return results;
}

function buildSellerProfiles(listings: ListingDetail[]): SellerProfile[] {
  const sellerMap = new Map<string, ListingDetail[]>();

  for (const listing of listings) {
    if (!listing.shopName) {
      continue;
    }
    const existing = sellerMap.get(listing.shopName) ?? [];
    existing.push(listing);
    sellerMap.set(listing.shopName, existing);
  }

  const profiles: SellerProfile[] = [];

  for (const [shopName, shopListings] of sellerMap) {
    const prices = shopListings.map((l) => l.price).filter((p) => p > 0);
    const reviews = shopListings.map((l) => l.reviews);
    const shopSales = Math.max(...shopListings.map((l) => l.shopSales));

    const strengths: string[] = [];
    const avgReviews = average(reviews);
    const avgPrice = average(prices);

    if (avgReviews > HIGH_REVIEW_THRESHOLD) {
      strengths.push('high review count');
    }
    if (shopSales > 10000) {
      strengths.push('high total shop sales');
    }
    if (shopListings.length >= 3) {
      strengths.push('multiple listings in niche');
    }
    if (avgPrice > 0 && avgReviews > 0 && avgReviews / avgPrice > 10) {
      strengths.push('strong reviews-to-price ratio');
    }

    profiles.push({
      shopName,
      shopSales,
      avgPrice: round2(avgPrice),
      avgReviews: round2(avgReviews),
      listingCount: shopListings.length,
      strengths,
    });
  }

  return profiles.sort((a, b) => b.avgReviews - a.avgReviews);
}

function countTagOccurrences(listings: ListingDetail[]): Map<string, number> {
  const tagCounts = new Map<string, number>();
  for (const listing of listings) {
    for (const tag of listing.tags) {
      const normalized = tag.toLowerCase().trim();
      if (normalized) {
        tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
      }
    }
  }
  return tagCounts;
}

// --- Main exported functions ---

export function buildPricingStrategy(listings: ListingDetail[]): PricingStrategy {
  const prices = listings
    .map((l) => l.price)
    .filter((p) => p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) {
    logger.warn('No valid prices found for pricing strategy');
    return {
      priceDistribution: { min: 0, max: 0, median: 0, p25: 0, p75: 0 },
      tiers: {
        budget: { range: [0, 0], sellerCount: 0, avgReviews: 0 },
        mid: { range: [0, 0], sellerCount: 0, avgReviews: 0 },
        premium: { range: [0, 0], sellerCount: 0, avgReviews: 0 },
      },
      recommendedPrice: 0,
      recommendedTier: 'mid',
      priceReasoning: 'Insufficient pricing data to form a strategy.',
      undercutTarget: 0,
      undercutMargin: 0,
    };
  }

  const min = prices[0];
  const max = prices[prices.length - 1];
  const p25 = round2(percentile(prices, 25));
  const p50 = round2(percentile(prices, 50));
  const p75 = round2(percentile(prices, 75));

  // Define tier boundaries based on percentiles
  const budgetCeiling = p25;
  const premiumFloor = p75;

  // Classify listings into tiers
  const budgetListings = listings.filter((l) => l.price > 0 && l.price <= budgetCeiling);
  const premiumListings = listings.filter((l) => l.price >= premiumFloor);
  const midListings = listings.filter(
    (l) => l.price > budgetCeiling && l.price < premiumFloor,
  );

  const budgetReviews = budgetListings.map((l) => l.reviews);
  const midReviews = midListings.map((l) => l.reviews);
  const premiumReviews = premiumListings.map((l) => l.reviews);

  const tiers = {
    budget: {
      range: [round2(min), round2(budgetCeiling)] as [number, number],
      sellerCount: budgetListings.length,
      avgReviews: round2(average(budgetReviews)),
    },
    mid: {
      range: [round2(budgetCeiling), round2(premiumFloor)] as [number, number],
      sellerCount: midListings.length,
      avgReviews: round2(average(midReviews)),
    },
    premium: {
      range: [round2(premiumFloor), round2(max)] as [number, number],
      sellerCount: premiumListings.length,
      avgReviews: round2(average(premiumReviews)),
    },
  };

  // Find the weakest top seller: high reviews but not the highest price
  // "Top seller" = 100+ reviews; "weakest" = lowest price among them
  const topSellers = listings
    .filter((l) => l.reviews >= HIGH_REVIEW_THRESHOLD && l.price > 0)
    .sort((a, b) => a.price - b.price);

  // Median price among sellers with 100+ reviews
  const topSellerPrices = topSellers.map((l) => l.price);
  const topSellerMedian = median(topSellerPrices);

  // For new listings, enter at the lower end of mid tier
  const lowerMid = round2(budgetCeiling + (premiumFloor - budgetCeiling) * 0.3);
  const recommendedPrice = topSellerMedian > 0
    ? round2(Math.min(topSellerMedian * 0.95, lowerMid))
    : round2(lowerMid);

  // Undercut target: the cheapest top seller
  const undercutTarget = topSellers.length > 0 ? topSellers[0].price : p50;
  const undercutMargin = round2(Math.max(0.5, undercutTarget * 0.05));

  let recommendedTier: 'budget' | 'mid' | 'premium' = 'mid';
  if (recommendedPrice <= budgetCeiling) {
    recommendedTier = 'budget';
  } else if (recommendedPrice >= premiumFloor) {
    recommendedTier = 'premium';
  }

  const priceReasoning = topSellers.length > 0
    ? `Recommending $${recommendedPrice} — at or below the median ($${topSellerMedian}) ` +
      `of sellers with ${HIGH_REVIEW_THRESHOLD}+ reviews. Entering at lower-mid tier to build ` +
      `reviews quickly. Undercut the cheapest proven seller ($${undercutTarget}) by $${undercutMargin}.`
    : `Recommending $${recommendedPrice} at the lower end of the mid tier ($${tiers.mid.range[0]}–$${tiers.mid.range[1]}). ` +
      `Insufficient high-review sellers to calculate undercut strategy.`;

  return {
    priceDistribution: { min: round2(min), max: round2(max), median: p50, p25, p75 },
    tiers,
    recommendedPrice,
    recommendedTier,
    priceReasoning,
    undercutTarget: round2(undercutTarget),
    undercutMargin,
  };
}

export async function extractBestPracticesWithAI(
  niche: string,
  listings: ListingDetail[],
): Promise<NicheBestPractices> {
  logger.info(`Extracting best practices for niche: ${niche}`, {
    listingCount: listings.length,
  });

  if (listings.length < MIN_LISTINGS_FOR_ANALYSIS) {
    throw new CompetitiveIntelError(
      `Need at least ${MIN_LISTINGS_FOR_ANALYSIS} listings to extract best practices, got ${listings.length}`,
    );
  }

  // Pre-compute quantitative metrics
  const avgDescLength = round2(
    average(listings.map((l) => l.description.length)),
  );
  const avgTitleLength = round2(
    average(listings.map((l) => l.title.length)),
  );
  const avgImageCount = round2(
    average(listings.map((l) => l.images.length)),
  );

  // Sort listings by reviews descending to emphasize top performers
  const sortedByReviews = [...listings].sort((a, b) => b.reviews - a.reviews);
  const topPerformers = sortedByReviews.slice(0, Math.ceil(listings.length / 2));
  const restPerformers = sortedByReviews.slice(Math.ceil(listings.length / 2));

  // Compute common tags
  const tagCounts = countTagOccurrences(listings);
  const commonTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag]) => tag);

  // Build the prompt with structured data
  const topListingData = topPerformers.map((l) => ({
    title: l.title,
    price: l.price,
    reviews: l.reviews,
    favorites: l.favorites,
    descriptionPreview: l.description.slice(0, 800),
    tags: l.tags,
    imageCount: l.images.length,
    shopName: l.shopName,
    shopSales: l.shopSales,
  }));

  const avgListingData = restPerformers.map((l) => ({
    title: l.title,
    price: l.price,
    reviews: l.reviews,
    favorites: l.favorites,
    descriptionPreview: l.description.slice(0, 400),
    tags: l.tags,
    imageCount: l.images.length,
  }));

  const prompt = `You are analyzing Etsy listings in the "${niche}" niche to extract actionable best practices for creating competitive digital printable products.

## TOP PERFORMERS (highest reviews):
${JSON.stringify(topListingData, null, 2)}

## AVERAGE PERFORMERS:
${JSON.stringify(avgListingData, null, 2)}

## Pre-computed metrics:
- Average description length: ${avgDescLength} chars
- Average title length: ${avgTitleLength} chars
- Average image count per listing: ${avgImageCount}
- Most common tags: ${commonTags.join(', ')}

## Your task:
Analyze what the TOP performers do differently from average performers. Return a JSON object (no markdown fences) with this exact structure:

{
  "photoPatterns": {
    "coverStyle": "<dominant cover image style, e.g. 'flat-lay mockup with props' or 'clean white background'>",
    "mockupTypes": ["<type1>", "<type2>", ...],
    "thumbnailApproach": "<what makes top seller thumbnails stand out>"
  },
  "descriptionPatterns": {
    "structure": ["<section1>", "<section2>", ...],
    "commonEmojis": <true/false>,
    "keySellingPoints": ["<point1>", "<point2>", ...]
  },
  "titlePatterns": {
    "frontLoadedKeywords": ["<kw1>", "<kw2>", ...],
    "commonFormats": ["<format1>", "<format2>", ...]
  },
  "tagPatterns": {
    "tagCategories": {
      "broad": ["<tag1>", ...],
      "specific": ["<tag1>", ...],
      "longTail": ["<tag1>", ...]
    }
  },
  "productPatterns": {
    "avgPageCount": <number or 0 if unknown>,
    "commonSections": ["<section1>", ...],
    "layoutStyle": "<dominant layout approach>",
    "colorSchemes": ["<scheme1>", ...],
    "fontStyles": ["<style1>", ...]
  }
}

Focus on concrete, actionable patterns. Be specific — not generic advice.`;

  const systemPrompt =
    'You are a competitive intelligence analyst for Etsy digital products. ' +
    'Return ONLY valid JSON, no markdown code fences, no commentary.';

  const response = await callClaude(prompt, {
    systemPrompt,
    maxTokens: 4096,
    temperature: 0.3,
  });

  let parsed: Record<string, unknown>;
  try {
    // Strip markdown fences if present despite instructions
    const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to parse AI best practices response', {
      error: message,
      responsePreview: response.slice(0, 200),
    });
    throw new CompetitiveIntelError(
      `Failed to parse AI analysis response: ${message}`,
    );
  }

  // Safely extract with fallbacks
  const photo = parsed.photoPatterns as Record<string, unknown> | undefined;
  const desc = parsed.descriptionPatterns as Record<string, unknown> | undefined;
  const title = parsed.titlePatterns as Record<string, unknown> | undefined;
  const tag = parsed.tagPatterns as Record<string, unknown> | undefined;
  const product = parsed.productPatterns as Record<string, unknown> | undefined;
  const tagCats = tag?.tagCategories as Record<string, unknown> | undefined;

  return {
    photoPatterns: {
      coverStyle: String(photo?.coverStyle ?? 'unknown'),
      imageCount: avgImageCount,
      mockupTypes: Array.isArray(photo?.mockupTypes)
        ? (photo.mockupTypes as string[])
        : [],
      thumbnailApproach: String(photo?.thumbnailApproach ?? 'unknown'),
    },
    descriptionPatterns: {
      avgLength: avgDescLength,
      structure: Array.isArray(desc?.structure)
        ? (desc.structure as string[])
        : [],
      commonEmojis: Boolean(desc?.commonEmojis),
      keySellingPoints: Array.isArray(desc?.keySellingPoints)
        ? (desc.keySellingPoints as string[])
        : [],
    },
    titlePatterns: {
      avgLength: avgTitleLength,
      frontLoadedKeywords: Array.isArray(title?.frontLoadedKeywords)
        ? (title.frontLoadedKeywords as string[])
        : [],
      commonFormats: Array.isArray(title?.commonFormats)
        ? (title.commonFormats as string[])
        : [],
    },
    tagPatterns: {
      commonTags,
      tagCategories: {
        broad: Array.isArray(tagCats?.broad)
          ? (tagCats.broad as string[])
          : [],
        specific: Array.isArray(tagCats?.specific)
          ? (tagCats.specific as string[])
          : [],
        longTail: Array.isArray(tagCats?.longTail)
          ? (tagCats.longTail as string[])
          : [],
      },
    },
    productPatterns: {
      avgPageCount: typeof product?.avgPageCount === 'number'
        ? product.avgPageCount
        : 0,
      commonSections: Array.isArray(product?.commonSections)
        ? (product.commonSections as string[])
        : [],
      layoutStyle: String(product?.layoutStyle ?? 'unknown'),
      colorSchemes: Array.isArray(product?.colorSchemes)
        ? (product.colorSchemes as string[])
        : [],
      fontStyles: Array.isArray(product?.fontStyles)
        ? (product.fontStyles as string[])
        : [],
    },
  };
}

export function selectReferenceListings(
  listings: ListingDetail[],
  maxRefs: number = DEFAULT_MAX_REFS,
): ReferenceListingData[] {
  if (listings.length === 0) {
    return [];
  }

  // Score each listing for reference value
  const scored = listings
    .filter((l) => l.title && l.price > 0)
    .map((listing) => {
      const reviewScore = listing.reviews;
      const favoriteScore = listing.favorites * 0.5;
      const priceEfficiency = listing.reviews > 0
        ? listing.reviews / listing.price
        : 0;
      const totalScore = reviewScore + favoriteScore + priceEfficiency * 10;

      return { listing, totalScore, priceEfficiency };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  // Select top references, ensuring diversity (different shops when possible)
  const selected: typeof scored = [];
  const seenShops = new Set<string>();

  // First pass: pick top from unique shops
  for (const item of scored) {
    if (selected.length >= maxRefs) {
      break;
    }
    if (!seenShops.has(item.listing.shopName)) {
      selected.push(item);
      seenShops.add(item.listing.shopName);
    }
  }

  // Second pass: fill remaining slots if needed
  for (const item of scored) {
    if (selected.length >= maxRefs) {
      break;
    }
    if (!selected.includes(item)) {
      selected.push(item);
    }
  }

  return selected.map((item) => {
    const { listing, priceEfficiency } = item;

    // Determine why this listing was selected
    const reasons: string[] = [];
    if (listing.reviews >= HIGH_REVIEW_THRESHOLD) {
      reasons.push(`high review count (${listing.reviews})`);
    }
    if (priceEfficiency > 20) {
      reasons.push(`excellent reviews-to-price ratio (${round2(priceEfficiency)})`);
    }
    if (listing.favorites > 500) {
      reasons.push(`high favorites (${listing.favorites})`);
    }
    if (listing.shopSales > 10000) {
      reasons.push(`from established shop (${listing.shopSales} sales)`);
    }
    if (reasons.length === 0) {
      reasons.push('top overall score in niche');
    }

    // Extract structural patterns from description
    const structuralPatterns: string[] = [];
    const desc = listing.description.toLowerCase();
    if (desc.includes('what you get') || desc.includes("what's included")) {
      structuralPatterns.push('includes "what you get" section');
    }
    if (desc.includes('how to') || desc.includes('instructions')) {
      structuralPatterns.push('includes usage instructions');
    }
    if (desc.includes('instant download') || desc.includes('digital download')) {
      structuralPatterns.push('emphasizes instant/digital download');
    }
    if (desc.includes('page') || desc.includes('pages')) {
      structuralPatterns.push('mentions page count');
    }
    if (desc.includes('printable') || desc.includes('print at home')) {
      structuralPatterns.push('highlights printability');
    }
    if (listing.tags.length > 10) {
      structuralPatterns.push('uses many tags for discoverability');
    }

    return {
      url: listing.url,
      title: listing.title,
      price: listing.price,
      reviews: listing.reviews,
      favorites: listing.favorites,
      tags: listing.tags,
      descriptionExcerpt: listing.description.slice(0, DESCRIPTION_EXCERPT_LENGTH),
      imageUrls: listing.images,
      whyReference: reasons.join('; '),
      structuralPatterns,
    };
  });
}

export async function analyzeNicheCompetition(
  niche: string,
  listingUrls: string[],
): Promise<CompetitiveIntel> {
  logger.info(`Starting competitive intelligence analysis for niche: ${niche}`, {
    urlCount: listingUrls.length,
  });

  if (listingUrls.length === 0) {
    throw new CompetitiveIntelError(
      'No listing URLs provided for competitive analysis',
    );
  }

  // Scrape all listings in batches
  const listings = await scrapeInBatches(listingUrls, SCRAPE_CONCURRENCY);

  logger.info(`Successfully scraped ${listings.length}/${listingUrls.length} listings`, {
    niche,
  });

  if (listings.length < MIN_LISTINGS_FOR_ANALYSIS) {
    throw new CompetitiveIntelError(
      `Only scraped ${listings.length} valid listings — need at least ${MIN_LISTINGS_FOR_ANALYSIS} for analysis`,
    );
  }

  // Build all analysis components
  const topSellers = buildSellerProfiles(listings);
  const pricingStrategy = buildPricingStrategy(listings);
  const bestPractices = await extractBestPracticesWithAI(niche, listings);
  const referenceListings = selectReferenceListings(listings);

  const result: CompetitiveIntel = {
    niche,
    analyzedAt: new Date().toISOString(),
    topSellers,
    bestPractices,
    pricingStrategy,
    referenceListings,
  };

  logger.info(`Competitive intelligence complete for niche: ${niche}`, {
    sellerCount: topSellers.length,
    referenceCount: referenceListings.length,
    recommendedPrice: pricingStrategy.recommendedPrice,
    recommendedTier: pricingStrategy.recommendedTier,
  });

  return result;
}
