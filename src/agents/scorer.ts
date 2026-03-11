import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief, ProductScores } from '../types/index.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';
import type { CopyResult } from './copywriter.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

export interface ScoreReport {
  productId: string;
  scores: Record<string, number>;
  recommendation: string;
  flags: string[];
}

interface DesignMeta {
  template: string;
  htmlPages: number;
  pdfPath: string;
  pageCount: number;
  fileSizeBytes: number;
  renderDuration: number;
}

async function loadJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

function scoreDesignQuality(brief: ProductBrief, design: DesignMeta): number {
  let score = 50;

  // Page count alignment
  if (design.pageCount >= brief.pageCount) {
    score += 15;
  } else {
    score -= 10;
  }

  // File size sanity (PDFs should be substantial for multi-page docs)
  const bytesPerPage = design.fileSizeBytes / Math.max(1, design.pageCount);
  if (bytesPerPage > 5000 && bytesPerPage < 500_000) {
    score += 10;
  }

  // Style guide completeness
  if (brief.styleGuide.primaryFont) {
    score += 8;
  }
  if (brief.styleGuide.palette) {
    score += 7;
  }
  if (brief.styleGuide.accentColor) {
    score += 5;
  }

  // Template match bonus
  if (brief.niche.includes(design.template)) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

function scoreMarketFit(brief: ProductBrief): number {
  let score = 50;

  // Section count - more sections = more complete product
  if (brief.sections.length >= 10) {
    score += 15;
  } else if (brief.sections.length >= 5) {
    score += 8;
  }

  // Target audience specified
  if (brief.targetAudience.length > 10) {
    score += 15;
  }

  // Niche specificity
  if (brief.niche.includes('-') || brief.niche.split(' ').length > 1) {
    score += 10;
  }

  // Page count appropriateness
  if (brief.pageCount >= 6 && brief.pageCount <= 60) {
    score += 10;
  }

  return Math.max(0, Math.min(100, score));
}

function scoreCopyQuality(copy: CopyResult): number {
  let score = 50;

  // Title length optimization
  if (copy.title.length >= 60 && copy.title.length <= 140) {
    score += 15;
  }

  // Tag count
  if (copy.tags.length === 13) {
    score += 10;
  } else if (copy.tags.length >= 10) {
    score += 5;
  }

  // Description length
  if (copy.description.length >= 300) {
    score += 10;
  }

  // Pinterest copy variants
  if (copy.pinterestCopy.length >= 3) {
    score += 8;
  }

  // Blog draft present and substantial
  if (copy.blogDraft.length >= 200) {
    score += 7;
  }

  return Math.max(0, Math.min(100, score));
}

function calculateOverallSellability(
  designQuality: number,
  marketFit: number,
  copyQuality: number
): number {
  return Math.round(
    designQuality * 0.35 +
    marketFit * 0.40 +
    copyQuality * 0.25
  );
}

function determineRecommendation(overallScore: number): string {
  if (overallScore >= 80) return 'strong-approve';
  if (overallScore >= 65) return 'approve';
  if (overallScore >= 50) return 'marginal';
  return 'reject';
}

function identifyFlags(
  brief: ProductBrief,
  design: DesignMeta,
  copy: CopyResult,
  scores: Record<string, number>
): string[] {
  const flags: string[] = [];

  if (scores.designQuality < 50) {
    flags.push('Low design quality score');
  }

  if (scores.marketFit < 50) {
    flags.push('Poor market fit');
  }

  if (scores.copyQuality < 50) {
    flags.push('Copy needs improvement');
  }

  if (copy.tags.length < 10) {
    flags.push(`Only ${copy.tags.length} tags (target: 13)`);
  }

  if (copy.title.length > 140) {
    flags.push('Title exceeds 140 character limit');
  }

  if (design.pageCount < brief.pageCount) {
    flags.push(`Page count mismatch: ${design.pageCount} rendered vs ${brief.pageCount} expected`);
  }

  if (brief.sections.length < 3) {
    flags.push('Insufficient sections defined');
  }

  return flags;
}

export async function runScoring(productId: string): Promise<AgentResult<ScoreReport>> {
  const startTime = performance.now();

  logger.info(`Scorer agent starting for product: ${productId}`);

  try {
    const productDir = join(PRODUCTS_DIR, productId);

    const brief = await loadJson<ProductBrief>(join(productDir, 'brief.json'));
    const design = await loadJson<DesignMeta>(join(productDir, 'design.json'));
    const copy = await loadJson<CopyResult>(join(productDir, 'copy.json'));

    const designQuality = scoreDesignQuality(brief, design);
    const marketFit = scoreMarketFit(brief);
    const copyQuality = scoreCopyQuality(copy);
    const overallSellability = calculateOverallSellability(designQuality, marketFit, copyQuality);

    const scores: Record<string, number> = {
      designQuality,
      marketFit,
      copyQuality,
      overallSellability,
    };

    const recommendation = determineRecommendation(overallSellability);
    const flags = identifyFlags(brief, design, copy, scores);

    const report: ScoreReport = {
      productId,
      scores,
      recommendation,
      flags,
    };

    // Write score report
    await writeFile(
      join(productDir, 'score-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );

    // Write ProductScores format for compatibility
    const productScores: ProductScores = {
      layout: designQuality,
      typography: Math.round(designQuality * 0.9),
      color: Math.round(designQuality * 0.85),
      differentiation: Math.round(marketFit * 0.8),
      sellability: overallSellability,
    };
    await writeFile(
      join(productDir, 'scores.json'),
      JSON.stringify(productScores, null, 2),
      'utf-8'
    );

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'scorer',
      action: 'scoring-complete',
      productId,
      details: `Overall: ${overallSellability}/100, Recommendation: ${recommendation}, Flags: ${flags.length}`,
      duration,
      success: true,
    });

    logger.info(
      `Scoring complete for ${productId}: ${overallSellability}/100 (${recommendation}), ${flags.length} flags`
    );

    return {
      success: true,
      data: report,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Scorer agent failed for ${productId}: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'scorer',
      action: 'scoring-failed',
      productId,
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
