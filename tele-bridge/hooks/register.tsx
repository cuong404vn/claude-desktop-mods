import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Bridge, Form, Mail, SessionEntry, WebInfo } from '../types'

// Telegram ⇄ Claude sessions.
//
// - Every session starts 🔴 off. Turn any number of sessions 🟢 on (Tele button).
// - On Telegram, /phien lists the 🟢 sessions as buttons; the one you pick is
//   the one you talk to. Every answer is headed by its session's name.
// - Only answers to messages sent FROM Telegram go back to Telegram: chatting
//   at the computer, even in a 🟢 session, sends nothing.
//
// Telegram lets one program read a bot's messages at a time, so the 🟢
// sessions elect one "leader" (store key `leader`) that polls the bot and
// hands each message to the chosen session through the shared store
// (`msg:<sessionId>:<n>`). If the leader goes away, another 🟢 session takes
// over. Settings (bot token, chat ID) live in config.local.json.
//
// Agents: an agent root is a folder holding `agents/<name>/` (one folder per
// agent) and `shared/`. Sessions opened anywhere under it turn 🟢 by
// themselves, and the chat page lists them by agent. The root is set in the
// pane, or found from the first session opened in `…/agents/<name>`.

const API = 'https://api.telegram.org/bot'
const POLL_SECONDS = 10
const MAX_MSG = 4000
const PANE = 'tele-bridge'
const TITLE = 'Telegram'
const LIVE_MS = 45_000 // a 🟢 session not seen for this long counts as gone
const LEADER_STALE_MS = 40_000 // a leader not seen for this long is replaced
const IDLE_SLEEP_MS = 2000 // how often a non-leader checks its mailbox
const CONFLICT_GRACE_MS = 45_000

const bridge = atom(
  { plugin: 'tele-bridge', key: 'bridge' } as const,
  { isOn: false, loopId: '' } as Bridge,
  { shape: 'bridge-1' },
)
const form = atom(
  { plugin: 'tele-bridge', key: 'form' } as const,
  { chatId: '', token: '' } as Form,
  { shape: 'form-1' },
)

type WebConfig = { enabled: boolean; lan: boolean; password?: string; port?: number }
type Config = { botToken?: string; chatId?: number; web?: WebConfig; agentRoot?: string }
// Where a remote message came from, and so where its answer goes.
type Origin = 'tele' | 'web'
const WEB_PORT = 8787
type Update = {
  update_id: number
  message?: {
    chat: { id: number }
    text?: string
    caption?: string
    photo?: { file_id: string; file_size?: number }[]
    document?: { file_id: string; file_name?: string; file_size?: number }
  }
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } }
}

// The keyboard kept under the chat box on Telegram: one tap instead of typing.
const KEYBOARD_COMMANDS: Record<string, string> = {
  '📋 Chọn phiên': '/phien',
  'ℹ️ Trạng thái': '/status',
  '⏹ Dừng': '/stop',
}
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📋 Chọn phiên' }, { text: 'ℹ️ Trạng thái' }, { text: '⏹ Dừng' }]],
    resize_keyboard: true,
    is_persistent: true,
  },
}
// Under each answer: switch session, or ask that session's status.
const answerButtons = (sid: string) => ({
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📋 Đổi phiên', callback_data: 'list' },
        { text: 'ℹ️ Trạng thái', callback_data: `status:${sid}` },
      ],
    ],
  },
})
// The bot's "Menu" button on Telegram.
const BOT_COMMANDS = [
  { command: 'phien', description: 'Chọn phiên Claude để trò chuyện' },
  { command: 'status', description: 'Phiên đang chọn đang làm gì' },
  { command: 'stop', description: 'Dừng việc phiên đang chọn đang làm' },
]

const TOKEN_RE = /^\d+:[\w-]{20,}$/
const CHAT_RE = /^-?\d+$/

// Per-process, per-session bookkeeping (a reload starts these over).
let currentTurnId: string | undefined
// The folder this session runs in (read at session.start).
let myCwd = ''
// Prompts submitted from Telegram or the chat page, not yet started.
const remoteTexts: { text: string; origin: Origin }[] = []
// Turn ids that answer a remote message, and where the answer goes.
const remoteTurns = new Map<string, Origin>()

// ---------------------------------------------------------------- config

const configPath = ($: EngineInterface) => `${$.plugin.root}/config.local.json`

async function readRaw($: EngineInterface): Promise<Config> {
  try {
    return JSON.parse(await $.fs.read(configPath($))) as Config
  } catch {
    return {}
  }
}

async function readConfig($: EngineInterface): Promise<Config> {
  const c = await readRaw($)
  return {
    botToken: c.botToken && TOKEN_RE.test(c.botToken.trim()) ? c.botToken.trim() : undefined,
    chatId: typeof c.chatId === 'number' ? c.chatId : undefined,
    web: c.web && typeof c.web === 'object' ? c.web : undefined,
    agentRoot: typeof c.agentRoot === 'string' && c.agentRoot.trim() ? c.agentRoot.trim() : undefined,
  }
}

// Merges into what the file holds, so Telegram and chat-page settings keep each other.
async function writeConfig($: EngineInterface, patch: Config) {
  const merged = { ...(await readRaw($)), ...patch }
  await $.fs.write(configPath($), JSON.stringify(merged, null, 2))
}

const hasTelegram = (c: Config) => c.botToken !== undefined && c.chatId !== undefined
const hasWeb = (c: Config) => Boolean(c.web?.enabled)

const maskToken = (t?: string) => (t ? `••••${t.slice(-4)}` : 'chưa có')

// -------------------------------------------------------------- telegram

async function tg($: EngineInterface, token: string, method: string, body: object) {
  const r = await $.http.fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = JSON.parse(r.text || '{}') as { ok?: boolean; result?: unknown; description?: string }
  if (!data.ok) throw new Error(`${method}: ${data.description ?? r.status}`)
  return data.result
}

async function send($: EngineInterface, text: string, extra: object = {}) {
  const { botToken, chatId } = await readConfig($)
  if (!botToken || chatId === undefined) return
  const body = text.trim() || '(trống)'
  for (let i = 0; i < body.length; i += MAX_MSG) {
    const last = i + MAX_MSG >= body.length
    await tg($, botToken, 'sendMessage', {
      chat_id: chatId,
      text: body.slice(i, i + MAX_MSG),
      ...(last ? extra : {}),
    })
  }
}

// ------------------------------------------------------------ chat page

// Shows a small note in this session's chat on the page (stopped, status,
// waiting for permission). Claude's answers need none: the page reads them
// from the session's transcript, like everything typed at the computer.
async function webNote($: EngineInterface, text: string) {
  const info = (await $.store.get('web')) as WebInfo | undefined
  if (!info) return
  await $.http.fetch(`http://127.0.0.1:${info.port}/internal/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-key': info.key },
    body: JSON.stringify({ sid: await $.session.id(), text }),
  })
}

// Refreshes this session's live entry right away (the page's "đang làm").
async function markBusy($: EngineInterface) {
  const b = await read($, bridge)
  if (!b.isOn) return
  await $.store.set(`sess:${await $.session.id()}`, {
    name: b.name ?? 'Claude',
    at: await $.clock.now(),
    busy: currentTurnId !== undefined,
    cwd: myCwd,
  } satisfies SessionEntry)
}

// Answers a remote message where it came from.
async function reply($: EngineInterface, origin: Origin, text: string, extra: object = {}) {
  if (origin === 'web') await webNote($, text)
  else await send($, text, extra)
}

// Runs scripts/tg-file.mjs (download a Telegram file / send one to the chat).
async function fileScript(
  $: EngineInterface,
  args: string[],
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/tg-file.mjs`, ...args], {
      timeoutMs: 120_000,
    })
    return JSON.parse(r.stdout || '{}') as { ok: boolean; path?: string; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ------------------------------------------------------------- sessions

const sessKey = (sid: string) => `sess:${sid}` // live entry, while the session runs
const onKey = (sid: string) => `on:${sid}` // the person turned it 🟢: remembered across restarts
const allKey = (sid: string) => `all:${sid}` // "báo cả việc giao trên máy" for this session
const offKey = (sid: string) => `off:${sid}` // the person turned an agent session 🔴: it stays so
const mailPrefix = (sid: string) => `msg:${sid}:`

// A title an earlier version marked with 🟢 (that feature was removed: the
// app's security plugin does not let mods retitle sessions).
const stripMark = (t: string) => t.replace(/^🟢 /, '')

// The session's title as the app stores it ("" when it has none yet).
async function sessionTitle($: EngineInterface): Promise<string> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/title.mjs`, await $.session.id()], {
      timeoutMs: 20_000,
    })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function sessionName($: EngineInterface): Promise<string> {
  const t = stripMark(await sessionTitle($))
  if (t) return t.slice(0, 40)
  const cwd = await $.session.cwd()
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'Phiên Claude'
}


type LiveSession = { sid: string; name: string; busy: boolean; cwd: string }

async function liveSessions($: EngineInterface): Promise<LiveSession[]> {
  const now = await $.clock.now()
  const out: LiveSession[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('sess:')) continue
    const s = (await $.store.get(key)) as SessionEntry | undefined
    if (s && now - s.at < LIVE_MS) {
      out.push({ sid: key.slice(5), name: s.name, busy: Boolean(s.busy), cwd: s.cwd ?? '' })
    }
  }
  return out
}

// --------------------------------------------------------------- agents

// Paths compared the way Windows does: either slash, any case.
const slash = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
const isUnder = (p: string, base: string) => {
  const a = slash(p).toLowerCase()
  const b = slash(base).toLowerCase()
  return a === b || a.startsWith(`${b}/`)
}

// `<root>/agents/<name>/…` → `<root>`.
function rootFromCwd(cwd: string): string | undefined {
  const parts = cwd.split(/[\\/]/)
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i]!.toLowerCase() === 'agents' && parts[i + 1]) {
      return parts.slice(0, i).join(cwd.includes('\\') ? '\\' : '/')
    }
  }
  return undefined
}

// The agent a session opened in `cwd` belongs to: its name, '' anywhere
// else under the root, undefined outside it.
function agentOf(cwd: string, root?: string): string | undefined {
  if (!root || !cwd || !isUnder(cwd, root)) return undefined
  const rest = slash(cwd).slice(slash(root).length).split('/').filter(Boolean)
  return rest[0]?.toLowerCase() === 'agents' && rest[1] ? rest[1] : ''
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// Whether this session turns 🟢 by itself: it runs under the agent root. The
// first session opened in `…/agents/<name>` sets the root when none is set.
async function autoOn($: EngineInterface): Promise<boolean> {
  const cfg = await readConfig($)
  if (!hasTelegram(cfg) && !hasWeb(cfg)) return false
  let root = cfg.agentRoot
  if (!root) {
    root = rootFromCwd(myCwd)
    if (!root) return false
    await writeConfig($, { agentRoot: root })
    $.ui.toast(`🤖 Thư mục tổng của các agent: ${root}`)
  }
  return agentOf(myCwd, root) !== undefined
}

async function setRoot($: EngineInterface, value: string) {
  const v = value.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '')
  const note = (text: string, isError = false) =>
    update($, form, x => ({ ...x, note: text, isError, rootInput: isError ? x.rootInput : '' }))
  if (!v) {
    await writeConfig($, { agentRoot: undefined })
    return note('Đã bỏ thư mục tổng. Phiên mở trong …\\agents\\<tên> sẽ đặt lại.')
  }
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(v)) return note('Cần đường dẫn đầy đủ, vd E:\\AI\\cong-ty', true)
  if (!(await $.fs.exists(v).catch(() => false))) return note('Không thấy thư mục này trên máy.', true)
  await writeConfig($, { agentRoot: v })
  const hasAgents = await $.fs.exists(`${v}/agents`).catch(() => false)
  await note(hasAgents ? 'Đã lưu.' : 'Đã lưu. Tạo thư mục agents\\ trong đó, mỗi agent một thư mục con.')
  const cfg = await readConfig($)
  if (!(await read($, bridge)).isOn && agentOf(myCwd, v) !== undefined && (hasTelegram(cfg) || hasWeb(cfg))) {
    await enable($)
  }
}

async function nameOf($: EngineInterface, sid: string) {
  const s = (await $.store.get(sessKey(sid))) as SessionEntry | undefined
  return s?.name ?? 'phiên đã tắt'
}

async function setBridge($: EngineInterface, fn: (b: Bridge) => Bridge) {
  await update($, bridge, b => fn(b))
  $.ui.status(undefined)
}

// ------------------------------------------- messages for THIS session

async function handleMail($: EngineInterface, mail: Mail) {
  const { name = 'Claude' } = await read($, bridge)
  const origin: Origin = mail.origin ?? 'tele'
  // On the page each message already sits under its session; Telegram needs the name.
  const tag = origin === 'web' ? '' : `[${name}] `
  if (mail.kind === 'stop') {
    if (currentTurnId) await $.turn.abort({ turnId: currentTurnId })
    await reply($, origin, `${tag}${currentTurnId ? '⏹ Đã dừng.' : 'Đang không làm gì.'}`)
    return
  }
  if (mail.kind === 'status') {
    await reply($, origin, `${tag}${currentTurnId ? '⏳ Đang làm việc…' : '💤 Đang chờ tin nhắn.'}`)
    return
  }
  const text = mail.text?.trim()
  if (!text) return
  remoteTexts.push({ text, origin })
  void $.prompt.submit({ text, asUser: true })
}

async function drainMailbox($: EngineInterface, me: string) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(mailPrefix(me)))
  keys.sort((a, b) => Number(a.split(':')[2]) - Number(b.split(':')[2]))
  for (const key of keys) {
    const mail = (await $.store.get(key)) as Mail | undefined
    await $.store.delete(key)
    if (mail) await handleMail($, mail).catch(() => undefined)
  }
}

// --------------------------------------- the leader: route bot messages

async function deliver($: EngineInterface, me: string, target: string, id: number, mail: Mail) {
  if (target === me) await handleMail($, mail)
  else await $.store.set(`${mailPrefix(target)}${id}`, mail)
}

async function listSessions($: EngineInterface) {
  const live = await liveSessions($)
  const active = (await $.store.get('active')) as string | undefined
  if (live.length === 0) {
    await send($, '🔴 Chưa có phiên nào bật. Trên máy, bấm nút Tele ở phiên muốn dùng để bật 🟢.')
    return
  }
  await send($, 'Chọn phiên để trò chuyện:', {
    reply_markup: {
      inline_keyboard: live.map(s => [
        // 🔵 the session you are talking to · 🟢 the others that are on
        { text: `${s.sid === active ? '🔵 ' : '🟢 '}${s.name}${s.sid === active ? ' (đang chọn)' : ''}`, callback_data: `pick:${s.sid}` },
      ]),
    },
  })
}

async function route($: EngineInterface, me: string, token: string, u: Update) {
  const { chatId } = await readConfig($)
  if (chatId === undefined) return

  const cb = u.callback_query
  if (cb) {
    if (cb.message?.chat.id !== chatId) return
    await tg($, token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => undefined)
    const [action, sid] = (cb.data ?? '').split(':')
    if (action === 'list') return listSessions($)
    if (!sid) return
    if (action === 'pick') {
      await $.store.set('active', sid)
      await send($, `🔵 Đang trò chuyện với [${await nameOf($, sid)}]. Cứ nhắn tin như bình thường.`, MAIN_KEYBOARD)
      return
    }
    if (action === 'stop' || action === 'status') {
      if (!(await liveSessions($)).some(s => s.sid === sid)) {
        await send($, '🔴 Phiên đó đã tắt.')
        return
      }
      await deliver($, me, sid, u.update_id, { kind: action })
    }
    return
  }

  const msg = u.message
  if (!msg || msg.chat.id !== chatId) return

  // A photo or file: save it on this computer, tell Claude where it is.
  const photo = msg.photo?.[msg.photo.length - 1]
  const doc = msg.document
  let raw = (msg.text ?? msg.caption ?? '').trim()
  if (photo || doc) {
    const got = await fileScript($, [
      'download',
      (photo ?? doc)!.file_id,
      doc?.file_name ?? 'anh-telegram.jpg',
    ])
    if (!got.ok || !got.path) {
      await send($, `⚠️ Không tải được file: ${got.error ?? 'lỗi không rõ'}`)
      return
    }
    raw = `${raw || (photo ? 'Xem ảnh này.' : 'Xem file này.')}\n\n[${photo ? 'Ảnh' : 'File'} gửi từ Telegram, đã lưu trên máy tại: ${got.path}]`
  }
  if (!raw) return
  // The keyboard's buttons send their label as text: map them to commands.
  const text = KEYBOARD_COMMANDS[raw] ?? raw

  if (text === '/start') {
    await tg($, token, 'setMyCommands', { commands: BOT_COMMANDS }).catch(() => undefined)
    await send($, '👋 Các nút bấm nhanh đã hiện dưới ô chat.', MAIN_KEYBOARD)
  }
  if (text === '/phien' || text === '/start') return listSessions($)

  const live = await liveSessions($)
  let target = (await $.store.get('active')) as string | undefined
  if (!target || !live.some(s => s.sid === target)) {
    const only = live.length === 1 ? live[0] : undefined
    if (!only) {
      await send($, live.length ? 'Chưa chọn phiên. Gõ /phien để chọn.' : '🔴 Chưa có phiên nào bật.')
      return
    }
    target = only.sid
    await $.store.set('active', target)
  }

  const kind: Mail['kind'] = text === '/stop' ? 'stop' : text === '/status' ? 'status' : 'text'
  if (kind === 'text') {
    await send($, `📥 [${await nameOf($, target)}] đã nhận, đang làm…`, {
      reply_markup: { inline_keyboard: [[{ text: '⏹ Dừng', callback_data: `stop:${target}` }]] },
    })
  }
  await deliver($, me, target, u.update_id, { kind, text, origin: 'tele' })
}

// ------------------------------------- the leader: run the chat page

type WebRun = {
  sig: string
  loopId: string
  stream: ReturnType<EngineInterface['process']['spawn']>
}
let webRun: WebRun | undefined

function stopWeb($: EngineInterface) {
  const run = webRun
  if (!run) return
  webRun = undefined
  void run.stream.return({ code: null, signal: null }).catch(() => undefined)
  void $.store.delete('web').catch(() => undefined)
}

// Starts the page server if it should run here and isn't, restarts it when
// its settings changed, stops it when it was turned off; pushes the session
// list to the page.
async function ensureWeb($: EngineInterface, me: string, loopId: string) {
  const cfg = await readConfig($)
  const sig = JSON.stringify(cfg.web ?? null)
  if (webRun && (!hasWeb(cfg) || webRun.sig !== sig || webRun.loopId !== loopId)) stopWeb($)
  if (!hasWeb(cfg) || !cfg.web) return

  if (!webRun) {
    const port = cfg.web.port ?? WEB_PORT
    const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('')
    const stream = $.process.spawn({
      argv: ['node', `${$.plugin.root}/scripts/web-server.mjs`],
      input:
        JSON.stringify({ port, lan: cfg.web.lan, password: cfg.web.password ?? '', key, root: cfg.agentRoot ?? '' }) +
        '\n',
    })
    const run: WebRun = { sig, loopId, stream }
    webRun = run
    void (async () => {
      let buf = ''
      try {
        for await (const chunk of stream) {
          if (chunk.stream !== 'stdout') continue
          buf += chunk.text
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('{')) continue
            const msg = JSON.parse(line) as { ready?: boolean; urls?: string[]; error?: string }
            if (msg.ready) {
              const info: WebInfo = { port, key, urls: msg.urls ?? [], sid: me }
              await $.store.set('web', info)
              await setBridge($, x => ({ ...x, lastError: undefined }))
            } else if (msg.error) {
              await setBridge($, x => ({
                ...x,
                lastError: /EADDRINUSE/.test(msg.error ?? '')
                  ? `Cổng ${port} đang bị chương trình khác dùng`
                  : `Trang chat: ${msg.error}`,
              }))
            }
          }
        }
      } catch {}
      if (webRun === run) {
        webRun = undefined
        await $.store.delete('web').catch(() => undefined)
      }
    })()
    void webInbox($, me, run)
  }

  const info = (await $.store.get('web')) as WebInfo | undefined
  if (info?.sid === me) {
    const sessions = await liveSessions($)
    await $.http.fetch(`http://127.0.0.1:${info.port}/internal/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-key': info.key },
      body: JSON.stringify({ sessions, root: cfg.agentRoot ?? '' }),
    })
  }
}

// Takes what is typed on the page and hands it to the chosen session.
async function webInbox($: EngineInterface, me: string, run: WebRun) {
  while (webRun === run) {
    const info = (await $.store.get('web')) as WebInfo | undefined
    if (!info || info.sid !== me) {
      await $.clock.sleep(500)
      continue
    }
    try {
      const r = await $.http.fetch(`http://127.0.0.1:${info.port}/internal/inbox?wait=20`, {
        headers: { 'x-key': info.key },
      })
      const items = JSON.parse(r.text || '[]') as { id: number; sid: string; kind: Mail['kind']; text?: string }[]
      for (const it of items) {
        await deliver($, me, it.sid, it.id, { kind: it.kind, text: it.text, origin: 'web' }).catch(() => undefined)
      }
    } catch {
      await $.clock.sleep(2000)
    }
  }
}

// ------------------------------------------------------ the session loop

async function loop($: EngineInterface, loopId: string) {
  const me = await $.session.id()
  let conflictSince = 0
  let beats = 0
  for (;;) {
    const b = await read($, bridge)
    if (!b.isOn || b.loopId !== loopId) return
    const now = await $.clock.now()

    // Heartbeat (refresh the name now and then: the session may be renamed).
    if (beats++ % 30 === 29) {
      const name = await sessionName($)
      if (name !== b.name) await setBridge($, x => ({ ...x, name }))
    }
    await $.store.set(sessKey(me), {
      name: (await read($, bridge)).name ?? 'Claude',
      at: now,
      busy: currentTurnId !== undefined,
      cwd: myCwd,
    } satisfies SessionEntry)
    await drainMailbox($, me)

    // Mirror the chat page's addresses into this session's state (pane redraws).
    const wi = (await $.store.get('web')) as WebInfo | undefined
    const urls = wi?.urls ?? []
    if (JSON.stringify(urls) !== JSON.stringify(b.webUrls ?? [])) {
      await setBridge($, x => ({ ...x, webUrls: urls }))
    }

    // Leader election.
    const leader = (await $.store.get('leader')) as { sid: string; at: number } | undefined
    const isMine = leader?.sid === me
    if (!isMine && leader && now - leader.at < LEADER_STALE_MS) {
      stopWeb($)
      await $.clock.sleep(IDLE_SLEEP_MS)
      continue
    }
    await $.store.set('leader', { sid: me, at: now })
    if (!isMine) {
      await $.clock.sleep(300 + Math.floor(Math.random() * 400))
      if (((await $.store.get('leader')) as { sid: string } | undefined)?.sid !== me) {
        stopWeb($)
        continue
      }
    }

    // The leader also runs the chat page (when it is turned on).
    await ensureWeb($, me, loopId).catch(() => undefined)

    const cfg = await readConfig($)
    const { botToken } = cfg
    if (!botToken || cfg.chatId === undefined) {
      if (hasWeb(cfg)) {
        if (b.lastError) await setBridge($, x => ({ ...x, lastError: undefined }))
        await $.clock.sleep(IDLE_SLEEP_MS)
      } else {
        await setBridge($, x => ({ ...x, lastError: 'chưa cài Telegram hoặc trang chat' }))
        await $.clock.sleep(10_000)
      }
      continue
    }
    try {
      let offset = Number((await $.store.get('offset')) ?? 0)
      const updates = (await tg($, botToken, 'getUpdates', {
        offset,
        timeout: POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      })) as Update[]
      if (b.lastError) await setBridge($, x => ({ ...x, lastError: undefined }))
      conflictSince = 0
      for (const u of updates) {
        offset = u.update_id + 1
        await $.store.set('offset', offset)
        await route($, me, botToken, u).catch(() => undefined)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 409 Conflict: a previous poll (this or another session's) is still
      // open for a moment after a takeover; only a lasting one is an error.
      if (/conflict/i.test(msg)) {
        const t = await $.clock.now()
        if (conflictSince === 0) conflictSince = t
        if (t - conflictSince < CONFLICT_GRACE_MS) {
          await $.clock.sleep(3000)
          continue
        }
        await setBridge($, x => ({
          ...x,
          lastError: 'Bot đang bị chương trình khác dùng cùng lúc (máy khác, hoặc plugin Telegram khác dùng chung bot)',
        }))
      } else {
        await setBridge($, x => ({ ...x, lastError: msg.slice(0, 120) }))
      }
      await $.clock.sleep(10_000)
    }
  }
}

// --------------------------------------------------------- on / off

async function enable($: EngineInterface) {
  const me = await $.session.id()
  const loopId = String(await $.clock.now()) + Math.random().toString(36).slice(2, 8)
  const name = await sessionName($)
  await $.store.set(onKey(me), true)
  await $.store.delete(offKey(me))
  await $.store.set(sessKey(me), { name, at: await $.clock.now(), cwd: myCwd } satisfies SessionEntry)
  const active = (await $.store.get('active')) as string | undefined
  const live = await liveSessions($)
  if (!active || !live.some(s => s.sid === active)) await $.store.set('active', me)
  const notifyAll = Boolean(await $.store.get(allKey(me)))
  await setBridge($, () => ({ isOn: true, loopId, name, notifyAll }))
  void loop($, loopId)
}

async function setNotifyAll($: EngineInterface, value: boolean) {
  const me = await $.session.id()
  if (value) await $.store.set(allKey(me), true)
  else await $.store.delete(allKey(me))
  await setBridge($, b => ({ ...b, notifyAll: value }))
  $.ui.toast(
    value
      ? '🔔 Sẽ báo về Telegram cả việc giao trên máy ở phiên này'
      : 'Chỉ báo về Telegram việc giao từ Telegram',
  )
}

// `forget`: the person turned it off (it stays 🔴 next time). Without it the
// session is only closing: it leaves the live list but comes back 🟢 when
// it is opened again.
async function disable($: EngineInterface, forget = true) {
  const me = await $.session.id()
  await setBridge($, b => ({ ...b, isOn: false, lastError: undefined }))
  stopWeb($)
  if (forget) {
    await $.store.delete(onKey(me))
    // An agent session would turn 🟢 again by itself next time: remember no.
    if (agentOf(myCwd, (await readConfig($)).agentRoot) !== undefined) await $.store.set(offKey(me), true)
  }
  await $.store.delete(sessKey(me))
  const leader = (await $.store.get('leader')) as { sid: string } | undefined
  if (leader?.sid === me) await $.store.delete('leader')
  if ((await $.store.get('active')) === me) await $.store.delete('active')
  for (const key of await $.store.keys()) {
    if (key.startsWith(mailPrefix(me))) await $.store.delete(key)
  }
}

// ------------------------------------------------------------ settings

async function save($: EngineInterface) {
  const f = await read($, form)
  const cfg = await readConfig($)
  const token = f.token.trim() || cfg.botToken || ''
  const chat = f.chatId.trim()
  const fail = (note: string) => update($, form, x => ({ ...x, note, isError: true }))

  if (!CHAT_RE.test(chat)) return fail('Cần Chat ID (chỉ gồm số). Lấy ID: nhắn @userinfobot.')
  if (!TOKEN_RE.test(token)) return fail('Token không đúng dạng (vd 123456:ABC…).')

  await writeConfig($, { botToken: token, chatId: Number(chat) })
  await update($, form, x => ({ ...x, token: '', note: 'Đã lưu. Đang kết nối…', isError: false }))
  try {
    const me = (await tg($, token, 'getMe', {})) as { username?: string }
    if (!(await read($, bridge)).isOn) await enable($)
    await tg($, token, 'setMyCommands', { commands: BOT_COMMANDS }).catch(() => undefined)
    await send(
      $,
      `👋 Đã kết nối với Claude qua @${me.username ?? ''}. Bấm "📋 Chọn phiên" để chọn phiên trò chuyện.`,
      MAIN_KEYBOARD,
    )
    await update($, form, x => ({
      ...x,
      isError: false,
      note: `Đã kết nối @${me.username}. Phiên này đã bật 🟢.`,
    }))
  } catch (err) {
    await fail(`Không kết nối được: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Double press on the Tele button.
const DOUBLE_MS = 450
let tapSeq = 0
let lastTapAt = 0

async function toggle($: EngineInterface) {
  if ((await read($, bridge)).isOn) {
    await disable($)
    $.ui.toast('🔴 Telegram: đã tắt phiên này')
    return
  }
  const cfg = await readConfig($)
  if (!hasTelegram(cfg) && !hasWeb(cfg)) {
    $.ui.toast('Chưa cài Telegram hay trang chat: mở pane để cài')
    await openPane($)
    return
  }
  await enable($)
  $.ui.toast('🟢 Đã bật phiên này (Telegram / trang chat)')
}

// The chat page: on/off, and whether other devices on the home network may open it.
async function setWeb($: EngineInterface, patch: Partial<WebConfig>) {
  const cur = (await readConfig($)).web ?? { enabled: false, lan: false }
  const next: WebConfig = { ...cur, ...patch }
  if (next.lan && !(next.password && next.password.length >= 6)) {
    await update($, form, x => ({
      ...x,
      note: 'Cho phép máy khác vào cần mật khẩu từ 6 ký tự trở lên.',
      isError: true,
    }))
    return
  }
  await writeConfig($, { web: next })
  await update($, form, x => ({ ...x, note: undefined, isError: false }))
  if (next.enabled && !(await read($, bridge)).isOn) await enable($)
  $.ui.toast(next.enabled ? '🌐 Trang chat: đang khởi động…' : 'Trang chat đã tắt')
}

async function openUrl($: EngineInterface, url: string) {
  await $.process.run(['explorer', url], { timeoutMs: 10_000 }).catch(() => undefined)
}

const openPane = async ($: EngineInterface) => {
  const { chatId } = await readConfig($)
  await update($, form, f => ({ ...f, chatId: chatId === undefined ? f.chatId : String(chatId) }))
  await $.ui.open({ id: PANE, title: TITLE })
}

// ------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tele',
      description: 'Telegram: mở cài đặt; /tele on | off để bật, tắt phiên này',
    })
    await $.tool.register({
      name: 'send_file',
      description:
        "Send a file or image from this computer to the user's Telegram chat (the tele-bridge mod's bot). " +
        'Use it when the user asks to send, forward or show a file, screenshot, image, video or result on Telegram. ' +
        'Images (.jpg .png .webp) arrive as photos, anything else as a document; 50 MB at most.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file on this computer' },
          caption: { type: 'string', description: 'Optional short caption shown with the file' },
        },
        required: ['path'],
      },
    })
    // A session the person turned 🟢 comes back 🟢 (reload, app restart,
    // reboot); a new session starts 🔴, unless it runs under the agent root.
    const me = await $.session.id()
    myCwd = await $.session.cwd().catch(() => '')
    if (await $.store.get(onKey(me))) await enable($)
    else if (!(await $.store.get(offKey(me))) && (await autoOn($).catch(() => false))) await enable($)
    else await setBridge($, b => ({ ...b, isOn: false }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Closing keeps the 🟢 choice; /clear starts a new conversation, which
    // starts 🔴 like any new one.
    if ((await read($, bridge)).isOn) await disable($, e.reason === 'clear')
    return next(e)
  }).catch(($, e, next) => next(e))


  on('command.run', { command: 'tele' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      const cfg = await readConfig($)
      if (!hasTelegram(cfg) && !hasWeb(cfg)) {
        await openPane($)
        return { text: 'Chưa cài Telegram hay trang chat: cài trong pane Telegram.' }
      }
      if (!(await read($, bridge)).isOn) await enable($)
      return { text: '🟢 Phiên này đã bật Telegram.' }
    }
    if (arg === 'off') {
      await disable($)
      return { text: '🔴 Đã tắt Telegram cho phiên này.' }
    }
    await openPane($)
    return { text: '' }
  })

  // The Tele button in the thong-ke-token row (each press bumps teleOpen):
  // one press opens the pane, a quick second press toggles this session
  // 🟢/🔴 instead. A single press waits DOUBLE_MS to see if a second follows.
  on('state.set', { plugin: 'thong-ke-token', key: 'teleOpen' }, async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    const seq = ++tapSeq
    if (now - lastTapAt < DOUBLE_MS) {
      lastTapAt = 0
      void toggle($)
    } else {
      lastTapAt = now
      void (async () => {
        await $.clock.sleep(DOUBLE_MS)
        if (tapSeq === seq) await openPane($)
      })()
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const f = await read($, form)
    const b = await read($, bridge)
    const cfg = await readConfig($)
    const tele = hasTelegram(cfg)
    const web = cfg.web
    const webOn = Boolean(web?.enabled)
    const urls = b.webUrls ?? []
    const live = tele || webOn ? await liveSessions($) : []
    const active = (await $.store.get('active')) as string | undefined
    const activeName = live.find(s => s.sid === active)?.name
    // Telegram's settings start open until it is set up.
    const open = f.open ?? (tele ? undefined : 'tele')
    const here = agentOf(myCwd, cfg.agentRoot)
    const toggleOpen = (card: 'tele' | 'web' | 'agent') =>
      void update($, form, x => ({ ...x, open: open === card ? undefined : card }))

    // One line: what it is on the left, its control on the right.
    const row = (key: string, left: RenderElement, right?: RenderElement | null) => (
      <Box key={key} justifyContent="space-between" alignItems="center">
        {left}
        {right ?? null}
      </Box>
    )
    const card = (key: string, children: (RenderElement | null)[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {children}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {card('card-session', [
          row(
            'r-on',
            <Text bold>{b.isOn ? '🟢 Phiên này đang bật' : '🔴 Phiên này đang tắt'}</Text>,
            b.isOn ? (
              <Button key="off" label="Tắt" onPress={() => void disable($)} />
            ) : tele || webOn ? (
              <Button key="on" label="Bật" onPress={() => void enable($)} />
            ) : null,
          ),
          b.isOn
            ? row(
                'r-notify',
                <Text dimColor>
                  {b.notifyAll ? '🔔 Báo cả việc giao trên máy' : '🔕 Chỉ báo việc giao từ xa'}
                </Text>,
                <Button
                  key="notify-all"
                  label={b.notifyAll ? 'Tắt' : 'Bật'}
                  onPress={() => void setNotifyAll($, !b.notifyAll)}
                />,
              )
            : null,
          b.lastError ? <Text color="red">{b.lastError}</Text> : null,
        ])}

        {card('card-tele', [
          row(
            'r-tele',
            <Text>
              <Text bold>✈️ Telegram </Text>
              <Text dimColor>{tele ? '· đã cài' : '· chưa cài'}</Text>
            </Text>,
            <Button
              key="tele-open"
              label={open === 'tele' ? 'Thu gọn' : 'Cài đặt'}
              onPress={() => toggleOpen('tele')}
            />,
          ),
          tele && open !== 'tele' ? <Text dimColor>Đang trò chuyện: {activeName ?? 'chưa chọn'}</Text> : null,
          open === 'tele' ? (
            <Box flexDirection="column" gap={1}>
              <Input
                key="chat-id"
                label="Chat ID"
                placeholder="nhắn @userinfobot để lấy"
                value={f.chatId}
                submitLabel="lưu"
                onInput={v => void update($, form, x => ({ ...x, chatId: v }))}
                onSubmit={v => void update($, form, x => ({ ...x, chatId: v })).then(() => save($))}
              />
              <Input
                key="token"
                label="Bot token"
                placeholder={
                  cfg.botToken ? `${maskToken(cfg.botToken)} (để trống nếu giữ)` : 'lấy từ @BotFather'
                }
                value={f.token}
                submitLabel="lưu"
                onInput={v => void update($, form, x => ({ ...x, token: v }))}
                onSubmit={v => void update($, form, x => ({ ...x, token: v })).then(() => save($))}
              />
              <Box gap={1} alignItems="center">
                <Button key="save" label="Lưu" onPress={() => void save($)} />
                {f.note ? <Text color={f.isError ? 'red' : 'green'}>{f.note}</Text> : null}
              </Box>
            </Box>
          ) : null,
        ])}

        {card('card-web', [
          row(
            'r-web',
            <Text>
              <Text bold>🌐 Trang chat </Text>
              <Text dimColor>{webOn ? (urls.length ? '· đang chạy' : '· đang khởi động') : '· tắt'}</Text>
            </Text>,
            <Button
              key="web-toggle"
              label={webOn ? 'Tắt' : 'Bật'}
              onPress={() => void setWeb($, { enabled: !webOn })}
            />,
          ),
          ...(webOn
            ? urls.map(u =>
                row(
                  `r-${u}`,
                  <Text>{u.replace('http://', '')}</Text>,
                  <Button key={`open-${u}`} label="Mở" onPress={() => void openUrl($, u)} />,
                ),
              )
            : []),
          webOn
            ? row(
                'r-lan',
                <Text dimColor>{web?.lan ? '🏠 Cả mạng nhà (có mật khẩu)' : '🔒 Chỉ máy này'}</Text>,
                <Button
                  key="web-open"
                  label={open === 'web' ? 'Thu gọn' : 'Đổi'}
                  onPress={() => toggleOpen('web')}
                />,
              )
            : null,
          webOn && open === 'web' ? (
            <Box flexDirection="column" gap={1}>
              <Input
                key="web-pass"
                label="Mật khẩu"
                placeholder={web?.password ? 'đã đặt (nhập để đổi)' : 'từ 6 ký tự'}
                value={f.webPassword ?? ''}
                submitLabel="lưu"
                onInput={v => void update($, form, x => ({ ...x, webPassword: v }))}
                onSubmit={v =>
                  void setWeb($, { password: v.trim() }).then(() =>
                    update($, form, x => ({ ...x, webPassword: '' })),
                  )
                }
              />
              <Box gap={1} alignItems="center">
                <Button
                  key="web-lan"
                  label={web?.lan ? 'Chỉ máy này' : 'Cho cả mạng nhà'}
                  onPress={() =>
                    void setWeb($, { lan: !web?.lan, password: f.webPassword?.trim() || web?.password })
                  }
                />
                {f.note ? <Text color={f.isError ? 'red' : 'green'}>{f.note}</Text> : null}
              </Box>
              <Text dimColor>Không bật ở wifi công cộng.</Text>
            </Box>
          ) : null,
        ])}

        {card('card-agent', [
          row(
            'r-agent',
            <Text>
              <Text bold>🤖 Agent </Text>
              <Text dimColor>{cfg.agentRoot ? `· ${baseName(cfg.agentRoot)}` : '· chưa có thư mục tổng'}</Text>
            </Text>,
            <Button
              key="agent-open"
              label={open === 'agent' ? 'Thu gọn' : cfg.agentRoot ? 'Đổi' : 'Cài đặt'}
              onPress={() => toggleOpen('agent')}
            />,
          ),
          cfg.agentRoot && open !== 'agent' ? (
            <Text dimColor>
              {here === undefined ? 'Phiên này: ngoài thư mục tổng' : here ? `Phiên này: agent ${here}` : 'Phiên này: thư mục tổng'}
            </Text>
          ) : null,
          open === 'agent' ? (
            <Box flexDirection="column" gap={1}>
              {cfg.agentRoot ? <Text dimColor>{cfg.agentRoot}</Text> : null}
              <Input
                key="agent-root"
                label="Thư mục tổng"
                placeholder="vd E:\AI\cong-ty (chứa agents\ và shared\)"
                value={f.rootInput ?? ''}
                submitLabel="lưu"
                onInput={v => void update($, form, x => ({ ...x, rootInput: v }))}
                onSubmit={v => void setRoot($, v)}
              />
              <Box gap={1} alignItems="center">
                <Button key="agent-save" label="Lưu" onPress={() => void setRoot($, f.rootInput ?? '')} />
                {myCwd ? (
                  <Button key="agent-here" label="Dùng thư mục phiên này" onPress={() => void setRoot($, myCwd)} />
                ) : null}
                {cfg.agentRoot ? <Button key="agent-clear" label="Bỏ" onPress={() => void setRoot($, '')} /> : null}
              </Box>
              {f.note ? <Text color={f.isError ? 'red' : 'green'}>{f.note}</Text> : null}
              <Text dimColor>
                Mỗi agent một thư mục trong agents\, dữ liệu chung trong shared\. Phiên mở trong thư mục tổng tự bật 🟢
                và hiện theo agent trên trang chat.
              </Text>
            </Box>
          ) : null,
        ])}

        <Text dimColor>Chỉ dùng cho riêng bạn, không chia sẻ cho người khác.</Text>
      </Box>
    )
  })

  // The model's tool: send a file from this computer to Telegram.
  on('tool.call', { tool: 'mcp__tele-bridge__send_file' }, async ($, e) => {
    const args = e as unknown as { path?: unknown; caption?: unknown }
    const file = typeof args.path === 'string' ? args.path : ''
    if (!file) return { result: 'Error: missing "path".' }
    const caption = typeof args.caption === 'string' ? args.caption : ''
    const { name = 'Claude' } = await read($, bridge)
    const r = await fileScript($, ['send', file, caption ? `[${name}] ${caption}` : `[${name}]`])
    return { result: r.ok ? `Sent to Telegram: ${r.path}` : `Error: ${r.error ?? 'unknown'}` }
  }).catch(() => ({ result: 'Error: sending to Telegram failed.' }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnId = e.turnId
      // A turn that starts with a prompt sent from Telegram or the chat page
      // answers there.
      const i = remoteTexts.findIndex(t => t.text === e.text.trim())
      if (i >= 0) {
        remoteTurns.set(e.turnId, remoteTexts[i]!.origin)
        remoteTexts.splice(i, 1)
      }
      void markBusy($).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    currentTurnId = undefined
    void markBusy($).catch(() => undefined)
    const origin = remoteTurns.get(e.turnId)
    remoteTurns.delete(e.turnId)
    const b = await read($, bridge)
    if (!b.isOn) return result
    const { name = 'Claude' } = b
    const me = await $.session.id()
    const answer = result.text || e.answer
    if (origin === 'web') {
      // The answer itself shows on the page from the transcript.
      const note = e.isAborted ? '⏹ Đã dừng.' : e.reason === 'error' ? '⚠️ Lỗi khi chạy.' : ''
      if (note) void webNote($, note).catch(() => undefined)
      return result
    }
    if (!origin) {
      // Typed at the computer: stays here, unless "báo cả việc giao trên máy".
      if (b.notifyAll && !e.isAborted) {
        void send(
          $,
          `✅ [${name}] xong việc giao trên máy:\n` + (result.text || e.answer),
          answerButtons(me),
        ).catch(() => undefined)
      }
      return result
    }
    const isActive = (await $.store.get('active')) === me
    const head = e.isAborted
      ? `[${name}] ⏹ Đã dừng.\n`
      : e.reason === 'error'
        ? `[${name}] ⚠️ Lỗi khi chạy.\n`
        : isActive
          ? `[${name}]\n`
          : `✅ [${name}] đã xong (bạn đang chọn phiên khác, gõ /phien để chuyển):\n`
    void send($, head + (result.text || e.answer), answerButtons(me)).catch(() => undefined)
    return result
  })

  // Claude waiting on you during a turn started from Telegram: say so there.
  on('classic.Notification', async ($, e, next) => {
    const origin = currentTurnId ? remoteTurns.get(currentTurnId) : undefined
    if (origin && (await read($, bridge)).isOn) {
      const { name = 'Claude' } = await read($, bridge)
      const tag = origin === 'web' ? '' : `[${name}] `
      void reply($, origin, `🔔 ${tag}${e.message}\n(Cần thao tác trên máy tính.)`).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
