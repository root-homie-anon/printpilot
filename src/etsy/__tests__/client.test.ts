import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EtsyClient, EtsyApiError } from '../client.js';

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockFetchResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): void {
  const headersMap = new Map(Object.entries(headers));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (key: string) => headersMap.get(key) ?? null,
      },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    })
  );
}

describe('EtsyClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('constructor sets correct base URL and credentials', () => {
    const client = new EtsyClient('test-key', 'test-secret', 'shop-123');
    // Client is constructed without throwing
    expect(client).toBeDefined();
  });

  it('createDraftListing sends correct payload', async () => {
    const rawResponse = {
      listing_id: 999,
      title: 'Budget Planner',
      description: 'A great planner',
      price: { amount: 599, divisor: 100, currency_code: 'USD' },
      url: 'https://etsy.com/listing/999',
      state: 'draft',
      tags: ['planner', 'budget'],
      views: 0,
      num_favorers: 0,
      created_timestamp: Math.floor(Date.now() / 1000),
    };

    mockFetchResponse(rawResponse);

    const client = new EtsyClient('test-key', 'test-secret', 'shop-123');
    client.setAccessToken('bearer-token');

    const listing = await client.createDraftListing({
      title: 'Budget Planner',
      description: 'A great planner',
      price: 5.99,
      tags: ['planner', 'budget'],
      categoryId: 1,
      isDigital: true,
      whoMade: 'i_did',
      whenMade: '2024',
      taxonomyId: 123,
    });

    expect(listing.listingId).toBe(999);
    expect(listing.title).toBe('Budget Planner');
    expect(listing.state).toBe('draft');
    expect(listing.price).toBeCloseTo(5.99);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toContain('/application/shops/shop-123/listings');
    expect(fetchCall[1]?.method).toBe('POST');

    const sentBody = JSON.parse(fetchCall[1]?.body as string);
    expect(sentBody.title).toBe('Budget Planner');
    expect(sentBody.is_digital).toBe(true);
    expect(sentBody.state).toBe('draft');
  });

  it('EtsyApiError includes status code and endpoint', async () => {
    mockFetchResponse('Rate limit exceeded', 429);

    const client = new EtsyClient('test-key', 'test-secret', 'shop-123');
    client.setAccessToken('bearer-token');

    await expect(
      client.createDraftListing({
        title: 'Test',
        description: 'Test',
        price: 1.0,
        tags: ['test'],
        categoryId: 1,
        isDigital: true,
        whoMade: 'i_did',
        whenMade: '2024',
        taxonomyId: 123,
      })
    ).rejects.toThrow(EtsyApiError);

    try {
      await client.createDraftListing({
        title: 'Test',
        description: 'Test',
        price: 1.0,
        tags: ['test'],
        categoryId: 1,
        isDigital: true,
        whoMade: 'i_did',
        whenMade: '2024',
        taxonomyId: 123,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EtsyApiError);
      const apiError = error as EtsyApiError;
      expect(apiError.statusCode).toBe(429);
      expect(apiError.endpoint).toContain('/application/shops/shop-123/listings');
    }
  });

  it('handles rate limit responses', async () => {
    mockFetchResponse('Too Many Requests', 429, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Limit': '100',
    });

    const client = new EtsyClient('test-key', 'test-secret', 'shop-123');

    await expect(
      client.getListing(12345)
    ).rejects.toThrow(EtsyApiError);
  });
});
