import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'ETSY_API_KEY',
  'ETSY_API_SECRET',
  'ETSY_SHOP_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;

const OPTIONAL_VARS = [
  'PINTEREST_ACCESS_TOKEN',
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_LIST_ID',
  'BLOG_API_URL',
  'BLOG_API_KEY',
  'DASHBOARD_PORT',
  'DASHBOARD_SECRET',
  'LOG_LEVEL',
] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number];
type OptionalVar = (typeof OPTIONAL_VARS)[number];
type EnvVar = RequiredVar | OptionalVar;

class EnvError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(', ')}`);
    this.name = 'EnvError';
  }
}

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new EnvError([...missing]);
  }
}

export function getEnv(key: RequiredVar): string;
export function getEnv(key: OptionalVar): string | undefined;
export function getEnv(key: EnvVar): string | undefined {
  return process.env[key];
}

export function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new EnvError([key]);
  }
  return value;
}

export function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

export default getEnv;
