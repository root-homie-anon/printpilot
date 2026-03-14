import logger from '../utils/logger.js';
import type { PinterestTrend, PinterestPin } from './types.js';
import * as firecrawlClient from './firecrawl-client.js';

const PINTEREST_BASE_URL = 'https://www.pinterest.com';

function classifyTrendDirection(
  pinCount: number,
  relatedTermsCount: number,
): PinterestTrend['trendDirection'] {
  if (pinCount > 1000 && relatedTermsCount > 5) {
    return 'rising';
  }
  if (pinCount > 200) {
    return 'stable';
  }
  return 'declining';
}

function parseTrendFromMarkdown(
  markdown: string,
  keyword: string,
): { pinCount: number; relatedTerms: string[] } {
  // Count distinct pin-like entries in the markdown
  // Pinterest search results typically appear as image cards with titles
  const pinPatterns = [
    /!\[[^\]]*\]\([^)]+\)/g,           // markdown images
    /#{1,3}\s+[^\n]+/g,                // headings (pin titles)
    /\*\*[^*]+\*\*/g,                  // bold text (pin titles)
  ];

  let pinCount = 0;
  const countedTexts = new Set<string>();

  for (const pattern of pinPatterns) {
    const matches = markdown.matchAll(pattern);
    for (const match of matches) {
      const text = match[0].trim();
      if (!countedTexts.has(text) && text.length > 5) {
        countedTexts.add(text);
        pinCount++;
      }
    }
  }

  // Extract related terms from the markdown
  const relatedTerms: string[] = [];
  const relatedPatterns = [
    /(?:related|similar|see also|more like)[:\s]*([^\n]+)/gi,
    /(?:people also search(?:ed)? for|trending)[:\s]*([^\n]+)/gi,
  ];

  for (const pattern of relatedPatterns) {
    const matches = markdown.matchAll(pattern);
    for (const match of matches) {
      const terms = match[1].split(/[,|]/).map((t) => t.trim()).filter(Boolean);
      for (const term of terms) {
        if (term.length > 1 && !relatedTerms.includes(term)) {
          relatedTerms.push(term);
        }
      }
    }
  }

  // Also look for linked text as potential related terms
  const linkMatches = markdown.matchAll(/\[([^\]]+)\]\([^)]*pinterest\.com[^)]*\)/g);
  for (const match of linkMatches) {
    const term = match[1].trim();
    if (
      term.length > 1 &&
      term.length < 60 &&
      !relatedTerms.includes(term) &&
      term.toLowerCase() !== keyword.toLowerCase()
    ) {
      relatedTerms.push(term);
    }
  }

  return { pinCount, relatedTerms };
}

function parsePinsFromMarkdown(markdown: string): PinterestPin[] {
  const pins: PinterestPin[] = [];

  // Split into potential pin blocks
  const blocks = markdown.split(/(?=#{1,3}\s|\*\*[^*]+\*\*)/);

  for (const block of blocks) {
    if (block.trim().length < 10) {
      continue;
    }

    // Title
    const titleMatch = block.match(/#{1,3}\s*([^\n]+)/) ??
      block.match(/\*\*([^*]+)\*\*/);
    const title = titleMatch?.[1]?.trim() ?? '';

    // Description — text following the title
    const descMatch = block.match(/(?:#{1,3}\s*[^\n]+|\*\*[^*]+\*\*)\s*\n+([\s\S]*?)(?=#{1,3}\s|\*\*|$)/);
    const description = descMatch?.[1]?.trim().slice(0, 500) ?? '';

    // Image URL
    const imgMatch = block.match(/!\[[^\]]*\]\(([^)]+)\)/);
    const imageUrl = imgMatch?.[1] ?? '';

    // Link
    const linkMatch = block.match(/\[(?:.*?)\]\((https?:\/\/[^)]+)\)/) ??
      block.match(/(https?:\/\/(?:www\.)?pinterest\.com\/pin\/[^\s)]+)/);
    const link = linkMatch?.[1] ?? '';

    // Saves count
    const savesMatch = block.match(/([\d,]+)\s*(?:saves?|repins?|pins?)/i);
    const saves = savesMatch ? parseInt(savesMatch[1].replace(/,/g, ''), 10) || 0 : 0;

    if (title || imageUrl) {
      pins.push({ title, description, saves, imageUrl, link });
    }
  }

  return pins;
}

export async function scrapePinterestTrends(
  keywords: string[],
): Promise<PinterestTrend[]> {
  logger.info(`Scraping Pinterest trends for ${keywords.length} keywords`);

  if (!firecrawlClient.isAvailable()) {
    logger.warn('FIRECRAWL_API_KEY not set — Pinterest trends scraping disabled, returning empty results');
    return [];
  }

  const trends: PinterestTrend[] = [];

  for (const keyword of keywords) {
    logger.debug(`Scraping Pinterest trends for: "${keyword}"`);

    try {
      const searchQuery = encodeURIComponent(`${keyword} printable`);
      const url = `${PINTEREST_BASE_URL}/search/pins/?q=${searchQuery}`;

      const markdown = await firecrawlClient.scrapeUrl(url);

      if (!markdown) {
        logger.warn(`No content returned for Pinterest trend: "${keyword}"`);
        continue;
      }

      const { pinCount, relatedTerms } = parseTrendFromMarkdown(markdown, keyword);
      const trendDirection = classifyTrendDirection(pinCount, relatedTerms.length);

      trends.push({
        keyword,
        relatedTerms: relatedTerms.slice(0, 10),
        pinCount,
        trendDirection,
      });

      logger.info(
        `Pinterest trend for "${keyword}": ${pinCount} pins, direction=${trendDirection}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to scrape Pinterest trend for "${keyword}": ${message}`);
    }
  }

  logger.info(`Pinterest trends scrape complete: ${trends.length} trends collected`);
  return trends;
}

export async function scrapePinterestSearch(
  query: string,
): Promise<PinterestPin[]> {
  logger.info(`Scraping Pinterest search for: "${query}"`);

  if (!firecrawlClient.isAvailable()) {
    logger.warn('FIRECRAWL_API_KEY not set — Pinterest search disabled, returning empty results');
    return [];
  }

  try {
    const searchQuery = encodeURIComponent(query);
    const url = `${PINTEREST_BASE_URL}/search/pins/?q=${searchQuery}`;

    const markdown = await firecrawlClient.scrapeUrl(url);

    if (!markdown) {
      logger.warn(`No content returned for Pinterest search: "${query}"`);
      return [];
    }

    const pins = parsePinsFromMarkdown(markdown);

    logger.info(`Pinterest search complete: ${pins.length} pins for "${query}"`);
    return pins;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to scrape Pinterest search for "${query}": ${message}`);
    return [];
  }
}
