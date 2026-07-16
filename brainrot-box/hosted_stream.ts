// Plaintext OpenAI-compatible chat completions for the AESTHETICS-only models (toolsmith /
// compositor) — the paint crew that does NOT hear the room. Wire toolsmith/compositor here ONLY
// when the brief they receive is sanitized (#94: no verbatim transcript). The judge never uses this
// path — every model that hears the room stays on e2ee confidential inference (near_e2ee/chutes_e2ee).
//
// This is the resilience win from #94: when NEAR's e2ee pool browns out, aesthetics can fall back to
// any fast hosted model without weakening the privacy claim, because the brief carries no room words.
export async function hostedStream(
  apiKey: string,
  baseUrl: string,
  model: string,
  body: Record<string, unknown>,
  onDelta: (t: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...body, model, stream: true }),
  });
  if (!r.ok) throw new Error(`hosted ${baseUrl} /chat/completions ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]" || raw === "") continue;
      let ev: any;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      const c = ev.choices?.[0]?.delta?.content;
      if (typeof c === "string" && c) onDelta(c);
    }
  }
}
