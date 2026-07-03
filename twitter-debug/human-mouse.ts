// Human-like mouse movement using ghost-cursor's Bezier paths
import { path } from 'ghost-cursor'
import { exec } from 'child_process'
import { promisify } from 'util'

// ghost-cursor's Vector ({x,y}) isn't re-exported from the package root; declare it.
export interface Vector { x: number; y: number }

const execAsync = promisify(exec)

export interface BoundingBox {
  x: number      // left
  y: number      // top
  width: number
  height: number
}

export interface TimedPoint {
  x: number
  y: number
  timestamp: number
}

// Get a random point within a bounding box (not center!)
export function randomPointInBox(box: BoundingBox): Vector {
  // Bias toward center with mild randomness (reduced from 0.6 to 0.3)
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const offsetX = (Math.random() - 0.5) * box.width * 0.3
  const offsetY = (Math.random() - 0.5) * box.height * 0.3
  return {
    x: Math.round(centerX + offsetX),
    y: Math.round(centerY + offsetY)
  }
}

// Generate human-like path between two points
export function generatePath(from: Vector, to: Vector | BoundingBox): TimedPoint[] {
  const target = 'width' in to ? randomPointInBox(to) : to

  // ghost-cursor path with timestamps
  const points = path(from, target, { useTimestamps: true }) as TimedPoint[]
  return points
}

// Add overshoot for distant targets (>400px) - reduced from 300
export function generatePathWithOvershoot(from: Vector, to: Vector | BoundingBox): TimedPoint[] {
  const target = 'width' in to ? randomPointInBox(to) : to
  const dist = Math.sqrt((target.x - from.x) ** 2 + (target.y - from.y) ** 2)

  if (dist > 400) {
    // Overshoot by 2-6% then correct (reduced from 5-15%)
    const overshootFactor = 1 + (0.02 + Math.random() * 0.04)
    const overshoot: Vector = {
      x: from.x + (target.x - from.x) * overshootFactor,
      y: from.y + (target.y - from.y) * overshootFactor
    }

    const toOvershoot = path(from, overshoot, { useTimestamps: true }) as TimedPoint[]
    const baseTime = toOvershoot[toOvershoot.length - 1]?.timestamp || 0

    // Small pause before correction
    const pauseTime = 50 + Math.random() * 100

    const correction = path(overshoot, target, { useTimestamps: true }) as TimedPoint[]
    const correctionAdjusted = correction.map(p => ({
      ...p,
      timestamp: p.timestamp + baseTime + pauseTime
    }))

    return [...toOvershoot, ...correctionAdjusted]
  }

  return path(from, target, { useTimestamps: true }) as TimedPoint[]
}

// Human typing delays - faster for common patterns, slower for special chars
export function getTypingDelay(char: string, prevChar: string): number {
  const base = 50 + Math.random() * 80

  // Special characters are slower
  if (/[!@#$%^&*()_+{}|:"<>?]/.test(char)) return base + 100 + Math.random() * 150

  // Numbers slightly slower
  if (/\d/.test(char)) return base + 30 + Math.random() * 50

  // Common bigrams are faster (muscle memory)
  const bigram = prevChar + char
  const fastBigrams = ['th', 'he', 'in', 'er', 'an', 'on', 'at', 'en', 'nd', 'st', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar', 'ou']
  if (fastBigrams.includes(bigram.toLowerCase())) return base * 0.7

  // Occasional longer pause (thinking)
  if (Math.random() < 0.05) return base + 200 + Math.random() * 300

  return base
}

// Execute path via xdotool (moves actual X11 cursor)
export async function executePath(
  envoyUrl: string,
  points: TimedPoint[],
  onProgress?: (i: number, total: number) => void
): Promise<void> {
  if (points.length === 0) return

  // ghost-cursor returns absolute timestamps - convert to relative delays
  const startTime = points[0].timestamp
  let lastRelativeTime = 0

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const relativeTime = p.timestamp - startTime
    const delay = relativeTime - lastRelativeTime

    // Sanity check - delays should be small (0-100ms typically)
    if (delay > 0 && delay < 500) {
      await sleep(delay)
    } else if (i > 0) {
      // Fallback to fixed small delay if timestamps seem wrong
      await sleep(5 + Math.random() * 15)
    }

    // Move actual X11 cursor with xdotool
    await execAsync(`xdotool mousemove ${Math.round(p.x)} ${Math.round(p.y)}`)

    lastRelativeTime = relativeTime
    onProgress?.(i + 1, points.length)
  }
}

// Type into the ALREADY-focused field (X's /compose/post auto-focuses the textarea). No mouse
// click — an errant focus-click was intermittently blurring the composer and dropping keystrokes.
const KEYMAP: Record<string, string> = {
  ' ': 'space', '\t': 'Tab', '\n': 'Return', '.': 'period', ',': 'comma', '-': 'minus', '=': 'equal',
  '/': 'slash', '\\': 'backslash', "'": 'apostrophe', ';': 'semicolon', '`': 'grave', '[': 'bracketleft', ']': 'bracketright',
  '!': 'shift+1', '@': 'shift+2', '#': 'shift+3', '$': 'shift+4', '%': 'shift+5', '^': 'shift+6', '&': 'shift+7', '*': 'shift+8',
  '(': 'shift+9', ')': 'shift+0', '_': 'shift+minus', '+': 'shift+equal', '{': 'shift+bracketleft', '}': 'shift+bracketright',
  '|': 'shift+backslash', '~': 'shift+grave', ':': 'shift+semicolon', '"': 'shift+apostrophe', '<': 'shift+comma', '>': 'shift+period', '?': 'shift+slash',
}
export async function typeText(text: string, focus: Vector): Promise<void> {
  // Click to focus the textarea (xdotool mouse-click DOES focus it), THEN per-char `xdotool key`
  // (this env honors `key` but not `xdotool type`, and autofocus doesn't hold without a click).
  await execAsync(`xdotool mousemove ${Math.round(focus.x)} ${Math.round(focus.y)}`); await sleep(150)
  await execAsync(`xdotool click 1`); await sleep(450)
  await execAsync(`xdotool key --clearmodifiers ctrl+a`); await sleep(80)
  await execAsync(`xdotool key --clearmodifiers Delete`); await sleep(80)
  for (const ch of text) { await sleep(30 + Math.random() * 40); await execAsync(`xdotool key --clearmodifiers ${KEYMAP[ch] || ch}`) }
}

// Submit the composed tweet via X's own keyboard shortcut. In this container XTEST focuses inputs
// but doesn't fire the React Post button's onClick — keyboard input (proven to work) does. The
// textarea is focused after typing, so Ctrl+Enter posts.
export async function submitCompose(): Promise<void> {
  await execAsync(`xdotool key --clearmodifiers ctrl+Return`)
}

// Precise click: move the X11 cursor EXACTLY to a point, then click. For small targets (the Post
// button) the bezier humanClick's overshoot left the cursor a few px off → no onClick fired.
export async function clickPoint(pt: Vector): Promise<void> {
  await execAsync(`xdotool mousemove ${Math.round(pt.x)} ${Math.round(pt.y)}`); await sleep(180)
  await execAsync(`xdotool click 1`)
}

// Human-like click: move to random point in element, pause, click
export async function humanClick(
  envoyUrl: string,
  currentPos: Vector,
  targetBox: BoundingBox
): Promise<Vector> {
  const clickPoint = randomPointInBox(targetBox)
  console.log(`[click] box=(${targetBox.x},${targetBox.y} ${targetBox.width}x${targetBox.height}) → click=(${clickPoint.x},${clickPoint.y})`)
  const points = generatePathWithOvershoot(currentPos, clickPoint)

  await executePath(envoyUrl, points)

  // Small pause before click (human reaction)
  await sleep(30 + Math.random() * 70)

  // Click with xdotool
  await execAsync('xdotool click 1')

  return clickPoint
}

// Human-like typing: click field, type with variable delays
export async function humanType(
  envoyUrl: string,
  currentPos: Vector,
  targetBox: BoundingBox,
  text: string
): Promise<Vector> {
  // Move to field and click to focus
  const clickPoint = await humanClick(envoyUrl, currentPos, targetBox)

  // Let the field actually take focus before typing — per-char typing while the composer was
  // still settling dropped the leading characters ("having some " lost, only "#coffee" landed).
  await sleep(600 + Math.random() * 200)
  await execAsync(`xdotool key --clearmodifiers ctrl+a`)
  await sleep(80)
  await execAsync(`xdotool key --clearmodifiers Delete`)
  await sleep(80)

  // Atomic `xdotool type` — one reliable keystroke stream (handles spaces, #, punctuation),
  // fast enough to land entirely after the field is ready. Single-quote-escape the payload.
  const esc = text.replace(/'/g, `'\\''`)
  await execAsync(`xdotool type --clearmodifiers --delay 45 -- '${esc}'`)

  return clickPoint
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
