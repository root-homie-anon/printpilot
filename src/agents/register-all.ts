import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerAgent } from './runner.js';
import { runResearch } from './researcher.js';
import { runStrategy } from './strategist.js';
import { runEnhancedStrategy } from './strategist-enhanced.js';
import { runDesign } from './designer.js';
import { runCopywriting } from './copywriter.js';
import { runScoring } from './scorer.js';
import { runComparison } from './reference-comparator.js';
import { PinterestClient } from '../marketing/pinterest.js';
import { EmailClient } from '../marketing/email.js';
import { BlogClient } from '../marketing/blog.js';
import { EtsyClient } from '../etsy/client.js';
import logger from '../utils/logger.js';
import type { ProductBrief, ListingData } from '../types/index.js';
import type { EmailProvider } from '../marketing/email.js';
import type { BlogPlatform } from '../marketing/blog.js';

// ── Input interfaces ─────────────────────────────────────────────

interface DesignerInput {
  brief: ProductBrief;
}

interface CopywriterInput {
  productId: string;
}

interface ScorerInput {
  productId?: string;
  brief?: { id: string };
}

interface HealthCheckerInput {
  listingId: string;
  etsyUrl: string;
}

interface ListingAgentInput {
  productId: string;
  copy: {
    title: string;
    description: string;
    tags: string[];
  };
  pdfPath: string;
}

interface PinterestAgentInput {
  productId: string;
  listing: ListingData;
  pinsPerProduct: number;
}

interface EmailAgentInput {
  productId: string;
  listing: ListingData;
}

interface BlogAgentInput {
  productId: string;
  listing: ListingData;
}

// ── Result interfaces ────────────────────────────────────────────

interface HealthCheckResult {
  isLive: boolean;
}

interface ListingAgentResult {
  listingId: string;
  etsyUrl: string;
  status: string;
  publishedAt: string;
  price: number;
  title: string;
  description: string;
  tags: string[];
}

interface PinterestAgentResult {
  pinCount: number;
}

interface EmailAgentResult {
  sent: boolean;
}

interface BlogAgentResult {
  postUrl: string;
}

// ── Registration ─────────────────────────────────────────────────

export function registerAllAgents(): void {
  // ── researcher ───────────────────────────────────────────────
  registerAgent('researcher', async (_input: unknown) => {
    const result = await runResearch();
    return result.data ?? [];
  });

  // ── strategist (basic) ───────────────────────────────────────
  registerAgent('strategist', async (_input: unknown) => {
    const result = await runStrategy();
    return result.data ?? [];
  });

  // ── strategist-enhanced (with competitive intel) ────────────
  registerAgent('strategist-enhanced', async (_input: unknown) => {
    const result = await runEnhancedStrategy();
    return result.data ?? [];
  });

  // ── reference-comparator (quality gate) ─────────────────────
  registerAgent('reference-comparator', async (input: unknown) => {
    const { productId } = input as { productId: string };
    const result = await runComparison(productId);
    if (!result.success || !result.data) {
      throw new Error(result.error ?? 'Reference comparator returned no data');
    }
    return result.data;
  });

  // ── designer ─────────────────────────────────────────────────
  registerAgent('designer', async (input: unknown) => {
    const { brief } = input as DesignerInput;
    const result = await runDesign(brief);
    return result.data;
  });

  // ── copywriter ───────────────────────────────────────────────
  registerAgent('copywriter', async (input: unknown) => {
    const { productId } = input as CopywriterInput;
    const result = await runCopywriting(productId);
    return result.data;
  });

  // ── scorer ───────────────────────────────────────────────────
  registerAgent('scorer', async (input: unknown) => {
    const typed = input as ScorerInput;
    const productId = typed.productId ?? typed.brief?.id;
    if (!productId) {
      throw new Error('Scorer requires productId or brief.id');
    }
    const result = await runScoring(productId);
    return result.data;
  });

  // ── listing-health-checker ───────────────────────────────────
  registerAgent<HealthCheckResult>('listing-health-checker', async (input: unknown) => {
    const { etsyUrl } = input as HealthCheckerInput;

    try {
      const response = await fetch(etsyUrl, { method: 'HEAD' });
      return { isLive: response.status === 200 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Listing health check failed for ${etsyUrl}: ${message}`);
      return { isLive: false };
    }
  });

  // ── listing-agent ────────────────────────────────────────────
  registerAgent<ListingAgentResult>('listing-agent', async (input: unknown) => {
    const { productId, copy, pdfPath } = input as ListingAgentInput;

    const etsyApiKey = process.env.ETSY_API_KEY;
    const etsyApiSecret = process.env.ETSY_API_SECRET;
    const etsyShopId = process.env.ETSY_SHOP_ID;

    if (!etsyApiKey || !etsyApiSecret || !etsyShopId) {
      logger.warn(
        'Missing Etsy API credentials (ETSY_API_KEY, ETSY_API_SECRET, or ETSY_SHOP_ID). ' +
        'Returning stub listing result.'
      );
      return {
        listingId: 'TBD',
        etsyUrl: 'TBD',
        status: 'pending-keys',
        publishedAt: new Date().toISOString(),
        price: 0,
        title: copy.title,
        description: copy.description,
        tags: copy.tags,
      };
    }

    const client = new EtsyClient(etsyApiKey, etsyApiSecret, etsyShopId);

    const draft = await client.createDraftListing({
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      price: 4.99,
      categoryId: 69,
      taxonomyId: 69,
      whoMade: 'i_did',
      whenMade: 'made_to_order',
      isDigital: true,
    });

    await client.uploadDigitalFile(draft.listingId, pdfPath);

    const published = await client.publishListing(draft.listingId);

    logger.info(`Listing published for product ${productId}: ${published.url}`);

    return {
      listingId: String(published.listingId),
      etsyUrl: published.url,
      status: 'active',
      publishedAt: new Date().toISOString(),
      price: published.price,
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
    };
  });

  // ── marketing-pinterest ──────────────────────────────────────
  registerAgent<PinterestAgentResult>('marketing-pinterest', async (input: unknown) => {
    const { productId, listing, pinsPerProduct } = input as PinterestAgentInput;

    const accessToken = process.env.PINTEREST_ACCESS_TOKEN;
    if (!accessToken) {
      logger.warn(
        'Missing PINTEREST_ACCESS_TOKEN. Returning stub Pinterest result.'
      );
      return { pinCount: 0 };
    }

    const client = new PinterestClient(accessToken);

    const productDir = resolve(process.cwd(), 'state', 'products', productId);
    let pinterestCopy: string[] = [];
    try {
      const copyRaw = await readFile(resolve(productDir, 'copy.json'), 'utf-8');
      const copyData = JSON.parse(copyRaw) as { pinterestCopy?: string[] };
      pinterestCopy = copyData.pinterestCopy ?? [];
    } catch {
      logger.warn(`Could not load copy.json for product ${productId}`);
    }

    let pinCount = 0;
    const count = Math.min(pinsPerProduct, Math.max(pinterestCopy.length, 1));

    for (let i = 0; i < count; i++) {
      try {
        const description = pinterestCopy[i] ?? `Check out ${listing.title} on Etsy!`;
        await client.createPin({
          title: listing.title,
          description,
          link: listing.etsyUrl,
          boardId: 'default',
          mediaSource: { sourceType: 'image_url', url: listing.etsyUrl },
        });
        pinCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to create Pinterest pin ${i + 1} for ${productId}: ${message}`);
      }
    }

    logger.info(`Created ${pinCount} Pinterest pins for product ${productId}`);
    return { pinCount };
  });

  // ── marketing-email ──────────────────────────────────────────
  registerAgent<EmailAgentResult>('marketing-email', async (input: unknown) => {
    const { productId, listing } = input as EmailAgentInput;

    const emailProvider = process.env.EMAIL_PROVIDER;
    const emailApiKey = process.env.EMAIL_API_KEY;

    if (!emailProvider || !emailApiKey) {
      logger.warn(
        'Missing EMAIL_PROVIDER or EMAIL_API_KEY. Returning stub email result.'
      );
      return { sent: false };
    }

    const client = new EmailClient(emailProvider as EmailProvider, emailApiKey);

    const productDir = resolve(process.cwd(), 'state', 'products', productId);
    let emailCopy = `New product available: ${listing.title}. Check it out on Etsy!`;
    try {
      const copyRaw = await readFile(resolve(productDir, 'copy.json'), 'utf-8');
      const copyData = JSON.parse(copyRaw) as { emailCopy?: string };
      emailCopy = copyData.emailCopy ?? emailCopy;
    } catch {
      logger.warn(`Could not load copy.json for product ${productId}`);
    }

    const listId = process.env.EMAIL_LIST_ID ?? 'default';

    await client.sendCampaign({
      subject: `New: ${listing.title}`,
      htmlBody: `<p>${emailCopy}</p><p><a href="${listing.etsyUrl}">View on Etsy</a></p>`,
      textBody: `${emailCopy}\n\nView on Etsy: ${listing.etsyUrl}`,
      listId,
      tags: ['new-product', 'printable'],
    });

    logger.info(`Email campaign sent for product ${productId}`);
    return { sent: true };
  });

  // ── marketing-blog ───────────────────────────────────────────
  registerAgent<BlogAgentResult>('marketing-blog', async (input: unknown) => {
    const { productId, listing } = input as BlogAgentInput;

    const blogApiUrl = process.env.BLOG_API_URL;
    const blogApiKey = process.env.BLOG_API_KEY;

    if (!blogApiUrl || !blogApiKey) {
      logger.warn(
        'Missing BLOG_API_URL or BLOG_API_KEY. Returning stub blog result.'
      );
      return { postUrl: 'TBD' };
    }

    const platform: BlogPlatform = blogApiUrl.includes('ghost') ? 'ghost' : 'wordpress';
    const client = new BlogClient(platform, blogApiUrl, blogApiKey);

    const productDir = resolve(process.cwd(), 'state', 'products', productId);
    let blogDraft = `Check out our new printable: ${listing.title}.`;
    try {
      const copyRaw = await readFile(resolve(productDir, 'copy.json'), 'utf-8');
      const copyData = JSON.parse(copyRaw) as { blogDraft?: string };
      blogDraft = copyData.blogDraft ?? blogDraft;
    } catch {
      logger.warn(`Could not load copy.json for product ${productId}`);
    }

    const slug = listing.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const post = await client.publishPost({
      title: listing.title,
      content: blogDraft,
      excerpt: `New printable: ${listing.title}`,
      tags: listing.tags.slice(0, 5),
      featuredImageUrl: listing.etsyUrl,
      slug,
    });

    logger.info(`Blog post published for product ${productId}: ${post.url}`);
    return { postUrl: post.url };
  });

  logger.info('All agents registered successfully');
}
