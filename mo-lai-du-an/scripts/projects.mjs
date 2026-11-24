// Finds the project folders Claude Code has worked in on this computer and
// writes hand-off notes from a project's latest session. Read-only on
// Claude's data: it only reads the transcripts in ~/.claude/projects.
//
//   node projects.mjs list                 → JSON: [{ cwd, title, lastAt, sid, file, hasClaudeMd }]
//   node projects.mjs handoff <file> <out> → writes a short Markdown hand-off to <out>
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(os.homedir(), '.claude', 'projects')
const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CACHE_FILE = path.join(MOD_DIR, '.cache.json')
const CACHE_VERSION = 1

// Folders that are not projects: temp and app scratch space.
const isScratch = cwd =>
  /\\AppData\\Local\\Temp\\|\\AppData\\Roaming\\Claude\\scratch-workspaces\\|[\\/]scratchpad([\\/]|$)/i.test(cwd)

const exists = p => fs.stat(p).then(() => true, () => false)

async function* records(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      yield JSON.parse(line)
    } catch {}
  }
}

// One transcript → where it ran and what it is called.
async function describe(file) {
  let cwd = ''
  let title = ''
  let firstPrompt = ''
  let turns = 0
  for await (const o of records(file)) {
    if (o.type === 'custom-title' && o.customTitle) title = String(o.customTitle)
    if (o.isSidechain) continue
    if (!cwd && typeof o.cwd === 'string' && !isScratch(o.cwd)) cwd = o.cwd
    if (o.type === 'user' && !o.isMeta && typeof o.message?.content === 'string') {
      const t = o.message.content.trim()
      if (t && !t.startsWith('<')) {
        turns++
        if (!firstPrompt) firstPrompt = t.slice(0, 60)
      }
    }
  }
  return { cwd, title: title || firstPrompt, turns }
}

async function list() {
  let cache = {}
  try {
    const c = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))
    if (c.version === CACHE_VERSION) cache = c.files
  } catch {}
  const next = {}
  const sessions = []
  for (const dir of await fs.readdir(ROOT).catch(() => [])) {
    const full = path.join(ROOT, dir)
    for (const name of await fs.readdir(full).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(full, name)
      const st = await fs.stat(file).catch(() => undefined)
      if (!st?.isFile()) continue
      const hit = cache[file]
      const info =
        hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit : { size: st.size, mtimeMs: st.mtimeMs, ...(await describe(file)) }
      next[file] = info
      if (info.cwd && info.turns > 0) sessions.push({ ...info, file, sid: name.slice(0, -6), lastAt: st.mtimeMs })
    }
  }
  await fs.writeFile(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: next })).catch(() => {})

  // One entry per folder: its most recent session.
  const byCwd = new Map()
  for (const s of sessions) {
    const key = s.cwd.toLowerCase()
    const cur = byCwd.get(key)
    if (!cur || s.lastAt > cur.lastAt) byCwd.set(key, s)
  }
  const out = []
  for (const s of byCwd.values()) {
    if (!(await exists(s.cwd))) continue
    out.push({
      cwd: s.cwd,
      title: s.title || path.basename(s.cwd),
      lastAt: s.lastAt,
      sid: s.sid,
      file: s.file,
      hasClaudeMd: await exists(path.join(s.cwd, 'CLAUDE.md')),
    })
  }
  out.sort((a, b) => b.lastAt - a.lastAt)
  return out
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s)

// The last turns of a session, as notes the next person's session can read.
async function handoff(file, outFile) {
  let title = ''
  let cwd = ''
  const turns = [] // [{ ask, answer, at }]
  for await (const o of records(file)) {
    if (o.type === 'custom-title' && o.customTitle) title = String(o.customTitle)
    if (o.isSidechain || o.isMeta) continue
    if (!cwd && typeof o.cwd === 'string' && !isScratch(o.cwd)) cwd = o.cwd
    const content = o.message?.content
    if (o.type === 'user') {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content) && !content.some(b => b.type === 'tool_result')
            ? content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : ''
      const t = text.trim()
      if (t && !t.startsWith('<')) turns.push({ ask: t, answer: '', at: o.timestamp })
    } else if (o.type === 'assistant' && Array.isArray(content) && turns.length) {
      const t = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (t) turns[turns.length - 1].answer += (turns[turns.length - 1].answer ? '\n\n' : '') + t
    }
  }
  const last = turns.slice(-8)
  const lines = [
    `# Bàn giao: ${title || path.basename(cwd)}`,
    '',
    `- Thư mục dự án: ${cwd}`,
    `- Tạo tự động từ phiên trước (${turns.length} lượt), có thể do người khác hoặc tài khoản khác làm.`,
    `- Đây là ${last.length} lượt gần nhất, đã rút gọn. Đọc để nắm ngữ cảnh; chi tiết hơn xem CLAUDE.md và code.`,
    '',
  ]
  last.forEach((t, i) => {
    lines.push(`## Lượt ${turns.length - last.length + i + 1}${t.at ? ` (${String(t.at).slice(0, 16).replace('T', ' ')})` : ''}`)
    lines.push('', '**Yêu cầu:**', clip(t.ask, 800), '')
    if (t.answer) lines.push('**Claude trả lời:**', clip(t.answer, 1500), '')
  })
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, lines.join('\n'))
  return outFile
}

const [cmd, a, b] = process.argv.slice(2)
try {
  if (cmd === 'list') process.stdout.write(JSON.stringify(await list()))
  else if (cmd === 'handoff') process.stdout.write(JSON.stringify({ ok: true, path: await handoff(a, b) }))
  else throw new Error('lệnh không rõ')
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
  process.exitCode = 1
}
