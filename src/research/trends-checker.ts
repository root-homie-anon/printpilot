import logger from '../utils/logger.js';
import type { TrendData } from './types.js';

interface InterestOverTimeResult {
  default: {
    timelineData: Array<{
      time: string;
      formattedTime: string;
      value: number[];
    }>;
    averages: number[];
  };
}

interface RelatedQueriesResult {
  default: {
    rankedList: Array<{
      rankedKeyword: Array<{
        query: string;
        value: number;
        formattedValue: string;
        link: string;
      }>;
    }>;
  };
}

function classifyTrend(interestOverTime: number): TrendData['trend'] {
  if (interestOverTime >= 60) {
    return 'rising';
  }
  if (interestOverTime >= 30) {
    return 'stable';
  }
  return 'declining';
}

function calculateAverageInterest(timelineData: Array<{ value: number[] }>): number {
  if (timelineData.length === 0) {
    return 0;
  }

  const values = timelineData.map((point) => point.value[0] ?? 0);
  const sum = values.reduce((acc, val) => acc + val, 0);
  return Math.round(sum / values.length);
}

interface GoogleTrendsApi {
  interestOverTime(options: { keyword: string | string[]; startTime?: Date; geo?: string }): Promise<string>;
  relatedQueries(options: { keyword: string | string[]; startTime?: Date; geo?: string }): Promise<string>;
}

async function loadGoogleTrendsApi(): Promise<GoogleTrendsApi | null> {
  try {
    const module = await import('google-trends-api');
    return (module.default ?? module) as GoogleTrendsApi;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to load google-trends-api package: ${message}`);
    return null;
  }
}

export async function checkGoogleTrends(
  keywords: string[],
): Promise<TrendData[]> {
  logger.info(`Checking Google Trends for ${keywords.length} keywords`);

  const googleTrends = await loadGoogleTrendsApi();

  if (!googleTrends) {
    logger.warn('google-trends-api not available — returning empty results');
    return [];
  }

  const results: TrendData[] = [];
  const startTime = new Date();
  startTime.setMonth(startTime.getMonth() - 3); // 90 days

  for (const keyword of keywords) {
    logger.debug(`Checking Google Trends for: "${keyword}"`);

    try {
      // Fetch interest over time
      const interestRaw = await googleTrends.interestOverTime({
        keyword,
        startTime,
        geo: 'US',
      });

      const interestParsed: InterestOverTimeResult = JSON.parse(interestRaw);
      const timelineData = interestParsed.default?.timelineData ?? [];
      const interestOverTime = calculateAverageInterest(timelineData);

      // Fetch related queries
      let relatedQueries: string[] = [];
      try {
        const relatedRaw = await googleTrends.relatedQueries({
          keyword,
          startTime,
          geo: 'US',
        });

        const relatedParsed: RelatedQueriesResult = JSON.parse(relatedRaw);
        const rankedLists = relatedParsed.default?.rankedList ?? [];

        for (const list of rankedLists) {
          for (const item of list.rankedKeyword) {
            if (item.query && !relatedQueries.includes(item.query)) {
              relatedQueries.push(item.query);
            }
          }
        }

        relatedQueries = relatedQueries.slice(0, 10);
      } catch (relatedError: unknown) {
        const msg = relatedError instanceof Error ? relatedError.message : String(relatedError);
        logger.debug(`Could not fetch related queries for "${keyword}": ${msg}`);
      }

      const trend = classifyTrend(interestOverTime);

      results.push({
        keyword,
        interestOverTime,
        trend,
        relatedQueries,
      });

      logger.info(
        `Google Trends for "${keyword}": interest=${interestOverTime}, trend=${trend}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to check Google Trends for "${keyword}": ${message}`);
    }
  }

  logger.info(`Google Trends check complete: ${results.length} keywords analyzed`);
  return results;
}

export async function getRelatedQueries(
  keyword: string,
): Promise<string[]> {
  logger.info(`Getting related queries for: "${keyword}"`);

  const googleTrends = await loadGoogleTrendsApi();

  if (!googleTrends) {
    logger.warn('google-trends-api not available — returning empty results');
    return [];
  }

  const startTime = new Date();
  startTime.setMonth(startTime.getMonth() - 3);

  try {
    const relatedRaw = await googleTrends.relatedQueries({
      keyword,
      startTime,
      geo: 'US',
    });

    const relatedParsed: RelatedQueriesResult = JSON.parse(relatedRaw);
    const rankedLists = relatedParsed.default?.rankedList ?? [];
    const queries: string[] = [];

    for (const list of rankedLists) {
      for (const item of list.rankedKeyword) {
        if (item.query && !queries.includes(item.query)) {
          queries.push(item.query);
        }
      }
    }

    logger.info(`Found ${queries.length} related queries for "${keyword}"`);
    return queries;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to get related queries for "${keyword}": ${message}`);
    return [];
  }
}
