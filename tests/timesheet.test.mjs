// The timesheet's arithmetic (hooks/timesheet.js): pure functions, so no session is needed.
// node --test tests/timesheet.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dayTotals, updateMachine, weekOf, weekDates, sheetFor, billedMinutes, parseAdjustment, formatSheet, confirmCheck, validSheet,
} from '../hooks/timesheet.js'

const MIN = 60_000
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime() // October 2026, local time
const rec = (over) => ({ v: 1, id: 's', project: 'jobsnearme', scheduled: false, state: 'ended', beats: [], turns: [], updated_at: new Date(at(5, 18)).toISOString(), ...over })

test('your time is the credit of each beat on its day; Claude\'s is the turns, per session and as wall clock', () => {
  const day = dayTotals(
    [
      rec({ id: 'a', beats: [[at(5, 9, 10), 10 * MIN], [at(5, 9, 40), 15 * MIN]], turns: [[at(5, 9, 11), at(5, 9, 31)]] }),
      rec({ id: 'b', beats: [[at(5, 10), 5 * MIN]], turns: [[at(5, 9, 20), at(5, 9, 50)]] }),
    ],
    '2026-10-05',
  )
  assert.deepEqual(day.jobsnearme, { you_ms: 30 * MIN, claude_ms: 50 * MIN, claude_wall_ms: 39 * MIN, scheduled_ms: 0 })
})

test('scheduled runs add Claude\'s time, kept apart, and never your time', () => {
  const day = dayTotals([rec({ scheduled: true, project: 'concurrent', beats: [[at(5, 9), 15 * MIN]], turns: [[at(5, 7), at(5, 8)]] })], '2026-10-05')
  assert.deepEqual(day.concurrent, { you_ms: 0, claude_ms: 60 * MIN, claude_wall_ms: 60 * MIN, scheduled_ms: 60 * MIN })
})

test('a turn across midnight is split between the two days, and a beat after midnight credits only the minutes since', () => {
  const recs = [rec({ beats: [[at(6, 0, 5), 15 * MIN]], turns: [[at(5, 23), at(6, 2)]] })]
  assert.equal(dayTotals(recs, '2026-10-05').jobsnearme.claude_ms, 60 * MIN)
  assert.equal(dayTotals(recs, '2026-10-06').jobsnearme.claude_ms, 120 * MIN)
  assert.equal(dayTotals(recs, '2026-10-06').jobsnearme.you_ms, 5 * MIN)
  assert.equal(dayTotals(recs, '2026-10-05').jobsnearme?.you_ms ?? 0, 0)
})

test('a turn still running counts up to the last heartbeat, once', () => {
  const r = rec({ state: 'working', state_since: new Date(at(5, 17)).toISOString(), updated_at: new Date(at(5, 17, 30)).toISOString(), turns: [[at(5, 16), at(5, 16, 50)], [at(5, 17), at(5, 17, 10)]] })
  assert.equal(dayTotals([r], '2026-10-05').jobsnearme.claude_ms, 80 * MIN)
})

test('a session id seen twice is one session', () => {
  const a = rec({ id: 'x', beats: [[at(5, 9), 10 * MIN]] })
  assert.equal(dayTotals([a, { ...a }], '2026-10-05').jobsnearme.you_ms, 10 * MIN)
})

test('the machine file keeps a day once its beats fall out of the live files, and never shrinks', () => {
  const now = at(8, 10)
  const first = updateMachine(null, { device: 'mac', now: at(5, 18), records: [rec({ beats: [[at(5, 9), 12 * MIN]], turns: [[at(5, 9), at(5, 10)]] })] })
  assert.equal(first.days['2026-10-05'].jobsnearme.you_ms, 12 * MIN)
  // Three days later the live record no longer carries the beat
  const later = updateMachine(first, { device: 'mac', now, records: [rec({ beats: [], turns: [] })] })
  assert.equal(later.days['2026-10-05'].jobsnearme.you_ms, 12 * MIN)
  assert.equal(later.days['2026-10-05'].jobsnearme.claude_ms, 60 * MIN)
  // A day that is still growing does grow
  const grown = updateMachine(first, { device: 'mac', now: at(5, 19), records: [rec({ beats: [[at(5, 9), 12 * MIN], [at(5, 12), 15 * MIN]] })] })
  assert.equal(grown.days['2026-10-05'].jobsnearme.you_ms, 27 * MIN)
})

test('the machine file carries its own adjustments and confirmations through an update', () => {
  const prior = { v: 1, device: 'mac', days: {}, adjustments: [{ id: 'a1', date: '2026-10-05', project: 'jobsnearme', min: 30, note: 'call' }], confirmed: { '2026-09-28': { at: 1 } } }
  const next = updateMachine(prior, { device: 'mac', now: at(5, 18), records: [] })
  assert.equal(next.adjustments.length, 1)
  assert.deepEqual(Object.keys(next.confirmed), ['2026-09-28'])
})

test('weeks run Monday to Sunday', () => {
  assert.equal(weekOf('2026-10-04'), '2026-09-28') // a Sunday
  assert.equal(weekOf('2026-10-05'), '2026-10-05') // a Monday
  assert.deepEqual(weekDates('2026-09-28'), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
})

test('billing rounds each project-day of your time up to 6 minutes, and adds adjustments as they are', () => {
  assert.equal(billedMinutes(0), 0)
  assert.equal(billedMinutes(1), 6)
  assert.equal(billedMinutes(6 * MIN), 6)
  assert.equal(billedMinutes(6 * MIN + 1), 12)
  const mac = { device: 'mac', days: { '2026-10-05': { jobsnearme: { you_ms: 61 * MIN, claude_ms: 5 * 61 * MIN, claude_wall_ms: 0, scheduled_ms: 0 } }, '2026-10-06': { jobsnearme: { you_ms: 7 * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } } }, adjustments: [{ id: 'a', date: '2026-10-06', project: 'jobsnearme', min: 30, note: 'client call' }] }
  const s = sheetFor([mac], '2026-10-05')
  const p = s.projects.jobsnearme
  assert.equal(p.billed_min, 66 + 12 + 30) // 61 -> 66, 7 -> 12, plus the call
  assert.equal(p.you_ms, 68 * MIN)
  assert.equal(p.adjust_min, 30)
  assert.equal(s.total.billed_min, 108)
})

test('the same time summed from two machines bills the same as it would from one', () => {
  const day = (m) => ({ '2026-10-05': { jobsnearme: { you_ms: m * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } } })
  const together = sheetFor([{ device: 'mac', days: day(20) }, { device: 'bld', days: day(25) }], '2026-10-05')
  const one = sheetFor([{ device: 'mac', days: day(45) }], '2026-10-05')
  assert.equal(together.projects.jobsnearme.billed_min, one.projects.jobsnearme.billed_min)
  assert.deepEqual(together.devices.sort(), ['bld', 'mac'])
})

test('a week sheet leaves out days outside the week and adjustments dated outside it', () => {
  const mac = { device: 'mac', days: { '2026-10-04': { a: { you_ms: 6 * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } }, '2026-10-05': { a: { you_ms: 12 * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } } }, adjustments: [{ id: 'z', date: '2026-10-04', project: 'a', min: 60, note: '' }] }
  const s = sheetFor([mac], '2026-10-05')
  assert.equal(s.projects.a.billed_min, 12)
})

test('adjustments parse: a duration, a project, an optional date, a note; sizes round up to 6 minutes', () => {
  const now = at(7, 12)
  assert.deepEqual(parseAdjustment('jobsnearme 1.5h client call', now), { ok: true, project: 'jobsnearme', date: '2026-10-07', min: 90, note: 'client call' })
  assert.deepEqual(parseAdjustment('ourPlace 20m 2026-10-05 testing on my phone', now), { ok: true, project: 'ourPlace', date: '2026-10-05', min: 24, note: 'testing on my phone' })
  assert.deepEqual(parseAdjustment('ourPlace -30m took a break', now), { ok: true, project: 'ourPlace', date: '2026-10-07', min: -30, note: 'took a break' })
  for (const bad of ['', 'jobsnearme', 'jobsnearme soon call', 'jobsnearme 0m nothing', 'jobsnearme 1h 2026-13-45 x', 'jobsnearme 30h too much']) {
    assert.equal(parseAdjustment(bad, now).ok, false, bad)
  }
})

test('the sheet prints three columns and the hours to bill, and flags a client whose Claude time runs 5x yours', () => {
  const mac = { device: 'mac', days: { '2026-10-05': { jobsnearme: { you_ms: 60 * MIN, claude_ms: 6 * 60 * MIN, claude_wall_ms: 0, scheduled_ms: 0 }, ourPlace: { you_ms: 30 * MIN, claude_ms: 60 * MIN, claude_wall_ms: 0, scheduled_ms: 0 } } }, adjustments: [{ id: 'a', date: '2026-10-05', project: 'ourPlace', min: 30, note: 'call' }] }
  const text = formatSheet(sheetFor([mac], '2026-10-05'))
  assert.match(text, /yours\s+Claude\s+adjust\s+bill/)
  assert.match(text, /jobsnearme\s+1h 00m\s+6h 00m\s+·\s+1\.0 h/)
  assert.match(text, /ourPlace\s+30m\s+1h 00m\s+\+30m\s+1\.0 h/)
  assert.match(text, /jobsnearme: Claude ran 6\.0x your time/)
  assert.doesNotMatch(text, /ourPlace: Claude ran/)
  assert.match(text, /not confirmed/)
})

test('confirming: a week that is not over cannot be confirmed; a machine that is stale or missing blocks it unless the owner says anyway; a change since is shown', () => {
  const day = { '2026-09-29': { a: { you_ms: 30 * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } } }
  const mac = { device: 'mac', updated_at: at(5, 1), days: day }
  const bld = { device: 'bld', updated_at: at(1, 1), days: {} }
  assert.equal(confirmCheck([mac], '2026-09-28', at(2, 12)).ok, false) // Friday: the week is still running
  const alone = confirmCheck([mac], '2026-09-28', at(5, 12))
  assert.equal(alone.ok, true)
  assert.equal(alone.record.billed_min.a, 30)
  // bld wrote its file before the week ended; pc has notes this week but no file here at all (RV-005 F5)
  const roster = [{ device: 'pc', dates: ['2026-09-30', '2026-10-02'] }, { device: 'old', dates: ['2026-09-01'] }, { device: 'mac', dates: ['2026-10-04'] }, { device: 'later', dates: ['2026-10-20'] }]
  const blocked = confirmCheck([mac, bld], '2026-09-28', at(5, 12), { roster })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.missing.sort(), ['bld', 'pc']) // 'old' and 'later' had no notes this week (RV-007 F5)
  assert.match(blocked.reason, /anyway/)
  assert.equal(confirmCheck([mac, bld], '2026-09-28', at(5, 12), { roster, force: true }).ok, true)
  const after = sheetFor([{ ...mac, confirmed: { '2026-09-28': { at: at(5, 12), billed_min: { a: 30 } } } }], '2026-09-28')
  assert.equal(after.confirmed.changed.length, 0)
  const grown = sheetFor([{ ...mac, days: { '2026-09-29': { a: { you_ms: 40 * MIN, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 } } }, confirmed: { '2026-09-28': { at: at(5, 12), billed_min: { a: 30 } } } }], '2026-09-28')
  assert.deepEqual(grown.confirmed.changed, [{ project: 'a', was: 30, now: 42 }])
  assert.match(formatSheet(grown), /changed since you confirmed/)
})

test('RV-005 F6: a project called __proto__ is refused, and in synced data it pollutes nothing', () => {
  assert.equal(parseAdjustment('__proto__ 1h x', at(7, 12)).ok, false)
  const evil = JSON.parse('{"device":"x","days":{"2026-10-05":{"__proto__":{"you_ms":60000},"real":{"you_ms":60000}}},"adjustments":[{"id":"q","date":"2026-10-05","project":"__proto__","min":60}]}')
  const s = sheetFor([evil], '2026-10-05')
  assert.equal({}.adjust_min, undefined)
  assert.equal({}.days, undefined)
  assert.deepEqual(Object.keys(s.projects), ['real'])
  assert.equal(dayTotals([rec({ project: '__proto__', beats: [[at(5, 9), MIN]] })], '2026-10-05').adjust_min, undefined)
  assert.equal({}.you_ms, undefined)
})

test('the sheet\'s footer does not promise more than one machine\'s clock', () => {
  const text = formatSheet(sheetFor([{ device: 'mac', days: {} }], '2026-10-05'))
  assert.match(text, /never counted twice on one machine/)
})

test('RV-007 F5: a retired machine\'s old file does not block every week from then on', () => {
  const mac = { device: 'mac', updated_at: at(5, 1), days: {} }
  const retired = { device: 'laptop', updated_at: new Date(2026, 5, 1).toISOString(), days: {} } // months before the week
  assert.equal(confirmCheck([mac, retired], '2026-09-28', at(5, 12), { roster: [] }).ok, true)
  // ...but the same old file with notes from that machine in the week does
  assert.equal(confirmCheck([mac, retired], '2026-09-28', at(5, 12), { roster: [{ device: 'laptop', dates: ['2026-09-30'] }] }).ok, false)
})

test('RV-007 F6: project names that are Object properties (constructor, toString) are ordinary names', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const a = parseAdjustment(name + ' 1h call', at(7, 12))
    assert.equal(a.ok, true, name)
    const file = { device: 'mac', days: { '2026-10-07': { [name]: { you_ms: 7 * MIN, claude_ms: MIN, claude_wall_ms: MIN, scheduled_ms: 0 } } }, adjustments: [{ id: 'z', date: '2026-10-07', project: name, min: a.min, note: '' }] }
    const s = sheetFor([file], '2026-10-05')
    assert.equal(s.projects[name].billed_min, 12 + 60, name)
    assert.equal(s.total.billed_min, 72, name)
    const day = dayTotals([rec({ project: name, beats: [[at(7, 9), 9 * MIN]] })], '2026-10-07')
    assert.equal(day[name].you_ms, 9 * MIN, name)
    assert.equal(updateMachine(file, { device: 'mac', now: at(7, 18), records: [rec({ project: name, beats: [[at(7, 9), 9 * MIN]] })] }).days['2026-10-07'][name].you_ms, 9 * MIN, name)
    formatSheet(s)
  }
})

test('RV-007 F6: a number in synced data that is not a number counts as nothing, not NaN', () => {
  const file = { device: 'x', days: { '2026-10-05': { a: { you_ms: 'lots', claude_ms: null } } }, adjustments: [{ id: 'q', date: '2026-10-05', project: 'a', min: 'x' }] }
  const s = sheetFor([file], '2026-10-05')
  assert.equal(s.projects.a.billed_min, 0)
  assert.equal(Number.isNaN(s.total.billed_min), false)
})

test('RV-008 F4 and RV-009 F2/F3: a file is valid only if its whole v1 shape is, and the rest of the code survives a bad one anyway', () => {
  const ok = { v: 1, device: 'mac', updated_at: '2026-10-07T10:00:00.000Z', days: { '2026-10-07': { work: { you_ms: 1, claude_ms: 2, claude_wall_ms: 2, scheduled_ms: 0 } } }, adjustments: [{ id: 'a', date: '2026-10-07', project: 'work', min: 6, note: '' }], confirmed: { '2026-09-28': { at: '2026-10-05T09:00:00.000Z', device: 'mac', billed_min: { work: 6 } } } }
  assert.equal(validSheet(ok), true)
  assert.equal(validSheet({ v: 1, device: 'mac', updated_at: ok.updated_at, days: {} }), true) // adjustments and confirmed may be absent
  const bads = [null, [], 'x', {}, { ...ok, v: 2 }, { ...ok, v: undefined }, { ...ok, updated_at: 'invalid' }, { ...ok, updated_at: undefined }, { ...ok, device: '' }, { ...ok, days: [] },
    { ...ok, days: { 'last tuesday': { work: {} } } }, { ...ok, days: { '2026-10-07': { work: null } } }, { ...ok, days: { '2026-10-07': [] } }, { ...ok, days: { '2026-10-07': { work: { you_ms: 'lots' } } } },
    { ...ok, adjustments: {} }, { ...ok, adjustments: [null] }, { ...ok, adjustments: [{ id: 'a', date: '2026-10-07', project: 'work' }] }, { ...ok, adjustments: [{ id: 'a', date: 'x', project: 'work', min: 6 }] },
    { ...ok, confirmed: [] }, { ...ok, confirmed: { '2026-09-28': null } }, { ...ok, confirmed: { '2026-09-28': { at: 'x', billed_min: {} } } }, { ...ok, confirmed: { '2026-09-28': { at: ok.updated_at } } }]
  for (const bad of bads) assert.equal(validSheet(bad), false, JSON.stringify(bad))
  // Handed one anyway, nothing throws
  const broken = { device: 'x', days: { '2026-10-05': { a: null } }, adjustments: {}, confirmed: { '2026-09-28': null } }
  sheetFor([broken], '2026-09-28')
  sheetFor([broken], '2026-10-05')
  assert.deepEqual(updateMachine(broken, { device: 'x', now: at(5, 12), records: [] }).adjustments, [])
})

test('RV-009 F3: fields a v1 file carries beyond the ones this code knows are kept when it rewrites the file', () => {
  const next = updateMachine({ v: 1, device: 'mac', days: {}, adjustments: [], confirmed: {}, invoice_metadata: { client: 'x' } }, { device: 'mac', now: at(7, 12), records: [] })
  assert.deepEqual(next.invoice_metadata, { client: 'x' })
})

test('RV-008 F3: a machine whose file could not be read blocks the confirm like a missing one', () => {
  const mac = { device: 'mac', updated_at: at(5, 1), days: {} }
  const c = confirmCheck([mac], '2026-09-28', at(5, 12), { unreadable: ['pc'] })
  assert.equal(c.ok, false)
  assert.deepEqual(c.missing, ['pc'])
  assert.match(c.reason, /pc/)
  assert.match(c.reason, /could not be read/)
  assert.equal(confirmCheck([mac], '2026-09-28', at(5, 12), { unreadable: ['pc'], force: true }).ok, true)
})
