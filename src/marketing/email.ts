import logger from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface CampaignData {
  subject: string;
  htmlBody: string;
  textBody: string;
  listId: string;
  tags: string[];
}

export interface CampaignResult {
  campaignId: string;
  sentCount: number;
}

export interface CampaignStats {
  sent: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

export type EmailProvider = 'resend' | 'convertkit' | 'mailchimp';

// ── Errors ──────────────────────────────────────────────────────────

export class EmailApiError extends Error {
  public readonly provider: EmailProvider;
  public readonly statusCode: number;

  constructor(provider: EmailProvider, statusCode: number, message: string) {
    super(`Email API error (${provider}) ${statusCode}: ${message}`);
    this.name = 'EmailApiError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

// ── Provider strategy interface ─────────────────────────────────────

interface EmailProviderStrategy {
  sendCampaign(data: CampaignData): Promise<CampaignResult>;
  getSubscriberCount(): Promise<number>;
  getCampaignStats(campaignId: string): Promise<CampaignStats>;
}

// ── Resend provider ─────────────────────────────────────────────────

class ResendProvider implements EmailProviderStrategy {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.resend.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async sendCampaign(data: CampaignData): Promise<CampaignResult> {
    const response = await fetch(`${this.baseUrl}/emails/batch`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        subject: data.subject,
        html: data.htmlBody,
        text: data.textBody,
        tags: data.tags.map((t) => ({ name: t })),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('resend', response.status, body);
    }

    const result = (await response.json()) as { id: string; count: number };
    return { campaignId: result.id, sentCount: result.count };
  }

  async getSubscriberCount(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/audiences`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('resend', response.status, body);
    }

    const result = (await response.json()) as { data: { id: string; size: number }[] };
    return result.data.reduce((sum, audience) => sum + audience.size, 0);
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStats> {
    const response = await fetch(`${this.baseUrl}/emails/${campaignId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('resend', response.status, body);
    }

    const result = (await response.json()) as ResendEmailStats;
    return {
      sent: result.sent ?? 0,
      opened: result.opened ?? 0,
      clicked: result.clicked ?? 0,
      unsubscribed: 0,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}

interface ResendEmailStats {
  sent?: number;
  opened?: number;
  clicked?: number;
}

// ── ConvertKit provider ─────────────────────────────────────────────

class ConvertKitProvider implements EmailProviderStrategy {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.convertkit.com/v3';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async sendCampaign(data: CampaignData): Promise<CampaignResult> {
    const response = await fetch(`${this.baseUrl}/broadcasts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_secret: this.apiKey,
        subject: data.subject,
        content: data.htmlBody,
        description: data.textBody,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('convertkit', response.status, body);
    }

    const result = (await response.json()) as { broadcast: { id: number } };
    return { campaignId: String(result.broadcast.id), sentCount: 0 };
  }

  async getSubscriberCount(): Promise<number> {
    const response = await fetch(
      `${this.baseUrl}/subscribers?api_secret=${this.apiKey}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('convertkit', response.status, body);
    }

    const result = (await response.json()) as { total_subscribers: number };
    return result.total_subscribers;
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStats> {
    const response = await fetch(
      `${this.baseUrl}/broadcasts/${campaignId}/stats?api_secret=${this.apiKey}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('convertkit', response.status, body);
    }

    const result = (await response.json()) as {
      broadcast: { stats: { recipients: number; open_rate: number; click_rate: number; unsubscribers: number } };
    };

    const stats = result.broadcast.stats;
    return {
      sent: stats.recipients,
      opened: Math.round(stats.recipients * stats.open_rate),
      clicked: Math.round(stats.recipients * stats.click_rate),
      unsubscribed: stats.unsubscribers,
    };
  }
}

// ── Mailchimp provider ──────────────────────────────────────────────

class MailchimpProvider implements EmailProviderStrategy {
  private readonly apiKey: string;
  private readonly server: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    // Mailchimp API keys end with -usXX (server prefix)
    const parts = apiKey.split('-');
    this.server = parts[parts.length - 1];
  }

  private get baseUrl(): string {
    return `https://${this.server}.api.mailchimp.com/3.0`;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async sendCampaign(data: CampaignData): Promise<CampaignResult> {
    // Create campaign
    const createResponse = await fetch(`${this.baseUrl}/campaigns`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        type: 'regular',
        recipients: { list_id: data.listId },
        settings: {
          subject_line: data.subject,
          title: data.subject,
        },
      }),
    });

    if (!createResponse.ok) {
      const body = await createResponse.text();
      throw new EmailApiError('mailchimp', createResponse.status, body);
    }

    const campaign = (await createResponse.json()) as { id: string; recipients_count: number };

    // Set content
    const contentResponse = await fetch(
      `${this.baseUrl}/campaigns/${campaign.id}/content`,
      {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify({ html: data.htmlBody, plain_text: data.textBody }),
      }
    );

    if (!contentResponse.ok) {
      const body = await contentResponse.text();
      throw new EmailApiError('mailchimp', contentResponse.status, body);
    }

    // Send campaign
    const sendResponse = await fetch(
      `${this.baseUrl}/campaigns/${campaign.id}/actions/send`,
      { method: 'POST', headers: this.getHeaders() }
    );

    if (!sendResponse.ok) {
      const body = await sendResponse.text();
      throw new EmailApiError('mailchimp', sendResponse.status, body);
    }

    return {
      campaignId: campaign.id,
      sentCount: campaign.recipients_count,
    };
  }

  async getSubscriberCount(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/lists?count=100`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('mailchimp', response.status, body);
    }

    const result = (await response.json()) as {
      lists: { stats: { member_count: number } }[];
    };

    return result.lists.reduce((sum, list) => sum + list.stats.member_count, 0);
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStats> {
    const response = await fetch(
      `${this.baseUrl}/reports/${campaignId}`,
      { method: 'GET', headers: this.getHeaders() }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new EmailApiError('mailchimp', response.status, body);
    }

    const result = (await response.json()) as {
      emails_sent: number;
      opens: { unique_opens: number };
      clicks: { unique_clicks: number };
      unsubscribed: number;
    };

    return {
      sent: result.emails_sent,
      opened: result.opens.unique_opens,
      clicked: result.clicks.unique_clicks,
      unsubscribed: result.unsubscribed,
    };
  }
}

// ── Email Client (facade) ───────────────────────────────────────────

export class EmailClient {
  private readonly provider: EmailProviderStrategy;
  private readonly providerName: EmailProvider;

  constructor(providerName: EmailProvider, apiKey: string) {
    this.providerName = providerName;

    switch (providerName) {
      case 'resend':
        this.provider = new ResendProvider(apiKey);
        break;
      case 'convertkit':
        this.provider = new ConvertKitProvider(apiKey);
        break;
      case 'mailchimp':
        this.provider = new MailchimpProvider(apiKey);
        break;
      default: {
        const exhaustive: never = providerName;
        throw new Error(`Unsupported email provider: ${exhaustive}`);
      }
    }
  }

  async sendCampaign(data: CampaignData): Promise<CampaignResult> {
    logger.info(`Sending email campaign via ${this.providerName}: "${data.subject}"`);

    const result = await this.provider.sendCampaign(data);

    logger.info(
      `Campaign ${result.campaignId} sent to ${result.sentCount} recipients`
    );

    return result;
  }

  async getSubscriberCount(): Promise<number> {
    logger.debug(`Fetching subscriber count from ${this.providerName}`);
    return this.provider.getSubscriberCount();
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStats> {
    logger.debug(`Fetching campaign stats for ${campaignId} from ${this.providerName}`);
    return this.provider.getCampaignStats(campaignId);
  }
}
