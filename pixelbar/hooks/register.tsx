import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, ModelUsage, Register, SessionRateLimit, SessionUsage, StateDollar } from 'claude-code'

import type { PixelbarBadge, PixelbarCache, PixelbarFile, PixelbarFocus, PixelbarPace, PixelbarTotals, PixelbarTurn } from '../types'

// Status bar++: one Raster above the prompt, repainted ~8 times a second
// with $.ui.blit. Left: an animated pixel Clawd. Right: three rows of info.

const ROWS = 4
const KEY = 'bar'
const FRAME_MS = 125
// The crab takes columns 1-11 and its sparks or Z's 12-13; the rest is a gap.
const MASCOT_COLS = 17
const CONTEXT_WARN = [80, 90]
const CONTEXT_REARM = 70

// Kept in the session's state so a reload does not lose them.
const historyAtom = atom({ plugin: 'pixelbar', key: 'history' } as const, [])
const warnedAtom = atom({ plugin: 'pixelbar', key: 'warnedAt' } as const, 0)
const badgeAtom = atom({ plugin: 'pixelbar', key: 'badge' } as const, null)

let badge: PixelbarBadge | null = null

const lastTurnAtom = atom({ plugin: 'pixelbar', key: 'lastTurn' } as const, null)

// The turn in progress (main conversation only), and the last one finished.
type TurnStats = {
  at: number
  tools: number
  files: Set<string>
  added: number
  removed: number
  costAtStart: number
  // Input tokens of the turn's responses: read from, written to and outside the prompt cache.
  read: number
  write: number
  fresh: number
}
let turn: TurnStats | undefined
let lastTurn: PixelbarTurn | null = null

// ---------- focus timer ----------

const focusAtom = atom({ plugin: 'pixelbar', key: 'focus' } as const, null)
// Not "focus": Claude Code has a built-in /focus.
const FOCUS_COMMAND = 'focus-timer'
const FOCUS_DEFAULT_MIN = 25
const FOCUS_MAX_MIN = 600
const RING = ['○', '◔', '◑', '◕', '●']

let focus: PixelbarFocus | null = null

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ---------- uncommitted-work nudge ----------

const dirtySinceAtom = atom({ plugin: 'pixelbar', key: 'dirtySince' } as const, null)
const NUDGE_MS = 30 * 60_000
const NUDGE_FILES = 10

let dirtySince: number | null = null

// ---------- 5h pace ----------

const paceAtom = atom({ plugin: 'pixelbar', key: 'pace' } as const, null)
const PACE_MIN_MS = 5 * 60_000
const PACE_MIN_POINTS = 1

let pace: PixelbarPace | null = null

// A new baseline when the window resets (or drops, as after a reset).
function nextPace(limits: SessionRateLimit[], now: number): PixelbarPace | null {
  const lim = limits.find(l => l.kind === 'five_hour')
  if (!lim) return pace
  if (!pace || pace.resetsAt !== lim.resetsAt || lim.percentUsed < pace.pct) {
    return { at: now, pct: lim.percentUsed, resetsAt: lim.resetsAt }
  }
  return pace
}

// Context, limits and cost from the session's usage or a measure event (the
// same shape), then the pace of the 5-hour limit.
async function applyUsage(
  $: StateDollar,
  u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>,
) {
  data.window = u.context.window
  data.tokens = u.context.tokens
  data.percent = u.context.percent
  data.limits = u.rateLimits
  data.cost = u.cost?.usd
  await trackPace($)
}

async function trackPace($: StateDollar) {
  const found = nextPace(data.limits, Date.now())
  if (found === pace) return
  pace = found
  await update($, paceAtom, () => found)
}

// How long until the 5h window runs out at this session's pace, when that
// comes before it resets; undefined while the pace is unknown or safe.
function paceLeft(now: number): number | undefined {
  const lim = data.limits.find(l => l.kind === 'five_hour')
  if (!lim || !pace || now - pace.at < PACE_MIN_MS) return undefined
  const used = lim.percentUsed - pace.pct
  if (used < PACE_MIN_POINTS) return undefined
  const left = ((100 - lim.percentUsed) / used) * (now - pace.at)
  const reset = lim.resetsAt ? Date.parse(lim.resetsAt) - now : Infinity
  return left < reset ? left : undefined
}

// ---------- prompt cache ----------

const cacheAtom = atom({ plugin: 'pixelbar', key: 'cache' } as const, null)
const TTL_5M = 5 * 60_000
const TTL_1H = 60 * 60_000
const TTL_STORE_KEY = 'cacheTtlMs'
// Past this much of the 5-minute TTL, a request that still reads most of the
// last context from the cache shows the TTL is an hour.
const TTL_SLACK_MS = 30_000
const CACHE_SOON_MS = 60_000
const SHIVER_MS = 30_000

let cache: PixelbarCache | null = null

// The session's tokens by kind, which the context bar's colors split by.
const totalsAtom = atom({ plugin: 'pixelbar', key: 'totals' } as const, { read: 0, write: 0, fresh: 0, output: 0 })
let totals: PixelbarTotals = { read: 0, write: 0, fresh: 0, output: 0 }

// A response's tokens by kind, as the bar and the totals count them.
const tokensOf = (u: ModelUsage): PixelbarTotals => ({
  read: u.cache_read_input_tokens,
  write: u.cache_creation_input_tokens,
  fresh: u.input_tokens,
  output: u.output_tokens,
})

async function addToTotals($: StateDollar, u: ModelUsage) {
  const add = tokensOf(u)
  const sum: PixelbarTotals = {
    read: totals.read + add.read,
    write: totals.write + add.write,
    fresh: totals.fresh + add.fresh,
    output: totals.output + add.output,
  }
  totals = sum
  await update($, totalsAtom, () => sum)
}
// Learned once and kept across sessions: from a model switch, which says, or
// from a long pause the cache survived.
let cacheTtl = TTL_5M

// How much of the input the cache served, as a percentage to one decimal,
// rounded down: 100.0 only when the cache served all of it.
function hitRate(read: number, write: number, fresh: number): number | undefined {
  const total = read + write + fresh
  return total > 0 ? Math.floor((read / total) * 1000) / 10 : undefined
}

// Time left before the cache lapses; undefined before the first response.
function cacheLeft(now: number): number | undefined {
  return cache ? cache.at + cacheTtl - now : undefined
}

async function noteResponse($: Pick<CoreEngineInterface, 'state' | 'store'>, u: ModelUsage, sentAt: number) {
  const before = cache
  if (before && cacheTtl < TTL_1H && sentAt - before.at > TTL_5M + TTL_SLACK_MS) {
    const prior = before.read + before.write + before.fresh + before.output
    if (u.cache_read_input_tokens >= prior / 2) {
      cacheTtl = TTL_1H
      await $.store.set(TTL_STORE_KEY, TTL_1H).catch(() => {})
    }
  }
  const now: PixelbarCache = { ...tokensOf(u), at: sentAt }
  cache = now
  await update($, cacheAtom, () => now)
  if (turn) {
    turn.read += now.read
    turn.write += now.write
    turn.fresh += now.fresh
  }
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

// ---------- files pane ----------

const filesAtom = atom({ plugin: 'pixelbar', key: 'files' } as const, [])
const selectedAtom = atom({ plugin: 'pixelbar', key: 'selectedFile' } as const, null)
const FILES_COMMAND = 'session-files'
const FILES_PANE = 'pixelbar-files'
const openFiles = ($: CoreEngineInterface) => $.ui.open({ id: FILES_PANE, title: 'Session files', closeOnEscape: true })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const MAX_FILES = 200
const MAX_PATCHES = 30

// An Edit's or Write's hunks; a new file with no patch is all added lines.
function hunksOf(hunks: readonly Hunk[], created?: string): readonly Hunk[] {
  if (hunks.length > 0 || created === undefined) return hunks
  const lines = created.split('\n').map(l => '+' + l)
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
}

// The header's counts come from the lines themselves, so the diff always parses.
function patchOf(h: Hunk): string {
  const oldLines = h.lines.filter(l => !l.startsWith('+')).length
  const newLines = h.lines.filter(l => !l.startsWith('-')).length
  return `@@ -${h.oldStart},${oldLines} +${h.newStart},${newLines} @@\n${h.lines.join('\n')}`
}

function withEdit(files: PixelbarFile[], path: string, added: number, removed: number, patches: string[]): PixelbarFile[] {
  const old = files.find(f => f.path === path)
  const file: PixelbarFile = {
    path,
    added: (old?.added ?? 0) + added,
    removed: (old?.removed ?? 0) + removed,
    patches: [...(old?.patches ?? []), ...patches].slice(-MAX_PATCHES),
  }
  return [...files.filter(f => f.path !== path), file].slice(-MAX_FILES)
}

// A path as the person reads it: relative to the session's folder when inside it.
function shownPath(p: string): string {
  if (data.cwd && p.startsWith(data.cwd + '/')) return p.slice(data.cwd.length + 1)
  return prettyPath(p, data.home, 200)
}

// Lines added and removed by an Edit or Write, from the patch it reported.
function countLines(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// Colors (0x00RRGGBB); DEF is the terminal's own color.
const DEF = 0x01000000
const ORANGE = 0xd97757
const ORANGE_LIGHT = 0xf0a080
const ORANGE_DARK = 0xa8553a
const GRAY = 0x8a8a8a
const DARK = 0x585858
const TRACK = 0x3a3a3a
const BLUE = 0x5fafff
const GOLD = 0xd7af5f
const BRANCH = 0xafd787
const CYAN = 0x5fd7ff
const GREEN = 0x5fff5f
const YELLOW = 0xffd700
const AMBER = 0xff8700
const RED = 0xff3030
const WHITE = 0xffffff
const SWEAT = 0x87d7ff
const LID = 0x3a1f14
// The context bar's parts: read from the cache, written to it, and new.
const CACHE_READ = 0x5f87d7
const CACHE_WRITE = 0xd7af00
const CACHE_NEW = 0xd75f5f

type Git = { branch: string; dirty: number; ahead: number; hasUpstream: boolean }

type Data = {
  model: string
  effort?: string
  window: number
  tokens?: number
  percent?: number
  limits: SessionRateLimit[]
  cost?: number
  cwd: string
  home?: string
  startedAt?: number
  git?: Git
  history: number[]
}

const data: Data = { model: '', window: 0, limits: [], cwd: '', history: [] }
let bandId: string | undefined
let cols = 0
let isWorking = false
let isHidden = false
let tick = 0

// ---------- color helpers ----------

function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (s: number) => {
    const x = (a >> s) & 0xff
    const y = (b >> s) & 0xff
    return Math.round(x + (y - x) * k) << s
  }
  return ch(16) | ch(8) | ch(0)
}

function heat(t: number): number {
  if (t < 0.4) return mix(GREEN, YELLOW, t / 0.4)
  if (t < 0.7) return mix(YELLOW, AMBER, (t - 0.4) / 0.3)
  return mix(AMBER, RED, (t - 0.7) / 0.3)
}

function step(value: number, cuts: [number, number, number]): number {
  if (value < cuts[0]) return GREEN
  if (value < cuts[1]) return YELLOW
  if (value < cuts[2]) return AMBER
  return RED
}

// ---------- canvas ----------

// The code point of a printable width-1 BMP character, else '?': a Raster
// refuses the whole band over one wide or control character (an emoji branch
// name, a CJK folder).
function cellCode(ch: string): number {
  const c = ch.codePointAt(0) ?? 0x20
  const isWide =
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
  return c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xffff || isWide ? 0x3f : c
}

class Canvas {
  readonly words: Uint32Array
  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.words = new Uint32Array(cols * rows * 3)
    for (let i = 0; i < cols * rows; i++) {
      this.words[i * 3] = 0x20
      this.words[i * 3 + 1] = DEF
      this.words[i * 3 + 2] = DEF
    }
  }

  put(x: number, y: number, ch: string, fg: number, bg = DEF) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = (y * this.cols + x) * 3
    this.words[i] = cellCode(ch)
    this.words[i + 1] = fg
    this.words[i + 2] = bg
  }

  text(x: number, y: number, s: string, fg: number | ((i: number) => number)): number {
    let i = 0
    for (const ch of s) {
      this.put(x + i, y, ch, typeof fg === 'number' ? fg : fg(i))
      i++
    }
    return x + i
  }

  encode(): string {
    return base64(new Uint8Array(this.words.buffer))
  }
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// ---------- the mascot: an 11x6 pixel grid drawn with half blocks ----------

type Px = number | null

type Mood = 'idle' | 'working' | 'celebrate' | 'worried' | 'sleeping'

// `hot` (0 to 1) turns the crab red as the context window fills.
function mascot(t: number, mood: Mood, hot: number): Px[][] {
  const W = 11
  const H = 6
  const g: Px[][] = Array.from({ length: H }, () => Array<Px>(W).fill(null))
  const set = (x: number, y: number, c: Px) => {
    const row = g[y]
    if (row && x >= 0 && x < W) row[x] = c
  }
  // The crab's shell, highlight and legs, reddening as context fills.
  const shell = mix(ORANGE, RED, hot)
  const shine = mix(ORANGE_LIGHT, RED, hot)
  const legShade = mix(ORANGE_DARK, RED, hot * 0.7)
  const phase = Math.floor(t / 2) % 2

  let bob = Math.floor(t / 10) % 2
  if (mood === 'working') bob = phase
  else if (mood === 'celebrate') bob = t % 2
  else if (mood === 'sleeping') bob = 1
  else if (mood === 'worried') bob = 0

  let isBlinking = t % 36 < 2
  if (mood === 'working') isBlinking = t % 24 === 0
  else if (mood === 'sleeping') isBlinking = true
  else if (mood === 'celebrate') isBlinking = false

  let look = [0, 0, 0, 1, 1, 0, -1, -1][Math.floor(t / 24) % 8]!
  if (mood === 'working' || mood === 'celebrate') look = 0
  else if (mood === 'worried') look = Math.floor(t / 3) % 2 === 0 ? -1 : 1

  for (let x = 2; x <= 8; x++) set(x, bob, x === 2 || x === 8 ? shell : shine)
  for (let x = 2; x <= 8; x++) set(x, 1 + bob, shell)
  if (!isBlinking) {
    set(3 + look, 1 + bob, null)
    set(7 + look, 1 + bob, null)
  }
  for (let x = 0; x <= 10; x++) set(x, 2 + bob, shell)
  for (let x = 2; x <= 8; x++) set(x, 3 + bob, shell)

  if (mood === 'working') {
    // Wave the claws in turn.
    const arm = phase === 0 ? 0 : 10
    set(arm, 2 + bob, null)
    set(arm, 1 + bob, shell)
  } else if (mood === 'celebrate') {
    // Both claws up.
    for (const arm of [0, 10]) {
      set(arm, 2 + bob, null)
      set(arm, 1 + bob, shell)
      set(arm, bob, shell)
    }
  } else if (mood === 'sleeping') {
    // Claws tucked in.
    set(0, 2 + bob, null)
    set(10, 2 + bob, null)
  } else if (mood === 'worried') {
    // A nervous shuffle of the claws.
    const arm = t % 4 < 2 ? 0 : 10
    set(arm, 2 + bob, null)
    set(arm, 3 + bob, shell)
  }

  const isWalking = mood === 'working' || mood === 'celebrate'
  const legs = isWalking && phase === 1 ? [3, 5, 7] : [2, 4, 6, 8]
  for (const x of legs) set(x, 4 + bob, legShade)
  return g
}

// `dx` shifts the body sideways (a shiver).
function drawMascot(c: Canvas, t: number, mood: Mood, hot: number, dx = 0) {
  const g = mascot(t, mood, hot)
  for (let row = 0; row < ROWS; row++) {
    for (let x = 0; x < 11; x++) {
      const top = g[row * 2]?.[x] ?? null
      const bot = g[row * 2 + 1]?.[x] ?? null
      if (top === null && bot === null) continue
      if (top !== null && bot !== null) {
        if (top === bot) c.put(x + 1 + dx, row, '█', top)
        else c.put(x + 1 + dx, row, '▀', top, bot)
      } else if (top !== null) c.put(x + 1 + dx, row, '▀', top)
      else c.put(x + 1 + dx, row, '▄', bot!)
    }
  }
  if (mood === 'working') {
    // Pixel sparks drifting up beside the mascot.
    const sparks = ['·', '+', '*', '+', '·']
    for (let s = 0; s < 2; s++) {
      const life = (t + s * 5) % 10
      if (life >= sparks.length) continue
      const y = 2 - Math.floor(life / 2)
      const x = 12 + ((t + s * 3) % 2)
      c.put(x, y, sparks[life]!, mix(YELLOW, ORANGE, life / sparks.length))
    }
  } else if (mood === 'celebrate') {
    // Confetti on both sides.
    const confetti = [GOLD, GREEN, CYAN, WHITE, ORANGE_LIGHT]
    for (let s = 0; s < 4; s++) {
      const y = (t + s * 2) % 3
      const x = s % 2 === 0 ? 12 + (s % 4 === 0 ? 0 : 1) : 0
      c.put(x, y, s % 2 ? '*' : '+', confetti[(t + s) % confetti.length]!)
    }
  } else if (mood === 'sleeping') {
    // Closed eyes: a dark lid line drawn across each eye's cell. Asleep the
    // crab sits low (bob 1), so its eye row is pixel row 2: cell row 1.
    for (const eyeX of [3, 7]) {
      const face = g[2]?.[eyeX]
      if (face != null) c.put(eyeX + 1 + dx, 1, '━', LID, face)
    }
    // Z's floating up.
    const z = Math.floor(t / 4) % 3
    c.put(12 + (z % 2), 2 - z, z === 2 ? 'Z' : 'z', mix(GRAY, DARK, z / 3))
  }
  if (hot > 0.3 || mood === 'worried') {
    // A sweat drop sliding down beside the head.
    const y = Math.floor(t / 3) % 3
    c.put(12, y, y === 0 ? '˙' : '·', SWEAT)
  }
}

// ---------- formatting ----------

function k(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

function span(ms: number): string {
  let s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

// A turn's length to the second: "45s", "2m14s", then as span() past an hour.
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return span(ms)
}

function prettyModel(raw: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(raw)
  if (!m) return raw
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return m[3] && m[3].length <= 2 ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

function prettyPath(p: string, home: string | undefined, room: number): string {
  let s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p
  if (s.length > room) {
    const parts = s.split('/')
    s = '…/' + parts.slice(-2).join('/')
  }
  return s
}

// ---------- bars & sparkline ----------

const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

type Segment = { share: number; color: number }

// One cell of a bar: `left` over its first `split` eighths, `right` over the
// rest (TRACK is the empty track).
type BarCell = { left: number; right: number; split: number }

// Runs of colors, `sizes` in eighths, drawn into `width` cells with the track
// after them; undefined when a cell would need more than two colors.
function runCells(sizes: number[], colors: number[], width: number): BarCell[] | undefined {
  const at = (slot: number) => {
    let end = 0
    for (let i = 0; i < sizes.length; i++) {
      end += sizes[i]!
      if (slot < end) return colors[i]!
    }
    return TRACK
  }
  const cells: BarCell[] = []
  for (let i = 0; i < width; i++) {
    const slots = Array.from({ length: 8 }, (_, k) => at(i * 8 + k))
    const split = slots.findIndex(col => col !== slots[0])
    if (split < 0) cells.push({ left: slots[0]!, right: slots[0]!, split: 8 })
    else if (slots.slice(split).some(col => col !== slots[split])) return undefined
    else cells.push({ left: slots[0]!, right: slots[split]!, split })
  }
  return cells
}

// A bar's cells split between `parts`, in order, to the eighth of a cell:
// each part after the first (the thin ones) its exact size, at least an
// eighth when above zero, the first part the rest. A cell holds two colors,
// so where two thin parts would meet inside one cell the fill's end moves
// (less than a cell) until they meet on a cell's edge.
function partCells(parts: Segment[], filled: number, width: number): BarCell[] | undefined {
  const [first, ...thin] = parts
  if (!first || filled === 0) return undefined
  const sizes = thin.map(p => (p.share > 0 ? Math.max(1, Math.round(p.share * filled)) : 0))
  const thinTotal = sizes.reduce((a, b) => a + b, 0)
  const colors = parts.map(p => p.color)
  for (let shift = 0; shift <= 8; shift++) {
    for (const end of shift === 0 ? [filled] : [filled - shift, filled + shift]) {
      if (end <= thinTotal || end > width * 8) continue
      const cells = runCells([end - thinTotal, ...sizes], colors, width)
      if (cells) return cells
    }
  }
  return undefined
}

// Rounded ends: the Powerline half circles. Only Nerd Fonts carry them, and
// elsewhere they draw as boxes, so they are on where the terminal draws them
// itself (or the person says their font has them).
const CAP_LEFT = '\uE0B6'
const CAP_RIGHT = '\uE0B4'
const ROUNDING_TERMINALS = ['ghostty', 'wezterm']
let roundEnds = false

// Whether this session's terminal draws the Powerline glyphs whatever the font.
async function drawsPowerline($: { env: CoreEngineInterface['env'] }): Promise<boolean> {
  const none = () => undefined
  const [program, ghostty, kitty, wezterm] = await Promise.all([
    $.env.get('TERM_PROGRAM').catch(none),
    $.env.get('GHOSTTY_RESOURCES_DIR').catch(none),
    $.env.get('KITTY_WINDOW_ID').catch(none),
    $.env.get('WEZTERM_PANE').catch(none),
  ])
  return ROUNDING_TERMINALS.includes((program ?? '').toLowerCase()) || !!ghostty || !!kitty || !!wezterm
}

// With `parts`, the filled length is split between them in order (shares
// summing to 1); without, it is colored by how full the bar is. With rounded
// ends, `outer` counts them.
function bar(c: Canvas, x: number, y: number, outer: number, pct: number, t: number, working: boolean, parts?: Segment[]): number {
  const caps = roundEnds ? 2 : 0
  const width = Math.max(1, outer - caps)
  if (roundEnds) x++
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * width
  const whole = Math.floor(filled)
  const frac = filled - whole
  const edge = frac > 0.0625 ? Math.max(1, Math.min(7, Math.floor(frac * 8))) : 0
  // By how full the bar is, unless the parts fit (a bar too short for them is too).
  const cells =
    (parts && partCells(parts, Math.round(filled * 8), width)) ??
    Array.from({ length: whole + (edge > 0 ? 1 : 0) }, (_, i): BarCell => {
      const col = heat(width === 1 ? 0 : i / (width - 1))
      return i < whole ? { left: col, right: col, split: 8 } : { left: col, right: TRACK, split: edge }
    })
  const sweep = (t % (width + 8)) - 4
  const glow = (col: number, i: number) =>
    working && col !== TRACK ? mix(col, WHITE, Math.max(0, 0.55 - Math.abs(i - sweep) * 0.2)) : col
  for (let i = 0; i < width; i++) {
    const cell = cells[i] ?? { left: TRACK, right: TRACK, split: 8 }
    const left = glow(cell.left, i)
    const right = glow(cell.right, i)
    if (cell.left === TRACK) c.put(x + i, y, ' ', DEF, TRACK)
    else if (cell.split >= 8 || cell.left === cell.right) c.put(x + i, y, '█', left, TRACK)
    else c.put(x + i, y, EIGHTHS[cell.split - 1]!, left, right)
    if (!roundEnds) continue
    // An end takes the color of the cell's side beside it, the track's while empty.
    if (i === 0) c.put(x - 1, y, CAP_LEFT, left === TRACK ? TRACK : left)
    if (i === width - 1) c.put(x + width, y, CAP_RIGHT, right)
  }
  return x + width + caps / 2
}

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Heights span the values' own range (at least 5 points, so noise stays
// small) so a climb from 8% to 15% shows; colors keep the absolute fill.
const SPARK_MIN_RANGE = 5

function sparkline(c: Canvas, x: number, y: number, values: number[]): number {
  const lo = Math.min(...values)
  const range = Math.max(SPARK_MIN_RANGE, Math.max(...values) - lo)
  values.forEach((v, i) => {
    const level = Math.max(0, Math.min(7, Math.round(((v - lo) / range) * 7)))
    c.put(x + i, y, LEVELS[level]!, heat(v / 100))
  })
  return x + values.length
}

// ---------- the frame ----------

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ---------- moods ----------

const IDLE_SLEEP_MS = 10 * 60_000
const CELEBRATE_MS = 4000
const WORRIED_MS = 5000

// Commands that only look around: their failures (a grep with no match) are no news.
const LOOKING = /^\s*(git|cat|ls|grep|rg|find|head|tail|sed|echo|cd|pwd|which|wc|test|\[)\b/
const TESTS = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|ctest)\b/
const BUILD = /\b(build|tsc|make|compile|webpack|gradle|mvn)\b/

let reaction: { mood: Mood; until: number } | undefined
let lastActivity = Date.now()

function currentMood(now: number): Mood {
  if (reaction && now < reaction.until) return reaction.mood
  if (isWorking) return 'working'
  if (now - lastActivity > IDLE_SLEEP_MS) return 'sleeping'
  return 'idle'
}

function react(mood: Mood, ms: number) {
  reaction = { mood, until: Date.now() + ms }
}

// The last count a runner printed ("3 failed", "42 passing"), its summary line.
function lastCount(output: string, re: RegExp): number | undefined {
  let found: number | undefined
  for (const m of output.matchAll(re)) found = Number(m[1])
  return found
}

// A count is 1 to 9 digits starting a number, so a long run of digits in
// the output is scanned once, not once per digit (that was quadratic).
const PASSED = /(?<!\d)(\d{1,9})\s+(?:tests?\s+)?pass(?:ed|ing|es)?\b/gi
const FAILED = /(?<!\d)(\d{1,9})\s+(?:tests?\s+)?fail(?:ed|ing|ures?|s)?\b/gi
// Test runners print their summary last: only the tail is read.
const SUMMARY_TAIL = 20_000

// Tests or a build that passed: celebrate. Anything real that failed: worry.
// Returns the badge for a test or build run.
function reactToCommand(command: string, fullOutput: string, isError: boolean): PixelbarBadge | undefined {
  if (LOOKING.test(command)) return undefined
  const output = fullOutput.slice(-SUMMARY_TAIL)
  const failed = lastCount(output, FAILED)
  const isFailure = isError || (failed ?? 0) > 0
  const kind = TESTS.test(command) ? 'tests' : BUILD.test(command) ? 'build' : undefined
  if (!kind) {
    if (isFailure) react('worried', WORRIED_MS)
    return undefined
  }
  react(isFailure ? 'worried' : 'celebrate', isFailure ? WORRIED_MS : CELEBRATE_MS)
  return { kind, isOk: !isFailure, passed: lastCount(output, PASSED), failed: isFailure ? failed : undefined }
}

function frame(): string {
  const c = new Canvas(cols, ROWS)
  const t = tick
  const now = Date.now()
  const pct = data.percent ?? 0
  const mood = currentMood(now)
  const cacheMs = isWorking ? undefined : cacheLeft(now)
  const isShivering = cacheMs !== undefined && cacheMs > 0 && cacheMs < SHIVER_MS && mood !== 'sleeping'
  drawMascot(c, t, mood, Math.max(0, Math.min(1, (pct - CONTEXT_REARM) / 25)), isShivering ? t % 2 : 0)
  const x0 = MASCOT_COLS
  const sep = (x: number, y: number) => c.text(x, y, ' │ ', DARK)
  const wave = (base: number) => (i: number) =>
    isWorking ? mix(base, WHITE, Math.max(0, Math.sin((t - i) * 0.5)) * 0.5) : base

  // Row 0: model · effort (window) │ path │ git
  let x = c.text(x0, 0, prettyModel(data.model) || '…', wave(BLUE))
  if (data.effort) {
    x = c.text(x, 0, ' · ', DARK)
    const effortColor: Record<string, number> = { low: GRAY, medium: GREEN, high: YELLOW, xhigh: AMBER, max: RED }
    x = c.text(x, 0, data.effort, effortColor[data.effort] ?? GRAY)
  }
  if (data.window) x = c.text(x, 0, ` (${k(data.window)})`, DARK)
  x = sep(x, 0)
  x = c.text(x, 0, prettyPath(data.cwd, data.home, Math.max(12, Math.floor(cols / 3))), GOLD)
  if (data.git) {
    x = sep(x, 0)
    x = c.text(x, 0, 'git ', GRAY)
    x = c.text(x, 0, data.git.branch, BRANCH)
    x = data.git.dirty > 0 ? c.text(x, 0, ` ●${data.git.dirty}`, AMBER) : c.text(x, 0, ' ✓', GREEN)
    if (data.git.ahead > 0) x = c.text(x, 0, ` ↑${data.git.ahead}`, CYAN)
    else if (!data.git.hasUpstream) x = c.text(x, 0, ' (no upstream)', DARK)
    // Nudge: many uncommitted files, or changes left uncommitted a long time.
    const dirty = data.git.dirty
    const age = dirtySince !== null ? now - dirtySince : 0
    if (dirty > 0 && (dirty >= NUDGE_FILES || age >= NUDGE_MS)) {
      const pulse = mix(AMBER, DARK, (Math.sin(t * 0.3) + 1) / 2)
      const files = plural(dirty, 'file')
      x = c.text(x, 0, ` ⚑ ${files}${age >= 60_000 ? `, ${span(age)}` : ''} uncommitted`, pulse)
    }
  }

  // Row 1: ctx bar, 5h bar, wk bar, stretched to fill the row: the bars share
  // what the labels leave, the context bar twice what each limit bar gets.
  // Where the row does not fit, the labels shorten a step at a time.
  type Piece = { text: string; color: number } | { pct: number; parts?: Segment[]; share: number; min: number }
  const cached = hitRate(totals.read, totals.write, totals.fresh)
  const caps = roundEnds ? 2 : 0
  // `terse` 0 is the full row; 1 drops "expires" and narrows the gaps, 2 the
  // limits' reset times, 3 the token count.
  const row1Of = (terse: number): Piece[] => {
    const row: Piece[] = [{ text: 'ctx ', color: GRAY }]
    // Past CONTEXT_REARM how full it is matters more than the cache: back to heat.
    row.push({ pct, parts: pct < CONTEXT_REARM ? cacheParts() : undefined, share: 2, min: 6 })
    if (terse < 3) row.push({ text: data.tokens !== undefined ? ` ${k(data.tokens)}/${k(data.window)}` : ` –/${k(data.window)}`, color: GRAY })
    if (data.percent !== undefined) {
      const isHot = data.percent >= CONTEXT_WARN[0]!
      row.push({ text: ` ${data.percent}%`, color: isHot && t % 8 < 4 ? WHITE : step(data.percent, [25, 50, 75]) })
      if (isHot) row.push({ text: ' /compact?', color: RED })
    }
    // How much of the session's input the cache served, as the bar's blue shows it.
    if (cached !== undefined) {
      row.push({ text: ' · ', color: DARK })
      row.push({ text: `${cached.toFixed(1)}% cached`, color: cached >= 80 ? GREEN : cached >= 50 ? YELLOW : AMBER })
    }
    // Until the prompt cache lapses; the next prompt after that re-pays for the context.
    if (cacheMs !== undefined) {
      const lead = cached === undefined ? ' · cache ' : terse > 0 ? ' ' : ', '
      const color = cacheMs >= CACHE_SOON_MS ? CACHE_READ : t % 8 < 4 ? AMBER : WHITE
      if (cacheMs <= 0) row.push({ text: `${lead}❄ cold`, color: GRAY })
      else row.push({ text: `${lead}${terse > 0 ? '' : 'expires '}${clock(cacheMs)}`, color })
    }
    for (const [kind, label] of [['five_hour', '5h'], ['seven_day', 'wk']] as const) {
      const lim = data.limits.find(l => l.kind === kind)
      if (!lim) continue
      row.push({ text: `${terse > 0 ? '  ' : '   '}${label} `, color: GRAY })
      row.push({ pct: lim.percentUsed, share: 1, min: 4 })
      row.push({ text: ` ${Math.round(lim.percentUsed)}%`, color: step(lim.percentUsed, [50, 75, 90]) })
      if (lim.resetsAt && terse < 2) {
        const left = Date.parse(lim.resetsAt) - now
        row.push({ text: left > 0 ? ` ${span(left)}` : ' resetting', color: DARK })
      }
      if (kind === 'five_hour') {
        const out = paceLeft(now)
        if (out !== undefined) row.push({ text: ` (out in ~${span(out)} at this pace)`, color: out < 30 * 60_000 ? RED : AMBER })
      }
    }
    return row
  }
  const measured = (row: Piece[]) => {
    let labels = 0
    let shares = 0
    let least = 0
    for (const p of row) {
      if ('text' in p) labels += [...p.text].length
      else {
        shares += p.share
        least += p.min + caps
      }
    }
    return { labels, shares, fits: labels + least <= cols - x0 - 1 }
  }
  let row1 = row1Of(0)
  for (let terse = 1; terse <= 3 && !measured(row1).fits; terse++) row1 = row1Of(terse)
  const { labels, shares } = measured(row1)
  const room = Math.max(0, cols - x0 - labels - 1)
  x = x0
  for (const p of row1) {
    if ('text' in p) x = c.text(x, 1, p.text, p.color)
    else x = bar(c, x, 1, Math.max(p.min + caps, Math.floor((room * p.share) / shares)), p.pct, t, isWorking, p.parts)
  }

  // Row 2: status │ cost │ session time │ context history
  if (mood === 'celebrate') {
    x = c.text(x0, 2, '★', [GOLD, YELLOW, WHITE][t % 3]!)
    x = c.text(x, 2, ' yay!   ', GOLD)
  } else if (mood === 'worried') {
    x = c.text(x0, 2, '!', t % 4 < 2 ? AMBER : RED)
    x = c.text(x, 2, ' uh oh  ', AMBER)
  } else if (mood === 'working') {
    x = c.text(x0, 2, SPIN[t % SPIN.length]!, ORANGE)
    x = c.text(x, 2, ' working', i => mix(ORANGE, ORANGE_LIGHT, (Math.sin((t - i) * 0.6) + 1) / 2))
  } else if (mood === 'sleeping') {
    x = c.text(x0, 2, '☾', GRAY)
    x = c.text(x, 2, ' asleep ', DARK)
  } else {
    x = c.text(x0, 2, '●', t % 16 < 8 ? GREEN : mix(GREEN, TRACK, 0.5))
    x = c.text(x, 2, ' ready  ', GRAY)
  }
  if (badge) {
    // The last test or build run; a failure blinks until the next run.
    x = sep(x, 2)
    x = c.text(x, 2, `${badge.kind} `, GRAY)
    if (badge.isOk) {
      x = c.text(x, 2, badge.passed !== undefined ? `✓ ${badge.passed}` : '✓', GREEN)
    } else {
      const blink = t % 8 < 4 ? RED : mix(RED, TRACK, 0.4)
      x = c.text(x, 2, badge.failed !== undefined ? `✗ ${badge.failed} failing` : '✗ failed', blink)
    }
  }
  x = sep(x, 2)
  const cost = data.cost ?? 0
  x = c.text(x, 2, 'session ', GRAY)
  x = c.text(x, 2, `$${cost.toFixed(2)}`, step(cost, [1, 5, 10]))
  if (data.startedAt !== undefined) {
    x = sep(x, 2)
    x = c.text(x, 2, `◷ ${span(now - data.startedAt)}`, GRAY)
  }
  if (data.history.length > 0) {
    x = sep(x, 2)
    x = c.text(x, 2, 'ctx ', GRAY)
    sparkline(c, x, 2, data.history.slice(-Math.max(4, Math.min(24, cols - x - 1))))
  }
  // Under the crab: the focus timer's ring and countdown; the last minute blinks.
  if (focus) {
    const left = focus.endsAt - now
    const done = 1 - left / (focus.minutes * 60_000)
    c.put(1, 3, RING[Math.max(0, Math.min(4, Math.floor(done * 5)))]!, ORANGE)
    c.text(3, 3, clock(left), left < 60_000 && t % 8 < 4 ? WHITE : ORANGE_LIGHT)
  }

  // Row 3: this turn so far while working, else the last turn's summary
  const summary = (s: { ms: number; tools: number; files: number; added: number; removed: number; cacheHit?: number }, dim: boolean) => {
    x = c.text(x, 3, duration(s.ms), dim ? DARK : GRAY)
    x = c.text(x, 3, ` · ${plural(s.tools, 'tool')}`, dim ? DARK : GRAY)
    if (s.files > 0) {
      x = c.text(x, 3, ` · ${plural(s.files, 'file')} `, dim ? DARK : GRAY)
      x = c.text(x, 3, `+${s.added}`, dim ? mix(GREEN, DARK, 0.5) : GREEN)
      x = c.text(x, 3, ` −${s.removed}`, dim ? mix(RED, DARK, 0.5) : RED)
    }
    if (s.cacheHit !== undefined) {
      x = c.text(x, 3, ' · cache ', dim ? DARK : GRAY)
      const col = s.cacheHit >= 80 ? GREEN : s.cacheHit >= 50 ? YELLOW : AMBER
      x = c.text(x, 3, `${s.cacheHit.toFixed(1)}%`, dim ? mix(col, DARK, 0.5) : col)
    }
  }
  x = x0
  if (isWorking && turn) {
    x = c.text(x, 3, 'this turn ', DARK)
    const cacheHit = hitRate(turn.read, turn.write, turn.fresh)
    summary({ ms: now - turn.at, tools: turn.tools, files: turn.files.size, added: turn.added, removed: turn.removed, cacheHit }, true)
  } else if (lastTurn) {
    x = c.text(x, 3, 'last turn ', GRAY)
    x = c.text(x, 3, lastTurn.isOk ? '✓ ' : '✗ ', lastTurn.isOk ? GREEN : RED)
    summary(lastTurn, false)
    x = c.text(x, 3, ' · ', GRAY)
    x = c.text(x, 3, 'turn ', GRAY)
    x = c.text(x, 3, `$${lastTurn.cost.toFixed(2)}`, step(lastTurn.cost, [0.25, 1, 3]))
  } else {
    x = c.text(x, 3, 'no turns yet', DARK)
  }
  return c.encode()
}

// The session's tokens as shares: cache read, cache write, new (input and output).
function cacheParts(): Segment[] | undefined {
  const total = totals.read + totals.write + totals.fresh + totals.output
  if (total === 0) return undefined
  return [
    { share: totals.read / total, color: CACHE_READ },
    { share: totals.write / total, color: CACHE_WRITE },
    { share: (totals.fresh + totals.output) / total, color: CACHE_NEW },
  ]
}

// ---------- the mod ----------

export const register: Register = (on, options) => {
  const ends = options.barEnds
  roundEnds = ends === 'rounded'

  on('session.start', async ($, e, next) => {
    // A refused command (say, a name a built-in takes) must not stop the bar.
    const commands = [
      { name: 'pixelbar', description: 'Show or hide the pixel status bar above the prompt' },
      {
        name: FILES_COMMAND,
        description: 'Open a pane of the files edited this session, with their diffs',
      },
      {
        name: FOCUS_COMMAND,
        description: `Start a focus timer: /${FOCUS_COMMAND} [minutes] (default ${FOCUS_DEFAULT_MIN}), /${FOCUS_COMMAND} off`,
      },
    ]
    for (const command of commands) {
      await $.command.register(command).catch((err: unknown) => $.ui.log(`pixelbar: /${command.name} not registered: ${String(err)}`))
    }
    data.home = await $.env.get('HOME')
    if (ends !== 'rounded' && ends !== 'square') roundEnds = await drawsPowerline($)
    const settings = (await $.settings.read()) as { effortLevel?: string }
    data.effort ??= settings.effortLevel

    const refresh = async () => {
      const [usage, model, cwd] = await Promise.all([$.session.usage(), $.session.model(), $.session.cwd()])
      data.model = model
      data.cwd = cwd
      data.startedAt = usage.startedAt
      await applyUsage($, usage)
    }
    const refreshGit = async () => {
      // No index lock (it would race Claude's own git add / commit), and no
      // fsmonitor command a repo's config could name.
      const r = await $.process.run(
        ['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
        { cwd: data.cwd || undefined, timeoutMs: 5000 },
      )
      if (r.exitCode !== 0) {
        data.git = undefined
        return
      }
      const git: Git = { branch: '', dirty: 0, ahead: 0, hasUpstream: false }
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('# branch.head ')) git.branch = line.slice(14)
        else if (line.startsWith('# branch.oid ') && !git.branch) git.branch = line.slice(13, 20)
        else if (line.startsWith('# branch.upstream ')) git.hasUpstream = true
        else if (line.startsWith('# branch.ab ')) git.ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
        else if (line && !line.startsWith('#')) git.dirty++
      }
      if (git.branch === '(detached)') git.branch = 'detached'
      data.git = git
      const since = git.dirty === 0 ? null : (dirtySince ?? Date.now())
      if (since !== dirtySince) {
        dirtySince = since
        await update($, dirtySinceAtom, () => since)
      }
    }

    // Pick up what a reload left behind (the pace baseline before the first
    // refresh, which would otherwise start a new one).
    pace = await read($, paceAtom)
    dirtySince = await read($, dirtySinceAtom)
    focus = await read($, focusAtom)
    cache = await read($, cacheAtom)
    totals = await read($, totalsAtom)
    const ttl = await $.store.get(TTL_STORE_KEY).catch(() => undefined)
    if (ttl === TTL_1H || ttl === TTL_5M) cacheTtl = ttl
    await refresh().catch(() => {})
    await refreshGit().catch(() => {})
    data.history = await read($, historyAtom)
    badge = await read($, badgeAtom)
    lastTurn = await read($, lastTurnAtom)
    if (data.history.length === 0 && data.percent !== undefined) {
      data.history = [data.percent]
      await update($, historyAtom, () => data.history)
    }
    $.clock.every(2000, () => void refresh().catch(() => {}))
    $.clock.every(5000, () => void refreshGit().catch(() => {}))
    $.clock.every(FRAME_MS, () => {
      tick++
      if (focus && Date.now() >= focus.endsAt) {
        $.ui.toast(`Focus session done (${focus.minutes}m). Take a break!`)
        react('celebrate', 6000)
        focus = null
        void update($, focusAtom, () => null).catch(() => {})
      }
      if (isHidden || bandId === undefined || cols === 0) return
      void $.ui.blit({ requestId: bandId, key: KEY, cells: frame() }).catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: FILES_COMMAND }, async $ => {
    const files = await read($, filesAtom)
    await openFiles($)
    const n = files.length
    return { text: n === 0 ? 'No files edited yet this session.' : `${plural(n, 'file')} edited this session.` }
  })

  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const files = [...(await read($, filesAtom))].reverse()
    if (files.length === 0) return <Text dimColor>No files edited yet this session.</Text>
    const selected = await read($, selectedAtom)
    const chosen = files.find(f => f.path === selected) ?? files[0]!
    const total = files.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{plural(files.length, 'file')} edited </Text>
          <Text color="green">+{total.added}</Text>
          <Text color="red"> −{total.removed}</Text>
        </Box>
        {files.map(f => (
          <Box flexDirection="row" key={`row:${f.path}`}>
            <Button
              key={`file:${f.path}`}
              plain
              label={`${f.path === chosen.path ? '▸' : ' '} ${shownPath(f.path)}`}
              onPress={() => update($, selectedAtom, () => f.path)}
            />
            <Text color="green"> +{f.added}</Text>
            <Text color="red"> −{f.removed}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Code source={chosen.patches.join('\n')} format="diff" path={chosen.path} />
      </Box>
    )
  })

  on('command.run', { command: 'pixelbar' }, async $ => {
    isHidden = !isHidden
    $.ui.invalidate('ui.render')
    return { text: isHidden ? 'Pixel bar hidden.' : 'Pixel bar shown.' }
  })

  on('command.run', { command: FOCUS_COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'stop') {
      const wasRunning = focus !== null
      focus = null
      await update($, focusAtom, () => null)
      return { text: wasRunning ? 'Focus timer stopped.' : 'No focus timer is running.' }
    }
    const minutes = arg === '' ? FOCUS_DEFAULT_MIN : Number(arg)
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > FOCUS_MAX_MIN) {
      return { text: `Usage: /${FOCUS_COMMAND} [minutes, up to ${FOCUS_MAX_MIN}] or /${FOCUS_COMMAND} off` }
    }
    const started: PixelbarFocus = { endsAt: Date.now() + minutes * 60_000, minutes }
    focus = started
    await update($, focusAtom, () => started)
    return { text: `Focus timer started: ${plural(minutes, 'minute')}.` }
  })

  on('prompt.submit', (_$, e, next) => {
    lastActivity = Date.now()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    lastActivity = Date.now()
    const usage = await $.session.usage().catch(() => undefined)
    const costAtStart = usage?.cost?.usd ?? data.cost ?? 0
    turn = { at: Date.now(), tools: 0, files: new Set(), added: 0, removed: 0, costAtStart, read: 0, write: 0, fresh: 0 }
    return next(e)
  })

  // Record every edit for the files pane (subagents' too); count the main
  // conversation's tool calls and edited lines for the turn summary.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const isMain = turn !== undefined && e.agentId === undefined
    if (isMain) turn!.tools++
    if ((e.tool === 'Edit' || e.tool === 'Write') && !r.isError && r.deny === undefined) {
      const res = r.result as { filePath?: string; structuredPatch?: Hunk[]; type?: string; content?: string } | undefined
      const path = res?.filePath ?? e.file_path
      const hunks = hunksOf(res?.structuredPatch ?? [], res?.type === 'create' ? res.content : undefined)
      const { added, removed } = countLines(hunks)
      await update($, filesAtom, files => withEdit(files, path, added, removed, hunks.map(patchOf)))
      if (isMain) {
        turn!.files.add(path)
        turn!.added += added
        turn!.removed += removed
      }
    }
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    lastActivity = Date.now()
    const r = await next(e)
    if (r.deny !== undefined) return r
    const res = r.result as { stdout?: string; stderr?: string } | undefined
    const output = r.isError ? (r.text ?? '') : `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`
    const run = reactToCommand(e.command, output, r.isError === true)
    if (run) {
      badge = run
      await update($, badgeAtom, () => run)
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined) data.effort = String(e.effort)
    const sentAt = Date.now()
    const r = yield* next(e)
    if (r.usage) await addToTotals($, r.usage)
    if (e.agentId === undefined && r.usage) await noteResponse($, r.usage, sentAt)
    return r
  })

  // A model switch says how long the cache lives (and forfeits it).
  on('classic.PostModelSwitch', async ($, e, next) => {
    cacheTtl = e.cache_ttl === '1h' ? TTL_1H : TTL_5M
    await $.store.set(TTL_STORE_KEY, cacheTtl)
    return next(e)
  }).catch((_$, e, next) => next(e))

  // A compaction replaces the context: nothing of it is cached any more.
  on('classic.PostCompact', async ($, e, next) => {
    cache = null
    await update($, cacheAtom, () => null)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    lastActivity = Date.now()
    if (e.agentId !== undefined) return next(e)
    isWorking = false
    if (turn) {
      const t = turn
      turn = undefined
      const usage = await $.session.usage().catch(() => undefined)
      const costNow = usage?.cost?.usd ?? data.cost ?? t.costAtStart
      const done: PixelbarTurn = {
        ms: e.durationMs,
        tools: t.tools,
        files: t.files.size,
        added: t.added,
        removed: t.removed,
        cost: Math.max(0, costNow - t.costAtStart),
        isOk: !e.isAborted && e.reason === 'answer',
        cacheHit: hitRate(t.read, t.write, t.fresh),
      }
      lastTurn = done
      await update($, lastTurnAtom, () => done)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e)
    const p = e.context.percent
    if (e.changed.includes('context') && p !== undefined) {
      const history = [...data.history, p].slice(-48)
      data.history = history
      await update($, historyAtom, () => history)

      // Warn once at each level; a compaction below 70% re-arms them.
      const stored = await read($, warnedAtom)
      const warnedAt = p < CONTEXT_REARM ? 0 : stored
      const level = [...CONTEXT_WARN].reverse().find(w => p >= w) ?? 0
      if (level > warnedAt) $.ui.toast(`Context at ${p}%. Consider /compact soon.`)
      const nextWarned = Math.max(level, warnedAt)
      if (nextWarned !== stored) await update($, warnedAtom, () => nextWarned)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isHidden || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    bandId = e.requestId
    isWorking = e.props.isWorking
    const { Raster, Box, Button } = $.ui.resolve(e)

    // Reading the files subscribes the band, so the button appears (and its
    // count moves) as edits land. Before the first edit there is no button.
    const edited = (await read($, filesAtom)).length
    const label = plural(edited, 'file')
    const buttonCols = edited > 0 ? label.length + 5 : 0 // "[ label ]" and a gap
    cols = Math.max(MASCOT_COLS + 20, Math.min(512, e.props.bodyColumns - buttonCols))
    const raster = <Raster key={KEY} columns={cols} rows={ROWS} cells={frame()} />
    if (edited === 0) return raster

    return (
      <Box flexDirection="row">
        {raster}
        <Box marginLeft={1}>
          <Button
            key="files"
            label={label}
            hotkey="f"
            onPress={() => openFiles($)}
          />
        </Box>
      </Box>
    )
  })
}
