// The local chat page for the tele-bridge mod: a tiny HTTP server on this
// computer (or the home Wi-Fi when "lan" is on, behind a password).
//
// Looks like a chat app: a sidebar of the 🟢 sessions, and each session's own
// conversation, read from the transcript Claude keeps on disk (so what you
// typed at the computer shows too).
//
// Agents: when there is an agent root (a folder holding `agents/<name>/` and
// `shared/`), the sidebar groups sessions by agent: every session opened in
// `agents/<name>` (the 🟢 ones to chat with, closed ones to read back), the
// agent's CLAUDE.md, its files, its inbox (`shared/hop-thu/<name>/`), the
// shared folder, and an overview of all agents.
//
// Started by the mod with its settings as one JSON line on stdin:
//   { port, lan, password, key, root }
// `key` guards /internal/*, which only the mod calls (from 127.0.0.1).
// Prints one JSON line when listening: { ready: true, urls: [...] }.
//
// Personal use only: your Claude account is yours; don't share this page.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INBOX = path.join(MOD_DIR, 'inbox')
// CDM_PROJECTS_DIR is for testing against a copy of the transcripts.
const PROJECTS = process.env.CDM_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
const MAX_UPLOAD = 50 * 1024 * 1024
const HISTORY_LIMIT = 300
const MAX_PREVIEW = 512 * 1024
const SESSIONS_PER_FOLDER = 40 // the newest; older closed sessions aren't listed
const MAIL_DIR = 'hop-thu' // shared/hop-thu/<agent>/: what was sent to that agent

const cfg = await new Promise(resolve => {
  let s = ''
  process.stdin.on('data', d => {
    s += d
    const nl = s.indexOf('\n')
    if (nl >= 0) resolve(JSON.parse(s.slice(0, nl)))
  })
  process.stdin.on('end', () => resolve(JSON.parse(s || '{}')))
})
const PORT = Number(cfg.port) || 8787
const LAN = Boolean(cfg.lan)
const PASSWORD = String(cfg.password ?? '')
const KEY = String(cfg.key ?? '')

let sessions = [] // [{ sid, name, busy, cwd }] pushed by the mod
let root = typeof cfg.root === 'string' ? cfg.root : '' // the agent root set in the pane
const notes = [] // small notes from the mod: [{ id, sid, text, at }]
let nextNote = 1
const inbox = [] // what the page sent, waiting for the mod
let waiter = null // the mod's pending /internal/inbox request
const tokens = new Set() // logged-in browsers (LAN mode)

const exists = f => fs.stat(f).then(() => true, () => false)

// ------------------------------------------------------------ transcripts

const files = new Map() // sid -> transcript path
async function transcriptOf(sid) {
  if (!/^[\w-]+$/.test(sid)) return undefined
  if (files.has(sid)) return files.get(sid)
  for (const dir of await fs.readdir(PROJECTS).catch(() => [])) {
    const f = path.join(PROJECTS, dir, `${sid}.jsonl`)
    if (await exists(f)) {
      files.set(sid, f)
      return f
    }
  }
}

// Reads what was added to a file since the last call, whole lines only (a
// line cut mid-write waits for the next call). null: the file shrank.
async function readNew(file, st) {
  const info = await fs.stat(file).catch(() => undefined)
  if (!info) return []
  if (info.size < st.offset) return null
  if (info.size === st.offset) return []
  const chunks = [st.rest]
  for await (const c of createReadStream(file, { start: st.offset, end: info.size - 1 })) chunks.push(c)
  st.offset = info.size
  const buf = Buffer.concat(chunks)
  const nl = buf.lastIndexOf(10)
  st.rest = buf.subarray(nl + 1)
  return nl < 0 ? [] : buf.subarray(0, nl).toString('utf8').split('\n')
}

function userText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  if (content.some(b => b.type === 'tool_result')) return ''
  const parts = []
  for (const b of content) {
    if (b.type === 'text') parts.push(b.text)
    else if (b.type === 'image') parts.push('[ảnh]')
  }
  return parts.join('\n')
}

// Per transcript: the chat so far, its title, first prompt and last answer.
// `count` only grows (the page's "new messages" dot), unlike trimmed `items`.
const parsed = new Map()
const fresh = () => ({ offset: 0, rest: Buffer.alloc(0), items: [], count: 0, title: '', first: '', lastAt: 0, last: '' })

function take(st, line) {
  // Most lines are tool calls, tool results and attachments: skip them unparsed.
  const isTitle = line.includes('"custom-title"')
  if (!isTitle && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (o.type === 'custom-title') {
    if (o.customTitle) st.title = String(o.customTitle)
    return
  }
  if (o.isSidechain || o.isMeta) return
  const at = Date.parse(o.timestamp) || 0
  if (o.type === 'user') {
    const text = userText(o.message?.content).trim()
    // Engine-made rows (commands, reminders, notices) start with a tag.
    if (!text || text.startsWith('<')) return
    if (!st.first) st.first = text.split('\n')[0].slice(0, 60)
    st.items.push({ role: 'me', text, at })
    st.count++
    st.lastAt = at
  } else if (o.type === 'assistant') {
    const content = o.message?.content
    if (!Array.isArray(content)) return
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()
    if (!text) return
    const last = st.items[st.items.length - 1]
    // One answer per turn: texts between two prompts join into one bubble.
    if (last && last.role === 'claude') {
      last.text += '\n\n' + text
      last.at = at
    } else {
      st.items.push({ role: 'claude', text, at })
      st.count++
    }
    st.last = text
    st.lastAt = at
  }
}

async function transcript(file) {
  let st = parsed.get(file)
  if (!st) parsed.set(file, (st = fresh()))
  let lines = await readNew(file, st)
  if (lines === null) {
    parsed.set(file, (st = fresh()))
    lines = await readNew(file, st)
  }
  for (const line of lines ?? []) if (line) take(st, line)
  if (st.items.length > HISTORY_LIMIT * 2) st.items.splice(0, st.items.length - HISTORY_LIMIT)
  return st
}

// ------------------------------------------------------------ agents

// `p`'s path under `base` ('' for base itself), or undefined when outside.
function under(base, p) {
  const rel = path.relative(base, p)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined
  return rel
}

// The agent root: set in the pane, or found from a 🟢 session opened in
// `<root>/agents/<name>`.
function agentRoot() {
  if (root) return path.resolve(root)
  for (const s of sessions) {
    if (!s.cwd) continue
    const parts = path.resolve(String(s.cwd)).split(path.sep)
    const i = parts.findLastIndex((x, k) => k > 0 && k < parts.length - 1 && x.toLowerCase() === 'agents')
    if (i > 0) return parts.slice(0, i).join(path.sep)
  }
  return ''
}

// Where a session opened in `cwd` belongs: { agent } inside agents/<agent>,
// { root: true } anywhere else under the root, undefined outside it.
function placeOf(r, cwd) {
  if (!r || !cwd) return undefined
  const rel = under(r, path.resolve(String(cwd)))
  if (rel === undefined) return undefined
  const parts = rel.split(path.sep)
  if (parts[0]?.toLowerCase() === 'agents' && parts[1]) return { agent: parts[1] }
  return { root: true }
}

// The folder each ~/.claude/projects/<dir> holds the sessions of (read from
// its transcripts' "cwd": the dir's name is a lossy spelling of it).
const dirCwd = new Map()
async function firstCwd(file) {
  const fh = await fs.open(file, 'r').catch(() => undefined)
  if (!fh) return ''
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, bytesRead).toString('utf8'))
    return m ? String(JSON.parse(m[1])) : ''
  } catch {
    return ''
  } finally {
    await fh.close()
  }
}
async function cwdOfDir(dir) {
  const c = dirCwd.get(dir)
  if (c && (c.cwd || Date.now() - c.at < 60_000)) return c.cwd
  let cwd = ''
  const full = path.join(PROJECTS, dir)
  for (const f of (await fs.readdir(full).catch(() => [])).filter(f => f.endsWith('.jsonl')).slice(0, 5)) {
    if ((cwd = await firstCwd(path.join(full, f)))) break
  }
  dirCwd.set(dir, { cwd, at: Date.now() })
  return cwd
}

const known = new Set() // closed sessions the page may read (listed under the root)
let index = { at: 0, data: undefined, building: undefined }

// Everything the sidebar and the overview show, rebuilt at most every 1.5 s.
function hub() {
  if (index.data && Date.now() - index.at < 1500) return Promise.resolve(index.data)
  index.building ??= build().then(
    data => {
      index = { at: Date.now(), data, building: undefined }
      return data
    },
    err => {
      index.building = undefined
      throw err
    },
  )
  return index.building
}

async function build() {
  const r = agentRoot()
  const groups = new Map() // 'a:<name>' | 'root' | 'other' -> Map(sid -> entry)
  const group = key => {
    let g = groups.get(key)
    if (!g) groups.set(key, (g = new Map()))
    return g
  }
  const names = r
    ? (await fs.readdir(path.join(r, 'agents'), { withFileTypes: true }).catch(() => []))
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
    : []
  for (const n of names) group(`a:${n}`)
  const keyOf = place =>
    !place ? 'other' : place.agent ? `a:${names.find(x => x.toLowerCase() === place.agent.toLowerCase()) ?? place.agent}` : 'root'
  const entry = (sid, t, mtime) => ({
    sid,
    name: t.title || t.first || 'Phiên chưa có tên',
    titled: Boolean(t.title),
    at: t.lastAt || mtime,
    n: t.count,
    last: t.last.slice(0, 240),
    live: false,
    busy: false,
  })

  // Sessions on disk, closed or not.
  if (r) {
    for (const dir of await fs.readdir(PROJECTS).catch(() => [])) {
      const place = placeOf(r, await cwdOfDir(dir))
      if (!place) continue
      const full = path.join(PROJECTS, dir)
      const list = []
      for (const f of await fs.readdir(full).catch(() => [])) {
        if (!f.endsWith('.jsonl')) continue
        const st = await fs.stat(path.join(full, f)).catch(() => undefined)
        if (st?.isFile()) list.push({ sid: f.slice(0, -6), file: path.join(full, f), mtime: st.mtimeMs })
      }
      list.sort((a, b) => b.mtime - a.mtime)
      const g = group(keyOf(place))
      for (const x of list.slice(0, SESSIONS_PER_FOLDER)) {
        const t = await transcript(x.file)
        if (!t.count && !t.title) continue // opened and left empty
        files.set(x.sid, x.file)
        known.add(x.sid)
        g.set(x.sid, entry(x.sid, t, x.mtime))
      }
    }
  }

  // The 🟢 sessions, with the name the mod knows them by.
  for (const s of sessions) {
    const g = group(keyOf(placeOf(r, s.cwd)))
    let e = g.get(s.sid)
    if (!e) {
      const file = await transcriptOf(s.sid)
      e = file ? entry(s.sid, await transcript(file), 0) : entry(s.sid, fresh(), 0)
    }
    const folder = path.basename(String(s.cwd ?? ''))
    // The mod falls back on the folder's name; a first prompt says more.
    if (s.name && !e.titled && (s.name !== folder || !e.n)) e.name = s.name
    e.live = true
    e.busy = Boolean(s.busy)
    g.set(s.sid, e)
  }

  const sorted = key =>
    [...(groups.get(key)?.values() ?? [])]
      .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
      .map(({ titled, ...e }) => e)
  const mailCount = async n =>
    (await fs.readdir(path.join(r, 'shared', MAIL_DIR, n), { withFileTypes: true }).catch(() => [])).filter(
      d => d.isFile() && !d.name.startsWith('.'),
    ).length
  const agents = []
  for (const key of groups.keys()) {
    if (!key.startsWith('a:')) continue
    const name = key.slice(2)
    const list = sorted(key)
    agents.push({
      name,
      folder: names.includes(name),
      sessions: list,
      mail: r ? await mailCount(name) : 0,
      at: Math.max(0, ...list.map(s => s.at)),
      live: list.filter(s => s.live).length,
      busy: list.some(s => s.busy),
    })
  }
  agents.sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  return {
    root: r,
    rootName: r ? path.basename(r) : '',
    hasShared: r ? await exists(path.join(r, 'shared')) : false,
    agents,
    rootSessions: sorted('root'),
    others: sorted('other'),
  }
}

// ------------------------------------------------------------ files

// What the page may browse: the root, one agent's folder, the shared folder.
function areaBase(area) {
  const r = agentRoot()
  if (!r) return undefined
  if (area === 'root') return r
  if (area === 'shared') return path.join(r, 'shared')
  const m = /^agent:([^\\/]+)$/.exec(area)
  if (m && m[1] !== '.' && m[1] !== '..') return path.join(r, 'agents', m[1])
}

// The real path of `rel` in `area`, or undefined if it leads outside (a
// `..`, or a link inside pointing elsewhere).
async function resolveIn(area, rel) {
  const base = areaBase(String(area ?? ''))
  if (!base) return undefined
  const full = path.resolve(base, String(rel ?? ''))
  if (under(base, full) === undefined) return undefined
  const [realBase, real] = await Promise.all([
    fs.realpath(base).catch(() => undefined),
    fs.realpath(full).catch(() => undefined),
  ])
  if (!realBase || !real || under(realBase, real) === undefined) return undefined
  return real
}

const HIDDEN = new Set(['.git', 'node_modules'])
const IMAGE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

async function listDir(dir) {
  const out = []
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (HIDDEN.has(d.name)) continue
    const st = await fs.stat(path.join(dir, d.name)).catch(() => undefined)
    if (st) out.push({ name: d.name, dir: st.isDirectory(), size: st.size, at: st.mtimeMs })
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'vi'))
}

// --------------------------------------------------------------- http

function flushInbox() {
  if (!waiter || inbox.length === 0) return
  const { res, timer } = waiter
  waiter = null
  clearTimeout(timer)
  json(res, 200, inbox.splice(0))
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = (req, limit = 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const cookieToken = req => /(?:^|;\s*)cdm_auth=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1]

const isLocal = req => {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

// On this computer no password is needed; from another device (LAN mode) it is.
const isAuthed = req => isLocal(req) || (LAN && tokens.has(cookieToken(req) ?? ''))

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const p = url.pathname
  const q = name => url.searchParams.get(name) ?? ''

  // ---- the mod (local only, with the key)
  if (p.startsWith('/internal/')) {
    if (!isLocal(req) || !safeEqual(req.headers['x-key'] ?? '', KEY)) return json(res, 403, { error: 'forbidden' })
    if (p === '/internal/inbox') {
      if (inbox.length) return json(res, 200, inbox.splice(0))
      if (waiter) json(waiter.res, 200, [])
      const wait = Math.min(Number(url.searchParams.get('wait')) || 20, 25) * 1000
      const timer = setTimeout(() => {
        if (waiter?.res === res) {
          waiter = null
          json(res, 200, [])
        }
      }, wait)
      waiter = { res, timer }
      return
    }
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (p === '/internal/state') {
      sessions = Array.isArray(body.sessions) ? body.sessions : []
      if (typeof body.root === 'string' && body.root !== root) {
        root = body.root
        index.at = 0
      }
      return json(res, 200, { ok: true })
    }
    if (p === '/internal/push') {
      notes.push({ id: nextNote++, sid: String(body.sid ?? ''), text: String(body.text ?? ''), at: Date.now() })
      if (notes.length > 300) notes.splice(0, notes.length - 300)
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  // ---- the page
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(PAGE)
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (!LAN || !PASSWORD || !safeEqual(body.password ?? '', PASSWORD)) {
      await new Promise(r => setTimeout(r, 800)) // slow down guessing
      return json(res, 401, { error: 'Sai mật khẩu' })
    }
    const token = crypto.randomBytes(24).toString('hex')
    tokens.add(token)
    res.setHeader('set-cookie', `cdm_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)
    return json(res, 200, { ok: true })
  }
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' })
  if (!isAuthed(req)) return json(res, 401, { error: 'login' })

  if (p === '/api/sessions') return json(res, 200, { sessions })
  if (p === '/api/hub') return json(res, 200, await hub())
  if (p === '/api/history') {
    const sid = q('sid')
    const live = sessions.some(s => s.sid === sid)
    if (!live && !known.has(sid)) return json(res, 200, { items: [], notes: [], count: 0, live })
    const file = await transcriptOf(sid)
    const t = file ? await transcript(file) : fresh()
    return json(res, 200, {
      items: t.items.slice(-HISTORY_LIMIT),
      count: t.count,
      notes: notes.filter(n => n.sid === sid),
      live,
    })
  }
  if (p === '/api/files') {
    const dir = await resolveIn(q('area'), q('path'))
    const entries = dir && (await listDir(dir).catch(() => undefined))
    if (!entries) return json(res, 200, { error: 'Không có thư mục này' })
    return json(res, 200, { entries })
  }
  if (p === '/api/file') {
    const file = await resolveIn(q('area'), q('path'))
    const st = file && (await fs.stat(file).catch(() => undefined))
    if (!st?.isFile()) return json(res, 200, { error: 'Không có file này' })
    const meta = { size: st.size, at: st.mtimeMs, ext: path.extname(file).toLowerCase() }
    if (IMAGE[meta.ext]) return json(res, 200, { kind: 'image', ...meta })
    if (st.size > MAX_PREVIEW) return json(res, 200, { kind: 'big', ...meta })
    const buf = await fs.readFile(file)
    if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { kind: 'binary', ...meta })
    return json(res, 200, { kind: 'text', text: buf.toString('utf8'), ...meta })
  }
  if (p === '/api/raw') {
    const file = await resolveIn(q('area'), q('path'))
    const type = file && IMAGE[path.extname(file).toLowerCase()]
    if (!type) return json(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // An SVG opened on its own must not run scripts on this page's origin.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    createReadStream(file)
      .on('error', () => res.end())
      .pipe(res)
    return
  }
  if (p === '/api/send' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const sid = String(body.sid ?? '')
    if (!sessions.some(x => x.sid === sid)) return json(res, 400, { error: 'Phiên này không còn bật' })
    const kind = ['stop', 'status'].includes(body.kind) ? body.kind : 'text'
    const text = String(body.text ?? '').slice(0, 20000)
    if (kind === 'text' && !text.trim()) return json(res, 400, { error: 'Tin nhắn trống' })
    inbox.push({ id: Date.now() * 1000 + Math.floor(Math.random() * 1000), sid, kind, text })
    flushInbox()
    return json(res, 200, { ok: true })
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const raw = decodeURIComponent(String(req.headers['x-name'] ?? 'file'))
    const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-80)
    const data = await readBody(req, MAX_UPLOAD)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    await fs.mkdir(INBOX, { recursive: true })
    const file = path.join(INBOX, `${stamp}-${name}`)
    await fs.writeFile(file, data)
    return json(res, 200, { ok: true, path: file })
  }
  return json(res, 404, { error: 'not found' })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    try {
      json(res, 500, { error: String(err?.message ?? err) })
    } catch {}
  })
})
server.on('error', err => {
  process.stdout.write(JSON.stringify({ ready: false, error: String(err?.message ?? err) }) + '\n')
  process.exit(1)
})
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const urls = [`http://localhost:${PORT}`]
  if (LAN) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list ?? []) {
        if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${PORT}`)
      }
    }
  }
  process.stdout.write(JSON.stringify({ ready: true, urls }) + '\n')
})
// The mod ends this process when its session stops leading or closes.

// The page below is plain JS inside a String.raw template: no backticks
// (written \x60) and no dollar-brace in it.
const PAGE = String.raw`<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Claude Chat</title>
<style>
:root{--bg:#faf9f5;--side:#f0eee6;--panel:#fff;--text:#1f1e1d;--dim:#73726c;--line:#e5e3da;--me:#efece3;--accent:#c96442;--hover:#e8e5da;--code:#f3f1ea;--ok:#15803d;--okbg:#dcfce7}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--side:#1f1e1d;--panel:#30302e;--text:#f5f4ef;--dim:#a6a39b;--line:#3e3e3a;--me:#3a3936;--hover:#30302e;--code:#1f1e1d;--ok:#86efac;--okbg:#14532d}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;border-radius:8px}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:13px}
#side{width:270px;flex:0 0 270px;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;height:100%}
#side h1{font-size:17px;margin:0;padding:16px 16px 8px;display:flex;align-items:center;gap:8px}
.label{font-size:12px;color:var(--dim);padding:12px 10px 4px;text-transform:uppercase;letter-spacing:.04em}
.hint{font-size:12px;color:var(--dim);padding:4px 10px}
#list{flex:1;overflow-y:auto;padding:0 8px 12px}
.item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;margin:1px 0}
.item:hover{background:var(--hover)}.item.on{background:var(--hover);font-weight:600}
.item .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .ic{width:16px;text-align:center;flex:0 0 16px}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 8px;margin:0 4px}
.dot.off{background:transparent;border:1.5px solid var(--dim);opacity:.6}
.dot.busy{background:var(--accent);animation:pulse 1s infinite}
.unread{width:8px;height:8px;border-radius:50%;background:#3b82f6;flex:0 0 8px}
.badge{font-size:11px;background:var(--accent);color:#fff;border-radius:999px;padding:0 6px;line-height:18px}
@keyframes pulse{50%{opacity:.3}}
#side .foot{font-size:12px;color:var(--dim);padding:12px 16px;border-top:1px solid var(--line)}
#main{flex:1;min-width:0;display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line)}
header .title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header button{padding:6px 10px}header button:hover{background:var(--hover)}
#menu{display:none}
.tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line);overflow-x:auto;flex:0 0 auto}
.tab{padding:9px 12px;border-radius:0;border-bottom:2px solid transparent;white-space:nowrap;color:var(--dim)}
.tab:hover{color:var(--text)}.tab.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.sbar{display:flex;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.sbar select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:100%;min-width:0;flex:1 1 260px}
#log{flex:1;overflow-y:auto}
#inner{max-width:760px;margin:0 auto;padding:24px 16px 8px;display:flex;flex-direction:column;gap:18px}
#inner.wide{max-width:980px;gap:12px}
.me{align-self:flex-end;max-width:80%;background:var(--me);padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.claude{align-self:stretch;word-wrap:break-word}
.claude p{margin:0 0 10px}.claude p:last-child{margin:0}
.claude pre,.code{background:var(--code);padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:13px;margin:0;white-space:pre}
.claude pre code{background:none;padding:0}
.claude h1,.claude h2,.claude h3{font-size:16px;margin:12px 0 6px}
.claude ul,.claude ol{margin:0 0 10px;padding-left:22px}
.claude table{border-collapse:collapse;margin:0 0 10px;font-size:14px;display:block;overflow-x:auto}
.claude td,.claude th{border:1px solid var(--line);padding:4px 8px;text-align:left}
.claude a{color:var(--accent)}
.note{align-self:center;color:var(--dim);font-size:13px;white-space:pre-wrap}
.working{color:var(--dim);font-size:14px}.working::after{content:"…";animation:pulse 1s infinite}
.empty{color:var(--dim);text-align:center;margin-top:16vh;line-height:1.8}
.pending{opacity:.6}
.doc{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 20px}
.crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:14px}
.crumbs button{padding:2px 6px;color:var(--accent)}.crumbs button:hover{background:var(--hover)}
.crumbs .sp{color:var(--dim)}.crumbs .grow{flex:1}
.flist{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.frow{display:flex;gap:10px;align-items:center;width:100%;padding:9px 14px;border-radius:0;border-bottom:1px solid var(--line);text-align:left}
.frow:last-child{border-bottom:0}.frow:hover{background:var(--hover)}
.frow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--dim);font-size:12px;white-space:nowrap}
.preview img{max-width:100%;border-radius:8px;border:1px solid var(--line);background:var(--panel)}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 16px;min-width:120px;flex:1 1 120px}
.stat b{display:block;font-size:24px;line-height:1.3}.stat span{color:var(--dim);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:left;display:flex;flex-direction:column;gap:6px;min-width:0}
.card:hover{border-color:var(--accent)}
.card .row{display:flex;align-items:center;gap:8px}.card .row b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.snip{color:var(--dim);font-size:13px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.pill{font-size:12px;padding:1px 9px;border-radius:999px;background:var(--hover);color:var(--dim);white-space:nowrap}
.pill.busy{background:var(--accent);color:#fff}.pill.on{background:var(--okbg);color:var(--ok)}
.btn{border:1px solid var(--line);padding:4px 10px;font-size:13px;background:var(--panel)}.btn:hover{background:var(--hover)}
footer{padding:8px 16px calc(14px + env(safe-area-inset-bottom))}
.box{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:8px}
.ro{max-width:760px;margin:0 auto;padding:10px 14px;border:1px dashed var(--line);border-radius:12px;color:var(--dim);font-size:14px;text-align:center}
textarea{flex:1;min-width:0;resize:none;border:0;outline:0;background:none;color:var(--text);font:inherit;max-height:200px;padding:6px 4px}
.box button{padding:6px 10px}.box button:hover{background:var(--hover)}
#send{background:var(--accent);color:#fff}#send:hover{background:var(--accent);opacity:.9}
#login{margin:auto;display:flex;flex-direction:column;gap:10px;padding:24px;width:min(320px,100% - 32px)}
#login input{font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text)}
#login button{background:var(--accent);color:#fff;padding:10px}
.hidden{display:none!important}.err{color:#dc2626;font-size:13px}
#scrim{display:none}
@media (max-width:760px){
  #side{position:fixed;z-index:10;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .2s}
  body.open #side{transform:none}
  body.open #scrim{display:block;position:fixed;inset:0;background:#0006;z-index:9}
  #menu{display:block}
  #inner{padding:16px 12px 8px}
}
</style></head><body>
<div id="login" class="hidden"><b>Claude Chat</b><input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password"><button id="go">Vào</button><div class="err" id="loginErr"></div></div>
<aside id="side" class="hidden">
  <h1>✳️ Claude Chat</h1>
  <div id="list"></div>
  <div class="foot" id="foot">Bật thêm phiên: trên máy, bấm nút Tele trong phiên đó. Chỉ dùng cho riêng bạn.</div>
</aside>
<div id="scrim"></div>
<main id="main" class="hidden">
  <header><button id="menu" title="Danh sách">☰</button><div class="title" id="title">Claude Chat</div><button id="status" title="Trạng thái">ℹ️</button><button id="stop" title="Dừng">⏹</button></header>
  <nav id="tabs" class="tabs hidden"></nav>
  <div id="sbar" class="sbar hidden"></div>
  <div id="log"><div id="inner"></div></div>
  <footer id="footer"><div class="box" id="box"><button id="attach" title="Gửi ảnh/file">📎</button><input id="file" type="file" class="hidden"><textarea id="text" rows="1" placeholder="Nhắn cho Claude…"></textarea><button id="send" title="Gửi">➤</button></div><div class="ro hidden" id="ro">Phiên này đã đóng, chỉ xem lại. Muốn làm tiếp: mở phiên trong thư mục này trên app Claude, phiên đó sẽ tự hiện ở đây.</div></footer>
</main>
<script>
const $=id=>document.getElementById(id);
const keep={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
let hub=null,view=keep.get('cdm_view2',{type:'overview'}),seen=keep.get('cdm_seen2',{}),pending=[],busy=false,rendered='',sbarHtml='';
function show(logged){$('login').classList.toggle('hidden',logged);$('side').classList.toggle('hidden',!logged);$('main').classList.toggle('hidden',!logged)}
async function api(path,opts){const r=await fetch(path,opts);if(r.status===401){show(false);throw new Error('login')}return r.json()}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const enc=encodeURIComponent;
function inline(s){return s.replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')}
function md(src){
  const out=[];const lines=esc(src).split('\n');let i=0;
  while(i<lines.length){const l=lines[i];
    if(/^\x60\x60\x60/.test(l)){const buf=[];i++;while(i<lines.length&&!/^\x60\x60\x60/.test(lines[i]))buf.push(lines[i++]);i++;out.push('<pre><code>'+buf.join('\n')+'</code></pre>');continue}
    if(/^\|.*\|\s*$/.test(l)&&i+1<lines.length&&/^\|[\s:|-]+\|\s*$/.test(lines[i+1])){const row=x=>x.trim().replace(/^\||\|$/g,'').split('|').map(c=>inline(c.trim()));
      let h='<table><tr>'+row(l).map(c=>'<th>'+c+'</th>').join('')+'</tr>';i+=2;while(i<lines.length&&/^\|.*\|\s*$/.test(lines[i]))h+='<tr>'+row(lines[i++]).map(c=>'<td>'+c+'</td>').join('')+'</tr>';out.push(h+'</table>');continue}
    let m;if(m=/^(#{1,3})\s+(.*)/.exec(l)){out.push('<h3>'+inline(m[2])+'</h3>');i++;continue}
    if(/^\s*([-*]|\d+\.)\s+/.test(l)){const ord=/^\s*\d+\./.test(l);const items=[];while(i<lines.length&&/^\s*([-*]|\d+\.)\s+/.test(lines[i]))items.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/,'')));out.push((ord?'<ol>':'<ul>')+items.map(x=>'<li>'+x+'</li>').join('')+(ord?'</ol>':'</ul>'));continue}
    if(!l.trim()){i++;continue}
    const buf=[];while(i<lines.length&&lines[i].trim()&&!/^\x60\x60\x60|^#{1,3}\s|^\s*([-*]|\d+\.)\s+|^\|/.test(lines[i]))buf.push(inline(lines[i++]));out.push('<p>'+buf.join('<br>')+'</p>');
  }
  return out.join('');
}
function ago(t){if(!t)return'';const s=(Date.now()-t)/1000;if(s<60)return'vừa xong';if(s<3600)return Math.floor(s/60)+' phút trước';if(s<86400)return Math.floor(s/3600)+' giờ trước';if(s<172800)return'hôm qua';const d=new Date(t);return d.getDate()+'/'+(d.getMonth()+1)+'/'+d.getFullYear()}
function size(n){return n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB'}
const join=(...p)=>p.filter(Boolean).join('/');
const plain=s=>String(s).replace(/[*#|\x60>]/g,'').replace(/\n{2,}/g,'\n').trim();
function setInner(h){if(h!==rendered){$('inner').innerHTML=h;rendered=h}}
function save(){keep.set('cdm_view2',view)}

// ---- where we are
const isChat=()=>view.type==='session'||((view.type==='agent'||view.type==='root')&&(view.tab||'chat')==='chat');
function sessionsOf(v){if(!hub)return[];if(v.type==='agent'){const a=hub.agents.find(x=>x.name===v.name);return a?a.sessions:[]}if(v.type==='root')return hub.rootSessions;if(v.type==='session')return hub.others;return[]}
function curSession(){const list=sessionsOf(view);const s=list.find(x=>x.sid===view.sid);if(view.type==='session')return s||null;return s||list[0]||null}
const allSessions=()=>hub?[].concat(...hub.agents.map(a=>a.sessions),hub.rootSessions,hub.others):[];
function isUnread(s){const cur=isChat()&&curSession();return(s.sid in seen)&&s.n>seen[s.sid]&&!(cur&&cur.sid===s.sid)}
function go(v){view={type:v.type};if(v.name)view.name=v.name;if(v.sid)view.sid=v.sid;view.tab=v.tab||(v.type==='shared'?'files':'chat');save();rendered='';sbarHtml='';document.body.classList.remove('open');render(true)}
function fixView(){
  const before=JSON.stringify(view);
  if(view.type==='agent'&&!hub.agents.some(a=>a.name===view.name))view={type:'overview'};
  if(view.type!=='session'&&!hub.root)view=hub.others.length?{type:'session',sid:hub.others[0].sid}:{type:'overview'};
  if(view.type==='session'&&!hub.others.some(s=>s.sid===view.sid))view=hub.others.length?{type:'session',sid:hub.others[0].sid}:{type:'overview'};
  if(JSON.stringify(view)!==before){save();rendered='';sbarHtml='';return true}
}

// ---- sidebar
function navItem(on,go,attrs,icon,name,extra){return'<button class="item'+(on?' on':'')+'" data-go="'+go+'"'+attrs+'>'+icon+'<span class="nm">'+esc(name)+'</span>'+(extra||'')+'</button>'}
function renderSide(){
  if(!hub)return;const h=[];
  if(hub.root){
    h.push(navItem(view.type==='overview','overview','','<span class="ic">📊</span>','Tổng quan'));
    h.push('<div class="label">Agent</div>');
    if(!hub.agents.length)h.push('<div class="hint">Chưa có agent: tạo thư mục trong <code>agents/</code>.</div>');
    for(const a of hub.agents){const dot='<span class="dot'+(a.busy?' busy':a.live?'':' off')+'"></span>';
      h.push(navItem(view.type==='agent'&&view.name===a.name,'agent',' data-name="'+esc(a.name)+'"',dot,a.name,(a.mail?'<span class="badge" title="Thư chưa xử lý">'+a.mail+'</span>':'')+(a.sessions.some(isUnread)?'<span class="unread"></span>':'')))}
    h.push('<div class="label">Thư mục</div>');
    h.push(navItem(view.type==='root','root','','<span class="ic">🏠</span>',hub.rootName||'Thư mục tổng',hub.rootSessions.some(s=>s.live)?'<span class="dot'+(hub.rootSessions.some(s=>s.busy)?' busy':'')+'"></span>':''));
    if(hub.hasShared)h.push(navItem(view.type==='shared','shared','','<span class="ic">📁</span>','Thư mục chung'));
  }
  if(hub.others.length||!hub.root){
    h.push('<div class="label">'+(hub.root?'Phiên khác 🟢':'Phiên đang bật 🟢')+'</div>');
    if(!hub.others.length)h.push('<div class="hint">Chưa có phiên nào bật.</div>');
    for(const s of hub.others)h.push(navItem(view.type==='session'&&view.sid===s.sid,'session',' data-sid="'+esc(s.sid)+'"','<span class="dot'+(s.busy?' busy':'')+'"></span>',s.name,isUnread(s)?'<span class="unread"></span>':''));
  }
  $('list').innerHTML=h.join('');
  $('foot').textContent=hub.root?'Phiên mở trong thư mục tổng tự hiện ở đây. Chỉ dùng cho riêng bạn.':'Bật thêm phiên: trên máy, bấm nút Tele trong phiên đó. Chỉ dùng cho riêng bạn.';
  for(const b of $('list').querySelectorAll('[data-go]'))b.onclick=()=>go({type:b.dataset.go,name:b.dataset.name,sid:b.dataset.sid});
}

// ---- header, tabs, session picker
function renderHead(){
  let title='Claude Chat',tabs=[];
  if(view.type==='overview')title='📊 Tổng quan';
  else if(view.type==='agent'){title='🤖 '+view.name;tabs=[['chat','💬 Chat'],['role','📜 Vai trò'],['files','📂 File'],['mail','📥 Hộp thư']]}
  else if(view.type==='root'){title='🏠 '+((hub&&hub.rootName)||'Thư mục tổng');tabs=[['chat','💬 Chat'],['role','📜 Luật chung'],['files','📂 File']]}
  else if(view.type==='shared')title='📁 Thư mục chung';
  else if(view.type==='session'){const s=curSession();title=s?s.name:'Chọn một phiên'}
  $('title').textContent=title;
  const th=tabs.map(t=>'<button class="tab'+((view.tab||'chat')===t[0]?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+(t[0]==='mail'&&mailOf()?' <span class="badge">'+mailOf()+'</span>':'')+'</button>').join('');
  if($('tabs').innerHTML!==th){$('tabs').innerHTML=th;for(const b of $('tabs').querySelectorAll('[data-tab]'))b.onclick=()=>{view.tab=b.dataset.tab;view.path='';view.file='';save();rendered='';render(true)}}
  $('tabs').classList.toggle('hidden',!tabs.length);
  const s=isChat()?curSession():null;
  $('status').classList.toggle('hidden',!(s&&s.live));$('stop').classList.toggle('hidden',!(s&&s.live));
  const chat=isChat();$('footer').classList.toggle('hidden',!chat||!s);
  $('box').classList.toggle('hidden',!(s&&s.live));$('ro').classList.toggle('hidden',!(s&&!s.live));
}
function mailOf(){if(!hub||view.type!=='agent')return 0;const a=hub.agents.find(x=>x.name===view.name);return a?a.mail:0}
function renderSbar(){
  const on=isChat()&&view.type!=='session';
  $('sbar').classList.toggle('hidden',!on);if(!on)return;
  const list=sessionsOf(view),cur=curSession();
  const h=list.length?'<select id="pick" title="Chọn phiên">'+list.map(s=>'<option value="'+esc(s.sid)+'"'+(cur&&s.sid===cur.sid?' selected':'')+'>'+(s.busy?'⏳ ':s.live?'🟢 ':'⚪ ')+esc(s.name)+' · '+ago(s.at)+(isUnread(s)?' •':'')+'</option>').join('')+'</select><span class="meta">'+list.filter(s=>s.live).length+' đang bật · '+list.length+' phiên</span>'
    :'<span class="meta">Chưa có phiên nào. Mở phiên mới trong thư mục '+(view.type==='agent'?'<code>agents/'+esc(view.name)+'</code>':'tổng')+' trên app Claude.</span>';
  if(h===sbarHtml||document.activeElement&&document.activeElement.id==='pick')return;
  $('sbar').innerHTML=h;sbarHtml=h;
  const p=$('pick');if(p)p.onchange=()=>{view.sid=p.value;save();rendered='';render(true)};
}

// ---- views
function render(scroll){
  if(!hub)return;
  renderSide();renderHead();renderSbar();
  $('inner').classList.toggle('wide',!isChat());
  if(view.type==='overview')return renderOverview();
  if(isChat())return loadHistory(scroll);
  if(view.tab==='role')return renderRole();
  return renderFiles();
}
const stat=(n,label)=>'<div class="stat"><b>'+n+'</b><span>'+label+'</span></div>';
function renderOverview(){
  if(!hub.root)return setInner('<div class="empty">Chưa có thư mục tổng cho các agent.<br><span class="hint">Trong app Claude: bấm nút Tele → 🤖 Agent → nhập đường dẫn thư mục tổng (thư mục chứa <code>agents/</code>).<br>Hoặc mở một phiên trong <code>…/agents/&lt;tên-agent&gt;</code>, mod sẽ tự nhận.</span></div>');
  const A=hub.agents;
  let h='<div class="stats">'+stat(A.length,'agent')+stat(A.filter(a=>a.busy).length,'đang làm')+stat(A.filter(a=>a.live).length,'đang bật')+stat(A.reduce((x,a)=>x+a.mail,0),'thư chưa xử lý')+'</div>';
  if(!A.length)h+='<div class="empty">Chưa có agent nào.<br><span class="hint">Tạo một thư mục cho mỗi agent trong <code>'+esc(hub.root)+'\\agents\\</code>, rồi mở phiên Claude trong thư mục đó.</span></div>';
  h+='<div class="grid">'+A.map(a=>{
    const pill=a.busy?'<span class="pill busy">Đang làm</span>':a.live?'<span class="pill on">Đang bật</span>':'<span class="pill">Nghỉ</span>';
    const last=a.sessions.find(s=>s.last);
    return'<button class="card" data-agent="'+esc(a.name)+'"><div class="row"><b>🤖 '+esc(a.name)+'</b>'+pill+'</div><div class="meta">'+(a.at?'Hoạt động '+ago(a.at)+' · ':a.sessions.length?'Chưa có tin nhắn · ':'')+(a.sessions.length?a.sessions.length+' phiên':'Chưa có phiên nào')+(a.mail?' · 📥 '+a.mail+' thư':'')+'</div>'+(last?'<div class="snip">'+esc(plain(last.last))+'</div>':'')+'</button>'}).join('')+'</div>';
  setInner(h);
  for(const b of $('inner').querySelectorAll('[data-agent]'))b.onclick=()=>go({type:'agent',name:b.dataset.agent});
}
async function renderRole(){
  const area=view.type==='agent'?'agent:'+view.name:'root',snap=JSON.stringify(view);
  const r=await api('/api/file?area='+enc(area)+'&path=CLAUDE.md').catch(()=>({}));
  if(snap!==JSON.stringify(view))return;
  setInner(r.kind==='text'?'<div class="doc claude">'+md(r.text)+'</div><div class="meta">CLAUDE.md · sửa '+ago(r.at)+'</div>'
    :'<div class="empty">Chưa có <code>CLAUDE.md</code>.<br><span class="hint">Tạo file này trong thư mục '+(view.type==='agent'?'của agent để ghi vai trò, nhiệm vụ':'tổng để ghi luật chung cho mọi agent')+'.</span></div>');
}
function fileArea(){
  if(view.type==='shared')return{area:'shared',base:'',label:'Thư mục chung'};
  if(view.type==='root')return{area:'root',base:'',label:hub.rootName||'Thư mục tổng'};
  if(view.tab==='mail')return{area:'shared',base:'hop-thu/'+view.name,label:'Hộp thư'};
  return{area:'agent:'+view.name,base:'',label:view.name};
}
function crumbs(fa){
  const parts=(view.path||'').split('/').filter(Boolean);
  let h='<div class="crumbs"><button data-cd="">'+esc(fa.label)+'</button>';
  parts.forEach((p,i)=>{h+='<span class="sp">/</span><button data-cd="'+esc(parts.slice(0,i+1).join('/'))+'">'+esc(p)+'</button>'});
  if(view.file)h+='<span class="sp">/</span><b>'+esc(view.file)+'</b>';
  return h+'<span class="grow"></span><button class="btn" data-reload="1" title="Tải lại">↻</button></div>';
}
function wireCrumbs(){
  for(const b of $('inner').querySelectorAll('[data-cd]'))b.onclick=()=>{view.path=b.dataset.cd;view.file='';save();render(true)};
  for(const b of $('inner').querySelectorAll('[data-reload]'))b.onclick=()=>{rendered='';render(true)};
}
async function renderFiles(){
  const fa=fileArea(),dir=join(fa.base,view.path||''),snap=JSON.stringify(view);
  if(view.file){
    const rel=join(dir,view.file);
    const r=await api('/api/file?area='+enc(fa.area)+'&path='+enc(rel)).catch(()=>({error:'Lỗi tải file'}));
    if(snap!==JSON.stringify(view))return;
    let body;
    if(r.error)body='<div class="empty">'+esc(r.error)+'</div>';
    else if(r.kind==='image')body='<div class="preview"><img alt="" src="/api/raw?area='+enc(fa.area)+'&path='+enc(rel)+'&t='+r.at+'"></div>';
    else if(r.kind==='text')body=r.ext==='.md'?'<div class="doc claude">'+md(r.text)+'</div>':'<pre class="code">'+esc(r.text)+'</pre>';
    else body='<div class="empty">'+(r.kind==='big'?'File lớn quá ('+size(r.size)+') để xem trước.':'File này không xem trước được.')+'</div>';
    setInner(crumbs(fa)+body+(r.error?'':'<div class="meta">'+size(r.size)+' · sửa '+ago(r.at)+'</div>'));
    return wireCrumbs();
  }
  const r=await api('/api/files?area='+enc(fa.area)+'&path='+enc(dir)).catch(()=>({error:'Lỗi tải thư mục'}));
  if(snap!==JSON.stringify(view))return;
  let body;
  if(r.error||!r.entries.length){
    body=view.tab==='mail'&&!view.path?'<div class="empty">📭 Hộp thư trống.<br><span class="hint">Agent khác gửi việc cho <b>'+esc(view.name)+'</b> bằng cách tạo file trong <code>shared/hop-thu/'+esc(view.name)+'/</code>.</span></div>'
      :'<div class="empty">'+(r.error?esc(r.error):'Thư mục trống.')+'</div>';
  }else{
    const list=view.tab==='mail'?r.entries.slice().sort((a,b)=>(b.dir-a.dir)||(b.at-a.at)):r.entries;
    body='<div class="flist">'+list.map(e=>'<button class="frow" data-'+(e.dir?'dir':'open')+'="'+esc(e.name)+'"><span>'+(e.dir?'📁':/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(e.name)?'🖼️':/\.md$/i.test(e.name)?'📝':'📄')+'</span><span class="nm">'+esc(e.name)+'</span><span class="meta">'+(e.dir?'':size(e.size)+' · ')+ago(e.at)+'</span></button>').join('')+'</div>';
  }
  setInner(crumbs(fa)+body);wireCrumbs();
  for(const b of $('inner').querySelectorAll('[data-dir]'))b.onclick=()=>{view.path=join(view.path,b.dataset.dir);save();render(true)};
  for(const b of $('inner').querySelectorAll('[data-open]'))b.onclick=()=>{view.file=b.dataset.open;save();render(true)};
}
async function loadHistory(scroll){
  const s=curSession();
  if(!s)return setInner(view.type==='session'?'<div class="empty">Chọn một phiên.</div>':'<div class="empty">Chưa có phiên nào ở đây.</div>');
  const sid=s.sid,snap=JSON.stringify(view);
  try{
    const r=await api('/api/history?sid='+enc(sid));
    if(snap!==JSON.stringify(view))return;
    const items=(r.items||[]).concat((r.notes||[]).map(n=>({role:'note',text:n.text,at:n.at}))).sort((a,b)=>a.at-b.at);
    seen[sid]=Math.max(r.count||0,s.n||0);keep.set('cdm_seen2',seen);
    pending=pending.filter(p=>p.sid===sid&&!items.some(m=>m.role==='me'&&m.text.trim()===p.text.trim()&&m.at>=p.at-60000));
    const view_=items.map(m=>m.role==='claude'?'<div class="claude">'+md(m.text)+'</div>':m.role==='me'?'<div class="me">'+esc(m.text)+'</div>':'<div class="note">'+esc(m.text)+'</div>').join('')
      +pending.map(p=>'<div class="me pending">'+esc(p.text)+'</div>').join('')
      +(s.busy?'<div class="working">Claude đang làm</div>':'');
    const html=view_||'<div class="empty">Chưa có tin nhắn nào trong phiên này.</div>';
    if(html!==rendered){const log=$('log');const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<120;$('inner').innerHTML=html;rendered=html;if(scroll||atBottom)log.scrollTop=log.scrollHeight}
  }catch(e){}
}

// ---- polling
async function loadHub(){
  try{const r=await api('/api/hub');show(true);hub=r;
    for(const s of allSessions())if(!(s.sid in seen))seen[s.sid]=s.n;keep.set('cdm_seen2',seen);
    return fixView();
  }catch(e){}
}
async function tick(){
  const moved=await loadHub();
  if(hub){if(moved)render(true);else{renderSide();renderHead();renderSbar();if(isChat())await loadHistory(false);else if(view.type==='overview')renderOverview()}}
  setTimeout(tick,2000);
}

// ---- sending
async function post(body){
  const s=isChat()&&curSession();
  if(!s||!s.live){alert('Phiên này không còn bật 🟢 trên máy.');return false}
  const r=await api('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,sid:s.sid})});
  if(r.error)alert(r.error);return !r.error;
}
async function sendText(t){const s=curSession();if(!t.trim()||busy||!s)return;busy=true;pending.push({sid:s.sid,text:t,at:Date.now()});rendered='';loadHistory(true);
  if(!(await post({text:t}).finally(()=>busy=false)))pending=pending.filter(p=>p.text!==t)}
$('send').onclick=()=>{const t=$('text').value;$('text').value='';autosize();sendText(t)};
const autosize=()=>{const t=$('text');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,200)+'px'};
$('text').oninput=autosize;
$('text').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!('ontouchstart' in window)){e.preventDefault();$('send').click()}};
$('stop').onclick=()=>post({kind:'stop'});$('status').onclick=()=>post({kind:'status'});
$('menu').onclick=()=>document.body.classList.add('open');$('scrim').onclick=()=>document.body.classList.remove('open');
$('attach').onclick=()=>$('file').click();
$('file').onchange=async()=>{const f=$('file').files[0];if(!f)return;
  const r=await api('/api/upload',{method:'POST',headers:{'x-name':enc(f.name)},body:f});$('file').value='';
  if(!r.ok)return alert(r.error||'Lỗi tải file');
  const img=f.type.startsWith('image/');const note=$('text').value.trim()||(img?'Xem ảnh này.':'Xem file này.');$('text').value='';
  sendText(note+'\n\n['+(img?'Ảnh':'File')+' gửi từ trang chat, đã lưu trên máy tại: '+r.path+']');
};
$('go').onclick=async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('pw').value})});
  if(r.ok){$('loginErr').textContent='';await loadHub();render(true)}else $('loginErr').textContent='Sai mật khẩu'};
$('pw').onkeydown=e=>{if(e.key==='Enter')$('go').click()};
(async()=>{await loadHub();if(hub)render(true);setTimeout(tick,2000)})();
</script></body></html>`
