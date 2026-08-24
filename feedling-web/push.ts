import { allSubs, removeSub } from "./store.ts";

// web-push transitively reads process.env.ECE_KEYLOG when it loads; under the daemon's
// --deny-env sandbox that read throws NotCapable. Swallow the optional keylog read (config
// arrives via ctx.env, an arg — not Deno.env — so this affects nothing real), then load web-push.
try {
  const _get = Deno.env.get.bind(Deno.env);
  Deno.env.get = (k: string) => { try { return _get(k); } catch { return undefined; } };
} catch { /* env not overridable */ }
const webpush: any = (await import("npm:web-push@3.6.7")).default;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let vapid: VapidConfig | null = null;

export function configurePush(v: VapidConfig) {
  vapid = v;
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
}

export function vapidPublicKey(): string {
  if (!vapid) throw new Error("push not configured");
  return vapid.publicKey;
}

export interface PushReport {
  sent: number;
  pruned: number;
  details: { endpoint: string; ok: boolean; status?: number; body?: string; headers?: Record<string, string>; error?: string }[];
}

export interface PushExtra {
  image?: string;
  actions?: { action: string; title: string }[];
  variant?: string;
  probeId?: string;
}

export async function pushAll(title: string, body: string, url = "", extra: PushExtra = {}): Promise<PushReport> {
  if (!vapid) throw new Error("push not configured");
  const payload = JSON.stringify({ title, body, url, ...extra });
  let sent = 0, pruned = 0;
  const details: PushReport["details"] = [];
  for (const sub of allSubs()) {
    const short = sub.endpoint.slice(0, 60) + "...";
    try {
      const r = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys } as any,
        payload,
        { TTL: 60, urgency: "high" } as any,
      );
      sent++;
      details.push({
        endpoint: short, ok: true,
        status: (r as any)?.statusCode,
        body: (r as any)?.body,
        headers: (r as any)?.headers,
      });
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        await removeSub(sub.endpoint);
        pruned++;
      }
      details.push({
        endpoint: short, ok: false,
        status: code,
        body: e?.body,
        error: e?.message,
      });
      console.error("[push] send failed:", code, e?.body || e?.message);
    }
  }
  return { sent, pruned, details };
}
