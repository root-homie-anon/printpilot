import logger from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface BlogPostData {
  title: string;
  content: string;
  excerpt: string;
  tags: string[];
  featuredImageUrl: string;
  slug: string;
}

export interface BlogPost {
  postId: string;
  url: string;
  publishedAt: string;
}

export interface BlogPostStats {
  views: number;
  shares: number;
}

export type BlogPlatform = 'wordpress' | 'ghost';

// ── Errors ──────────────────────────────────────────────────────────

export class BlogApiError extends Error {
  public readonly platform: BlogPlatform;
  public readonly statusCode: number;

  constructor(platform: BlogPlatform, statusCode: number, message: string) {
    super(`Blog API error (${platform}) ${statusCode}: ${message}`);
    this.name = 'BlogApiError';
    this.platform = platform;
    this.statusCode = statusCode;
  }
}

// ── Provider strategy interface ─────────────────────────────────────

interface BlogProviderStrategy {
  publishPost(data: BlogPostData): Promise<BlogPost>;
  getPostStats(postId: string): Promise<BlogPostStats>;
}

// ── WordPress provider ──────────────────────────────────────────────

class WordPressProvider implements BlogProviderStrategy {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async publishPost(data: BlogPostData): Promise<BlogPost> {
    const response = await fetch(`${this.apiUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        title: data.title,
        content: data.content,
        excerpt: data.excerpt,
        slug: data.slug,
        status: 'publish',
        tags: data.tags,
        featured_media_url: data.featuredImageUrl,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new BlogApiError('wordpress', response.status, body);
    }

    const result = (await response.json()) as WordPressPostRaw;

    return {
      postId: String(result.id),
      url: result.link,
      publishedAt: result.date,
    };
  }

  async getPostStats(postId: string): Promise<BlogPostStats> {
    // WordPress doesn't have built-in analytics; uses Jetpack stats endpoint
    const response = await fetch(
      `${this.apiUrl}/wp-json/wpcom/v2/stats/post/${postId}`,
      { method: 'GET', headers: this.getHeaders() }
    );

    if (!response.ok) {
      logger.warn(`Failed to fetch WordPress stats for post ${postId}, returning zeroes`);
      return { views: 0, shares: 0 };
    }

    const result = (await response.json()) as { views: number; shares?: number };
    return {
      views: result.views ?? 0,
      shares: result.shares ?? 0,
    };
  }
}

interface WordPressPostRaw {
  id: number;
  link: string;
  date: string;
}

// ── Ghost provider ──────────────────────────────────────────────────

class GhostProvider implements BlogProviderStrategy {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Ghost ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async publishPost(data: BlogPostData): Promise<BlogPost> {
    const response = await fetch(`${this.apiUrl}/ghost/api/admin/posts/`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        posts: [
          {
            title: data.title,
            html: data.content,
            custom_excerpt: data.excerpt,
            slug: data.slug,
            tags: data.tags.map((t) => ({ name: t })),
            feature_image: data.featuredImageUrl,
            status: 'published',
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new BlogApiError('ghost', response.status, body);
    }

    const result = (await response.json()) as { posts: GhostPostRaw[] };
    const post = result.posts[0];

    return {
      postId: post.id,
      url: post.url,
      publishedAt: post.published_at,
    };
  }

  async getPostStats(postId: string): Promise<BlogPostStats> {
    // Ghost provides member analytics via admin API
    const response = await fetch(
      `${this.apiUrl}/ghost/api/admin/posts/${postId}/?include=count.clicks`,
      { method: 'GET', headers: this.getHeaders() }
    );

    if (!response.ok) {
      logger.warn(`Failed to fetch Ghost stats for post ${postId}, returning zeroes`);
      return { views: 0, shares: 0 };
    }

    const result = (await response.json()) as {
      posts: { count?: { clicks?: number } }[];
    };

    return {
      views: result.posts[0]?.count?.clicks ?? 0,
      shares: 0,
    };
  }
}

interface GhostPostRaw {
  id: string;
  url: string;
  published_at: string;
}

// ── Blog Client (facade) ───────────────────────────────────────────

export class BlogClient {
  private readonly provider: BlogProviderStrategy;
  private readonly platform: BlogPlatform;

  constructor(platform: BlogPlatform, apiUrl: string, apiKey: string) {
    this.platform = platform;

    switch (platform) {
      case 'wordpress':
        this.provider = new WordPressProvider(apiUrl, apiKey);
        break;
      case 'ghost':
        this.provider = new GhostProvider(apiUrl, apiKey);
        break;
      default: {
        const exhaustive: never = platform;
        throw new Error(`Unsupported blog platform: ${exhaustive}`);
      }
    }
  }

  async publishPost(data: BlogPostData): Promise<BlogPost> {
    logger.info(`Publishing blog post via ${this.platform}: "${data.title}"`);

    const result = await this.provider.publishPost(data);

    logger.info(`Blog post published: ${result.url}`);
    return result;
  }

  async getPostStats(postId: string): Promise<BlogPostStats> {
    logger.debug(`Fetching blog post stats for ${postId} from ${this.platform}`);
    return this.provider.getPostStats(postId);
  }
}
