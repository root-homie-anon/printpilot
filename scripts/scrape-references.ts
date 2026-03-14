import FirecrawlApp from '@mendable/firecrawl-js';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListingMetadata {
  title: string;
  price: number;
  reviews: number;
  imageUrl: string;
  localImage: string;
  sourceUrl: string;
}

interface CategoryMetadata {
  category: string;
  scrapedAt: string;
  listings: ListingMetadata[];
}

interface ExtractedListing {
  title: string;
  price: number;
  reviews: number;
  imageUrl: string;
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: string[] = [
  'planner',
  'budget tracker',
  'habit tracker',
  'gratitude journal',
  'meal planner',
  'fitness tracker',
  'reading log',
  'goal setting worksheet',
];

const MAX_IMAGES_PER_CATEGORY = 5;
const MAX_IMAGE_WIDTH = 800;
const RATE_LIMIT_MS = 2500;
const REFERENCE_LIBRARY_ROOT = path.resolve('src/renderer/reference-library');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(category: string): string {
  return category.toLowerCase().replace(/\s+/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEtsySearchUrl(category: string): string {
  const query = encodeURIComponent(`${category} printable digital download`);
  return `https://www.etsy.com/search?q=${query}&order=most_relevant`;
}

/**
 * Parse scraped markdown/HTML content to extract listing data.
 * Firecrawl returns markdown; we look for patterns that match
 * Etsy listing cards: image URLs, titles, prices, review counts.
 */
function extractListings(markdown: string): ExtractedListing[] {
  const listings: ExtractedListing[] = [];

  // Extract image URLs (Etsy uses i.etsystatic.com)
  const imageMatches = markdown.match(
    /https:\/\/i\.etsystatic\.com\/[^\s)"\]]+/g
  );

  // Extract listing URLs
  const listingUrlMatches = markdown.match(
    /https:\/\/www\.etsy\.com\/listing\/\d+\/[^\s)"\]?]+/g
  );

  // Extract prices — patterns like $4.99, US$4.99, USD 4.99
  const priceMatches = markdown.match(
    /(?:US?\$|USD\s*)(\d+\.\d{2})/g
  );

  // Extract review counts — patterns like (1,234 reviews), (1234), "1,234 reviews"
  const reviewMatches = markdown.match(
    /\(?([\d,]+)\s*reviews?\)?/gi
  );

  // Extract potential titles — lines that look like listing titles
  const titleMatches = markdown.match(
    /\[([^\]]{15,120})\]/g
  );

  const uniqueImages = [...new Set(imageMatches ?? [])];
  const uniqueUrls = [...new Set(listingUrlMatches ?? [])];

  const count = Math.min(
    MAX_IMAGES_PER_CATEGORY,
    uniqueImages.length,
  );

  for (let i = 0; i < count; i++) {
    const rawPrice = priceMatches?.[i]
      ? priceMatches[i].replace(/[^0-9.]/g, '')
      : '0';
    const rawReviews = reviewMatches?.[i]
      ? reviewMatches[i].replace(/[^0-9]/g, '')
      : '0';
    const rawTitle = titleMatches?.[i]
      ? titleMatches[i].replace(/^\[|\]$/g, '')
      : `Listing ${i + 1}`;

    listings.push({
      title: rawTitle,
      price: parseFloat(rawPrice) || 0,
      reviews: parseInt(rawReviews, 10) || 0,
      imageUrl: uniqueImages[i],
      sourceUrl: uniqueUrls[i] ?? '',
    });
  }

  return listings;
}

/**
 * Download an image, resize with sharp, and save to disk.
 */
async function downloadAndOptimizeImage(
  imageUrl: string,
  outputPath: string
): Promise<boolean> {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok || !response.body) {
      console.warn(`  Failed to download image: ${response.status} ${imageUrl}`);
      return false;
    }

    // Download to a temp buffer first, then resize with sharp
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const optimized = await sharp(buffer)
      .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    await writeFile(outputPath, optimized);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Error downloading/optimizing image: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env['FIRECRAWL_API_KEY'];

  if (!apiKey) {
    console.log('FIRECRAWL_API_KEY not set — skipping reference scraping');
    process.exit(0);
  }

  const firecrawl = new FirecrawlApp({ apiKey });

  console.log('PrintPilot Reference Library Scraper');
  console.log('====================================');
  console.log(`Categories to scrape: ${CATEGORIES.length}`);
  console.log(`Max images per category: ${MAX_IMAGES_PER_CATEGORY}`);
  console.log(`Output: ${REFERENCE_LIBRARY_ROOT}`);
  console.log();

  for (let i = 0; i < CATEGORIES.length; i++) {
    const category = CATEGORIES[i];
    const slug = slugify(category);
    const categoryDir = path.join(REFERENCE_LIBRARY_ROOT, slug);

    console.log(`[${i + 1}/${CATEGORIES.length}] Scraping: ${category}`);

    // Ensure output directory exists
    await mkdir(categoryDir, { recursive: true });

    try {
      const url = buildEtsySearchUrl(category);
      console.log(`  URL: ${url}`);

      // Scrape the page using Firecrawl
      const scrapeResult = await firecrawl.scrapeUrl(url, {
        formats: ['markdown'],
      });

      if (!scrapeResult.success) {
        console.warn(`  Scrape failed for ${category}: ${scrapeResult.error ?? 'unknown error'}`);
        continue;
      }

      const markdown = scrapeResult.markdown ?? '';

      if (!markdown) {
        console.warn(`  No content returned for ${category}`);
        continue;
      }

      // Extract listing data from the scraped content
      const listings = extractListings(markdown);
      console.log(`  Found ${listings.length} listings`);

      if (listings.length === 0) {
        console.warn(`  No listings extracted for ${category}`);
        continue;
      }

      // Download and optimize reference images
      const metadataListings: ListingMetadata[] = [];

      for (let j = 0; j < listings.length; j++) {
        const listing = listings[j];
        const imageFilename = `ref-${String(j + 1).padStart(3, '0')}.jpg`;
        const imagePath = path.join(categoryDir, imageFilename);

        console.log(`  Downloading image ${j + 1}/${listings.length}: ${listing.title.slice(0, 50)}...`);

        const downloaded = await downloadAndOptimizeImage(
          listing.imageUrl,
          imagePath
        );

        metadataListings.push({
          title: listing.title,
          price: listing.price,
          reviews: listing.reviews,
          imageUrl: listing.imageUrl,
          localImage: downloaded ? imageFilename : '',
          sourceUrl: listing.sourceUrl,
        });
      }

      // Write metadata JSON
      const metadata: CategoryMetadata = {
        category: slug,
        scrapedAt: new Date().toISOString(),
        listings: metadataListings,
      };

      const metadataPath = path.join(categoryDir, 'metadata.json');
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
      console.log(`  Saved metadata to ${metadataPath}`);
      console.log(
        `  Done: ${metadataListings.filter((l) => l.localImage).length} images saved`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Error processing ${category}: ${message}`);
    }

    // Rate limit between categories (skip delay on last one)
    if (i < CATEGORIES.length - 1) {
      console.log(`  Waiting ${RATE_LIMIT_MS}ms before next category...`);
      await sleep(RATE_LIMIT_MS);
    }

    console.log();
  }

  console.log('Reference scraping complete.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
