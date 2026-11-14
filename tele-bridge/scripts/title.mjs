// Prints a Claude session's title (its last "custom-title" record), or "".
// Usage: node title.mjs <sessionId>
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'

const sid = process.argv[2] ?? ''
const root = path.join(os.homedir(), '.claude', 'projects')

async function find() {
  for (const dir of await fs.readdir(root).catch(() => [])) {
    const file = path.join(root, dir, `${sid}.jsonl`)
    if (await fs.stat(file).then(() => true, () => false)) return file
  }
}

let title = ''
const file = sid && (await find())
if (file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"custom-title"')) continue
    try {
      const o = JSON.parse(line)
      if (o.type === 'custom-title' && o.customTitle) title = String(o.customTitle)
    } catch {}
  }
}
process.stdout.write(title)
