import logger from '../utils/logger.js';

interface FirecrawlScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    content?: string;
    metadata?: Record<string, string>;
    links?: string[];
  };
  error?: string;
}

interface FirecrawlApp {
  scrapeUrl(
    url: string,
    options: { formats: string[] },
  ): Promise<FirecrawlScrapeResult>;
}

let appInstance: FirecrawlApp | null = null;
let initAttempted = false;

function getApiKey(): string | undefined {
  return process.env.FIRECRAWL_API_KEY;
}

async function getApp(): Promise<FirecrawlApp | null> {
  if (appInstance) {
    return appInstance;
  }

  if (initAttempted) {
    return null;
  }

  initAttempted = true;

  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('FIRECRAWL_API_KEY not set — Firecrawl scraping disabled');
    return null;
  }

  try {
    const FirecrawlAppModule = await import('@mendable/firecrawl-js');
    const FirecrawlClass = FirecrawlAppModule.default ?? FirecrawlAppModule;
    appInstance = new FirecrawlClass({ apiKey }) as unknown as FirecrawlApp;
    return appInstance;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to initialize Firecrawl: ${message}`);
    return null;
  }
}

export async function scrapeUrl(url: string): Promise<string | null> {
  const app = await getApp();

  if (!app) {
    return null;
  }

  try {
    logger.debug(`Firecrawl scraping: ${url}`);
    const result = await app.scrapeUrl(url, { formats: ['markdown'] });

    if (!result.success || !result.data) {
      logger.warn(`Firecrawl scrape failed for ${url}: ${result.error ?? 'unknown error'}`);
      return null;
    }

    return result.data.markdown ?? result.data.content ?? null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Firecrawl scrape error for ${url}: ${message}`);
    return null;
  }
}

export async function scrapeUrlWithMetadata(
  url: string,
): Promise<{ markdown: string; metadata: Record<string, string>; links: string[] } | null> {
  const app = await getApp();

  if (!app) {
    return null;
  }

  try {
    logger.debug(`Firecrawl scraping with metadata: ${url}`);
    const result = await app.scrapeUrl(url, { formats: ['markdown'] });

    if (!result.success || !result.data) {
      logger.warn(`Firecrawl scrape failed for ${url}: ${result.error ?? 'unknown error'}`);
      return null;
    }

    return {
      markdown: result.data.markdown ?? result.data.content ?? '',
      metadata: result.data.metadata ?? {},
      links: result.data.links ?? [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Firecrawl scrape error for ${url}: ${message}`);
    return null;
  }
}

export function isAvailable(): boolean {
  return Boolean(getApiKey());
}
