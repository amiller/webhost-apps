// oauth3-sdk — the consume side of OAuth3.
//
// An app holds a scoped read token (or runs the connect() handshake to get one),
// and reads a user's data through an OAuth3 instance. It never sees the raw
// cookie jar. Mirror image of oauth3-extension, which is the ingest side.

import type {
  ConnectRequest,
  ConnectStatus,
  PluginInfo,
  PluginItem,
} from "./types.ts";

export interface Oauth3Options {
  /** Base URL of the OAuth3 instance, e.g. https://<node> or http://localhost:3000 */
  node: string;
  /** Scoped read token — the normal credential for an app. */
  token?: string;
  /** Owner secret — dev/admin only. Mints tokens and reads everything. */
  ownerSecret?: string;
  /** Override fetch (tests, custom runtimes without a global fetch). */
  fetch?: typeof fetch;
}

export interface ConnectOptions {
  plugin: string;
  /** Attribution carried by the token, e.g. the transcriber's handle. */
  subject?: string;
  /** App identifier shown to the user on the approval screen. */
  app?: string;
  /** Surface the URL the user must visit to approve (print it / redirect to it). */
  onApproveUrl?: (url: string) => void | Promise<void>;
  intervalMs?: number; // poll cadence, default 2000
  timeoutMs?: number; // give up after, default 300000
}

export class Oauth3Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "Oauth3Error";
  }
}

/** Scoped accessor for one plugin: `oa.plugin("otter").list()`. */
export class PluginClient {
  constructor(
    private readonly client: Oauth3Client,
    readonly id: string,
  ) {}
  list(): Promise<PluginItem[]> {
    return this.client.list(this.id);
  }
  fetch(itemId: string): Promise<unknown> {
    return this.client.fetch(this.id, itemId);
  }
}

export class Oauth3Client {
  readonly node: string;
  private token?: string;
  private readonly ownerSecret?: string;
  private readonly _fetch: typeof fetch;

  constructor(opts: Oauth3Options) {
    if (!opts.node) throw new Oauth3Error("node URL is required");
    this.node = opts.node.replace(/\/+$/, "");
    this.token = opts.token;
    this.ownerSecret = opts.ownerSecret;
    this._fetch = opts.fetch ?? fetch;
  }

  /** The scoped token in hand, if any (set directly or via connect()). */
  get currentToken(): string | undefined {
    return this.token;
  }

  private async req(
    path: string,
    init: RequestInit & { owner?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = { ...(init.headers as any) };
    if (init.owner) {
      if (!this.ownerSecret) {
        throw new Oauth3Error(`${path} requires ownerSecret`);
      }
      headers.Authorization = `Bearer ${this.ownerSecret}`;
    } else {
      const bearer = this.token ?? this.ownerSecret;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
    }
    const r = await this._fetch(`${this.node}${path}`, { ...init, headers });
    const text = await r.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // non-JSON (e.g. a plain "not found") — keep it as the message
      }
    }
    if (!r.ok) {
      const msg = body?.error ?? (typeof body === "string" && body ? body : r.statusText);
      throw new Oauth3Error(msg, r.status, body);
    }
    return body;
  }

  /** GET /api/plugins — what this instance can read, and jar status. */
  async plugins(): Promise<PluginInfo[]> {
    return (await this.req("/api/plugins")).plugins;
  }

  plugin(id: string): PluginClient {
    return new PluginClient(this, id);
  }

  /** GET /api/:plugin/items */
  async list(plugin: string): Promise<PluginItem[]> {
    return (await this.req(`/api/${plugin}/items`)).data;
  }

  /** GET /api/:plugin/items/:id */
  async fetch(plugin: string, id: string): Promise<unknown> {
    return (await this.req(`/api/${plugin}/items/${encodeURIComponent(id)}`))
      .data;
  }

  /** Owner-only: mint a scoped read token bound to a plugin (+ optional subject). */
  async mint(plugin: string, subject?: string): Promise<string> {
    const b = await this.req("/api/tokens", {
      owner: true,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin, subject }),
    });
    return b.token;
  }

  /**
   * App-authorization handshake. Asks the instance for access to `plugin`,
   * surfaces an approval URL to the user, polls until they approve, then adopts
   * the returned scoped token so subsequent list()/fetch() calls Just Work.
   *
   * Server contract (implemented — connect → approve → token):
   *   POST /api/connect                    { plugin, subject?, app? } -> { requestId, approveUrl }
   *   GET  /api/connect/:requestId                                    -> ConnectStatus
   *   POST /api/connect/:requestId/approve                            -> approves, mints token
   */
  async connect(opts: ConnectOptions): Promise<string> {
    // Provider-preferred: if the OAuth3 wallet (extension) is present, let it carry
    // out the whole flow — copy the cookie jar if needed, approve, hand back a token.
    const prov = (globalThis as any).oauth3 ?? (globalThis as any).window?.oauth3;
    if (prov && typeof prov.connect === "function") {
      const token = await prov.connect({ node: this.node, plugin: opts.plugin, subject: opts.subject, app: opts.app });
      this.token = token;
      return token;
    }
    // Web fallback (no extension): server connect → user approves in their signed-in
    // room at approveUrl → poll until the token comes back.
    const reqRes: ConnectRequest = await this.req("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plugin: opts.plugin,
        subject: opts.subject,
        app: opts.app,
      }),
    });
    await opts.onApproveUrl?.(reqRes.approveUrl);

    const interval = opts.intervalMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const s: ConnectStatus = await this.req(`/api/connect/${reqRes.requestId}`);
      if (s.status === "approved") {
        this.token = s.token;
        return s.token;
      }
      if (s.status === "denied") {
        throw new Oauth3Error("connect denied by user");
      }
    }
    throw new Oauth3Error("connect timed out");
  }
}

export function oauth3(opts: Oauth3Options): Oauth3Client {
  return new Oauth3Client(opts);
}

export type { PluginInfo, PluginItem, ConnectRequest, ConnectStatus } from "./types.ts";
