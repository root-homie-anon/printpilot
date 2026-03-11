import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type {
  Product,
  ProductBrief,
  Opportunity,
  FeedbackRecord,
} from '../index.js';

// Runtime validators using Zod to test type shapes

const ProductScoresSchema = z.object({
  layout: z.number().min(1).max(5),
  typography: z.number().min(1).max(5),
  color: z.number().min(1).max(5),
  differentiation: z.number().min(1).max(5),
  sellability: z.number().min(1).max(5),
});

const ProductSchema = z.object({
  id: z.string(),
  niche: z.string(),
  title: z.string(),
  status: z.enum([
    'researched', 'briefed', 'designed', 'copywritten',
    'scored', 'approved', 'rejected', 'revision', 'listed', 'marketing',
  ]),
  scores: ProductScoresSchema,
  briefId: z.string(),
  pdfPath: z.string().optional(),
  listingId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProductBriefSchema = z.object({
  id: z.string(),
  niche: z.string(),
  targetAudience: z.string(),
  pageCount: z.number().int().positive(),
  sections: z.array(z.string()),
  styleGuide: z.object({
    primaryFont: z.string(),
    accentColor: z.string(),
    palette: z.string(),
    layout: z.string(),
  }),
  createdAt: z.string(),
});

const OpportunitySchema = z.object({
  id: z.string(),
  niche: z.string(),
  avgPrice: z.number(),
  reviewCount: z.number().int(),
  competitionLevel: z.enum(['low', 'medium', 'high']),
  trendScore: z.number(),
  keywords: z.array(z.string()),
  source: z.string(),
  discoveredAt: z.string(),
});

const FeedbackRecordSchema = z.object({
  id: z.string(),
  productId: z.string(),
  layout: z.number().min(1).max(5),
  typography: z.number().min(1).max(5),
  color: z.number().min(1).max(5),
  differentiation: z.number().min(1).max(5),
  sellability: z.number().min(1).max(5),
  issues: z.string(),
  source: z.enum(['design', 'spec', 'research']),
  decision: z.enum(['approve', 'reject', 'revise']),
  createdAt: z.string(),
});

describe('Type validation', () => {
  it('Product type accepts valid data', () => {
    const validProduct: Product = {
      id: 'prod-001',
      niche: 'Budget Planner',
      title: 'Monthly Budget Tracker',
      status: 'designed',
      scores: { layout: 4, typography: 5, color: 3, differentiation: 4, sellability: 5 },
      briefId: 'brief-001',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = ProductSchema.safeParse(validProduct);
    expect(result.success).toBe(true);
  });

  it('ProductBrief type accepts valid data', () => {
    const validBrief: ProductBrief = {
      id: 'brief-001',
      niche: 'Habit Tracker',
      targetAudience: 'Health-conscious millennials',
      pageCount: 12,
      sections: ['Cover', 'Monthly Overview', 'Weekly Tracker'],
      styleGuide: {
        primaryFont: 'Playfair Display',
        accentColor: '#4A90D9',
        palette: 'cool-blue',
        layout: 'minimal',
      },
      createdAt: new Date().toISOString(),
    };

    const result = ProductBriefSchema.safeParse(validBrief);
    expect(result.success).toBe(true);
  });

  it('Opportunity type accepts valid data', () => {
    const validOpportunity: Opportunity = {
      id: 'opp-001',
      niche: 'Meal Planner',
      avgPrice: 8.99,
      reviewCount: 150,
      competitionLevel: 'medium',
      trendScore: 0.85,
      keywords: ['meal planner', 'weekly meal prep', 'grocery list'],
      source: 'etsy-search',
      discoveredAt: new Date().toISOString(),
    };

    const result = OpportunitySchema.safeParse(validOpportunity);
    expect(result.success).toBe(true);
  });

  it('FeedbackRecord validates score ranges (1-5)', () => {
    const validFeedback: FeedbackRecord = {
      id: 'fb-001',
      productId: 'prod-001',
      layout: 4,
      typography: 5,
      color: 3,
      differentiation: 2,
      sellability: 4,
      issues: 'Minor spacing issue on page 3',
      source: 'design',
      decision: 'approve',
      createdAt: new Date().toISOString(),
    };

    const result = FeedbackRecordSchema.safeParse(validFeedback);
    expect(result.success).toBe(true);

    // Score out of range should fail
    const invalidFeedback = { ...validFeedback, layout: 0 };
    const invalidResult = FeedbackRecordSchema.safeParse(invalidFeedback);
    expect(invalidResult.success).toBe(false);

    const tooHighFeedback = { ...validFeedback, sellability: 6 };
    const tooHighResult = FeedbackRecordSchema.safeParse(tooHighFeedback);
    expect(tooHighResult.success).toBe(false);
  });
});
