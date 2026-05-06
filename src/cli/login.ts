import { AUTH_BASE_URL, CLIENT_ID, USER_AGENT } from "../config.js";

interface DeviceAuthResponse {
  device_auth_id?: string;
  user_code?: string;
  verification_uri?: string;
  verification_url?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  code_verifier?: string;
}

interface PollResponse {
  authorization_code?: string;
  code?: string;
  code_verifier?: string;
  error?: string;
  error_description?: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

const REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

async function main(): Promise<void> {
  const device = await startDeviceAuth();
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri ?? device.verification_url;

  if (!device.device_auth_id || !device.user_code || !verificationUrl) {
    throw new Error(`Unexpected device auth response: ${JSON.stringify(device)}`);
  }

  console.error(`Open ${verificationUrl}`);
  console.error(`Code: ${device.user_code}`);

  const poll = await pollForCode(device);
  const authorizationCode = poll.authorization_code ?? poll.code;
  const codeVerifier = poll.code_verifier ?? device.code_verifier;

  if (!authorizationCode || !codeVerifier) {
    throw new Error(`Unexpected device token response: ${JSON.stringify(poll)}`);
  }

  const token = await exchangeAuthorizationCode(authorizationCode, codeVerifier);
  if (!token.access_token || !token.refresh_token) {
    throw new Error(`Unexpected OAuth token response: ${JSON.stringify(token)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = token.expires_at ?? (token.expires_in ? now + token.expires_in : undefined);

  console.log(JSON.stringify({
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: expiresAt
  }, null, 2));
}

async function startDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify({ client_id: CLIENT_ID })
  });

  const data = await response.json() as DeviceAuthResponse;
  if (!response.ok) {
    throw new Error(`Device auth failed with status ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function pollForCode(device: DeviceAuthResponse): Promise<PollResponse> {
  const intervalMs = Math.max(device.interval ?? 5, 1) * 1000;
  const deadline = Date.now() + Math.max(device.expires_in ?? 900, 60) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const response = await fetch(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code
      })
    });

    const data = await response.json() as PollResponse;
    if (response.ok && (data.authorization_code || data.code)) {
      return data;
    }

    if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") {
      throw new Error(`Device auth polling failed: ${data.error_description ?? data.error}`);
    }
  }

  throw new Error("Timed out waiting for device authorization");
}

async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier
  });

  const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT
    },
    body
  });

  const data = await response.json() as OAuthTokenResponse;
  if (!response.ok) {
    throw new Error(`OAuth exchange failed with status ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
