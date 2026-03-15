import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import type { AgentResult, ProductBrief } from '../types/index.js';
import type { CopyResult } from './copywriter.js';
import type {
  CompetitiveIntel,
  NicheBestPractices,
  PricingStrategy,
  ReferenceListingData,
} from '../research/competitive-intel.js';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ComparisonResult {
  productId: string;
  comparedAt: string;
  overallAlignment: number;

  designComparison: {
    score: number;
    pageCountMatch: boolean;
    layoutAlignment: string;
    colorSchemeMatch: string;
    fontMatch: string;
    gaps: string[];
    strengths: string[];
  };

  copyComparison: {
    score: number;
    titleAlignment: {
      score: number;
      keywordOverlap: string[];
      missingKeywords: string[];
      formatMatch: boolean;
    };
    descriptionAlignment: {
      score: number;
      structureMatch: boolean;
      missingElements: string[];
      sellingPointCoverage: number;
    };
    tagAlignment: {
      score: number;
      overlappingTags: string[];
      missingHighValueTags: string[];
      uniqueTags: string[];
    };
  };

  pricingComparison: {
    ourPrice: number;
    marketMedian: number;
    recommendedPrice: number;
    competitivePosition: string;
  };

  actionItems: string[];
  readyToList: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DesignMeta {
  generationMethod?: string;
  template?: string;
  htmlPages: number;
  pdfPath: string;
  pageCount: number;
  fileSizeBytes: number;
  renderDuration: number;
}

interface AICopyComparisonResponse {
  titleAlignment: {
    score: number;
    keywordOverlap: string[];
    missingKeywords: string[];
    formatMatch: boolean;
    reasoning: string;
  };
  descriptionAlignment: {
    score: number;
    structureMatch: boolean;
    missingElements: string[];
    sellingPointCoverage: number;
    reasoning: string;
  };
  tagAlignment: {
    score: number;
    overlappingTags: string[];
    missingHighValueTags: string[];
    uniqueTags: string[];
    reasoning: string;
  };
  overallCopyScore: number;
  actionItems: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

const ALIGNMENT_THRESHOLD = 65;
const DESIGN_WEIGHT = 0.35;
const COPY_WEIGHT = 0.40;
const PRICING_WEIGHT = 0.25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseAIResponse(response: string): AICopyComparisonResponse {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned) as AICopyComparisonResponse;

  // Validate and clamp scores
  parsed.titleAlignment.score = clampScore(parsed.titleAlignment.score);
  parsed.descriptionAlignment.score = clampScore(parsed.descriptionAlignment.score);
  parsed.tagAlignment.score = clampScore(parsed.tagAlignment.score);
  parsed.overallCopyScore = clampScore(parsed.overallCopyScore);

  parsed.descriptionAlignment.sellingPointCoverage = Math.max(
    0,
    Math.min(100, Math.round(parsed.descriptionAlignment.sellingPointCoverage)),
  );

  if (!Array.isArray(parsed.titleAlignment.keywordOverlap)) {
    parsed.titleAlignment.keywordOverlap = [];
  }
  if (!Array.isArray(parsed.titleAlignment.missingKeywords)) {
    parsed.titleAlignment.missingKeywords = [];
  }
  if (!Array.isArray(parsed.descriptionAlignment.missingElements)) {
    parsed.descriptionAlignment.missingElements = [];
  }
  if (!Array.isArray(parsed.tagAlignment.overlappingTags)) {
    parsed.tagAlignment.overlappingTags = [];
  }
  if (!Array.isArray(parsed.tagAlignment.missingHighValueTags)) {
    parsed.tagAlignment.missingHighValueTags = [];
  }
  if (!Array.isArray(parsed.tagAlignment.uniqueTags)) {
    parsed.tagAlignment.uniqueTags = [];
  }
  if (!Array.isArray(parsed.actionItems)) {
    parsed.actionItems = [];
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Design comparison (heuristic)
// ---------------------------------------------------------------------------

export function compareDesign(
  brief: ProductBrief,
  designMeta: DesignMeta,
  bestPractices: NicheBestPractices,
): ComparisonResult['designComparison'] {
  const gaps: string[] = [];
  const strengths: string[] = [];
  let score = 50;

  // Page count comparison
  const pageCountMatch = designMeta.pageCount >= bestPractices.productPatterns.avgPageCount;
  if (pageCountMatch) {
    score += 10;
    strengths.push(
      `Page count (${designMeta.pageCount}) meets or exceeds market average (${bestPractices.productPatterns.avgPageCount})`,
    );
  } else {
    score -= 10;
    gaps.push(
      `Page count (${designMeta.pageCount}) is below market average (${bestPractices.productPatterns.avgPageCount})`,
    );
  }

  // Layout alignment
  const marketLayout = bestPractices.productPatterns.layoutStyle.toLowerCase();
  const ourLayout = brief.styleGuide.layout.toLowerCase();
  const layoutAlignment = ourLayout.includes(marketLayout) || marketLayout.includes(ourLayout)
    ? 'Strong match with market-dominant layout style'
    : `Our layout ("${brief.styleGuide.layout}") differs from market preference ("${bestPractices.productPatterns.layoutStyle}")`;

  if (ourLayout.includes(marketLayout) || marketLayout.includes(ourLayout)) {
    score += 10;
    strengths.push('Layout style aligns with top sellers');
  } else {
    score -= 5;
    gaps.push(`Market favors "${bestPractices.productPatterns.layoutStyle}" layout`);
  }

  // Color scheme comparison
  const marketColors = bestPractices.productPatterns.colorSchemes.map((c) => c.toLowerCase());
  const ourPalette = brief.styleGuide.palette.toLowerCase();
  const ourAccent = brief.styleGuide.accentColor.toLowerCase();
  const colorMatch = marketColors.some(
    (c) => ourPalette.includes(c) || ourAccent.includes(c) || c.includes(ourPalette),
  );
  const colorSchemeMatch = colorMatch
    ? 'Color scheme aligns with market preferences'
    : `Market prefers color schemes: ${bestPractices.productPatterns.colorSchemes.join(', ')}`;

  if (colorMatch) {
    score += 10;
    strengths.push('Color palette matches market trends');
  } else {
    score -= 5;
    gaps.push(`Consider adopting market-preferred colors: ${bestPractices.productPatterns.colorSchemes.join(', ')}`);
  }

  // Font comparison
  const marketFonts = bestPractices.productPatterns.fontStyles.map((f) => f.toLowerCase());
  const ourFont = brief.styleGuide.primaryFont.toLowerCase();
  const fontMatches = marketFonts.some(
    (f) => ourFont.includes(f) || f.includes(ourFont),
  );
  const fontMatch = fontMatches
    ? 'Font choice aligns with market preferences'
    : `Market prefers font styles: ${bestPractices.productPatterns.fontStyles.join(', ')}`;

  if (fontMatches) {
    score += 10;
    strengths.push('Font style matches market trends');
  } else {
    score -= 5;
    gaps.push(`Consider fonts in the style of: ${bestPractices.productPatterns.fontStyles.join(', ')}`);
  }

  // Section coverage
  const commonSections = bestPractices.productPatterns.commonSections.map((s) => s.toLowerCase());
  const ourSections = brief.sections.map((s) => s.toLowerCase());
  const missingSections = commonSections.filter(
    (cs) => !ourSections.some((os) => os.includes(cs) || cs.includes(os)),
  );

  if (missingSections.length === 0) {
    score += 10;
    strengths.push('All common market sections included');
  } else if (missingSections.length <= 2) {
    score += 5;
    gaps.push(`Missing commonly seen sections: ${missingSections.join(', ')}`);
  } else {
    score -= 5;
    gaps.push(`Missing ${missingSections.length} common sections: ${missingSections.join(', ')}`);
  }

  return {
    score: clampScore(score),
    pageCountMatch,
    layoutAlignment,
    colorSchemeMatch,
    fontMatch,
    gaps,
    strengths,
  };
}

// ---------------------------------------------------------------------------
// Copy comparison (AI-powered)
// ---------------------------------------------------------------------------

function buildCopyComparisonPrompt(
  copy: CopyResult,
  intel: CompetitiveIntel,
): string {
  const topRefs = intel.referenceListings
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, 3);

  const refTitles = topRefs
    .map((r, i) => `  ${i + 1}. "${r.title}" (${r.reviews} reviews, ${r.favorites} favorites)`)
    .join('\n');

  const refTags = topRefs
    .flatMap((r) => r.tags)
    .filter((tag, idx, arr) => arr.indexOf(tag) === idx)
    .slice(0, 30);

  const refDescriptions = topRefs
    .map((r, i) => `  ${i + 1}. "${r.descriptionExcerpt}"`)
    .join('\n');

  const bestPractices = intel.bestPractices;

  return `You are an expert Etsy SEO and copywriting analyst. Compare our product listing copy against successful reference listings and market best practices.

## Our Listing
- Title (${copy.title.length} chars): "${copy.title}"
- Description (${copy.description.length} chars): "${copy.description.slice(0, 800)}"
- Tags (${copy.tags.length}): ${copy.tags.join(', ')}

## Top Reference Listings (by reviews)
${refTitles}

## Reference Tags (combined from top sellers):
${refTags.join(', ')}

## Reference Description Excerpts:
${refDescriptions}

## Market Best Practices
### Title Patterns
- Average length: ${bestPractices.titlePatterns.avgLength} chars
- Front-loaded keywords: ${bestPractices.titlePatterns.frontLoadedKeywords.join(', ')}
- Common formats: ${bestPractices.titlePatterns.commonFormats.join(', ')}

### Description Patterns
- Average length: ${bestPractices.descriptionPatterns.avgLength} chars
- Structure: ${bestPractices.descriptionPatterns.structure.join(' -> ')}
- Key selling points: ${bestPractices.descriptionPatterns.keySellingPoints.join(', ')}

### Tag Patterns
- Common tags: ${bestPractices.tagPatterns.commonTags.join(', ')}
- Broad: ${bestPractices.tagPatterns.tagCategories.broad.join(', ')}
- Specific: ${bestPractices.tagPatterns.tagCategories.specific.join(', ')}
- Long-tail: ${bestPractices.tagPatterns.tagCategories.longTail.join(', ')}

## Analysis Instructions
Compare our listing against the references and best practices. For each dimension, provide a score (0-100) and specific, actionable feedback.

Respond with ONLY valid JSON in this exact format:
{
  "titleAlignment": {
    "score": <0-100>,
    "keywordOverlap": ["keywords we share with top sellers"],
    "missingKeywords": ["high-value keywords top sellers use that we don't"],
    "formatMatch": <true if our title format matches winning patterns>,
    "reasoning": "<brief explanation>"
  },
  "descriptionAlignment": {
    "score": <0-100>,
    "structureMatch": <true if our description follows winning structure>,
    "missingElements": ["specific elements we're missing"],
    "sellingPointCoverage": <0-100, percentage of key selling points we hit>,
    "reasoning": "<brief explanation>"
  },
  "tagAlignment": {
    "score": <0-100>,
    "overlappingTags": ["tags we share with successful listings"],
    "missingHighValueTags": ["important tags we should add"],
    "uniqueTags": ["our tags not in the reference set"],
    "reasoning": "<brief explanation>"
  },
  "overallCopyScore": <0-100>,
  "actionItems": ["specific things to fix or improve"]
}`;
}

export async function compareCopyWithAI(
  copy: CopyResult,
  intel: CompetitiveIntel,
): Promise<ComparisonResult['copyComparison']> {
  const prompt = buildCopyComparisonPrompt(copy, intel);

  const response = await callClaude(prompt, {
    systemPrompt: 'You are an expert Etsy copywriting analyst. Respond with valid JSON only, no markdown fences or additional text.',
    maxTokens: 3072,
    temperature: 0.3,
  });

  const parsed = parseAIResponse(response);

  return {
    score: parsed.overallCopyScore,
    titleAlignment: {
      score: parsed.titleAlignment.score,
      keywordOverlap: parsed.titleAlignment.keywordOverlap,
      missingKeywords: parsed.titleAlignment.missingKeywords,
      formatMatch: parsed.titleAlignment.formatMatch,
    },
    descriptionAlignment: {
      score: parsed.descriptionAlignment.score,
      structureMatch: parsed.descriptionAlignment.structureMatch,
      missingElements: parsed.descriptionAlignment.missingElements,
      sellingPointCoverage: parsed.descriptionAlignment.sellingPointCoverage,
    },
    tagAlignment: {
      score: parsed.tagAlignment.score,
      overlappingTags: parsed.tagAlignment.overlappingTags,
      missingHighValueTags: parsed.tagAlignment.missingHighValueTags,
      uniqueTags: parsed.tagAlignment.uniqueTags,
    },
  };
}

// ---------------------------------------------------------------------------
// Pricing comparison (heuristic)
// ---------------------------------------------------------------------------

export function comparePricing(
  briefPrice: number,
  pricingStrategy: PricingStrategy,
): ComparisonResult['pricingComparison'] {
  const marketMedian = pricingStrategy.priceDistribution.median;
  const recommendedPrice = pricingStrategy.recommendedPrice;

  let competitivePosition: string;
  if (marketMedian <= 0) {
    competitivePosition = 'unknown';
  } else {
    const ratio = briefPrice / marketMedian;
    if (ratio < 0.75) {
      competitivePosition = 'underpriced';
    } else if (ratio > 1.25) {
      competitivePosition = 'overpriced';
    } else {
      competitivePosition = 'competitive';
    }
  }

  return {
    ourPrice: briefPrice,
    marketMedian,
    recommendedPrice,
    competitivePosition,
  };
}

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

export function determineReadiness(comparison: ComparisonResult): boolean {
  if (comparison.overallAlignment < ALIGNMENT_THRESHOLD) {
    return false;
  }

  // Check for critical design gaps
  if (comparison.designComparison.score < 40) {
    return false;
  }

  // Check for critical copy gaps
  if (comparison.copyComparison.score < 40) {
    return false;
  }

  // Check pricing is not overpriced
  if (comparison.pricingComparison.competitivePosition === 'overpriced') {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Fallback copy comparison (when AI call fails)
// ---------------------------------------------------------------------------

function compareCopyFallback(
  copy: CopyResult,
  intel: CompetitiveIntel,
): ComparisonResult['copyComparison'] {
  const bestPractices = intel.bestPractices;

  // Title alignment heuristic
  const titleKeywords = bestPractices.titlePatterns.frontLoadedKeywords.map((k) => k.toLowerCase());
  const titleLower = copy.title.toLowerCase();
  const keywordOverlap = titleKeywords.filter((k) => titleLower.includes(k));
  const missingKeywords = titleKeywords.filter((k) => !titleLower.includes(k));
  const formatMatch = copy.title.length >= bestPractices.titlePatterns.avgLength * 0.7
    && copy.title.length <= bestPractices.titlePatterns.avgLength * 1.5;

  let titleScore = 50;
  titleScore += keywordOverlap.length * 10;
  titleScore -= missingKeywords.length * 5;
  if (formatMatch) titleScore += 10;

  // Tag alignment heuristic
  const commonTagsLower = bestPractices.tagPatterns.commonTags.map((t) => t.toLowerCase());
  const ourTagsLower = copy.tags.map((t) => t.toLowerCase());
  const overlappingTags = ourTagsLower.filter((t) =>
    commonTagsLower.some((ct) => ct.includes(t) || t.includes(ct)),
  );
  const missingHighValueTags = commonTagsLower
    .filter((ct) => !ourTagsLower.some((t) => ct.includes(t) || t.includes(ct)))
    .slice(0, 5);
  const uniqueTags = ourTagsLower.filter((t) =>
    !commonTagsLower.some((ct) => ct.includes(t) || t.includes(ct)),
  );

  let tagScore = 50;
  tagScore += overlappingTags.length * 5;
  tagScore -= missingHighValueTags.length * 3;
  if (copy.tags.length === 13) tagScore += 10;

  // Description alignment heuristic
  const sellingPoints = bestPractices.descriptionPatterns.keySellingPoints.map((s) => s.toLowerCase());
  const descLower = copy.description.toLowerCase();
  const matchedPoints = sellingPoints.filter((sp) => descLower.includes(sp));
  const sellingPointCoverage = sellingPoints.length > 0
    ? Math.round((matchedPoints.length / sellingPoints.length) * 100)
    : 50;

  let descScore = 50;
  descScore += sellingPointCoverage > 60 ? 15 : sellingPointCoverage > 30 ? 5 : -5;
  if (copy.description.length >= bestPractices.descriptionPatterns.avgLength * 0.7) {
    descScore += 10;
  }

  const structureMatch = copy.description.length >= bestPractices.descriptionPatterns.avgLength * 0.5;
  const missingElements = sellingPoints
    .filter((sp) => !descLower.includes(sp))
    .slice(0, 5);

  const overallScore = Math.round(titleScore * 0.35 + tagScore * 0.35 + descScore * 0.30);

  return {
    score: clampScore(overallScore),
    titleAlignment: {
      score: clampScore(titleScore),
      keywordOverlap,
      missingKeywords,
      formatMatch,
    },
    descriptionAlignment: {
      score: clampScore(descScore),
      structureMatch,
      missingElements,
      sellingPointCoverage,
    },
    tagAlignment: {
      score: clampScore(tagScore),
      overlappingTags,
      missingHighValueTags,
      uniqueTags,
    },
  };
}

// ---------------------------------------------------------------------------
// Collect action items from all dimensions
// ---------------------------------------------------------------------------

function collectActionItems(
  designComparison: ComparisonResult['designComparison'],
  copyComparison: ComparisonResult['copyComparison'],
  pricingComparison: ComparisonResult['pricingComparison'],
): string[] {
  const items: string[] = [];

  // Design action items
  for (const gap of designComparison.gaps) {
    items.push(`[Design] ${gap}`);
  }

  // Copy action items - title
  if (copyComparison.titleAlignment.missingKeywords.length > 0) {
    items.push(
      `[Title] Add missing high-value keywords: ${copyComparison.titleAlignment.missingKeywords.slice(0, 3).join(', ')}`,
    );
  }
  if (!copyComparison.titleAlignment.formatMatch) {
    items.push('[Title] Adjust title format to match winning patterns');
  }

  // Copy action items - description
  if (!copyComparison.descriptionAlignment.structureMatch) {
    items.push('[Description] Restructure description to match winning format');
  }
  if (copyComparison.descriptionAlignment.missingElements.length > 0) {
    items.push(
      `[Description] Add missing elements: ${copyComparison.descriptionAlignment.missingElements.slice(0, 3).join(', ')}`,
    );
  }
  if (copyComparison.descriptionAlignment.sellingPointCoverage < 50) {
    items.push(
      `[Description] Selling point coverage is only ${copyComparison.descriptionAlignment.sellingPointCoverage}% - add more key benefits`,
    );
  }

  // Copy action items - tags
  if (copyComparison.tagAlignment.missingHighValueTags.length > 0) {
    items.push(
      `[Tags] Add high-value tags: ${copyComparison.tagAlignment.missingHighValueTags.slice(0, 5).join(', ')}`,
    );
  }

  // Pricing action items
  if (pricingComparison.competitivePosition === 'overpriced') {
    items.push(
      `[Pricing] Price ($${pricingComparison.ourPrice}) is above market - consider reducing to $${pricingComparison.recommendedPrice}`,
    );
  } else if (pricingComparison.competitivePosition === 'underpriced') {
    items.push(
      `[Pricing] Price ($${pricingComparison.ourPrice}) may be too low - consider raising to $${pricingComparison.recommendedPrice} for better margins`,
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main comparison runner
// ---------------------------------------------------------------------------

export async function runComparison(
  productId: string,
): Promise<AgentResult<ComparisonResult>> {
  const startTime = performance.now();

  logger.info(`Reference comparator starting for product: ${productId}`);

  try {
    const productDir = join(PRODUCTS_DIR, productId);

    // Load required files
    const brief = await loadJson<ProductBrief>(join(productDir, 'brief.json'));
    const copy = await loadJson<CopyResult>(join(productDir, 'copy.json'));
    const designMeta = await loadJson<DesignMeta>(join(productDir, 'design.json'));

    // Check if competitive intel exists
    const intelPath = join(productDir, 'competitive-intel.json');
    const hasIntel = await fileExists(intelPath);

    if (!hasIntel) {
      logger.warn(
        `No competitive-intel.json found for ${productId} - returning partial result`,
      );

      const duration = Math.round(performance.now() - startTime);
      const partialResult: ComparisonResult = {
        productId,
        comparedAt: new Date().toISOString(),
        overallAlignment: 0,
        designComparison: {
          score: 0,
          pageCountMatch: false,
          layoutAlignment: 'Unable to compare - no competitive intelligence available',
          colorSchemeMatch: 'Unable to compare - no competitive intelligence available',
          fontMatch: 'Unable to compare - no competitive intelligence available',
          gaps: ['No competitive intelligence data available for comparison'],
          strengths: [],
        },
        copyComparison: {
          score: 0,
          titleAlignment: {
            score: 0,
            keywordOverlap: [],
            missingKeywords: [],
            formatMatch: false,
          },
          descriptionAlignment: {
            score: 0,
            structureMatch: false,
            missingElements: [],
            sellingPointCoverage: 0,
          },
          tagAlignment: {
            score: 0,
            overlappingTags: [],
            missingHighValueTags: [],
            uniqueTags: copy.tags,
          },
        },
        pricingComparison: {
          ourPrice: 0,
          marketMedian: 0,
          recommendedPrice: 0,
          competitivePosition: 'unknown',
        },
        actionItems: [
          'Run competitive intelligence research before comparison can be performed',
        ],
        readyToList: false,
      };

      await writeFile(
        join(productDir, 'comparison.json'),
        JSON.stringify(partialResult, null, 2),
        'utf-8',
      );

      return {
        success: true,
        data: partialResult,
        duration,
      };
    }

    const intel = await loadJson<CompetitiveIntel>(intelPath);

    // Run design comparison
    const designComparison = compareDesign(brief, designMeta, intel.bestPractices);
    logger.info(`Design comparison complete for ${productId}: score ${designComparison.score}`);

    // Run copy comparison (AI-powered with fallback)
    let copyComparison: ComparisonResult['copyComparison'];
    let copyMethod: string;

    try {
      copyComparison = await compareCopyWithAI(copy, intel);
      copyMethod = 'ai';
      logger.info(`AI copy comparison complete for ${productId}: score ${copyComparison.score}`);
    } catch (aiError) {
      const aiMessage = aiError instanceof Error ? aiError.message : String(aiError);
      logger.warn(
        `AI copy comparison failed for ${productId}, using fallback: ${aiMessage}`,
      );
      copyComparison = compareCopyFallback(copy, intel);
      copyMethod = 'heuristic';
      logger.info(`Fallback copy comparison complete for ${productId}: score ${copyComparison.score}`);
    }

    // Run pricing comparison
    // Extract price from brief or intel - use recommended price as our target if not set
    const ourPrice = intel.pricingStrategy.recommendedPrice > 0
      ? intel.pricingStrategy.recommendedPrice
      : intel.pricingStrategy.priceDistribution.median;
    const pricingComparison = comparePricing(ourPrice, intel.pricingStrategy);
    logger.info(`Pricing comparison complete for ${productId}: ${pricingComparison.competitivePosition}`);

    // Calculate pricing score for overall alignment
    let pricingScore: number;
    switch (pricingComparison.competitivePosition) {
      case 'competitive':
        pricingScore = 85;
        break;
      case 'underpriced':
        pricingScore = 60;
        break;
      case 'overpriced':
        pricingScore = 40;
        break;
      default:
        pricingScore = 50;
    }

    // Calculate overall alignment (weighted average)
    const overallAlignment = clampScore(
      Math.round(
        designComparison.score * DESIGN_WEIGHT
        + copyComparison.score * COPY_WEIGHT
        + pricingScore * PRICING_WEIGHT,
      ),
    );

    // Collect action items
    const actionItems = collectActionItems(designComparison, copyComparison, pricingComparison);

    // Build result
    const result: ComparisonResult = {
      productId,
      comparedAt: new Date().toISOString(),
      overallAlignment,
      designComparison,
      copyComparison,
      pricingComparison,
      actionItems,
      readyToList: false, // Placeholder, determined below
    };

    result.readyToList = determineReadiness(result);

    // Write comparison result
    await writeFile(
      join(productDir, 'comparison.json'),
      JSON.stringify(result, null, 2),
      'utf-8',
    );

    const duration = Math.round(performance.now() - startTime);

    logger.info(
      `Reference comparison complete for ${productId}: alignment ${overallAlignment}/100, ` +
      `ready: ${result.readyToList}, action items: ${actionItems.length}, ` +
      `copy method: ${copyMethod}`,
    );

    return {
      success: true,
      data: result,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Reference comparator failed for ${productId}: ${message}`);

    return {
      success: false,
      error: message,
      duration,
    };
  }
}
