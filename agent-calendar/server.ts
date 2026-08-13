// agent-calendar — a server-to-server Google Calendar v3 demo.
//
// The service-account JSON is supplied only through the daemon vault/env as
// GOOGLE_SERVICE_ACCOUNT_JSON (or its base64 form). It is never read from the
// repository and is never sent to the browser.

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FULL_SCOPE = "https://www.googleapis.com/auth/calendar";
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

type Env = Record<string, string>;
type ServiceAccount = { client_email?: string; private_key?: string; project_id?: string };

let tokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textB64url(value: string): string {
  return b64url(new TextEncoder().encode(value));
}

function pemBytes(pem: string): ArrayBuffer {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

function accountFrom(env: Env): ServiceAccount {
  const encoded = env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const raw = encoded
    ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))
    : env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
  let account: ServiceAccount;
  try { account = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  if (!account.client_email || !account.private_key) {
    throw new Error("service-account JSON must include client_email and private_key");
  }
  return account;
}

async function accessToken(env: Env, scope: string): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const account = accountFrom(env);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${textB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${textB64url(JSON.stringify({
    iss: account.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemBytes(account.private_key!),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64url(new Uint8Array(signature))}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Google token exchange failed (${response.status}): ${body.error_description || body.error || "unknown error"}`);
  }
  tokenCache.set(scope, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 });
  return body.access_token;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function google(env: Env, path: string, init: RequestInit = {}, scope = FULL_SCOPE): Promise<unknown> {
  const token = await accessToken(env, scope);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${CALENDAR_API}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.error_description || `Google Calendar returned ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function calendarId(env: Env): string {
  return encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
}

export async function handler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname === "/api/version") {
      return json(200, { commit: env.VERSION || "development", app: "agent-calendar" });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      const data = await google(env, `/calendars/${calendarId(env)}/events?timeMin=${encodeURIComponent(new Date().toISOString())}&singleEvents=true&orderBy=startTime`);
      return json(200, { events: (data as { items?: unknown[] }).items || [] });
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const input = await req.json();
      if (!input?.summary || !input?.start || !input?.end) return json(400, { error: "summary, start, and end are required" });
      const event = await google(env, `/calendars/${calendarId(env)}/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          summary: input.summary, description: input.description || undefined, location: input.location || undefined,
          start: { dateTime: input.start }, end: { dateTime: input.end },
        }),
      });
      return json(201, { event });
    }
    if (req.method === "POST" && url.pathname === "/api/readonly-token") {
      const token = await accessToken(env, READ_SCOPE);
      return json(200, { access_token: token, token_type: "Bearer", scope: READ_SCOPE, calendar_id: env.GOOGLE_CALENDAR_ID || "primary" });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(await Deno.readTextFile(new URL("./public/index.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  } catch (error) {
    return json(502, { error: String(error instanceof Error ? error.message : error) });
  }
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") || 8080) }, (req) => handler(req, Deno.env.toObject()));
}
