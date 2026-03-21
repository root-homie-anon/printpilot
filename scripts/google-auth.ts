import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const CLIENT_PATH = resolve(process.cwd(), '.credentials/google-oauth-client.json');
const TOKEN_PATH = resolve(process.cwd(), '.credentials/google-oauth-token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

async function main(): Promise<void> {
  const clientJson = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8'));
  const { client_id, client_secret } = clientJson.installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3456',
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n=== Google OAuth2 Authorization ===');
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...\n');

  const code = await new Promise<string>((resolveCode) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost:3456');
      const authCode = url.searchParams.get('code');
      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
        server.close();
        resolveCode(authCode);
      } else {
        res.writeHead(400);
        res.end('No code received');
      }
    });
    server.listen(3456);
  });

  const { tokens } = await oauth2Client.getToken(code);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token saved to', TOKEN_PATH);
  console.log('Refresh token:', tokens.refresh_token ? 'YES' : 'NO');
}

main().catch(console.error);
