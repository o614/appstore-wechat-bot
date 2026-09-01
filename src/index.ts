import { handleWechat } from "./wechat";

const VERSION = "0.3.1";

function securityHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

function withSecurityHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of securityHeaders()) headers.set(name, value);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function route(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const response = jsonResponse({
      ok: true,
      service: "appstore-wechat-bot",
      version: VERSION,
      environment: env.ENVIRONMENT,
    });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }

  if (url.pathname === "/wechat") {
    return handleWechat(request, {
      token: env.WECHAT_TOKEN,
      state: env.BOT_STATE,
      requestId,
    });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    let response: Response;

    try {
      response = await route(request, env, requestId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "request_failed",
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown_error",
        }),
      );
      response = jsonResponse({ error: "internal_error", requestId }, 500);
    }

    console.log(
      JSON.stringify({
        event: "request_completed",
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    );

    return withSecurityHeaders(response, requestId);
  },
} satisfies ExportedHandler<Env>;
