// Moves files between Telegram and this computer for the tele-bridge mod.
// Reads the bot token and chat ID from ../config.local.json (never argv).
//
//   node tg-file.mjs download <file_id> <name>   → saves under ../inbox/, prints the path
//   node tg-file.mjs send <path> [caption]        → sends the file to the saved chat
//
// Prints one JSON line: { ok: true, path? } or { ok: false, error }.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INBOX = path.join(MOD_DIR, 'inbox')
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const MAX_UPLOAD = 50 * 1024 * 1024 // Telegram bot limit for documents

const out = o => process.stdout.write(JSON.stringify(o))

async function config() {
  const c = JSON.parse(await fs.readFile(path.join(MOD_DIR, 'config.local.json'), 'utf8'))
  if (!c.botToken || typeof c.chatId !== 'number') throw new Error('chưa cài bot (thiếu token hoặc Chat ID)')
  return c
}

async function api(token, method, init) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, init)
  const data = await r.json()
  if (!data.ok) throw new Error(`${method}: ${data.description ?? r.status}`)
  return data.result
}

// A file name safe on Windows, prefixed with the date so names don't clash.
function safeName(name) {
  const base = String(name || 'file').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-80)
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  return `${stamp}-${base}`
}

async function download(fileId, name) {
  const { botToken } = await config()
  const f = await api(botToken, 'getFile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const r = await fetch(`https://api.telegram.org/file/bot${botToken}/${f.file_path}`)
  if (!r.ok) throw new Error(`tải file: ${r.status}`)
  const ext = path.extname(name || '') || path.extname(f.file_path || '') || ''
  const file = path.join(INBOX, safeName(path.basename(name || 'file', ext) + ext))
  await fs.mkdir(INBOX, { recursive: true })
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()))
  return file
}

async function send(file, caption) {
  const { botToken, chatId } = await config()
  const abs = path.resolve(file)
  const st = await fs.stat(abs)
  if (!st.isFile()) throw new Error('không phải file')
  if (st.size > MAX_UPLOAD) throw new Error('file lớn hơn 50 MB, Telegram không nhận')
  const ext = path.extname(abs).toLowerCase()
  const asPhoto = PHOTO_EXT.has(ext) && st.size <= 10 * 1024 * 1024
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) form.append('caption', caption.slice(0, 1000))
  form.append(asPhoto ? 'photo' : 'document', new Blob([await fs.readFile(abs)]), path.basename(abs))
  await api(botToken, asPhoto ? 'sendPhoto' : 'sendDocument', { method: 'POST', body: form })
  return abs
}

const [cmd, a, b] = process.argv.slice(2)
try {
  if (cmd === 'download') out({ ok: true, path: await download(a, b) })
  else if (cmd === 'send') out({ ok: true, path: await send(a, b) })
  else throw new Error('lệnh không rõ')
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) })
}
