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
const SOUTH_ISLAND_SHEET_ID = "1L_GUByHbUMIORDakIRutHUwK9pNMYPAsm1H1fe6RMB0";
const TRIP_MEMORY_FOLDER_ID = "1mvq9t6mrtMnQk1Ug3DN2dl8S7cEDI-97";
const EXPENSE_HEADERS = ["expense_id", "date", "description", "category", "amount", "currency", "paid_by", "expense_type", "notes", "created_at", "share_type", "latitude", "longitude", "location", "legacy"];

async function getTripRegistry(env: Env): Promise<TripConfig[]> {
  const saved = await env.OAUTH_TOKEN_STORE.get(TRIP_REGISTRY_KEY);
  let trips: TripConfig[] = [];
  if (saved) {
    try { trips = JSON.parse(saved) as TripConfig[]; } catch { trips = []; }
  }
  const southIsland = trips.find((trip) => trip.id === "nz-south-island");
  if (southIsland) {
    // This is the workbook explicitly confirmed by the user. Avoid stale KV trip IDs
    // silently sending itinerary/checklist/expenses to a different spreadsheet.
    southIsland.sheetId = SOUTH_ISLAND_SHEET_ID;
    southIsland.itineraryTab = "FINAL ITINERARY";
  } else {
    trips.unshift({ id: "nz-south-island", name: "New Zealand — South Island", sheetId: SOUTH_ISLAND_SHEET_ID, itineraryTab: "FINAL ITINERARY" });
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
    if (!addResponse.ok) {
      const detail = await addResponse.text().catch(() => "");
      throw new Error(`Could not create the ${tabName} tab in Google Sheets (HTTP ${addResponse.status}). ${detail.slice(0, 500)}`);
    }
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
  const exact = candidates.find((candidate) => names.includes(candidate));
  if (exact) return exact;
  const normalizeTab = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedMatch = names.find((name) => candidates.some((candidate) => normalizeTab(name) === normalizeTab(candidate)));
  return normalizedMatch || fallback;
}

async function readSheetRows(accessToken: string, sheetId: string, tabName: string): Promise<string[][]> {
  const response = await fetch(sheetsValuesUrl(sheetId, `${quoteSheetTab(tabName)}!A:Z`), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Could not read the ${tabName} tab. Check the tab name and Google Sheets access.`);
  const data = await response.json() as { values?: unknown[][] };
  return (data.values || []).map((row) => row.map((cell) => String(cell ?? "")));
}


async function uploadSharedMemoryPhoto(accessToken: string, photo: { name?: unknown; mime_type?: unknown; data_base64?: unknown }): Promise<{ id: string; url: string }> {
  const name = typeof photo.name === "string" ? photo.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) : "travel-memory.jpg";
  const mimeType = typeof photo.mime_type === "string" && /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(photo.mime_type) ? photo.mime_type : "";
  const encoded = typeof photo.data_base64 === "string" ? photo.data_base64.replace(/^data:image\/[^;]+;base64,/, "") : "";
  if (!mimeType || !encoded) throw new Error("A selected photo has an unsupported image format.");
  const binary = atob(encoded);
  if (binary.length > 4 * 1024 * 1024) throw new Error("Each photo must be 4 MB or smaller.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name, mimeType, parents: [TRIP_MEMORY_FOLDER_ID], description: "Shared campervan travel memory" })], { type: "application/json" }));
  form.append("file", new Blob([bytes], { type: mimeType }), name);
  const upload = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form,
  });
  if (!upload.ok) {
    const detail = (await upload.text().catch(() => "")).slice(0, 400);
    if (upload.status === 401 || /insufficient authentication scopes/i.test(detail)) {
      throw new Error(`Google Drive authorization is missing the required upload scope (HTTP ${upload.status}). Reconnect Google access once to approve Drive permissions. ${detail}`);
    }
    if (upload.status === 403 && /has not been used in project|is disabled|enable.*drive\.googleapis\.com/i.test(detail)) throw new Error(`Google Drive API is disabled for Google Cloud project 269076730966. Enable it at https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=269076730966, wait a few minutes, then retry. ${detail}`);
    if (upload.status === 403) throw new Error(`Google Drive denied access to the photo folder. Confirm the connected Google account can add files to folder ${TRIP_MEMORY_FOLDER_ID} and that the Drive API is enabled. ${detail}`);
    if (upload.status === 404) throw new Error(`The configured trip-photo folder could not be found or accessed (${TRIP_MEMORY_FOLDER_ID}). ${detail}`);
    throw new Error(`Google Drive could not upload the selected photo (HTTP ${upload.status}). ${detail}`);
  }
  const file = await upload.json() as { id?: string; webViewLink?: string };
  if (!file.id) throw new Error("Google Drive did not return a photo ID.");
  // Files inherit access from the destination folder. Avoid a second per-file
  // permission call, which can fail under Workspace sharing policies and used
  // to trigger the reconnect loop (and delete the successfully uploaded photo).
  return { id: file.id, url: file.webViewLink || `https://drive.google.com/uc?export=view&id=${encodeURIComponent(file.id)}` };
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
          "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
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

    // Shared trip expenses. Load both the existing FINAL EXPENSES planning rows
    // and valid app-entered rows from TRIP EXPENSES. Never modify FINAL EXPENSES.
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
        if (request.method === "POST") {
          await ensureSheetTab(token, trip.sheetId, tab, EXPENSE_HEADERS);
          const extraHeaderRange = `${quoteSheetTab(tab)}!K1:N1`;
          const extraHeaderRead = await fetch(sheetsValuesUrl(trip.sheetId, extraHeaderRange), { headers: { Authorization: `Bearer ${token}` } });
          if (extraHeaderRead.ok) {
            const extraHeaderData = await extraHeaderRead.json() as { values?: unknown[][] };
            if (!(extraHeaderData.values?.[0] || []).some((cell) => String(cell ?? "").trim())) {
              const extraHeaderWrite = await fetch(`${sheetsValuesUrl(trip.sheetId, extraHeaderRange)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [["share_type", "latitude", "longitude", "location"]] }) });
              if (!extraHeaderWrite.ok) throw new Error("Could not add the new expense metadata headers in columns K:N.");
            }
          }
          const legacyHeaderRead = await fetch(sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!O1`), { headers: { Authorization: `Bearer ${token}` } });
          if (legacyHeaderRead.ok) {
            const legacyHeaderData = await legacyHeaderRead.json() as { values?: unknown[][] };
            if (!String(legacyHeaderData.values?.[0]?.[0] ?? "").trim()) {
              const legacyHeaderWrite = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!O1`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [["legacy"]] }) });
              if (!legacyHeaderWrite.ok) throw new Error("Could not add the legacy flag header in column O.");
            }
          }
        }

        if (request.method === "GET") {
          const loggedExpenses: Array<Record<string, unknown>> = [];
          const existingTab = await findExistingTab(token, trip.sheetId, [tab], "");
          if (existingTab) {
            const rows = await readSheetRows(token, trip.sheetId, existingTab);
            const header = (rows[0] || []).map((cell) => cell.trim().toLowerCase());
            const idx = (name: string) => header.indexOf(name);
            const idIdx = idx("expense_id"), dateIdx = idx("date"), descIdx = idx("description");
            const amountIdx = idx("amount"), currencyIdx = idx("currency"), paidByIdx = idx("paid_by");
            const categoryIdx = idx("category"), notesIdx = idx("notes"), shareTypeIdx = idx("share_type"), latitudeIdx = idx("latitude"), longitudeIdx = idx("longitude"), locationIdx = idx("location"), legacyIdx = idx("legacy");
            rows.slice(1).forEach((row, rowOffset) => {
              const legacyFlag = legacyIdx >= 0 ? String(row[legacyIdx] ?? "").trim().toUpperCase() : "";
              if (["TRUE", "YES", "LEGACY", "1", "X"].includes(legacyFlag)) return;
              const expenseId = idIdx >= 0 ? String(row[idIdx] || "").trim() : "";
              const description = descIdx >= 0 ? String(row[descIdx] || "").trim() : "";
              const amountText = amountIdx >= 0 ? String(row[amountIdx] || "").replace(/,/g, "").replace(/[^0-9.-]/g, "") : "";
              const amount = Number(amountText);
              // Ignore partial/test rows: they are not usable expense records and
              // otherwise appear as blank cards in the frontend.
              if (!expenseId || !description || !Number.isFinite(amount) || amount <= 0) return;
              const date = dateIdx >= 0 ? String(row[dateIdx] || "").trim() : "";
              const inferredType = date >= "2026-11-07" ? "actual-trip" : "pre-trip";
              loggedExpenses.push({
                expense_id: expenseId,
                date,
                description,
                category: categoryIdx >= 0 ? String(row[categoryIdx] || "Other") : "Other",
                amount,
                currency: currencyIdx >= 0 ? String(row[currencyIdx] || "NZD") : "NZD",
                paid_by: paidByIdx >= 0 ? String(row[paidByIdx] || "Ralph") : "Ralph",
                // Date is the source of truth for the trip boundary: before 7 Nov is
                // pre-trip; 7 Nov onward is actual-trip, even if an old row has a stale type.
                expense_type: inferredType,
                share_type: shareTypeIdx >= 0 && String(row[shareTypeIdx] || "").toLowerCase() === "personal" ? "personal" : "shared",
                split_share: shareTypeIdx >= 0 && String(row[shareTypeIdx] || "").toLowerCase() === "personal" ? amount : amount / 2,
                latitude: latitudeIdx >= 0 ? String(row[latitudeIdx] || "") : "",
                longitude: longitudeIdx >= 0 ? String(row[longitudeIdx] || "") : "",
                location: locationIdx >= 0 ? String(row[locationIdx] || "") : "",
                notes: notesIdx >= 0 ? String(row[notesIdx] || "") : "",
                source: "TRIP EXPENSES",
                sheet_row: rowOffset + 2,
              });
            });
          }

          const plannedExpenses: Array<Record<string, unknown>> = [];
          const planningTab = await findExistingTab(token, trip.sheetId, ["FINAL EXPENSES", "Final Expenses"], "");
          if (planningTab) {
            const planningRows = await readSheetRows(token, trip.sheetId, planningTab);
            let group = "Pre-trip";
            for (let i = 0; i < planningRows.length; i++) {
              const row = planningRows[i] || [];
              const description = String(row[0] || "").trim();
              const amountText = String(row[1] || "").replace(/,/g, "").replace(/[^0-9.-]/g, "");
              const amount = Number(amountText);
              const rowLabel = description.toLowerCase().replace(/[^a-z0-9]/g, "");
              if (rowLabel === "total" || rowLabel === "grandtotal") break;
              if (!description) continue;
              if (["item", "itemlist", "description", "category", "expense", "expenses"].includes(rowLabel)) continue;
              if (!Number.isFinite(amount) || amount <= 0) {
                // Category title rows have a label in column A and no total cost.
                group = description;
                continue;
              }
              const splitText = String(row[2] || "").replace(/,/g, "").replace(/[^0-9.-]/g, "");
              const splitShare = Number(splitText);
              const paidBy = String(row[3] || "Shared").trim() || "Shared";
              const paidFlag = String(row[4] ?? "").trim().toUpperCase();
              const notes = [row[9] ? String(row[9]).trim() : ""].filter(Boolean).join(" · ");
              const sheetRow = i + 1;
              plannedExpenses.push({
                expense_id: `planned-final-expenses-row-${sheetRow}`,
                date: "",
                description,
                category: group,
                amount,
                split_share: Number.isFinite(splitShare) && splitText ? splitShare : amount / 2,
                currency: "MYR",
                paid_by: paidBy,
                expense_type: "pre-trip",
                share_type: "shared",
                payment_status: ["TRUE", "✓", "☑", "1"].includes(paidFlag) ? "Paid" : "Estimate",
                notes,
                source: "FINAL EXPENSES",
              });
            }
          }
          return jsonResponse({ success: true, expenses: [...plannedExpenses, ...loggedExpenses], tripId: trip.id, sources: { planned: "FINAL EXPENSES", actual: existingTab || null } });
        }

        const rows = await readSheetRows(token, trip.sheetId, tab);
        const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "create";
        const expenseId = typeof body.expense_id === "string" ? body.expense_id.trim() : "";
        const existingRowIndex = rows.findIndex((row, index) => index > 0 && String(row[0] ?? "").trim() === expenseId);
        if (action === "legacy") {
          if (!expenseId || existingRowIndex < 1) return jsonResponse({ success: false, error: "Could not find that app-entered expense to mark as legacy." }, 404);
          const legacyRange = `${quoteSheetTab(tab)}!O${existingRowIndex + 1}`;
          const legacyWrite = await fetch(`${sheetsValuesUrl(trip.sheetId, legacyRange)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [["TRUE"]] }) });
          if (!legacyWrite.ok) return jsonResponse({ success: false, error: `Could not mark the expense as legacy (HTTP ${legacyWrite.status}).` }, 502);
          return jsonResponse({ success: true, message: "Expense marked as legacy. The original sheet row was kept; it will no longer appear in the app." });
        }
        const date = typeof body.date === "string" ? body.date.trim() : "";
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const category = typeof body.category === "string" ? body.category.trim() : "Other";
        const amount = Number(body.amount);
        const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "NZD";
        const paidBy = typeof body.paid_by === "string" ? body.paid_by.trim() : "";
        const expenseType = date >= "2026-11-07" ? "actual-trip" : "pre-trip";
        const shareType = body.share_type === "personal" ? "personal" : body.share_type === "shared" ? "shared" : "shared";
        const latitude = typeof body.latitude === "string" ? body.latitude.trim() : "";
        const longitude = typeof body.longitude === "string" ? body.longitude.trim() : "";
        const location = typeof body.location === "string" ? body.location.trim() : "";
        const notes = typeof body.notes === "string" ? body.notes.trim() : "";
        if (!expenseId || expenseId.length > 100 || !date || !description || description.length > 250 || !Number.isFinite(amount) || amount <= 0 || !["pre-trip", "actual-trip"].includes(String(expenseType)) || !["Ralph", "June", "Shared"].includes(paidBy) || !/^[A-Z]{3}$/.test(currency) || category.length > 100 || notes.length > 2000 || latitude.length > 30 || longitude.length > 30 || location.length > 500) return jsonResponse({ success: false, error: "Invalid expense details." }, 400);
        if (action === "edit") {
          if (existingRowIndex < 1) return jsonResponse({ success: false, error: "Could not find that app-entered expense to edit." }, 404);
          const createdAt = String(rows[existingRowIndex][9] || new Date().toISOString());
          const editRange = `${quoteSheetTab(tab)}!A${existingRowIndex + 1}:O${existingRowIndex + 1}`;
          const editWrite = await fetch(`${sheetsValuesUrl(trip.sheetId, editRange)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[expenseId, date, description, category, amount, currency, paidBy, expenseType, notes, createdAt, shareType, latitude, longitude, location, ""]] }) });
          if (!editWrite.ok) return jsonResponse({ success: false, error: `Could not update the expense in Google Sheets (HTTP ${editWrite.status}).` }, 502);
          return jsonResponse({ success: true, message: "Expense updated." });
        }
        if (action !== "create") return jsonResponse({ success: false, error: "Unknown expense action." }, 400);
        if (existingRowIndex > 0 || rows.slice(1).some((row) => row[0] === expenseId)) return jsonResponse({ success: true, duplicate: true, message: "Expense already saved." });
        const appendUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:O`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
        const append = await fetch(appendUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[expenseId, date, description, category, amount, currency, paidBy, expenseType, notes, new Date().toISOString(), shareType, latitude, longitude, location, ""]] }) });
        if (!append.ok) {
          const detail = (await append.text().catch(() => "")).slice(0, 400);
          return jsonResponse({ success: false, error: `Could not save the expense to Google Sheets (HTTP ${append.status}). ${detail}` }, 502);
        }
        return jsonResponse({ success: true, message: "Expense saved.", tripId: trip.id }, 201);
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not access trip expenses." }, 500); }
    }

    // Approved trip documents and reference links. The Password/email rows in
    // the source Link tab are intentionally excluded server-side.
    if (request.method === "GET" && url.pathname === "/api/documents") {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      try {
        const trip = await resolveTrip(request, env);
        if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
        const token = await googleAccessToken(session, env);
        const linkTab = await findExistingTab(token, trip.sheetId, ["Link", "Links"], "Link");
        const rows = await readSheetRows(token, trip.sheetId, linkTab);
        const documents = rows.flatMap((row) => {
          const sourceCategory = String(row[0] || "Reference").trim();
          const title = String(row[1] || "").trim();
          const resourceUrl = String(row[2] || "").trim();
          const allowedTitles = ["all document", "doc website", "jucy chaser spec", "bus route 29", "bus route 8"];
          if (!title || !allowedTitles.includes(title.toLowerCase()) || /password|email|login|credential/i.test(title) || /@/.test(title) || !/^https:\/\//i.test(resourceUrl) || /password|email|login|credential/i.test(resourceUrl)) return [];
          try { const parsed = new URL(resourceUrl); if (!parsed.hostname || parsed.protocol !== "https:") return []; } catch { return []; }
          const category = title.toLowerCase() === "all document" ? "Documents" : title.toLowerCase() === "doc website" ? "Booking" : /drive/i.test(sourceCategory) ? "Documents" : sourceCategory;
          return [{ category, title, url: resourceUrl, kind: /drive\.google\.com\/drive\/folders/i.test(resourceUrl) ? "drive_folder" : "link" }];
        });
        return jsonResponse({ success: true, documents, tripId: trip.id });
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not load trip documents and links." }, 500); }
    }

    // Checklist single source of truth. APP_CHECKLIST is created and migrated
    // automatically; the two original human-readable tabs are never modified.
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
        const profile = session.email.toLowerCase() === "koochanyee@gmail.com" ? "Ralph" : session.email.toLowerCase() === "wookahwai@gmail.com" ? "June" : "";
        if (!profile) return jsonResponse({ success: false, error: "This account is not assigned a checklist profile." }, 403);
        const tab = "APP_CHECKLIST";
        const headers = ["checklist_id", "list_type", "category", "item", "quantity", "notes", "shared_done", "to_buy", "sort_order", "active", "created_at", "updated_at", "source_tab", "source_row", "must_have", "due_date", "completion_mode", "ralph_done", "june_done", "cancelled"];
        await ensureSheetTab(token, trip.sheetId, tab, headers);
        const readAppRows = async () => readSheetRows(token, trip.sheetId, tab);
        let appRows = await readAppRows();
        const headerNorm = (appRows[0] || []).map((cell) => String(cell ?? "").trim().toLowerCase());
        if (headers.slice(0, 16).some((header, index) => headerNorm[index] !== header)) {
          return jsonResponse({ success: false, error: "APP_CHECKLIST exists but its original headers do not match the expected schema. No data was changed; please inspect the tab before retrying." }, 409);
        }
        // Extend an existing A:P checklist safely; never replace or reorder its data.
        const extraHeaders = headers.slice(16);
        if (extraHeaders.some((header, index) => headerNorm[index + 16] !== header)) {
          const headerWrite = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!Q1:T1`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [extraHeaders] }) });
          if (!headerWrite.ok) return jsonResponse({ success: false, error: "Could not add the Shared/Personal and cancellation columns to APP_CHECKLIST." }, 502);
          appRows = await readAppRows();
        }
        const col = (name: string) => headers.indexOf(name);
        const now = new Date().toISOString();

        // One-time, idempotent migration. Deterministic IDs mean retries cannot
        // duplicate legacy rows. Existing source tabs remain untouched.
        const existingIds = new Set(appRows.slice(1).map((row) => String(row[col("checklist_id")] || "").trim()).filter(Boolean));
        const migrationRows: string[][] = [];
        const legacyStatusKey = `checklist-status:${trip.id}`;
        let legacyStatuses: Record<string, { ralph_status?: string; june_status?: string; shared_status?: string }> = {};
        const savedLegacyStatuses = await env.OAUTH_TOKEN_STORE.get(legacyStatusKey);
        if (savedLegacyStatuses) { try { legacyStatuses = JSON.parse(savedLegacyStatuses) as typeof legacyStatuses; } catch { legacyStatuses = {}; } }
        const truthy = (value: unknown) => [true, "TRUE", "true", "✓", "1", 1].includes(value as never);
        // Existing checklist rows predate the Personal/Shared choice. Default
        // them to Personal while carrying their previous shared completion to
        // both travellers, so no checked state is lost during the upgrade.
        const defaultsToBackfill = appRows.slice(1).flatMap((row, index) => {
          const rowId = String(row[col("checklist_id")] || "").trim();
          if (!rowId || String(row[col("completion_mode")] || "").trim()) return [];
          const priorDone = truthy(row[col("shared_done")]);
          return [{ range: `${quoteSheetTab(tab)}!Q${index + 2}:T${index + 2}`, values: [["PERSONAL", priorDone, priorDone, false]] }];
        });
        if (defaultsToBackfill.length) {
          const defaultsWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trip.sheetId)}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data: defaultsToBackfill }) });
          if (!defaultsWrite.ok) return jsonResponse({ success: false, error: "Could not initialise existing checklist items as Personal. No checklist status was changed; please retry." }, 502);
          appRows = await readAppRows();
        }
        const appendLegacy = (id: string, listType: string, category: string, item: string, quantity: string, notes: string, sourceTab: string, sourceRow: number, oldIds: string[], mustHave = false, dueDate = "", sourceDone = false) => {
          if (!item.trim() || existingIds.has(id) || migrationRows.some((row) => row[0] === id)) return;
          const prior = oldIds.map((oldId) => legacyStatuses[oldId] || {}).find((status) => status.shared_status === "✓" || status.ralph_status === "✓" || status.june_status === "✓");
          const done = Boolean(prior) || sourceDone;
          migrationRows.push([id, listType, category || "Other", item.trim(), quantity, notes, String(done), "FALSE", String(migrationRows.length + 1), "TRUE", now, now, sourceTab, String(sourceRow), String(mustHave), dueDate, "PERSONAL", String(done), String(done), "FALSE"]);
        };
        const mainTab = await findExistingTab(token, trip.sheetId, ["Thing to do n bring", "Things to do n bring", "Thing to do & bring", "Things to do & bring", "THINGS TO DO N BRING", "THINGS TO DO & BRING"], "");
        if (!mainTab) return jsonResponse({ success: false, error: "Could not find the existing pre-trip checklist tab ‘Thing to do n bring’." }, 404);
        const mainRows = await readSheetRows(token, trip.sheetId, mainTab);
        const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
        const mainHeader = mainRows[0] || [];
        const findHeader = (tests: string[]) => mainHeader.findIndex((cell) => tests.includes(norm(String(cell || ""))));
        const categoryIdx = Math.max(0, findHeader(["category"]));
        const itemIdx = findHeader(["item"]) >= 0 ? findHeader(["item"]) : 1;
        const qtyIdx = findHeader(["qty", "quantity"]) >= 0 ? findHeader(["qty", "quantity"]) : 2;
        const notesIdx = findHeader(["notes"]) >= 0 ? findHeader(["notes"]) : 5;
        const ralphIdx = findHeader(["ralph"]);
        const juneIdx = findHeader(["june"]);
        const todoIdx = findHeader(["thingstodo", "todo", "task"]) >= 0 ? findHeader(["thingstodo", "todo", "task"]) : 9;
        const dueIdx = findHeader(["duedate", "due", "month"]) >= 0 ? findHeader(["duedate", "due", "month"]) : 8;
        const mustHaveIdx = String(mainHeader[3] || "").trim() ? -1 : 3;
        if (norm(String(mainHeader[categoryIdx] || "")) !== "category" || norm(String(mainHeader[itemIdx] || "")) !== "item") return jsonResponse({ success: false, error: `The tab “${mainTab}” does not have the expected Category / Item headers.` }, 409);
        let currentCategory = "Other";
        mainRows.slice(1).forEach((row, index) => {
          const sourceRow = index + 2;
          if (String(row[categoryIdx] || "").trim()) currentCategory = String(row[categoryIdx]).trim();
          const packing = String(row[itemIdx] || "").trim();
          if (packing) appendLegacy(`legacy:packing:${sourceRow}`, "BEFORE_DEPARTURE", currentCategory, packing, String(row[qtyIdx] || "").trim(), String(row[notesIdx] || "").trim(), mainTab, sourceRow, [`pack-${sourceRow}`], mustHaveIdx >= 0 && truthy(row[mustHaveIdx]), "", (ralphIdx >= 0 && truthy(row[ralphIdx])) || (juneIdx >= 0 && truthy(row[juneIdx])));
          const todo = String(row[todoIdx] || "").trim();
          if (todo) appendLegacy(`legacy:todo:${sourceRow}`, "BEFORE_DEPARTURE", "Things to do", todo, "", "", mainTab, sourceRow, [`todo-${sourceRow}`], false, String(row[dueIdx] || "").trim(), truthy(row[7]));
        });
        const groceryTab = await findExistingTab(token, trip.sheetId, ["Shopping List or Things to Brin", "Shopping List or Things to Bring"], "");
        if (groceryTab) {
          const groceryRows = await readSheetRows(token, trip.sheetId, groceryTab);
          let groceryCategory = "Pack ’n Save";
          groceryRows.slice(2).forEach((row, index) => {
            const sourceRow = index + 3;
            const malaysiaItem = String(row[0] || "").trim();
            const malaysiaQty = String(row[1] || "").trim();
            if (malaysiaItem && norm(malaysiaItem) !== "tobringfrommalaysia") appendLegacy(`legacy:grocery-malaysia:${sourceRow}`, "GROCERY", "🧳 To bring from Malaysia", malaysiaItem, malaysiaQty, "", groceryTab, sourceRow, [`grocery-malaysia-${sourceRow}`]);
            const categoryCell = String(row[3] || "").trim();
            if (categoryCell && norm(categoryCell) !== "category") groceryCategory = categoryCell;
            const buyItem = String(row[4] || "").trim();
            if (buyItem && norm(buyItem) !== "whatidbuy") appendLegacy(`legacy:grocery-pns:${sourceRow}`, "GROCERY", `🛒 ${groceryCategory}`, buyItem, String(row[5] || "").trim(), String(row[6] || "").trim(), groceryTab, sourceRow, [`grocery-pns-${sourceRow}`]);
            const quickItem = String(row[9] || "").trim();
            if (quickItem) appendLegacy(`legacy:grocery-list:${sourceRow}`, "GROCERY", "🛒 Grocery quick list", quickItem, "", "", groceryTab, sourceRow, [`grocery-list-${sourceRow}`]);
          });
        }
        if (migrationRows.length) {
          const appendUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:T`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
          const migrationWrite = await fetch(appendUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: migrationRows }) });
          if (!migrationWrite.ok) return jsonResponse({ success: false, error: `Could not migrate existing checklist items to APP_CHECKLIST (HTTP ${migrationWrite.status}).` }, 502);
          appRows = await readAppRows();
        }

        if (request.method === "POST") {
          const action = String(body.action || "set_status");
          if (action === "reset_grocery") {
            const updates = appRows.slice(1).flatMap((row, index) => String(row[col("list_type")] || "") === "GROCERY" && String(row[col("active")] || "TRUE").toUpperCase() !== "FALSE" ? [{ range: `${quoteSheetTab(tab)}!G${index + 2}:H${index + 2}`, values: [[false, false]] }, { range: `${quoteSheetTab(tab)}!R${index + 2}:S${index + 2}`, values: [[false, false]] }] : []);
            if (updates.length) {
              const write = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trip.sheetId)}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data: updates }) });
              if (!write.ok) return jsonResponse({ success: false, error: "Google Sheets could not reset grocery completion." }, 502);
            }
            return jsonResponse({ success: true, message: "Grocery checkboxes reset for both travellers." });
          }
          if (action === "add") {
            const listType = body.list_type === "GROCERY" ? "GROCERY" : "BEFORE_DEPARTURE";
            const category = typeof body.category === "string" ? body.category.trim().slice(0, 100) : "";
            const item = typeof body.item === "string" ? body.item.trim().slice(0, 250) : "";
            const quantity = typeof body.quantity === "string" ? body.quantity.trim().slice(0, 80) : "";
            const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
            if (!category || !item) return jsonResponse({ success: false, error: "Choose a category and enter an item." }, 400);
            const id = `custom:${crypto.randomUUID()}`;
            const addUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:T`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
            const addWrite = await fetch(addUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[id, listType, category, item, quantity, notes, "FALSE", "FALSE", String(appRows.length), "TRUE", now, now, "APP", "", "FALSE", "", "PERSONAL", "FALSE", "FALSE", "FALSE"]] }) });
            if (!addWrite.ok) return jsonResponse({ success: false, error: "Could not add the item to Google Sheets." }, 502);
            return jsonResponse({ success: true, message: "Item added and synced to Google Sheets.", item: { item_id: id, checklist_type: listType === "GROCERY" ? "grocery" : "packing", category, item, quantity, notes, shared_done: false, to_buy: false, completion_mode: "PERSONAL", ralph_done: false, june_done: false, cancelled: false } }, 201);
          }
          const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
          const rowIndex = appRows.slice(1).findIndex((row) => String(row[col("checklist_id")] || "") === itemId);
          if (!itemId || rowIndex < 0) return jsonResponse({ success: false, error: "Checklist item not found. Refresh and try again." }, 404);
          const sheetRow = rowIndex + 2;
          const currentRow = appRows[sheetRow - 1] || [];
          const currentSharedDone = truthy(currentRow[col("shared_done")]);
          const currentRalphDone = truthy(currentRow[col("ralph_done")]);
          const currentJuneDone = truthy(currentRow[col("june_done")]);
          const currentMode = String(currentRow[col("completion_mode")] || "PERSONAL").toUpperCase() === "SHARED" ? "SHARED" : "PERSONAL";
          if (action === "set_mode") {
            const nextMode = String(body.completion_mode || "").toUpperCase();
            if (nextMode !== "SHARED" && nextMode !== "PERSONAL") return jsonResponse({ success: false, error: "Choose Shared or Personal." }, 400);
            const nextSharedDone = nextMode === "SHARED" ? (currentMode === "PERSONAL" ? currentRalphDone || currentJuneDone : currentSharedDone) : currentSharedDone;
            const nextRalphDone = nextMode === "PERSONAL" && currentMode === "SHARED" ? currentSharedDone : currentRalphDone;
            const nextJuneDone = nextMode === "PERSONAL" && currentMode === "SHARED" ? currentSharedDone : currentJuneDone;
            const modeWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trip.sheetId)}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: `${quoteSheetTab(tab)}!G${sheetRow}`, values: [[nextSharedDone]] }, { range: `${quoteSheetTab(tab)}!Q${sheetRow}:S${sheetRow}`, values: [[nextMode, nextRalphDone, nextJuneDone]] }, { range: `${quoteSheetTab(tab)}!L${sheetRow}`, values: [[now]] }] }) });
            if (!modeWrite.ok) return jsonResponse({ success: false, error: "Could not save the checklist sharing mode." }, 502);
            return jsonResponse({ success: true, item_id: itemId, completion_mode: nextMode, message: `Checklist item is now ${nextMode === "SHARED" ? "shared by both travellers" : "personal to each traveller"}.` });
          }
          if (action === "set_cancelled") {
            const cancelled = Boolean(body.cancelled);
            const cancelWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trip.sheetId)}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: `${quoteSheetTab(tab)}!T${sheetRow}`, values: [[cancelled]] }, ...(cancelled ? [{ range: `${quoteSheetTab(tab)}!H${sheetRow}`, values: [[false]] }] : []), { range: `${quoteSheetTab(tab)}!L${sheetRow}`, values: [[now]] }] }) });
            if (!cancelWrite.ok) return jsonResponse({ success: false, error: "Could not save the cancelled status." }, 502);
            return jsonResponse({ success: true, item_id: itemId, cancelled, message: cancelled ? "Item cancelled and kept in the checklist." : "Item restored to the active checklist." });
          }
          if (action === "set_to_buy") {
            const toBuy = Boolean(body.to_buy) && String(appRows[sheetRow - 1][col("list_type")]) === "BEFORE_DEPARTURE";
            const write = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!H${sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[toBuy]] }) });
            if (!write.ok) return jsonResponse({ success: false, error: "Could not update To Buy status in Google Sheets." }, 502);
            await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!L${sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[now]] }) });
            return jsonResponse({ success: true, message: toBuy ? "Added to To Buy." : "Removed from To Buy." });
          }
          if (currentMode === "PERSONAL") {
            const person = String(body.person || profile);
            if (person !== profile) return jsonResponse({ success: false, error: "You can only update your own personal checklist status." }, 403);
            const done = Boolean(body.done ?? (body.status === "✓"));
            const targetColumn = profile === "Ralph" ? "R" : "S";
            const otherDone = profile === "Ralph" ? currentJuneDone : currentRalphDone;
            const clearToBuy = done && otherDone;
            const personalWrite = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trip.sheetId)}/values:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: `${quoteSheetTab(tab)}!${targetColumn}${sheetRow}`, values: [[done]] }, ...(clearToBuy ? [{ range: `${quoteSheetTab(tab)}!H${sheetRow}`, values: [[false]] }] : []), { range: `${quoteSheetTab(tab)}!L${sheetRow}`, values: [[now]] }] }) });
            if (!personalWrite.ok) return jsonResponse({ success: false, error: `Google Sheets did not save your personal completion status (HTTP ${personalWrite.status}).` }, 502);
            return jsonResponse({ success: true, item_id: itemId, person: profile, done, message: `${profile}'s personal completion saved to Google Sheets.` });
          }
          const sharedDone = Boolean(body.shared_done ?? (body.status === "✓"));
          const write = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!G${sheetRow}:H${sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[sharedDone, sharedDone ? false : truthy(currentRow[col("to_buy")])]] }) });
          if (!write.ok) return jsonResponse({ success: false, error: `Google Sheets did not save the shared completion status (HTTP ${write.status}).` }, 502);
          await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!L${sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[now]] }) });
          return jsonResponse({ success: true, item_id: itemId, shared_done: sharedDone, message: sharedDone ? `Marked done for both Ralph and June by ${profile}.` : "Shared completion cleared for both travellers." });
        }

        const items = appRows.slice(1).flatMap((row) => {
          const id = String(row[col("checklist_id")] || "").trim();
          const item = String(row[col("item")] || "").trim();
          if (!id || !item || String(row[col("active")] || "TRUE").toUpperCase() === "FALSE") return [];
          const listType = String(row[col("list_type")] || "BEFORE_DEPARTURE");
          const done = truthy(row[col("shared_done")]);
          const completionMode = String(row[col("completion_mode")] || "PERSONAL").toUpperCase() === "SHARED" ? "SHARED" : "PERSONAL";
          const ralphDone = truthy(row[col("ralph_done")]) || (completionMode === "SHARED" && done);
          const juneDone = truthy(row[col("june_done")]) || (completionMode === "SHARED" && done);
          return [{ item_id: id, category: String(row[col("category")] || "Other"), item, quantity: String(row[col("quantity")] || ""), notes: String(row[col("notes")] || ""), checklist_type: listType === "GROCERY" ? "grocery" : "packing", list_type: listType, shared_done: done, shared_status: done ? "✓" : "", ralph_status: ralphDone ? "✓" : "", june_status: juneDone ? "✓" : "", ralph_done: ralphDone, june_done: juneDone, completion_mode: completionMode, cancelled: truthy(row[col("cancelled")]), to_buy: truthy(row[col("to_buy")]), sort_order: Number(row[col("sort_order")] || 0), must_have: truthy(row[col("must_have")]), due_date: String(row[col("due_date")] || "") }];
        });
        return jsonResponse({ success: true, checklistItems: items, tripId: trip.id, sourceTab: tab, migratedCount: migrationRows.length, sharedCompletion: true, personalCompletion: true });
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
        
        // Lite mode returns the main itinerary only to reduce mobile data usage.
        // Normal mode retains the existing supplementary worksheet behavior.
        const supplementaryTabs: Record<string, string[][]> = {};
        let supplementaryError: string | undefined;

        if (url.searchParams.get("lite") !== "1") {
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
        await ensureSheetTab(tokenData.access_token, trip.sheetId, sessionTab, ["Date", "Session", "Planned location"]);
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

        if (matches.length === 0 && !oldLocation) {
          const appendUrl = `${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(sessionTab)}!A:C`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
          const appendResponse = await fetch(appendUrl, { method: "POST", headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[date, sessionName, newLocation]] }) });
          if (!appendResponse.ok) return jsonResponse({ success: false, error: "Could not add this session location to Google Sheets." }, 502);
          return jsonResponse({ success: true, message: "Session location added.", date, session: sessionName, oldLocation: "", newLocation }, 200);
        }
        if (matches.length !== 1) {
          return jsonResponse(
            {
              success: false,
              error: matches.length === 0
                ? "Session row not found for the existing location. Refresh the itinerary and try again."
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

    
    // Serve private Google Drive memory photos through the authenticated Worker.
    // Direct drive.google.com image URLs do not work reliably for private files.
    if (request.method === "GET" && url.pathname === "/api/memory-photo") {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      const trip = await resolveTrip(request, env);
      if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
      const fileId = (url.searchParams.get("fileId") || "").trim();
      if (!/^[a-zA-Z0-9_-]{10,200}$/.test(fileId)) return jsonResponse({ success: false, error: "Invalid photo ID." }, 400);
      try {
        const accessToken = await googleAccessToken(session, env);
        const driveResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!driveResponse.ok) {
          const detail = (await driveResponse.text().catch(() => "")).slice(0, 300);
          return jsonResponse({ success: false, error: driveResponse.status === 404 ? "Photo not found or not shared with this traveller." : `Could not load photo from Google Drive (HTTP ${driveResponse.status}). ${detail}` }, driveResponse.status === 404 ? 404 : 502);
        }
        const contentType = driveResponse.headers.get("Content-Type") || "application/octet-stream";
        if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(contentType.split(";")[0])) {
          return jsonResponse({ success: false, error: "The Drive file is not a supported image." }, 415);
        }
        return new Response(driveResponse.body, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
          },
        });
      } catch (error) {
        return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not retrieve the trip photo." }, 502);
      }
    }

    if (url.pathname === "/api/highlight-photo" && (request.method === "GET" || request.method === "POST")) {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return jsonResponse({ success: false, error: "Invalid request origin." }, 403);
      try {
        let body: Record<string, unknown> = {};
        if (request.method === "POST") body = await request.json() as Record<string, unknown>;
        const tripId = typeof body.tripId === "string" ? body.tripId : url.searchParams.get("tripId") || undefined;
        const trip = await resolveTrip(request, env, tripId);
        if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
        const date = (request.method === "POST" ? body.date : url.searchParams.get("date")) as string | null;
        if (!date || !String(date).trim() || String(date).length > 40) return jsonResponse({ success: false, error: "Select a valid itinerary date." }, 400);
        const dateKey = String(date).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const key = `highlight-photo:${trip.id}:${dateKey}`;
        if (request.method === "GET") {
          const saved = await env.OAUTH_TOKEN_STORE.get(key);
          const photo = saved ? JSON.parse(saved) as { id?: string; url?: string; date?: string; uploaded_by?: string } : null;
          if (url.searchParams.get("image") === "1") {
            const fileId = url.searchParams.get("fileId") || photo?.id || "";
            if (!fileId || !photo?.id || fileId !== photo.id) return jsonResponse({ success: false, error: "The saved highlight photo was not found." }, 404);
            const accessToken = await googleAccessToken(session, env);
            const imageResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
            if (!imageResponse.ok) return jsonResponse({ success: false, error: `Could not load the saved highlight photo from Google Drive (HTTP ${imageResponse.status}).` }, 502);
            return new Response(imageResponse.body, { status: 200, headers: { "Content-Type": imageResponse.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
          }
          const imageUrl = photo?.id ? `${url.origin}/api/highlight-photo?tripId=${encodeURIComponent(trip.id)}&date=${encodeURIComponent(String(date))}&image=1&fileId=${encodeURIComponent(photo.id)}` : "";
          return jsonResponse({ success: true, photo: photo ? { ...photo, url: imageUrl } : null, tripId: trip.id, date: String(date) });
        }
        const photo = body.photo as { name?: unknown; mime_type?: unknown; data_base64?: unknown } | undefined;
        if (!photo) return jsonResponse({ success: false, error: "Choose a photo first." }, 400);
        const accessToken = await googleAccessToken(session, env);
        const uploaded = await uploadSharedMemoryPhoto(accessToken, { ...photo, name: `highlight-${dateKey}-${String(photo.name || "photo")}` });
        const imageUrl = `${url.origin}/api/highlight-photo?tripId=${encodeURIComponent(trip.id)}&date=${encodeURIComponent(String(date))}&image=1&fileId=${encodeURIComponent(uploaded.id)}`;
        const savedPhoto = { id: uploaded.id, url: imageUrl, date: String(date), uploaded_by: session.email, updated_at: new Date().toISOString() };
        await env.OAUTH_TOKEN_STORE.put(key, JSON.stringify(savedPhoto));
        return jsonResponse({ success: true, photo: savedPhoto, message: "Today Highlight photo saved to the shared Drive folder." });
      } catch (error) {
        return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not save the Today Highlight photo." }, 500);
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

        const memoryTab = await findExistingTab(tokenData.access_token, trip.sheetId, ["TRIP_MEMORIES", "TRIP MEMORIES"], "TRIP_MEMORIES");
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
          photos?: Array<{ name?: unknown; mime_type?: unknown; data_base64?: unknown }>;
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

        const photos = Array.isArray(body.photos) ? body.photos : [];
        if (photos.length > 4) return jsonResponse({ success: false, error: "Choose up to 4 photos per memory." }, 400);
        let encodedTotal = 0;
        for (const photo of photos) {
          const encoded = typeof photo.data_base64 === "string" ? photo.data_base64.replace(/^data:image\/[^;]+;base64,/, "") : "";
          encodedTotal += encoded.length;
          if (!encoded || encoded.length > 5_600_000) return jsonResponse({ success: false, error: "Each photo must be 4 MB or smaller." }, 400);
        }
        if (encodedTotal > 14_000_000) return jsonResponse({ success: false, error: "Total photo size must be under 10 MB per memory." }, 400);
        const photoFiles: Array<{ id: string; url: string }> = [];
        for (const photo of photos) photoFiles.push(await uploadSharedMemoryPhoto(tokenData.access_token, photo));
        // Store both Drive file IDs and URLs so photos can be located from the sheet later.
        const photoIdsValue = photoFiles.length ? JSON.stringify(photoFiles) : "";
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
              photoIdsValue,
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
            photo_ids: photoIdsValue,
          },
        });
      } catch (error) {
        return jsonResponse(
          { success: false, error: error instanceof Error ? error.message : "An unexpected error occurred while accessing memories." },
          500,
        );
      }
    }
    
    // Per-photo comments and emoji reactions are stored separately from the
    // original TRIP_MEMORIES records and Google Drive photo files.
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/memory-interactions") {
      const session = await readSession(request, env);
      if (!session) return jsonResponse({ success: false, error: "Authentication required." }, 401);
      if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return jsonResponse({ success: false, error: "Invalid request origin." }, 403);
      try {
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        const trip = await resolveTrip(request, env, typeof body.tripId === "string" ? body.tripId : undefined);
        if (!trip) return jsonResponse({ success: false, error: "Select a valid trip first." }, 404);
        const token = await googleAccessToken(session, env);
        const tab = "TRIP_MEMORY_INTERACTIONS";
        const headers = ["interaction_id", "memory_id", "photo_id", "kind", "value", "author_email", "created_at"];
        await ensureSheetTab(token, trip.sheetId, tab, headers);
        const range = `${quoteSheetTab(tab)}!A:G`;
        const read = await fetch(sheetsValuesUrl(trip.sheetId, range), { headers: { Authorization: `Bearer ${token}` } });
        if (!read.ok) return jsonResponse({ success: false, error: "Could not read photo comments and reactions." }, 502);
        const data = await read.json() as { values?: unknown[][] };
        const rows = data.values || [];        
        if (request.method === "GET") {
          const interactions = rows.slice(1).filter((row) => String(row[1] || "").trim() && String(row[2] || "").trim() && String(row[4] || "").trim()).map((row) => ({ interaction_id: String(row[0] || ""), memory_id: String(row[1] || ""), photo_id: String(row[2] || ""), kind: String(row[3] || ""), value: String(row[4] || ""), author: String(row[5] || "").toLowerCase() === "koochanyee@gmail.com" ? "Ralph" : String(row[5] || "").toLowerCase() === "wookahwai@gmail.com" ? "June" : "Traveller", created_at: String(row[6] || "") }));
          return jsonResponse({ success: true, interactions });
        }
        const action = String(body.action || "");
        const memoryId = typeof body.memory_id === "string" ? body.memory_id.trim() : "";
        const photoId = typeof body.photo_id === "string" ? body.photo_id.trim() : "";
        if (!memoryId || memoryId.length > 120 || !photoId || photoId.length > 200) return jsonResponse({ success: false, error: "Invalid memory or photo reference." }, 400);
        const createdAt = new Date().toISOString();
        if (action === "reaction") {
          const allowed = ["❤️", "😂", "😍", "👍", "🎉", "🥰", "👏"];
          const emoji = typeof body.value === "string" ? body.value : "";
          if (!allowed.includes(emoji)) return jsonResponse({ success: false, error: "Unsupported emoji reaction." }, 400);
          const existingIndex = rows.slice(1).findIndex((row) => String(row[1] || "") === memoryId && String(row[2] || "") === photoId && String(row[3] || "") === "REACTION" && String(row[5] || "").toLowerCase() === session.email.toLowerCase());
          if (existingIndex >= 0) {
            const sheetRow = existingIndex + 2;
            const current = String(rows[sheetRow - 1]?.[4] || "");
            const nextValue = current === emoji ? "" : emoji;
            const update = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!E${sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[nextValue]] }) });
            if (!update.ok) return jsonResponse({ success: false, error: "Could not update emoji reaction." }, 502);
          } else {
            const append = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:G`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[crypto.randomUUID(), memoryId, photoId, "REACTION", emoji, session.email, createdAt]] }) });
            if (!append.ok) return jsonResponse({ success: false, error: "Could not save emoji reaction." }, 502);
          }
          return jsonResponse({ success: true, message: "Reaction updated." });
        }
        if (action === "comment") {
          const comment = typeof body.value === "string" ? body.value.trim() : "";
          if (!comment || comment.length > 1000) return jsonResponse({ success: false, error: "Enter a comment of up to 1,000 characters." }, 400);
          const append = await fetch(`${sheetsValuesUrl(trip.sheetId, `${quoteSheetTab(tab)}!A:G`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [[crypto.randomUUID(), memoryId, photoId, "COMMENT", comment, session.email, createdAt]] }) });
          if (!append.ok) return jsonResponse({ success: false, error: "Could not save comment." }, 502);
          return jsonResponse({ success: true, message: "Comment shared." }, 201);
        }
        return jsonResponse({ success: false, error: "Unsupported interaction." }, 400);
      } catch (error) { return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Could not save photo interaction." }, 500); }
    }

    return jsonResponse(
      { error: "Not Found" },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
