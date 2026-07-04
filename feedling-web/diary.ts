import type { Snapshot, PetState } from "./state.ts";

const URL = "https://openrouter.ai/api/v1/chat/completions";

let cache: { date: string; text: string } | null = null;

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

function titles(snaps: Snapshot[]): string {
  return snaps
    .filter((s) => (s as any).shorts?.length)
    .flatMap((s) => (s as any).shorts as { title: string }[])
    .map((x) => x.title)
    .slice(-25)
    .join("\n");
}

export async function renderDiary(
  state: PetState,
  snaps: Snapshot[],
  apiKey: string,
  model: string,
  force = false,
): Promise<string> {
  if (!apiKey) return "(set OPENROUTER_API_KEY to generate a diary)";
  const today = todayKey();
  if (!force && cache && cache.date === today) return cache.text;

  const sys = `You are a cat writing a short playful first-person diary entry for your human.
Keep it 3-4 sentences, warm and a little bratty, present tense. No hashtags, no emoji.`;
  const user = [
    `Cat state: ${state.stateCode} (energy ${state.energy}, vibe ${state.vibe})`,
    `Today: ${state.shortsToday} shorts, longest continuous stretch ${state.continuousMinutes} min`,
    `Recent titles:\n${titles(snaps) || "(unknown)"}`,
    `Write the diary entry.`,
  ].join("\n\n");

  const res = await fetch(URL, {
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
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  cache = { date: today, text };
  return text;
}
