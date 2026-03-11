import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentResult, Opportunity, ProductBrief } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const QUEUE_DIR = join(STATE_DIR, 'queue');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

// Scoring weights
const WEIGHT_TREND = 0.30;
const WEIGHT_GAP = 0.25;
const WEIGHT_PRICE = 0.20;
const WEIGHT_COMPETITION = 0.15;
const WEIGHT_FEASIBILITY = 0.10;

interface ScoredOpportunity {
  opportunity: Opportunity;
  totalScore: number;
  breakdown: {
    trendScore: number;
    gapScore: number;
    priceScore: number;
    competitionScore: number;
    feasibilityScore: number;
  };
}

const DEFAULT_PALETTES: Record<string, string> = {
  wellness: 'sage-green, warm-cream, soft-coral',
  productivity: 'blue, light-grey, dark-grey',
  fitness: 'coral, teal, navy',
  finance: 'green, blue, light-grey',
  kids: 'pink, yellow, sky-blue',
  default: 'blue, grey, orange',
};

const DEFAULT_FONTS: Record<string, { heading: string; body: string }> = {
  wellness: { heading: 'Playfair Display', body: 'Lato' },
  productivity: { heading: 'Inter', body: 'Inter' },
  fitness: { heading: 'Oswald', body: 'Open Sans' },
  finance: { heading: 'Roboto Slab', body: 'Roboto' },
  kids: { heading: 'Fredoka One', body: 'Nunito' },
  default: { heading: 'Georgia', body: 'Helvetica Neue' },
};

async function loadQueuedOpportunities(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  try {
    const files = await readdir(QUEUE_DIR);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const content = await readFile(join(QUEUE_DIR, file), 'utf-8');
      const opp = JSON.parse(content) as Opportunity;
      opportunities.push(opp);
    }
  } catch {
    logger.warn('No queued opportunities found');
  }

  return opportunities;
}

function scoreTrend(opportunity: Opportunity): number {
  // trendScore from researcher is 0-100
  return opportunity.trendScore;
}

function scoreGap(opportunity: Opportunity): number {
  // Lower competition = bigger gap
  const competitionPenalty: Record<string, number> = {
    low: 0,
    medium: 30,
    high: 60,
  };
  const penalty = competitionPenalty[opportunity.competitionLevel] ?? 30;
  return Math.max(0, Math.min(100, 100 - penalty));
}

function scorePrice(opportunity: Opportunity, targetRange: [number, number]): number {
  const [min, max] = targetRange;
  const mid = (min + max) / 2;
  const price = opportunity.avgPrice;

  if (price >= min && price <= max) {
    const distFromMid = Math.abs(price - mid);
    const maxDist = (max - min) / 2;
    return Math.round(100 - (distFromMid / maxDist) * 30);
  }

  return 30;
}

function scoreCompetition(opportunity: Opportunity): number {
  const scores: Record<string, number> = {
    low: 90,
    medium: 60,
    high: 25,
  };
  return scores[opportunity.competitionLevel] ?? 50;
}

function scoreFeasibility(opportunity: Opportunity): number {
  let score = 70;

  // More keywords = better understanding of the niche
  if (opportunity.keywords.length > 5) {
    score += 20;
  } else if (opportunity.keywords.length > 2) {
    score += 10;
  }

  return Math.min(100, score);
}

function scoreOpportunity(
  opportunity: Opportunity,
  targetPriceRange: [number, number]
): ScoredOpportunity {
  const trendScore = scoreTrend(opportunity);
  const gapScore = scoreGap(opportunity);
  const priceScore = scorePrice(opportunity, targetPriceRange);
  const competitionScore = scoreCompetition(opportunity);
  const feasibilityScore = scoreFeasibility(opportunity);

  const totalScore =
    trendScore * WEIGHT_TREND +
    gapScore * WEIGHT_GAP +
    priceScore * WEIGHT_PRICE +
    competitionScore * WEIGHT_COMPETITION +
    feasibilityScore * WEIGHT_FEASIBILITY;

  return {
    opportunity,
    totalScore: Math.round(totalScore),
    breakdown: {
      trendScore,
      gapScore,
      priceScore,
      competitionScore,
      feasibilityScore,
    },
  };
}

function inferCategory(niche: string): string {
  const lower = niche.toLowerCase();
  if (lower.includes('wellness') || lower.includes('self-care') || lower.includes('gratitude')) return 'wellness';
  if (lower.includes('fitness') || lower.includes('workout')) return 'fitness';
  if (lower.includes('budget') || lower.includes('finance')) return 'finance';
  if (lower.includes('kid') || lower.includes('child')) return 'kids';
  return 'productivity';
}

function determinePageCount(niche: string): number {
  const lower = niche.toLowerCase();
  if (lower.includes('weekly')) return 54;
  if (lower.includes('monthly')) return 14;
  if (lower.includes('habit')) return 13;
  if (lower.includes('gratitude')) return 30;
  if (lower.includes('daily')) return 60;
  if (lower.includes('budget')) return 8;
  if (lower.includes('goal')) return 6;
  return 20;
}

function generateSections(niche: string, pageCount: number): string[] {
  const sections: string[] = ['Cover'];

  for (let i = 1; i < pageCount; i++) {
    sections.push(`${niche} - Page ${i + 1}`);
  }

  return sections;
}

function generateBrief(scored: ScoredOpportunity): ProductBrief {
  const opp = scored.opportunity;
  const category = inferCategory(opp.niche);
  const palette = DEFAULT_PALETTES[category] ?? DEFAULT_PALETTES.default;
  const fonts = DEFAULT_FONTS[category] ?? DEFAULT_FONTS.default;
  const pageCount = determinePageCount(opp.niche);
  const sections = generateSections(opp.niche, pageCount);

  return {
    id: randomUUID(),
    niche: opp.niche,
    targetAudience: `People interested in ${opp.niche}`,
    pageCount,
    sections,
    styleGuide: {
      primaryFont: fonts.heading,
      accentColor: palette.split(', ')[0],
      palette,
      layout: 'clean-minimal',
    },
    createdAt: new Date().toISOString(),
  };
}

export async function runStrategy(): Promise<AgentResult<ProductBrief[]>> {
  const startTime = performance.now();

  logger.info('Strategy agent starting');

  try {
    const config = await loadConfig();
    const { productsPerDay } = config.pipeline;
    const { targetPriceRange } = config.agents.researcher;

    const opportunities = await loadQueuedOpportunities();
    logger.info(`Loaded ${opportunities.length} queued opportunities`);

    if (opportunities.length === 0) {
      const duration = Math.round(performance.now() - startTime);
      logger.warn('No opportunities to evaluate');

      return {
        success: true,
        data: [],
        duration,
      };
    }

    // Score all opportunities
    const scored = opportunities.map((opp) => scoreOpportunity(opp, targetPriceRange));
    scored.sort((a, b) => b.totalScore - a.totalScore);

    // Select top N
    const selected = scored.slice(0, productsPerDay);
    const briefs: ProductBrief[] = [];

    for (const item of selected) {
      const brief = generateBrief(item);

      // Create product directory and write brief
      const productDir = join(PRODUCTS_DIR, brief.id);
      await mkdir(productDir, { recursive: true });
      await writeFile(
        join(productDir, 'brief.json'),
        JSON.stringify(brief, null, 2),
        'utf-8'
      );

      briefs.push(brief);

      logger.info(
        `Selected: niche="${brief.niche}" (score: ${item.totalScore})`
      );
    }

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'strategist',
      action: 'strategy-complete',
      details: `Evaluated ${opportunities.length} opportunities, selected ${briefs.length} for production`,
      duration,
      success: true,
    });

    logger.info(`Strategy complete: ${briefs.length} briefs generated in ${duration}ms`);

    return {
      success: true,
      data: briefs,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Strategy agent failed: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'strategist',
      action: 'strategy-failed',
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
