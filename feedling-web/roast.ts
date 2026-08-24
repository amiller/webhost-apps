// The cat reads what you actually watched and drafts a roast plus a ≤280-character version of
// it. Drafts only: nothing in this file posts anywhere — the sole outbound call is the same
// OpenRouter completion diary.ts makes, and both results are cached per calendar day.
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

let roastCache: { date: string; text: string } | null = null;
let tweetCache: { date: string; text: string } | null = null;

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

function corpus(titles: string[]): string {
  return titles.slice(0, 40).join("\n") || "(the history page is empty)";
}

export function buildRoastPrompt(titles: string[]): { sys: string; user: string } {
  return {
    sys: "You are a snarky cat who has read your human's watch history. Roast the taste on "
      + "display, not the person: 2-3 specific sentences, funny, present tense. No hashtags, "
      + "no emoji.",
    user: `Watch history (most recent first):\n\n${corpus(titles)}\n\nWrite the roast.`,
  };
}

async function complete(sys: string, user: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: 300,
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

export async function renderRoast(
  titles: string[],
  apiKey: string,
  model: string,
  force = false,
): Promise<string> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const today = todayKey();
  if (!force && roastCache && roastCache.date === today) return roastCache.text;
  const { sys, user } = buildRoastPrompt(titles);
  const text = await complete(sys, user, apiKey, model);
  roastCache = { date: today, text };
  return text;
}

// Cap at 280 without ever cutting a word in half. The 280-cut is on a boundary iff the first
// dropped character starts a new word (whitespace); otherwise the last kept word was cut in
// half, so back off to the previous word end.
function cap280(s: string): string {
  if (s.length <= 280) return s;
  const cut = s.slice(0, 280);
  if (/\s/.test(s[280])) return cut.replace(/\s+$/, "");
  const lastWs = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return lastWs > 0 ? cut.slice(0, lastWs).replace(/\s+$/, "") : cut;
}

export async function draftTweet(
  titles: string[],
  apiKey: string,
  model: string,
  force = false,
): Promise<string> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const today = todayKey();
  if (!force && tweetCache && tweetCache.date === today) return tweetCache.text;
  const sys = "You are a snarky cat. Write ONE post of at most 280 characters roasting the watch "
    + "history below. No hashtags, no emoji, no quotation marks around the post.";
  const user = `Watch history (most recent first):\n\n${corpus(titles)}\n\nWrite the post.`;
  const text = cap280(await complete(sys, user, apiKey, model));
  tweetCache = { date: today, text };
  return text;
}
