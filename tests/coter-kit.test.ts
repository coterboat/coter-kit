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
  pullFails?: boolean
  missingFiles?: string[]
  hostname?: string
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
    if (argv[0] === 'git' && argv.includes('pull') && opts.pullFails) return { value: { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in HANDOFF.md' } }
    if (argv[0] === 'hostname') return opts.hostname ? { value: { exitCode: 0, stdout: opts.hostname + '\n', stderr: '' } } : { value: { exitCode: 1, stdout: '', stderr: 'no' } }
    if (argv[0] === 'git' && argv.includes('ls-files')) return { value: { exitCode: 0, stdout: (opts.missingFiles ?? []).join('\n'), stderr: '' } }
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
  on('prompt.submit', ($: any, e: any) => ({ text: e.text, context: e.context }))
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

// What Claude is given as a session starts: the snapshot, then the brain beside the first prompt
async function snapshot($: any, firstPrompt = 'hi') {
  const out: any = await $.classic.SessionStart({ source: 'startup' })
  const first: any = await $.prompt.submit({ text: firstPrompt })
  return [...out.additionalContext, ...(first.context ?? [])].join('\n') as string
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
    expect(await ui.find({ type: 'Text', text: '· Add the route layer' })).toBeDefined()
    await ui.unmount()
  }
})

t('the band opens to every step and folds back, and remembers which across sessions', async ($, on) => {
  const { store } = stubAll(on)
  await start($)
  const items = Array.from({ length: 7 }, (_, i) => ({ text: 'Step ' + (i + 1), status: i < 2 ? 'done' : i === 2 ? 'active' : 'pending' }))
  await $.tool.call({ tool: 'mcp__coter-kit__checklist', title: 'Big job', items })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '· Step 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Step 7/ })).toBeUndefined()
    await ui.press({ key: 'checklist-toggle' })
    // Every step, past the band's 4 rows: the engine scrolls the rest
    expect(await ui.find({ type: 'Text', text: '  ✓ Step 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ▸ Step 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ○ Step 7' })).toBeDefined()
    expect(store.get('checklist:expanded')).toBe(true)
    await ui.press({ key: 'checklist-toggle' })
    expect(await ui.find({ type: 'Text', text: /Step 7/ })).toBeUndefined()
    expect(store.get('checklist:expanded')).toBe(false)
    await ui.unmount()
  }
})

t('a session opens the band the way it was last left', async ($, on) => {
  const { store } = stubAll(on)
  store.set('checklist:expanded', true)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__checklist', items: [{ text: 'One', status: 'done' }, { text: 'Two', status: 'active' }] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '  ✓ One' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ▸ Two' })).toBeDefined()
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

t('ordinary words like token or secret are not redacted', async ($, on) => {
  const { files } = stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'The token budget is tight; the secret sauce is the digest' }] })
  expect(journal(files)).toContain('The token budget is tight; the secret sauce is the digest')
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

const eightTurns = async ($: any) => {
  for (let i = 0; i < 8; i++) await $.turn.complete({ turnId: 't' + i, answer: 'ok', durationMs: 1, isAborted: false, usage: null })
}
const idOf = (files: Map<string, string>, text: string) =>
  journal(files).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.text === text)?.id as string

t('every 8 turns the digest proposes notes, and each waits for review before Claude is told', async ($, on) => {
  const { files, forks, clock } = stubAll(on, {
    forkReply:
      '{"kind": "thread", "text": "EDGAR scout backtest still to run on 2019-2024", "scope": "project"}\n' +
      '{"kind": "term", "text": "\\"cook\\" = keep building on your own", "scope": "global"}\n' +
      'not json, ignored',
  })
  await start($)
  await eightTurns($)
  await clock.advance(2_000)
  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('Already known')
  let text = await snapshot($)
  expect(text).not.toContain('EDGAR scout backtest still to run')
  expect(text).toContain('2 learned item(s) wait for their review in /brain')

  const ui = await $.ui.mount({ ...pane('coter-brain'), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /thread · work · digest: EDGAR scout/ })).toBeDefined()
  await ui.press({ key: 'keep-' + idOf(files, 'EDGAR scout backtest still to run on 2019-2024') })
  text = await snapshot($)
  expect(text).toContain('EDGAR scout backtest still to run')
  expect(text).not.toContain('"cook"')
})

t('the digest cannot skip review, retire a note, or leave a handoff', async ($, on) => {
  const tuesday = { id: 'd1', at: Date.now() - DAY, device: 'pc', session: 'pc-session', project: 'work', kind: 'decision', text: 'Ship on Tuesdays', status: 'active' }
  const { files, clock } = stubAll(on, {
    files: { '/brain/.git/HEAD': 'ref', '/brain/profile.md': '# Profile', '/brain/journal/pc/2026-10-02-pc.jsonl': JSON.stringify(tuesday) + '\n' },
    forkReply:
      '{"kind": "decision", "text": "Ship on Fridays", "confirmed": true, "resolves": "d1"}\n' +
      '{"kind": "handoff", "text": "Goal: something the user never asked to hand off"}\n' +
      '{"kind": "waiting", "text": "A question nobody asked", "link": "https://example.com"}',
  })
  await start($)
  await eightTurns($)
  await clock.advance(2_000)
  const rows = journal(files).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  expect(rows.find((r) => r.text === 'Ship on Fridays')?.status).toBe('pending')
  expect(rows.some((r) => r.op === 'status' && r.ref === 'd1')).toBe(false)
  expect(rows.some((r) => r.kind === 'handoff' || r.kind === 'waiting')).toBe(false)
  const text = await snapshot($)
  expect(text).toContain('Ship on Tuesdays')
  expect(text).not.toContain('Ship on Fridays')
})

t('a note the user dropped is not proposed again', async ($, on) => {
  const { files, forks, clock } = stubAll(on, { forkReply: '{"kind": "fact", "text": "The API is written in Go", "scope": "project"}' })
  await start($)
  await eightTurns($)
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...pane('coter-brain'), surface: 'terminal' })
  await ui.press({ key: 'drop-' + idOf(files, 'The API is written in Go') })
  await eightTurns($)
  await clock.advance(2_000)
  expect(forks.length).toBe(2)
  expect(journal(files).split('The API is written in Go').length - 1).toBe(1)
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

// ---------------------------------------------------------------- 5. Handoffs

const REMOTE = { ...OPTS, brainRemote: 'https://github.com/coterboat/coter-kit.git' }

test('/handoff saves a summary, writes HANDOFF.md and pushes it at once', { options: REMOTE }, async ($: any, on: any) => {
  const { files, ran, forks } = stubAll(on, { forkReply: 'Goal: finish the Mac setup.\nNext steps:\n1. On the Mac, install coter-kit.' })
  await start($)
  const out: any = await $.command.run({ command: 'handoff', args: 'mention the Mac' })
  expect(forks[0]).toContain('The user adds: mention the Mac')
  expect(out.text).toContain('Goal: finish the Mac setup.')
  expect(out.text).toContain('pushed')
  const file = files.get('/brain/HANDOFF.md') ?? ''
  expect(file).toContain('claude plugin marketplace add coterboat/coter-kit')
  expect(file).toContain('--config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain')
  expect(file).toContain('1. On the Mac, install coter-kit.')
  expect(ran.some((a) => a[0] === 'git' && a.includes('push'))).toBe(true)
})

t('a handoff from another session waits, in the band and in memory, until the user asks to pick it up', async ($, on) => {
  const handoff = { id: 'h1', at: Date.now() - 3_600_000, device: 'bld', session: 'other-session', project: '', from: 'scratch', kind: 'handoff', text: 'Goal: run mine-history on the Mac.', status: 'active' }
  stubAll(on, { files: { '/brain/.git/HEAD': 'ref', '/brain/profile.md': '# Profile', '/brain/journal/bld/2026-10-02-other.jsonl': JSON.stringify(handoff) } })
  await start($)
  let text = await snapshot($)
  // Background, not a first order: after the profile, acted on only when asked
  expect(text.indexOf('## Handoff waiting')).toBeGreaterThan(text.indexOf('## Who you are working with'))
  expect(text).toContain('Act on it only when they ask to pick it up')
  expect(text).not.toContain('Before anything else')
  expect(text).toContain('[h1] from scratch on bld')
  expect(text).toContain('Goal: run mine-history on the Mac.')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /handoff waiting from scratch on bld/ })).toBeDefined()
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'thread', text: 'Picked up the Mac setup handoff', resolves: 'h1' }] })
  text = await snapshot($)
  expect(text).not.toContain('Goal: run mine-history on the Mac.')
})

t('a handoff is not shown back to the session that wrote it', async ($, on) => {
  stubAll(on)
  await start($)
  const out: any = await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'handoff', text: 'Goal: something for later.', confirmed: true }] })
  expect(out.result).toContain('saved on this machine only')
  expect(await snapshot($)).not.toContain('Goal: something for later.')
})

// ---------------------------------------------------------------- 6. A running session stays in sync

// Notes another session wrote, as a pull (or a session on this machine) leaves them on disk
const arrive = (files: Map<string, string>, rows: object[], device = 'pc') =>
  files.set('/brain/journal/' + device + '/2026-10-02-other.jsonl', rows.map((r) => JSON.stringify(r)).join('\n'))
const fromPC = (over: object) => ({ at: Date.now() - 60_000, device: 'pc', session: 'pc-session', project: 'work', status: 'active', ...over })

t('the snapshot tells Claude how memory stays current and when to sync or hand off', async ($, on) => {
  stubAll(on)
  await start($)
  const text = await snapshot($)
  expect(text).toContain('New in working memory')
  expect(text).toContain('/brain sync')
  expect(text).toContain('/handoff')
})

t('/brain sync takes in what another session wrote, and the next prompt carries it once', async ($, on) => {
  const { files } = stubAll(on)
  await start($)
  arrive(files, [fromPC({ id: 'p1', kind: 'decision', text: 'Routes are cached for a day' })])
  const reply: any = await $.command.run({ command: 'brain', args: 'sync' })
  expect(reply.text).toContain('1 new note(s) from other sessions')
  const first: any = await $.prompt.submit({ text: 'where were we?' })
  expect(first.context.join('\n')).toContain('Routes are cached for a day')
  const second: any = await $.prompt.submit({ text: 'and then?' })
  expect((second.context ?? []).length).toBe(0)
})

test('while a session runs, a handoff pushed from another machine is pulled in, shown, and handed to Claude', { options: REMOTE }, async ($: any, on: any) => {
  const { files, ran, clock } = stubAll(on)
  await start($)
  expect(ran.some((a) => a.includes('pull'))).toBe(false)
  arrive(files, [fromPC({ id: 'h9', project: '', from: 'ourPlace', kind: 'handoff', text: 'Goal: ship the statewide search.' })])
  await clock.advance(121_000)
  expect(ran.some((a) => a[0] === 'git' && a.includes('pull'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /handoff waiting from ourPlace on pc/ })).toBeDefined()
  const out: any = await $.prompt.submit({ text: 'morning' })
  const context = out.context.join('\n')
  expect(context).toContain('## Handoff')
  expect(context).toContain('[h9] from ourPlace on pc')
  expect(context).toContain("resolves set to the handoff's id")
})

test('recall fetches the latest from other machines before it searches', { options: REMOTE }, async ($: any, on: any) => {
  const { files, ran, clock } = stubAll(on)
  await start($)
  arrive(files, [fromPC({ id: 'f1', kind: 'fact', text: 'The PC builds the Godot export, not the Mac' })])
  await clock.advance(20_000)
  const out: any = await $.tool.call({ tool: 'mcp__coter-kit__recall', query: 'godot export' })
  expect(ran.some((a) => a[0] === 'git' && a.includes('pull'))).toBe(true)
  expect(out.result).toContain('The PC builds the Godot export')
})

t('/clear re-reads the brain, so the fresh snapshot has what other sessions wrote', async ($, on) => {
  const { files } = stubAll(on)
  await start($)
  arrive(files, [fromPC({ id: 'p2', kind: 'thread', text: 'Waiting on the county list' })], 'macbook')
  const out: any = await $.classic.SessionStart({ source: 'clear' })
  expect(out.additionalContext.join('\n')).toContain('Waiting on the county list')
  const next: any = await $.prompt.submit({ text: 'go' })
  expect((next.context ?? []).length).toBe(0)
})

t("a session's own notes are not handed back to it as new", async ($, on) => {
  stubAll(on)
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Written here' }] })
  await $.command.run({ command: 'brain', args: 'sync' })
  const out: any = await $.prompt.submit({ text: 'go' })
  expect((out.context ?? []).length).toBe(0)
})

t("another project's notes and unreviewed preferences are not pushed into this session", async ($, on) => {
  const { files } = stubAll(on)
  await start($)
  arrive(files, [
    fromPC({ id: 'o1', project: 'ironVeil', kind: 'decision', text: 'Iron Veil ships on Steam first' }),
    fromPC({ id: 'o2', project: '', kind: 'preference', text: 'Never use tabs', status: 'pending' }),
  ])
  const reply: any = await $.command.run({ command: 'brain', args: 'sync' })
  expect(reply.text).toContain('Nothing new from other sessions')
  const out: any = await $.prompt.submit({ text: 'go' })
  expect((out.context ?? []).length).toBe(0)
})

test('a pull that hits a conflict is undone, so the brain is never left mid-rebase', { options: REMOTE }, async ($: any, on: any) => {
  const { ran } = stubAll(on, { pullFails: true })
  await start($)
  await $.command.run({ command: 'brain', args: 'sync' })
  expect(ran.some((a) => a[0] === 'git' && a.includes('rebase') && a.includes('--abort'))).toBe(true)
})

// ---------------------------------------------------------------- 7. Startup order and safe syncs

t('the snapshot has the brain even when the session raises SessionStart before session.start', async ($, on) => {
  const { ran } = stubAll(on)
  const text = await snapshot($)
  expect(text).toContain('Project: work')
  expect(text).toContain('Prefers short summaries')
  expect(text).toContain('## Using this memory')
  await start($)
  expect(ran.filter((a) => a[0] === 'git' && a.includes('init')).length).toBe(1)
})

t("a sync never commits a deletion: a note missing from disk is put back, not deleted on every machine", async ($, on) => {
  const { ran, clock } = stubAll(on, { missingFiles: ['journal/bld/2026-10-02-5cf38e73.jsonl', 'HANDOFF.md'] })
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Sync safety test' }] })
  await clock.advance(21_000)
  const adds = ran.filter((a) => a[0] === 'git' && a.includes('add'))
  expect(adds.length).toBeGreaterThan(0)
  expect(adds.every((a) => a.includes('--ignore-removal') && !a.includes('-A'))).toBe(true)
  const restore = ran.find((a) => a[0] === 'git' && a.includes('checkout'))
  expect(restore).toEqual(['git', '-C', '/brain', 'checkout', '--', 'journal/bld/2026-10-02-5cf38e73.jsonl', 'HANDOFF.md'])
})

// ---------------------------------------------------------------- 6. Waiting on you

t('a mockup to review waits in /waiting with its link until the user answers it', async ($, on) => {
  stubAll(on)
  await start($)
  const out: any = await $.tool.call({
    tool: 'mcp__coter-kit__remember',
    notes: [
      { kind: 'waiting', text: 'Pick the desktop job-detail layout', ref: 'Q1', link: 'https://claude.ai/artifact/abc123' },
      { kind: 'waiting', text: 'A link that is not a web page is dropped', link: 'javascript:alert(1)' },
      { kind: 'waiting', text: 'A link with a password in it is dropped', link: 'https://me:hunter22@example.com/x' },
    ],
  })
  expect(out.result).toContain('Saved 3 note(s)')
  const first = String(out.result.match(/Saved 3 note\(s\): (\S+?),/)[1])

  const shown: any = await $.command.run({ command: 'waiting', args: '' })
  expect(shown.text).toContain('Waiting on you (work): 3')
  expect(shown.text).toContain('Q1 · Pick the desktop job-detail layout')
  expect(shown.text).toContain('https://claude.ai/artifact/abc123')
  expect(shown.text).not.toContain('javascript:')
  expect(shown.text).not.toContain('hunter22')

  // A new session is told what is waiting, with ids it can resolve
  const text = await snapshot($)
  expect(text).toContain('## Waiting on the user (work)')
  expect(text).toContain('[' + first + '] Q1 · Pick the desktop job-detail layout (https://claude.ai/artifact/abc123)')

  // The band nudges quietly
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /3 waiting on you · \/waiting/ })).toBeDefined()

  // The answer resolves it
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'decision', text: 'Build both layouts A and B to compare', resolves: first }] })
  const after: any = await $.command.run({ command: 'waiting', args: '' })
  expect(after.text).not.toContain('Pick the desktop job-detail layout')
  expect(after.text).toContain('Waiting on you (work): 2')
})

t('/waiting shows this project by default and every project with "all"', async ($, on) => {
  const other = [
    { id: 'w1', at: Date.now(), device: 'pc', session: 's9', project: 'wallstbets', kind: 'waiting', text: 'Approve the new stop-loss rule', ref: 'Q3', status: 'active' },
  ]
  stubAll(on, { files: { '/brain/.git/HEAD': 'ref', '/brain/profile.md': '# Profile', '/brain/journal/pc/2026-10-02-s9.jsonl': other.map((r) => JSON.stringify(r)).join('\n') } })
  await start($)
  const here: any = await $.command.run({ command: 'waiting', args: '' })
  expect(here.text).toContain('Nothing is waiting on you in work')
  const all: any = await $.command.run({ command: 'waiting', args: 'all' })
  expect(all.text).toContain('Waiting on you (wallstbets): 1')
  expect(all.text).toContain('Q3 · Approve the new stop-loss rule')
})

// ---------------------------------------------------------------- 8. Who is there, and what else is in flight

const SCHEDULED = '<scheduled-task name="concurrent-bots-loop" file="/x/SKILL.md">\nThis is an automated run of a scheduled task. The user is not present.'

// A brain with a bit of everything: profile, an approved preference, this project's decision,
// another project's threads, and a handoff from the PC
function fullBrain(now = Date.now()) {
  const rows = [
    { id: 'p1', at: now - DAY, device: 'pc', session: 'pc-s', project: '', kind: 'preference', text: 'Swapping a 2D asset for a 3D one needs no approval', status: 'active' },
    { id: 'd1', at: now - DAY, device: 'pc', session: 'pc-s', project: 'work', kind: 'decision', text: 'Bots trade paper only until the backtest beats the index', status: 'active' },
    { id: 't1', at: now - 3 * 3_600_000, device: 'pc', session: 'pc-s', project: 'jobsnearme', kind: 'thread', text: 'jobsnearme lane 1: FS-301 committed', status: 'active' },
    { id: 't2', at: now - 3_600_000, device: 'pc', session: 'pc-s', project: 'jobsnearme', kind: 'thread', text: 'jobsnearme lane 3: ' + 'FS-313 landed, FS-314 building, then FS-315; owner questions re-asked. '.repeat(4), status: 'active' },
    { id: 't3', at: now - 2 * 3_600_000, device: 'pc', session: 'pc-s', project: 'ironVeil', kind: 'thread', text: 'Iron Veil m3 sprites waiting on ludo.ai', status: 'active' },
    { id: 'h1', at: now - 3_600_000, device: 'bld', session: 'pc-s', project: '', from: 'scratch', kind: 'handoff', text: 'Goal: finish the Mac setup.', status: 'active' },
  ]
  return {
    '/brain/.git/HEAD': 'ref',
    '/brain/profile.md': '# Profile\n- Casual, direct, short',
    '/brain/journal/pc/2026-10-03-pc.jsonl': rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  }
}

t('the startup snapshot leaves the brain for the first prompt', async ($, on) => {
  stubAll(on, { files: fullBrain() })
  await start($)
  const out: any = await $.classic.SessionStart({ source: 'startup' })
  const startup = out.additionalContext.join('\n')
  expect(startup).toContain('# Project snapshot')
  expect(startup).not.toContain('# Working memory')
  const first: any = await $.prompt.submit({ text: 'morning' })
  const brainText = first.context.join('\n')
  expect(brainText).toContain('Casual, direct, short')
  expect(brainText).toContain('Goal: finish the Mac setup.')
  const second: any = await $.prompt.submit({ text: 'and then?' })
  expect((second.context ?? []).length).toBe(0)
})

t("a scheduled task's run gets only this project's notes: no profile, no other projects, never a handoff", async ($, on) => {
  const { files, forks, clock } = stubAll(on, { files: fullBrain(), forkReply: '{"kind": "fact", "text": "From a bot loop", "scope": "project"}' })
  await start($)
  const text = await snapshot($, SCHEDULED)
  expect(text).toContain('for a run nobody is watching')
  expect(text).toContain('Bots trade paper only until the backtest beats the index')
  expect(text).toContain('Swapping a 2D asset for a 3D one needs no approval')
  expect(text).not.toContain('Casual, direct, short')
  expect(text).not.toContain('Goal: finish the Mac setup.')
  expect(text).not.toContain('jobsnearme')
  expect(text).not.toContain('/handoff')

  // Nothing from other sessions later, and no digest proposals from a run nobody reviews
  arrive(files, [fromPC({ id: 'h2', project: '', from: 'ourPlace', kind: 'handoff', text: 'Goal: ship the statewide search.' })])
  await $.command.run({ command: 'brain', args: 'sync' })
  const later: any = await $.prompt.submit({ text: 'next step of the loop' })
  expect((later.context ?? []).length).toBe(0)
  await eightTurns($)
  await clock.advance(2_000)
  expect(forks.length).toBe(0)
})

t('other projects show one short line each: their newest thread', async ($, on) => {
  stubAll(on, { files: fullBrain() })
  await start($)
  const text = await snapshot($)
  const section = text.slice(text.indexOf('## In flight in their other projects'))
  expect(section).toContain('[jobsnearme · 1h ago] jobsnearme lane 3: FS-313 landed')
  expect(section).toContain('…')
  expect(section).not.toContain('FS-301 committed')
  expect(section).toContain('[ironVeil · 2h ago] Iron Veil m3 sprites waiting on ludo.ai')
})

// ---------------------------------------------------------------- 9. Catch-up

const HOUR = 3_600_000
const longTurn = async ($: any, clock: any, ms: number, id = 't1') => {
  await $.turn.start({ turnId: id })
  await clock.advance(ms)
  await $.turn.complete({ turnId: id, answer: 'ok', durationMs: ms, isAborted: false, usage: null })
}

t('after a long stretch without you, the band offers /catchup, which gives the facts then six lines, and stops offering it', async ($, on) => {
  const { forks, clock } = stubAll(on, { forkReply: 'Done: FS-314 landed, tests green\nNeeds you: Q19 intro prompts' })
  await start($)
  await $.prompt.submit({ text: 'build the signup wave, back in a few hours' })
  await $.tool.call({ tool: 'mcp__coter-kit__checklist', title: 'Signup wave', items: [{ text: 'FS-314', status: 'done' }, { text: 'FS-315', status: 'active' }] })
  await longTurn($, clock, 2 * HOUR)

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'catch up: /catchup · 2h 00m of work since your last message' })).toBeDefined()
  await band.unmount()

  const out: any = await $.command.run({ command: 'catchup', args: '' })
  expect(out.text).toContain('Since your last message, 2h 00m ago: 2h 00m of work')
  expect(out.text).toContain('Checklist: Signup wave 1/2 · ▸ FS-315')
  expect(out.text).toContain('Done: FS-314 landed, tests green')
  expect(out.text).toContain('Needs you: Q19 intro prompts')
  expect(forks[0]).toContain('back after 2h 00m')
  expect(forks[0]).toContain('Decided: choices made that they did not make themselves')

  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /catch up/ })).toBeUndefined()
})

t('a short stretch is not worth a catch-up', async ($, on) => {
  const { clock } = stubAll(on)
  await start($)
  await $.prompt.submit({ text: 'quick fix' })
  await longTurn($, clock, 10 * 60_000)
  await $.tool.call({ tool: 'mcp__coter-kit__checklist', items: [{ text: 'One', status: 'done' }] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /catch up/ })).toBeUndefined()
})

t("background deliveries and other sessions' messages are not you looking", async ($, on) => {
  const { clock } = stubAll(on)
  await start($)
  await $.prompt.submit({ text: 'coordinate the lanes' })
  await longTurn($, clock, HOUR)
  await $.prompt.submit({ text: '<task-notification>lane 2 done</task-notification>', origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: 'lane 3 is blocked', origin: { kind: 'peer' } })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /catch up: \/catchup · 1h 00m/ })).toBeDefined()
})

t('a /loop or routine firing counts as a scheduled run and gets the lean brain', async ($, on) => {
  stubAll(on, { files: fullBrain() })
  await start($)
  await $.classic.SessionStart({ source: 'startup' })
  const first: any = await $.prompt.submit({ text: 'check the deploy', origin: { kind: 'scheduled-trigger' } })
  const text = first.context.join('\n')
  expect(text).toContain('for a run nobody is watching')
  expect(text).not.toContain('Goal: finish the Mac setup.')
})

t('every question you owe is a waiting note, link or not, and Claude is told so', async ($, on) => {
  stubAll(on)
  await start($)
  const text = await snapshot($)
  expect(text).toContain('with or without a link')
  expect(text).toContain('never a thread')
})

t('a restarted or resumed session still knows when you last spoke', async ($, on) => {
  const { store } = stubAll(on)
  store.set('look:sess-1', { lastLookAt: Date.now() - 3 * HOUR, workSinceLook: 2 * HOUR })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'catch up: /catchup · 2h 00m of work since your last message' })).toBeDefined()
})

t("a Mac with no HOSTNAME set is named after the machine, so the desktop app and the terminal agree", async ($, on) => {
  const { files } = stubAll(on, { hostname: 'Alexs-MacBook-Pro' })
  await start($)
  await $.tool.call({ tool: 'mcp__coter-kit__remember', notes: [{ kind: 'fact', text: 'Named by the machine' }] })
  expect([...files.keys()].some((k) => k.startsWith('/brain/journal/alexs-macbook-pro/'))).toBe(true)
})
