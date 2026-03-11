import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief } from '../types/index.js';
import logger from '../utils/logger.js';
import { callClaude } from '../utils/claude.js';
import { logActivity } from '../tracker/activity-log.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

const MAX_ETSY_TITLE_LENGTH = 140;
const ETSY_TAG_COUNT = 13;
const MAX_COPY_RETRIES = 1;

export interface CopyResult {
  title: string;
  description: string;
  tags: string[];
  pinterestCopy: string[];
  emailCopy: string;
  blogDraft: string;
}

interface AICopyResponse {
  title: string;
  description: string;
  tags: string[];
  pinterestDescriptions: string[];
  emailAnnouncement: string;
  blogDraft: string;
}

async function loadBrief(productId: string): Promise<ProductBrief> {
  const briefPath = join(PRODUCTS_DIR, productId, 'brief.json');
  const content = await readFile(briefPath, 'utf-8');
  return JSON.parse(content) as ProductBrief;
}

function buildCopyPrompt(brief: ProductBrief): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return `You are an expert Etsy SEO copywriter specializing in digital printable products.

## Product Brief
- Niche: ${nicheLabel}
- Target audience: ${brief.targetAudience}
- Page count: ${brief.pageCount}
- Sections included: ${brief.sections.join(', ')}
- Style: ${brief.styleGuide.layout} layout, ${brief.styleGuide.palette} palette

## Etsy SEO Best Practices
- Front-load the most important keywords in the title
- Use all 13 tags — mix of broad and long-tail keywords
- Include buyer-intent keywords (printable, digital download, instant download)
- Description should lead with benefits, not features
- Use natural language that matches what buyers search for
- Tags should be 2-4 words each, no single-word tags
- Never repeat the exact same phrase across tags

## Generate the following (respond with valid JSON only):

{
  "title": "Etsy listing title, max ${MAX_ETSY_TITLE_LENGTH} characters, front-loaded with primary keywords for ${nicheLabel}",
  "description": "Full Etsy listing description. Start with a compelling benefit statement. Include: what the buyer gets, who it is for, how to use it, what is included (${brief.pageCount} pages, sections list). Format with line breaks and emojis for scannability. Minimum 300 characters.",
  "tags": ["exactly 13 Etsy tags", "mix of broad and long-tail", "2-4 words each", "relevant to ${nicheLabel}", "include printable + digital download variants", "..."],
  "pinterestDescriptions": ["3 unique Pinterest pin descriptions with hashtags, each 150-300 chars, different angles/hooks"],
  "emailAnnouncement": "Email announcement with subject line, preview text, body copy, and CTA. Target: existing subscribers who like printables.",
  "blogDraft": "SEO blog post draft (500-800 words) about the product. Include H2 headings, benefits, use cases, and a CTA to the Etsy listing."
}

Respond with ONLY the JSON object, no additional text or markdown.`;
}

function parseAICopyResponse(response: string): AICopyResponse {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned) as AICopyResponse;

  // Validate required fields
  if (!parsed.title || typeof parsed.title !== 'string') {
    throw new Error('Missing or invalid title in AI response');
  }
  if (!parsed.description || typeof parsed.description !== 'string') {
    throw new Error('Missing or invalid description in AI response');
  }
  if (!Array.isArray(parsed.tags)) {
    throw new Error('Missing or invalid tags in AI response');
  }
  if (!Array.isArray(parsed.pinterestDescriptions)) {
    throw new Error('Missing or invalid pinterestDescriptions in AI response');
  }
  if (!parsed.emailAnnouncement || typeof parsed.emailAnnouncement !== 'string') {
    throw new Error('Missing or invalid emailAnnouncement in AI response');
  }
  if (!parsed.blogDraft || typeof parsed.blogDraft !== 'string') {
    throw new Error('Missing or invalid blogDraft in AI response');
  }

  return parsed;
}

function validateAndFixCopy(
  parsed: AICopyResponse,
  brief: ProductBrief,
): CopyResult {
  // Fix title length
  let title = parsed.title;
  if (title.length > MAX_ETSY_TITLE_LENGTH) {
    title = title.slice(0, MAX_ETSY_TITLE_LENGTH - 3) + '...';
    logger.warn(`Title truncated to ${MAX_ETSY_TITLE_LENGTH} chars`);
  }

  // Fix tag count
  let tags = parsed.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0);
  if (tags.length > ETSY_TAG_COUNT) {
    tags = tags.slice(0, ETSY_TAG_COUNT);
  } else if (tags.length < ETSY_TAG_COUNT) {
    // Supplement with fallback tags
    const fallbackTags = generateFallbackTags(brief);
    for (const fallback of fallbackTags) {
      if (tags.length >= ETSY_TAG_COUNT) break;
      if (!tags.includes(fallback)) {
        tags.push(fallback);
      }
    }
    tags = tags.slice(0, ETSY_TAG_COUNT);
  }

  // Ensure 3 Pinterest descriptions
  let pinterestCopy = parsed.pinterestDescriptions.filter(
    (desc) => typeof desc === 'string' && desc.trim().length > 0,
  );
  if (pinterestCopy.length < 3) {
    const nicheLabel = brief.niche.replace(/-/g, ' ');
    while (pinterestCopy.length < 3) {
      pinterestCopy.push(
        `Check out our new ${nicheLabel} printable! ${brief.pageCount} pages, instant download. #printable #${brief.niche.replace(/-/g, '')}`,
      );
    }
  }
  pinterestCopy = pinterestCopy.slice(0, 3);

  return {
    title,
    description: parsed.description,
    tags,
    pinterestCopy,
    emailCopy: parsed.emailAnnouncement,
    blogDraft: parsed.blogDraft,
  };
}

function generateFallbackTags(brief: ProductBrief): string[] {
  const nicheLabel = brief.niche.replace(/-/g, ' ');
  return [
    `${nicheLabel} printable`,
    'digital download',
    'printable pdf',
    `${nicheLabel} planner`,
    'instant download',
    `${brief.targetAudience.split(' ').slice(0, 2).join(' ')} printable`,
    `${nicheLabel} template`,
    'print at home',
    `${brief.pageCount} page printable`,
    `${nicheLabel} tracker`,
    'printable planner',
    'digital planner',
    'organization printable',
  ];
}

// Template-based fallback functions
function generateFallbackTitle(brief: ProductBrief): string {
  const nicheLabel = brief.niche
    .split('-')
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const parts = [
    nicheLabel,
    'Printable',
    'Digital Download',
    `${brief.pageCount} Pages`,
    'PDF',
  ];

  let title = parts.join(' | ');

  if (title.length > MAX_ETSY_TITLE_LENGTH) {
    title = title.slice(0, MAX_ETSY_TITLE_LENGTH - 3) + '...';
  }

  return title;
}

function generateFallbackDescription(brief: ProductBrief): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return [
    `Printable ${nicheLabel} for ${brief.targetAudience}`,
    '',
    'WHAT YOU GET:',
    `- ${brief.pageCount}-page printable PDF`,
    '- Instant digital download',
    '- Print at home or at a print shop',
    '- US Letter & A4 compatible',
    '',
    'PERFECT FOR:',
    `- ${brief.targetAudience}`,
    `- Anyone looking for a ${nicheLabel} to stay organized`,
    '',
    'HOW TO USE:',
    '1. Purchase and download the PDF file',
    '2. Print at home or at your favorite print shop',
    '3. Start using right away!',
    '',
    'PrintPilot. All rights reserved.',
  ].join('\n');
}

function generateFallbackPinterestCopy(brief: ProductBrief): string[] {
  const nicheLabel = brief.niche.replace(/-/g, ' ');
  const nicheTag = brief.niche.replace(/-/g, '');

  return [
    `Get organized with this beautiful ${nicheLabel}! ${brief.pageCount} printable pages designed for ${brief.targetAudience}. Download instantly and start planning today! #printable #${nicheTag}`,
    `New ${nicheLabel} just dropped! Clean, minimal design with ${brief.pageCount} pages. Link in bio! #digitaldownload #planner`,
    `Stay on track with our ${nicheLabel}. Beautifully designed, instant download, print at home. ${brief.pageCount} pages of pure organization! #organization #printables`,
  ];
}

function generateFallbackEmailCopy(brief: ProductBrief): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');

  return [
    `Subject: New ${nicheLabel} just launched!`,
    '',
    'Hi there,',
    '',
    `We just released a brand new ${nicheLabel} printable!`,
    '',
    `This ${brief.pageCount}-page printable is perfect for ${brief.targetAudience}.`,
    '',
    'Check it out on our Etsy shop!',
    '',
    'Happy planning,',
    'The PrintPilot Team',
  ].join('\n');
}

function generateFallbackBlogDraft(brief: ProductBrief): string {
  const nicheLabel = brief.niche.replace(/-/g, ' ');
  const nicheTitle = nicheLabel.charAt(0).toUpperCase() + nicheLabel.slice(1);

  return [
    `# ${nicheTitle}: Your New Favorite Printable`,
    '',
    `Are you looking for a ${nicheLabel} that actually works? We designed this printable with ${brief.targetAudience} in mind.`,
    '',
    '## What Is Included',
    '',
    `This ${brief.pageCount}-page printable PDF includes everything you need to stay organized:`,
    '',
    ...brief.sections.slice(0, 5).map((section) => `- ${section}`),
    '',
    `## Why Choose This ${nicheTitle}?`,
    '',
    '- Clean, minimal design',
    '- Print at home or at a print shop',
    '- Compatible with US Letter and A4 paper',
    '- Instant digital download',
    '',
    '## Get It Now',
    '',
    'Available on our Etsy shop. Download instantly and start planning today!',
  ].join('\n');
}

function buildFallbackCopy(brief: ProductBrief): CopyResult {
  return {
    title: generateFallbackTitle(brief),
    description: generateFallbackDescription(brief),
    tags: generateFallbackTags(brief).slice(0, ETSY_TAG_COUNT),
    pinterestCopy: generateFallbackPinterestCopy(brief),
    emailCopy: generateFallbackEmailCopy(brief),
    blogDraft: generateFallbackBlogDraft(brief),
  };
}

async function generateCopyWithAI(brief: ProductBrief): Promise<CopyResult> {
  const prompt = buildCopyPrompt(brief);

  for (let attempt = 0; attempt <= MAX_COPY_RETRIES; attempt++) {
    const retryNote = attempt > 0
      ? ` (retry ${attempt}/${MAX_COPY_RETRIES})`
      : '';
    logger.info(`Generating AI copy for ${brief.id}${retryNote}`);

    const response = await callClaude(prompt, {
      systemPrompt: 'You are an expert Etsy SEO copywriter. Respond with valid JSON only, no markdown fences or additional text.',
      maxTokens: 4096,
      temperature: 0.7,
    });

    try {
      const parsed = parseAICopyResponse(response);
      const validated = validateAndFixCopy(parsed, brief);

      // Check critical constraints
      if (validated.tags.length !== ETSY_TAG_COUNT) {
        logger.warn(
          `Tag count ${validated.tags.length} !== ${ETSY_TAG_COUNT} after validation, retrying`,
        );
        if (attempt < MAX_COPY_RETRIES) continue;
      }

      return validated;
    } catch (parseError) {
      const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
      logger.warn(`Failed to parse AI copy response: ${parseMessage}`);
      if (attempt < MAX_COPY_RETRIES) continue;
      throw parseError;
    }
  }

  throw new Error('AI copy generation exhausted all retries');
}

export async function runCopywriting(productId: string): Promise<AgentResult<CopyResult>> {
  const startTime = performance.now();

  logger.info(`Copywriter agent starting for product: ${productId}`);

  try {
    const brief = await loadBrief(productId);

    let copyResult: CopyResult;
    let generationMethod: string;

    try {
      copyResult = await generateCopyWithAI(brief);
      generationMethod = 'ai';
      logger.info(`Using AI-generated copy for ${productId}`);
    } catch (aiError) {
      const aiMessage = aiError instanceof Error ? aiError.message : String(aiError);
      logger.warn(
        `AI copy generation failed for ${productId}, falling back to templates: ${aiMessage}`,
      );
      copyResult = buildFallbackCopy(brief);
      generationMethod = 'template';
    }

    // Write copy to product directory
    const copyPath = join(PRODUCTS_DIR, productId, 'copy.json');
    await writeFile(copyPath, JSON.stringify(copyResult, null, 2), 'utf-8');

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'copywriter',
      action: 'copywriting-complete',
      productId,
      details: `Title: "${copyResult.title}" | ${copyResult.tags.length} tags | method: ${generationMethod}`,
      duration,
      success: true,
    });

    logger.info(`Copywriting complete for ${productId}: "${copyResult.title}" (${generationMethod})`);

    return {
      success: true,
      data: copyResult,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Copywriter agent failed for ${productId}: ${message}`);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'copywriter',
      action: 'copywriting-failed',
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
