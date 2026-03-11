// ── Base Error ────────────────────────────────────────────────────────

export class PrintPilotError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'PrintPilotError';
    this.code = code;
    this.context = context;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    };
  }
}

// ── Pipeline Error ───────────────────────────────────────────────────

export class PipelineError extends PrintPilotError {
  public readonly stage: string;
  public readonly productId?: string;

  constructor(
    message: string,
    stage: string,
    productId?: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'PIPELINE_STAGE_FAILED', { ...context, stage, productId });
    this.name = 'PipelineError';
    this.stage = stage;
    this.productId = productId;
  }
}

// ── Etsy API Error ───────────────────────────────────────────────────

export class EtsyApiError extends PrintPilotError {
  public readonly statusCode: number;
  public readonly endpoint: string;

  constructor(
    message: string,
    statusCode: number,
    endpoint: string,
    context?: Record<string, unknown>
  ) {
    const code = statusCode === 429 ? 'ETSY_API_RATE_LIMIT' : 'ETSY_API_REQUEST_FAILED';
    super(message, code, { ...context, statusCode, endpoint });
    this.name = 'EtsyApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

// ── Render Error ─────────────────────────────────────────────────────

export class RenderError extends PrintPilotError {
  public readonly templateName?: string;

  constructor(message: string, templateName?: string, context?: Record<string, unknown>) {
    super(message, 'RENDER_FAILED', { ...context, templateName });
    this.name = 'RenderError';
    this.templateName = templateName;
  }
}

// ── Config Error ─────────────────────────────────────────────────────

export class ConfigError extends PrintPilotError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_INVALID', context);
    this.name = 'ConfigError';
  }
}

// ── Notification Error ───────────────────────────────────────────────

export class NotificationError extends PrintPilotError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NOTIFICATION_FAILED', context);
    this.name = 'NotificationError';
  }
}

// ── Feedback Error ───────────────────────────────────────────────────

export class FeedbackError extends PrintPilotError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'FEEDBACK_ERROR', context);
    this.name = 'FeedbackError';
  }
}

// ── Marketing Error ──────────────────────────────────────────────────

export class MarketingError extends PrintPilotError {
  public readonly channel: string;

  constructor(message: string, channel: string, context?: Record<string, unknown>) {
    super(message, 'MARKETING_CHANNEL_FAILED', { ...context, channel });
    this.name = 'MarketingError';
    this.channel = channel;
  }
}
