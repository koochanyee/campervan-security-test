
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

interface WorkflowInstance {
  id: string;
  status(): Promise<unknown>;
  sendEvent(event: {
    type: "user-approval";
    payload: {
      approved: boolean;
      comment?: string;
    };
  }): Promise<void>;
}

interface WorkflowBinding {
  create(options: {
    params: {
      timestamp: number;
    };
  }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Env {
  GOOGLE_CLIENT_ID: string;
  APPROVED_EMAILS: string;
  SESSION_SECRET: string;
  MY_WORKFLOW: WorkflowBinding;
  WORKFLOW_STATUS: DurableObjectNamespace;

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

    // Require an approved session for workflow APIs and WebSockets.
    if (
      url.pathname.startsWith("/api/workflow/") ||
      url.pathname === "/ws"
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
    }

    // Start a workflow
    if (
      url.pathname === "/api/workflow/start" &&
      request.method === "POST"
    ) {
      try {
        const instance = await env.MY_WORKFLOW.create({
          params: {
            timestamp: Date.now(),
          },
        });

        return jsonResponse({
          instanceId: instance.id,
          message: "Workflow started successfully",
        });
      } catch {
        return jsonResponse(
          { error: "Failed to start workflow" },
          500,
        );
      }
    }

    // Read workflow status
    if (
      url.pathname.startsWith("/api/workflow/status/") &&
      request.method === "GET"
    ) {
      const instanceId = url.pathname.split("/").pop();

      if (!instanceId) {
        return jsonResponse(
          { error: "Instance ID required" },
          400,
        );
      }

      try {
        const instance = await env.MY_WORKFLOW.get(instanceId);
        const status = await instance.status();

        return jsonResponse({ status });
      } catch {
        return jsonResponse(
          { error: "Failed to get workflow status" },
          500,
        );
      }
    }

    // Send an event to a workflow
    if (
      url.pathname.startsWith("/api/workflow/event/") &&
      request.method === "POST"
    ) {
      const instanceId = url.pathname.split("/").pop();

      if (!instanceId) {
        return jsonResponse(
          { error: "Instance ID required" },
          400,
        );
      }

      let body: {
        approved: boolean;
        comment?: string;
      };

      try {
        body = await request.json() as {
          approved: boolean;
          comment?: string;
        };
      } catch {
        return jsonResponse(
          { error: "Invalid JSON body" },
          400,
        );
      }

      if (
        typeof body.approved !== "boolean" ||
        (body.comment !== undefined &&
          typeof body.comment !== "string")
      ) {
        return jsonResponse(
          { error: "Invalid workflow event payload" },
          400,
        );
      }

      try {
        const instance = await env.MY_WORKFLOW.get(instanceId);

        await instance.sendEvent({
          type: "user-approval",
          payload: body,
        });

        return jsonResponse({
          success: true,
          message: "Event sent successfully",
        });
      } catch {
        return jsonResponse(
          { error: "Failed to send event" },
          500,
        );
      }
    }

    // WebSocket connection for workflow updates
    if (url.pathname === "/ws") {
      const instanceId = url.searchParams.get("instanceId");

      if (!instanceId) {
        return new Response(
          "instanceId query parameter required",
          { status: 400 },
        );
      }

      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response(
          "Expected Upgrade: websocket",
          { status: 426 },
        );
      }

      try {
        const doId = env.WORKFLOW_STATUS.idFromName(instanceId);
        const stub = env.WORKFLOW_STATUS.get(doId);

        return stub.fetch(request);
      } catch {
        return new Response(
          "Failed to establish WebSocket connection",
          { status: 500 },
        );
      }
    }

    return jsonResponse(
      { error: "Not Found" },
      404,
    );
  },
} satisfies ExportedHandler<Env>;
