
interface Env {
  GOOGLE_CLIENT_ID: string;
}

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string;
  exp?: string;
  iss?: string;
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


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ success: true, service: "campervan-auth-test" });
    }

    if (url.pathname !== "/api/auth/google" || request.method !== "POST") {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    if (!env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: "Server configuration error" }, 500);
    }

    let body: { credential?: unknown };

    try {
      body = await request.json() as { credential?: unknown };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (
      typeof body.credential !== "string" ||
      body.credential.length < 20 ||
      body.credential.length > 10000
    ) {
      return jsonResponse({ error: "Google ID token required" }, 401);
    }

    let tokenResponse: Response;

    try {
      tokenResponse = await fetch(
        "https://oauth2.googleapis.com/tokeninfo?id_token=" +
          encodeURIComponent(body.credential),
      );
    } catch {
      return jsonResponse({ error: "Token verification unavailable" }, 502);
    }

    if (!tokenResponse.ok) {
      return jsonResponse({ error: "Invalid or expired Google ID token" }, 401);
    }

    let token: GoogleTokenInfo;

    try {
      token = await tokenResponse.json() as GoogleTokenInfo;
    } catch {
      return jsonResponse({ error: "Invalid token response" }, 502);
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
      return jsonResponse({ error: "Google identity validation failed" }, 401);
    }

    return jsonResponse({
      success: true,
      user: {
        googleId: token.sub,
        email: token.email,
      },
      message: "Google identity verified; trip access has not been granted.",
    });
  },
};
