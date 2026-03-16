export type ProductStatus =
  | 'researched'
  | 'briefed'
  | 'designed'
  | 'copywritten'
  | 'scored'
  | 'approved'
  | 'rejected'
  | 'revision'
  | 'listed'
  | 'marketing';

export type CompetitionLevel = 'low' | 'medium' | 'high';

export type FeedbackSource = 'design' | 'spec' | 'research';

export type FeedbackDecision = 'approve' | 'reject' | 'revise';

export interface ProductScores {
  layout: number;
  typography: number;
  color: number;
  differentiation: number;
  sellability: number;
}

export interface Product {
  id: string;
  niche: string;
  title: string;
  status: ProductStatus;
  scores: ProductScores;
  briefId: string;
  pdfPath?: string;
  listingId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductBrief {
  id: string;
  niche: string;
  targetAudience: string;
  pageCount: number;
  sections: string[];
  styleGuide: {
    primaryFont: string;
    accentColor: string;
    palette: string;
    layout: string;
  };
  createdAt: string;
}

export interface Opportunity {
  id: string;
  niche: string;
  avgPrice: number;
  reviewCount: number;
  competitionLevel: CompetitionLevel;
  trendScore: number;
  keywords: string[];
  source: string;
  discoveredAt: string;
}

export interface FeedbackRecord {
  id: string;
  productId: string;
  layout: number;
  typography: number;
  color: number;
  differentiation: number;
  sellability: number;
  issues: string;
  source: FeedbackSource;
  decision: FeedbackDecision;
  createdAt: string;
}

export interface ListingData {
  etsyUrl: string;
  listingId: string;
  title: string;
  description: string;
  tags: string[];
  price: number;
  status: 'draft' | 'active' | 'inactive' | 'removed';
  publishedAt?: string;
}

export interface MarketingPlan {
  listingId: string;
  pinterest: {
    scheduled: boolean;
    pinCount: number;
    scheduledAt?: string;
    completedAt?: string;
  };
  email: {
    scheduled: boolean;
    scheduledAt?: string;
    completedAt?: string;
  };
  blog: {
    scheduled: boolean;
    scheduledAt?: string;
    completedAt?: string;
  };
}

export interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  duration: number;
}

export interface ScoreReport {
  productId: string;
  scores: Record<string, number>;
  recommendation: string;
  flags: string[];
}

export interface PipelineResult {
  productsProcessed: number;
  approved: number;
  listed: number;
  errors: string[];
}

export interface SynthesisResult {
  patternsFound: number;
  instructionsUpdated: number;
  agentsAffected: string[];
}

export interface ApprovalDecision {
  decision: FeedbackDecision;
  feedback?: string;
  decidedAt: string;
}
