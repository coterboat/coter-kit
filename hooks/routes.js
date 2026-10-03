// coter-kit: the route log. A 'route' note records where a piece of work was sent and why
// (docs/routing.md has the options); a later 'route' note that resolves it records the outcome.
// /routes lists them, newest first, so the playbook can be checked against what happened.

import { clip } from './util.js'

const day = (ms) => {
  const d = new Date(ms)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function formatRoutes(entries, { project, all = false, limit = 20 } = {}) {
  const routes = entries.filter((e) => e.kind === 'route' && e.status !== 'rejected' && (all || !e.project || e.project === project))
  // An outcome replaces its decision; a decision has no `replaces`
  const outcomeOf = new Map(routes.filter((e) => e.replaces).map((e) => [e.replaces, e]))
  const decisions = routes.filter((e) => !e.replaces).sort((a, b) => b.at - a.at).slice(0, limit)
  if (!decisions.length) {
    return 'No routes recorded' + (all ? '' : ' in ' + (project || 'this project')) + ' yet. Claude records one whenever it picks where a piece of work runs.' + (all ? '' : ' /routes all shows every project.')
  }
  const lines = ['Routes (' + (all ? 'every project' : project) + '): ' + decisions.length + (all ? '' : ' · /routes all for every project')]
  for (const d of decisions) {
    lines.push(day(d.at) + ' ' + (d.where || '?') + (all && d.project ? ' · ' + d.project : '') + ': ' + clip(d.text, 220))
    const o = outcomeOf.get(d.id)
    lines.push(o ? '  → ' + day(o.at) + ': ' + clip(o.text, 260) : '  → open')
  }
  return lines.join('\n')
}
