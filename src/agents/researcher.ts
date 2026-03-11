import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentResult, Opportunity, CompetitionLevel } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const QUEUE_DIR = join(STATE_DIR, 'queue');
const NICHE_REGISTRY_PATH = resolve(process.cwd(), 'shared', 'niche-registry.md');

const TRENDING_CATEGORIES = [
  'planner-weekly',
  'planner-monthly',
  'tracker-habit',
  'journal-gratitude',
  'journal-daily',
  'worksheet-budget',
  'worksheet-goal',
];

interface EtsySearchResult {
  title: string;
  tags: string[];
  price: number;
  reviews: number;
  favorites: number;
  niche: string;
  category: string;
}

async function loadExploredNiches(): Promise<Set<string>> {
  const niches = new Set<string>();

  try {
    const content = await readFile(NICHE_REGISTRY_PATH, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && !trimmed.startsWith('| Niche') && !trimmed.startsWith('|---')) {
        const cells = trimmed.split('|').map((c: string) => c.trim()).filter(Boolean);
        if (cells.length > 0 && cells[0] !== '') {
          niches.add(cells[0]);
        }
      }
    }
  } catch {
    logger.warn('Niche registry not found, treating all niches as unexplored');
  }

  return niches;
}

async function searchEtsyTrending(category: string): Promise<EtsySearchResult[]> {
  // Placeholder: in production, this would use EtsyClient to search the API
  logger.info(`Searching Etsy trending for category: ${category}`);
  return [];
}

function analyzeCompetition(results: EtsySearchResult[]): {
  competitionLevel: CompetitionLevel;
  topSellerCount: number;
} {
  if (results.length === 0) {
    return { competitionLevel: 'low', topSellerCount: 0 };
  }

  const avgReviews = results.reduce((sum, r) => sum + r.reviews, 0) / results.length;
  const topSellerCount = results.filter((r) => r.reviews > 500).length;

  let competitionLevel: CompetitionLevel = 'low';
  if (avgReviews > 200 || topSellerCount > 3) {
    competitionLevel = 'high';
  } else if (avgReviews > 100 || topSellerCount > 1) {
    competitionLevel = 'medium';
  }

  return { competitionLevel, topSellerCount };
}

function calculateTrendScore(results: EtsySearchResult[]): number {
  if (results.length === 0) {
    return 0;
  }

  const avgFavorites = results.reduce((sum, r) => sum + r.favorites, 0) / results.length;
  const avgReviews = results.reduce((sum, r) => sum + r.reviews, 0) / results.length;

  return Math.min(100, Math.round((avgFavorites * 0.3 + avgReviews * 0.7) / 5));
}

function extractKeywords(results: EtsySearchResult[]): string[] {
  const tagCounts = new Map<string, number>();

  for (const result of results) {
    for (const tag of result.tags) {
      const lower = tag.toLowerCase();
      tagCounts.set(lower, (tagCounts.get(lower) ?? 0) + 1);
    }
  }

  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);
}

function buildOpportunity(
  category: string,
  niche: string,
  results: EtsySearchResult[]
): Opportunity {
  const { competitionLevel } = analyzeCompetition(results);
  const trendScore = calculateTrendScore(results);
  const keywords = extractKeywords(results);
  const avgPrice = results.length > 0
    ? results.reduce((sum, r) => sum + r.price, 0) / results.length
    : 0;
  const reviewCount = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.reviews, 0) / results.length)
    : 0;

  return {
    id: randomUUID(),
    niche,
    avgPrice,
    reviewCount,
    competitionLevel,
    trendScore,
    keywords,
    source: `etsy-trending:${category}`,
    discoveredAt: new Date().toISOString(),
  };
}

function filterByCriteria(
  opportunity: Opportunity,
  minReviewCount: number,
  targetPriceRange: [number, number]
): boolean {
  if (opportunity.reviewCount < minReviewCount) {
    return false;
  }

  if (opportunity.avgPrice < targetPriceRange[0] || opportunity.avgPrice > targetPriceRange[1]) {
    return false;
  }

  return true;
}

export async function runResearch(): Promise<AgentResult<Opportunity[]>> {
  const startTime = performance.now();

  logger.info('Research agent starting');

  try {
    const config = await loadConfig();
    const { maxOpportunitiesPerRun, minReviewCount, targetPriceRange } = config.agents.researcher;

    const exploredNiches = await loadExploredNiches();
    logger.info(`Found ${exploredNiches.size} previously explored niches`);

    const allOpportunities: Opportunity[] = [];

    for (const category of TRENDING_CATEGORIES) {
      const results = await searchEtsyTrending(category);

      if (results.length === 0) {
        continue;
      }

      // Group results by niche
      const nicheGroups = new Map<string, EtsySearchResult[]>();
      for (const result of results) {
        const niche = result.niche || category;
        if (!nicheGroups.has(niche)) {
          nicheGroups.set(niche, []);
        }
        nicheGroups.get(niche)!.push(result);
      }

      for (const [niche, nicheResults] of nicheGroups) {
        if (exploredNiches.has(niche)) {
          logger.info(`Skipping already-explored niche: ${niche}`);
          continue;
        }

        const opportunity = buildOpportunity(category, niche, nicheResults);

        if (filterByCriteria(opportunity, minReviewCount, targetPriceRange)) {
          allOpportunities.push(opportunity);
        }
      }
    }

    // Sort by trend score descending, take top N
    allOpportunities.sort((a, b) => b.trendScore - a.trendScore);
    const selected = allOpportunities.slice(0, maxOpportunitiesPerRun);

    // Write opportunities to queue
    await mkdir(QUEUE_DIR, { recursive: true });
    for (const opp of selected) {
      const filePath = join(QUEUE_DIR, `${opp.id}.json`);
      await writeFile(filePath, JSON.stringify(opp, null, 2), 'utf-8');
    }

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'researcher',
      action: 'research-complete',
      details: `Found ${selected.length} opportunities from ${TRENDING_CATEGORIES.length} categories`,
      duration,
      success: true,
    });

    logger.info(`Research complete: ${selected.length} opportunities queued in ${duration}ms`);

    return {
      success: true,
      data: selected,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Research agent failed: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'researcher',
      action: 'research-failed',
      details: message,
      duration,
      success: false,
    });

    return {
      success: false,
      error: message,
      duration,
    };
  }
}
