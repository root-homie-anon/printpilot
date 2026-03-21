import Anthropic from '@anthropic-ai/sdk';
import { getEnvOrThrow } from './env.js';
import logger from './logger.js';

export interface ClaudeOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;

class ClaudeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ClaudeApiError';
  }
}

let clientInstance: Anthropic | undefined;

function getClient(): Anthropic {
  if (!clientInstance) {
    const apiKey = getEnvOrThrow('ANTHROPIC_API_KEY');
    clientInstance = new Anthropic({ apiKey });
  }
  return clientInstance;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) {
    return true;
  }
  if (error instanceof Anthropic.InternalServerError) {
    return true;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callClaude(
  prompt: string,
  options?: ClaudeOptions,
): Promise<string> {
  const model = options?.model ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
  const systemPrompt = options?.systemPrompt;

  const client = getClient();
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `Claude API retry attempt ${attempt}/${MAX_RETRIES}, waiting ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }

    const startTime = performance.now();

    try {
      // Use streaming for large requests to avoid timeout
      const useStreaming = maxTokens > 16384;

      if (useStreaming) {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt ?? '',
          messages: [{ role: 'user', content: prompt }],
        });

        const finalMessage = await stream.finalMessage();
        const durationMs = Math.round(performance.now() - startTime);
        const responseText = finalMessage.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        logger.info('Claude API call completed (streaming)', {
          model,
          promptLength: prompt.length,
          responseLength: responseText.length,
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          durationMs,
          attempt,
        });

        return responseText;
      }

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt ?? '',
        messages: [{ role: 'user', content: prompt }],
      });

      const durationMs = Math.round(performance.now() - startTime);
      const responseText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      logger.info('Claude API call completed', {
        model,
        promptLength: prompt.length,
        responseLength: responseText.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs,
        attempt,
      });

      return responseText;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);
      lastError = error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Claude API call failed', {
        model,
        promptLength: prompt.length,
        durationMs,
        attempt,
        error: errorMessage,
      });

      if (!isRetryableError(error) || attempt === MAX_RETRIES) {
        break;
      }
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ClaudeApiError(
    `Claude API call failed after ${MAX_RETRIES + 1} attempts: ${finalMessage}`,
    undefined,
    false,
  );
}

export default callClaude;
