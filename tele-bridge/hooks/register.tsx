import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bridge, Form } from '../types'

// Telegram ⇄ this Claude session.
// The 📱 Tele button above the prompt opens a pane: enter the chat ID and the
// bot token, press Lưu, and this session starts listening. Only one session
// listens at a time; messages from any chat but the saved one are ignored.
// Settings live in config.local.json beside this mod.

const API = 'https://api.telegram.org/bot'
const POLL_SECONDS = 20
const MAX_MSG = 4000
const CONFLICT_GRACE_MS = (POLL_SECONDS + 15) * 1000
const PANE = 'tele-bridge'
const TITLE = 'Telegram'

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

type Config = { botToken?: string; chatId?: number }
type Update = {
  update_id: number
  message?: { chat: { id: number }; text?: string }
}

const TOKEN_RE = /^\d+:[\w-]{20,}$/
const CHAT_RE = /^-?\d+$/

let currentTurnId: string | undefined

const configPath = ($: EngineInterface) => `${$.plugin.root}/config.local.json`

async function readConfig($: EngineInterface): Promise<Config> {
  try {
    const c = JSON.parse(await $.fs.read(configPath($))) as Config
    return {
      botToken: c.botToken && TOKEN_RE.test(c.botToken.trim()) ? c.botToken.trim() : undefined,
      chatId: typeof c.chatId === 'number' ? c.chatId : undefined,
    }
  } catch {
    return {}
  }
}

async function writeConfig($: EngineInterface, c: Config) {
  await $.fs.write(configPath($), JSON.stringify(c, null, 2))
}

const maskToken = (t?: string) => (t ? `••••${t.slice(-4)}` : 'chưa có')

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

async function send($: EngineInterface, text: string) {
  const { botToken, chatId } = await readConfig($)
  if (!botToken || chatId === undefined) return
  const body = text.trim() || '(Claude đã xong, không có nội dung trả lời)'
  for (let i = 0; i < body.length; i += MAX_MSG) {
    await tg($, botToken, 'sendMessage', { chat_id: chatId, text: body.slice(i, i + MAX_MSG) })
  }
}

async function isActiveHere($: EngineInterface) {
  const b = await read($, bridge)
  return b.isOn && (await $.store.get('owner')) === (await $.session.id())
}

// The Tele button (drawn by the thong-ke-token mod's row) reads this state
// for its 🟢/🔴 dot; no separate status line.
async function setBridge($: EngineInterface, fn: (b: Bridge) => Bridge) {
  await update($, bridge, b => fn(b))
  $.ui.status(undefined)
}

async function handle($: EngineInterface, token: string, u: Update) {
  const msg = u.message
  const text = msg?.text?.trim()
  if (!msg || !text) return
  const cfg = await readConfig($)

  if (cfg.chatId === undefined) {
    const { pairCode } = await read($, bridge)
    if (pairCode && text === pairCode) {
      await writeConfig($, { ...cfg, chatId: msg.chat.id })
      await update($, form, f => ({ ...f, chatId: String(msg.chat.id) }))
      await setBridge($, b => ({ ...b, pairCode: undefined }))
      await tg($, token, 'sendMessage', {
        chat_id: msg.chat.id,
        text: '✅ Đã ghép với Claude. Nhắn gì ở đây sẽ được gửi vào phiên chat.\nLệnh: /stop dừng việc đang làm, /status xem trạng thái.',
      })
      $.ui.toast('Telegram đã ghép xong')
    }
    return
  }
  const chatId = cfg.chatId
  if (msg.chat.id !== chatId) return

  const reply = (t: string) => tg($, token, 'sendMessage', { chat_id: chatId, text: t })
  if (text === '/stop') {
    if (currentTurnId) await $.turn.abort({ turnId: currentTurnId })
    await reply(currentTurnId ? '⏹ Đã dừng.' : 'Claude đang không làm gì.')
    return
  }
  if (text === '/status') {
    await reply(currentTurnId ? '⏳ Claude đang làm việc…' : '💤 Claude đang chờ tin nhắn.')
    return
  }
  if (text === '/start') {
    await reply('👋 Đã kết nối. Nhắn gì ở đây sẽ được gửi vào phiên Claude.')
    return
  }
  await reply(currentTurnId ? '📥 Đã nhận, sẽ chạy sau việc hiện tại.' : '📥 Đã nhận, Claude đang làm…')
  void $.prompt.submit({ text, asUser: true })
}

async function loop($: EngineInterface, loopId: string) {
  const me = await $.session.id()
  let offset = Number((await $.store.get('offset')) ?? 0)
  let conflictSince = 0
  for (;;) {
    const b = await read($, bridge)
    if (!b.isOn || b.loopId !== loopId) return
    if ((await $.store.get('owner')) !== me) {
      await setBridge($, x => ({ ...x, isOn: false }))
      $.ui.toast('Telegram đã chuyển sang phiên khác')
      return
    }
    const { botToken } = await readConfig($)
    if (!botToken) {
      await setBridge($, x => ({ ...x, lastError: 'chưa có bot token' }))
      await $.clock.sleep(15000)
      continue
    }
    try {
      const updates = (await tg($, botToken, 'getUpdates', {
        offset,
        timeout: POLL_SECONDS,
        allowed_updates: ['message'],
      })) as Update[]
      if (b.lastError) await setBridge($, x => ({ ...x, lastError: undefined }))
      conflictSince = 0
      for (const u of updates) {
        offset = u.update_id + 1
        await $.store.set('offset', offset)
        const now = await read($, bridge)
        if (!now.isOn || now.loopId !== loopId) return
        await handle($, botToken, u).catch(() => undefined)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 409 Conflict: another getUpdates is still open on this bot. After a
      // reload, a Lưu or a /tele on, the previous loop's long poll (up to
      // POLL_SECONDS) overlaps the new one for a moment; that is not an error.
      // Report it only if it lasts, i.e. something else really uses the bot.
      if (/conflict/i.test(msg)) {
        const now = await $.clock.now()
        if (conflictSince === 0) conflictSince = now
        if (now - conflictSince < CONFLICT_GRACE_MS) {
          await $.clock.sleep(3000)
          continue
        }
        await setBridge($, x => ({
          ...x,
          lastError: 'Bot đang bị nơi khác dùng cùng lúc (một máy/phiên khác, hoặc plugin Telegram khác dùng chung bot)',
        }))
        await $.clock.sleep(10000)
        continue
      }
      await setBridge($, x => ({ ...x, lastError: msg.slice(0, 120) }))
      await $.clock.sleep(10000)
    }
  }
}

async function start($: EngineInterface) {
  const loopId = String(await $.clock.now()) + Math.random().toString(36).slice(2, 8)
  await $.store.set('owner', await $.session.id())
  const { chatId } = await readConfig($)
  const pairCode =
    chatId === undefined ? String(Math.floor(100000 + Math.random() * 900000)) : undefined
  await setBridge($, () => ({ isOn: true, loopId, pairCode }))
  void loop($, loopId)
  return pairCode
}

async function stop($: EngineInterface) {
  await setBridge($, b => ({ ...b, isOn: false, pairCode: undefined, lastError: undefined }))
}

async function save($: EngineInterface) {
  const f = await read($, form)
  const cfg = await readConfig($)
  const token = f.token.trim() || cfg.botToken || ''
  const chat = f.chatId.trim()
  const fail = (note: string) => update($, form, x => ({ ...x, note, isError: true }))

  if (!TOKEN_RE.test(token)) return fail('Token không đúng dạng (vd 123456:ABC…).')
  if (chat && !CHAT_RE.test(chat)) return fail('Chat ID chỉ gồm số (có thể có dấu - ở đầu).')

  await writeConfig($, { botToken: token, chatId: chat ? Number(chat) : undefined })
  await update($, form, x => ({ ...x, token: '', note: 'Đã lưu. Đang kết nối…', isError: false }))
  try {
    const me = (await tg($, token, 'getMe', {})) as { username?: string }
    const code = await start($)
    if (chat) {
      await send($, `👋 Claude đã kết nối qua bot @${me.username ?? ''}. Nhắn gì ở đây sẽ được gửi vào phiên chat.`)
    }
    await update($, form, x => ({
      ...x,
      isError: false,
      note: code
        ? `Đã kết nối @${me.username}. Gửi mã ${code} cho bot để ghép chat.`
        : `Đã kết nối @${me.username}. Bot đã nhắn chào bạn trên Telegram.`,
    }))
  } catch (err) {
    await fail(`Không kết nối được: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const openPane = async ($: EngineInterface) => {
  const { chatId } = await readConfig($)
  await update($, form, f => ({ ...f, chatId: chatId === undefined ? f.chatId : String(chatId) }))
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tele',
      description: 'Telegram: mở cài đặt; /tele on | off để bật, tắt',
    })
    if (await isActiveHere($)) await start($)
    // Write the state once so the Tele button appears even before first use.
    else await setBridge($, b => ({ ...b }))
    return next(e)
  })

  on('command.run', { command: 'tele' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      const { botToken } = await readConfig($)
      if (!botToken) {
        await openPane($)
        return { text: 'Chưa có bot token: nhập trong pane Telegram.' }
      }
      const code = await start($)
      return {
        text: code
          ? `📱 Đang nghe Telegram. Gửi mã ${code} cho bot để ghép chat.`
          : '📱 Đang nghe Telegram ở phiên này.',
      }
    }
    if (arg === 'off') {
      await stop($)
      return { text: 'Đã tắt Telegram cho phiên này.' }
    }
    await openPane($)
    return { text: '' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const f = await read($, form)
    const b = await read($, bridge)
    const cfg = await readConfig($)

    const state = !b.isOn
      ? 'Tắt'
      : b.lastError
        ? `Lỗi: ${b.lastError}`
        : b.pairCode
          ? `Chờ ghép (gửi mã ${b.pairCode} cho bot)`
          : 'Đang nghe'

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text dimColor>Trạng thái: </Text>
            {state}
          </Text>
          {b.isOn ? (
            <Button key="off" label="Tắt" onPress={() => void stop($)} />
          ) : cfg.botToken ? (
            <Button key="on" label="Bật" onPress={() => void start($)} />
          ) : null}
        </Box>

        <Box flexDirection="column">
          <Input
            key="chat-id"
            label="Chat ID"
            placeholder="vd 123456789"
            value={f.chatId}
            submitLabel="lưu"
            onInput={v => void update($, form, x => ({ ...x, chatId: v }))}
            onSubmit={v => void update($, form, x => ({ ...x, chatId: v })).then(() => save($))}
          />
          <Text dimColor>Lấy ID: nhắn @userinfobot trên Telegram. Để trống thì ghép bằng mã.</Text>
        </Box>

        <Box flexDirection="column">
          <Input
            key="token"
            label="Bot token"
            placeholder={
              cfg.botToken
                ? `đang dùng ${maskToken(cfg.botToken)} – để trống nếu giữ`
                : 'dán token từ @BotFather'
            }
            value={f.token}
            submitLabel="lưu"
            onInput={v => void update($, form, x => ({ ...x, token: v }))}
            onSubmit={v => void update($, form, x => ({ ...x, token: v })).then(() => save($))}
          />
        </Box>

        <Box gap={1}>
          <Button key="save" label="Lưu" onPress={() => void save($)} />
          {f.note ? <Text color={f.isError ? 'red' : 'green'}>{f.note}</Text> : null}
        </Box>

        <Text dimColor>Trên Telegram: /stop dừng việc đang làm · /status xem trạng thái.</Text>
      </Box>
    )
  })

  // The Tele button in the thong-ke-token row: open this mod's pane.
  on('state.set', { plugin: 'thong-ke-token', key: 'teleOpen' }, async ($, e, next) => {
    const result = await next(e)
    void openPane($)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) currentTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    currentTurnId = undefined
    if (await isActiveHere($)) {
      const head = e.isAborted ? '⏹ (đã dừng)\n' : e.reason === 'error' ? '⚠️ Lỗi khi chạy.\n' : ''
      void send($, head + (result.text || e.answer)).catch(() => undefined)
    }
    return result
  })

  // Claude waiting on you (a permission prompt, a question): tell Telegram.
  on('classic.Notification', async ($, e, next) => {
    if (await isActiveHere($)) {
      void send($, `🔔 ${e.message}\n(Cần thao tác trên máy tính.)`).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
