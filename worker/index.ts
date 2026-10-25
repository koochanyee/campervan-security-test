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

    
    // Read the signed-in user's Google Sheets itinerary.
    if (request.method === "GET" && url.pathname === "/api/itinerary") {
      const session = await readSession(request, env);

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
        !env.GOOGLE_SHEET_ID ||
        !env.GOOGLE_SHEET_TAB ||
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
          `'${env.GOOGLE_SHEET_TAB.replace(/'/g, "''")}'!A:ZZZ`;

        const sheetUrl =
          `https://sheets.googleapis.com/v4/spreadsheets/` +
          `${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/` +
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
            `${encodeURIComponent(env.GOOGLE_SHEET_ID)}` +
            `?fields=sheets.properties.title`;

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
              `${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values:batchGet`,
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
    
    return jsonResponse(
      { error: "Not Found" },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
