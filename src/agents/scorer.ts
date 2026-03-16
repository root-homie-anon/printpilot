import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief, ProductScores, ScoreReport } from '../types/index.js';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { logActivity } from '../tracker/activity-log.js';
import type { CopyResult } from './copywriter.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

interface DesignMeta {
  generationMethod?: string;
  template?: string;
  htmlPages: number;
  pdfPath: string;
  pageCount: number;
  fileSizeBytes: number;
  renderDuration: number;
}

interface AIScoreResponse {
  designQuality: {
    score: number;
    reasoning: string;
  };
  marketFit: {
    score: number;
    reasoning: string;
  };
  copyQuality: {
    score: number;
    reasoning: string;
  };
  overallSellability: {
    score: number;
    reasoning: string;
  };
  flags: string[];
  recommendation: string;
}

async function loadJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

function buildScoringPrompt(
  brief: ProductBrief,
  design: DesignMeta,
  copy: CopyResult,
): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return `You are an expert product quality analyst for Etsy digital printable products. Analyze this product holistically and provide detailed scoring.

## Product Brief
- Niche: ${nicheLabel}
- Target audience: ${brief.targetAudience}
- Requested page count: ${brief.pageCount}
- Sections: ${brief.sections.join(', ')}
- Style: ${brief.styleGuide.primaryFont} font, ${brief.styleGuide.accentColor} accent, ${brief.styleGuide.palette} palette, ${brief.styleGuide.layout} layout

## Design Data
- Generation method: ${design.generationMethod ?? design.template ?? 'unknown'}
- Rendered pages: ${design.pageCount}
- File size: ${design.fileSizeBytes} bytes
- Render duration: ${design.renderDuration}ms

## Copy
- Title (${copy.title.length} chars): "${copy.title}"
- Description (${copy.description.length} chars): "${copy.description.slice(0, 500)}..."
- Tags (${copy.tags.length}): ${copy.tags.join(', ')}
- Pinterest variants: ${copy.pinterestCopy.length}
- Has email copy: ${copy.emailCopy.length > 0}
- Has blog draft: ${copy.blogDraft.length > 0}

## Scoring Criteria

### Design Quality (0-100)
- Does the page count match the brief? (${design.pageCount} rendered vs ${brief.pageCount} requested)
- Is the file size reasonable for the page count?
- Was the style guide followed?
- Is the generation method appropriate?

### Market Fit (0-100)
- Is the niche specific enough to target buyers?
- Does the target audience make sense for this niche?
- Are the sections comprehensive and useful?
- Would this compete well against existing Etsy listings?

### Copy Quality (0-100)
- Is the title SEO-optimized with front-loaded keywords?
- Is the title within 140 chars and using the space effectively?
- Are there exactly 13 tags with good keyword diversity?
- Is the description benefit-focused and well-formatted?
- Are Pinterest descriptions varied and engaging?

### Overall Sellability (0-100)
- Weighted combination: design 35%, market fit 40%, copy 25%
- Would you buy this product?

## Response Format (valid JSON only):
{
  "designQuality": { "score": <0-100>, "reasoning": "<brief explanation>" },
  "marketFit": { "score": <0-100>, "reasoning": "<brief explanation>" },
  "copyQuality": { "score": <0-100>, "reasoning": "<brief explanation>" },
  "overallSellability": { "score": <0-100>, "reasoning": "<brief explanation>" },
  "flags": ["list of specific issues or concerns, if any"],
  "recommendation": "strong-approve | approve | marginal | reject"
}

Respond with ONLY the JSON object.`;
}

function parseAIScoreResponse(response: string): AIScoreResponse {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned) as AIScoreResponse;

  // Validate structure
  const categories = ['designQuality', 'marketFit', 'copyQuality', 'overallSellability'] as const;
  for (const cat of categories) {
    if (!parsed[cat] || typeof parsed[cat].score !== 'number') {
      throw new Error(`Missing or invalid score for ${cat}`);
    }
    // Clamp scores to 0-100
    parsed[cat].score = Math.max(0, Math.min(100, Math.round(parsed[cat].score)));
  }

  if (!Array.isArray(parsed.flags)) {
    parsed.flags = [];
  }

  const validRecommendations = ['strong-approve', 'approve', 'marginal', 'reject'];
  if (!validRecommendations.includes(parsed.recommendation)) {
    // Derive from overall score
    const overall = parsed.overallSellability.score;
    if (overall >= 80) parsed.recommendation = 'strong-approve';
    else if (overall >= 65) parsed.recommendation = 'approve';
    else if (overall >= 50) parsed.recommendation = 'marginal';
    else parsed.recommendation = 'reject';
  }

  return parsed;
}

// Fallback heuristic scoring (original logic)
function scoreDesignQualityFallback(brief: ProductBrief, design: DesignMeta): number {
  let score = 50;

  if (design.pageCount >= brief.pageCount) {
    score += 15;
  } else {
    score -= 10;
  }

  const bytesPerPage = design.fileSizeBytes / Math.max(1, design.pageCount);
  if (bytesPerPage > 5000 && bytesPerPage < 500_000) {
    score += 10;
  }

  if (brief.styleGuide.primaryFont) score += 8;
  if (brief.styleGuide.palette) score += 7;
  if (brief.styleGuide.accentColor) score += 5;

  const template = design.template ?? '';
  if (brief.niche.includes(template)) score += 5;

  return Math.max(0, Math.min(100, score));
}

function scoreMarketFitFallback(brief: ProductBrief): number {
  let score = 50;

  if (brief.sections.length >= 10) score += 15;
  else if (brief.sections.length >= 5) score += 8;

  if (brief.targetAudience.length > 10) score += 15;
  if (brief.niche.includes('-') || brief.niche.split(' ').length > 1) score += 10;
  if (brief.pageCount >= 6 && brief.pageCount <= 60) score += 10;

  return Math.max(0, Math.min(100, score));
}

function scoreCopyQualityFallback(copy: CopyResult): number {
  let score = 50;

  if (copy.title.length >= 60 && copy.title.length <= 140) score += 15;
  if (copy.tags.length === 13) score += 10;
  else if (copy.tags.length >= 10) score += 5;
  if (copy.description.length >= 300) score += 10;
  if (copy.pinterestCopy.length >= 3) score += 8;
  if (copy.blogDraft.length >= 200) score += 7;

  return Math.max(0, Math.min(100, score));
}

function buildFallbackScoreReport(
  productId: string,
  brief: ProductBrief,
  design: DesignMeta,
  copy: CopyResult,
): ScoreReport {
  const designQuality = scoreDesignQualityFallback(brief, design);
  const marketFit = scoreMarketFitFallback(brief);
  const copyQuality = scoreCopyQualityFallback(copy);
  const overallSellability = Math.round(
    designQuality * 0.35 + marketFit * 0.40 + copyQuality * 0.25,
  );

  const scores: Record<string, number> = {
    designQuality,
    marketFit,
    copyQuality,
    overallSellability,
  };

  let recommendation: string;
  if (overallSellability >= 80) recommendation = 'strong-approve';
  else if (overallSellability >= 65) recommendation = 'approve';
  else if (overallSellability >= 50) recommendation = 'marginal';
  else recommendation = 'reject';

  const flags: string[] = [];
  if (designQuality < 50) flags.push('Low design quality score');
  if (marketFit < 50) flags.push('Poor market fit');
  if (copyQuality < 50) flags.push('Copy needs improvement');
  if (copy.tags.length < 10) flags.push(`Only ${copy.tags.length} tags (target: 13)`);
  if (copy.title.length > 140) flags.push('Title exceeds 140 character limit');
  if (design.pageCount < brief.pageCount) {
    flags.push(`Page count mismatch: ${design.pageCount} rendered vs ${brief.pageCount} expected`);
  }
  if (brief.sections.length < 3) flags.push('Insufficient sections defined');

  return { productId, scores, recommendation, flags };
}

export async function runScoring(productId: string): Promise<AgentResult<ScoreReport>> {
  const startTime = performance.now();

  logger.info(`Scorer agent starting for product: ${productId}`);

  try {
    const productDir = join(PRODUCTS_DIR, productId);

    const brief = await loadJson<ProductBrief>(join(productDir, 'brief.json'));
    const design = await loadJson<DesignMeta>(join(productDir, 'design.json'));
    const copy = await loadJson<CopyResult>(join(productDir, 'copy.json'));

    let report: ScoreReport;
    let scoringMethod: string;

    try {
      const prompt = buildScoringPrompt(brief, design, copy);

      const response = await callClaude(prompt, {
        systemPrompt: 'You are an expert product quality analyst. Respond with valid JSON only, no markdown fences or additional text.',
        maxTokens: 2048,
        temperature: 0.3,
      });

      const aiScores = parseAIScoreResponse(response);

      report = {
        productId,
        scores: {
          designQuality: aiScores.designQuality.score,
          marketFit: aiScores.marketFit.score,
          copyQuality: aiScores.copyQuality.score,
          overallSellability: aiScores.overallSellability.score,
        },
        recommendation: aiScores.recommendation,
        flags: aiScores.flags,
      };

      // Write AI reasoning separately for reference
      const reasoningData = {
        designQuality: aiScores.designQuality.reasoning,
        marketFit: aiScores.marketFit.reasoning,
        copyQuality: aiScores.copyQuality.reasoning,
        overallSellability: aiScores.overallSellability.reasoning,
      };
      await writeFile(
        join(productDir, 'score-reasoning.json'),
        JSON.stringify(reasoningData, null, 2),
        'utf-8',
      );

      scoringMethod = 'ai';
      logger.info(`Using AI-powered scoring for ${productId}`);
    } catch (aiError) {
      const aiMessage = aiError instanceof Error ? aiError.message : String(aiError);
      logger.warn(
        `AI scoring failed for ${productId}, falling back to heuristics: ${aiMessage}`,
      );

      report = buildFallbackScoreReport(productId, brief, design, copy);
      scoringMethod = 'heuristic';
    }

    // Write score report
    await writeFile(
      join(productDir, 'score-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8',
    );

    // Write ProductScores format for compatibility
    const productScores: ProductScores = {
      layout: report.scores.designQuality,
      typography: Math.round(report.scores.designQuality * 0.9),
      color: Math.round(report.scores.designQuality * 0.85),
      differentiation: Math.round(report.scores.marketFit * 0.8),
      sellability: report.scores.overallSellability,
    };
    await writeFile(
      join(productDir, 'scores.json'),
      JSON.stringify(productScores, null, 2),
      'utf-8',
    );

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'scorer',
      action: 'scoring-complete',
      productId,
      details: `Overall: ${report.scores.overallSellability}/100, Recommendation: ${report.recommendation}, Flags: ${report.flags.length}, Method: ${scoringMethod}`,
      duration,
      success: true,
    });

    logger.info(
      `Scoring complete for ${productId}: ${report.scores.overallSellability}/100 (${report.recommendation}), ${report.flags.length} flags, method: ${scoringMethod}`,
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
