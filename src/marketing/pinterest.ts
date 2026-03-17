import logger from '../utils/logger.js';
import {
  withTimeout,
  withRetry,
  isRetryableError,
  CircuitBreaker,
} from '../utils/resilience.js';

const BASE_URL = 'https://api.pinterest.com/v5';
const RATE_LIMIT_WARNING_THRESHOLD = 0.8;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;

// ── Types ───────────────────────────────────────────────────────────

export interface PinData {
  title: string;
  description: string;
  link: string;
  boardId: string;
  altText?: string;
  mediaSource: PinMediaSource;
}

export type PinMediaSource =
  | { sourceType: 'image_url'; url: string }
  | { sourceType: 'image_base64'; contentType: string; data: string }
  | { sourceType: 'multiple'; items: Array<{ url: string; title?: string }> };

export interface Pin {
  pinId: string;
  title: string;
  description: string;
  link: string;
  boardId: string;
  url: string;
  createdAt: string;
}

export interface PinAnalytics {
  impressions: number;
  saves: number;
  clicks: number;
  outboundClicks: number;
  videoViews: number;
}

export interface Board {
  boardId: string;
  name: string;
  description: string;
  url: string;
  privacy: 'PUBLIC' | 'SECRET' | 'PROTECTED';
  pinCount: number;
  followerCount: number;
  createdAt: string;
}

export interface BoardSection {
  sectionId: string;
  boardId: string;
  name: string;
  pinCount: number;
}

export interface CreateBoardInput {
  name: string;
  description: string;
  privacy?: 'PUBLIC' | 'SECRET' | 'PROTECTED';
}

export interface UpdateBoardInput {
  name?: string;
  description?: string;
  privacy?: 'PUBLIC' | 'SECRET' | 'PROTECTED';
}

export interface PaginatedResponse<T> {
  items: T[];
  bookmark: string | null;
}

// ── Errors ──────────────────────────────────────────────────────────

export class PinterestApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;
  public readonly responseBody: string;

  constructor(statusCode: number, endpoint: string, responseBody: string) {
    super(`Pinterest API error ${statusCode} on ${endpoint}: ${responseBody}`);
    this.name = 'PinterestApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

// ── Client ──────────────────────────────────────────────────────────

export class PinterestClient {
  private readonly accessToken: string;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
    this.circuitBreaker = new CircuitBreaker({
      name: 'pinterest-api',
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
    });
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private checkRateLimits(response: Response): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');

    if (remaining !== null && limit !== null) {
      const rem = parseInt(remaining, 10);
      const lim = parseInt(limit, 10);
      const usageRatio = 1 - rem / lim;

      if (usageRatio >= RATE_LIMIT_WARNING_THRESHOLD) {
        logger.warn(
          `Pinterest rate limit warning: ${rem}/${lim} requests remaining ` +
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

    logger.debug(`Pinterest API ${method} ${path}`);

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

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
            logger.warn(`Pinterest rate limited on ${path}. Waiting ${waitMs}ms`);
            await new Promise<void>((r) => setTimeout(r, waitMs));
            throw new PinterestApiError(429, path, 'Rate limited');
          }

          if (!response.ok) {
            const responseBody = await response.text();
            throw new PinterestApiError(response.status, path, responseBody);
          }

          if (response.status === 204) {
            return undefined as T;
          }

          const data = (await response.json()) as T;
          return data;
        },
        {
          maxAttempts: MAX_RETRY_ATTEMPTS,
          retryOn: (error) => {
            if (error instanceof PinterestApiError) {
              return [429, 500, 502, 503, 504].includes(error.statusCode);
            }
            return isRetryableError(error);
          },
          onRetry: (attempt, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`Pinterest API retry ${attempt} for ${method} ${path}: ${msg}`);
          },
        }
      )
    );
  }

  // ── Pins ────────────────────────────────────────────────────────

  async createPin(data: PinData): Promise<Pin> {
    logger.info(`Creating Pinterest pin: "${data.title}"`);

    const mediaSource = buildMediaSource(data.mediaSource);

    const payload: Record<string, unknown> = {
      title: data.title,
      description: data.description,
      board_id: data.boardId,
      link: data.link,
      media_source: mediaSource,
    };

    if (data.altText) {
      payload.alt_text = data.altText;
    }

    const raw = await this.request<PinterestPinRaw>('POST', '/pins', payload);
    return mapRawPin(raw);
  }

  async getPin(pinId: string): Promise<Pin> {
    logger.debug(`Fetching pin ${pinId}`);
    const raw = await this.request<PinterestPinRaw>('GET', `/pins/${pinId}`);
    return mapRawPin(raw);
  }

  async deletePin(pinId: string): Promise<void> {
    logger.info(`Deleting pin ${pinId}`);
    await this.request<void>('DELETE', `/pins/${pinId}`);
  }

  async listPins(
    boardId: string,
    bookmark?: string
  ): Promise<PaginatedResponse<Pin>> {
    logger.debug(`Listing pins for board ${boardId}`);
    const params = new URLSearchParams({ page_size: '25' });
    if (bookmark) {
      params.set('bookmark', bookmark);
    }

    const raw = await this.request<PinterestPaginatedRaw<PinterestPinRaw>>(
      'GET',
      `/boards/${boardId}/pins?${params.toString()}`
    );

    return {
      items: raw.items.map(mapRawPin),
      bookmark: raw.bookmark ?? null,
    };
  }

  async getPinAnalytics(
    pinId: string,
    startDate?: string,
    endDate?: string
  ): Promise<PinAnalytics> {
    logger.debug(`Fetching analytics for pin ${pinId}`);

    const start = startDate ?? getThirtyDaysAgo();
    const end = endDate ?? getToday();
    const metricTypes = 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,VIDEO_V50_WATCH_TIME';

    const raw = await this.request<PinterestAnalyticsRaw>(
      'GET',
      `/pins/${pinId}/analytics?start_date=${start}&end_date=${end}&metric_types=${metricTypes}`
    );

    const totals = raw.all?.summary_metrics ?? {};

    return {
      impressions: totals.IMPRESSION ?? 0,
      saves: totals.SAVE ?? 0,
      clicks: totals.PIN_CLICK ?? 0,
      outboundClicks: totals.OUTBOUND_CLICK ?? 0,
      videoViews: totals.VIDEO_V50_WATCH_TIME ?? 0,
    };
  }

  // ── Boards ──────────────────────────────────────────────────────

  async createBoard(input: CreateBoardInput): Promise<Board> {
    logger.info(`Creating Pinterest board: "${input.name}"`);

    const raw = await this.request<PinterestBoardRaw>('POST', '/boards', {
      name: input.name,
      description: input.description,
      privacy: input.privacy ?? 'PUBLIC',
    });

    return mapRawBoard(raw);
  }

  async getBoard(boardId: string): Promise<Board> {
    logger.debug(`Fetching board ${boardId}`);
    const raw = await this.request<PinterestBoardRaw>('GET', `/boards/${boardId}`);
    return mapRawBoard(raw);
  }

  async updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board> {
    logger.info(`Updating board ${boardId}`);
    const payload: Record<string, unknown> = {};
    if (input.name !== undefined) payload.name = input.name;
    if (input.description !== undefined) payload.description = input.description;
    if (input.privacy !== undefined) payload.privacy = input.privacy;

    const raw = await this.request<PinterestBoardRaw>(
      'PATCH',
      `/boards/${boardId}`,
      payload
    );
    return mapRawBoard(raw);
  }

  async deleteBoard(boardId: string): Promise<void> {
    logger.info(`Deleting board ${boardId}`);
    await this.request<void>('DELETE', `/boards/${boardId}`);
  }

  async listBoards(bookmark?: string): Promise<PaginatedResponse<Board>> {
    logger.debug('Listing boards');
    const params = new URLSearchParams({ page_size: '25' });
    if (bookmark) {
      params.set('bookmark', bookmark);
    }

    const raw = await this.request<PinterestPaginatedRaw<PinterestBoardRaw>>(
      'GET',
      `/boards?${params.toString()}`
    );

    return {
      items: raw.items.map(mapRawBoard),
      bookmark: raw.bookmark ?? null,
    };
  }

  // ── Board Sections ──────────────────────────────────────────────

  async createBoardSection(
    boardId: string,
    name: string
  ): Promise<BoardSection> {
    logger.info(`Creating board section "${name}" on board ${boardId}`);

    const raw = await this.request<PinterestSectionRaw>(
      'POST',
      `/boards/${boardId}/sections`,
      { name }
    );

    return mapRawSection(boardId, raw);
  }

  async listBoardSections(
    boardId: string,
    bookmark?: string
  ): Promise<PaginatedResponse<BoardSection>> {
    logger.debug(`Listing sections for board ${boardId}`);
    const params = new URLSearchParams({ page_size: '25' });
    if (bookmark) {
      params.set('bookmark', bookmark);
    }

    const raw = await this.request<PinterestPaginatedRaw<PinterestSectionRaw>>(
      'GET',
      `/boards/${boardId}/sections?${params.toString()}`
    );

    return {
      items: raw.items.map((s) => mapRawSection(boardId, s)),
      bookmark: raw.bookmark ?? null,
    };
  }

  async deleteBoardSection(
    boardId: string,
    sectionId: string
  ): Promise<void> {
    logger.info(`Deleting section ${sectionId} from board ${boardId}`);
    await this.request<void>(
      'DELETE',
      `/boards/${boardId}/sections/${sectionId}`
    );
  }

  // ── User Info ───────────────────────────────────────────────────

  async getUserAccount(): Promise<{ username: string; accountType: string }> {
    logger.debug('Fetching user account info');
    const raw = await this.request<{ username: string; account_type: string }>(
      'GET',
      '/user_account'
    );
    return { username: raw.username, accountType: raw.account_type };
  }
}

// ── Internal types ──────────────────────────────────────────────────

interface PinterestPinRaw {
  id: string;
  title: string;
  description: string;
  link: string;
  board_id: string;
  created_at: string;
}

interface PinterestBoardRaw {
  id: string;
  name: string;
  description: string;
  privacy: string;
  pin_count: number;
  follower_count: number;
  created_at: string;
}

interface PinterestSectionRaw {
  id: string;
  name: string;
  pin_count: number;
}

interface PinterestPaginatedRaw<T> {
  items: T[];
  bookmark?: string;
}

interface PinterestAnalyticsRaw {
  all?: {
    summary_metrics?: Record<string, number>;
  };
}

// ── Mappers ─────────────────────────────────────────────────────────

function mapRawPin(raw: PinterestPinRaw): Pin {
  return {
    pinId: raw.id,
    title: raw.title,
    description: raw.description,
    link: raw.link,
    boardId: raw.board_id,
    url: `https://www.pinterest.com/pin/${raw.id}/`,
    createdAt: raw.created_at,
  };
}

function mapRawBoard(raw: PinterestBoardRaw): Board {
  return {
    boardId: raw.id,
    name: raw.name,
    description: raw.description,
    url: `https://www.pinterest.com/board/${raw.id}/`,
    privacy: raw.privacy as Board['privacy'],
    pinCount: raw.pin_count,
    followerCount: raw.follower_count,
    createdAt: raw.created_at,
  };
}

function mapRawSection(boardId: string, raw: PinterestSectionRaw): BoardSection {
  return {
    sectionId: raw.id,
    boardId,
    name: raw.name,
    pinCount: raw.pin_count,
  };
}

function buildMediaSource(
  source: PinMediaSource
): Record<string, unknown> {
  switch (source.sourceType) {
    case 'image_url':
      return { source_type: 'image_url', url: source.url };
    case 'image_base64':
      return {
        source_type: 'image_base64',
        content_type: source.contentType,
        data: source.data,
      };
    case 'multiple':
      return {
        source_type: 'multiple',
        items: source.items.map((item) => ({
          url: item.url,
          title: item.title,
        })),
      };
  }
}

// ── Date helpers ────────────────────────────────────────────────────

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getThirtyDaysAgo(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}
