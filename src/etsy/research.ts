import logger from '../utils/logger.js';
import type { CompetitionLevel, Opportunity } from '../types/index.js';
import { EtsyClient } from './client.js';
import type {
  CompetitionAnalysis,
  EtsyListing,
  PriceDistribution,
} from './types.js';

const DEFAULT_SEARCH_LIMIT = 100;
const TOP_SELLER_REVIEW_THRESHOLD = 500;

interface ResearchConfig {
  apiKey: string;
  apiSecret: string;
  shopId: string;
  accessToken: string;
}

function createClient(config: ResearchConfig): EtsyClient {
  const client = new EtsyClient(config.apiKey, config.apiSecret, config.shopId);
  client.setAccessToken(config.accessToken);
  return client;
}

export async function searchTrendingNiches(
  categories: string[],
  config: ResearchConfig
): Promise<Opportunity[]> {
  logger.info(`Searching trending niches across ${categories.length} categories`);

  const client = createClient(config);
  const opportunities: Opportunity[] = [];

  for (const category of categories) {
    logger.debug(`Researching category: ${category}`);

    const listings = await client.searchListings(category, {
      limit: DEFAULT_SEARCH_LIMIT,
      sortBy: 'score',
    });

    if (listings.length === 0) {
      logger.debug(`No listings found for category: ${category}`);
      continue;
    }

    const competition = analyzeListings(listings);
    const prices = computePriceDistribution(listings);
    const trendScore = computeDemandScore(listings);

    const opportunity: Opportunity = {
      id: `opp-${category.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
      niche: category,
      avgPrice: prices.median,
      reviewCount: competition.avgReviews,
      competitionLevel: mapSaturationToLevel(competition.saturationLevel),
      trendScore,
      keywords: extractKeywords(listings),
      source: 'etsy-search',
      discoveredAt: new Date().toISOString(),
    };

    opportunities.push(opportunity);
  }

  opportunities.sort((a, b) => b.trendScore - a.trendScore);

  logger.info(`Found ${opportunities.length} niche opportunities`);
  return opportunities;
}

export async function analyzeCompetition(
  niche: string,
  config: ResearchConfig
): Promise<CompetitionAnalysis> {
  logger.info(`Analyzing competition for niche: "${niche}"`);

  const client = createClient(config);

  const listings = await client.searchListings(niche, {
    limit: DEFAULT_SEARCH_LIMIT,
    sortBy: 'score',
  });

  return analyzeListings(listings);
}

export async function getPriceDistribution(
  niche: string,
  config: ResearchConfig
): Promise<PriceDistribution> {
  logger.info(`Getting price distribution for niche: "${niche}"`);

  const client = createClient(config);

  const listings = await client.searchListings(niche, {
    limit: DEFAULT_SEARCH_LIMIT,
    sortBy: 'price',
  });

  return computePriceDistribution(listings);
}

// ── Internal helpers ────────────────────────────────────────────────

function analyzeListings(listings: EtsyListing[]): CompetitionAnalysis {
  const totalListings = listings.length;

  const prices = listings.map((l) => l.price);
  const avgPrice =
    prices.reduce((sum, p) => sum + p, 0) / totalListings;

  const favorites = listings.map((l) => l.favorites);
  const avgReviews =
    favorites.reduce((sum, f) => sum + f, 0) / totalListings;

  const topSellerCount = listings.filter(
    (l) => l.favorites >= TOP_SELLER_REVIEW_THRESHOLD
  ).length;

  const saturationLevel = determineSaturation(totalListings, topSellerCount);

  return {
    totalListings,
    avgPrice: Math.round(avgPrice * 100) / 100,
    avgReviews: Math.round(avgReviews),
    topSellerCount,
    saturationLevel,
  };
}

function determineSaturation(
  totalListings: number,
  topSellerCount: number
): CompetitionAnalysis['saturationLevel'] {
  if (totalListings < 20 && topSellerCount < 3) return 'low';
  if (totalListings < 50 && topSellerCount < 10) return 'medium';
  if (totalListings < 80 && topSellerCount < 20) return 'high';
  return 'oversaturated';
}

function computePriceDistribution(listings: EtsyListing[]): PriceDistribution {
  const prices = listings.map((l) => l.price).sort((a, b) => a - b);

  if (prices.length === 0) {
    return { min: 0, max: 0, median: 0, p25: 0, p75: 0, sweetSpot: 0 };
  }

  const min = prices[0];
  const max = prices[prices.length - 1];
  const median = percentile(prices, 50);
  const p25 = percentile(prices, 25);
  const p75 = percentile(prices, 75);

  // Sweet spot: slightly below median to be competitive
  const sweetSpot = Math.round((median * 0.9) * 100) / 100;

  return { min, max, median, p25, p75, sweetSpot };
}

function percentile(sorted: number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const fraction = index - lower;
  return Math.round((sorted[lower] * (1 - fraction) + sorted[upper] * fraction) * 100) / 100;
}

function computeDemandScore(listings: EtsyListing[]): number {
  const totalFavorites = listings.reduce((sum, l) => sum + l.favorites, 0);
  const totalViews = listings.reduce((sum, l) => sum + l.views, 0);

  // Normalize to 0-100 scale
  const favScore = Math.min(totalFavorites / 100, 100);
  const viewScore = Math.min(totalViews / 1000, 100);

  return Math.round((favScore * 0.6 + viewScore * 0.4) * 100) / 100;
}

function mapSaturationToLevel(
  saturation: CompetitionAnalysis['saturationLevel']
): CompetitionLevel {
  switch (saturation) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'oversaturated':
      return 'high';
  }
}

function extractKeywords(listings: EtsyListing[]): string[] {
  const tagCounts = new Map<string, number>();

  for (const listing of listings) {
    for (const tag of listing.tags) {
      const normalized = tag.toLowerCase().trim();
      tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
    }
  }

  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag]) => tag);
}
