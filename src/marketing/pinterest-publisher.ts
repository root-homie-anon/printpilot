import { PinterestClient } from './pinterest.js';
import type { PinData, Pin, PinAnalytics, Board, CreateBoardInput } from './pinterest.js';
import { BufferClient } from './buffer.js';
import type { BufferPost } from './buffer.js';
import { loadConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface PublishPinInput {
  title: string;
  description: string;
  imageUrl: string;
  link: string;
  boardId: string;
  altText?: string;
  scheduledAt?: string;
}

export interface PublishPinResult {
  id: string;
  url: string;
  route: 'direct' | 'buffer';
}

export interface PublisherAnalytics {
  impressions: number;
  saves: number;
  clicks: number;
  route: 'direct' | 'buffer';
}

// ── Publisher ────────────────────────────────────────────────────────

export class PinterestPublisher {
  private pinterestClient: PinterestClient | null = null;
  private bufferClient: BufferClient | null = null;
  private bufferPinterestProfileId: string | null = null;
  private useDirect: boolean;

  constructor(options: {
    pinterestDirect: boolean;
    pinterestAccessToken?: string;
    bufferAccessToken?: string;
    bufferPinterestProfileId?: string;
  }) {
    this.useDirect = options.pinterestDirect;

    if (options.pinterestAccessToken) {
      this.pinterestClient = new PinterestClient(options.pinterestAccessToken);
    }

    if (options.bufferAccessToken) {
      this.bufferClient = new BufferClient(options.bufferAccessToken);
      this.bufferPinterestProfileId = options.bufferPinterestProfileId ?? null;
    }
  }

  static async fromEnv(): Promise<PinterestPublisher> {
    const config = await loadConfig();
    const pinterestDirect = config.features.pinterestDirect ?? true;

    return new PinterestPublisher({
      pinterestDirect,
      pinterestAccessToken: process.env.PINTEREST_ACCESS_TOKEN,
      bufferAccessToken: process.env.BUFFER_ACCESS_TOKEN,
      bufferPinterestProfileId: process.env.BUFFER_PINTEREST_PROFILE_ID,
    });
  }

  getRoute(): 'direct' | 'buffer' {
    return this.useDirect ? 'direct' : 'buffer';
  }

  // ── Publishing ──────────────────────────────────────────────────

  async publishPin(input: PublishPinInput): Promise<PublishPinResult> {
    if (this.useDirect) {
      return this.publishViaDirect(input);
    }
    return this.publishViaBuffer(input);
  }

  async publishPins(inputs: PublishPinInput[]): Promise<PublishPinResult[]> {
    const results: PublishPinResult[] = [];
    for (const input of inputs) {
      const result = await this.publishPin(input);
      results.push(result);
    }
    return results;
  }

  private async publishViaDirect(
    input: PublishPinInput
  ): Promise<PublishPinResult> {
    const client = this.requirePinterestClient();

    logger.info(`Publishing pin via Pinterest API: "${input.title}"`);

    const pinData: PinData = {
      title: input.title,
      description: input.description,
      link: input.link,
      boardId: input.boardId,
      altText: input.altText,
      mediaSource: { sourceType: 'image_url', url: input.imageUrl },
    };

    const pin = await client.createPin(pinData);

    return {
      id: pin.pinId,
      url: pin.url,
      route: 'direct',
    };
  }

  private async publishViaBuffer(
    input: PublishPinInput
  ): Promise<PublishPinResult> {
    const client = this.requireBufferClient();
    const profileId = await this.resolveBufferProfileId();

    logger.info(`Publishing pin via Buffer: "${input.title}"`);

    const posts = await client.createPost({
      profileIds: [profileId],
      text: `${input.title}\n\n${input.description}`,
      link: input.link,
      mediaUrl: input.imageUrl,
      scheduledAt: input.scheduledAt,
    });

    const post = posts[0];
    if (!post) {
      throw new Error('Buffer returned no post after creation');
    }

    return {
      id: post.postId,
      url: input.link,
      route: 'buffer',
    };
  }

  // ── Analytics ───────────────────────────────────────────────────

  async getAnalytics(
    id: string,
    route?: 'direct' | 'buffer'
  ): Promise<PublisherAnalytics> {
    const activeRoute = route ?? this.getRoute();

    if (activeRoute === 'direct') {
      const client = this.requirePinterestClient();
      const analytics = await client.getPinAnalytics(id);
      return {
        impressions: analytics.impressions,
        saves: analytics.saves,
        clicks: analytics.clicks,
        route: 'direct',
      };
    }

    const client = this.requireBufferClient();
    const analytics = await client.getPostAnalytics(id);
    return {
      impressions: analytics.impressions,
      saves: analytics.repins,
      clicks: analytics.clicks,
      route: 'buffer',
    };
  }

  // ── Board Management (direct only) ─────────────────────────────

  async createBoard(input: CreateBoardInput): Promise<Board> {
    const client = this.requirePinterestClient();
    return client.createBoard(input);
  }

  async ensureBoard(
    name: string,
    description: string
  ): Promise<Board> {
    const client = this.requirePinterestClient();

    let bookmark: string | null = null;
    do {
      const page = await client.listBoards(bookmark ?? undefined);
      const existing = page.items.find(
        (b) => b.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        logger.debug(`Board "${name}" already exists: ${existing.boardId}`);
        return existing;
      }
      bookmark = page.bookmark;
    } while (bookmark);

    logger.info(`Board "${name}" not found, creating it`);
    return client.createBoard({ name, description });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private requirePinterestClient(): PinterestClient {
    if (!this.pinterestClient) {
      throw new Error(
        'Pinterest client not configured. Set PINTEREST_ACCESS_TOKEN in .env'
      );
    }
    return this.pinterestClient;
  }

  private requireBufferClient(): BufferClient {
    if (!this.bufferClient) {
      throw new Error(
        'Buffer client not configured. Set BUFFER_ACCESS_TOKEN in .env'
      );
    }
    return this.bufferClient;
  }

  private async resolveBufferProfileId(): Promise<string> {
    if (this.bufferPinterestProfileId) {
      return this.bufferPinterestProfileId;
    }

    const client = this.requireBufferClient();
    const profiles = await client.getPinterestProfiles();

    if (profiles.length === 0) {
      throw new Error(
        'No Pinterest profiles found in Buffer. Connect a Pinterest account in Buffer settings.'
      );
    }

    this.bufferPinterestProfileId = profiles[0].profileId;
    logger.info(
      `Auto-resolved Buffer Pinterest profile: ${profiles[0].serviceUsername} (${profiles[0].profileId})`
    );

    return this.bufferPinterestProfileId;
  }
}
