// Z.ai GLM-4.5V vision client — swaps the OpenRouter/Claude vision in vision-agent.ts
// for GLM-4.5V on the coding-plan (paas) endpoint. Same OpenAI-compatible image_url+text
// shape. Two jobs: classify an X screen, and locate an element to click/type (pixel coords).

import type { BoundingBox } from './human-mouse.js'

const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/coding/paas/v4'
const ZAI_API_KEY = process.env.ZAI_API_KEY || ''
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4.5v'

async function chat(imageBase64: string, prompt: string, maxTokens = 300): Promise<string> {
  if (!ZAI_API_KEY) throw new Error('ZAI_API_KEY not set')
  const res = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ZAI_API_KEY}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' }, // GLM-4.5V: skip reasoning, we want the JSON only
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  })
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

// GLM sometimes wraps coords in <|begin_of_box|>...<|end_of_box|> or a ```json fence.
function extractJson(text: string): any {
  let t = text.replace(/<\|begin_of_box\|>|<\|end_of_box\|>/g, '')
    .replace(/^```json\s*/im, '').replace(/```\s*$/m, '').trim()
  const m = t.match(/\{[\s\S]*\}/)
  if (m) t = m[0]
  try { return JSON.parse(t) } catch { return null }
}

export interface ScreenAnalysis { type: string; details?: string; confidence: string }

export async function classifyScreen(imageBase64: string): Promise<ScreenAnalysis> {
  const text = await chat(imageBase64, `Classify this X (Twitter) screen. JSON only, no prose:
{"type":"<type>","details":"<details>","confidence":"<high|medium|low>"}
Types: "home_timeline" (logged-in feed), "compose" (tweet composer open), "logged_out" (login/landing),
"challenge" (verify/captcha/suspicious-login), "error", "unknown".`)
  return extractJson(text) ?? { type: 'unknown', confidence: 'low' }
}

// Locate an element. GLM-4.5V returns coordinates NORMALIZED to [0,1000] (per-mille of
// the image), regardless of prompt wording — so we scale by the real image dims. imgW/imgH
// are the actual screenshot pixel dims; the returned box is in viewport pixels.
export async function locateElement(
  imageBase64: string, description: string, imgW: number, imgH: number,
): Promise<BoundingBox | null> {
  const text = await chat(imageBase64,
    `Find the ${description} in this screenshot. Give its CENTER point as JSON only, no prose:
{"x":<cx>,"y":<cy>,"width":<w>,"height":<h>}, each a single integer 0-1000 normalized to image size. If absent, {"x":null}.`)
  // Regex-extract the FIRST number per key — GLM sometimes emits malformed JSON like "x":557,357.
  const t = text.replace(/<\|begin_of_box\|>|<\|end_of_box\|>/g, '')
  const num = (k: string): number | null => { const m = t.match(new RegExp(`"${k}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`)); return m ? parseFloat(m[1]) : null }
  const nx = num('x'), ny = num('y')
  if (nx == null || ny == null) { console.log(`[glm-locate] "${description}" not found: ${text.slice(0, 120)}`); return null }
  const cx = nx / 1000 * imgW, cy = ny / 1000 * imgH
  const w = (num('width') || 64) / 1000 * imgW, h = (num('height') || 40) / 1000 * imgH
  const box = { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
  console.log(`[glm-locate] "${description}" → viewport(${Math.round(cx)},${Math.round(cy)}) ${Math.round(w)}x${Math.round(h)}`)
  return box
}
