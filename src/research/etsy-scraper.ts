import logger from '../utils/logger.js';
import type { EtsyScrapedData, EtsySearchResult, ListingDetail } from './types.js';
import * as firecrawlClient from './firecrawl-client.js';

const ETSY_BASE_URL = 'https://www.etsy.com';
const MAX_PAGES = 3;

function parsePrice(text: string): number {
  const match = text.match(/\$?([\d,]+\.?\d*)/);
  if (!match) {
    return 0;
  }
  const parsed = parseFloat(match[1].replace(/,/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseCount(text: string): number {
  const match = text.match(/([\d,]+)/);
  if (!match) {
    return 0;
  }
  const parsed = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseListingsFromMarkdown(markdown: string, category: string): EtsyScrapedData[] {
  const results: EtsyScrapedData[] = [];

  // Split markdown into listing blocks using common Etsy listing patterns
  const listingBlocks = markdown.split(/(?=#{1,3}\s|\*\*[^*]+\*\*.*\$)/);

  for (const block of listingBlocks) {
    if (block.trim().length < 20) {
      continue;
    }

    // Extract title — typically first heading or bold text
    const titleMatch = block.match(/#{1,3}\s*\[?([^\]\n]+)\]?/) ??
      block.match(/\*\*([^*]+)\*\*/);
    const title = titleMatch?.[1]?.trim() ?? '';

    if (!title) {
      continue;
    }

    // Extract price
    const priceMatch = block.match(/\$\s*([\d,]+\.?\d*)/);
    const price = priceMatch ? parsePrice(priceMatch[0]) : 0;

    // Extract review count
    const reviewMatch = block.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i);
    const reviews = reviewMatch ? parseCount(reviewMatch[1]) : 0;

    // Extract favorites
    const favMatch = block.match(/(\d[\d,]*)\s*(?:favorites?|favou?rites?)/i);
    const favorites = favMatch ? parseCount(favMatch[1]) : 0;

    // Extract shop name
    const shopMatch = block.match(/(?:by|from|shop[:\s]+)\s*\[?([A-Za-z][\w]*(?:\s+\w+){0,3})\]?/i);
    const shopName = shopMatch?.[1]?.trim() ?? '';

    // Extract URL
    const urlMatch = block.match(/https?:\/\/www\.etsy\.com\/listing\/\d+[^\s)>]*/);
    const url = urlMatch?.[0] ?? '';

    if (title && (price > 0 || url)) {
      results.push({
        title,
        price,
        reviews,
        favorites,
        shopName,
        url,
        tags: [],
        category,
        estimatedAge: '',
      });
    }
  }

  return results;
}

function parseSearchResultsFromMarkdown(markdown: string): EtsySearchResult[] {
  const results: EtsySearchResult[] = [];

  const listingBlocks = markdown.split(/(?=#{1,3}\s|\*\*[^*]+\*\*.*\$)/);

  for (const block of listingBlocks) {
    if (block.trim().length < 20) {
      continue;
    }

    const titleMatch = block.match(/#{1,3}\s*\[?([^\]\n]+)\]?/) ??
      block.match(/\*\*([^*]+)\*\*/);
    const title = titleMatch?.[1]?.trim() ?? '';

    if (!title) {
      continue;
    }

    const priceMatch = block.match(/\$\s*([\d,]+\.?\d*)/);
    const price = priceMatch ? parsePrice(priceMatch[0]) : 0;

    const reviewMatch = block.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i);
    const reviews = reviewMatch ? parseCount(reviewMatch[1]) : 0;

    const favMatch = block.match(/(\d[\d,]*)\s*(?:favorites?|favou?rites?)/i);
    const favorites = favMatch ? parseCount(favMatch[1]) : 0;

    const shopMatch = block.match(/(?:by|from|shop[:\s]+)\s*\[?([A-Za-z][\w]*(?:\s+\w+){0,3})\]?/i);
    const shopName = shopMatch?.[1]?.trim() ?? '';

    const urlMatch = block.match(/https?:\/\/www\.etsy\.com\/listing\/\d+[^\s)>]*/);
    const url = urlMatch?.[0] ?? '';

    if (title && (price > 0 || url)) {
      results.push({
        title,
        price,
        reviews,
        favorites,
        shopName,
        url,
        tags: [],
        listingAge: '',
      });
    }
  }

  return results;
}

function parseListingDetailFromMarkdown(markdown: string, url: string): ListingDetail {
  // Title
  const titleMatch = markdown.match(/#{1,2}\s*([^\n]+)/) ??
    markdown.match(/\*\*([^*]+)\*\*/);
  const title = titleMatch?.[1]?.trim() ?? '';

  // Description — text after title, before next section
  const descMatch = markdown.match(/#{1,2}\s*[^\n]+\n+([\s\S]*?)(?=#{1,2}\s|$)/);
  const description = descMatch?.[1]?.trim().slice(0, 2000) ?? '';

  // Price
  const priceMatch = markdown.match(/\$\s*([\d,]+\.?\d*)/);
  const price = priceMatch ? parsePrice(priceMatch[0]) : 0;

  // Reviews
  const reviewMatch = markdown.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i);
  const reviews = reviewMatch ? parseCount(reviewMatch[1]) : 0;

  // Favorites
  const favMatch = markdown.match(/(\d[\d,]*)\s*(?:favorites?|favou?rites?)/i);
  const favorites = favMatch ? parseCount(favMatch[1]) : 0;

  // Shop name
  const shopMatch = markdown.match(/(?:by|from|shop[:\s]+)\s*\[?([A-Za-z][\w]*(?:\s+\w+){0,3})\]?/i);
  const shopName = shopMatch?.[1]?.trim() ?? '';

  // Shop sales
  const salesMatch = markdown.match(/([\d,]+)\s*sales/i);
  const shopSales = salesMatch ? parseCount(salesMatch[1]) : 0;

  // Tags
  const tags: string[] = [];
  const tagMatches = markdown.matchAll(/(?:tags?|keywords?)[:\s]*([^\n]+)/gi);
  for (const match of tagMatches) {
    const tagLine = match[1];
    const individualTags = tagLine.split(/[,|]/).map((t) => t.trim()).filter(Boolean);
    tags.push(...individualTags);
  }

  // Images
  const images: string[] = [];
  const imgMatches = markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of imgMatches) {
    images.push(match[1]);
  }

  // Created date
  const dateMatch = markdown.match(/(?:listed|created|posted)\s*(?:on)?\s*(\w+\s+\d{1,2},?\s*\d{4})/i);
  const createdAt = dateMatch?.[1] ?? '';

  return {
    title,
    description,
    price,
    reviews,
    favorites,
    shopName,
    shopSales,
    tags: tags.slice(0, 20),
    images: images.slice(0, 10),
    url,
    createdAt,
  };
}

export async function scrapeEtsyTrending(
  categories: string[],
): Promise<EtsyScrapedData[]> {
  logger.info(`Scraping Etsy trending for ${categories.length} categories`);

  const allResults: EtsyScrapedData[] = [];

  for (const category of categories) {
    logger.debug(`Scraping Etsy category: ${category}`);

    try {
      const categoryResults = await scrapeCategoryData(category);
      allResults.push(...categoryResults);
      logger.info(
        `Found ${categoryResults.length} results for category: ${category}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to scrape category "${category}": ${message}`);
    }
  }

  logger.info(`Etsy trending scrape complete: ${allResults.length} total results`);
  return allResults;
}

async function scrapeCategoryData(category: string): Promise<EtsyScrapedData[]> {
  const results: EtsyScrapedData[] = [];
  const query = `${category} printable digital download`;

  // Firecrawl web scraping
  if (firecrawlClient.isAvailable()) {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const encodedQuery = encodeURIComponent(query);
      const url = `${ETSY_BASE_URL}/search?q=${encodedQuery}&ref=pagination&page=${pageNum}`;

      const markdown = await firecrawlClient.scrapeUrl(url);
      if (!markdown) {
        logger.debug(`No Firecrawl content on page ${pageNum} for "${category}"`);
        break;
      }

      const pageResults = parseListingsFromMarkdown(markdown, category);
      if (pageResults.length === 0) {
        logger.debug(`No more results on page ${pageNum} for "${category}"`);
        break;
      }

      results.push(...pageResults);
    }
  }

  if (results.length === 0) {
    logger.warn(
      `No data sources available for Etsy category "${category}" — Firecrawl returned empty results`,
    );
  }

  return results;
}

export async function scrapeEtsySearch(
  query: string,
): Promise<EtsySearchResult[]> {
  logger.info(`Scraping Etsy search for: "${query}"`);

  const allResults: EtsySearchResult[] = [];

  // Firecrawl web scraping
  if (firecrawlClient.isAvailable()) {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const encodedQuery = encodeURIComponent(query);
      const url = `${ETSY_BASE_URL}/search?q=${encodedQuery}&ref=pagination&page=${pageNum}`;

      const markdown = await firecrawlClient.scrapeUrl(url);
      if (!markdown) {
        break;
      }

      const pageResults = parseSearchResultsFromMarkdown(markdown);
      if (pageResults.length === 0) {
        break;
      }

      allResults.push(...pageResults);
    }
  }

  if (allResults.length === 0) {
    logger.warn(`No data sources returned results for Etsy search: "${query}"`);
  }

  logger.info(`Etsy search complete: ${allResults.length} results for "${query}"`);
  return allResults;
}

export async function scrapeListingDetails(
  url: string,
): Promise<ListingDetail> {
  logger.info(`Scraping listing details: ${url}`);

  // Use Firecrawl to get the listing page
  if (firecrawlClient.isAvailable()) {
    const markdown = await firecrawlClient.scrapeUrl(url);

    if (markdown) {
      const detail = parseListingDetailFromMarkdown(markdown, url);
      if (detail.title) {
        logger.info(`Listing details scraped successfully: "${detail.title}"`);
        return detail;
      }
    }
  }

  logger.warn(`Could not scrape listing details for ${url} — Firecrawl unavailable or returned empty`);

  // Return empty detail structure as graceful degradation
  return {
    title: '',
    description: '',
    price: 0,
    reviews: 0,
    favorites: 0,
    shopName: '',
    shopSales: 0,
    tags: [],
    images: [],
    url,
    createdAt: '',
  };
}
