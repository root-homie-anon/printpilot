import type { AgentResult } from '../types/index.js';
import logger from '../utils/logger.js';

type AgentFunction<T> = (input: unknown) => Promise<T>;

const agentRegistry = new Map<string, AgentFunction<unknown>>();

export function registerAgent<T>(
  name: string,
  handler: AgentFunction<T>
): void {
  agentRegistry.set(name, handler as AgentFunction<unknown>);
  logger.info(`Agent registered: ${name}`);
}

export async function runAgent<T>(
  agentName: string,
  input: unknown
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

  try {
    const data = (await handler(input)) as T;
    const duration = Math.round(performance.now() - startTime);

    logger.info(`Agent ${agentName} completed in ${duration}ms`);
    return {
      success: true,
      data,
      duration,
    };
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Agent ${agentName} failed: ${message}`);
    return {
      success: false,
      error: message,
      duration,
    };
  }
}

export default runAgent;
