import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Scan, ScanState, Tally, TeleBridge } from '../types'

// The tele-bridge mod's state (read only): its button shares our row.
const tele = atom(
  { plugin: 'tele-bridge', key: 'bridge' } as const,
  null as TeleBridge | null,
  { shape: 'bridge-1' },
)
const teleOpen = atom({ plugin: 'thong-ke-token', key: 'teleOpen' } as const, 0)
const allDays = atom({ plugin: 'thong-ke-token', key: 'allDays' } as const, false)
// The mo-lai-du-an mod (read only): its 📂 button shares our row.
const projOpen = atom({ plugin: 'thong-ke-token', key: 'projOpen' } as const, 0)
const projReady = atom({ plugin: 'mo-lai-du-an', key: 'ready' } as const, false)
const teleDot = (b: TeleBridge) =>
  !b.isOn ? '🔴' : b.lastError ? '🔴' : b.pairCode ? '🟡' : '🟢'

const PANE = 'thong-ke-token'
const TITLE = 'Thống kê token'

const scan = atom(
  { plugin: 'thong-ke-token', key: 'scan' } as const,
  { result: null, isRunning: false } as ScanState,
  { shape: 'scan-1' },
)
const live = atom({ plugin: 'thong-ke-token', key: 'live' } as const, null, {
  shape: 'live-1',
})

const sumTokens = (t: Tally) => t.input + t.output + t.cacheRead + t.cacheWrite

const fmtNum = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(n)

const pad = (n: number) => String(n).padStart(2, '0')

const fmtDur = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  if (h > 0) return `${h} giờ ${pad(m)} phút`
  if (m > 0) return `${m} phút ${pad(s % 60)} giây`
  return `${s} giây`
}

const fmtTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fmtReset = (iso: string, now: number) => {
  const d = new Date(iso)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay
    ? fmtTime(d.getTime())
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${fmtTime(d.getTime())}`
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5 giờ',
  seven_day: '7 ngày',
  spend_limit: 'Chi tiêu',
}

async function refreshLive($: EngineInterface) {
  const u = await $.session.usage()
  await update($, live, () => ({
    startedAt: u.startedAt,
    costUsd: u.cost?.usd,
    limits: u.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt,
    })),
  }))
}

// Runs scripts/scan.mjs, which reads the local transcripts since the start of
// the month (cached per file, so later runs take well under a second).
async function runScan($: EngineInterface) {
  const state = await read($, scan)
  if (state.isRunning) return
  await update($, scan, s => ({ ...s, isRunning: true }))
  try {
    const id = await $.session.id()
    const script = `${$.plugin.root}/scripts/scan.mjs`
    const r = await $.process.run(['node', script, id], { timeoutMs: 10 * 60 * 1000 })
    if (r.exitCode !== 0) {
      throw new Error(r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`)
    }
    const result = JSON.parse(r.stdout) as Scan
    await update($, scan, () => ({ result, isRunning: false }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, scan, s => ({ ...s, isRunning: false, error }))
  }
}

const refreshAll = ($: EngineInterface) => {
  void refreshLive($)
  void runScan($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'token', description: 'Mở pane thống kê token' })
    refreshAll($)
    return next(e)
  })

  on('command.run', { command: 'token' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    refreshAll($)
    return { text: 'Đã mở pane Thống kê token.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) refreshAll($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const t = await read($, tele).catch(() => null)
    const hasProjects = await read($, projReady).catch(() => false)

    // One row for all the mods; the Tele and 📂 buttons bump a counter that
    // the tele-bridge / mo-lai-du-an mod watches to open its pane.
    return (
      <Box flexDirection="row" gap={1}>
        <Button
          key="open-token-pane"
          label="📊 Thống kê token"
          onPress={() => {
            void $.ui.open({ id: PANE, title: TITLE })
            refreshAll($)
          }}
        />
        {t ? (
          <Button
            key="open-tele"
            label={`${teleDot(t)} Tele`}
            onPress={() => void update($, teleOpen, n => (n ?? 0) + 1)}
          />
        ) : null}
        {hasProjects ? (
          <Button
            key="open-projects"
            label="📂 Dự án"
            onPress={() => void update($, projOpen, n => (n ?? 0) + 1)}
          />
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { result: r, isRunning, error } = await read($, scan)
    const l = await read($, live)
    const now = await $.clock.now()

    const Row = (label: string, value: string) => (
      <Box justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text>{value}</Text>
      </Box>
    )

    const Section = (title: string, rows: ReturnType<typeof Row>[]) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{title}</Text>
        {rows}
      </Box>
    )

    const monthName = `Tháng ${new Date(r?.monthStart ?? now).getMonth() + 1}`

    // Daily chart: one bar per day, the last 7 days or the whole month.
    const showAll = await read($, allDays)
    const days = r?.days ?? []
    const month = new Date(r?.monthStart ?? now).getMonth() + 1
    const shown = days
      .map((tokens, i) => ({ day: i + 1, tokens }))
      .slice(showAll ? 0 : -7)
    const peak = Math.max(1, ...shown.map(d => d.tokens))
    const BAR = 12
    const chart =
      shown.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text bold>Theo ngày</Text>
            <Button
              key="days-toggle"
              label={showAll ? '7 ngày' : 'Cả tháng'}
              onPress={() => void update($, allDays, v => !v)}
            />
          </Box>
          {shown.map(d => {
            const width = d.tokens > 0 ? Math.max(1, Math.round((d.tokens / peak) * BAR)) : 0
            return (
              <Box justifyContent="space-between">
                <Text dimColor>{`${pad(d.day)}/${pad(month)}`}</Text>
                <Box gap={1}>
                  <Text color="cyan">{'█'.repeat(width) || '·'}</Text>
                  <Text>{fmtNum(d.tokens).padStart(6)}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      ) : null

    return (
      <Box flexDirection="column">
        {r
          ? Section('Phiên chat này', [
              Row('Token', fmtNum(sumTokens(r.session))),
              Row('Thời gian hoạt động', fmtDur(r.session.activeMs)),
              ...(l ? [Row('Đã mở', fmtDur(now - l.startedAt))] : []),
              ...(l?.costUsd !== undefined
                ? [Row('Chi phí ước tính', `$${l.costUsd.toFixed(2)}`)]
                : []),
            ])
          : null}

        {r
          ? Section(monthName, [
              Row('Token', fmtNum(sumTokens(r.month))),
              Row('Thời gian hoạt động', fmtDur(r.month.activeMs)),
              Row('Số phiên', String(r.month.sessions)),
            ])
          : null}

        {chart}

        {r ? null : (
          <Box marginBottom={1}>
            <Text dimColor>{isRunning ? 'Đang đọc lịch sử chat…' : 'Chưa có dữ liệu.'}</Text>
          </Box>
        )}

        {l && l.limits.length > 0
          ? Section(
              'Hạn mức tài khoản',
              l.limits.map(x =>
                Row(
                  LIMIT_NAMES[x.kind] ?? x.kind,
                  `${x.percentUsed}%${x.resetsAt ? ` · reset ${fmtReset(x.resetsAt, now)}` : ''}`,
                ),
              ),
            )
          : null}

        {error ? <Text color="red">Lỗi: {error}</Text> : null}

        <Box justifyContent="space-between">
          <Text dimColor>
            {isRunning ? 'Đang cập nhật…' : r ? `Cập nhật ${fmtTime(r.scannedAt)}` : ''}
          </Text>
          <Button key="refresh" label="Làm mới" onPress={() => refreshAll($)} />
        </Box>
      </Box>
    )
  })
}
