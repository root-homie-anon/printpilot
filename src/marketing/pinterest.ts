import logger from '../utils/logger.js';

const BASE_URL = 'https://api.pinterest.com/v5';

// ── Types ───────────────────────────────────────────────────────────

export interface PinData {
  title: string;
  description: string;
  imageUrl: string;
  link: string;
  boardId: string;
}

export interface PinResult {
  pinId: string;
  url: string;
}

export interface PinAnalytics {
  impressions: number;
  saves: number;
  clicks: number;
}

export interface Board {
  boardId: string;
  name: string;
  description: string;
  url: string;
}

// ── Errors ──────────────────────────────────────────────────────────

export class PinterestApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;

  constructor(statusCode: number, endpoint: string, message: string) {
    super(`Pinterest API error ${statusCode} on ${endpoint}: ${message}`);
    this.name = 'PinterestApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

// ── Client ──────────────────────────────────────────────────────────

export class PinterestClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;

    logger.debug(`Pinterest API ${method} ${path}`);

    const response = await fetch(url, {
      method,
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new PinterestApiError(response.status, path, responseBody);
    }

    const data = (await response.json()) as T;
    return data;
  }

  async createPin(data: PinData): Promise<PinResult> {
    logger.info(`Creating Pinterest pin: "${data.title}"`);

    const payload: Record<string, unknown> = {
      title: data.title,
      description: data.description,
      board_id: data.boardId,
      media_source: {
        source_type: 'image_url',
        url: data.imageUrl,
      },
      link: data.link,
    };

    const raw = await this.request<PinterestPinRaw>('POST', '/pins', payload);

    return {
      pinId: raw.id,
      url: `https://www.pinterest.com/pin/${raw.id}/`,
    };
  }

  async createBoard(name: string, description: string): Promise<Board> {
    logger.info(`Creating Pinterest board: "${name}"`);

    const raw = await this.request<PinterestBoardRaw>('POST', '/boards', {
      name,
      description,
      privacy: 'PUBLIC',
    });

    return {
      boardId: raw.id,
      name: raw.name,
      description: raw.description,
      url: `https://www.pinterest.com/board/${raw.id}/`,
    };
  }

  async getAnalytics(pinId: string): Promise<PinAnalytics> {
    logger.debug(`Fetching analytics for pin ${pinId}`);

    const raw = await this.request<PinterestAnalyticsRaw>(
      'GET',
      `/pins/${pinId}/analytics?start_date=${getThirtyDaysAgo()}&end_date=${getToday()}&metric_types=IMPRESSION,SAVE,PIN_CLICK`
    );

    const totals = raw.all?.summary_metrics ?? {
      IMPRESSION: 0,
      SAVE: 0,
      PIN_CLICK: 0,
    };

    return {
      impressions: totals.IMPRESSION ?? 0,
      saves: totals.SAVE ?? 0,
      clicks: totals.PIN_CLICK ?? 0,
    };
  }
}

// ── Internal types ──────────────────────────────────────────────────

interface PinterestPinRaw {
  id: string;
  title: string;
  description: string;
  link: string;
}

interface PinterestBoardRaw {
  id: string;
  name: string;
  description: string;
}

interface PinterestAnalyticsRaw {
  all?: {
    summary_metrics?: {
      IMPRESSION?: number;
      SAVE?: number;
      PIN_CLICK?: number;
    };
  };
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getThirtyDaysAgo(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}
