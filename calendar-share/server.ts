// calendar-share — the write-side sibling of timeline-peek. A relying-party app signed in
// as the operator's Google Calendar account that mints a share code: a link that lets
// whoever opens it edit ONE specific event on the account's behalf, and nothing else.
// Revocable. Where timeline-peek publishes a read-only feed, this publishes a single-event
// write delegation.
//
// The browser does ALL of the oauth3 work itself — it talks straight to the node's
// /api/google-calendar/* with the scoped `write:event:<id>` token carried in the share URL
// (or the self-provisioned wallet session on the owner path). So this server is
// intentionally just a static file server for index.html: unlike otterpilot there is no
// owner token to keep server-side and nothing to proxy. The delegation envelope — cap
// check, attenuation (write:event:A ≠ write:event:B), audit, revocation — all live in the
// oauth3 node, enforced against the token the client presents.
//
// Serving through a deno entry (rather than a bare static project) mirrors otterpilot /
// feedling-web and lets the page sit at /calendar-share/ beside the node on the same
// origin, with <base href="/calendar-share/"> in the page pinning relative fetches.
//
// Env (ctx.env): OAUTH3_NODE — the pod's oauth3 instance (see project.json). The page
// recomputes the node from location.origin, so this is advisory; it is kept for
// consistency with the rest of the suite.

async function readStatic(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./public/${name}`, import.meta.url));
}

export default async function handler(
  req: Request,
  _ctx: { env: Record<string, string>; dataDir?: string },
): Promise<Response> {
  const path = new URL(req.url).pathname;

  // The daemon strips the /calendar-share/ prefix, so the entry page arrives as "/"
  // (and "/index.html" as a fallback). Everything else 404s: the browser's oauth3 calls
  // target /oauth3, a sibling project on the same origin, not this server.
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(await readStatic("index.html"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}
