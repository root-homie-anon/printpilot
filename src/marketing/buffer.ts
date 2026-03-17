import logger from '../utils/logger.js';
import {
  withTimeout,
  withRetry,
  isRetryableError,
  CircuitBreaker,
} from '../utils/resilience.js';

const BASE_URL = 'https://api.bufferapp.com/1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;

// ── Types ───────────────────────────────────────────────────────────

export interface BufferProfile {
  profileId: string;
  service: string;
  serviceUsername: string;
  isDefault: boolean;
}

export interface BufferPostData {
  profileIds: string[];
  text: string;
  link?: string;
  mediaUrl?: string;
  scheduledAt?: string;
}

export interface BufferPost {
  postId: string;
  profileId: string;
  text: string;
  status: 'buffer' | 'sent' | 'error';
  scheduledAt: string;
  sentAt?: string;
}

export interface BufferPostAnalytics {
  impressions: number;
  clicks: number;
  repins: number;
  likes: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export class BufferApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;
  public readonly responseBody: string;

  constructor(statusCode: number, endpoint: string, responseBody: string) {
    super(`Buffer API error ${statusCode} on ${endpoint}: ${responseBody}`);
    this.name = 'BufferApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

// ── Client ──────────────────────────────────────────────────────────

export class BufferClient {
  private readonly accessToken: string;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
    this.circuitBreaker = new CircuitBreaker({
      name: 'buffer-api',
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${path}${separator}access_token=${this.accessToken}`;

    logger.debug(`Buffer API ${method} ${path}`);

    return this.circuitBreaker.execute(() =>
      withRetry(
        async () => {
          const init: RequestInit = {
            method,
            headers: { 'Content-Type': 'application/json' },
          };

          if (body) {
            init.body = JSON.stringify(body);
          }

          const response = await withTimeout(
            fetch(url, init),
            REQUEST_TIMEOUT_MS,
            `${method} ${path}`
          );

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10_000;
            logger.warn(`Buffer rate limited on ${path}. Waiting ${waitMs}ms`);
            await new Promise<void>((r) => setTimeout(r, waitMs));
            throw new BufferApiError(429, path, 'Rate limited');
          }

          if (!response.ok) {
            const responseBody = await response.text();
            throw new BufferApiError(response.status, path, responseBody);
          }

          const data = (await response.json()) as T;
          return data;
        },
        {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryOn: (error) => {
            if (error instanceof BufferApiError) {
              return [429, 500, 502, 503, 504].includes(error.statusCode);
            }
            return isRetryableError(error);
          },
          onRetry: (attempt, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`Buffer API retry ${attempt} for ${method} ${path}: ${msg}`);
          },
        }
      )
    );
  }

  // ── Profiles ────────────────────────────────────────────────────

  async getProfiles(): Promise<BufferProfile[]> {
    logger.debug('Fetching Buffer profiles');
    const raw = await this.request<BufferProfileRaw[]>('GET', '/profiles.json');
    return raw.map(mapRawProfile);
  }

  async getPinterestProfiles(): Promise<BufferProfile[]> {
    const profiles = await this.getProfiles();
    return profiles.filter((p) => p.service === 'pinterest');
  }

  // ── Posts ───────────────────────────────────────────────────────

  async createPost(data: BufferPostData): Promise<BufferPost[]> {
    logger.info(`Creating Buffer post for ${data.profileIds.length} profile(s)`);

    const payload: Record<string, unknown> = {
      profile_ids: data.profileIds,
      text: data.text,
      shorten: true,
    };

    if (data.link) {
      payload.link = data.link;
    }

    if (data.mediaUrl) {
      payload.media = { photo: data.mediaUrl };
    }

    if (data.scheduledAt) {
      payload.scheduled_at = data.scheduledAt;
    }

    const raw = await this.request<BufferCreateResponse>(
      'POST',
      '/updates/create.json',
      payload
    );

    return raw.updates.map(mapRawPost);
  }

  async getPost(postId: string): Promise<BufferPost> {
    logger.debug(`Fetching Buffer post ${postId}`);
    const raw = await this.request<BufferPostRaw>(
      'GET',
      `/updates/${postId}.json`
    );
    return mapRawPost(raw);
  }

  async getPendingPosts(profileId: string): Promise<BufferPost[]> {
    logger.debug(`Fetching pending posts for profile ${profileId}`);
    const raw = await this.request<{ updates: BufferPostRaw[] }>(
      'GET',
      `/profiles/${profileId}/updates/pending.json`
    );
    return raw.updates.map(mapRawPost);
  }

  async getSentPosts(profileId: string): Promise<BufferPost[]> {
    logger.debug(`Fetching sent posts for profile ${profileId}`);
    const raw = await this.request<{ updates: BufferPostRaw[] }>(
      'GET',
      `/profiles/${profileId}/updates/sent.json`
    );
    return raw.updates.map(mapRawPost);
  }

  async deletePost(postId: string): Promise<void> {
    logger.info(`Deleting Buffer post ${postId}`);
    await this.request<unknown>('POST', `/updates/${postId}/destroy.json`);
  }

  async getPostAnalytics(postId: string): Promise<BufferPostAnalytics> {
    logger.debug(`Fetching analytics for Buffer post ${postId}`);
    const raw = await this.request<BufferInteractionRaw>(
      'GET',
      `/updates/${postId}/interactions.json`
    );

    return {
      impressions: raw.totals?.impressions ?? 0,
      clicks: raw.totals?.clicks ?? 0,
      repins: raw.totals?.repins ?? 0,
      likes: raw.totals?.likes ?? 0,
    };
  }
}

// ── Internal types ──────────────────────────────────────────────────

interface BufferProfileRaw {
  id: string;
  service: string;
  service_username: string;
  default: boolean;
}

interface BufferPostRaw {
  id: string;
  profile_id: string;
  text: string;
  status: string;
  scheduled_at: number;
  sent_at?: number;
}

interface BufferCreateResponse {
  success: boolean;
  updates: BufferPostRaw[];
}

interface BufferInteractionRaw {
  totals?: {
    impressions?: number;
    clicks?: number;
    repins?: number;
    likes?: number;
  };
}

// ── Mappers ─────────────────────────────────────────────────────────

function mapRawProfile(raw: BufferProfileRaw): BufferProfile {
  return {
    profileId: raw.id,
    service: raw.service,
    serviceUsername: raw.service_username,
    isDefault: raw.default,
  };
}

function mapRawPost(raw: BufferPostRaw): BufferPost {
  return {
    postId: raw.id,
    profileId: raw.profile_id,
    text: raw.text,
    status: raw.status as BufferPost['status'],
    scheduledAt: new Date(raw.scheduled_at * 1000).toISOString(),
    sentAt: raw.sent_at
      ? new Date(raw.sent_at * 1000).toISOString()
      : undefined,
  };
}
