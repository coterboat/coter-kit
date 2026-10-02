import { expect, mock, test } from 'claude-code/testing'

// The kit resolves paths to the host's absolute form (C:\work on Windows)
const unix = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// The brain lives in /brain in every test, with no remote unless a test sets one
const OPTS = { brainDir: '/brain', brainRemote: '', brainBranch: 'brain' }
const DAY = 86_400_000

// A fake project at /work: a Next.js + TypeScript app with a typecheck script, inside git
const PROJECT_FILES: Record<string, string> = {
  '/work/package.json': JSON.stringify({ scripts: { dev: 'next dev', typecheck: 'tsc --noEmit' }, dependencies: { next: '15', react: '19' }, devDependencies: { typescript: '5' } }),
  '/work/tsconfig.json': '{}',
  '/work/src/app.ts': '',
  '/work/api/Api.csproj': '<Project />',
  '/bots/equity_bot.py': '',
}

type Opts = {
  root?: string
  dotnetLocked?: boolean
  typecheckFails?: boolean | (() => boolean)
  files?: Record<string, string>
  forkReply?: string
}

// An in-memory file system and stubs for everything coter-kit asks Claude Code for.
// Register before the first $ call.
function stubAll(on: any, opts: Opts = {}) {
  const files = new Map<string, string>(Object.entries({ ...PROJECT_FILES, ...(opts.files || {}) }))
  const store = new Map<string, unknown>()
  const ran: string[][] = []
  const forks: string[] = []
  const root = opts.root ?? '/work'
  const clock = mock.clock(on, { now: Date.now() })

  const list = (dir: string) => {
    const prefix = unix(dir).replace(/\/$/, '') + '/'
    const kids = new Map<string, string>()
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const name = rest.split('/')[0]
      kids.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    return [...kids].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
  }

  on('env.get', () => ({ value: undefined }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: { root, remote: null, internal: false, name: null } }))
  on('session.start', () => ({ cwd: root }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('fs.list', ($: any, e: any) => ({ value: list(e.path) }))
  on('fs.read', ($: any, e: any) => {
    const path = unix(e.path)
    if (path.endsWith('/profile.seed.md')) return { value: '# Profile\n- Prefers short summaries' }
    return files.has(path) ? { value: files.get(path) } : { deny: 'no such file' }
  })
  on('fs.write', ($: any, e: any) => (files.set(unix(e.path), e.text), { value: undefined }))
  on('fs.exists', ($: any, e: any) => {
    const path = unix(e.path)
    return { value: files.has(path) || [...files.keys()].some((k) => k.startsWith(path + '/')) }
  })
  on('model.fork', ($: any, e: any) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: opts.forkReply ?? '', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    ran.push(argv)
    if (argv[0] === 'python' || argv[0] === 'python3') {
      if (argv.includes('--version')) return { value: { exitCode: 0, stdout: 'Python 3.13', stderr: '' } }
      return { value: { exitCode: 1, stdout: '', stderr: '  File "bad.py", line 2\nSyntaxError: invalid syntax' } }
    }
    if (argv[0] === 'git' && argv.includes('status')) return { value: { exitCode: 0, stdout: '## main...origin/main [ahead 1]\n M src/app.ts\n', stderr: '' } }
    if (argv[0] === 'git' && argv.includes('log')) return { value: { exitCode: 0, stdout: 'abc1234 2 hours ago  Add commute route\ndef5678 1 day ago  Fix pins', stderr: '' } }
    if (argv[0] === 'dotnet') {
      return opts.dotnetLocked
        ? { value: { exitCode: 1, stdout: 'error MSB3027: Could not copy "obj/Api.dll". The file is locked by: "Api (1234)"', stderr: '' } }
        : { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv.includes('typecheck')) {
      const fails = typeof opts.typecheckFails === 'function' ? opts.typecheckFails() : opts.typecheckFails
      return fails
        ? { value: { exitCode: 2, stdout: "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", stderr: '' } }
        : { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.PreCompact', () => ({}))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return { files, store, ran, forks, clock }
}

// Every test runs with the brain in /brain
const t = (name: string, body: (...a: any[]) => Promise<void>) => test(name, { options: OPTS }, body as any)

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function snapshot($: any) {
  const out: any = await $.classic.SessionStart({ source: 'startup' })
  return out.additionalContext.join('\n') as string
}

const journal = (files: Map<string, string>) =>
  [...files.entries()].filter(([k]) => k.startsWith('/brain/journal/')).map(([, v]) => v).join('')

const BAND = {
  plugin: 'coter-kit',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 96, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const pane = (requestId: string) =>
  ({
    plugin: 'coter-kit',
    component: 'Pane',
    requestId,
    viewport: { columns: 100, rows: 30 },
    props: { title: requestId, isFocused: true, bodyColumns: 70, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  }) as const

// ---------------------------------------------------------------- 1. Snapshot

t('the snapshot gives Claude the branch, commits, stack and checklist instructions', async ($, on) => {
  stubAll(on)
  await start($)
  const text = await snapshot($)
  expect(text).toContain('Branch: main...origin/main [ahead 1]')
  expect(text).toContain('abc1234 2 hours ago  Add commute route')
  expect(text).toContain('Next.js + TypeScript')
  expect(text).toContain('mcp__coter-kit__checklist')
})

// ---------------------------------------------------------------- 2. Checks

t('a failing typecheck after an edit blocks the stop and reports the error', async ($, on) => {
  const { ran } = stubAll(on, { typecheckFails: true })
  await start($)
  await $.prompt.submit({ text: 'change the type' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  const stop: any = await $.classic.Stop({ stop_hook_active: false })
  expect(stop.block).toContain('error TS2322')
  expect(stop.block).toContain('round 1 of 2')
  expect(ran.some((a) => a.includes('typecheck'))).toBe(true)
})

t('the same failure twice is not blocked again, so Claude cannot loop', async ($, on) => {
  stubAll(on, { typecheckFails: true })
  await start($)
  await $.prompt.submit({ text: 'change the type' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  const first: any = await $.classic.Stop({ stop_hook_active: false })
  expect(first.block).toBeDefined()
  const second: any = await $.classic.Stop({ stop_hook_active: true })
  expect(second.block).toBeUndefined()
})

t('a fix that passes lets Claude stop and records the pass', async ($, on) => {
  let fails = true
  const { store } = stubAll(on, { typecheckFails: () => fails })
  await start($)
  await $.prompt.submit({ text: 'change the type' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  expect(((await $.classic.Stop({ stop_hook_active: false })) as any).block).toBeDefined()
  fails = false
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'b', new_string: 'c' })
  expect(((await $.classic.Stop({ stop_hook_active: true })) as any).block).toBeUndefined()
  expect((store.get('checks') as any)['/work'].ok).toBe(true)
})

t('no edits means no checks run at stop', async ($, on) => {
  const { ran } = stubAll(on, { typecheckFails: true })
  await start($)
  await $.prompt.submit({ text: 'just a question' })
  expect(((await $.classic.Stop({ stop_hook_active: false })) as any).block).toBeUndefined()
  expect(ran.some((a) => a.includes('typecheck'))).toBe(false)
})

t('/checks off turns the stop checks off for the project', async ($, on) => {
  const { ran } = stubAll(on, { typecheckFails: true })
  await start($)
  const reply: any = await $.command.run({ command: 'checks', args: 'off' })
  expect(reply.text).toContain('off')
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  expect(((await $.classic.Stop({ stop_hook_active: false })) as any).block).toBeUndefined()
  expect(ran.some((a) => a.includes('typecheck'))).toBe(false)
})

t('loose Python scripts with no manifest are still checked before stopping', async ($, on) => {
  stubAll(on, { root: '/bots' })
  await start($)
  await $.prompt.submit({ text: 'tune the bot' })
  await $.tool.call({ tool: 'Edit', file_path: '/bots/equity_bot.py', old_string: 'a', new_string: 'b' })
  expect(((await $.classic.Stop({ stop_hook_active: false })) as any).block).toContain('python compile')
})

t('a dotnet build blocked by a running app is skipped, not sent to Claude to fix', async ($, on) => {
  stubAll(on, { dotnetLocked: true })
  await start($)
  await $.prompt.submit({ text: 'change the api' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/api/Program.cs', old_string: 'a', new_string: 'b' })
  expect(((await $.classic.Stop({ stop_hook_active: false })) as any).block).toBeUndefined()
})

t('a Python syntax error is reported to Claude right after the edit', async ($, on) => {
  stubAll(on)
  await start($)
  const out: any = await $.tool.call({ tool: 'Write', file_path: '/work/bad.py', content: 'def x(:\n' })
  expect(out.context.join('\n')).toContain('SyntaxError')
})

// ---------------------------------------------------------------- 3. Checklist

t("Claude's checklist tool draws progress and the current step above the prompt", async ($, on) => {
  stubAll(on)
  await start($)
  const out: any = await $.tool.call({
    tool: 'mcp__coter-kit__checklist',
    title: 'Commute route',
    items: [
      { text: 'Read the map component', status: 'done' },
      { text: 'Add the route layer', status: 'active' },
      { text: 'Test on mobile', status: 'pending' },
    ],
  })
  expect(out.result).toContain('1/3 done')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Commute route  1/3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▸ Add the route layer' })).toBeDefined()
    await ui.unmount()
  }
})

t('the band shows what Claude is doing while it works', async ($, on) => {
  stubAll(on)
  await start($)
  await $.turn.start({ turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'now: Editing app.ts' })).toBeDefined()
})

t('the band stays out of the way when idle with nothing to show', async ($, on) => {
  stubAll(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
})

t("Claude Code's own todo list is mirrored into the checklist", async ($, on) => {
  stubAll(on)
  await start($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Audit the bot', status: 'completed', activeForm: 'Auditing' },
      { content: 'Backtest EDGAR scout', status: 'in_progress', activeForm: 'Backtesting' },
    ],
  })
  const ui = await $.ui.mount({ ...pane('coter-checklist'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '✓ Audit the bot' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ Backtest EDGAR scout' })).toBeDefined()
})

t('the checklist pane lists every step and Clear empties it', async ($, on) => {
  const { store } = stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__checklist', items: [{ text: 'One', status: 'done' }, { text: 'Two', status: 'blocked' }] })
  const ui = await $.ui.mount({ ...pane('coter-checklist'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '✗ Two' })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No checklist yet/ })).toBeDefined()
  expect((store.get('checklist:sess-1') as any).items.length).toBe(0)
})

// ---------------------------------------------------------------- 4. Brain

t('a new brain is created with the profile seed, and the profile reaches Claude', async ($, on) => {
  const { files, ran } = stubAll(on)
  await start($)
  expect(ran.some((a) => a[0] === 'git' && a.includes('init'))).toBe(true)
  expect(files.get('/brain/profile.md')).toContain('Prefers short summaries')
  expect(await snapshot($)).toContain('Prefers short summaries')
})

t('a decision is used at once; a preference waits for review, then is used once kept', async ($, on) => {
  stubAll(on)
  await start($)
  const out: any = await $.tool.call({
    tool: 'mcp__coter-kit__remember',
    notes: [
      { kind: 'decision', text: 'Commute times come from Google Maps, not our own math' },
      { kind: 'preference', text: 'Push back with a reason; skip devil-advocate on every point' },
    ],
  })
  expect(out.result).toContain('1 wait for the user')
  let text = await snapshot($)
  expect(text).toContain('Commute times come from Google Maps')
  expect(text).not.toContain('Push back with a reason')

  // The band nudges quietly, and /brain keeps it
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 new thing\(s\) learned/ })).toBeDefined()
  const ui = await $.ui.mount({ ...pane('coter-brain'), surface: 'desktop' })
  const row = await ui.find({ type: 'Text', text: /preference: Push back/ })
  expect(row).toBeDefined()
  const id = String(out.result.match(/Saved 2 note\(s\): \S+, (\S+)\./)[1])
  await ui.press({ key: 'keep-' + id })
  text = await snapshot($)
  expect(text).toContain('Push back with a reason')
})

t('something the user asked to have remembered skips the review', async ($, on) => {
  stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'term', text: '"cook" = keep building on your own until review', confirmed: true }] })
  expect(await snapshot($)).toContain('"cook" = keep building on your own')
})

t('credentials are redacted before anything is written', async ($, on) => {
  const { files } = stubAll(on)
  await start($)
  await $.tool.call({
    tool: 'mcp__coter-kit__remember',
    notes: [{ kind: 'fact', text: 'Test user is demo with pw Hunter2Example! and app secret 0123456789abcdef0123456789abcdef' }],
  })
  const written = journal(files)
  expect(written).toContain('[redacted]')
  expect(written).not.toContain('Hunter2Example!')
  expect(written).not.toContain('0123456789abcdef0123456789abcdef')
})

t('the same note twice is kept once', async ($, on) => {
  stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'The API deploys by hand, not from GitHub.' }] })
  const again: any = await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'the API deploys by hand not from github' }] })
  expect(again.result).toContain('Nothing new')
})

t('a superseded decision drops out of what Claude is told', async ($, on) => {
  stubAll(on)
  await start($)
  const first: any = await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'decision', text: 'Day trading is half the portfolio' }] })
  const id = String(first.result.match(/Saved 1 note\(s\): (\S+)\./)[1])
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'decision', text: 'Day trading shrinks to a small experiment; core-satellite is the plan', resolves: id }] })
  const text = await snapshot($)
  expect(text).not.toContain('Day trading is half the portfolio')
  expect(text).toContain('core-satellite is the plan')
})

t('notes from another machine and project load, old threads expire', async ($, on) => {
  const now = Date.now()
  const mac = [
    { id: 'm1', at: now - 2 * DAY, device: 'macbook', project: 'ourPlace', kind: 'thread', text: 'Waiting on Sarah for the Georgia statewide list', status: 'active' },
    { id: 'm2', at: now - 40 * DAY, device: 'macbook', project: 'ourPlace', kind: 'thread', text: 'Old thread nobody closed', status: 'active' },
    { id: 'm3', at: now - 1 * DAY, device: 'macbook', project: '', kind: 'term', text: '"m10" = milestone 10 of the Iron Veil roadmap', status: 'pending' },
    { op: 'status', ref: 'm3', status: 'active', at: now - DAY / 2, device: 'macbook' },
  ]
  stubAll(on, { files: { '/brain/.git/HEAD': 'ref', '/brain/profile.md': '# Profile', '/brain/journal/macbook/2026-09-30-abc.jsonl': mac.map((r) => JSON.stringify(r)).join('\n') } })
  await start($)
  const text = await snapshot($)
  expect(text).toContain('[ourPlace · 2d ago] Waiting on Sarah')
  expect(text).not.toContain('Old thread nobody closed')
  expect(text).toContain('"m10" = milestone 10')
})

t('recall finds notes by keyword across projects', async ($, on) => {
  stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Statewide search rewrites the stored procedure to skip the zip code' }] })
  const out: any = await $.tool.call({ tool: 'mcp__coter-kit__recall', query: 'stored procedure zip' })
  expect(out.result).toContain('Statewide search rewrites')
  const none: any = await $.tool.call({ tool: 'mcp__coter-kit__recall', query: 'kubernetes' })
  expect(none.result).toContain('Nothing in memory')
})

t('every 8 turns a digest of the session is kept, without the review step for threads', async ($, on) => {
  const { forks, clock } = stubAll(on, {
    forkReply:
      '{"kind": "thread", "text": "EDGAR scout backtest still to run on 2019-2024", "scope": "project"}\n' +
      '{"kind": "term", "text": "\\"cook\\" = keep building on your own", "scope": "global"}\n' +
      'not json, ignored',
  })
  await start($)
  for (let i = 0; i < 8; i++) await $.turn.complete({ turnId: 't' + i, answer: 'ok', durationMs: 1, isAborted: false, usage: null })
  await clock.advance(2_000)
  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('Already known')
  const text = await snapshot($)
  expect(text).toContain('EDGAR scout backtest still to run')
  expect(text).not.toContain('"cook"')
})

t('notes are committed and pushed to the remote a little after they are written', async ($, on) => {
  const { ran, clock } = stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Brain sync test' }] })
  expect(ran.some((a) => a.includes('commit'))).toBe(false)
  await clock.advance(21_000)
  expect(ran.some((a) => a.includes('commit'))).toBe(true)
})

test('with a remote set, a new machine clones the brain and syncs back to it', { options: { ...OPTS, brainRemote: 'https://github.com/coterboat/coter-kit.git' } }, async ($: any, on: any) => {
  const { ran, clock } = stubAll(on)
  await start($)
  expect(ran.some((a) => a[0] === 'git' && a.includes('clone') && a.includes('brain'))).toBe(true)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Pushed from the PC' }] })
  await clock.advance(21_000)
  expect(ran.some((a) => a[0] === 'git' && a.includes('push') && a.includes('HEAD:brain'))).toBe(true)
})
