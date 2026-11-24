import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Project, View } from '../types'

// Mở lại dự án: lists the project folders Claude Code has worked in on this
// computer (from the transcripts on disk, whichever account made them), and
// reopens the ticked ones as NEW sessions in the account signed in now, each
// in its folder, under its old name, with a hand-off note of the old session.
//
// It only reads Claude's data. The sessions are opened by Claude through the
// app's own "start session" tool: the mod asks for it in a prompt.

const PANE = 'mo-lai-du-an'
const TITLE = 'Mở lại dự án'

const view = atom(
  { plugin: 'mo-lai-du-an', key: 'view' } as const,
  { projects: null, selected: [], withContext: true, isLoading: false, isOpening: false } as View,
  { shape: 'view-1' },
)
// Tells the thong-ke-token row to draw the 📂 button.
const ready = atom({ plugin: 'mo-lai-du-an', key: 'ready' } as const, false)

type Script = { ok?: boolean; path?: string; error?: string }

async function script($: EngineInterface, args: string[]) {
  const r = await $.process.run(['node', `${$.plugin.root}/scripts/projects.mjs`, ...args], {
    timeoutMs: 5 * 60 * 1000,
  })
  return r.stdout
}

async function refresh($: EngineInterface) {
  if ((await read($, view)).isLoading) return
  await update($, view, v => ({ ...v, isLoading: true, note: undefined }))
  try {
    const projects = JSON.parse(await script($, ['list'])) as Project[]
    const here = (await $.session.cwd()).toLowerCase()
    await update($, view, v => ({
      ...v,
      projects,
      // Keep what was ticked; never tick the folder this session is in.
      selected: v.selected.filter(c => c.toLowerCase() !== here && projects.some(p => p.cwd === c)),
      isLoading: false,
    }))
  } catch (err) {
    await update($, view, v => ({
      ...v,
      isLoading: false,
      note: `Không đọc được danh sách: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }))
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  void refresh($)
}

const fmtWhen = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (days <= 0) return `hôm nay ${hm}`
  if (days === 1) return `hôm qua ${hm}`
  return `${days} ngày trước`
}

// Builds the hand-offs and asks Claude, in this session, to open the sessions.
async function openSelected($: EngineInterface) {
  const v = await read($, view)
  const chosen = (v.projects ?? []).filter(p => v.selected.includes(p.cwd))
  if (chosen.length === 0 || v.isOpening) return
  await update($, view, x => ({ ...x, isOpening: true, note: 'Đang chuẩn bị…', isError: false }))

  const items: string[] = []
  for (const [i, p] of chosen.entries()) {
    let handoff = ''
    if (v.withContext) {
      const out = `${$.plugin.root}/handoff/${p.sid}.md`
      try {
        const r = JSON.parse(await script($, ['handoff', p.file, out])) as Script
        if (r.ok && r.path) handoff = r.path
      } catch {}
    }
    items.push(
      `${i + 1}. Tên phiên: "${p.title}"\n   Thư mục (cwd): ${p.cwd}` +
        (handoff ? `\n   File bàn giao: ${handoff}` : ''),
    )
  }

  const task = v.withContext
    ? 'Đây là phiên nối tiếp dự án ở thư mục này. Đọc CLAUDE.md của thư mục (nếu chưa có thì xem qua code rồi tạo CLAUDE.md ngắn mô tả dự án) và đọc file bàn giao <File bàn giao>. Sau đó trả lời 1-2 dòng: đã nắm dự án và đang dở ở đâu. Chưa làm việc gì khác.'
    : 'Đây là phiên nối tiếp dự án ở thư mục này. Đọc CLAUDE.md của thư mục (nếu chưa có thì xem qua code rồi tạo CLAUDE.md ngắn mô tả dự án). Sau đó trả lời 1-2 dòng: đã nắm dự án gì. Chưa làm việc gì khác.'

  const text = [
    `Mở lại ${chosen.length} dự án dưới đây, mỗi dự án một phiên MỚI trên thanh bên của tài khoản đang đăng nhập.`,
    'Dùng công cụ mở phiên của app (mcp__ccd_session__start_session; nếu chưa tải thì tải bằng ToolSearch). Mỗi phiên: initiation "user_asked", context "fresh", cwd đúng đường dẫn thư mục, title đúng tên phiên, prompt là "Việc của phiên mới" bên dưới (thay <File bàn giao> bằng đường dẫn của dự án đó).',
    '',
    items.join('\n'),
    '',
    `Việc của phiên mới: "${task}"`,
    '',
    'Chỉ mở các phiên này, không làm việc gì khác. Xong thì báo ngắn gọn phiên nào đã mở, phiên nào lỗi.',
  ].join('\n')

  void $.prompt.submit({ text, asUser: true })
  await update($, view, x => ({
    ...x,
    isOpening: false,
    selected: [],
    note: `Đã gửi yêu cầu mở ${chosen.length} phiên. Xem tiến độ ở khung chat.`,
    isError: false,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'du-an', description: 'Mở lại các phiên dự án trên máy này' })
    await update($, ready, () => true)
    return next(e)
  })

  on('command.run', { command: 'du-an' }, async $ => {
    await openPane($)
    return { text: '' }
  })

  // The 📂 button in the thong-ke-token row.
  on('state.set', { plugin: 'thong-ke-token', key: 'projOpen' }, async ($, e, next) => {
    const result = await next(e)
    void openPane($)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const here = (await $.session.cwd()).toLowerCase()
    const list = v.projects ?? []
    const count = v.selected.length
    const choosable = list.filter(p => p.cwd.toLowerCase() !== here)

    const toggle = (cwd: string) =>
      void update($, view, x => ({
        ...x,
        selected: x.selected.includes(cwd) ? x.selected.filter(c => c !== cwd) : [...x.selected, cwd],
      }))

    const rows: RenderElement[] = list.map(p => {
      const isHere = p.cwd.toLowerCase() === here
      const isTicked = v.selected.includes(p.cwd)
      return (
        <Box key={`p-${p.cwd}`} flexDirection="column">
          <Box justifyContent="space-between" alignItems="center">
            <Text bold={isTicked}>{`${p.hasClaudeMd ? '📄 ' : ''}${p.title}`}</Text>
            {isHere ? (
              <Text dimColor>phiên này</Text>
            ) : (
              <Button key={`t-${p.cwd}`} label={isTicked ? '☑' : '☐'} onPress={() => toggle(p.cwd)} />
            )}
          </Box>
          <Text dimColor>{`${p.cwd.split(/[\\/]/).slice(-2).join('\\')} · ${fmtWhen(p.lastAt)}`}</Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center">
          <Text bold>Dự án trên máy này</Text>
          <Box gap={1}>
            <Button
              key="all"
              label={count === choosable.length && count > 0 ? 'Bỏ chọn' : 'Chọn hết'}
              onPress={() =>
                void update($, view, x => ({
                  ...x,
                  selected: count === choosable.length ? [] : choosable.map(p => p.cwd),
                }))
              }
            />
            <Button key="refresh" label="Làm mới" onPress={() => void refresh($)} />
          </Box>
        </Box>

        {v.isLoading && !v.projects ? <Text dimColor>Đang tìm dự án…</Text> : null}
        {v.projects && list.length === 0 ? <Text dimColor>Chưa thấy dự án nào.</Text> : null}

        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} gap={1}>
          {rows}
        </Box>

        <Box justifyContent="space-between" alignItems="center">
          <Text dimColor>{v.withContext ? '☑ Kèm ngữ cảnh phiên cũ' : '☐ Kèm ngữ cảnh phiên cũ'}</Text>
          <Button
            key="ctx"
            label={v.withContext ? 'Tắt' : 'Bật'}
            onPress={() => void update($, view, x => ({ ...x, withContext: !x.withContext }))}
          />
        </Box>

        <Box gap={1} alignItems="center">
          <Button
            key="open"
            label={v.isOpening ? 'Đang mở…' : `Mở ${count} dự án`}
            onPress={() => void openSelected($)}
          />
          {v.note ? <Text color={v.isError ? 'red' : 'green'}>{v.note}</Text> : null}
        </Box>

        <Text dimColor>📄 = đã có CLAUDE.md. Mỗi phiên mới tốn một lượt ngắn để đọc ngữ cảnh.</Text>
      </Box>
    )
  })
}
