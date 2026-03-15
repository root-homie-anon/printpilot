import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { loadConfig } from '../utils/config.js';
import { logActivity } from '../tracker/activity-log.js';
import type { AgentResult, Opportunity, ProductBrief } from '../types/index.js';
import type {
  CompetitiveIntel,
  NicheBestPractices,
  PricingStrategy,
  ReferenceListingData,
} from '../research/competitive-intel.js';

// --- Exported interfaces ---

export interface EnhancedProductBrief extends ProductBrief {
  competitiveIntel: {
    recommendedPrice: number;
    priceTier: 'budget' | 'mid' | 'premium';
    undercutTarget: number;
    topSellerPatterns: string[];
    referenceUrls: string[];
  };
  photoStrategy: {
    coverStyle: string;
    mockupTypes: string[];
    imageCount: number;
  };
  copyGuidance: {
    titleKeywords: string[];
    titleFormat: string;
    descriptionStructure: string[];
    keySellingPoints: string[];
    mustHaveTags: string[];
  };
}

interface ScoredOpportunity {
  opportunity: Opportunity;
  intel: CompetitiveIntel | undefined;
  totalScore: number;
  breakdown: {
    trendScore: number;
    gapScore: number;
    priceScore: number;
    competitionScore: number;
    feasibilityScore: number;
    intelBonus: number;
  };
}

interface AIBriefResponse {
  targetAudience: string;
  sections: string[];
  styleGuide: {
    primaryFont: string;
    accentColor: string;
    palette: string;
    layout: string;
  };
  differentiators: string[];
}

// --- Constants ---

const STATE_DIR = resolve(process.cwd(), 'state');
const QUEUE_DIR = join(STATE_DIR, 'queue');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

const WEIGHT_TREND = 0.25;
const WEIGHT_GAP = 0.20;
const WEIGHT_PRICE = 0.20;
const WEIGHT_COMPETITION = 0.15;
const WEIGHT_FEASIBILITY = 0.10;
const WEIGHT_INTEL = 0.10;

const DEFAULT_PAGE_COUNT = 20;
const DEFAULT_IMAGE_COUNT = 7;

const FALLBACK_PALETTES: Record<string, string> = {
  wellness: 'sage-green, warm-cream, soft-coral',
  productivity: 'blue, light-grey, dark-grey',
  fitness: 'coral, teal, navy',
  finance: 'green, blue, light-grey',
  kids: 'pink, yellow, sky-blue',
  default: 'blue, grey, orange',
};

const FALLBACK_FONTS: Record<string, { heading: string; body: string }> = {
  wellness: { heading: 'Playfair Display', body: 'Lato' },
  productivity: { heading: 'Inter', body: 'Inter' },
  fitness: { heading: 'Oswald', body: 'Open Sans' },
  finance: { heading: 'Roboto Slab', body: 'Roboto' },
  kids: { heading: 'Fredoka One', body: 'Nunito' },
  default: { heading: 'Georgia', body: 'Helvetica Neue' },
};

// --- Helpers ---

function inferCategory(niche: string): string {
  const lower = niche.toLowerCase();
  if (lower.includes('wellness') || lower.includes('self-care') || lower.includes('gratitude')) return 'wellness';
  if (lower.includes('fitness') || lower.includes('workout')) return 'fitness';
  if (lower.includes('budget') || lower.includes('finance')) return 'finance';
  if (lower.includes('kid') || lower.includes('child')) return 'kids';
  return 'productivity';
}

function safeFirst<T>(arr: T[] | undefined, fallback: T): T {
  return arr && arr.length > 0 ? arr[0] : fallback;
}

function safeSlice(arr: string[] | undefined, count: number): string[] {
  if (!arr || arr.length === 0) return [];
  return arr.slice(0, count);
}

function extractTopSellerPatterns(intel: CompetitiveIntel): string[] {
  const patterns: string[] = [];

  for (const seller of intel.topSellers.slice(0, 3)) {
    for (const strength of seller.strengths) {
      if (!patterns.includes(strength)) {
        patterns.push(strength);
      }
    }
  }

  for (const ref of intel.referenceListings.slice(0, 3)) {
    for (const pattern of ref.structuralPatterns) {
      if (!patterns.includes(pattern)) {
        patterns.push(pattern);
      }
    }
  }

  return patterns;
}

function extractReferenceUrls(intel: CompetitiveIntel): string[] {
  return intel.referenceListings
    .filter((ref) => ref.url)
    .map((ref) => ref.url);
}

function buildMustHaveTags(intel: CompetitiveIntel): string[] {
  const tags: string[] = [];
  const tagPatterns = intel.bestPractices.tagPatterns;

  // Broad tags first for discoverability, then specific, then long-tail
  const broad = safeSlice(tagPatterns.tagCategories.broad, 3);
  const specific = safeSlice(tagPatterns.tagCategories.specific, 5);
  const longTail = safeSlice(tagPatterns.tagCategories.longTail, 5);

  for (const tag of [...broad, ...specific, ...longTail]) {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 13);
}

function buildSyntheticIntel(opportunity: Opportunity): CompetitiveIntel {
  const category = inferCategory(opportunity.niche);
  const palette = FALLBACK_PALETTES[category] ?? FALLBACK_PALETTES.default;
  const fonts = FALLBACK_FONTS[category] ?? FALLBACK_FONTS.default;

  return {
    niche: opportunity.niche,
    analyzedAt: new Date().toISOString(),
    topSellers: [],
    bestPractices: {
      photoPatterns: {
        coverStyle: 'clean mockup on neutral background',
        imageCount: DEFAULT_IMAGE_COUNT,
        mockupTypes: ['flat-lay', 'lifestyle', 'close-up detail'],
        thumbnailApproach: 'bold title text with preview of interior pages',
      },
      descriptionPatterns: {
        avgLength: 1200,
        structure: [
          'Hook / headline',
          'What you get',
          'Features and benefits',
          'How to use',
          'Instant download details',
        ],
        commonEmojis: true,
        keySellingPoints: [
          'Instant digital download',
          'Printable at home',
          'Clean, modern design',
        ],
      },
      titlePatterns: {
        avgLength: 80,
        frontLoadedKeywords: opportunity.keywords.slice(0, 5),
        commonFormats: ['[Product Type] | [Niche] [Descriptor] | [Benefit] | Printable PDF'],
      },
      tagPatterns: {
        commonTags: opportunity.keywords,
        tagCategories: {
          broad: [opportunity.niche, 'printable', 'digital download'],
          specific: opportunity.keywords.slice(0, 4),
          longTail: [],
        },
      },
      productPatterns: {
        avgPageCount: DEFAULT_PAGE_COUNT,
        commonSections: [],
        layoutStyle: 'clean-minimal',
        colorSchemes: [palette],
        fontStyles: [`${fonts.heading} / ${fonts.body}`],
      },
    },
    pricingStrategy: {
      priceDistribution: {
        min: opportunity.avgPrice * 0.5,
        max: opportunity.avgPrice * 2,
        median: opportunity.avgPrice,
        p25: opportunity.avgPrice * 0.7,
        p75: opportunity.avgPrice * 1.3,
      },
      tiers: {
        budget: { range: [opportunity.avgPrice * 0.5, opportunity.avgPrice * 0.7], sellerCount: 0, avgReviews: 0 },
        mid: { range: [opportunity.avgPrice * 0.7, opportunity.avgPrice * 1.3], sellerCount: 0, avgReviews: 0 },
        premium: { range: [opportunity.avgPrice * 1.3, opportunity.avgPrice * 2], sellerCount: 0, avgReviews: 0 },
      },
      recommendedPrice: opportunity.avgPrice * 0.9,
      recommendedTier: 'mid',
      priceReasoning: 'No competitive intel available; using 10% below average market price.',
      undercutTarget: opportunity.avgPrice,
      undercutMargin: opportunity.avgPrice * 0.05,
    },
    referenceListings: [],
  };
}

async function loadQueuedOpportunities(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  try {
    const files = await readdir(QUEUE_DIR);
    const jsonFiles = files.filter(
      (f) => f.endsWith('.json') && !f.endsWith('-intel.json'),
    );

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

async function loadCompetitiveIntel(opportunityId: string): Promise<CompetitiveIntel | undefined> {
  const intelPath = join(QUEUE_DIR, `${opportunityId}-intel.json`);

  try {
    const content = await readFile(intelPath, 'utf-8');
    return JSON.parse(content) as CompetitiveIntel;
  } catch {
    return undefined;
  }
}

function inferTargetAudience(intel: CompetitiveIntel): string {
  const refs = intel.referenceListings;
  if (refs.length === 0) {
    return '';
  }

  // Extract clues from reference listing titles and descriptions
  const allTitles = refs.map((r) => r.title).join(' ');
  const allDescriptions = refs.map((r) => r.descriptionExcerpt).join(' ');
  const combined = `${allTitles} ${allDescriptions}`.toLowerCase();

  const audienceSignals: string[] = [];

  if (combined.includes('mom') || combined.includes('mother') || combined.includes('parent')) {
    audienceSignals.push('busy parents');
  }
  if (combined.includes('student') || combined.includes('college') || combined.includes('school')) {
    audienceSignals.push('students');
  }
  if (combined.includes('teacher') || combined.includes('classroom') || combined.includes('homeschool')) {
    audienceSignals.push('teachers and homeschoolers');
  }
  if (combined.includes('entrepreneur') || combined.includes('business') || combined.includes('freelance')) {
    audienceSignals.push('entrepreneurs and freelancers');
  }
  if (combined.includes('beginner') || combined.includes('getting started') || combined.includes('new to')) {
    audienceSignals.push('beginners');
  }
  if (combined.includes('women') || combined.includes('her') || combined.includes('feminine')) {
    audienceSignals.push('women');
  }
  if (combined.includes('minimalist') || combined.includes('simple') || combined.includes('clean')) {
    audienceSignals.push('minimalism enthusiasts');
  }

  return audienceSignals.length > 0
    ? audienceSignals.join(', ')
    : '';
}

// --- Scoring ---

function scoreTrend(opportunity: Opportunity): number {
  return opportunity.trendScore;
}

function scoreGap(opportunity: Opportunity): number {
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

  if (opportunity.keywords.length > 5) {
    score += 20;
  } else if (opportunity.keywords.length > 2) {
    score += 10;
  }

  return Math.min(100, score);
}

function scoreIntelQuality(intel: CompetitiveIntel | undefined): number {
  if (!intel) return 0;

  let score = 0;

  // Has real seller data
  if (intel.topSellers.length > 0) score += 20;
  if (intel.topSellers.length >= 3) score += 10;

  // Has reference listings
  if (intel.referenceListings.length > 0) score += 20;
  if (intel.referenceListings.length >= 3) score += 10;

  // Has pricing data
  if (intel.pricingStrategy.recommendedPrice > 0) score += 15;

  // Has product patterns
  const patterns = intel.bestPractices.productPatterns;
  if (patterns.commonSections.length > 0) score += 10;
  if (patterns.colorSchemes.length > 0) score += 5;
  if (patterns.fontStyles.length > 0) score += 5;
  if (patterns.avgPageCount > 0) score += 5;

  return Math.min(100, score);
}

function scoreOpportunity(
  opportunity: Opportunity,
  intel: CompetitiveIntel | undefined,
  targetPriceRange: [number, number],
): ScoredOpportunity {
  const trendScore = scoreTrend(opportunity);
  const gapScore = scoreGap(opportunity);
  const priceScore = scorePrice(opportunity, targetPriceRange);
  const competitionScore = scoreCompetition(opportunity);
  const feasibilityScore = scoreFeasibility(opportunity);
  const intelBonus = scoreIntelQuality(intel);

  const totalScore =
    trendScore * WEIGHT_TREND +
    gapScore * WEIGHT_GAP +
    priceScore * WEIGHT_PRICE +
    competitionScore * WEIGHT_COMPETITION +
    feasibilityScore * WEIGHT_FEASIBILITY +
    intelBonus * WEIGHT_INTEL;

  return {
    opportunity,
    intel,
    totalScore: Math.round(totalScore),
    breakdown: {
      trendScore,
      gapScore,
      priceScore,
      competitionScore,
      feasibilityScore,
      intelBonus,
    },
  };
}

// --- Brief generation ---

export function generateEnhancedBrief(
  opportunity: Opportunity,
  intel: CompetitiveIntel,
): EnhancedProductBrief {
  const category = inferCategory(opportunity.niche);
  const practices = intel.bestPractices;
  const pricing = intel.pricingStrategy;

  // Page count: prefer intel data, fall back to reasonable default
  const pageCount = practices.productPatterns.avgPageCount > 0
    ? practices.productPatterns.avgPageCount
    : DEFAULT_PAGE_COUNT;

  // Sections: use what top sellers include, not generic "Page N"
  const sections = practices.productPatterns.commonSections.length > 0
    ? practices.productPatterns.commonSections
    : generateFallbackSections(opportunity.niche, pageCount);

  // Layout from market data
  const layout = practices.productPatterns.layoutStyle || 'clean-minimal';

  // Colors: first scheme from intel, or fallback
  const palette = safeFirst(
    practices.productPatterns.colorSchemes,
    FALLBACK_PALETTES[category] ?? FALLBACK_PALETTES.default,
  );
  const accentColor = palette.split(',')[0]?.trim() || palette.split(' ')[0] || 'blue';

  // Fonts: first style from intel, or fallback
  const fallbackFont = FALLBACK_FONTS[category] ?? FALLBACK_FONTS.default;
  const fontStyle = safeFirst(practices.productPatterns.fontStyles, '');
  const primaryFont = fontStyle
    ? fontStyle.split('/')[0]?.trim() || fallbackFont.heading
    : fallbackFont.heading;

  // Target audience from reference listings
  const inferredAudience = inferTargetAudience(intel);
  const targetAudience = inferredAudience || `${opportunity.niche} enthusiasts looking for printable organizational tools`;

  // Pricing
  const recommendedPrice = pricing.recommendedPrice > 0
    ? pricing.recommendedPrice
    : opportunity.avgPrice * 0.9;

  // Top seller patterns
  const topSellerPatterns = extractTopSellerPatterns(intel);

  // Reference URLs
  const referenceUrls = extractReferenceUrls(intel);

  // Photo strategy
  const photoPatterns = practices.photoPatterns;
  const coverStyle = photoPatterns.coverStyle || 'clean mockup on neutral background';
  const mockupTypes = photoPatterns.mockupTypes.length > 0
    ? photoPatterns.mockupTypes
    : ['flat-lay', 'lifestyle', 'close-up detail'];
  const imageCount = photoPatterns.imageCount > 0
    ? photoPatterns.imageCount
    : DEFAULT_IMAGE_COUNT;

  // Copy guidance
  const titleKeywords = practices.titlePatterns.frontLoadedKeywords.length > 0
    ? practices.titlePatterns.frontLoadedKeywords
    : opportunity.keywords.slice(0, 5);
  const titleFormat = safeFirst(
    practices.titlePatterns.commonFormats,
    '[Product Type] | [Niche] [Descriptor] | Printable PDF',
  );
  const descriptionStructure = practices.descriptionPatterns.structure.length > 0
    ? practices.descriptionPatterns.structure
    : ['Hook', 'What you get', 'Features', 'How to use', 'Instant download'];
  const keySellingPoints = practices.descriptionPatterns.keySellingPoints.length > 0
    ? practices.descriptionPatterns.keySellingPoints
    : ['Instant digital download', 'Printable at home', 'Clean design'];
  const mustHaveTags = buildMustHaveTags(intel);

  return {
    id: randomUUID(),
    niche: opportunity.niche,
    targetAudience,
    pageCount,
    sections,
    styleGuide: {
      primaryFont,
      accentColor,
      palette,
      layout,
    },
    createdAt: new Date().toISOString(),
    competitiveIntel: {
      recommendedPrice,
      priceTier: pricing.recommendedTier,
      undercutTarget: pricing.undercutTarget,
      topSellerPatterns,
      referenceUrls,
    },
    photoStrategy: {
      coverStyle,
      mockupTypes,
      imageCount,
    },
    copyGuidance: {
      titleKeywords,
      titleFormat,
      descriptionStructure,
      keySellingPoints,
      mustHaveTags,
    },
  };
}

function generateFallbackSections(niche: string, pageCount: number): string[] {
  const lower = niche.toLowerCase();
  const sections: string[] = [];

  // Generate meaningful section names based on niche keywords
  if (lower.includes('habit')) {
    sections.push(
      'Monthly Habit Overview',
      'Weekly Habit Grid',
      'Daily Habit Checklist',
      'Habit Streak Tracker',
      'Monthly Reflection',
      'Progress Summary',
    );
  } else if (lower.includes('gratitude') || lower.includes('journal')) {
    sections.push(
      'Daily Gratitude Entry',
      'Weekly Reflection',
      'Monthly Highlights',
      'Affirmation Page',
      'Gratitude Prompts',
      'Year in Review',
    );
  } else if (lower.includes('budget') || lower.includes('finance')) {
    sections.push(
      'Monthly Budget Overview',
      'Income Tracker',
      'Expense Categories',
      'Savings Goals',
      'Debt Payoff Tracker',
      'Bill Payment Schedule',
      'Financial Summary',
    );
  } else if (lower.includes('fitness') || lower.includes('workout')) {
    sections.push(
      'Weekly Workout Plan',
      'Exercise Log',
      'Progress Measurements',
      'Meal Planning',
      'Water Intake Tracker',
      'Monthly Fitness Review',
    );
  } else if (lower.includes('planner') || lower.includes('daily') || lower.includes('weekly')) {
    sections.push(
      'Monthly Calendar',
      'Weekly Spread',
      'Daily Schedule',
      'Priority Tasks',
      'Notes & Ideas',
      'Goal Setting',
      'Weekly Review',
    );
  } else if (lower.includes('goal') || lower.includes('productivity')) {
    sections.push(
      'Yearly Goals Overview',
      'Quarterly Breakdown',
      'Monthly Milestones',
      'Weekly Action Items',
      'Progress Chart',
      'Obstacle & Solution Log',
      'Achievement Tracker',
    );
  } else {
    // Generic but still meaningful
    sections.push(
      'Introduction & Instructions',
      'Monthly Overview',
      'Weekly Tracker',
      'Daily Log',
      'Progress Chart',
      'Reflection & Notes',
    );
  }

  // Adjust length to roughly match page count
  if (sections.length > pageCount) {
    return sections.slice(0, pageCount);
  }

  return sections;
}

export async function generateBriefWithAI(
  opportunity: Opportunity,
  intel: CompetitiveIntel,
): Promise<EnhancedProductBrief> {
  logger.info(`Generating AI-enhanced brief for niche: ${opportunity.niche}`);

  // Start with the data-driven brief as a baseline
  const baseBrief = generateEnhancedBrief(opportunity, intel);

  // Build a concise summary for the AI
  const topRefSummary = intel.referenceListings.slice(0, 3).map((ref) => ({
    title: ref.title,
    price: ref.price,
    reviews: ref.reviews,
    whyReference: ref.whyReference,
    structuralPatterns: ref.structuralPatterns,
  }));

  const prompt = `You are designing a printable PDF digital product for the "${opportunity.niche}" niche on Etsy.

## Market intelligence:
- Recommended price: $${intel.pricingStrategy.recommendedPrice} (${intel.pricingStrategy.recommendedTier} tier)
- Price reasoning: ${intel.pricingStrategy.priceReasoning}
- Common sections in top sellers: ${intel.bestPractices.productPatterns.commonSections.join(', ') || 'unknown'}
- Layout style: ${intel.bestPractices.productPatterns.layoutStyle || 'unknown'}
- Color schemes: ${intel.bestPractices.productPatterns.colorSchemes.join('; ') || 'unknown'}
- Font styles: ${intel.bestPractices.productPatterns.fontStyles.join('; ') || 'unknown'}
- Keywords: ${opportunity.keywords.join(', ')}
- Average page count: ${intel.bestPractices.productPatterns.avgPageCount || 'unknown'}

## Top reference listings:
${JSON.stringify(topRefSummary, null, 2)}

## Top seller key selling points:
${intel.bestPractices.descriptionPatterns.keySellingPoints.join(', ') || 'unknown'}

## Your task:
Generate a product brief as JSON (no markdown fences) with this exact structure:

{
  "targetAudience": "<specific audience, e.g. 'busy working moms who want to build daily wellness routines'>",
  "sections": ["<section1>", "<section2>", ...],
  "styleGuide": {
    "primaryFont": "<specific font name>",
    "accentColor": "<specific color>",
    "palette": "<comma-separated color palette>",
    "layout": "<layout description>"
  },
  "differentiators": ["<what makes this product stand out from reference listings>", ...]
}

Rules:
- The target audience must be SPECIFIC — who exactly buys this, what problem they solve, and why printable format works for them.
- Sections must be ACTUAL content section names (e.g. "Weekly Habit Grid", "Monthly Reflection Page", "Progress Chart") — NEVER "Cover" or "Page 2".
- Include ${baseBrief.pageCount > 15 ? '8-15' : '4-8'} sections that match or exceed what top sellers offer.
- Style choices should differentiate from competitors while matching the market's aesthetic expectations.
- Differentiators should be specific competitive advantages, not generic claims.`;

  const systemPrompt =
    'You are a product strategist for Etsy digital printables. ' +
    'Return ONLY valid JSON, no markdown code fences, no commentary.';

  try {
    const response = await callClaude(prompt, {
      systemPrompt,
      maxTokens: 2048,
      temperature: 0.5,
    });

    const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as AIBriefResponse;

    // Merge AI suggestions into the data-driven brief
    const enhanced: EnhancedProductBrief = {
      ...baseBrief,
      targetAudience: parsed.targetAudience || baseBrief.targetAudience,
      sections: Array.isArray(parsed.sections) && parsed.sections.length > 0
        ? parsed.sections
        : baseBrief.sections,
      styleGuide: {
        primaryFont: parsed.styleGuide?.primaryFont || baseBrief.styleGuide.primaryFont,
        accentColor: parsed.styleGuide?.accentColor || baseBrief.styleGuide.accentColor,
        palette: parsed.styleGuide?.palette || baseBrief.styleGuide.palette,
        layout: parsed.styleGuide?.layout || baseBrief.styleGuide.layout,
      },
      competitiveIntel: {
        ...baseBrief.competitiveIntel,
        topSellerPatterns: Array.isArray(parsed.differentiators) && parsed.differentiators.length > 0
          ? [...baseBrief.competitiveIntel.topSellerPatterns, ...parsed.differentiators]
          : baseBrief.competitiveIntel.topSellerPatterns,
      },
    };

    // Update page count to match section count if AI gave more sections
    if (enhanced.sections.length > enhanced.pageCount) {
      enhanced.pageCount = enhanced.sections.length;
    }

    logger.info(`AI-enhanced brief generated for niche: ${opportunity.niche}`, {
      sectionCount: enhanced.sections.length,
      targetAudience: enhanced.targetAudience,
    });

    return enhanced;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`AI brief generation failed, falling back to data-driven brief: ${message}`);
    return baseBrief;
  }
}

export async function runEnhancedStrategy(): Promise<AgentResult<EnhancedProductBrief[]>> {
  const startTime = performance.now();

  logger.info('Enhanced strategy agent starting');

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

    // Load competitive intel for each opportunity
    const intelMap = new Map<string, CompetitiveIntel>();
    for (const opp of opportunities) {
      const intel = await loadCompetitiveIntel(opp.id);
      if (intel) {
        intelMap.set(opp.id, intel);
        logger.info(`Loaded competitive intel for opportunity: ${opp.id} (${opp.niche})`);
      }
    }

    logger.info(`Competitive intel available for ${intelMap.size}/${opportunities.length} opportunities`);

    // Score all opportunities (intel quality is now a scoring factor)
    const scored = opportunities.map((opp) =>
      scoreOpportunity(opp, intelMap.get(opp.id), targetPriceRange),
    );
    scored.sort((a, b) => b.totalScore - a.totalScore);

    // Select top N
    const selected = scored.slice(0, productsPerDay);
    const briefs: EnhancedProductBrief[] = [];

    for (const item of selected) {
      const opp = item.opportunity;
      const intel = item.intel ?? buildSyntheticIntel(opp);
      const hasRealIntel = item.intel !== undefined;

      let brief: EnhancedProductBrief;

      if (hasRealIntel) {
        // Use AI-enhanced generation when we have real competitive data
        brief = await generateBriefWithAI(opp, intel);
      } else {
        // Fall back to data-driven generation with synthetic intel
        brief = generateEnhancedBrief(opp, intel);
        logger.info(`Using synthetic intel for niche: ${opp.niche} (no competitive data available)`);
      }

      // Create product directory and write artifacts
      const productDir = join(PRODUCTS_DIR, brief.id);
      await mkdir(productDir, { recursive: true });

      await writeFile(
        join(productDir, 'brief.json'),
        JSON.stringify(brief, null, 2),
        'utf-8',
      );

      await writeFile(
        join(productDir, 'competitive-intel.json'),
        JSON.stringify(intel, null, 2),
        'utf-8',
      );

      briefs.push(brief);

      logger.info(
        `Selected: niche="${brief.niche}" score=${item.totalScore} ` +
        `price=$${brief.competitiveIntel.recommendedPrice} ` +
        `tier=${brief.competitiveIntel.priceTier} ` +
        `sections=${brief.sections.length} ` +
        `intel=${hasRealIntel ? 'real' : 'synthetic'}`,
      );
    }

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'strategist-enhanced',
      action: 'enhanced-strategy-complete',
      details: `Evaluated ${opportunities.length} opportunities (${intelMap.size} with intel), selected ${briefs.length} for production`,
      duration,
      success: true,
    });

    logger.info(`Enhanced strategy complete: ${briefs.length} briefs generated in ${duration}ms`);

    return {
      success: true,
      data: briefs,
      duration,
    };
  } catch (error: unknown) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Enhanced strategy agent failed: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'strategist-enhanced',
      action: 'enhanced-strategy-failed',
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
