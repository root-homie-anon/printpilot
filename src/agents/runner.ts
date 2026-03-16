import type { AgentResult } from '../types/index.js';
import logger from '../utils/logger.js';
import { withTimeout, TimeoutError, sendToDeadLetterQueue } from '../utils/resilience.js';

type AgentFunction<T> = (input: unknown) => Promise<T>;

const agentRegistry = new Map<string, AgentFunction<unknown>>();

const AGENT_TIMEOUTS: Record<string, number> = {
  researcher: 300_000,         // 5 min — scrapes external sites
  'strategist-enhanced': 120_000, // 2 min — AI calls
  designer: 180_000,           // 3 min — PDF rendering
  copywriter: 120_000,         // 2 min — AI calls
  scorer: 120_000,             // 2 min — AI calls
  'reference-comparator': 120_000,
  'listing-agent': 60_000,     // 1 min
  'listing-health-checker': 15_000,
  'marketing-pinterest': 60_000,
  'marketing-email': 30_000,
  'marketing-blog': 60_000,
};

const DEFAULT_TIMEOUT_MS = 60_000; // 1 min

export function registerAgent<T>(
  name: string,
  handler: AgentFunction<T>
): void {
  agentRegistry.set(name, handler as AgentFunction<unknown>);
  logger.info(`Agent registered: ${name}`);
}

export async function runAgent<T>(
  agentName: string,
  input: unknown,
  timeoutMs?: number
): Promise<AgentResult<T>> {
  logger.info(`Running agent: ${agentName}`);
  const startTime = performance.now();

  const handler = agentRegistry.get(agentName);
  if (!handler) {
    const duration = Math.round(performance.now() - startTime);
    logger.error(`Agent not found: ${agentName}`);
    return {
      success: false,
      error: `Agent "${agentName}" is not registered`,
      duration,
    };
  }

  const timeout = timeoutMs ?? AGENT_TIMEOUTS[agentName] ?? DEFAULT_TIMEOUT_MS;

  try {
    const data = (await withTimeout(
      handler(input),
      timeout,
      `agent:${agentName}`
    )) as T;
    const duration = Math.round(performance.now() - startTime);

    logger.info(`Agent ${agentName} completed in ${duration}ms`);
    return {
      success: true,
      data,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const isTimeout = error instanceof TimeoutError;
    const message = error instanceof Error ? error.message : String(error);

    if (isTimeout) {
      logger.error(`Agent ${agentName} TIMED OUT after ${timeout}ms`);
    } else {
      logger.error(`Agent ${agentName} failed: ${message}`);
    }

    // Send failed agent runs to dead letter queue for replay
    await sendToDeadLetterQueue(
      `agent:${agentName}`,
      message,
      input,
      typeof input === 'object' && input !== null && 'productId' in input
        ? String((input as Record<string, unknown>).productId)
        : undefined
    ).catch((dlqError) => {
      logger.warn('Failed to write to dead letter queue', {
        error: dlqError instanceof Error ? dlqError.message : String(dlqError),
      });
    });

    return {
      success: false,
      error: message,
      duration,
    };
  }
}

export default runAgent;
