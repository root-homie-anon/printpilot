import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AgentResult, ProductBrief } from '../types/index.js';
import logger from '../utils/logger.js';
import { logActivity } from '../tracker/activity-log.js';

const STATE_DIR = resolve(process.cwd(), 'state');
const PRODUCTS_DIR = join(STATE_DIR, 'products');

const MAX_ETSY_TITLE_LENGTH = 140;
const ETSY_TAG_COUNT = 13;

export interface CopyResult {
  title: string;
  description: string;
  tags: string[];
  pinterestCopy: string[];
  emailCopy: string;
  blogDraft: string;
}

async function loadBrief(productId: string): Promise<ProductBrief> {
  const briefPath = join(PRODUCTS_DIR, productId, 'brief.json');
  const content = await readFile(briefPath, 'utf-8');
  return JSON.parse(content) as ProductBrief;
}

function generateEtsyTitle(brief: ProductBrief): string {
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

function generateEtsyDescription(brief: ProductBrief): string {
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

function generateTags(brief: ProductBrief): string[] {
  const baseTags = brief.sections.slice(0, 5);
  const supplemental = [
    'printable',
    'digital download',
    'pdf',
    brief.niche.replace(/-/g, ' '),
    `${brief.pageCount} pages`,
    brief.targetAudience.split(' ').slice(0, 2).join(' '),
    brief.styleGuide.layout,
    'planner',
  ];

  const allTags = [...new Set([...baseTags, ...supplemental])];
  return allTags.slice(0, ETSY_TAG_COUNT);
}

function generatePinterestCopy(brief: ProductBrief): string[] {
  const nicheLabel = brief.niche.replace(/-/g, ' ');
  const nicheTag = brief.niche.replace(/-/g, '');

  return [
    `Get organized with this beautiful ${nicheLabel}! ${brief.pageCount} printable pages designed for ${brief.targetAudience}. Download instantly and start planning today! #printable #${nicheTag}`,
    `New ${nicheLabel} just dropped! Clean, minimal design with ${brief.pageCount} pages. Link in bio! #digitaldownload #planner`,
    `Stay on track with our ${nicheLabel}. Beautifully designed, instant download, print at home. ${brief.pageCount} pages of pure organization! #organization #printables`,
  ];
}

function generateEmailCopy(brief: ProductBrief): string {
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

function generateBlogDraft(brief: ProductBrief): string {
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

export async function runCopywriting(productId: string): Promise<AgentResult<CopyResult>> {
  const startTime = performance.now();

  logger.info(`Copywriter agent starting for product: ${productId}`);

  try {
    const brief = await loadBrief(productId);

    const title = generateEtsyTitle(brief);
    const description = generateEtsyDescription(brief);
    const tags = generateTags(brief);
    const pinterestCopy = generatePinterestCopy(brief);
    const emailCopy = generateEmailCopy(brief);
    const blogDraft = generateBlogDraft(brief);

    const copyResult: CopyResult = {
      title,
      description,
      tags,
      pinterestCopy,
      emailCopy,
      blogDraft,
    };

    // Write copy to product directory
    const copyPath = join(PRODUCTS_DIR, productId, 'copy.json');
    await writeFile(copyPath, JSON.stringify(copyResult, null, 2), 'utf-8');

    const duration = Math.round(performance.now() - startTime);

    await logActivity({
      timestamp: new Date().toISOString(),
      agent: 'copywriter',
      action: 'copywriting-complete',
      productId,
      details: `Title: "${title}" | ${tags.length} tags`,
      duration,
      success: true,
    });

    logger.info(`Copywriting complete for ${productId}: "${title}"`);

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
