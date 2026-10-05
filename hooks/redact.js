// Keeps credentials out of anything coter-kit writes: notes, waiting links, the reviewer's verdicts.
// Its own module so brain.js and waiting.js can both use it without importing each other.

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[a-f0-9]{32,}\b/gi,
  // A labelled value that looks like a credential (6+ characters with a digit), so prose
  // such as "the token budget" is left alone
  /((?:password|passwd|pwd|\bpw|secret|token|api[_ -]?key)\s*(?:is\s+|=\s*|:\s*)?)(?=\S*\d)\S{6,}/gi,
  // An ntfy topic in a link: anyone who has it can read the pushes (phone.js)
  /(\bntfy\.[a-z0-9.-]+\/)[A-Za-z0-9_-]{16,}/gi,
]

// Values this machine knows are secret wherever they appear, such as its phone topic
const KNOWN = new Set()
export function alsoRedact(value) {
  if (typeof value === 'string' && value.trim().length >= 8) KNOWN.add(value.trim())
}

// Keeps credentials out of the brain, whatever Claude or the digest wrote
export function redact(text) {
  let out = String(text)
  for (const known of KNOWN) out = out.split(known).join('[redacted]')
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) => (typeof prefix === 'string' && match.startsWith(prefix) ? prefix + '[redacted]' : '[redacted]'))
  }
  return out
}
