import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import type { Opportunity, CompetitionLevel } from '../types/index.js';
import type { EtsyScrapedData, PinterestTrend, TrendData } from './types.js';

const NICHE_REGISTRY_PATH = resolve(process.cwd(), 'shared', 'niche-registry.md');

interface NicheRegistryEntry {
  slug: string;
  competitionLevel: string;
  qualityScoreTrend: string;
  notes: string;
}

async function loadNicheRegistry(): Promise<Map<string, NicheRegistryEntry>> {
  const registry = new Map<string, NicheRegistryEntry>();

  try {
    const content = await readFile(NICHE_REGISTRY_PATH, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed.startsWith('|') ||
        trimmed.startsWith('| Niche') ||
        trimmed.startsWith('|---')
      ) {
        continue;
      }

      const cells = trimmed
        .split('|')
        .map((c: string) => c.trim())
        .filter(Boolean);

      if (cells.length >= 4 && cells[0] !== '') {
        registry.set(cells[0], {
          slug: cells[0],
          competitionLevel: cells[3] ?? '',
          qualityScoreTrend: cells[4] ?? '',
          notes: cells[5] ?? '',
        });
      }
    }
  } catch {
    logger.warn('Niche registry not found, treating all niches as unexplored');
  }

  return registry;
}

function isNicheDeclining(entry: NicheRegistryEntry): boolean {
  const notes = entry.notes.toLowerCase();
  const trend = entry.qualityScoreTrend.toLowerCase();
  return notes.includes('declining') || trend.includes('↓') || trend.includes('declining');
}

function toNicheSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function groupByNiche(etsyData: EtsyScrapedData[]): Map<string, EtsyScrapedData[]> {
  const groups = new Map<string, EtsyScrapedData[]>();

  for (const item of etsyData) {
    const niche = toNicheSlug(item.category);
    const existing = groups.get(niche);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(niche, [item]);
    }
  }

  return groups;
}

function analyzeCompetition(listings: EtsyScrapedData[]): CompetitionLevel {
  if (listings.length === 0) {
    return 'low';
  }

  const avgReviews = listings.reduce((sum, l) => sum + l.reviews, 0) / listings.length;
  const topSellerCount = listings.filter((l) => l.reviews > 500).length;

  if (avgReviews > 200 || topSellerCount > 3) {
    return 'high';
  }
  if (avgReviews > 100 || topSellerCount > 1) {
    return 'medium';
  }
  return 'low';
}

function extractTopKeywords(listings: EtsyScrapedData[]): string[] {
  const tagCounts = new Map<string, number>();

  for (const listing of listings) {
    for (const tag of listing.tags) {
      const lower = tag.toLowerCase().trim();
      if (lower) {
        tagCounts.set(lower, (tagCounts.get(lower) ?? 0) + 1);
      }
    }
  }

  // Also extract keywords from titles
  for (const listing of listings) {
    const words = listing.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    for (const word of words) {
      tagCounts.set(word, (tagCounts.get(word) ?? 0) + 1);
    }
  }

  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);
}

function calculateTrendScore(
  listings: EtsyScrapedData[],
  pinterestMatch: PinterestTrend | undefined,
  googleMatch: TrendData | undefined
): number {
  let score = 0;

  // Etsy metrics (40% weight)
  if (listings.length > 0) {
    const avgFavorites = listings.reduce((sum, l) => sum + l.favorites, 0) / listings.length;
    const avgReviews = listings.reduce((sum, l) => sum + l.reviews, 0) / listings.length;
    const etsyScore = Math.min(100, (avgFavorites * 0.3 + avgReviews * 0.7) / 5);
    score += etsyScore * 0.4;
  }

  // Pinterest metrics (30% weight)
  if (pinterestMatch) {
    let pinterestScore = Math.min(100, pinterestMatch.pinCount / 10);
    if (pinterestMatch.trendDirection === 'rising') {
      pinterestScore *= 1.3;
    } else if (pinterestMatch.trendDirection === 'declining') {
      pinterestScore *= 0.7;
    }
    score += Math.min(100, pinterestScore) * 0.3;
  }

  // Google Trends metrics (30% weight)
  if (googleMatch) {
    let googleScore = googleMatch.interestOverTime;
    if (googleMatch.trend === 'rising') {
      googleScore *= 1.3;
    } else if (googleMatch.trend === 'declining') {
      googleScore *= 0.7;
    }
    score += Math.min(100, googleScore) * 0.3;
  }

  return Math.round(Math.min(100, score));
}

function findPinterestMatch(
  niche: string,
  pinterestData: PinterestTrend[]
): PinterestTrend | undefined {
  const nicheWords = niche.split('-');

  return pinterestData.find((trend) => {
    const trendSlug = toNicheSlug(trend.keyword);
    // Direct match
    if (trendSlug === niche || trendSlug.includes(niche) || niche.includes(trendSlug)) {
      return true;
    }
    // Partial word match
    const trendWords = trendSlug.split('-');
    const commonWords = nicheWords.filter((w) => trendWords.includes(w));
    return commonWords.length >= Math.min(2, nicheWords.length);
  });
}

function findGoogleMatch(
  niche: string,
  trendsData: TrendData[]
): TrendData | undefined {
  const nicheWords = niche.split('-');

  return trendsData.find((trend) => {
    const trendSlug = toNicheSlug(trend.keyword);
    if (trendSlug === niche || trendSlug.includes(niche) || niche.includes(trendSlug)) {
      return true;
    }
    const trendWords = trendSlug.split('-');
    const commonWords = nicheWords.filter((w) => trendWords.includes(w));
    return commonWords.length >= Math.min(2, nicheWords.length);
  });
}

export async function buildOpportunities(
  etsyData: EtsyScrapedData[],
  pinterestData: PinterestTrend[],
  trendsData: TrendData[]
): Promise<Opportunity[]> {
  logger.info(
    `Building opportunities from ${etsyData.length} Etsy results, ` +
    `${pinterestData.length} Pinterest trends, ${trendsData.length} Google Trends`
  );

  const config = await loadConfig();
  const { maxOpportunitiesPerRun, minReviewCount, targetPriceRange } = config.agents.researcher;

  const nicheRegistry = await loadNicheRegistry();
  const nicheGroups = groupByNiche(etsyData);
  const opportunities: Opportunity[] = [];

  for (const [niche, listings] of nicheGroups) {
    // Skip declining niches from registry
    const registryEntry = nicheRegistry.get(niche);
    if (registryEntry && isNicheDeclining(registryEntry)) {
      logger.info(`Skipping declining niche from registry: ${niche}`);
      continue;
    }

    const avgPrice =
      listings.length > 0
        ? listings.reduce((sum, l) => sum + l.price, 0) / listings.length
        : 0;

    const avgReviews =
      listings.length > 0
        ? Math.round(listings.reduce((sum, l) => sum + l.reviews, 0) / listings.length)
        : 0;

    // Filter by config criteria
    if (avgReviews < minReviewCount) {
      logger.debug(`Skipping niche "${niche}": avg reviews ${avgReviews} < min ${minReviewCount}`);
      continue;
    }

    if (avgPrice < targetPriceRange[0] || avgPrice > targetPriceRange[1]) {
      logger.debug(
        `Skipping niche "${niche}": avg price $${avgPrice.toFixed(2)} outside range ` +
        `$${targetPriceRange[0]}-$${targetPriceRange[1]}`
      );
      continue;
    }

    const pinterestMatch = findPinterestMatch(niche, pinterestData);
    const googleMatch = findGoogleMatch(niche, trendsData);
    const trendScore = calculateTrendScore(listings, pinterestMatch, googleMatch);
    const competitionLevel = analyzeCompetition(listings);
    const keywords = extractTopKeywords(listings);

    const sources: string[] = ['etsy-scrape'];
    if (pinterestMatch) {
      sources.push('pinterest');
    }
    if (googleMatch) {
      sources.push('google-trends');
    }

    const opportunity: Opportunity = {
      id: randomUUID(),
      niche,
      avgPrice: Math.round(avgPrice * 100) / 100,
      reviewCount: avgReviews,
      competitionLevel,
      trendScore,
      keywords,
      source: sources.join('+'),
      discoveredAt: new Date().toISOString(),
    };

    opportunities.push(opportunity);
  }

  // Sort by trend score descending, take top N
  opportunities.sort((a, b) => b.trendScore - a.trendScore);
  const selected = opportunities.slice(0, maxOpportunitiesPerRun);

  logger.info(
    `Built ${opportunities.length} total opportunities, selected top ${selected.length}`
  );

  return selected;
}
