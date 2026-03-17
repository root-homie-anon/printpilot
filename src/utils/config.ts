import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

const ConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    slug: z.string(),
    version: z.string(),
  }),
  pipeline: z.object({
    productsPerDay: z.number().int().positive(),
    marketingBufferDays: z.number().int().nonnegative(),
    pinterestDelayDays: z.number().int().nonnegative(),
    emailDelayDays: z.number().int().nonnegative(),
    blogDelayDays: z.number().int().nonnegative(),
  }),
  credentials: z.object({
    etsyOAuth: z.string(),
    pinterestOAuth: z.string(),
    bufferOAuth: z.string().optional(),
    emailProvider: z.string(),
    blogApi: z.string(),
  }),
  agents: z.object({
    designer: z.object({
      pageSize: z.enum(['A4', 'Letter']),
      exportDpi: z.number().int().positive(),
      referenceLibraryPath: z.string(),
    }),
    researcher: z.object({
      maxOpportunitiesPerRun: z.number().int().positive(),
      minReviewCount: z.number().int().nonnegative(),
      targetPriceRange: z.tuple([z.number(), z.number()]),
    }),
    marketing: z.object({
      pinsPerProduct: z.number().int().positive(),
      pinterestEnabled: z.boolean(),
      emailEnabled: z.boolean(),
      blogEnabled: z.boolean(),
    }),
  }),
  notifications: z.object({
    channel: z.string(),
    approvalRequired: z.boolean(),
    weeklyReviewDay: z.string(),
  }),
  dashboard: z.object({
    port: z.number().int().positive(),
  }),
  features: z.object({
    autoPublish: z.boolean(),
    autoSynthesize: z.boolean(),
    dashboardEnabled: z.boolean(),
    marketingEnabled: z.boolean(),
    pinterestDirect: z.boolean().optional().default(true),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cachedConfig: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const raw = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const validated = ConfigSchema.parse(parsed);
  cachedConfig = validated;
  return validated;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export default loadConfig;
