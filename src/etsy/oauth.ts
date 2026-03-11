import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import logger from '../utils/logger.js';
import type { TokenPair } from './types.js';

const ETSY_AUTH_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export class EtsyOAuth {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly redirectUri: string;
  private readonly credentialsPath: string;

  constructor(
    apiKey: string,
    apiSecret: string,
    redirectUri: string,
    credentialsPath?: string
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.redirectUri = redirectUri;
    this.credentialsPath = credentialsPath
      ?? resolve(process.cwd(), '.credentials/etsy-oauth.json');
  }

  getAuthUrl(scopes: string[] = ['listings_r', 'listings_w', 'transactions_r']): string {
    const state = crypto.randomUUID();
    const codeChallenge = crypto.randomUUID().replace(/-/g, '');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.apiKey,
      redirect_uri: this.redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    logger.info('Generated Etsy OAuth authorization URL');
    return `${ETSY_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<TokenPair> {
    logger.info('Exchanging authorization code for tokens');

    const response = await fetch(ETSY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.apiKey,
        redirect_uri: this.redirectUri,
        code,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to exchange code: ${response.status} - ${body}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const tokens = mapTokenResponse(data);

    await this.saveTokens(tokens);
    logger.info('Successfully exchanged code and saved tokens');

    return tokens;
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenPair> {
    logger.info('Refreshing Etsy access token');

    const response = await fetch(ETSY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.apiKey,
        refresh_token: refreshTokenValue,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} - ${body}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const tokens = mapTokenResponse(data);

    await this.saveTokens(tokens);
    logger.info('Successfully refreshed and saved tokens');

    return tokens;
  }

  async loadTokens(): Promise<TokenPair> {
    logger.debug('Loading Etsy OAuth tokens from disk');

    const raw = await readFile(this.credentialsPath, 'utf-8');
    const tokens = JSON.parse(raw) as TokenPair;

    if (this.isTokenExpired(tokens)) {
      logger.info('Access token expired, auto-refreshing');
      return this.refreshToken(tokens.refreshToken);
    }

    return tokens;
  }

  async saveTokens(tokens: TokenPair): Promise<void> {
    const dir = dirname(this.credentialsPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.credentialsPath, JSON.stringify(tokens, null, 2), 'utf-8');
    logger.debug('Saved Etsy OAuth tokens to disk');
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = await this.loadTokens();
    return tokens.accessToken;
  }

  private isTokenExpired(tokens: TokenPair): boolean {
    return Date.now() >= tokens.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
  }
}

// ── Internal types ──────────────────────────────────────────────────

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

function mapTokenResponse(data: OAuthTokenResponse): TokenPair {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
