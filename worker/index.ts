
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
  MY_WORKFLOW: WorkflowBinding;
  WORKFLOW_STATUS: DurableObjectNamespace;
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

    // Health check
    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        success: true,
        service: "campervan-auth-test",
      });
    }

    // Google ID token verification
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) {
        return jsonResponse(
          { error: "M3 preview cannot read GOOGLE_CLIENT_ID" },
          500,
        );
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
        return jsonResponse(
          { error: "Google identity validation failed" },
          401,
        );
      }

      return jsonResponse({
        success: true,
        user: {
          googleId: token.sub,
          email: token.email,
        },
        message:
          "Google identity verified; trip access has not been granted.",
      });
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
    if (url.pathname.startsWith("/api/workflow/status/")) {
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

      try {
        const body = await request.json() as {
          approved: boolean;
          comment?: string;
        };

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
        return new Response("Expected Upgrade: websocket", {
          status: 426,
        });
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

    return jsonResponse({ error: "Not Found" }, 404);
  },
} satisfies ExportedHandler<Env>;
