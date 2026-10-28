interface Env {
  GOOGLE_CLIENT_ID: string;
  APPROVED_EMAILS: string;
  SESSION_SECRET: string;

  // Google Sheets OAuth — configure these on Preview
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_TAB: string;
  OAUTH_TOKEN_STORE: KVNamespace;
}

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string;
  exp?: string;
  iss?: string;
}

interface SessionPayload {
  email: string;
  googleId: string;
  exp: number;
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    (char) => char.charCodeAt(0),
  );
}

async function hmac(
  value: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value),
    ),
  );
}

function isApprovedEmail(email: string, env: Env): boolean {
  if (!env.APPROVED_EMAILS) return false;

  const approved = env.APPROVED_EMAILS
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return approved.includes(email.trim().toLowerCase());
}

async function createSessionToken(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const signature = base64UrlEncode(
    await hmac(encoded, secret),
  );

  return `${encoded}.${signature}`;
}

async function readSession(
  request: Request,
  env: Env,
): Promise<SessionPayload | null> {
  try {
    if (
      !env.SESSION_SECRET ||
      env.SESSION_SECRET.length < 32 ||
      !env.APPROVED_EMAILS
    ) {
      return null;
    }

    const cookieHeader = request.headers.get("Cookie") || "";

    const cookie = cookieHeader
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("m3_session="));

    if (!cookie) return null;

    const token = cookie.slice("m3_session=".length);
    const parts = token.split(".");

    if (parts.length !== 2) return null;

    const [encoded, suppliedSignature] = parts;

    if (!encoded || !suppliedSignature) return null;

    const expectedSignature = base64UrlEncode(
      await hmac(encoded, env.SESSION_SECRET),
    );

    if (suppliedSignature.length !== expectedSignature.length) {
      return null;
    }

    let difference = 0;

    for (let i = 0; i < expectedSignature.length; i++) {
      difference |=
        suppliedSignature.charCodeAt(i) ^
        expectedSignature.charCodeAt(i);
    }

    if (difference !== 0) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as SessionPayload;

    if (
      typeof payload.email !== "string" ||
      typeof payload.googleId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      !isApprovedEmail(payload.email, env)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

interface GoogleOAuthState {
  email: string;
  nonce: string;
  exp: number;
}

interface GoogleOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

function getCookie(
  request: Request,
  name: string,
): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";

  const cookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  return cookie ? cookie.slice(name.length + 1) : null;
}

async function createOAuthState(
  email: string,
  secret: string,
): Promise<{ state: string; nonce: string }> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = base64UrlEncode(nonceBytes);

  const payload: GoogleOAuthState = {
    email,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  };

  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const signature = base64UrlEncode(
    await hmac(encoded, secret),
  );

  return {
    state: `${encoded}.${signature}`,
    nonce,
  };
}

async function verifyOAuthState(
  state: string,
  secret: string,
): Promise<GoogleOAuthState | null> {
  try {
    const parts = state.split(".");
    if (parts.length !== 2) return null;

    const [encoded, suppliedSignature] = parts;
    if (!encoded || !suppliedSignature) return null;

    const expectedSignature = base64UrlEncode(
      await hmac(encoded, secret),
    );

    if (suppliedSignature.length !== expectedSignature.length) {
      return null;
    }

    let difference = 0;

    for (let i = 0; i < expectedSignature.length; i++) {
      difference |=
        suppliedSignature.charCodeAt(i) ^
        expectedSignature.charCodeAt(i);
    }

    if (difference !== 0) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as GoogleOAuthState;

    if (
      typeof payload.email !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function encryptToken(
  plaintext: string,
  encodedKey: string,
): Promise<string> {
  const rawKey = base64UrlDecode(encodedKey);

  if (rawKey.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return `${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(ciphertext),
  )}`;
}

async function decryptToken(
  encrypted: string,
  encodedKey: string,
): Promise<string> {
  const parts = encrypted.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted token format");
  }

  const [encodedIv, encodedCiphertext] = parts;
  if (!encodedIv || !encodedCiphertext) {
    throw new Error("Encrypted token is incomplete");
  }

  const rawKey = base64UrlDecode(encodedKey);

  if (rawKey.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(encodedIv),
    },
    key,
    base64UrlDecode(encodedCiphertext),
  );

  return new TextDecoder().decode(plaintext);
}



interface TripConfig {
  id: string;
  name: string;
  sheetId: string;
  itineraryTab: string;
  createdAt?: string;
}

const TRIP_REGISTRY_KEY = "trip-registry:shared:v1";
const EXPENSE_HEADERS = ["expense_id", "date", "description", "category", "amount", "currency", "paid_by", "expense_type", "notes", "created_at"];
const CHECKLIST_HEADERS = ["item_id", "category", "item", "ralph_status", "june_status"];

async function getTripRegistry(env: Env): Promise<TripConfig[]> {
  const saved = await env.OAUTH_TOKEN_STORE.get(TRIP_REGISTRY_KEY);
  let trips: TripConfig[] = [];
  if (saved) {
    try { trips = JSON.parse(saved) as TripConfig[]; } catch { trips = []; }
  }
  if (!trips.some((trip) => trip.id === "nz-south-island") && env.GOOGLE_SHEET_ID) {
    trips.unshift({ id: "nz-south-island", name: "New Zealand — South Island", sheetId: env.GOOGLE_SHEET_ID, itineraryTab: env.GOOGLE_SHEET_TAB || "FINAL ITINERARY" });
  }
  return trips;
}

async function resolveTrip(request: Request, env: Env, bodyTripId?: string): Promise<TripConfig | null> {
  const url = new URL(request.url);
  const tripId = (url.searchParams.get("tripId") || bodyTripId || "nz-south-island").trim();
  const trips = await getTripRegistry(env);
  return trips.find((trip) => trip.id === tripId) || null;
}

async function googleAccessToken(session: SessionPayload, env: Env): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.OAUTH_TOKEN_STORE) {
    throw new Error("Google Sheets is not configured.");
  }
  const encrypted = await env.OAUTH_TOKEN_STORE.get(`google-refresh:${session.email.toLowerCase()}`);
  if (!encrypted) throw new Error("Google Sheets is not connected. Reconnect Google Sheets.");
  const refreshToken = await decryptToken(encrypted, env.TOKEN_ENCRYPTION_KEY);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
  });
  if (!response.ok) throw new Error("Google access failed. Reconnect Google Sheets.");
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Google returned no access token.");
  return data.access_token;
}

function quoteSheetTab(tab: string): string { return `'${tab.replace(/'/g, "''")}'`; }
function sheetsValuesUrl(sheetId: string, range: string): string {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
}

async function ensureSheetTab(accessToken: string, sheetId: string, tabName: string, headers: string[]): Promise<void> {
  const metadataResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title))`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!metadataResponse.ok) throw new Error("Could not inspect the selected Google Sheet. Check access and the spreadsheet ID.");
  const metadata = await metadataResponse.json() as { sheets?: Array<{ properties?: { title?: string } }> };
  const exists = (metadata.sheets || []).some((sheet) => sheet.properties?.title === tabName);
  if (!exists) {
    const addResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
    });
    if (!addResponse.ok) throw new Error(`Could not create the ${tabName} tab in Google Sheets.`);
  }
  const range = `${quoteSheetTab(tabName)}!A1:${String.fromCharCode(64 + headers.length)}1`;
  const readResponse = await fetch(sheetsValuesUrl(sheetId, range), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!readResponse.ok) throw new Error(`Could not read the ${tabName} tab.`);
  const existing = await readResponse.json() as { values?: unknown[][] };
  if (!existing.values?.[0]?.some((cell) => String(cell ?? "").trim())) {
    const writeResponse = await fetch(`${sheetsValuesUrl(sheetId, range)}?valueInputOption=RAW`, {
      method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [headers] }),
    });
    if (!writeResponse.ok) throw new Error(`Could not initialise the ${tabName} headers.`);
  }
}

async function findExistingTab(accessToken: string, sheetId: string, candidates: string[], fallback: string): Promise<string> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title))`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return fallback;
  const data = await response.json() as { sheets?: Array<{ properties?: { title?: string } }> };
  const names = (data.sheets || []).map((sheet) => sheet.properties?.title || "");
  return candidates.find((candidate) => names.includes(candidate)) || fallback;
}

async function readSheetRows(accessToken: string, sheetId: string, tabName: string): Promise<string[][]> {
  const response = await fetch(sheetsValuesUrl(sheetId, `${quoteSheetTab(tabName)}!A:Z`), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Could not read the ${tabName} tab. Check the tab name and Google Sheets access.`);
  const data = await response.json() as { values?: unknown[][] };
  return (data.values || []).map((row) => row.map((cell) => String(cell ?? "")));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (
      request.method === "GET" &&
      url.pathname === "/api/health"
    ) {
      return jsonResponse({
        success: true,
        service: "campervan-auth-test",
      });
    }

    // Google ID token verification and session creation
    if (
      url.pathname === "/api/auth/google" &&
      request.method === "POST"
    ) {
      if (!env.GOOGLE_CLIENT_ID) {
        return jsonResponse(
          { error: "Google Client ID is not configured" },
          500,
        );
      }

      if (!env.APPROVED_EMAILS) {
        return jsonResponse(
          { error: "Preview diagnostic: APPROVED_EMAILS missing" },
          500,
        );
      }

      if (!env.SESSION_SECRET) {
        return jsonResponse(
          { error: "Preview diagnostic: SESSION_SECRET missing" },
          500,
        );
      }

      if (env.SESSION_SECRET.length < 32) {
        return jsonResponse(
          { error: "Preview diagnostic: SESSION_SECRET too short" },
          500,
        );
      }

      let body: { credential?: unknown };

      try {
        body = await request.json() as { credential?: unknown };
      } catch {
        return jsonResponse(
          { error: "Invalid JSON body" },
          400,
        );
      }

      if (
        typeof body.credential !== "string" ||
        body.credential.length < 20 ||
        body.credential.length > 10000
      ) {
        return jsonResponse(
          { error: "Google ID token required" },
          401,
        );
      }

      let tokenResponse: Response;

      try {
        tokenResponse = await fetch(
          "https://oauth2.googleapis.com/tokeninfo?id_token=" +
            encodeURIComponent(body.credential),
        );
      } catch {
        return jsonResponse(
          { error: "Token verification unavailable" },
          502,
        );
      }

      if (!tokenResponse.ok) {
        return jsonResponse(
          { error: "Invalid or expired Google ID token" },
          401,
        );
      }

      let token: GoogleTokenInfo;

      try {
        token = await tokenResponse.json() as GoogleTokenInfo;
      } catch {
        return jsonResponse(
          { error: "Invalid token response" },
          502,
        );
      }

      const validIssuer =
        token.iss === "accounts.google.com" ||
        token.iss === "https://accounts.google.com";

      const expiresAt = Number(token.exp);

      if (
        token.aud !== env.GOOGLE_CLIENT_ID ||
        !token.sub ||
        !token.email ||
        token.email_verified !== "true" ||
        !validIssuer ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Math.floor(Date.now() / 1000)
      ) {
        return jsonResponse(
          { error: "Google identity validation failed" },
          401,
        );
      }

      const email = token.email.trim().toLowerCase();
      console.log("Trip access diagnostic:", {
        approvedEmailsConfigured: Boolean(env.APPROVED_EMAILS),
        approvedEmailCount: env.APPROVED_EMAILS
         ? env.APPROVED_EMAILS.split(",").filter((item) => item.trim()).length
         : 0,
        verifiedEmailMatches: isApprovedEmail(email, env),
      });

      if (!isApprovedEmail(email, env)) {
        return jsonResponse(
          {
            success: false,
            error: "This Google account is not approved for trip access.",
          },
          403,
        );
      }

      try {
        const sessionToken = await createSessionToken(
          {
            email,
            googleId: token.sub,
            exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
          },
          env.SESSION_SECRET,
        );

        const response = jsonResponse({
          success: true,
          user: {
            googleId: token.sub,
            email,
          },
          message: "Google identity verified. Trip access granted.",
        });

        response.headers.append(
          "Set-Cookie",
          `m3_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
        );

        return response;
      } catch {
        return jsonResponse(
          { error: "Failed to create authenticated session" },
          500,
        );
      }
    }

    // Check whether the current browser has a valid session
    if (
      url.pathname === "/api/auth/session" &&
      request.method === "GET"
    ) {
      const session = await readSession(request, env);

      if (!session) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required",
          },
          401,
        );
      }

      return jsonResponse({
        success: true,
        user: {
          email: session.email,
          googleId: session.googleId,
        },
      });
    }
    
    // Start Google Sheets OAuth authorization
    if (
      url.pathname === "/api/sheets/connect" &&
      request.method === "GET"
    ) {
      const session = await readSession(request, env);

      if (!session) {
        return jsonResponse(
          { success: false, error: "Authentication required" },
          401,
        );
      }

      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.SESSION_SECRET ||
        !env.OAUTH_TOKEN_STORE ||
        !env.TOKEN_ENCRYPTION_KEY
      ) {
        return jsonResponse(
          { error: "Google Sheets OAuth is not fully configured" },
          500,
        );
      }

      try {
        const { state, nonce } = await createOAuthState(
          session.email,
          env.SESSION_SECRET,
        );

        await env.OAUTH_TOKEN_STORE.put(
          `oauth-state:${nonce}`,
          session.email,
          { expirationTtl: 600 },
        );

        const callbackUrl = `${url.origin}/api/sheets/callback`;
        const googleUrl = new URL(
          "https://accounts.google.com/o/oauth2/v2/auth",
        );

        googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
        googleUrl.searchParams.set("redirect_uri", callbackUrl);
        googleUrl.searchParams.set("response_type", "code");
        googleUrl.searchParams.set(
          "scope",
          "https://www.googleapis.com/auth/spreadsheets",
        );
        googleUrl.searchParams.set("access_type", "offline");
        googleUrl.searchParams.set("prompt", "consent");
        googleUrl.searchParams.set("state", state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: googleUrl.toString(),
            "Cache-Control": "no-store",
            "Set-Cookie":
              `m3_oauth_state=${nonce}; Path=/api/sheets/callback; ` +
              "HttpOnly; Secure; SameSite=Lax; Max-Age=600",
          },
        });
      } catch {
        return jsonResponse(
          { error: "Could not start Google Sheets authorization" },
          500,
        );
      }
    }

    // Complete Google Sheets OAuth authorization
    if (
      url.pathname === "/api/sheets/callback" &&
      request.method === "GET"
    ) {
      const session = await readSession(request, env);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      const nonceCookie = getCookie(request, "m3_oauth_state");

      const clearStateCookie =
        "m3_oauth_state=; Path=/api/sheets/callback; " +
        "HttpOnly; Secure; SameSite=Lax; Max-Age=0";

      if (oauthError) {
        return new Response(
          "Google Sheets authorization was cancelled or denied. You may return to the app and try again.",
          {
            status: 400,
            headers: {
              "Cache-Control": "no-store",
              "Set-Cookie": clearStateCookie,
            },
          },
        );
      }

      if (!session || !state || !code || !nonceCookie) {
        return new Response(
          "Authorization failed. Please sign in again and retry.",
          {
            status: 401,
            headers: {
              "Cache-Control": "no-store",
              "Set-Cookie": clearStateCookie,
            },
          },
        );
      }

      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.SESSION_SECRET ||
        !env.TOKEN_ENCRYPTION_KEY ||
        !env.OAUTH_TOKEN_STORE
      ) {
        return new Response("OAuth configuration is incomplete.", {
          status: 500,
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": clearStateCookie,
          },
        });
      }

      try {
        const verifiedState = await verifyOAuthState(
          state,
          env.SESSION_SECRET,
        );

        if (
          !verifiedState ||
          verifiedState.email !== session.email ||
          verifiedState.nonce !== nonceCookie
        ) {
          return new Response(
            "Invalid or expired authorization state. Please retry.",
            {
              status: 400,
              headers: {
                "Cache-Control": "no-store",
                "Set-Cookie": clearStateCookie,
              },
            },
          );
        }

        const stateKey = `oauth-state:${verifiedState.nonce}`;
        const storedEmail = await env.OAUTH_TOKEN_STORE.get(stateKey);

        if (
          !storedEmail ||
          storedEmail.toLowerCase() !== session.email.toLowerCase()
        ) {
          return new Response(
            "Authorization state has expired or already been used. Please retry.",
            {
              status: 400,
              headers: {
                "Cache-Control": "no-store",
                "Set-Cookie": clearStateCookie,
              },
            },
          );
        }

        // Consume the state record before exchanging the authorization code.
        await env.OAUTH_TOKEN_STORE.delete(stateKey);

        const callbackUrl = `${url.origin}/api/sheets/callback`;
        const form = new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: callbackUrl,
          grant_type: "authorization_code",
        });

        const tokenResponse = await fetch(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
        );

        if (!tokenResponse.ok) {
          return new Response(
            "Google could not complete authorization. Please retry.",
            {
              status: 502,
              headers: {
                "Cache-Control": "no-store",
                "Set-Cookie": clearStateCookie,
              },
            },
          );
        }

        const tokens =
          (await tokenResponse.json()) as GoogleOAuthTokenResponse;

        if (!tokens.refresh_token) {
          return new Response(
            "Google did not return a refresh token. Revoke this app's access in your Google Account and try connecting again.",
            {
              status: 400,
              headers: {
                "Cache-Control": "no-store",
                "Set-Cookie": clearStateCookie,
              },
            },
          );
        }

        const encryptedToken = await encryptToken(
          tokens.refresh_token,
          env.TOKEN_ENCRYPTION_KEY,
        );

        await env.OAUTH_TOKEN_STORE.put(
          `google-refresh:${session.email.toLowerCase()}`,
          encryptedToken,
        );

        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/?sheets=connected`,
            "Cache-Control": "no-store",
            "Set-Cookie": clearStateCookie,
          },
        });
      } catch {
        return new Response(
          "An unexpected error occurred during Google authorization.",
          {
            status: 500,
            headers: {
              "Cache-Control": "no-store",
              "Set-Cookie": clearStateCookie,
            },
          },
        );
      }
    }

    

    // Shared trip registry. A trip stores its own spreadsheet destination.
    if (url.pathname === "/api/trips" && (request.method === "GET" || request.method === "POST")) {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return jsonResponse({ success: false, error: "Invalid request origin." }, 403);
      try {
        const trips = await getTripRegistry(env);
        if (request.method === "GET") return jsonResponse({ success: true, trips: trips.map(({ id, name, itineraryTab }) => ({ id, name, itineraryTab })) });
        const body = await request.json() as { name?: unknown; sheetId?: unknown; itineraryTab?: unknown };
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const sheetId = typeof body.sheetId === "string" ? body.sheetId.trim() : "";
        const itineraryTab = typeof body.itineraryTab === "string" && body.itineraryTab.trim() ? body.itineraryTab.trim() : "FINAL ITINERARY";
        if (name.length < 2 || name.length > 100 || !/^[A-Za-z0-9_-]{20,}$/.test(sheetId) || itineraryTab.length > 100) return jsonResponse({ success: false, error: "Enter a trip name and a valid Google Sheets spreadsheet ID." }, 400);
        const accessToken = await googleAccessToken(session, env);
        const check = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=spreadsheetId,properties(title),sheets(properties(title))`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!check.ok) return jsonResponse({ success: false, error: "This Google Sheet could not be opened. Check its ID and share it with the signed-in Google account." }, 400);
        const metadata = await check.json() as { spreadsheetId?: string; properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> };
        if (!(metadata.sheets || []).some((sheet) => sheet.properties?.title === itineraryTab)) return jsonResponse({ success: false, error: `The sheet does not contain a tab named “${itineraryTab}”.` }, 400);
        if (trips.some((trip) => trip.sheetId === sheetId)) return jsonResponse({ success: false, error: "This Google Sheet is already registered as a trip." }, 409);
        const baseId = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "trip";
        let id = baseId; let suffix = 2;
        while (trips.some((trip) => trip.id === id)) id = `${baseId}-${suffix++}`;
        const trip: TripConfig = { id, name, sheetId, itineraryTab, createdAt: new Date().toISOString() };
        trips.push(trip);
        await env.OAUTH_TOKEN_STORE.put(TRIP_REGISTRY_KEY, JSON.stringify(trips));
        return jsonResponse({ success: true, trip: { id: trip.id, name: trip.name, itineraryTab: trip.itineraryTab } }, 201);
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not manage trips." }, 500); }
    }

    // Shared trip expenses stored in the selected trip spreadsheet.
    if (url.pathname === "/api/expenses" && (request.method === "GET" || request.method === "POST")) {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return jsonResponse({ success: false, error: "Invalid request origin." }, 403);
      try {
        let body: Record<string, unknown> = {};
        if (request.method === "POST") body = await request.json() as Record<string, unknown>;
        const trip = await resolveTrip(request, env, typeof body.tripId === "string" ? body.tripId : undefined);
        if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
        const token = await googleAccessToken(session, env);
        const tab = "TRIP EXPENSES";
        await ensureSheetTab(token, trip.sheetId, tab, EXPENSE_HEADERS);
        const rows = await readSheetRows(token, trip.sheetId, tab);
        if (request.method === "GET") {
          const header = (rows[0] || []).map((cell) => cell.trim().toLowerCase());
          const idx = (name: string) => header.indexOf(name);
          const expenses = rows.slice(1).filter((row) => row[idx("expense_id")]?.trim()).map((row) => ({
            expense_id: row[idx("expense_id")] || "", date: row[idx("date")] || "", description: row[idx("description")] || "", category: row[idx("category")] || "Other",
            amount: Number(row[idx("amount")] || 0), currency: row[idx("currency")] || "NZD", paid_by: row[idx("paid_by")] || "Ralph", expense_type: row[idx("expense_type")] || "actual-trip", notes: row[idx("notes")] || "",
          }));
          return jsonResponse({ success: true, expenses, tripId: trip.id });
        }
        const expenseId = typeof body.expense_id === "string" ? body.expense_id.trim() : "";
        const date = typeof body.date === "string" ? body.date.trim() : "";
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const category = typeof body.category === "string" ? body.category.trim() : "Other";
        const amount = Number(body.amount);
        const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "NZD";
        const paidBy = typeof body.paid_by === "string" ? body.paid_by.trim() : "";
        const expenseType = body.expense_type;
        const notes = typeof body.notes === "string" ? body.notes.trim() : "";
        if (!expenseId || expenseId.length > 100 || !date || !description || description.length > 250 || !Number.isFinite(amount) || amount <= 0 || !["pre-trip", "actual-trip"].includes(String(expenseType)) || !["Ralph", "June"].includes(paidBy) || !/^[A-Z]{3}$/.test(currency) || category.length > 100 || notes.length > 2000) return jsonResponse({ success: false, error: "Invalid expense details." }, 400);
        if (rows.slice(1).some((row) => row[0] === expenseId)) return jsonResponse({ success: true, duplicate: true, message: "Expense already saved." });
        const appendUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
        const append = await fetch(appendUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[expenseId, date, description, category, amount, currency, paidBy, expenseType, notes, new Date().toISOString()]] }) });
        if (!append.ok) return jsonResponse({ success: false, error: "Could not save the expense to Google Sheets." }, 502);
        return jsonResponse({ success: true, message: "Expense saved.", tripId: trip.id }, 201);
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not access trip expenses." }, 500); }
    }

    // Checklist keeps separate status cells for Ralph and June; a write only touches the signed-in person's cell.
    if (url.pathname === "/api/checklist" && (request.method === "GET" || request.method === "POST")) {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return jsonResponse({ success: false, error: "Invalid request origin." }, 403);
      try {
        let body: Record<string, unknown> = {};
        if (request.method === "POST") body = await request.json() as Record<string, unknown>;
        const trip = await resolveTrip(request, env, typeof body.tripId === "string" ? body.tripId : undefined);
        if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
        const token = await googleAccessToken(session, env);
        const tab = await findExistingTab(token, trip.sheetId, ["Things to do n bring", "Thing to do n bring", "Things to do & bring", "Thing to do & bring", "THINGS TO DO N BRING", "THINGS TO DO & BRING"], "Things to do n bring");
        await ensureSheetTab(token, trip.sheetId, tab, CHECKLIST_HEADERS);
        const rows = await readSheetRows(token, trip.sheetId, tab);
        const headers = (rows[0] || []).map((cell) => cell.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
        const col = (...names: string[]) => headers.findIndex((header) => names.some((name) => header === name.toLowerCase().replace(/[^a-z0-9]/g, "")));
        const idCol = col("item_id", "itemid", "id", "checklist_id"), categoryCol = col("category", "group"), itemCol = col("item", "task", "description", "checklist_item"), ralphCol = col("ralph_status", "ralph", "ralph_checkbox"), juneCol = col("june_status", "june", "june_checkbox");
        if ([idCol, categoryCol, itemCol, ralphCol, juneCol].some((value) => value < 0)) return jsonResponse({ success: false, error: "Checklist tab must have item ID, category, item, Ralph status and June status columns. Recommended headers: item_id, category, item, ralph_status, june_status." }, 409);
        if (request.method === "GET") {
          const checklistItems = rows.slice(1).filter((row) => row[idCol]?.trim() && row[itemCol]?.trim()).map((row) => ({ item_id: row[idCol], category: row[categoryCol] || "Other", item: row[itemCol], ralph_status: row[ralphCol] || "", june_status: row[juneCol] || "" }));
          return jsonResponse({ success: true, checklistItems, tripId: trip.id });
        }
        const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
        const status = typeof body.status === "string" ? body.status : "";
        if (!itemId || itemId.length > 150 || !["", "✓", "x"].includes(status)) return jsonResponse({ success: false, error: "Invalid checklist status." }, 400);
        const statusCol = session.email.toLowerCase() === "koochanyee@gmail.com" ? ralphCol : session.email.toLowerCase() === "wookahwai@gmail.com" ? juneCol : -1;
        if (statusCol < 0) return jsonResponse({ success: false, error: "This account is not assigned a checklist profile." }, 403);
        const matches: number[] = [];
        rows.slice(1).forEach((row, index) => { if (row[idCol] === itemId) matches.push(index + 2); });
        if (matches.length !== 1) return jsonResponse({ success: false, error: matches.length ? "Duplicate checklist item IDs found." : "Checklist item not found." }, 409);
        let column = ""; let n = statusCol + 1;
        while (n > 0) { const rem = (n - 1) % 26; column = String.fromCharCode(65 + rem) + column; n = Math.floor((n - 1) / 26); }
        const writeUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!${column}${matches[0]}`)}?valueInputOption=RAW`;
        const write = await fetch(writeUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[status]] }) });
        if (!write.ok) return jsonResponse({ success: false, error: "Could not sync checklist status to Google Sheets." }, 502);
        return jsonResponse({ success: true, item_id: itemId, status, tripId: trip.id });
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not access the shared checklist." }, 500); }
    }

    // Read the signed-in user's Google Sheets itinerary.
    if (request.method === "GET" && url.pathname === "/api/itinerary") {
      const session = await readSession(request, env);
      const trip = await resolveTrip(request, env);
      if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
      const activeSheetId = trip.sheetId;
      const activeItineraryTab = trip.itineraryTab;

      if (!session) {
        return jsonResponse(
          { success: false, error: "Authentication required." },
          401,
        );
      }

      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.TOKEN_ENCRYPTION_KEY ||
        !activeSheetId ||
        !activeItineraryTab ||
        !env.OAUTH_TOKEN_STORE
      ) {
        return jsonResponse(
          { success: false, error: "Itinerary service is not configured." },
          500,
        );
      }

      try {
        const tokenKey =
          `google-refresh:${session.email.toLowerCase()}`;

        const encryptedRefreshToken =
          await env.OAUTH_TOKEN_STORE.get(tokenKey);

        if (!encryptedRefreshToken) {
          return jsonResponse(
            {
              success: false,
              error: "Google Sheets is not connected.",
              connectUrl: "/api/sheets/connect",
            },
            403,
          );
        }

        const refreshToken = await decryptToken(
          encryptedRefreshToken,
          env.TOKEN_ENCRYPTION_KEY,
        );

        const tokenResponse = await fetch(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }).toString(),
          },
        );

        if (!tokenResponse.ok) {
          return jsonResponse(
            {
              success: false,
              error: "Could not refresh Google access. Please reconnect Google Sheets.",
              connectUrl: "/api/sheets/connect",
            },
            502,
          );
        }

        const tokenData = (await tokenResponse.json()) as {
          access_token?: string;
        };

        if (!tokenData.access_token) {
          return jsonResponse(
            { success: false, error: "Google returned no access token." },
            502,
          );
        }

        const range =
          `'${activeItineraryTab.replace(/'/g, "''")}'!A:ZZZ`;

        const sheetUrl =
          `https://sheets.googleapis.com/v4/spreadsheets/` +
          `${encodeURIComponent(activeSheetId)}/values/` +
          `${encodeURIComponent(range)}`;

        const sheetResponse = await fetch(sheetUrl, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        if (!sheetResponse.ok) {
          return jsonResponse(
            {
              success: false,
              error: "Could not read the Google Sheet. Check the sheet permissions and configuration.",
            },
            502,
          );
        }

        const sheetData = (await sheetResponse.json()) as {
          values?: unknown[][];
        };

        const rows = sheetData.values ?? [];

        if (rows.length === 0) {
          return jsonResponse(
            { success: true, data: [], count: 0 },
            200,
          );
        }

        const rawHeaders = rows[0].map((value) =>
          String(value ?? "").trim(),
        );

        const headers: string[] = [];

        rawHeaders.forEach((header, index) => {
          const base = header || `column_${index + 1}`;
          let key = base;
          let suffix = 2;

          while (headers.includes(key)) {
            key = `${base}_${suffix++}`;
          }

          headers.push(key);
        });

        const data = rows.slice(1)
          .filter((row) =>
            row.some((value) => String(value ?? "").trim() !== ""),
          )
          .map((row) => {
            const item: Record<string, string> = {};

            headers.forEach((header, index) => {
              item[header] = String(row[index] ?? "");
            });

            return item;
          });
        
        // Read supplementary worksheet tabs for practical tips and layering notes.
        const supplementaryTabs: Record<string, string[][]> = {};
        let supplementaryError: string | undefined;

        try {
          const metadataUrl =
            `https://sheets.googleapis.com/v4/spreadsheets/` +
            `${encodeURIComponent(activeSheetId)}` +
            `?fields=sheets(properties(title))`;

          const metadataResponse = await fetch(metadataUrl, {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
            },
          });

          if (!metadataResponse.ok) {
            throw new Error("Could not read worksheet metadata");
          }

          const spreadsheetMeta = (await metadataResponse.json()) as {
            sheets?: Array<{
              properties?: {
                title?: string;
              };
            }>;
          };

          const mainTab = env.GOOGLE_SHEET_TAB.trim();

          const tabTitles = (spreadsheetMeta.sheets ?? [])
            .map((sheet) => sheet.properties?.title)
            .filter(
              (title): title is string =>
                Boolean(title) && title !== mainTab,
            );

          if (tabTitles.length > 0) {
            const batchUrl = new URL(
              `https://sheets.googleapis.com/v4/spreadsheets/` +
              `${encodeURIComponent(activeSheetId)}/values:batchGet`,
            );

            tabTitles.forEach((title) => {
              const range =
                `'${title.replace(/'/g, "''")}'!A:ZZZ`;
              batchUrl.searchParams.append("ranges", range);
            });

            const batchResponse = await fetch(batchUrl.toString(), {
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
              },
            });

            if (!batchResponse.ok) {
              throw new Error("Could not read supplementary worksheets");
            }

            const batchData = (await batchResponse.json()) as {
              valueRanges?: Array<{
                values?: unknown[][];
              }>;
            };

            tabTitles.forEach((title, index) => {
              const values =
                batchData.valueRanges?.[index]?.values ?? [];

              supplementaryTabs[title] = values.map((row) =>
                row.map((value) => String(value ?? "")),
              );
            });
          }
        } catch (error) {
          console.error(
            "Supplementary worksheet read failed:",
            error instanceof Error ? error.message : String(error),
          );
          supplementaryError =
            "Some supplementary worksheet details could not be loaded.";
        }

        return jsonResponse(
          {
            success: true,
            data,
            count: data.length,
            supplementaryTabs,
            ...(supplementaryError ? { supplementaryError } : {}),
          },
          200,
        );

      } catch (error) {
        console.error(
         "Itinerary read failed:",
         error instanceof Error ? error.message : String(error),
       );

       return jsonResponse(
          {
            success: false,
            error: "An unexpected error occurred while reading the itinerary.",
          },
          500,
        );
      }
    }

    
    // Save a confirmed session location to SESSION LOCATIONS only.
    if (
      request.method === "POST" &&
      url.pathname === "/api/session-location"
    ) {
      const session = await readSession(request, env);
      const trip = await resolveTrip(request, env);
      if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);

      if (!session) {
        return jsonResponse(
          { success: false, error: "Authentication required." },
          401,
        );
      }

      // Accept writes only from this same origin.
      if (request.headers.get("Origin") !== url.origin) {
        return jsonResponse(
          { success: false, error: "Invalid request origin." },
          403,
        );
      }

      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.TOKEN_ENCRYPTION_KEY ||
        !trip.sheetId ||
        !env.OAUTH_TOKEN_STORE
      ) {
        return jsonResponse(
          { success: false, error: "Google Sheets is not configured." },
          500,
        );
      }

      try {
        const body = (await request.json()) as {
          date?: unknown;
          session?: unknown;
          oldLocation?: unknown;
          newLocation?: unknown;
        };

        const date =
          typeof body.date === "string" ? body.date.trim() : "";
        const sessionName =
          typeof body.session === "string"
            ? body.session.trim()
            : "";
        const oldLocation =
          typeof body.oldLocation === "string"
            ? body.oldLocation.trim()
            : "";
        const newLocation =
          typeof body.newLocation === "string"
            ? body.newLocation.trim()
            : "";

        if (
          !date ||
          !sessionName ||
          !newLocation ||
          date.length > 40 ||
          sessionName.length > 40 ||
          oldLocation.length > 1000 ||
          newLocation.length > 1000 ||
          !["Morning", "Afternoon", "Evening"].includes(sessionName)
        ) {
          return jsonResponse(
            { success: false, error: "Invalid session location details." },
            400,
          );
        }

        const tokenKey =
          `google-refresh:${session.email.toLowerCase()}`;
        const encryptedRefreshToken =
          await env.OAUTH_TOKEN_STORE.get(tokenKey);

        if (!encryptedRefreshToken) {
          return jsonResponse(
            {
              success: false,
              error: "Google Sheets is not connected. Reconnect Google Sheets.",
              connectUrl: "/api/sheets/connect",
            },
            403,
          );
        }

        const refreshToken = await decryptToken(
          encryptedRefreshToken,
          env.TOKEN_ENCRYPTION_KEY,
        );

        const tokenResponse = await fetch(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }).toString(),
          },
        );

        if (!tokenResponse.ok) {
          return jsonResponse(
            {
              success: false,
              error: "Google access failed. Reconnect Google Sheets.",
              connectUrl: "/api/sheets/connect",
            },
            502,
          );
        }

        const tokenData = (await tokenResponse.json()) as {
          access_token?: string;
        };

        if (!tokenData.access_token) {
          return jsonResponse(
            { success: false, error: "Google returned no access token." },
            502,
          );
        }

        const sessionTab = await findExistingTab(tokenData.access_token, trip.sheetId, ["SESSION LOCATION", "SESSION LOCATIONS"], "SESSION LOCATION");
        const sheetId = encodeURIComponent(trip.sheetId);
        const readRange = `${quoteSheetTab(sessionTab)}!A:C`;
        const readUrl =
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
          encodeURIComponent(readRange);

        const readResponse = await fetch(readUrl, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        if (!readResponse.ok) {
          return jsonResponse(
            {
              success: false,
              error: "Could not read SESSION LOCATIONS. Check Google Sheets access.",
            },
            502,
          );
        }

        const sheetData = (await readResponse.json()) as {
          values?: unknown[][];
        };
        const rows = sheetData.values ?? [];

        if (rows.length === 0) {
          return jsonResponse(
            { success: false, error: "SESSION LOCATIONS is empty." },
            409,
          );
        }

        const headers = rows[0].map((value) =>
          String(value ?? "").trim().toLowerCase(),
        );
        const dateCol = headers.indexOf("date");
        const sessionCol = headers.indexOf("session");
        const locationCol = headers.indexOf("planned location");

        if (dateCol < 0 || sessionCol < 0 || locationCol < 0) {
          return jsonResponse(
            {
              success: false,
              error: "SESSION LOCATIONS must have Date, Session, and Planned location headers.",
            },
            409,
          );
        }

        const matches: Array<{ rowNumber: number; location: string }> = [];

        rows.slice(1).forEach((row, index) => {
          const rowDate = String(row[dateCol] ?? "").trim();
          const rowSession = String(row[sessionCol] ?? "").trim();

          if (rowDate === date && rowSession === sessionName) {
            matches.push({
              rowNumber: index + 2,
              location: String(row[locationCol] ?? "").trim(),
            });
          }
        });

        if (matches.length !== 1) {
          return jsonResponse(
            {
              success: false,
              error:
                matches.length === 0
                  ? "Session row not found. Refresh the itinerary and try again."
                  : "Duplicate date and session rows found. Please correct SESSION LOCATIONS first.",
            },
            409,
          );
        }

        const match = matches[0];

        // Prevent overwriting a change made by someone else.
        if (match.location !== oldLocation) {
          return jsonResponse(
            {
              success: false,
              error: "This location has changed since you opened it. Refresh and review the latest value.",
              currentLocation: match.location,
            },
            409,
          );
        }

        const columnLetter = (columnIndex: number): string => {
          let number = columnIndex + 1;
          let result = "";

          while (number > 0) {
            const remainder = (number - 1) % 26;
            result =
            String.fromCharCode(65 + remainder) + result;
            number = Math.floor((number - 1) / 26);
          }
          return result;
        };

        const writeRange =
          `${quoteSheetTab(sessionTab)}!${columnLetter(locationCol)}${match.rowNumber}`;
        const writeUrl =
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
          encodeURIComponent(writeRange) +
          "?valueInputOption=RAW";

        const writeResponse = await fetch(writeUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            values: [[newLocation]],
          }),
        });

        if (!writeResponse.ok) {
          const errorText = await writeResponse.text();
          console.error(
            "Session location save failed:",
            writeResponse.status,
            errorText.slice(0, 500),
          );

          return jsonResponse(
            {
              success: false,
              error:
                writeResponse.status === 403
                  ? "Google Sheets write permission is missing. Reconnect Google Sheets and grant the requested access."
                  : "Could not save the location. Your change was not confirmed.",
            },
            502,
          );
        }

        return jsonResponse(
          {
            success: true,
            message: "Session location saved.",
            date,
            session: sessionName,
            oldLocation,
            newLocation,
          },
          200,
        );
      } catch (error) {
        console.error(
          "Session location save failed:",
          error instanceof Error ? error.message : String(error),
        );

        return jsonResponse(
          { success: false, error: "Could not process the location update." },
          500,
        );
      }
    }

    
    // Shared Trip Memories: read and save records in TRIP_MEMORIES.
    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === "/api/memories"
    ) {
      const session = await readSession(request, env);
      const trip = await resolveTrip(request, env);
      if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);

      if (!session) {
        return jsonResponse(
          { success: false, error: "Authentication required." },
          401,
        );
      }

      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.TOKEN_ENCRYPTION_KEY ||
        !trip.sheetId ||
        !env.OAUTH_TOKEN_STORE
      ) {
        return jsonResponse(
          { success: false, error: "Google Sheets is not configured." },
          500,
        );
      }

      if (
        request.method === "POST" &&
        request.headers.get("Origin") !== url.origin
      ) {
        return jsonResponse(
          { success: false, error: "Invalid request origin." },
          403,
        );
      }

      try {
        const tokenKey =
          `google-refresh:${session.email.toLowerCase()}`;

        const encryptedRefreshToken =
          await env.OAUTH_TOKEN_STORE.get(tokenKey);

        if (!encryptedRefreshToken) {
          return jsonResponse(
            {
              success: false,
              error: "Google Sheets is not connected. Reconnect Google Sheets.",
              connectUrl: "/api/sheets/connect",
            },
            403,
          );
        }

        const refreshToken = await decryptToken(
          encryptedRefreshToken,
          env.TOKEN_ENCRYPTION_KEY,
        );

        const tokenResponse = await fetch(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }).toString(),
          },
        );

        if (!tokenResponse.ok) {
          return jsonResponse(
            {
              success: false,
              error: "Google access failed. Reconnect Google Sheets.",
              connectUrl: "/api/sheets/connect",
            },
            502,
          );
        }

        const tokenData = (await tokenResponse.json()) as {
          access_token?: string;
        };

        if (!tokenData.access_token) {
          return jsonResponse(
            { success: false, error: "Google returned no access token." },
            502,
          );
        }

        const memoryTab = await findExistingTab(tokenData.access_token, trip.sheetId, ["TRIP MEMORIES", "TRIP_MEMORIES"], "TRIP MEMORIES");
        await ensureSheetTab(tokenData.access_token, trip.sheetId, memoryTab, ["memory_id", "trip_date", "attraction", "author_email", "content", "created_at", "updated_at", "photo_ids"]);
        const range = encodeURIComponent(`${quoteSheetTab(memoryTab)}!A:H`);
        const sheetUrl =
          `https://sheets.googleapis.com/v4/spreadsheets/` +
          `${encodeURIComponent(trip.sheetId)}/values/${range}`;

        if (request.method === "GET") {
          const sheetResponse = await fetch(sheetUrl, {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
            },
          });

          if (!sheetResponse.ok) {
            return jsonResponse(
              {
                success: false,
                error: "Could not read TRIP_MEMORIES. Check the worksheet name and Google Sheets access.",
              },
              502,
            );
          }

          const sheetData = (await sheetResponse.json()) as {
            values?: unknown[][];
          };

          const rows = sheetData.values || [];
          const memories = rows.slice(1).filter(
            (row) =>
              typeof row[0] === "string" &&
              typeof row[1] === "string" &&
              typeof row[4] === "string" &&
              String(row[0]).trim() !== "",
          ).map((row) => ({
            memory_id: String(row[0] || ""),
            trip_date: String(row[1] || ""),
            attraction: String(row[2] || ""),
            author_email: String(row[3] || ""),
            content: String(row[4] || ""),
            created_at: String(row[5] || ""),
            updated_at: String(row[6] || ""),
            photo_ids: String(row[7] || ""),
          }));

          return jsonResponse({
            success: true,
            memories,
          });
        }

        const body = (await request.json()) as {
          memory_id?: unknown;
          trip_date?: unknown;
          attraction?: unknown;
          content?: unknown;
        };

        const memoryId =
          typeof body.memory_id === "string" ? body.memory_id.trim() : "";
        const tripDate =
          typeof body.trip_date === "string" ? body.trip_date.trim() : "";
        const attraction =
          typeof body.attraction === "string" ? body.attraction.trim() : "";
        const content =
          typeof body.content === "string" ? body.content.trim() : "";

        if (
          !memoryId ||
          memoryId.length > 100 ||
          !tripDate ||
          tripDate.length > 40 ||
          attraction.length > 200 ||
          !content ||
          content.length > 5000
        ) {
          return jsonResponse(
            { success: false, error: "Invalid memory details." },
            400,
          );
        }

        // Check existing IDs so retries do not normally create duplicates.
        const existingResponse = await fetch(sheetUrl, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        if (!existingResponse.ok) {
          return jsonResponse(
            { success: false, error: "Could not check existing memories." },
            502,
          );
        }

        const existingData = (await existingResponse.json()) as {
          values?: string[][];
        };

        const existingRows = existingData.values || [];
        const existingRow = existingRows.slice(1).find(
          (row) => String(row[0] || "") === memoryId,
        );

        if (existingRow) {
          return jsonResponse({
            success: true,
            duplicate: true,
            message: "Memory already saved.",
            memory: {
              memory_id: String(existingRow[0] || ""),
              trip_date: String(existingRow[1] || ""),
              attraction: String(existingRow[2] || ""),
              author_email: String(existingRow[3] || ""),
              content: String(existingRow[4] || ""),
              created_at: String(existingRow[5] || ""),
              updated_at: String(existingRow[6] || ""),
              photo_ids: String(existingRow[7] || ""),
            },
          });
        }

        const createdAt = new Date().toISOString();
        const appendUrl =
          `${sheetUrl}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

        const appendResponse = await fetch(appendUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            values: [[
              memoryId,
              tripDate,
              attraction,
              session.email,
              content,
              createdAt,
              createdAt,
              "",
            ]],
          }),
        });

        if (!appendResponse.ok) {
          return jsonResponse(
            { success: false, error: "Could not save the memory to Google Sheets." },
            502,
          );
        }

        return jsonResponse({
          success: true,
          duplicate: false,
          message: "Memory saved.",
          memory: {
            memory_id: memoryId,
            trip_date: tripDate,
            attraction,
            author_email: session.email,
            content,
            created_at: createdAt,
            updated_at: createdAt,
            photo_ids: "",
          },
        });
      } catch {
        return jsonResponse(
          { success: false, error: "An unexpected error occurred while accessing memories." },
          500,
        );
      }
    }
    
    return jsonResponse(
      { error: "Not Found" },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
