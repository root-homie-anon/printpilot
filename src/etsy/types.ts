// ── Etsy API Types ──────────────────────────────────────────────────

export interface CreateListingInput {
  title: string;
  description: string;
  price: number;
  tags: string[];
  categoryId: number;
  isDigital: true;
  whoMade: 'i_did' | 'someone_else' | 'collective';
  whenMade: string;
  taxonomyId: number;
}

export interface EtsyListing {
  listingId: number;
  title: string;
  description: string;
  price: number;
  url: string;
  state: 'active' | 'inactive' | 'draft' | 'removed' | 'expired';
  tags: string[];
  views: number;
  favorites: number;
  createdAt: string;
}

export interface ListingStats {
  views: number;
  favorites: number;
  sales: number;
  revenue: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'created' | 'price' | 'score';
  category?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CompetitionAnalysis {
  totalListings: number;
  avgPrice: number;
  avgReviews: number;
  topSellerCount: number;
  saturationLevel: 'low' | 'medium' | 'high' | 'oversaturated';
}

export interface PriceDistribution {
  min: number;
  max: number;
  median: number;
  p25: number;
  p75: number;
  sweetSpot: number;
}
