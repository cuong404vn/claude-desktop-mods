// The local chat page for the tele-bridge mod: a tiny HTTP server on this
// computer (or the home Wi-Fi when "lan" is on, behind a password).
//
// Started by the mod with its settings as one JSON line on stdin:
//   { port, lan, password, key }
// `key` guards /internal/*, which only the mod calls (from 127.0.0.1).
// Prints one JSON line when listening: { ready: true, urls: [...] }.
//
// Personal use only: your Claude account is yours; don't share this page.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INBOX = path.join(MOD_DIR, 'inbox')
const MAX_UPLOAD = 50 * 1024 * 1024

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

let sessions = [] // [{ sid, name }] pushed by the mod
const messages = [] // [{ id, sid, name, role: 'me'|'claude'|'info', text, at }]
let nextId = 1
const inbox = [] // messages from the page, waiting for the mod
let waiter = null // the mod's pending /internal/inbox request
const tokens = new Set() // logged-in browsers (LAN mode)

function addMessage(m) {
  const msg = { id: nextId++, at: Date.now(), ...m }
  messages.push(msg)
  if (messages.length > 500) messages.splice(0, messages.length - 500)
  return msg
}

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

function cookieToken(req) {
  const m = /(?:^|;\s*)cdm_auth=([a-f0-9]+)/.exec(req.headers.cookie ?? '')
  return m?.[1]
}

const isLocal = req => {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

// On this computer no password is needed; from another device (LAN mode) it is.
const isAuthed = req => isLocal(req) || (LAN && tokens.has(cookieToken(req) ?? ''))

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const p = url.pathname

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
      return json(res, 200, { ok: true })
    }
    if (p === '/internal/push') {
      addMessage({ sid: body.sid, name: body.name, role: body.role ?? 'claude', text: String(body.text ?? '') })
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

  if (p === '/api/state') {
    const after = Number(url.searchParams.get('after')) || 0
    return json(res, 200, { sessions, messages: messages.filter(m => m.id > after) })
  }
  if (p === '/api/send' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const sid = String(body.sid ?? '')
    const s = sessions.find(x => x.sid === sid)
    if (!s) return json(res, 400, { error: 'Phiên này không còn bật' })
    const kind = ['stop', 'status'].includes(body.kind) ? body.kind : 'text'
    const text = String(body.text ?? '').slice(0, 20000)
    if (kind === 'text' && !text.trim()) return json(res, 400, { error: 'Tin nhắn trống' })
    if (kind === 'text') addMessage({ sid, name: s.name, role: 'me', text })
    inbox.push({ id: Date.now() * 1000 + (nextId % 1000), sid, kind, text })
    flushInbox()
    return json(res, 200, { ok: true })
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const name = String(req.headers['x-name'] ?? 'file').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-80)
    const data = await readBody(req, MAX_UPLOAD)
    const d = new Date()
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
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

const PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Claude Chat</title>
<style>
:root{--bg:#f5f5f4;--panel:#fff;--text:#1c1917;--dim:#78716c;--line:#e7e5e4;--me:#2563eb;--meText:#fff;--claude:#fff;--accent:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--panel:#292524;--text:#f5f5f4;--dim:#a8a29e;--line:#44403c;--me:#2563eb;--claude:#292524}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
header{display:flex;gap:8px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
header b{flex:0 0 auto}select{flex:1;min-width:0;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
button{font:inherit;border:0;border-radius:8px;padding:8px 12px;background:var(--line);color:var(--text);cursor:pointer}
button.primary{background:var(--me);color:#fff}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.me{align-self:flex-end;background:var(--me);color:var(--meText)}
.claude{align-self:flex-start;background:var(--claude);border:1px solid var(--line)}
.info{align-self:center;color:var(--dim);font-size:13px}
.who{font-size:12px;color:var(--dim);margin-bottom:2px}
footer{display:flex;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--panel);border-top:1px solid var(--line)}
textarea{flex:1;min-width:0;resize:none;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);height:42px;max-height:140px}
#login{margin:auto;display:flex;flex-direction:column;gap:10px;padding:24px;width:min(320px,100% - 32px)}
#login input{font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text)}
.hidden{display:none!important}.err{color:#dc2626;font-size:13px}
</style></head><body>
<div id="login" class="hidden"><b>Claude Chat</b><input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password"><button class="primary" id="go">Vào</button><div class="err" id="loginErr"></div></div>
<header id="top" class="hidden"><b>🟢</b><select id="sess"></select><button id="status" title="Trạng thái">ℹ️</button><button id="stop" title="Dừng">⏹</button></header>
<div id="log" class="hidden"></div>
<footer id="bar" class="hidden"><button id="attach" title="Gửi ảnh/file">📎</button><input id="file" type="file" class="hidden"><textarea id="text" placeholder="Nhắn cho Claude…"></textarea><button class="primary" id="send">Gửi</button></footer>
<script>
const $=id=>document.getElementById(id);let after=0,sessions=[],busy=false;
const key='cdm_sid';
function show(logged){for(const id of ['top','log','bar'])$(id).classList.toggle('hidden',!logged);$('login').classList.toggle('hidden',logged)}
function current(){return $('sess').value}
function render(list){
  const keep=current()||localStorage.getItem(key)||'';
  $('sess').innerHTML=list.length?list.map(s=>'<option value="'+s.sid+'">'+s.name.replace(/[<>&]/g,'')+'</option>').join(''):'<option value="">Chưa có phiên nào bật 🟢</option>';
  if(list.some(s=>s.sid===keep))$('sess').value=keep;
}
function add(m){
  const d=document.createElement('div');d.className='msg '+m.role;
  if(m.role!=='me'&&m.role!=='info'){const w=document.createElement('div');w.className='who';w.textContent=m.name||'Claude';d.appendChild(w)}
  d.appendChild(document.createTextNode(m.text));$('log').appendChild(d);
}
async function api(path,opts){const r=await fetch(path,opts);if(r.status===401){show(false);throw new Error('login')}return r.json()}
async function poll(){
  try{const s=await api('/api/state?after='+after);show(true);
    if(JSON.stringify(s.sessions)!==JSON.stringify(sessions)){sessions=s.sessions;render(sessions)}
    const atBottom=$('log').scrollHeight-$('log').scrollTop-$('log').clientHeight<80;
    for(const m of s.messages){add(m);after=m.id}
    if(s.messages.length&&atBottom)$('log').scrollTop=$('log').scrollHeight;
  }catch(e){}
  setTimeout(poll,1500);
}
async function post(body){
  const sid=current();if(!sid)return alert('Chưa có phiên nào bật 🟢 trên máy.');
  const r=await api('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,sid})});
  if(r.error)alert(r.error);
}
$('sess').onchange=()=>localStorage.setItem(key,current());
$('send').onclick=async()=>{const t=$('text').value.trim();if(!t||busy)return;busy=true;$('text').value='';await post({text:t}).finally(()=>busy=false)};
$('text').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!('ontouchstart' in window)){e.preventDefault();$('send').click()}};
$('stop').onclick=()=>post({kind:'stop'});$('status').onclick=()=>post({kind:'status'});
$('attach').onclick=()=>$('file').click();
$('file').onchange=async()=>{const f=$('file').files[0];if(!f)return;
  const r=await api('/api/upload',{method:'POST',headers:{'x-name':encodeURIComponent(f.name)},body:f});$('file').value='';
  if(!r.ok)return alert(r.error||'Lỗi tải file');
  const note=$('text').value.trim()||(f.type.startsWith('image/')?'Xem ảnh này.':'Xem file này.');$('text').value='';
  await post({text:note+'\\n\\n['+(f.type.startsWith('image/')?'Ảnh':'File')+' gửi từ trang chat, đã lưu trên máy tại: '+r.path+']'});
};
$('go').onclick=async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('pw').value})});
  if(r.ok){$('loginErr').textContent='';show(true)}else $('loginErr').textContent='Sai mật khẩu'};
$('pw').onkeydown=e=>{if(e.key==='Enter')$('go').click()};
poll();
</script></body></html>`
