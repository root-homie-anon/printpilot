import logger from '../utils/logger.js';
import {
  withTimeout,
  withRetry,
  isRetryableError,
  CircuitBreaker,
} from '../utils/resilience.js';
import type {
  CreateListingInput,
  EtsyListing,
  ListingStats,
  SearchOptions,
} from './types.js';

const BASE_URL = 'https://api.etsy.com/v3';
const RATE_LIMIT_WARNING_THRESHOLD = 0.8;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;

export class EtsyApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;
  public readonly responseBody: string;

  constructor(statusCode: number, endpoint: string, responseBody: string) {
    super(`Etsy API error ${statusCode} on ${endpoint}: ${responseBody}`);
    this.name = 'EtsyApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

interface RateLimitInfo {
  remaining: number;
  limit: number;
}

export class EtsyClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly shopId: string;
  private accessToken: string | null = null;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(apiKey: string, apiSecret: string, shopId: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.shopId = shopId;
    this.circuitBreaker = new CircuitBreaker({
      name: 'etsy-api',
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
    });
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return headers;
  }

  private checkRateLimits(response: Response): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');

    if (remaining !== null && limit !== null) {
      const info: RateLimitInfo = {
        remaining: parseInt(remaining, 10),
        limit: parseInt(limit, 10),
      };

      const usageRatio = 1 - info.remaining / info.limit;

      if (usageRatio >= RATE_LIMIT_WARNING_THRESHOLD) {
        logger.warn(
          `Etsy rate limit warning: ${info.remaining}/${info.limit} requests remaining ` +
            `(${Math.round(usageRatio * 100)}% used)`
        );
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;

    logger.debug(`Etsy API ${method} ${path}`);

    return this.circuitBreaker.execute(() =>
      withRetry(
        async () => {
          const response = await withTimeout(
            fetch(url, {
              method,
              headers: this.getHeaders(),
              body: body ? JSON.stringify(body) : undefined,
            }),
            REQUEST_TIMEOUT_MS,
            `${method} ${path}`
          );

          this.checkRateLimits(response);

          // Handle rate limiting with Retry-After header
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
            logger.warn(`Etsy rate limited on ${path}. Waiting ${waitMs}ms`);
            await new Promise<void>((r) => setTimeout(r, waitMs));
            throw new EtsyApiError(429, path, 'Rate limited');
          }

          if (!response.ok) {
            const responseBody = await response.text();
            throw new EtsyApiError(response.status, path, responseBody);
          }

          const data = (await response.json()) as T;
          return data;
        },
        {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryOn: (error) => {
            if (error instanceof EtsyApiError) {
              return [429, 500, 502, 503, 504].includes(error.statusCode);
            }
            return isRetryableError(error);
          },
          onRetry: (attempt, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`Etsy API retry ${attempt} for ${method} ${path}: ${msg}`);
          },
        }
      )
    );
  }

  async createDraftListing(data: CreateListingInput): Promise<EtsyListing> {
    logger.info(`Creating draft listing: "${data.title}"`);

    const payload: Record<string, unknown> = {
      title: data.title,
      description: data.description,
      price: data.price,
      tags: data.tags,
      taxonomy_id: data.taxonomyId,
      who_made: data.whoMade,
      when_made: data.whenMade,
      is_digital: data.isDigital,
      state: 'draft',
    };

    const raw = await this.request<EtsyListingRaw>(
      'POST',
      `/application/shops/${this.shopId}/listings`,
      payload
    );

    return mapRawListing(raw);
  }

  async uploadDigitalFile(listingId: number, filePath: string): Promise<void> {
    logger.info(`Uploading digital file for listing ${listingId}: ${filePath}`);

    const { readFile } = await import('node:fs/promises');
    const fileBuffer = await readFile(filePath);
    const fileName = filePath.split('/').pop() ?? 'product.pdf';

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);

    const url = `${BASE_URL}/application/shops/${this.shopId}/listings/${listingId}/files`;

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    await this.circuitBreaker.execute(() =>
      withRetry(
        async () => {
          const response = await withTimeout(
            fetch(url, {
              method: 'POST',
              headers,
              body: formData,
            }),
            120_000, // 2 min for file upload
            `upload file for listing ${listingId}`
          );

          this.checkRateLimits(response);

          if (!response.ok) {
            const responseBody = await response.text();
            throw new EtsyApiError(
              response.status,
              `/listings/${listingId}/files`,
              responseBody
            );
          }
        },
        {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryOn: (error) => {
            if (error instanceof EtsyApiError) {
              return [429, 500, 502, 503, 504].includes(error.statusCode);
            }
            return isRetryableError(error);
          },
        }
      )
    );

    logger.info(`Digital file uploaded successfully for listing ${listingId}`);
  }

  async publishListing(listingId: number): Promise<EtsyListing> {
    logger.info(`Publishing listing ${listingId}`);

    const raw = await this.request<EtsyListingRaw>(
      'PUT',
      `/application/shops/${this.shopId}/listings/${listingId}`,
      { state: 'active' }
    );

    return mapRawListing(raw);
  }

  async getListing(listingId: number): Promise<EtsyListing> {
    logger.debug(`Fetching listing ${listingId}`);

    const raw = await this.request<EtsyListingRaw>(
      'GET',
      `/application/listings/${listingId}`
    );

    return mapRawListing(raw);
  }

  async getListingStats(listingId: number): Promise<ListingStats> {
    logger.debug(`Fetching stats for listing ${listingId}`);

    const listing = await this.request<EtsyListingRaw>(
      'GET',
      `/application/listings/${listingId}`
    );

    const transactions = await this.request<EtsyTransactionsResponse>(
      'GET',
      `/application/shops/${this.shopId}/transactions?listing_id=${listingId}`
    );

    const sales = transactions.count;
    const revenue = transactions.results.reduce(
      (sum: number, tx: EtsyTransaction) => sum + parseFloat(tx.price.amount) / tx.price.divisor,
      0
    );

    return {
      views: listing.views ?? 0,
      favorites: listing.num_favorers ?? 0,
      sales,
      revenue,
    };
  }

  async searchListings(
    query: string,
    options?: SearchOptions
  ): Promise<EtsyListing[]> {
    logger.debug(`Searching listings: "${query}"`);

    const params = new URLSearchParams({ keywords: query });

    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.offset !== undefined) {
      params.set('offset', String(options.offset));
    }
    if (options?.sortBy) {
      params.set('sort_on', options.sortBy);
    }
    if (options?.category) {
      params.set('category', options.category);
    }

    const raw = await this.request<EtsySearchResponse>(
      'GET',
      `/application/listings/active?${params.toString()}`
    );

    return raw.results.map(mapRawListing);
  }
}

// ── Raw Etsy API response types (internal) ──────────────────────────

interface EtsyListingRaw {
  listing_id: number;
  title: string;
  description: string;
  price: { amount: number; divisor: number; currency_code: string };
  url: string;
  state: string;
  tags: string[];
  views?: number;
  num_favorers?: number;
  created_timestamp: number;
}

interface EtsySearchResponse {
  count: number;
  results: EtsyListingRaw[];
}

interface EtsyTransaction {
  price: { amount: string; divisor: number; currency_code: string };
}

interface EtsyTransactionsResponse {
  count: number;
  results: EtsyTransaction[];
}

function mapRawListing(raw: EtsyListingRaw): EtsyListing {
  return {
    listingId: raw.listing_id,
    title: raw.title,
    description: raw.description,
    price: raw.price.amount / raw.price.divisor,
    url: raw.url,
    state: raw.state as EtsyListing['state'],
    tags: raw.tags,
    views: raw.views ?? 0,
    favorites: raw.num_favorers ?? 0,
    createdAt: new Date(raw.created_timestamp * 1000).toISOString(),
  };
}
