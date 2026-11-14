// The local chat page for the tele-bridge mod: a tiny HTTP server on this
// computer (or the home Wi-Fi when "lan" is on, behind a password).
//
// Looks like a chat app: a sidebar of the 🟢 sessions, and each session's own
// conversation, read from the transcript Claude keeps on disk (so what you
// typed at the computer shows too).
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
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INBOX = path.join(MOD_DIR, 'inbox')
const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const MAX_UPLOAD = 50 * 1024 * 1024
const HISTORY_LIMIT = 300

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

let sessions = [] // [{ sid, name, busy }] pushed by the mod
const notes = [] // small notes from the mod: [{ id, sid, text, at }]
let nextNote = 1
const inbox = [] // what the page sent, waiting for the mod
let waiter = null // the mod's pending /internal/inbox request
const tokens = new Set() // logged-in browsers (LAN mode)

// ------------------------------------------------------------ history

const files = new Map() // sid -> transcript path
async function transcriptOf(sid) {
  if (!/^[\w-]+$/.test(sid)) return undefined
  if (files.has(sid)) return files.get(sid)
  for (const dir of await fs.readdir(PROJECTS).catch(() => [])) {
    const f = path.join(PROJECTS, dir, `${sid}.jsonl`)
    if (await fs.stat(f).then(() => true, () => false)) {
      files.set(sid, f)
      return f
    }
  }
}

// Per transcript: what was read so far, so each poll reads only new lines.
const parsed = new Map() // file -> { size, offset, rest, items: [{ role, text, at }] }

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

function take(state, line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (o.isSidechain || o.isMeta) return
  const at = Date.parse(o.timestamp) || 0
  if (o.type === 'user') {
    const text = userText(o.message?.content).trim()
    // Engine-made rows (commands, reminders, notices) start with a tag.
    if (!text || text.startsWith('<')) return
    state.items.push({ role: 'me', text, at })
  } else if (o.type === 'assistant') {
    const content = o.message?.content
    if (!Array.isArray(content)) return
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()
    if (!text) return
    const last = state.items[state.items.length - 1]
    // One answer per turn: texts between two prompts join into one bubble.
    if (last && last.role === 'claude') {
      last.text += '\n\n' + text
      last.at = at
    } else state.items.push({ role: 'claude', text, at })
  }
}

async function history(sid) {
  const file = await transcriptOf(sid)
  if (!file) return []
  const st = await fs.stat(file).catch(() => undefined)
  if (!st) return []
  let state = parsed.get(file)
  if (!state || st.size < state.size) {
    state = { size: 0, offset: 0, rest: '', items: [] }
    parsed.set(file, state)
  }
  if (st.size > state.offset) {
    const rl = createInterface({
      input: createReadStream(file, { start: state.offset, end: st.size - 1, encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    const lines = []
    for await (const line of rl) lines.push(line)
    // The last line may be cut mid-write: keep it for the next read.
    if (lines.length) lines[0] = state.rest + lines[0]
    state.rest = ''
    const endsClean = await new Promise(resolve => {
      const s = createReadStream(file, { start: st.size - 1, end: st.size - 1 })
      s.on('data', b => resolve(b[0] === 10))
      s.on('error', () => resolve(true))
    })
    if (!endsClean) state.rest = lines.pop() ?? ''
    for (const line of lines) if (line) take(state, line)
    state.offset = st.size
    state.size = st.size
    if (state.items.length > HISTORY_LIMIT * 2) state.items.splice(0, state.items.length - HISTORY_LIMIT)
  }
  return state.items.slice(-HISTORY_LIMIT)
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
  if (p === '/api/history') {
    const sid = String(url.searchParams.get('sid') ?? '')
    if (!sessions.some(s => s.sid === sid)) return json(res, 200, { items: [], notes: [] })
    const items = await history(sid)
    return json(res, 200, { items, notes: notes.filter(n => n.sid === sid) })
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

const PAGE = String.raw`<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Claude Chat</title>
<style>
:root{--bg:#faf9f5;--side:#f0eee6;--panel:#fff;--text:#1f1e1d;--dim:#73726c;--line:#e5e3da;--me:#efece3;--accent:#c96442;--hover:#e8e5da;--code:#f3f1ea}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--side:#1f1e1d;--panel:#30302e;--text:#f5f4ef;--dim:#a6a39b;--line:#3e3e3a;--me:#3a3936;--hover:#30302e;--code:#1f1e1d}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;border-radius:8px}
#side{width:270px;flex:0 0 270px;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;height:100%}
#side h1{font-size:17px;margin:0;padding:16px 16px 8px;display:flex;align-items:center;gap:8px}
#side .label{font-size:12px;color:var(--dim);padding:8px 16px 4px}
#list{flex:1;overflow-y:auto;padding:0 8px 12px}
.item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 10px;margin:1px 0}
.item:hover{background:var(--hover)}.item.on{background:var(--hover);font-weight:600}
.item .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 8px}
.dot.busy{background:var(--accent);animation:pulse 1s infinite}
.unread{width:8px;height:8px;border-radius:50%;background:#3b82f6}
@keyframes pulse{50%{opacity:.3}}
#side .foot{font-size:12px;color:var(--dim);padding:12px 16px;border-top:1px solid var(--line)}
#main{flex:1;min-width:0;display:flex;flex-direction:column;height:100%}
header{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line)}
header .title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header button{padding:6px 10px}header button:hover{background:var(--hover)}
#menu{display:none}
#log{flex:1;overflow-y:auto}
#inner{max-width:760px;margin:0 auto;padding:24px 16px 8px;display:flex;flex-direction:column;gap:18px}
.me{align-self:flex-end;max-width:80%;background:var(--me);padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.claude{align-self:stretch;word-wrap:break-word}
.claude p{margin:0 0 10px}.claude p:last-child{margin:0}
.claude pre{background:var(--code);padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:13px}
.claude code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:13px}.claude pre code{background:none;padding:0}
.claude h1,.claude h2,.claude h3{font-size:16px;margin:12px 0 6px}
.claude ul,.claude ol{margin:0 0 10px;padding-left:22px}
.claude table{border-collapse:collapse;margin:0 0 10px;font-size:14px;display:block;overflow-x:auto}
.claude td,.claude th{border:1px solid var(--line);padding:4px 8px;text-align:left}
.claude a{color:var(--accent)}
.note{align-self:center;color:var(--dim);font-size:13px;white-space:pre-wrap}
.working{color:var(--dim);font-size:14px}.working::after{content:"…";animation:pulse 1s infinite}
.empty{color:var(--dim);text-align:center;margin-top:20vh}
.pending{opacity:.6}
footer{padding:8px 16px calc(14px + env(safe-area-inset-bottom))}
.box{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:8px}
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
}
</style></head><body>
<div id="login" class="hidden"><b>Claude Chat</b><input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password"><button id="go">Vào</button><div class="err" id="loginErr"></div></div>
<aside id="side" class="hidden">
  <h1>✳️ Claude Chat</h1>
  <div class="label">Phiên đang bật 🟢</div>
  <div id="list"></div>
  <div class="foot">Bật thêm phiên: trên máy, bấm nút Tele trong phiên đó. Chỉ dùng cho riêng bạn.</div>
</aside>
<div id="scrim"></div>
<main id="main" class="hidden">
  <header><button id="menu" title="Danh sách phiên">☰</button><div class="title" id="title">Chọn một phiên</div><button id="status" title="Trạng thái">ℹ️</button><button id="stop" title="Dừng">⏹</button></header>
  <div id="log"><div id="inner"></div></div>
  <footer><div class="box"><button id="attach" title="Gửi ảnh/file">📎</button><input id="file" type="file" class="hidden"><textarea id="text" rows="1" placeholder="Nhắn cho Claude…"></textarea><button id="send" title="Gửi">➤</button></div></footer>
</main>
<script>
const $=id=>document.getElementById(id);
let sessions=[],sid=localStorage.getItem('cdm_sid')||'',pending=[],lastCount={},seen=JSON.parse(localStorage.getItem('cdm_seen')||'{}'),busy=false,rendered='';
function show(logged){$('login').classList.toggle('hidden',logged);$('side').classList.toggle('hidden',!logged);$('main').classList.toggle('hidden',!logged)}
async function api(path,opts){const r=await fetch(path,opts);if(r.status===401){show(false);throw new Error('login')}return r.json()}
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
function renderList(){
  $('list').innerHTML=sessions.length?sessions.map(s=>'<button class="item'+(s.sid===sid?' on':'')+'" data-sid="'+s.sid+'"><span class="dot'+(s.busy?' busy':'')+'"></span><span class="nm">'+esc(s.name)+'</span>'+((lastCount[s.sid]||0)>(seen[s.sid]||0)&&s.sid!==sid?'<span class="unread"></span>':'')+'</button>').join(''):'<div class="label">Chưa có phiên nào bật.</div>';
  for(const b of $('list').querySelectorAll('.item'))b.onclick=()=>pick(b.dataset.sid);
  const cur=sessions.find(s=>s.sid===sid);$('title').textContent=cur?cur.name:'Chọn một phiên';
}
function pick(id){sid=id;localStorage.setItem('cdm_sid',sid);rendered='';document.body.classList.remove('open');renderList();loadHistory(true)}
async function loadSessions(){
  try{const r=await api('/api/sessions');show(true);sessions=r.sessions||[];
    if(!sessions.some(s=>s.sid===sid)&&sessions.length)pick(sessions[0].sid);else renderList();
  }catch(e){}
}
async function loadHistory(scroll){
  if(!sid)return;
  try{
    const r=await api('/api/history?sid='+encodeURIComponent(sid));
    const items=(r.items||[]).concat((r.notes||[]).map(n=>({role:'note',text:n.text,at:n.at}))).sort((a,b)=>a.at-b.at);
    lastCount[sid]=items.length;seen[sid]=items.length;localStorage.setItem('cdm_seen',JSON.stringify(seen));
    pending=pending.filter(p=>p.sid===sid&&!items.some(m=>m.role==='me'&&m.text.trim()===p.text.trim()&&m.at>=p.at-60000));
    const cur=sessions.find(s=>s.sid===sid);
    const view=items.map(m=>m.role==='claude'?'<div class="claude">'+md(m.text)+'</div>':m.role==='me'?'<div class="me">'+esc(m.text)+'</div>':'<div class="note">'+esc(m.text)+'</div>').join('')
      +pending.map(p=>'<div class="me pending">'+esc(p.text)+'</div>').join('')
      +(cur&&cur.busy?'<div class="working">Claude đang làm</div>':'');
    const html=view||'<div class="empty">Chưa có tin nhắn nào trong phiên này.</div>';
    if(html!==rendered){const log=$('log');const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<120;$('inner').innerHTML=html;rendered=html;if(scroll||atBottom)log.scrollTop=log.scrollHeight}
  }catch(e){}
}
async function tick(){await loadSessions();await loadHistory(false);setTimeout(tick,2000)}
async function post(body){
  if(!sid)return alert('Chưa có phiên nào bật 🟢 trên máy.');
  const r=await api('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,sid})});
  if(r.error)alert(r.error);return !r.error;
}
async function sendText(t){if(!t.trim()||busy)return;busy=true;pending.push({sid,text:t,at:Date.now()});rendered='';loadHistory(true);
  if(!(await post({text:t}).finally(()=>busy=false)))pending=pending.filter(p=>p.text!==t)}
$('send').onclick=()=>{const t=$('text').value;$('text').value='';autosize();sendText(t)};
const autosize=()=>{const t=$('text');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,200)+'px'};
$('text').oninput=autosize;
$('text').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!('ontouchstart' in window)){e.preventDefault();$('send').click()}};
$('stop').onclick=()=>post({kind:'stop'});$('status').onclick=()=>post({kind:'status'});
$('menu').onclick=()=>document.body.classList.add('open');$('scrim').onclick=()=>document.body.classList.remove('open');
$('attach').onclick=()=>$('file').click();
$('file').onchange=async()=>{const f=$('file').files[0];if(!f)return;
  const r=await api('/api/upload',{method:'POST',headers:{'x-name':encodeURIComponent(f.name)},body:f});$('file').value='';
  if(!r.ok)return alert(r.error||'Lỗi tải file');
  const img=f.type.startsWith('image/');const note=$('text').value.trim()||(img?'Xem ảnh này.':'Xem file này.');$('text').value='';
  sendText(note+'\n\n['+(img?'Ảnh':'File')+' gửi từ trang chat, đã lưu trên máy tại: '+r.path+']');
};
$('go').onclick=async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('pw').value})});
  if(r.ok){$('loginErr').textContent='';show(true);loadSessions()}else $('loginErr').textContent='Sai mật khẩu'};
$('pw').onkeydown=e=>{if(e.key==='Enter')$('go').click()};
tick();
</script></body></html>`
