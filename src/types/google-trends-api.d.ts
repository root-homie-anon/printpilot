declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
    timezone?: number;
    category?: number;
    property?: string;
    resolution?: string;
    granularTimeResolution?: boolean;
  }

  interface GoogleTrends {
    interestOverTime(options: TrendsOptions): Promise<string>;
    interestByRegion(options: TrendsOptions): Promise<string>;
    relatedQueries(options: TrendsOptions): Promise<string>;
    relatedTopics(options: TrendsOptions): Promise<string>;
    dailyTrends(options: { geo?: string; trendDate?: Date; hl?: string }): Promise<string>;
    realTimeTrends(options: { geo?: string; hl?: string; category?: string }): Promise<string>;
    autoComplete(options: { keyword: string; hl?: string }): Promise<string>;
  }

  const googleTrends: GoogleTrends;
  export default googleTrends;
}
