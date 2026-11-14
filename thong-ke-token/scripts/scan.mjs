// Tally Claude Code token usage from the local transcripts since the start of
// the month. Usage: node scan.mjs [sessionId]   → prints one JSON object.
//
// Reads ~/.claude/projects/**/*.jsonl. Each API response is counted once (by
// message id + request id), so resumed sessions that copy history are not
// double counted. Per-file results are cached by size + mtime, so only files
// that changed are read again.
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const IDLE_MS = 5 * 60 * 1000 // a gap longer than this counts as idle
const CACHE_VERSION = 2
const ROOT = path.join(os.homedir(), '.claude', 'projects')
// The cache sits in the mod's own folder (git-ignored), next to scripts/.
const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CACHE_FILE = path.join(MOD_DIR, '.cache.json')

const currentSession = process.argv[2] ?? ''
const now = new Date()
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

async function walk(dir, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// One file → its API responses since monthStart and its main-thread
// timestamps, grouped by session id.
async function readFile(file) {
  const responses = [] // [key, sessionId, input, output, cacheRead, cacheWrite]
  const times = {} // sessionId -> number[]
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"timestamp"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(o.timestamp)
    if (!(t >= monthStart)) continue
    const sid = o.sessionId ?? ''
    if (!o.isSidechain && (o.type === 'user' || o.type === 'assistant')) {
      ;(times[sid] ??= []).push(t)
    }
    const u = o.type === 'assistant' ? o.message?.usage : undefined
    if (!u) continue
    responses.push([
      `${o.message?.id ?? ''}|${o.requestId ?? ''}`,
      sid,
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
    ])
  }
  return { responses, times }
}

const activeMs = ts => {
  ts.sort((a, b) => a - b)
  let sum = 0
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1]
    if (gap <= IDLE_MS) sum += gap
  }
  return sum
}

const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, activeMs: 0 })

async function main() {
  let cache = {}
  try {
    const c = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    if (c.version === CACHE_VERSION && c.monthStart === monthStart) cache = c.files
  } catch {}

  const files = await walk(ROOT, [])
  const nextCache = {}
  for (const file of files) {
    let st
    try {
      st = await fs.stat(file)
    } catch {
      continue
    }
    if (st.mtimeMs < monthStart) continue
    const hit = cache[file]
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      nextCache[file] = hit
    } else {
      nextCache[file] = { size: st.size, mtimeMs: st.mtimeMs, ...(await readFile(file)) }
    }
  }

  const seen = new Set()
  const month = empty()
  const session = empty()
  const sessionTimes = {}
  for (const { responses, times } of Object.values(nextCache)) {
    for (const [key, sid, i, o, cr, cw] of responses) {
      if (seen.has(key)) continue
      seen.add(key)
      for (const b of sid === currentSession ? [month, session] : [month]) {
        b.input += i
        b.output += o
        b.cacheRead += cr
        b.cacheWrite += cw
      }
    }
    for (const [sid, ts] of Object.entries(times)) (sessionTimes[sid] ??= []).push(...ts)
  }
  let sessions = 0
  for (const [sid, ts] of Object.entries(sessionTimes)) {
    const ms = activeMs(ts)
    month.activeMs += ms
    if (sid === currentSession) session.activeMs = ms
    sessions++
  }

  try {
    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({ version: CACHE_VERSION, monthStart, files: nextCache }),
    )
  } catch {}

  process.stdout.write(
    JSON.stringify({ monthStart, scannedAt: Date.now(), month: { ...month, sessions }, session }),
  )
}

main().catch(err => {
  process.stderr.write(String(err?.stack ?? err))
  process.exit(1)
})
