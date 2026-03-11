export interface EtsyScrapedData {
  title: string;
  price: number;
  reviews: number;
  favorites: number;
  shopName: string;
  url: string;
  tags: string[];
  category: string;
  estimatedAge: string;
}

export interface EtsySearchResult {
  title: string;
  price: number;
  reviews: number;
  favorites: number;
  shopName: string;
  url: string;
  tags: string[];
  listingAge: string;
}

export interface ListingDetail {
  title: string;
  description: string;
  price: number;
  reviews: number;
  favorites: number;
  shopName: string;
  shopSales: number;
  tags: string[];
  images: string[];
  url: string;
  createdAt: string;
}

export interface PinterestTrend {
  keyword: string;
  relatedTerms: string[];
  pinCount: number;
  trendDirection: 'rising' | 'stable' | 'declining';
}

export interface PinterestPin {
  title: string;
  description: string;
  saves: number;
  imageUrl: string;
  link: string;
}

export interface TrendData {
  keyword: string;
  interestOverTime: number;
  trend: 'rising' | 'stable' | 'declining';
  relatedQueries: string[];
}
