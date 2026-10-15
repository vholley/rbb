export const meta = {
  name: 'settle-differences',
  description: 'RBB: record the requester\'s verdicts on the differences a check found (accept as an amendment, dispute before an independent judge, or rework), and run the rework rounds',
  whenToUse: 'Started by the rbb:check skill after a check with differences; not for direct use.',
  phases: [
    { title: 'Facts', detail: 'the check, the verdicts so far and the approved spec, relayed and verified' },
    { title: 'Judge', detail: 'an independent judge upholds or withdraws each disputed finding' },
    { title: 'Amend', detail: 'accepted differences frozen in the spec index, like an approval' },
    { title: 'Record', detail: 'verdicts.json, check.json and the review written and read back' },
    { title: 'Rework', detail: 'the builder sent back with the differences, then the check again, bounded' },
  ],
}
// Args: {change, verdicts: [{difference: n, verdict: accept|dispute|rework, words}], until_clean}.
// With no verdicts it lists the open differences and changes nothing (architecture 8.2).

// <pure> -- deterministic functions only; unit-tested by tests/check/unit.mjs with no model.

// <lib:spec> copied from src/lib/spec.js by tools/sync-lib.mjs; edit the source, not this copy
// The goal and spec formats (docs/spec-format.md) and their validation. Pure functions only.
// Workflow scripts cannot import, so this file is copied into a marked region of each workflow
// that needs it by tools/sync-lib.mjs; tests/check/unit.mjs fails if any copy differs.

const SPEC_V = 1
// A: an amendment, a difference the check found that the requester accepted (architecture 8.2).
const ID = { E: /^E\d+$/, C: /^C\d+$/, O: /^O\d+$/, X: /^X\d+$/, D: /^D\d+$/, P: /^P\d+$/, A: /^A\d+$/ }
const DECIDED_BY = ['requester', 'model']
const BASES = ["requester's answer", 'goal', 'constraint', 'project convention', 'smallest change']

// Documents mode (architecture 9.1): committed (default) or none, from .rbb/config.json.
const documentsMode = config => (config && config.documents === 'none' ? 'none' : 'committed')
// In mode none, .rbb/.gitignore ignores every file in .rbb/, itself included, so nothing is committed.
const NONE_GITIGNORE = '*\n'
// Mode none freezes the approved spec by git's blob id of each of its files, kept in approval.json.
function approvalProblems(a, change) {
  if (!a || a.v !== 1) return ['approval.json: expected {"v": 1, ...}']
  const errs = []
  if (a.change !== change) errs.push(`approval.json: change is ${a.change}, expected ${change}`)
  // The hashed files are the spec's files as its manifest named them when it was approved: always
  // spec.json, and the parts that existed then (advocate.json came later).
  const files = a.hashes && typeof a.hashes === 'object' ? Object.keys(a.hashes) : []
  if (!files.includes('spec.json') || files.some(f => !SPEC_FILES.includes(f) || !/^[0-9a-f]{40}$/.test(a.hashes[f] || ''))) errs.push(`approval.json: hashes must give the git blob id of spec.json and of each file it names, among ${SPEC_FILES.join(', ')}`)
  if (!/^[0-9a-f]{40}$/.test(a.base || '')) errs.push('approval.json: base must be a commit id')
  return errs
}
// The spec files an approval froze, in their fixed order: what to hash again to compare.
const hashedFiles = approval => SPEC_FILES.filter(f => approval && approval.hashes && f in approval.hashes)
// What counts as an alternative, for every agent that records a decision.
const REAL_ALTERNATIVE = 'each option a competent developer could defensibly have taken instead: one that still meets the goal, every constraint and every example. An option that would break any of them is not an alternative, nor is the plain opposite of the choice unless doing nothing is itself defensible. If the only reason against it is that it would be wrong, broken or inaccurate, it was never a real option: leave it out. Give why it was not taken: a trade-off, not a defect. Empty when there is none'
const CHANGES = ['edit', 'add', 'new file', 'delete']

const isStr = v => typeof v === 'string' && v.trim().length > 0

// The goal half, shared by a goal and a spec: the outcome, its examples, constraints, exclusions
// and agreed extras. Appends to errs; returns the item ids it found.
function goalItems(o, errs) {
  const list = (k, re, fields) => {
    if (!Array.isArray(o[k])) { errs.push(`${k}: must be a list`); return [] }
    o[k].forEach((it, n) => {
      if (!it || !re.test(it.id || '')) errs.push(`${k}[${n}]: bad id ${it && it.id}`)
      for (const f of fields) if (!isStr(it && it[f])) errs.push(`${k}[${n}] ${it && it.id}: missing ${f}`)
    })
    return o[k].map(it => it && it.id)
  }
  if (!isStr(o.goal)) errs.push('goal: missing')
  const ids = [
    ...list('done_when', ID.E, ['text']),
    ...list('constraints', ID.C, ['text']),
    ...list('out_of_scope', ID.O, ['text']),
    // Agreed extras are optional: specs written before they existed stay valid.
    ...(o.agreed_extras === undefined ? [] : list('agreed_extras', ID.X, ['text', 'why'])),
  ]
  if (Array.isArray(o.done_when) && o.done_when.length === 0) errs.push('done_when: at least one example')
  return ids
}

// A shaped goal, before any code is explored: what the requester approves first.
// questions holds what only the requester can answer; a goal is ready only when it is empty.
function validateGoal(g) {
  if (!g || typeof g !== 'object') return ['goal: not an object']
  const errs = []
  if (g.v !== SPEC_V) errs.push(`v: expected ${SPEC_V}`)
  if (!isStr(g.title)) errs.push('title: missing')
  if (!isStr(g.source_request)) errs.push('source_request: missing')
  // The reading (one sentence saying how the request is taken) came later: goals without one still read.
  if (g.reading !== undefined && !isStr(g.reading)) errs.push('reading: must be one sentence')
  const ids = goalItems(g, errs)
  // Other goals found in the same request, each to be shaped as its own change. Optional.
  if (g.split_off !== undefined && !(Array.isArray(g.split_off) && g.split_off.every(x => isStr(x && x.goal)))) errs.push('split_off: must be a list of {goal}')
  // The requester's answers, verbatim, in the order given (architecture 5.1.5). Optional.
  if (g.answers !== undefined && !(Array.isArray(g.answers) && g.answers.every(a => a && isStr(a.question) && typeof a.answer === 'string'))) errs.push('answers: must be a list of {question, answer}')
  if (!Array.isArray(g.questions)) errs.push('questions: must be a list (empty when nothing is open)')
  else g.questions.forEach((q, n) => { if (!isStr(q && q.question)) errs.push(`questions[${n}]: missing question`) })
  if (Array.isArray(g.questions)) errs.push(...questionProblems(g.questions, true))
  const dup = ids.filter((x, n) => ids.indexOf(x) !== n)
  if (dup.length) errs.push(`duplicate ids: ${[...new Set(dup)].join(', ')}`)
  return errs
}

// A question to the requester carries the real answers (options, each with what it would mean for
// the change), the recommended one, why (in terms of the request), and what the answer changes
// elsewhere: a recommendation acts as a default, and the reason is what lets a person see a wrong
// one. Goals written before the options existed hold only question and recommendation; they stay
// valid (lenient) but a new draft must have the full shape (strict).
function questionProblems(questions, lenient = false) {
  const errs = []
  ;(questions || []).forEach((q, n) => {
    const at = `questions[${n}]`
    if (!q) return
    if (q.options === undefined) { if (!lenient) errs.push(`${at}: options missing; list the real answers, each with what it means`); return }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !o || !isStr(o.option) || !isStr(o.means))) errs.push(`${at}: options must list at least two {option, means}`)
    else if (!q.options.some(o => o.option === q.recommendation)) errs.push(`${at}: recommendation must be one of the options, word for word`)
    if (!isStr(q.because)) errs.push(`${at}: because missing; say why the recommended option, in terms of the request`)
    if (typeof q.affects !== 'string') errs.push(`${at}: affects must be a string (empty when the answer changes nothing else)`)
  })
  return errs
}

function goalReady(g) {
  return validateGoal(g).length === 0 && g.questions.length === 0
}

function validateSpec(spec, change) {
  if (!spec || typeof spec !== 'object') return ['spec: not an object']
  const errs = []
  if (spec.v !== SPEC_V) errs.push(`v: expected ${SPEC_V}`)
  if (spec.change !== change) errs.push(`change: expected ${change}, found ${spec.change}`)
  if (spec.reading !== undefined && !isStr(spec.reading)) errs.push('reading: must be one sentence')
  if (!/^[0-9a-f]{7,40}$/.test(spec.base || '')) errs.push('base: must be a commit id')
  const ids = goalItems(spec, errs)
  if (!Array.isArray(spec.decisions)) errs.push('decisions: must be a list')
  else spec.decisions.forEach((d, n) => {
    if (!d || !ID.D.test(d.id || '')) errs.push(`decisions[${n}]: bad id ${d && d.id}`)
    for (const f of ['choice', 'because']) if (!isStr(d && d[f])) errs.push(`decisions[${n}] ${d && d.id}: missing ${f}`)
    if (!d) return
    ids.push(d.id)
    // Who decided is optional until the specify workflow stamps it; when present it must be well formed.
    const w = d.decided_by
    if (w !== undefined) {
      if (!w || !DECIDED_BY.includes(w.by)) errs.push(`${d.id}: decided_by.by must be one of ${DECIDED_BY.join(', ')}`)
      else if (w.by === 'model' && !isStr(w.model)) errs.push(`${d.id}: decided_by.model is required when a model decided`)
      if (w && w.basis !== undefined && !BASES.includes(w.basis)) errs.push(`${d.id}: decided_by.basis must be one of ${BASES.join(', ')}`)
    }
    if (d.related !== undefined && !(Array.isArray(d.related) && d.related.every(r => ID.D.test(r || '')))) errs.push(`${d.id}: related must list decision ids`)
    if (d.alternatives !== undefined && !(Array.isArray(d.alternatives) && d.alternatives.every(a => a && isStr(a.option) && typeof a.why_not === 'string'))) errs.push(`${d.id}: alternatives must list {option, why_not}`)
  })
  if (!spec.plan || !Array.isArray(spec.plan.steps) || spec.plan.steps.length === 0) errs.push('plan.steps: at least one step')
  else spec.plan.steps.forEach((s, n) => {
    if (!ID.P.test(s.id || '')) errs.push(`plan.steps[${n}]: bad id`)
    if (!isStr(s.does)) errs.push(`${s.id}: missing does`)
    if (!Array.isArray(s.serves) || s.serves.some(x => !ids.includes(x))) errs.push(`${s.id}: serves must name existing items`)
    if (!Array.isArray(s.locations) || s.locations.length === 0) errs.push(`${s.id}: at least one location`)
    else s.locations.forEach((l, k) => {
      if (!isStr(l.file)) errs.push(`${s.id}.locations[${k}]: missing file`)
      if (!CHANGES.includes(l.change)) errs.push(`${s.id}.locations[${k}]: change must be one of ${CHANGES.join(', ')}`)
      const needsLines = l.change === 'edit' || l.change === 'add'
      if (needsLines && !(l.lines && Number.isInteger(l.lines.start) && Number.isInteger(l.lines.end) && l.lines.start >= 0 && l.lines.end >= l.lines.start)) errs.push(`${s.id}.locations[${k}]: lines {start,end} required for ${l.change}`)
    })
  })
  const all = ids.concat((spec.plan && spec.plan.steps || []).map(s => s.id))
  const dup = all.filter((x, n) => all.indexOf(x) !== n)
  if (dup.length) errs.push(`duplicate ids: ${[...new Set(dup)].join(', ')}`)
  return errs
}

// Pages are generated by code, never written by a model (architecture 5.2). They are for people,
// so they never show ID codes: an item is referred to by its kind and its visible number,
// such as "example 3", and listed under its heading with that number.
const KIND = { E: ['example', 'examples'], C: ['constraint', 'constraints'], O: ['exclusion', 'exclusions'], X: ['agreed extra', 'agreed extras'], D: ['decision', 'decisions'], P: ['step', 'steps'], A: ['amendment', 'amendments'] }
const num = id => Number(String(id).slice(1))

// "Examples 1–5; constraint 2; decision 6": grouped by kind, consecutive numbers as ranges.
function refs(ids) {
  const out = []
  for (const k of Object.keys(KIND)) {
    const ns = [...new Set(ids.filter(id => String(id)[0] === k).map(num))].sort((a, b) => a - b)
    if (!ns.length) continue
    const spans = []
    for (const n of ns) {
      const last = spans[spans.length - 1]
      if (last && n === last[1] + 1) last[1] = n
      else spans.push([n, n])
    }
    const text = spans.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a}, ${b}` : `${a}–${b}`)).join(', ')
    out.push(`${KIND[k][ns.length > 1 ? 1 : 0]} ${text}`)
  }
  const joined = out.join('; ')
  return joined ? joined[0].toUpperCase() + joined.slice(1) : ''
}

const oneLine = v => String(v === undefined || v === null ? '' : v).replace(/\n+/g, ' ')
const cell = v => oneLine(v).replace(/\|/g, '\\|')
function table(headers, rows) {
  return rows.length ? [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n') : 'None.'
}
// A numbered list whose numbers are the items' own, so "example 3" is the line numbered 3.
function items(list, withWhy) {
  return list.length ? list.map(i => `${num(i.id)}. ${oneLine(i.text)}${withWhy && i.why ? ` *Why: ${oneLine(i.why)}*` : ''}`).join('\n') : 'None.'
}

// The request as written: a plain quoted section, last on the page, readable in any markdown viewer.
// Its heading is fixed so the reading-length check can leave it out, as is the Examined list's.
const REQUEST_HEADING = '## The request as written'
// Settled decisions (architecture 5.1.4 and 5.1.5): the decisions with no credible alternative and the
// implementation decisions, one line each, in a section of their own outside the counted prose. The
// judgment calls alone are what the requester must read before approving.
const SETTLED_HEADING = '## Settled decisions'
// The reading: one sentence saying how the request is taken, first on the page, so that a wrong one
// is the first thing the requester sees and rejects.
const READING_HEADING = '## How the request is read'
const EXAMINED_HEADING = '## Examined'
const FOLLOW_UPS_HEADING = '## Found along the way, not part of this change'
const IMPACT_HEADING = '## What the change touches'
const REPRODUCTION_HEADING = '## Reproduction'
const bullets = (list, f = x => oneLine(x)) => (list && list.length ? list.map(x => `- ${f(x)}`).join('\n') : 'None.')

// The prose a person must read before approving, for the reading-length limit (the old RBB's rule:
// not counting code, tables, the alternatives considered or the Examined list). Left out: the
// reference sections (what the change touches, what was examined, the request as written), tables,
// and sub-bullets (evidence, alternatives considered, who decided).
function readingText(page) {
  // Left out too (architecture 5.1.5): what the scout found for the reviewer, which approval does not turn on.
  const skip = new Set([IMPACT_HEADING, EXAMINED_HEADING, REQUEST_HEADING, SETTLED_HEADING, REPRODUCTION_HEADING, REVIEW_FOCUS_HEADING, FOLLOW_UPS_HEADING])
  const out = []
  let skipping = false
  for (const line of String(page).split('\n')) {
    if (/^## /.test(line)) skipping = skip.has(line.trim())
    if (skipping || /^\s+- /.test(line) || /^\|/.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

// The scout's findings as sections of the spec page (and the review): what was observed, what the
// change touches, defects found along the way, and what was examined. Each returns '' when the
// spec has no such finding, so older specs render as before.
function reproductionSection(s) {
  const r = s.reproduction
  if (!r) return ''
  return `## Reproduction\n\n- **Outcome:** ${oneLine(r.outcome)}.\n- **Observed:** ${oneLine(r.observed)}\n- **Cause:** ${oneLine(r.cause)}${r.evidence && r.evidence.length ? `\n- **Evidence:**\n${r.evidence.map(e => `  - ${oneLine(e)}`).join('\n')}` : ''}`
}
function impactSection(s) {
  const i = s.impact
  if (!i) return ''
  const code = (i.code || []).map(c => `${c.file}${c.lines ? `, lines ${c.lines.start}–${c.lines.end}` : ''}${c.symbol ? ` (${c.symbol})` : ''}`)
  return `## What the change touches\n\n- **Code to change:** ${code.length ? code.join('; ') : 'none named'}\n- **Callers and dependents:** ${(i.callers || []).length ? i.callers.map(oneLine).join('; ') : 'none found'}\n- **Tests that cover it:** ${(i.tests_covering || []).length ? i.tests_covering.map(oneLine).join('; ') : 'none found'}\n- **Tests that assert the behaviour being changed:** ${(i.tests_asserting_changed_behaviour || []).length ? i.tests_asserting_changed_behaviour.map(oneLine).join('; ') : 'none'}\n- **Docs and config that describe it:** ${(i.docs_and_config || []).length ? i.docs_and_config.map(oneLine).join('; ') : 'none found'}`
}
function followUpsSection(s) {
  const f = s.follow_ups
  if (!f || !f.length) return ''
  return `${FOLLOW_UPS_HEADING}\n\nDefects the scout found off the path to the goal, each at the bar (wrong results, data loss, security, a crash on a reachable path, or a blocker). Nothing here is built or fixed by this change.\n\n${f.map(x => `- ${oneLine(x.text)}${x.evidence ? `\n  - Evidence: ${oneLine(x.evidence)}` : ''}`).join('\n')}`
}
// Ways the change could fail that no example exercises (the old RBB's Review focus): short facts a
// reader should know before looking at the code, each one checkable, none advice.
const REVIEW_FOCUS_HEADING = '## What no example exercises'
function reviewFocusSection(s) {
  const r = s.review_focus
  if (!r || !r.length) return ''
  return `${REVIEW_FOCUS_HEADING}\n\nWays the change could fail that none of the examples would catch, as the scout saw them. You should know these before reading the change.\n\n${bullets(r)}`
}
function examinedSection(s) {
  const e = s.examined
  if (!e) return ''
  return `${EXAMINED_HEADING}\n\nFiles read:\n\n${bullets(e.read, x => `\`${oneLine(x)}\``)}\n\nCommands run:\n\n${bullets(e.ran, x => `\`${oneLine(x)}\``)}`
}
// Amendments (architecture 8.2): differences the check found that the requester accepted, in their
// words, frozen like the approval. Each names the difference it answers, as the review stated it.
const AMENDMENTS_HEADING = '## Amendments'
function amendmentsSection(s) {
  const a = (s.amendments || []).filter(x => x && typeof x === 'object' && x.text)
  if (!a.length) return ''
  return `${AMENDMENTS_HEADING}\n\nAccepted by the requester after the check, and frozen like the approval: each is part of what the change must do, and a change that does what it says is asked for.\n\n${a.map(x => `${num(x.id)}. ${oneLine(x.text)}${x.from && x.from.text ? `\n   - Answers this difference the check found: ${oneLine(x.from.text)}` : ''}${x.round ? `\n   - Accepted after check round ${x.round}.` : ''}`).join('\n')}`
}
// The request, quoted, and every answer the requester gave, verbatim (architecture 5.1.5): the
// record of their words, which the items above restate. Outside the counted prose.
function requestSection(text, answers) {
  const quoted = String(text).split('\n').map(l => `> ${l}`.trimEnd()).join('\n')
  const given = (answers || []).filter(a => a && a.question)
  return `${REQUEST_HEADING}\n\n${quoted}${given.length ? `\n\nAnswers given, as written:\n\n${given.map(a => `- **${oneLine(a.question)}**\n  ${String(a.answer).split('\n').map(l => `> ${l}`.trimEnd()).join('\n  ')}`).join('\n')}` : ''}`
}

// Every item id this goal or spec defines.
function specIds(o) {
  const lists = [o.done_when, o.constraints, o.out_of_scope, o.agreed_extras, o.amendments, o.decisions, o.plan && o.plan.steps]
  return new Set(lists.filter(Array.isArray).flat().filter(Boolean).map(i => i.id))
}

// Text a model wrote that cites one of this goal's or spec's own items by its code. Used only to
// ask the writer to rephrase (once); text is never rewritten by code, because the same token can
// legitimately mean something else (an error code, a cell, a version). Only codes this goal or
// spec defines are looked for. Returns [{ where, code }].
function codeMentions(o, ids) {
  const found = []
  const scan = (where, text) => {
    for (const m of String(text || '').matchAll(/\b[ECOXDPA]\d+\b/g)) if (ids.has(m[0])) found.push({ where, code: m[0] })
  }
  for (const k of ['goal', 'title']) scan(k, o[k])
  for (const k of ['done_when', 'constraints', 'out_of_scope', 'agreed_extras']) for (const i of o[k] || []) { scan(`${k} ${i.id}`, i.text); scan(`${k} ${i.id}`, i.why) }
  for (const d of o.decisions || []) {
    for (const f of ['choice', 'because', 'instead_of', 'would_change_if']) scan(`decision ${d.id}`, d[f])
    for (const a of d.alternatives || []) { scan(`decision ${d.id}`, a.option); scan(`decision ${d.id}`, a.why_not) }
  }
  if (o.plan) { scan('plan approach', o.plan.approach); for (const p of o.plan.steps || []) scan(`step ${p.id}`, p.does) }
  for (const q of o.questions || []) { for (const f of ['question', 'recommendation', 'because', 'affects']) scan('question', q[f]); for (const op of q.options || []) { scan('question', op.option); scan('question', op.means) } }
  return found
}
function mentionProblems(o) {
  return codeMentions(o, specIds(o)).map(m => `${m.where} cites ${m.code} by its code; refer to it in words, such as "the first example"`)
}

// One open question on the goal page: the options with what each means, the recommended one with
// its reason, and what the answer changes elsewhere. A question from before options existed shows
// its recommendation alone.
function questionLines(q, n) {
  const lines = [`${n}. ${oneLine(q.question)}`]
  if (Array.isArray(q.options) && q.options.length) {
    for (const o of q.options) lines.push(`   - ${o.option === q.recommendation ? '**Recommended:** ' : ''}${oneLine(o.option)}: ${oneLine(o.means)}`)
    if (q.because) lines.push(`   - Why the recommendation: ${oneLine(q.because)}`)
    if (q.affects) lines.push(`   - What the answer changes elsewhere: ${oneLine(q.affects)}`)
  } else if (q.recommendation) lines.push(`   - Recommended: ${oneLine(q.recommendation)}`)
  return lines.join('\n')
}

// The goal as a page for the requester.
function goalPage(g) {
  const parts = [
    `# ${g.title}`,
    ...(g.reading ? [`${READING_HEADING}\n\n${oneLine(g.reading)}`] : []),
    `## Goal\n\n${g.goal}`,
    `## Done when\n\n${items(g.done_when)}`,
    `## Constraints\n\n${items(g.constraints)}`,
    `## Out of scope\n\n${items(g.out_of_scope)}`,
  ]
  if (g.agreed_extras && g.agreed_extras.length) parts.push(`## Agreed extras\n\n${items(g.agreed_extras, true)}`)
  if (g.split_off && g.split_off.length) parts.push(`## Split off\n\nThe request also holds these goals. Each becomes its own change, shaped separately.\n\n${g.split_off.map(x => `- ${x.goal}`).join('\n')}`)
  if (g.questions && g.questions.length) parts.push(`## Open questions\n\n${g.questions.map((q, n) => questionLines(q, n + 1)).join('\n')}`)
  parts.push(requestSection(g.source_request, g.answers))
  return parts.join('\n\n') + '\n'
}

// The independent review of alternatives (architecture 5.1.3). Each alternative is named by
// position: "2.1" is the first alternative of the second decision given.
function altIds(decisions) {
  return decisions.flatMap((d, i) => (d.alternatives || []).map((_, j) => `${i + 1}.${j + 1}`))
}

// The two levels of a decision (architecture 5.1.4): a judgment call's alternatives differ in what the
// requester can observe or in what the goal commits to; an implementation decision's differ only in
// where code lives, a name, a default no example exercises, how a test is arranged, or the order of
// steps. Only judgment calls count against the cap, and only they are the requester's to settle.
const LEVELS = ['judgment call', 'implementation']
const LEVEL_RULE = 'A judgment call is a decision whose alternatives differ in what the requester can observe or in what the goal commits to: behaviour, scope, the kind or wording of an error, what is documented, whether a test asserting the old behaviour changes, how a result is shaped. An implementation decision is one whose alternatives differ only in where code lives, what a thing is named, a default no example exercises, how a test is sampled or arranged, or the order of steps. A decision the goal itself delegates to the project\'s conventions is an implementation decision whatever its alternatives.'
// The decisions a review's ids belong to, 1-based, each once, in order.
const altDecisions = ids => [...new Set(ids.map(id => Number(String(id).split('.')[0])))]
function ALT_REVIEW_SCHEMA(ids) {
  const ds = altDecisions(ids)
  return { type: 'object', properties: {
    verdicts: { type: 'array', minItems: ids.length, maxItems: ids.length, items: { type: 'object', properties: {
      id: { type: 'string', enum: ids }, keep: { type: 'boolean', description: 'true only for a real alternative' }, why: { type: 'string', description: 'one line' },
    }, required: ['id', 'keep', 'why'] } },
    levels: { type: 'array', minItems: ds.length, maxItems: ds.length, description: 'one per decision that has alternatives, judged from the goal alone', items: { type: 'object', properties: {
      decision: { type: 'integer', enum: ds }, level: { type: 'string', enum: LEVELS }, why: { type: 'string', description: 'one line: what the alternatives change for the requester, or that they change nothing the requester could observe' },
    }, required: ['decision', 'level', 'why'] } },
  }, required: ['verdicts', 'levels'] }
}

// The reviewer sees what the change must achieve, and each choice with its alternatives, but not
// the decider's reasons for the choice or its conversation.
function altReviewPrompt(goal, decisions) {
  const list = decisions.map((d, i) => (d.alternatives || []).length
    ? `Decision ${i + 1}: ${oneLine(d.choice)}\n${d.alternatives.map((a, j) => `  ${i + 1}.${j + 1}: ${oneLine(a.option)}. ${a.raised_by === 'advocate' ? `Raised by an independent advocate, whose case is: ${oneLine(a.case)}` : `Not taken because: ${oneLine(a.why_not)}`}`).join('\n')}`
    : '').filter(Boolean).join('\n\n')
  const must = JSON.stringify({ goal: goal.goal, done_when: goal.done_when, constraints: goal.constraints, out_of_scope: goal.out_of_scope }, null, 2)
  return `Another agent made the decisions below for a code change and listed, for each, the alternatives it considered and why it did not take them. Judge each alternative on its own: keep it only if it is ${REAL_ALTERNATIVE.replace(/^each /, 'an ').replace(/\. Give why[\s\S]*$/, '.')}

Drop it if it would break the goal, a constraint or an example; if it is only the opposite of the choice and doing nothing is not defensible; or if the reason given against it is a defect (it would be wrong, broken, inaccurate, or fail) rather than a trade-off a reasonable developer could weigh the other way. Do not judge the choice itself, and add no alternative of your own. Answer for every id, once.

Then judge each decision's level, from the goal alone and whatever the decider called it. ${LEVEL_RULE} Give one line saying what the kept alternatives would change for the requester, or that they change nothing the requester could observe.

What the change must achieve:
${must}

The decisions and their alternatives:
${list}`
}

function altReviewProblems(ids, answer) {
  const seen = (answer && answer.verdicts || []).map(v => v.id)
  const missing = ids.filter(id => !seen.includes(id))
  const twice = seen.filter((id, n) => seen.indexOf(id) !== n)
  const ds = altDecisions(ids)
  const levelled = ((answer && answer.levels) || []).map(l => l.decision)
  const noLevel = ds.filter(d => !levelled.includes(d))
  const twoLevels = levelled.filter((d, n) => levelled.indexOf(d) !== n)
  return [...missing.map(id => `no verdict for ${id}`), ...[...new Set(twice)].map(id => `more than one verdict for ${id}`), ...noLevel.map(d => `no level for decision ${d}`), ...[...new Set(twoLevels)].map(d => `more than one level for decision ${d}`)]
}

// Keeps the alternatives the reviewer kept; the rest move to dropped_alternatives with the reason,
// for audit. A decision that has a "sure" flag (the scout's) and loses every alternative is sure.
// With no answer, the alternatives stay as given and say they were not reviewed.
function applyAltReview(decisions, answer, run) {
  const by = new Map(((answer && answer.verdicts) || []).map(v => [v.id, v]))
  const who = run ? { model: run.model, effort: run.effort, ...(run.alias ? { alias: true } : {}) } : null
  return decisions.map((d, i) => {
    const alts = d.alternatives || []
    if (!alts.length) return d
    if (!answer) return { ...d, alternatives_reviewed: false }
    const verdict = (a, j) => by.get(`${i + 1}.${j + 1}`)
    const kept = alts.filter((a, j) => !verdict(a, j) || verdict(a, j).keep)
    const dropped = alts.map((a, j) => [a, verdict(a, j)]).filter(([, v]) => v && !v.keep).map(([a, v]) => ({ ...a, dropped_because: v.why }))
    // The reviewer's level, judged from the goal alone, stands over the decider's (architecture 5.1.4).
    const lv = ((answer && answer.levels) || []).find(l => l.decision === i + 1)
    return { ...d, alternatives: kept, ...(dropped.length ? { dropped_alternatives: dropped } : {}), ...(d.sure !== undefined ? { sure: d.sure || kept.length === 0 } : {}), ...(lv ? { level: lv.level, level_by: 'reviewer', level_because: lv.why } : {}), alternatives_reviewed_by: who }
  })
}

// The scout's findings as later steps use them. The scout saves its own answer (scout.json); what
// code adds is kept apart in scout-meta.json, which holds no reasoning: the base commit, the model
// and effort that ran the scout, and which alternatives the independent review kept. Nothing the
// scout wrote is re-typed by another agent (architecture 5.2).
// advocate: the independent advocate's answer (advocate.json), when there is one: for each decision
// the best case for deciding otherwise, or none. A case the review kept joins the decision's
// alternatives, marked as raised by the advocate, and the decision becomes a judgment call.
function composeFindings(answer, meta, advocate = null) {
  const run = meta.run || {}
  const review = meta.review || null
  const cases = (advocate && Array.isArray(advocate.cases)) ? advocate.cases : []
  return {
    v: 1, ...answer, base: meta.base,
    decisions: answer.decisions.map((d, n) => {
      const alts = d.alternatives || []
      const keep = review && review.keep && review.keep[n]
      const kept = keep ? alts.filter((a, j) => keep[j] !== false) : alts
      const c = cases.find(x => x && x.decision === n + 1 && isStr(x.option))
      const raised = c ? [{ option: c.option, why_not: '', case: c.case, evidence: c.evidence, raised_by: 'advocate' }] : []
      const raisedKept = meta.advocate ? (meta.advocate.keep && meta.advocate.keep[n] ? raised : []) : raised
      const all = [...kept, ...raisedKept]
      // The level (architecture 5.1.4): the reviewer's verdict, recorded by code in the meta, stands over
      // the scout's own. A judgment call is a decision with a real alternative at the judgment-call
      // level; an implementation decision is settled by the scout, whatever its alternatives.
      const reviewedLevel = review && Array.isArray(review.levels) ? review.levels[n] : null
      const level = LEVELS.includes(reviewedLevel) ? reviewedLevel : LEVELS.includes(d.level) ? d.level : 'judgment call'
      return {
        // A call with no real alternative is not a judgment call, whatever the scout said; one that
        // gains an alternative, from the scout or the advocate, is a judgment call when its level is.
        id: `D${n + 1}`, choice: d.choice, because: d.because, sure: all.length === 0 || level === 'implementation',
        level, level_by: LEVELS.includes(reviewedLevel) ? 'reviewer' : 'scout', ...(d.level_because ? { level_because: d.level_because } : {}),
        alternatives: all, would_change_if: d.would_change_if,
        decided_by: { by: 'model', model: run.model, effort: run.effort, basis: d.basis, ...(run.alias ? { alias: true } : {}) },
        ...(alts.length || raised.length ? (review ? { alternatives_reviewed_by: review.by } : { alternatives_reviewed: false }) : {}),
      }
    }),
  }
}

// The advocate (architecture 5.1.3): an agent that sees the goal and the decisions' choices, never
// the decider's reasons, and argues from the code for the best way of deciding otherwise. It can
// only add alternatives; a case that meets the bar turns a settled decision into a judgment call.
const ADVOCATE = { model: 'opus', effort: 'high', alias: true }
function ADVOCATE_SCHEMA(n) {
  return { type: 'object', properties: { saved_hash: { type: 'string', description: 'the output of git hash-object on the file you saved, run after saving it: 40 hex characters' }, cases: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', properties: {
    decision: { type: 'integer', minimum: 1, maximum: n, description: 'the decision number, each once' },
    option: { type: 'string', description: 'the best other way of deciding, in a few words; empty when no other way meets the goal, every constraint and every example' },
    case: { type: 'string', description: 'why a competent developer could defensibly decide that way: the trade-off it wins, in terms of the code and the goal; empty when option is empty' },
    evidence: { type: 'string', description: 'file:line or a command and its output that the case rests on; empty when option is empty' },
  }, required: ['decision', 'option', 'case', 'evidence'] } } }, required: ['cases', 'saved_hash'] }
}
function advocatePrompt(goal, decisions) {
  const must = JSON.stringify({ goal: goal.goal, done_when: goal.done_when, constraints: goal.constraints, out_of_scope: goal.out_of_scope }, null, 2)
  return `Another agent explored this repository and made the decisions below for a change. You see what the change must achieve and what was decided, not why. For each decision, argue from the code for the best way of deciding otherwise: ${REAL_ALTERNATIVE.replace(/^each /, 'an ').replace(/\. Give why[\s\S]*$/, '.')} Read the code the decision concerns before you answer. Give one case per decision, or none when every other way would break the goal, a constraint or an example, or would only be wrong, broken or inaccurate. Do not judge the choice made, and do not repeat it as its own alternative.

Every case you raise is put to the requester as a judgment call, and a change may carry only a few. So raise a case only where deciding otherwise changes what the requester gets: the behaviour, the public interface, what users read in documentation or the changelog, or what is tested and so protected. How the code is arranged, named or placed, which existing test a check goes into, or an equivalent way of writing the same computation is the builder's business: never a case, however defensible. When in doubt, none.

What the change must achieve:
${must}

The decisions:
${decisions.map((d, i) => `${i + 1}. ${oneLine(d.choice)}`).join('\n')}`
}
function advocateProblems(n, answer) {
  const seen = ((answer && answer.cases) || []).map(c => c && c.decision)
  const errs = []
  for (let i = 1; i <= n; i++) if (!seen.includes(i)) errs.push(`no case or none for decision ${i}`)
  for (const c of (answer && answer.cases) || []) if (c && isStr(c.option) && !isStr(c.case)) errs.push(`decision ${c.decision}: an option needs its case`)
  return errs
}

// Two JSON values equal whatever their key order or formatting.
function sameJson(a, b) {
  const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v)
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

// The full spec, assembled in memory: the goal, the findings and the plan, as their authors saved them.
function buildSpec(change, goal, findings, plan) {
  const spec = {
    v: 1, change, base: findings.base, title: goal.title, goal: goal.goal,
    done_when: goal.done_when, constraints: goal.constraints, out_of_scope: goal.out_of_scope,
    decisions: findings.decisions.map(d => ({ ...d, judgment: !d.sure })),
    plan: {
      approach: plan.approach,
      steps: plan.steps.map((s, n) => ({ id: `P${n + 1}`, does: s.does, serves: s.serves, locations: s.locations.map(i => {
        const l = findings.locations[i]
        return { file: l.file, lines: l.lines, symbol: l.symbol, change: l.change }
      }) })),
    },
    source_request: goal.source_request,
    amendments: [],
  }
  if (goal.agreed_extras) spec.agreed_extras = goal.agreed_extras
  // The requester's answers, verbatim: shown under the request, outside the counted prose.
  if (goal.answers && goal.answers.length) spec.answers = goal.answers
  // What the scout found, for the person approving and the reviewer: the reproduction, the impact,
  // the project's conventions, defects found along the way, and what was examined (the old RBB's
  // Reproduction, What will be touched, Follow-ups and Examined). Older findings lack them.
  if (findings.reproduction) spec.reproduction = findings.reproduction
  if (findings.impact) {
    const { read, ran, ...impact } = findings.impact
    spec.impact = impact
    spec.examined = { read: read || [], ran: ran || [] }
  }
  if (findings.conventions) spec.conventions = findings.conventions
  if (findings.follow_ups) spec.follow_ups = findings.follow_ups
  if (findings.review_focus) spec.review_focus = findings.review_focus
  return spec
}

// The spec is spread over files, each saved once by its author (architecture 5.2.1): the goal, the
// scout's findings and what code added to them, and the planner's plan. spec.json is only a manifest
// naming them; every reader rebuilds the full spec in memory, so nothing an agent wrote is re-typed.
const SPEC_PARTS = ['goal.json', 'scout.json', 'scout-meta.json', 'plan.json', 'advocate.json', 'spec-index.json']
const SPEC_FILES = ['spec.json', ...SPEC_PARTS]
const specManifest = (change, base, title) => ({ v: 2, change, base, title, parts: SPEC_PARTS })

// The index (architecture 5.2.2): the structure every later stage needs from the spec, built by code
// from the authors' answers while they are in memory, with no sentence of anyone's: item ids and
// kinds, decisions and whether each is sure, the plan's steps with what they serve and where they
// touch, and the blob id of each record as its author saved it. Code-made, so any agent may relay it.
const RECORD_FILES = ['goal.json', 'scout.json', 'advocate.json', 'plan.json']
function specIndex(spec, hashes) {
  const kind = id => ({ E: 'example', C: 'constraint', O: 'exclusion', X: 'agreed extra', A: 'amendment' })[String(id)[0]]
  const amendments = (spec.amendments || []).filter(a => a && typeof a === 'object' && a.id)
  const items = [...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || []), ...amendments].map(i => ({ id: i.id, kind: kind(i.id) }))
  return {
    v: 1, change: spec.change, base: spec.base, title: spec.title,
    items,
    // Statements travel; reasons stay in the records. A decision's choice and the options considered
    // say what was decided, not why; the why, the case for each option and what could change it are
    // the scout's reasoning, in scout.json and on the spec page.
    decisions: spec.decisions.map(d => ({ id: d.id, sure: !!d.sure, ...(d.level ? { level: d.level, level_by: d.level_by } : {}), choice: d.choice, alternatives: (d.alternatives || []).map(a => a.option), ...(d.decided_by ? { decided_by: d.decided_by } : {}) })),
    steps: spec.plan.steps.map(s => ({ id: s.id, does: s.does, serves: s.serves, locations: s.locations.map(l => ({ file: l.file, ...(l.lines ? { lines: l.lines } : {}), ...(l.symbol ? { symbol: l.symbol } : {}), change: l.change })) })),
    hashes: Object.fromEntries(RECORD_FILES.filter(f => hashes && /^[0-9a-f]{40}$/.test(hashes[f] || '')).map(f => [f, hashes[f]])),
    // The requester's words are requirements, not an agent's reasoning, so they travel (architecture 8.2).
    ...(amendments.length ? { amendments: amendments.map(a => ({ id: a.id, text: a.text, from: a.from || null, by: a.by || 'requester', round: a.round || null })) } : {}),
  }
}
// The index with new amendments (architecture 8.2): each gets the next A number, joins the items as kind
// amendment, and is kept in full. The index is then frozen again, like an approval.
function amendIndex(index, amendments) {
  const have = (index.amendments || []).length
  const added = amendments.map((a, n) => ({ id: `A${have + n + 1}`, text: a.text, from: a.from || null, by: a.by || 'requester', round: a.round || null }))
  return { ...index, items: [...index.items, ...added.map(a => ({ id: a.id, kind: 'amendment' }))], amendments: [...(index.amendments || []), ...added] }
}
// What a later stage checks before it trusts an index: its shape, that it is this change's, and that
// its hashes are blob ids of the record files. The records themselves are compared with git.
function indexProblems(x, change) {
  if (!x || typeof x !== 'object') return ['spec-index.json: missing or not an object']
  const errs = []
  if (x.v !== 1) errs.push('spec-index.json: expected {"v": 1, ...}')
  if (x.change !== change) errs.push(`spec-index.json: change is ${x.change}, expected ${change}`)
  if (!/^[0-9a-f]{40}$/.test(x.base || '')) errs.push('spec-index.json: base must be a commit id')
  if (!isStr(x.title)) errs.push('spec-index.json: title missing')
  for (const k of ['items', 'decisions', 'steps']) if (!Array.isArray(x[k])) errs.push(`spec-index.json: ${k} must be a list`)
  if (Array.isArray(x.steps) && !x.steps.length) errs.push('spec-index.json: at least one step')
  const h = x.hashes && typeof x.hashes === 'object' ? x.hashes : null
  if (!h || !/^[0-9a-f]{40}$/.test(h['plan.json'] || '') || !/^[0-9a-f]{40}$/.test(h['scout.json'] || '')) errs.push('spec-index.json: hashes must give the blob id of scout.json and plan.json')
  if (h) for (const f of Object.keys(h)) if (!RECORD_FILES.includes(f) || !/^[0-9a-f]{40}$/.test(h[f] || '')) errs.push(`spec-index.json: hashes.${f} is not a record file's blob id`)
  if (x.amendments !== undefined && !(Array.isArray(x.amendments) && x.amendments.every(a => a && ID.A.test(a.id || '') && isStr(a.text)))) errs.push('spec-index.json: amendments must list {id: A1..., text}')
  return errs
}
// The spec's structure as a later stage's code needs it, from the index alone: ids for the schemas,
// steps and locations for the mapping, the title for commit subjects. Every text field is absent.
function specFromIndex(x) {
  const of = k => x.items.filter(i => i.kind === k).map(i => ({ id: i.id }))
  return {
    v: 1, change: x.change, base: x.base, title: x.title,
    done_when: of('example'), constraints: of('constraint'), out_of_scope: of('exclusion'), agreed_extras: of('agreed extra'),
    amendments: of('amendment').map(i => ({ ...i, ...((x.amendments || []).find(a => a.id === i.id) || {}) })),
    decisions: x.decisions.map(d => ({ id: d.id, sure: d.sure, judgment: !d.sure, ...(d.level ? { level: d.level } : {}), ...(d.choice ? { choice: d.choice } : {}), alternatives: (d.alternatives || []).map(o => (typeof o === 'string' ? { option: o, why_not: '' } : o)), ...(d.decided_by ? { decided_by: d.decided_by } : {}) })),
    plan: { steps: x.steps.map(s => ({ id: s.id, ...(s.does ? { does: s.does } : {}), serves: s.serves, locations: s.locations })) },
  }
}
// The index with the goal's own words on its items: what the check's pages may say. The goal is the
// requester's requirements, not an agent's reasoning, so its text travels; decisions and steps stay
// ids, and a page names them by number.
function specWithGoal(index, goal) {
  const s = specFromIndex(index)
  const withText = (ids, items) => ids.map(i => { const it = (items || []).find(x => x.id === i.id) || {}; return { ...i, ...(it.text ? { text: it.text } : {}), ...(it.why ? { why: it.why } : {}) } })
  return { ...s, goal: goal.goal, ...(goal.reading ? { reading: goal.reading } : {}), source_request: goal.source_request, done_when: withText(s.done_when, goal.done_when), constraints: withText(s.constraints, goal.constraints), out_of_scope: withText(s.out_of_scope, goal.out_of_scope), agreed_extras: withText(s.agreed_extras, goal.agreed_extras) }
}

// texts: each spec file's content by name ('' when missing). A spec.json from before the manifest
// holds the whole spec and needs no other file; a manifest names the files it has (advocate.json
// came later), so a missing file is one the manifest names.
function specFromTexts(change, texts) {
  const parse = t => { try { return t && String(t).trim() ? JSON.parse(t) : null } catch (e) { return null } }
  const top = parse(texts['spec.json'])
  if (!top) return { error: 'spec.json is missing or not JSON' }
  if (!top.parts) return { spec: top }
  const missing = specFiles(top).slice(1).filter(f => !parse(texts[f]))
  if (missing.length) return { error: `these files of the spec are missing or not JSON: ${missing.join(', ')}` }
  let spec
  try {
    spec = buildSpec(change, parse(texts['goal.json']), composeFindings(parse(texts['scout.json']), parse(texts['scout-meta.json']), parse(texts['advocate.json'])), parse(texts['plan.json']))
  } catch (e) { return { error: `the files of the spec do not fit together: ${e.message}` } }
  if (spec.base !== top.base) return { error: 'spec.json names a different base commit from the findings' }
  return { spec }
}

// git hash-object, run on hashedFiles(approval) in order, prints one blob id per file: the spec
// files whose id differs from the approved one.
function changedSpecFiles(approval, hashOutput) {
  const ids = String(hashOutput || '').trim().split(/\s+/)
  return hashedFiles(approval).filter((f, n) => ids[n] !== approval.hashes[f])
}
// The spec's files as its manifest names them: spec.json and its parts (a manifest from before a
// part existed does not name it).
const specFiles = manifest => ['spec.json', ...(manifest && Array.isArray(manifest.parts) ? manifest.parts : SPEC_PARTS)]

// A decision's alternatives. Records written before the list existed hold one free-text instead_of.
const alternativesOf = d => (Array.isArray(d.alternatives) ? d.alternatives : d.instead_of ? [{ option: d.instead_of, why_not: '' }] : [])

const SETTLED_BY = { "requester's answer": "the requester's answer", goal: 'the goal', constraint: 'a constraint', 'project convention': 'project convention', 'smallest change': 'the smallest change' }

// A decision's details, the same on every page: why, the alternatives with why each was dropped,
// what could change it, and who decided, by what, and when.
function decisionLines(d, when) {
  const stop = t => { const s = oneLine(t).trim(); return !s ? '' : /[.!?]$/.test(s) ? s : `${s}.` }
  const lower = t => t.replace(/^[A-Z](?![A-Z])/, c => c.toLowerCase())
  const alts = alternativesOf(d)
  // Who made the decision and when ("Decision by"), then what settled it ("Decided by").
  const w = d.decided_by
  const actor = !w ? '' : w.by === 'requester' ? 'the requester' : `${w.model || 'a model'}${w.effort ? ` at ${w.effort} effort` : ''}${w.alias ? ' (model alias)' : ''}`
  const moment = when ? oneLine(when).replace(/^Made\s+/i, '').replace(/\.$/, '') : ''
  // On a page rendered from the index (architecture 5.2.2) the decision has its choice and its options
  // but no reason: the why is in the record its author saved, and the line says which.
  const reasons = d.because ? '' : /^B/.test(d.id || '') ? "the builder's log" : 'the spec page'
  return [
    d.because ? `- **Why:** ${stop(d.because)}` : `- **Why, and what could change this:** in ${reasons}.`,
    alts.length ? `- **Alternatives considered:**\n${alts.map(a => `  - ${a.raised_by === 'advocate' ? `${oneLine(a.option).replace(/\.$/, '')}: raised by an independent advocate, not weighed by the decider. Its case: ${stop(a.case)}${a.evidence ? ` Evidence:${stop(a.evidence)}` : ''}` : a.why_not ? `${oneLine(a.option).replace(/\.$/, '')}: not taken because ${lower(stop(a.why_not))}` : stop(a.option)}`).join('\n')}` : '',
    d.would_change_if ? `- **What could change this:** ${stop(d.would_change_if)}` : '',
    actor || moment ? `- **Decision by:** ${stop([actor, moment].filter(Boolean).join(', '))}` : '',
    w && w.basis ? `- **Decided by:** ${stop(SETTLED_BY[w.basis] || w.basis)}` : '',
  ].filter(Boolean)
}

// A page saved without its reasoning (architecture 5.2.1), when the agent saving the full page was
// refused for copying it: the record files hold the reasoning in full, and the page says so.
// Why a page carries no reasoning: a refused save (the default), or the design, which never copies
// another agent's reasoning onto the review (architecture 5.2.2).
const reasonsLeftOut = (files, why = "the agent saving it was not allowed to copy another agent's reasoning") => `*The reasons behind each decision, the alternatives considered and what could change it are left off this page: ${why}. They are in full in ${files.map(f => `\`${f}\``).join(', ')}.*`

// The spec as a page for the requester and the reviewer: what and why first, then how.
// With { reasons: false }, the decisions are one line each and the page says where the reasons are.
function specPage(s, opts = {}) {
  const where = l => `${l.file}${l.lines ? `, lines ${l.lines.start}–${l.lines.end}` : ''}${l.symbol ? ` (${l.symbol})` : ''}: ${l.change}`
  const who = d => {
    const w = d.decided_by
    if (!w) return ''
    // The same words as the full entry: who made the decision, then what decided it.
    return `decision by ${w.by === 'requester' ? 'the requester' : `${w.model || 'a model'}${w.effort ? ` at ${w.effort} effort` : ''}`}${w.basis ? `, decided by ${SETTLED_BY[w.basis] || w.basis}` : ''}`
  }
  const decision = d => [
    `### Decision ${num(d.id)}: ${oneLine(d.choice)}`,
    ...decisionLines(d, 'Made while planning.'),
    d.related && d.related.length ? `- **Related:** ${refs(d.related)}` : '',
  ].filter(Boolean).join('\n')
  const parts = [
    `# ${s.title || s.change}`,
    ...(s.reading ? [`${READING_HEADING}\n\n${oneLine(s.reading)}`] : []),
    `## Goal\n\n${s.goal}`,
    `## Done when\n\n${items(s.done_when)}`,
    `## Constraints\n\n${items(s.constraints)}`,
    `## Out of scope\n\n${items(s.out_of_scope)}`,
  ]
  if (s.agreed_extras && s.agreed_extras.length) parts.push(`## Agreed extras\n\n${items(s.agreed_extras, true)}`)
  parts.push(reproductionSection(s), impactSection(s))
  // Judgment calls first, in full: that is where the reader's attention belongs. A sure decision,
  // with no credible alternative, takes one line (the old RBB's rule).
  const calls = s.decisions.filter(d => d.judgment !== false)
  // Settled decisions: implementation decisions, whose alternatives change nothing the requester could
  // observe, go in a section of their own outside the counted prose (architecture 5.1.4); the rest had
  // no credible alternative.
  const implementation = s.decisions.filter(d => d.judgment === false && d.level === 'implementation' && (d.alternatives || []).length)
  const sure = s.decisions.filter(d => d.judgment === false && !implementation.includes(d))
  const brief = d => `- **Decision ${num(d.id)}:** ${oneLine(d.choice)}${who(d) ? ` (${who(d)})` : ''}`
  // The judgment calls are the decisions section: what the requester must read. The settled ones follow
  // in a section of their own, outside the counted prose (architecture 5.1.5).
  const decisions = [
    calls.length ? (opts.reasons === false ? `### Judgment calls\n\n${calls.map(brief).join('\n')}` : calls.map(decision).join('\n\n')) : '',
    opts.reasons === false && calls.length ? reasonsLeftOut(['scout.json', 'plan.json']) : '',
  ].filter(Boolean).join('\n\n')
  parts.push(`## Decisions\n\n${decisions || (sure.length || implementation.length ? 'No judgment call: every decision is settled, below.' : 'None.')}`)
  if (sure.length || implementation.length) {
    const settled = [
      sure.length ? `### Settled, with no credible alternative\n\n${sure.map(brief).join('\n')}` : '',
      implementation.length ? `### Implementation decisions\n\nSettled by the scout from the project's conventions and the smallest change: their alternatives change nothing you could observe. Say so at approval if one should be yours.\n\n${implementation.map(d => `${brief(d)}${(d.alternatives || []).length ? ` Instead of: ${d.alternatives.map(a => oneLine(a.option)).join('; ')}.` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    parts.push(`${SETTLED_HEADING}\n\nDecisions the scout settled, one line each. Each is recorded with its reasons in the spec's files.\n\n${settled}`)
  }
  parts.push(`## Plan\n\n${s.plan.approach || ''}\n\n${table(['Step', 'What it does', 'Serves', 'Where'], s.plan.steps.map(p => [num(p.id), p.does, refs(p.serves), p.locations.map(where).join('; ')]))}`)
  parts.push(amendmentsSection(s))
  parts.push(reviewFocusSection(s), followUpsSection(s), examinedSection(s), requestSection(s.source_request, s.answers))
  return parts.filter(Boolean).join('\n\n') + '\n'
}

// git log --format='%H %(trailers:key=RBB-Approved,valueonly,separator=%x2C)' -- <spec>
// Newest first. Each line: <sha> [<trailer values, comma-separated>]
function parseLog(text, change) {
  const commits = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const sp = l.indexOf(' ')
    const sha = sp < 0 ? l : l.slice(0, sp)
    const values = sp < 0 ? [] : l.slice(sp + 1).split(',').map(v => v.trim()).filter(Boolean)
    return { sha, approves: values.includes(change), values }
  })
  const approvals = commits.filter(c => c.approves).map(c => c.sha)
  const unapproved = commits.filter(c => !c.approves).map(c => ({ sha: c.sha, trailer: c.values.join(',') || null }))
  return { approvals, latest: approvals[0] || null, unapproved }
}

// A commit subject RBB makes: the prefix, then the title, within git's usual 72 characters,
// cut at a word boundary. It goes into a shell command inside double quotes, so characters that
// would need quoting care in bash or PowerShell are removed.
const SUBJECT_LIMIT = 72
function commitSubject(prefix, title) {
  const clean = t => String(t).replace(/["'`$\\]/g, '').replace(/\s+/g, ' ')
  // The prefix keeps its trailing space ("Approve spec: "); only the title is trimmed.
  const p = clean(prefix).replace(/^\s+/, ''), t = clean(title).trim()
  const room = SUBJECT_LIMIT - p.length
  if (t.length <= room) return p + t
  const cut = t.slice(0, room + 1).replace(/\s+\S*$/, '')
  return p + (cut || t.slice(0, room))
}
// </lib:spec>

// <lib:build> copied from src/lib/build.js by tools/sync-lib.mjs; edit the source, not this copy
// The builder's log (architecture 5.3): its schema, validation and page. Pure functions only.
// Needs the spec library (copied before this one): ID, KIND, num, refs, oneLine.

const BUILD_KINDS = ['evidence', 'decision', 'deviation', 'claim']

// The log as the builder answers it, through a schema built from the approved spec: it can cite
// only examples, steps and items that exist. In a rework (architecture 8.2), a deviation may name,
// instead of a plan step, the number of the difference it resolves.
function BUILD_SCHEMA(spec, rework = null) {
  const eIds = spec.done_when.map(i => i.id)
  const pIds = spec.plan.steps.map(p => p.id)
  const itemIds = [...eIds, ...spec.constraints.map(i => i.id), ...spec.out_of_scope.map(i => i.id), ...(spec.agreed_extras || []).map(i => i.id), ...(spec.amendments || []).map(i => i.id), ...spec.decisions.map(d => d.id)]
  const s = d => ({ type: 'string', description: d })
  const numbers = rework ? rework.differences.map(d => d.n) : []
  const deviation = rework
    ? { type: 'object', properties: { step: { type: ['string', 'null'], enum: [...pIds, null], description: 'the plan step this departs from; null when the change resolves a difference and no step concerns it' }, resolves: { type: ['integer', 'null'], enum: [...numbers, null], description: 'the number of the difference this change resolves; null for an ordinary deviation' }, planned: s('what the plan said, or what the check found'), actual: s('what was done instead'), because: s('') }, required: ['step', 'resolves', 'planned', 'actual', 'because'] }
    : { type: 'object', properties: { step: { type: 'string', enum: pIds }, planned: s('what the plan said'), actual: s('what was done instead'), because: s('') }, required: ['step', 'planned', 'actual', 'because'] }
  return { type: 'object', properties: {
    evidence: { type: 'array', items: { type: 'object', properties: { item: { type: 'string', enum: eIds }, before: s('what the example gave before the change'), after: s('what it gives after'), how: s('the command or check that showed it') }, required: ['item', 'before', 'after', 'how'] } },
    decisions: { type: 'array', items: { type: 'object', properties: { serves: { type: 'array', items: { type: 'string', enum: itemIds } }, choice: s(''), because: s(''), alternatives: { type: 'array', description: REAL_ALTERNATIVE, items: { type: 'object', properties: { option: s(''), why_not: s('') }, required: ['option', 'why_not'] } }, would_change_if: s('what would make another choice right; empty if nothing would'), basis: { type: 'string', enum: BASES, description: 'the criterion that settled it' } }, required: ['serves', 'choice', 'because', 'alternatives', 'would_change_if', 'basis'] } },
    deviations: { type: 'array', items: deviation },
    claims: { type: 'array', items: s('one thing the change does, checkable against the diff') },
  }, required: ['evidence', 'decisions', 'deviations', 'claims'] }
}

// The saved log: the builder's answer with ids and who decided stamped by code. The model and
// effort are the ones the workflow started the builder with, never the builder's own claim.
function toBuildLog(answer, run) {
  let n = 0
  const id = () => `B${++n}`
  // The model and effort are stamped by code; the basis is the builder's own answer, from a fixed list.
  const by = { by: 'model', model: run.model, effort: run.effort, ...(run.alias ? { alias: true } : {}) }
  return { v: 1, entries: [
    ...answer.evidence.map(e => ({ kind: 'evidence', ...e })),
    ...answer.decisions.map(({ basis, ...d }) => ({ kind: 'decision', id: id(), ...d, decided_by: { ...by, basis } })),
    ...answer.deviations.map(d => ({ kind: 'deviation', id: id(), ...d, decided_by: by })),
    ...answer.claims.map(t => ({ kind: 'claim', text: t })),
  ] }
}

// The builder saves its own answer (build.json); what code adds is kept apart in build-meta.json:
// the model and effort that ran it, and which alternatives the independent review kept (architecture
// 5.2.1). Readers rebuild the log in memory.
function composeBuildLog(answer, meta) {
  const log = toBuildLog(answer, (meta && meta.run) || {})
  const review = (meta && meta.review) || null
  let i = -1
  log.entries = log.entries.map(e => {
    if (e.kind !== 'decision') return e
    i++
    const alts = e.alternatives || []
    if (!alts.length) return e
    if (!review) return { ...e, alternatives_reviewed: false }
    const keep = review.keep[i] || []
    return { ...e, alternatives: alts.filter((a, j) => keep[j] !== false), alternatives_reviewed_by: review.by }
  })
  return log
}

// The log's index (architecture 5.2.2) after a rework round (architecture 8.2): the builder appended its
// entries to each list of the saved log, so the index is the prior index followed by the new answer's
// statements, numbered as the file is read: decisions B1..., deviations continuing, claims K1....
// The prior entries keep the stamps they were recorded with.
function mergeLogIndex(prior, parsedNew, run) {
  const p = prior || { evidence: [], decisions: [], deviations: [], claims: [] }
  const by = run ? { by: 'model', model: run.model, effort: run.effort, ...(run.alias ? { alias: true } : {}) } : null
  const decisions = [...p.decisions.map(d => ({ ...d })), ...parsedNew.decisions.map(d => ({ serves: d.serves || [], choice: d.choice, alternatives: (d.alternatives || []).map(a => a.option), ...(d.decided_by ? { decided_by: d.decided_by } : by ? { decided_by: by } : {}) }))]
  const deviations = [...p.deviations.map(d => ({ ...d })), ...parsedNew.deviations.map(d => ({ step: d.step, planned: d.planned, actual: d.actual, ...(Number.isInteger(d.resolves) ? { resolves: d.resolves } : {}) }))]
  let n = 0
  return {
    evidence: [...p.evidence, ...parsedNew.evidence.map(e => e.item)],
    decisions: decisions.map(d => ({ ...d, id: `B${++n}` })),
    deviations: deviations.map(d => ({ ...d, id: `B${++n}` })),
    claims: [...p.claims.map(c => (typeof c === 'string' ? { text: c } : { text: c.text })), ...parsedNew.claims.map(c => ({ text: c.text }))].map((c, k) => ({ id: `K${k + 1}`, text: c.text })),
  }
}

// The log as text, from build.json and build-meta.json; empty when there is none. A build.json from
// before the split is a log already.
function buildLogText(buildText, metaText) {
  const parse = t => { try { return t && String(t).trim() ? JSON.parse(t) : null } catch (e) { return null } }
  const b = parse(buildText)
  if (!b) return String(buildText || '').trim() ? String(buildText) : ''
  if (Array.isArray(b.entries)) return JSON.stringify(b)
  return JSON.stringify(composeBuildLog(b, parse(metaText)))
}

// The log as committed. Empty text means no log. With the spec, references are checked too:
// evidence names a real example, a deviation a real step, a decision real items.
// Claims get ids K1, K2, ... in log order so the claims judge answers by id.
function parseBuild(text, spec) {
  const empty = { entries: [], claims: [], deviations: [], decisions: [], evidence: [], errors: [] }
  if (!text.trim()) return empty
  let b
  try { b = JSON.parse(text) } catch (e) { return { ...empty, errors: [`build.json is not valid JSON: ${e.message}`] } }
  const errors = []
  if (!b || b.v !== 1 || !Array.isArray(b.entries)) return { ...empty, errors: ['build.json: expected {"v": 1, "entries": [...]}'] }
  const eIds = spec ? new Set(spec.done_when.map(i => i.id)) : null
  const pIds = spec ? new Set(spec.plan.steps.map(p => p.id)) : null
  const items = spec ? new Set([...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || []), ...(spec.amendments || []), ...spec.decisions].map(i => i.id)) : null
  // A deviation made in a rework may resolve a difference the check found instead of departing from a step.
  const resolves = e => e.step === null && Number.isInteger(e.resolves)
  b.entries.forEach((e, n) => {
    const at = `build.json entries[${n}]`
    if (!e || !BUILD_KINDS.includes(e.kind)) errors.push(`${at}: kind must be one of ${BUILD_KINDS.join(', ')}`)
    else if ((e.kind === 'decision' || e.kind === 'deviation') && !/^B\d+$/.test(e.id || '')) errors.push(`${at}: a ${e.kind} needs an id B1, B2, ...`)
    else if (e.kind === 'claim' && !(typeof e.text === 'string' && e.text.trim())) errors.push(`${at}: a claim needs text`)
    else if (spec && e.kind === 'evidence' && !eIds.has(e.item)) errors.push(`${at}: evidence for ${e.item}, which is not an example of the spec`)
    else if (spec && e.kind === 'deviation' && !pIds.has(e.step) && !resolves(e)) errors.push(`${at}: a deviation from ${e.step}, which is not a step of the plan`)
    else if (spec && e.kind === 'decision' && Array.isArray(e.serves) && e.serves.some(x => !items.has(x))) errors.push(`${at}: a decision serving an item the spec does not have`)
  })
  const bIds = b.entries.filter(e => e && e.id).map(e => e.id)
  const dup = bIds.filter((x, n) => bIds.indexOf(x) !== n)
  if (dup.length) errors.push(`build.json: duplicate ids ${[...new Set(dup)].join(', ')}`)
  const ok = b.entries.filter(e => e && BUILD_KINDS.includes(e.kind))
  return {
    entries: ok,
    claims: ok.filter(e => e.kind === 'claim').map((e, n) => ({ id: `K${n + 1}`, text: e.text })),
    deviations: ok.filter(e => e.kind === 'deviation'),
    decisions: ok.filter(e => e.kind === 'decision'),
    evidence: ok.filter(e => e.kind === 'evidence'),
    errors,
  }
}

// The log as a page for people: examples, steps and decisions named in words, never by code.
function buildPage(log, spec) {
  const b = parseBuild(JSON.stringify(log), spec)
  const parts = ['# Build log']
  parts.push(`## Evidence for each example\n\n${b.evidence.length ? b.evidence.map(e => `- **Example ${num(e.item)}.** Before: ${oneLine(e.before)}. After: ${oneLine(e.after)}. Shown by: ${oneLine(e.how)}`).join('\n') : 'None recorded.'}`)
  parts.push(`## Decisions made while building\n\n${b.decisions.length ? b.decisions.map((d, n) => [`### Build decision ${n + 1}: ${oneLine(d.choice)}`, d.serves && d.serves.length ? `- **Serves:** ${refs(d.serves)}` : '', ...decisionLines(d, 'Made while building.')].filter(Boolean).join('\n')).join('\n\n') : 'None.'}`)
  parts.push(`## Deviations from the plan\n\n${b.deviations.length ? b.deviations.map(d => `- **${d.step ? `Step ${num(d.step)}` : `Difference ${d.resolves} of the check, resolved`}.** Planned: ${oneLine(d.planned)}. Done instead: ${oneLine(d.actual)}. Because: ${oneLine(d.because)}`).join('\n') : 'None.'}`)
  parts.push(`## What the builder says the change does\n\nThese are the builder's own claims; the check verifies each against the change.\n\n${b.claims.length ? b.claims.map(c => `- ${oneLine(c.text)}`).join('\n') : 'None.'}`)
  return parts.join('\n\n') + '\n'
}
// </lib:build>

// <lib:review> copied from src/lib/review.js by tools/sync-lib.mjs; edit the source, not this copy
// The review (architecture section 8): information for a person reading the change alongside the
// code. It presents; it never tells the reader how to review. Sections: the goal, what changed and
// where, warnings (every difference from the approved spec, in a table), and the important or
// questionable decisions in full. Generated by code from the spec, the build log and the check.
// Never shows ID codes, and never refers to something by a number defined elsewhere.
// Needs the spec and build libraries.

// The key of a difference across checks (architecture 8.2): its kind, the item, step, claim or entry it
// names, and the base-commit locations of its hunks, which a rework elsewhere leaves unchanged. A
// verdict recorded under a key applies to the same difference when a later check finds it again.
function differenceKey(e, hunks) {
  const where = (e.hunks || []).map(id => { const h = (hunks || []).find(x => x.id === id); return h ? h.where : id }).sort()
  return [e.kind, e.item || e.step || e.claim || e.entry || '', ...where].join('|')
}

// The rows of the review's warnings table and what they are built from, shared by the page and by
// the one-line statements of each difference.
function reviewRows(spec, log, check) {
  const hunks = new Map((check.hunks || []).map(h => [h.id, h]))
  const units = check.units || []
  const unitOfHunk = new Map(units.flatMap(u => u.hunks.map(h => [h, u])))
  // The builder's log, or, when the page is rendered from the check alone (architecture 5.2.2), the
  // log's index the check carries: each decision's choice and options, each deviation's planned and
  // actual, each claim's text, with ids. The reasons are in the log and the page says so.
  const fromIndex = x => ({
    decisions: ((x && x.decisions) || []).map(d => ({ kind: 'decision', id: d.id, choice: d.choice, serves: d.serves || [], alternatives: (d.alternatives || []).map(o => (typeof o === 'string' ? { option: o, why_not: '' } : o)), ...(d.decided_by ? { decided_by: d.decided_by } : {}) })),
    deviations: ((x && x.deviations) || []).map(d => ({ kind: 'deviation', id: d.id, step: d.step, planned: d.planned, actual: d.actual, ...(Number.isInteger(d.resolves) ? { resolves: d.resolves } : {}) })),
    claims: ((x && x.claims) || []).map(c => (typeof c === 'string' ? { id: c } : { id: c.id, text: c.text })),
  })
  const b = log ? parseBuild(JSON.stringify(log), spec) : fromIndex(check.build)
  const sentence = t => { const s = oneLine(t).trim(); return !s ? '' : /[.!?]$/.test(s) ? s : `${s}.` }

  // Where a hunk is, as lines of the changed code; a pure removal says where it was removed.
  const at = id => {
    const h = hunks.get(id)
    if (!h) return ''
    if (h.new_start === undefined || h.new_start === null) return h.where
    if (h.new_len === 0) return `${h.file}: lines removed after line ${h.new_start}`
    return h.new_len === 1 ? `${h.file}, line ${h.new_start}` : `${h.file}, lines ${h.new_start}–${h.new_start + h.new_len - 1}`
  }
  const where = ids => ids.map(at).filter(Boolean).join('; ')
  // What the hunks add or remove, from the check's short preview of each.
  const shows = ids => ids.map(id => (hunks.get(id) || {}).preview).filter(Boolean).map(sentence).join(' ')

  // An item of the spec, by its own words.
  const all = [...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || []), ...(spec.amendments || [])]
  const words = id => {
    const d = spec.decisions.find(x => x.id === id)
    // A decision's words are the scout's; when the page has only the index, it names the decision by number.
    if (d) return d.choice ? `the decision to ${oneLine(d.choice).replace(/^[A-Z]/, c => c.toLowerCase())}` : `decision ${num(d.id)} of the spec`
    const i = all.find(x => x.id === id)
    return i ? `"${oneLine(i.text)}"` : ''
  }
  const asked = ids => (ids && ids.length ? ids.map(words).filter(Boolean).join('; ') : 'Nothing in the spec asks for this.')
  // Where the plan meant to change a file: its symbols and lines, not the whole step.
  const planned = file => {
    const locs = spec.plan.steps.flatMap(p => p.locations.filter(l => l.file === file))
    return locs.length
      ? `Changes planned only at ${locs.map(l => `${l.symbol ? `${l.symbol}, ` : ''}${l.lines ? `lines ${l.lines.start}–${l.lines.end}` : 'the whole file'}`).join('; ')} (lines before the change).`
      : `The plan changes nothing in ${file}.`
  }
  // A dispute the judge upheld (architecture 8.2) stays a difference; the row says so, with both sides.
  const upheld = e => (e.disputed && e.disputed.outcome === 'upheld' ? ` The requester disputed it: "${oneLine(e.disputed.words)}" An independent judge upheld it: ${sentence(e.disputed.why)}` : '')

  // One row per difference: Item | Location | Reason | What was requested | What the outcome was.
  const row = e => {
    const cells = (() => {
      switch (e.kind) {
        case 'unrequested': {
          const u = units.find(x => x.id === e.unit)
          return e.extras && e.extras.length
            ? ['Change not asked for, inside a requested change', where(e.hunks), 'No example, constraint, agreed extra or approved decision asks for it.', e.near ? words(e.near) : asked(u && u.serves), [e.extras.map(x => sentence(typeof x === 'string' ? x : x.text)).join(' '), 'near' in e ? shows(e.hunks) : ''].filter(Boolean).join(' ')]
            : ['Change not asked for', where(e.hunks), e.excluded_by ? `It does what ${words(e.excluded_by)} excludes.` : (u && u.serves || []).some(x => x[0] === 'O') ? 'It does something the spec names as out of scope.' : 'No example, constraint, agreed extra or approved decision asks for it.', asked(u && u.serves), sentence(u && u.summary)]
        }
        case 'unexplained_deviation': {
          const h = hunks.get(e.hunks[0]); const u = unitOfHunk.get(e.hunks[0])
          return ['Changed outside the plan', where(e.hunks), 'No plan step names this place, and the builder logged no reason.', planned(h ? h.file : ''), shows(e.hunks) || sentence(u && u.summary)]
        }
        case 'item_missing': case 'item_partial': case 'item_contradicts': case 'item_needs_a_person': {
          const i = (check.items || []).find(x => x.id === e.item)
          const label = { item_missing: 'Example not met', item_partial: 'Example only partly met', item_contradicts: 'Example contradicted', item_needs_a_person: 'Example the change alone cannot show' }[e.kind]
          return [label, where((i && i.units || []).flatMap(uid => (units.find(x => x.id === uid) || { hunks: [] }).hunks)) || 'No change serves it.', sentence(i && i.note), words(e.item), label]
        }
        case 'constraint_violated': {
          const c = (check.constraints || []).find(x => x.id === e.item)
          return ['Constraint broken', '', sentence(c && c.note), words(e.item), sentence(c && c.note)]
        }
        case 'step_not_done': {
          const s = ((check.plan && check.plan.steps) || []).find(x => x.id === e.step)
          const p = spec.plan.steps.find(x => x.id === e.step)
          return ['Plan step not done', p ? p.locations.map(l => `${l.file}${l.lines ? `, lines ${l.lines.start}–${l.lines.end} (before the change)` : ''}`).join('; ') : '', sentence(s && s.note), p && p.does ? sentence(p.does) : p ? `Step ${num(p.id)} of the plan, in spec.md.` : '', 'Not done.']
        }
        case 'unsupported_claim': {
          const c = (check.claims || []).find(x => x.id === e.claim || x.text === e.claim)
          return ["The builder's claim is contradicted", '', sentence(c && c.evidence), '', /^K\d+$/.test(e.claim) ? `Claim ${num(e.claim)} in build.json.` : `The builder said: "${oneLine(e.claim)}"`]
        }
        case 'decision_conflict': {
          const d = b.decisions.find(x => x.id === e.entry)
          return ['A build decision goes against the spec', '', sentence(e.reason), words(e.conflicts_with), d ? sentence(d.choice) : '']
        }
        case 'spec_integrity': return ['The approved spec was changed without approval', '', sentence(e.detail), 'The spec as approved.', 'Changed by a later commit.']
        default: return [e.kind, '', '', '', '']
      }
    })()
    cells[2] = `${cells[2]}${upheld(e)}`.trim()
    return cells
  }

  // A change outside the plan that the builder explained is not an exception, but it is still a
  // difference from the approved plan: it is shown with the builder's own reason.
  const cap = t => (/^[a-z]+[\s,:;]/.test(t) ? t.replace(/^[a-z]/, x => x.toUpperCase()) : t) // a file or code name keeps its case
  const logged = id => [...b.deviations, ...b.decisions].find(x => x.id === id)
  // A departure a constraint of the goal covers is not a difference (architecture 7), so it has no row.
  const explainedRows = ((check.plan && check.plan.unplanned_hunks) || []).filter(u => u.explained_by && !u.covered_by).map(u => {
    const h = hunks.get(u.hunk); const l = logged(u.explained_by); const u2 = unitOfHunk.get(u.hunk)
    const resolved = l && l.kind === 'deviation' && Number.isInteger(l.resolves) ? `Made in a rework to resolve a difference the check found. ` : ''
    const reason = !l ? 'The builder logged a reason.' : l.kind === 'deviation' && !l.because ? `${resolved}The builder deviated from the plan: planned ${cap(sentence(l.planned))} Done instead: ${cap(sentence(l.actual))} Its reason is in the build log.` : l.kind === 'deviation' ? `${resolved}The builder's logged reason: ${cap(sentence(l.because))}` : `The builder's logged decision: ${cap(sentence(l.choice))} ${cap(sentence(l.because))}`
    return ['Changed outside the plan, with a reason', at(u.hunk), reason, planned(h ? h.file : ''), shows([u.hunk]) || sentence(u2 && u2.summary)]
  })

  // A difference settled by a verdict (architecture 8.2): its row, the verdict and the words behind it.
  const settledRows = (check.settled || []).map(s => {
    const [item, loc] = row(s.difference)
    const v = s.verdict || {}
    const verdict = v.kind === 'accept' ? 'Accepted by the requester as an amendment' : v.kind === 'dispute' ? 'Withdrawn by an independent judge after the requester disputed it' : v.kind
    const because = v.kind === 'accept' ? `The requester's words: "${oneLine(v.words)}"` : v.kind === 'dispute' ? `The requester's words: "${oneLine(v.words)}" The judge: ${sentence(v.why)}` : ''
    return [item, loc, verdict, `${because}${s.carried ? ' Settled at an earlier check round and found again.' : ''}`.trim()]
  })

  return { row, explainedRows, settledRows, at, where, words, sentence, b, hunks, units }
}

// Each difference as one line for a person: what it is, where, the reason and the outcome. These are
// the lines the check skill shows when it asks for a verdict, and what verdicts.json records as the
// statement of the difference each verdict answers (architecture 8.2).
function differenceLines(spec, check) {
  const { row } = reviewRows(spec, null, check)
  return (check.exceptions || []).map((e, n) => {
    const [item, where, reason, asked, outcome] = row(e)
    const parts = [`${item}${where ? `, at ${where}` : ''}.`, reason, outcome && outcome !== item ? outcome : '', asked && asked !== 'Nothing in the spec asks for this.' ? `Requested: ${asked}` : '']
    return { n: n + 1, kind: e.kind, key: differenceKey(e, check.hunks), text: parts.filter(Boolean).join(' ') }
  })
}

// With { reasons: false }, the decisions are one line each and the page says where the reasons are.
function reviewPage(spec, log, check, opts = {}) {
  const { row, explainedRows, settledRows, where, sentence, b, units } = reviewRows(spec, log, check)

  const parts = [`# Review: ${spec.title || spec.change}`, `## Goal\n\n${spec.goal}`]
  // What the requester accepted after a check (architecture 8.2), frozen like the approval.
  if (spec.amendments && spec.amendments.some(a => a && a.text)) parts.push(amendmentsSection(spec))

  // What changed, each change once, with where it is in the changed code.
  parts.push(`## What changed\n\n${units.length ? units.map(u => `- ${sentence(u.summary || 'A change')} *${where(u.hunks)}*`).join('\n') : 'Nothing.'}`)
  // What the scout saw that no example exercises, and the defects it found off the path, which this
  // change leaves alone: the reviewer should know both before reading on.
  if (spec.review_focus && spec.review_focus.length) parts.push(reviewFocusSection(spec))
  if (spec.follow_ups && spec.follow_ups.length) parts.push(followUpsSection(spec))

  // Warnings: the summary, how complete the check was, then every difference.
  const n = (check.exceptions || []).length + explainedRows.length
  const total = (check.hunks || []).length
  const files = new Set((check.hunks || []).map(h => h.file)).size
  const settled = settledRows.length
  const summary = check.verdict === 'error'
    ? `**The check could not complete:** ${check.error ? sentence(check.error.reason) : 'reason unknown.'} Nothing below has been checked.`
    : n === 0
      ? settled ? `**No open differences from the approved spec.** ${settled === 1 ? 'One difference was' : `${settled} differences were`} settled by a verdict, below.` : '**No differences from the approved spec were found.**'
      : `**${n} difference${n === 1 ? '' : 's'} from the approved spec.**${settled ? ` ${settled === 1 ? 'One more was' : `${settled} more were`} settled by a verdict, below.` : ''}`
  const coverage = check.verdict === 'error' ? '' : `All ${total} changed place${total === 1 ? '' : 's'}, in ${files} file${files === 1 ? '' : 's'}, were checked against the spec; none was left unaccounted for. The check judges what the change does, not whether the code is correct beyond the examples.`
  // Rework rounds (architecture 8.2): how many times the builder was sent back, and what each resolved.
  // Each resolved difference by its item and place: the first sentence of its statement.
  const head = t => oneLine(t).split(/\.(\s|$)/)[0]
  const rounds = check.rounds && check.rounds.count > 1 ? `Reworked ${check.rounds.count - 1} time${check.rounds.count === 2 ? '' : 's'} after a check. ${(check.rounds.rework || []).map(r => `Round ${r.round} resolved: ${(r.resolves || []).map(d => head(d.text)).join('; ') || 'nothing named'}.`).join(' ')}` : ''
  const warnings = [summary, coverage, rounds]
  if (n) warnings.push(table(['Item', 'Location', 'Reason', 'What was requested', 'What the outcome was'], [...(check.exceptions || []).map(row), ...explainedRows]))
  if (settled) warnings.push(`**Settled.** Each difference below has a verdict: the requester accepted it as an amendment, or disputed it and an independent judge withdrew it. None is open.\n\n${table(['Item', 'Location', 'Verdict', 'Why'], settledRows)}`)
  if (check.for_a_person && check.for_a_person.length) warnings.push(`**Not verified.** The builder says the following, and the change alone cannot show it. The person who ran the build should confirm it:\n\n${check.for_a_person.map(c => `- ${/^K\d+$/.test(c.claim) ? `Claim ${num(c.claim)} in build.json.` : `"${oneLine(c.claim)}"`} ${sentence(c.why)}`).join('\n')}`)
  parts.push(`## Warnings\n\n${warnings.filter(Boolean).join('\n\n')}`)

  // Decisions: the judgment calls of the spec and the builder's own, in full.
  // A decision's words are its author's. When the page has only the index (architecture 5.2.2), it
  // names the decision by number and says which record holds it; the reader opens that file.
  const name = d => (d.choice ? sentence(d.choice) : /^B/.test(d.id) ? `Entry ${num(d.id)} of build.json.` : `Decision ${num(d.id)} of the spec, in spec.md.`)
  const decision = (d, origin) => (d.choice ? [`### ${sentence(d.choice)}`, ...decisionLines(d, origin)].join('\n') : `- ${name(d)} ${origin}`)
  const brief = (d, origin) => `- ${name(d)} ${origin}`
  // The spec's judgment calls (judgment in a full spec, sure in the index), and the builder's own.
  const calls = spec.decisions.filter(d => d.judgment !== false && d.sure !== true)
  const built = b.decisions.length ? b.decisions : ((check.build && check.build.decisions) || []).map(d => ({ id: d.id }))
  if (opts.reasons === false || built.some(d => !d.choice) || calls.some(d => !d.choice)) {
    const lines = [...calls.map(d => brief(d, 'Made while planning.')), ...built.map(d => brief(d, 'Made while building.'))]
    const indexOnly = calls.some(d => !d.choice) || built.some(d => !d.choice)
    parts.push(`## Decisions\n\nThe choices a competent developer could have made another way.\n\n${lines.length ? `${lines.join('\n')}\n\n${reasonsLeftOut(['scout.json', 'plan.json', 'build.json'], indexOnly ? "this page copies no agent's reasoning, and the spec page, which the pull request carries, has each decision in full" : undefined)}` : 'None.'}`)
  } else {
    parts.push(`## Decisions\n\nThe choices a competent developer could have made another way, with the reasoning behind each.\n\n${[...calls.map(d => decision(d, 'Made while planning.')), ...built.map(d => decision(d, 'Made while building.'))].join('\n\n') || 'None.'}`)
  }
  return parts.join('\n\n') + '\n'
}
// </lib:review>

const VERDICTS = ['accept', 'dispute', 'rework']
// Rework rounds are bounded (ADR-014): at the bound the differences come back to the person.
const REWORK_BOUND = 3

// The verdicts as the skill passes them, against the open differences: each names a difference by its
// number, once, with a verdict from the list; a dispute carries the requester's rebuttal.
function verdictProblems(verdicts, differences) {
  const errs = []
  const seen = new Set()
  if (!differences.length) errs.push('the check has no open difference to give a verdict on')
  for (const v of verdicts || []) {
    const n = v && Number(v.difference)
    if (!v || !Number.isInteger(n) || n < 1 || n > differences.length) { errs.push(`a verdict names difference ${v && v.difference}, which the check does not have (1 to ${differences.length})`); continue }
    if (seen.has(n)) errs.push(`difference ${n} has more than one verdict`)
    seen.add(n)
    if (!VERDICTS.includes(v.verdict)) errs.push(`difference ${n}: the verdict must be one of ${VERDICTS.join(', ')}`)
    if (v.verdict === 'dispute' && !(typeof v.words === 'string' && v.words.trim())) errs.push(`difference ${n}: a dispute needs the requester's words`)
  }
  return errs
}
// Each verdict with the difference it answers: its number, kind, key and statement, and the exception.
// An accept without words takes the difference's own statement as the requester's.
function decide(verdicts, differences, check) {
  return verdicts.map(v => {
    const n = Number(v.difference)
    const d = differences[n - 1]
    const words = typeof v.words === 'string' && v.words.trim() ? v.words.trim() : v.verdict === 'accept' ? d.text : ''
    return { n, verdict: v.verdict, words, key: d.key, kind: d.kind, text: d.text, exception: check.exceptions[n - 1] }
  })
}

// The verdicts record (architecture 8.2): code-made, every verdict with the requester's words, the
// difference it answers (its number in that round's check, kind, key and statement) and the round.
function verdictsRecord(prior, change, entries) {
  return { v: 1, change, verdicts: [...(prior && Array.isArray(prior.verdicts) ? prior.verdicts : []), ...entries] }
}
function verdictEntry(d, round) {
  return {
    round, difference: { n: d.n, kind: d.kind, key: d.key, text: d.text }, verdict: d.verdict, words: d.words, by: 'requester',
    ...(d.verdict === 'accept' ? { amendment: d.amendment || null } : {}),
    ...(d.verdict === 'dispute' ? { outcome: d.outcome, why: d.why, judged_by: d.judged_by || null } : {}),
    ...(d.verdict === 'rework' ? { reworked_in: d.reworked_in || null, commit: d.commit || null } : {}),
  }
}

// The check after the verdicts: an accepted difference and a withdrawn one move to settled with the
// verdict on them; an upheld dispute stays open with both sides on it; a reworked one stays open
// until the next check; the verdict is recomputed from what is open.
function applyVerdicts(check, decided, round) {
  const open = [], settled = [...(check.settled || [])]
  ;(check.exceptions || []).forEach((e, i) => {
    const d = decided.find(x => x.n === i + 1)
    if (!d) { open.push(e); return }
    if (d.verdict === 'accept') { settled.push({ difference: e, verdict: { kind: 'accept', amendment: d.amendment || null, words: d.words, by: 'requester', round } }); return }
    if (d.verdict === 'dispute' && d.outcome === 'withdrawn') { settled.push({ difference: e, verdict: { kind: 'dispute', outcome: 'withdrawn', words: d.words, why: d.why, by: d.judged_by || null, round } }); return }
    if (d.verdict === 'dispute') { open.push({ ...e, disputed: { words: d.words, outcome: 'upheld', why: d.why, by: d.judged_by || null, round } }); return }
    open.push(e)
  })
  return { ...check, exceptions: open, settled, verdict: open.length === 0 ? 'aligned' : 'exceptions' }
}

// The judge answers through a schema: upheld or withdrawn, and one line for people.
const JUDGE_SCHEMA = { type: 'object', properties: {
  outcome: { type: 'string', enum: ['upheld', 'withdrawn'] },
  why: { type: 'string', description: 'one line, shown to people: the fact in the spec or the change that decides it, named by file, line and function, or by the item of the spec in words, never by a code such as E1 or H3' },
}, required: ['outcome', 'why'] }
function judgePrompt(d, specReading, logReading, diffCmd) {
  const aboutLog = ['unexplained_deviation', 'unsupported_claim', 'decision_conflict'].includes(d.kind)
  return `A check compared this change with its approved spec and reported the difference below. The requester disputes it. Decide, from the spec and the change alone, whether the finding stands (upheld) or is wrong (withdrawn). The requester's words are a claim to test, not evidence, and so is the check's finding. Withdraw the finding only when the spec or the change shows it wrong: the change does what the spec asks at that place, or the spec as approved (its goal, examples, constraints, exclusions, agreed extras, amendments and approved decisions) asks for or allows what the finding objects to. Uphold it otherwise, including when the dispute rests on what the requester meant rather than on what the spec says. Give one line naming the fact that decides it.

The finding, as the review states it:
${d.text}

The requester's dispute, in their words:
"${d.words}"

${specReading}${aboutLog ? `\n\n${logReading}` : ''}

The change at the places the finding names: run \`${diffCmd}\` and read its output (the hunks are shown without context lines; the finding names lines of the changed code). Read the surrounding code with the Read tool where the diff alone does not settle it.`
}

// The amendment commit (architecture 8.2): the index alone, with the approval trailer, so that every
// later stage reads the amended spec from the latest approval and the records stay frozen.
function amendSubject(spec, style, round) {
  const prefix = style && style.kind === 'conventional' ? `${style.type || 'docs'}${style.scope ? `(${style.scope})` : ''}: amend spec after check ${round} for ` : `Amend spec after check ${round}: `
  return commitSubject(prefix, spec.title || spec.change)
}
function amendCommands(change, subject) {
  const file = `.rbb/${change}/spec-index.json`
  return [`git add -- ${file}`, `git commit -m "${subject}" --trailer "RBB-Approved: ${change}" -- ${file}`]
}

// </pure>

// <lib:record> copied from src/lib/record.js by tools/sync-lib.mjs; edit the source, not this copy
// Save a file from inside a workflow and verify it by reading it back (architecture 5.2).
// Workflow scripts cannot write files, so the recorder agent (Read and Write) writes, a checker agent
// reads it back through a schema, and code compares. Uses the workflow globals agent and log.

const READBACK_SCHEMA = { type: 'object', properties: { content: { type: 'string', description: 'the file content, verbatim' } }, required: ['content'] }

// Text compared line by line, ignoring only trailing spaces and trailing blank lines.
function sameText(a, b) {
  const norm = t => String(t).split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '')
  return norm(a) === norm(b)
}

// true when saved and verified; null when the agent saving it ended with an error, which is not
// retried: when the error is a safeguard refusal, Anthropic's documentation says to change the
// request rather than retry it, and refusals are billed; false when the read-back never matched.
async function recordFile(path, text, phase, same = sameText) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wrote = await agent(`Write this content to ${path}:\n\n${text}`, { label: `write ${path} (${attempt})`, phase, agentType: 'rbb:recorder', effort: 'low' })
    if (wrote === null) { log(`${path}: the agent saving it ended with an error (a safeguard refusal, or an API error); not retried`); return null }
    const back = await agent(`Read the file ${path} and return its content verbatim, without line numbers.`, { label: `read back ${path} (${attempt})`, phase, agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })
    if (back && same(back.content, text)) return true
    log(`${path}: read-back did not match (attempt ${attempt})`)
  }
  return false
}

// A page for people combines several agents' reasoning, and the agent saving it may be refused for
// copying it (architecture 5.2.1). Then the page without that reasoning is saved instead, when the
// caller gives one: 'full', 'reduced', or false when neither was saved.
async function recordPage(path, full, reduced, phase) {
  const first = await recordFile(path, full, phase)
  if (first) return 'full'
  if (first !== null || !reduced) return false
  log(`${path}: saving the page without the reasoning it carries`)
  return (await recordFile(path, reduced, phase)) ? 'reduced' : false
}

// A record an author saved itself is verified without a read-back, which would ask another agent to
// reproduce its author's reasoning (architecture 5.2.2): the author's own blob id against the id two
// relays compute, and a count of the record's items against the answer's. Prose equality is not
// proven, and the design says so. Returns {hash, now} (now: the relayed clock, seconds) or {error}.
const VERIFY_SCHEMA = { type: 'object', properties: { hash: { type: 'string', description: 'stdout of the git hash-object command, verbatim' }, count: { type: 'string', description: 'stdout of the grep command, verbatim' }, now: { type: 'string', description: 'stdout of date +%s, verbatim' } }, required: ['hash', 'count', 'now'] }
const clockOf = r => (r && /^\d{9,11}$/.test(String(r.now || '').trim()) ? Number(String(r.now).trim()) : null)
async function verifySave(path, claimed, itemPattern, expected, phase) {
  const cmd = `Run these commands in the current directory, one at a time, and return each one's standard output verbatim:\nhash: git hash-object -- ${path}\ncount: grep -o -E '${itemPattern}' ${path} | grep -c .\nnow: date +%s`
  const r = await parallel([1, 2].map(i => () => agent(cmd, { label: `verify ${path} ${i}`, phase, agentType: 'rbb:checker', effort: 'low', schema: VERIFY_SCHEMA })))
  if (!r[0] || !r[1]) return { error: `${path} could not be verified (a relay failed)` }
  const hash = r[0].hash.trim(), count = Number(r[0].count.trim())
  if (hash !== r[1].hash.trim() || count !== Number(r[1].count.trim())) return { error: `${path} could not be verified (the two relays disagreed)` }
  if (!/^[0-9a-f]{40}$/.test(hash)) return { error: `${path} was not saved` }
  const said = String(claimed || '').trim()
  if (hash !== said) return { error: `${path} is not the file its author hashed after saving (${hash.slice(0, 10)} on disk, ${said.slice(0, 10) || 'none'} claimed)` }
  if (count !== expected) return { error: `${path} holds ${count} items where the answer has ${expected}` }
  return { hash, now: clockOf(r[0]) }
}
// </lib:record>

// <lib:alternatives> copied from src/lib/alternatives.js by tools/sync-lib.mjs; edit the source, not this copy
// Run the independent review of a decision list's alternatives (architecture 5.1.3) and apply it.
// Uses the workflow global agent; needs the spec library (altIds, ALT_REVIEW_SCHEMA, altReviewPrompt,
// altReviewProblems, applyAltReview). The reviewer runs at its own fixed model and effort.

const ALT_REVIEWER = { model: 'opus', effort: 'high', alias: true }

async function reviewAlternatives(goal, decisions, phase) {
  const ids = altIds(decisions)
  if (!ids.length) return decisions
  let problems = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = altReviewPrompt(goal, decisions) + (problems.length ? `\n\nYour last answer broke these rules; fix them:\n${problems.join('\n')}` : '')
    const answer = await agent(prompt, { label: `review alternatives ${attempt}`, phase, agentType: 'rbb:checker', model: ALT_REVIEWER.model, effort: ALT_REVIEWER.effort, schema: ALT_REVIEW_SCHEMA(ids) })
    problems = answer ? altReviewProblems(ids, answer) : ['no answer']
    if (!problems.length) return applyAltReview(decisions, answer, ALT_REVIEWER)
  }
  return applyAltReview(decisions, null)
}
// </lib:alternatives>

// The judge of a dispute is the checker at the alternatives reviewer's model and effort (architecture 8.2).
const JUDGE = ALT_REVIEWER

const change = typeof args === 'string' ? args.trim().split(/\s+/)[0] : args && args.change
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(change || '')) throw new Error(`rbb:settle-differences needs a change name, got: ${change}`)
const given = args && Array.isArray(args.verdicts) ? args.verdicts : []
const untilClean = !!(args && args.until_clean)
const dir = `.rbb/${change}`
const DIFF = `git -c core.quotepath=false diff --no-renames --no-color --no-ext-diff`
const canon = s => String(s).replace(/\n+$/, '')
const parseJson = t => { try { return t && String(t).trim() ? JSON.parse(t) : null } catch (e) { return null } }

// Facts are relayed by two agents whose outputs must match (architecture 7.1), as in the check.
const RELAY = keys => ({ type: 'object', properties: { ...Object.fromEntries(keys.map(k => [k, { type: 'string', description: `stdout of the command labelled ${k}, verbatim` }])), refused: { type: 'array', items: { type: 'string', enum: keys }, description: 'labels of commands you were not allowed to run (refused, denied, or waiting for approval); empty if all ran' } }, required: [...keys, 'refused'] })
const RELAY_PROMPT = cmds => `Run these commands in the current directory, exactly as written, one at a time, and return each one's standard output verbatim under its label: every character and newline, nothing added, removed or summarised. Return standard output only: never an error message the command printed instead. If a command prints nothing to standard output, or fails, return an empty string for it. If you were not allowed to run a command (it was refused, denied, or needs approval), return an empty string for it and list its label under refused; a command that ran and exited with an error is not refused.\n\n${cmds.map(([k, c]) => `${k}: ${c}`).join('\n')}`
async function relay(label, cmds, phaseName = 'Facts') {
  if (!cmds.length) return { out: {} }
  const keys = cmds.map(([k]) => k)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [a, b] = await parallel([1, 2].map(i => () => agent(RELAY_PROMPT(cmds), { label: `${label} ${attempt}.${i}`, phase: phaseName, agentType: 'rbb:checker', effort: 'low', schema: RELAY(keys) })))
    const refused = [...new Set([...((a && a.refused) || []), ...((b && b.refused) || [])])]
    if (refused.length) return { refused: refused.map(k => cmds.find(([l]) => l === k)[1]) }
    if (a && b && keys.every(k => canon(a[k]) === canon(b[k]))) return { out: Object.fromEntries(keys.map(k => [k, canon(a[k])])) }
    log(`${label}: the two relays differ (attempt ${attempt})`)
  }
  return null
}
const refusedError = r => ({ change, error: `these read-only commands were not allowed to run; allow them and try again: ${r.refused.join(' ; ')}` })
async function readTwice(file, label, phaseName = 'Facts') {
  const [a, b] = await parallel([1, 2].map(i => () => agent(`Read the file ${file} and return its content verbatim, without line numbers. If it does not exist, return an empty string.`, { label: `${label} ${i}`, phase: phaseName, agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })))
  return a && b && canon(a.content) === canon(b.content) ? canon(a.content) : null
}
const recordJson = (path, value, phaseName) => recordFile(path, JSON.stringify(value, null, 2) + '\n', phaseName, t => { try { return sameJson(JSON.parse(t), value) } catch (e) { return false } })

phase('Facts')
// Code reads only what code made, and the goal (architecture 5.2.2): the check, the verdicts, the
// config, the manifest, the index and the goal. No record of an agent's is relayed.
const cfgText = await readTwice('.rbb/config.json', 'config')
const config = parseJson(cfgText)
const none = documentsMode(config) === 'none'
const checkText = await readTwice(`${dir}/check.json`, 'check')
if (checkText === null) return { change, error: 'the two reads of check.json never matched' }
const check = parseJson(checkText)
if (!check || !check.v) return { change, error: `${dir}/check.json is missing or not JSON; run /rbb:check first` }
if (check.verdict === 'error') return { change, error: `the last check did not complete (${check.error ? check.error.reason : 'unknown reason'}); run /rbb:check again` }
if (!/^[0-9a-f]{40}$/.test(check.head || '')) return { change, error: 'the check does not record the commit it checked; run /rbb:check again' }
const priorText = await readTwice(`${dir}/verdicts.json`, 'verdicts')
if (priorText === null) return { change, error: 'the two reads of verdicts.json never matched' }
const priorVerdicts = parseJson(priorText)

const specPaths = SPEC_FILES.map(f => `${dir}/${f}`)
const factsA = await relay('head and approvals', [
  ['head', 'git rev-parse HEAD'],
  ['status', `git status --porcelain=v1 -uall -- . ':(exclude).rbb'`],
  // Covered, as the pull-request stage judges it: the code at the checked commit is the code at HEAD;
  // commits since then may only touch .rbb (an amendment commit is one).
  ['kind', `git cat-file -t ${check.head}`],
  ['moved', `git -c core.quotepath=false diff --name-only ${check.head} HEAD -- . ':(exclude).rbb'`],
  ...(none ? [] : [['log', `git log --format='%H %(trailers:key=RBB-Approved,valueonly,separator=%x2C)' -- ${specPaths.join(' ')}`]]),
])
if (factsA && factsA.refused) return refusedError(factsA)
if (!factsA || !/^[0-9a-f]{40}$/.test(factsA.out.head)) return { change, error: 'relays of HEAD and the approval log never matched' }
const head = factsA.out.head
// The verdicts answer the check of the code as it is: a check of other code is stale.
if (factsA.out.kind.trim() !== 'commit') return { change, error: `the checked commit ${check.head.slice(0, 10)} is not in this repository; run /rbb:check again` }
if (factsA.out.moved.trim()) return { change, error: 'the code changed after the check; run /rbb:check again before giving verdicts', changed: factsA.out.moved.trim().split('\n') }
if (factsA.out.status.trim()) return { change, error: 'the working tree has changes outside .rbb; commit or stash them, and run /rbb:check again before giving verdicts', status: factsA.out.status.trim() }

// The approved spec, as the check reads it (architecture 5.2.2): the manifest, the index and the goal.
let approval = null, latest = null, specText
if (none) {
  try { approval = JSON.parse(await readTwice(`${dir}/approval.json`, 'approval')) } catch (e) { approval = null }
  if (approvalProblems(approval, change).length) return { change, error: `no valid approval for ${change}: approve the spec first`, approval_problems: approvalProblems(approval, change) }
  const hashed = await relay('spec hashes', [['hash', `git hash-object ${hashedFiles(approval).map(f => `${dir}/${f}`).join(' ')}`]])
  if (hashed && hashed.refused) return refusedError(hashed)
  if (!hashed) return { change, error: 'relays of the spec hashes never matched' }
  const changed = changedSpecFiles(approval, hashed.out.hash)
  if (changed.length) return { change, error: `the spec changed after it was approved: ${changed.join(', ')} no longer has its approved hash` }
  const texts = await parallel(['spec.json', 'spec-index.json', 'goal.json'].map(f => () => readTwice(`${dir}/${f}`, f)))
  if (texts.some(t => t === null)) return { change, error: 'the two reads of a spec file never matched' }
  specText = { 'spec.json': texts[0], 'spec-index.json': texts[1], 'goal.json': texts[2] }
} else {
  const approvals = parseLog(factsA.out.log, change)
  if (!approvals.latest) return { change, error: `no approval commit for ${change}: the spec has no commit with the trailer RBB-Approved: ${change}` }
  latest = approvals.latest
  const f = await relay('spec', ['spec.json', 'spec-index.json', 'goal.json'].map((name, n) => [`f${n}`, `git show ${latest}:${dir}/${name}`]))
  if (f && f.refused) return refusedError(f)
  if (!f) return { change, error: 'relays of the approved spec never matched' }
  specText = { 'spec.json': f.out.f0, 'spec-index.json': f.out.f1, 'goal.json': f.out.f2 }
}
const manifest = parseJson(specText['spec.json']), index = parseJson(specText['spec-index.json']), goal = parseJson(specText['goal.json'])
if (!manifest || !Array.isArray(manifest.parts) || !manifest.parts.includes('spec-index.json')) return { change, error: 'this spec was drafted before the index existed; draft and approve it again with /rbb:approve' }
if (indexProblems(index, change).length) return { change, error: 'the approved spec index does not meet its format', spec_errors: indexProblems(index, change) }
if (!goal || validateGoal(goal).length) return { change, error: 'the approved goal does not meet its format' }
const spec = specWithGoal(index, goal)
const rounds = check.rounds && check.rounds.count ? check.rounds : { count: 1, rework: [] }
// The open differences, numbered as the check's exceptions are; the lines the skill showed.
const differences = differenceLines(spec, check)
const reworkLeft = Math.max(0, REWORK_BOUND - (rounds.count - 1))
const summary = () => ({ change, verdict: check.verdict, head, rounds, differences, settled: (check.settled || []).length, rework_bound: REWORK_BOUND, rework_left: reworkLeft })
// Nothing to answer, or nothing open to rework: nothing to record.
if (!given.length && (!untilClean || !differences.length)) return summary()
const problems = verdictProblems(given, differences)
if (problems.length && given.length) return { ...summary(), error: 'the verdicts do not name the open differences', problems }
const decided = decide(given, differences, check)
const round = rounds.count

// Where the judges read the spec and the log themselves, as in the check.
const frozen = none ? `in ${dir}/ (verified unchanged)` : `frozen in commit ${latest}`
const show = f => (none ? `Read the file ${dir}/${f}` : `run \`git show ${latest}:${dir}/${f}\``)
const amendmentsNow = (spec.amendments || []).filter(a => a.text)
const specReading = `The approved spec is ${frozen}; read it yourself before judging: ${show('spec.md')} (the page the requester approved, first), then ${show('goal.json')}, ${show('scout.json')} (the findings and every decision), ${show('plan.json')} (the steps and their locations), ${show('advocate.json')} and ${show('spec-index.json')} (which holds any amendment accepted after approval, with the requester's words).${amendmentsNow.length ? `\n\nAmendments so far, which make a change asked for:\n${amendmentsNow.map(a => `${a.id}: ${a.text}`).join('\n')}` : ''}`
const logReading = `The builder's own log, as committed, is ${none ? `the file ${dir}/build.json: Read it` : `\`git show HEAD:${dir}/build.json\`: run it`} and verify it; do not trust it. Its decisions are numbered B1, B2, ... in order, its deviations continue that numbering after the last decision, and its claims are K1, K2, ... in order.`

phase('Judge')
// Each dispute goes to an independent judge, who sees the finding, the rebuttal, the records and the
// diff at the places the finding names, never the builder's conversation (ADR-005). It is never
// granted by the requester's assertion (ADR-014).
const hunkFile = id => { const h = (check.hunks || []).find(x => x.id === id); return h ? h.file : null }
const quoted = p => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)
const disputes = decided.filter(d => d.verdict === 'dispute')
for (const d of disputes) {
  const files = [...new Set((d.exception.hunks || []).map(hunkFile).filter(Boolean))]
  const diffCmd = `${DIFF} -U0 ${spec.base} HEAD -- ${files.length ? files.map(quoted).join(' ') : `. ':(exclude).rbb'`}`
  const r = await agent(judgePrompt(d, specReading, logReading, diffCmd), { label: `dispute ${d.n}`, phase: 'Judge', agentType: 'rbb:checker', model: JUDGE.model, effort: JUDGE.effort, schema: JUDGE_SCHEMA })
  if (!r || !['upheld', 'withdrawn'].includes(r.outcome)) return { change, error: `the judge of difference ${d.n} did not answer; no verdict was recorded` }
  d.outcome = r.outcome; d.why = r.why; d.judged_by = { model: JUDGE.model, effort: JUDGE.effort, ...(JUDGE.alias ? { alias: true } : {}) }
  log(`difference ${d.n}: ${r.outcome}`)
}

phase('Amend')
// An accepted difference becomes an amendment, in the requester's words, frozen like an approval
// (architecture 8.2): the index gains it, and the index alone is committed with the trailer, or
// hashed again into approval.json in mode none.
const accepts = decided.filter(d => d.verdict === 'accept')
let newIndex = index, amendCommit = null
if (accepts.length) {
  newIndex = amendIndex(index, accepts.map(d => ({ text: d.words, from: { kind: d.kind, key: d.key, text: d.text }, by: 'requester', round })))
  accepts.forEach((d, i) => { d.amendment = newIndex.amendments[newIndex.amendments.length - accepts.length + i].id })
  const saved = await recordJson(`${dir}/spec-index.json`, newIndex, 'Amend')
  if (!saved) return { change, error: 'spec-index.json with the amendments could not be saved and verified; no verdict was recorded' }
  if (none) {
    const files = hashedFiles(approval)
    const runs = await relay('amended hashes', [['hash', `git hash-object ${files.map(f => `${dir}/${f}`).join(' ')}`]], 'Amend')
    const ids = runs && runs.out ? runs.out.hash.trim().split(/\s+/) : []
    if (ids.length !== files.length || ids.some(h => !/^[0-9a-f]{40}$/.test(h))) return { change, error: 'could not compute the amended spec hashes; spec-index.json was changed and approval.json was not: approve the spec again' }
    const amended = { ...approval, hashes: Object.fromEntries(files.map((f, n) => [f, ids[n]])) }
    if (!(await recordJson(`${dir}/approval.json`, amended, 'Amend'))) return { change, error: 'approval.json could not be saved with the amended hashes; approve the spec again' }
    approval = amended
  } else {
    const subject = amendSubject(spec, config && config.commit, round)
    const cmds = amendCommands(change, subject)
    await agent(`Run these commands:\n${cmds.map((c, n) => `${n + 1}. ${c}`).join('\n')}`, { label: 'amend commit', phase: 'Amend', agentType: 'rbb:committer', effort: 'low' })
    const v = await relay('verify amendment', [['last', `git log -1 --format='%H %P %(trailers:key=RBB-Approved,valueonly)'`]], 'Amend')
    const [sha, parent, value] = v && v.out ? v.out.last.trim().split(/\s+/) : []
    if (!/^[0-9a-f]{40}$/.test(sha || '') || parent !== head || value !== change) return { change, error: 'the amendment commit was not found with its trailer; spec-index.json holds the amendments uncommitted: commit it with the trailer, or restore it', commands: cmds }
    amendCommit = sha
    latest = sha
  }
}
const amendedSpec = specWithGoal(newIndex, goal)

phase('Record')
const entries = decided.map(d => verdictEntry(d, round))
let verdicts = verdictsRecord(priorVerdicts, change, entries)
if (!(await recordJson(`${dir}/verdicts.json`, verdicts, 'Record'))) return { change, error: 'verdicts.json could not be saved and verified', amend_commit: amendCommit }
const current = applyVerdicts(check, decided, round)
if (amendCommit) current.approval = amendCommit
if (!(await recordJson(`${dir}/check.json`, current, 'Record'))) return { change, error: 'check.json could not be saved with the verdicts', amend_commit: amendCommit }
const reviewSaved = await recordPage(`${dir}/review.md`, reviewPage(amendedSpec, null, current), reviewPage(amendedSpec, null, current, { reasons: false }), 'Record')
// The open differences after the verdicts, numbered as check.json now lists them; the ones the
// requester reworks keep their statement, and their old numbers are kept beside for the answer.
const openNow = differenceLines(amendedSpec, current)
const result = {
  change, round, verdict: current.verdict, amend_commit: amendCommit,
  amendments: accepts.map(d => ({ id: d.amendment, text: d.words })),
  withdrawn: disputes.filter(d => d.outcome === 'withdrawn').map(d => ({ difference: d.n, why: d.why })),
  upheld: disputes.filter(d => d.outcome === 'upheld').map(d => ({ difference: d.n, why: d.why })),
  settled: (current.settled || []).length,
  review: `${dir}/review.md`, review_recorded: reviewSaved,
  rounds: current.rounds || rounds, differences: openNow, rework_bound: REWORK_BOUND, rework_rounds: [],
}

phase('Rework')
// The builder is sent back with the differences to resolve, each as the review states it, and the
// check runs again; with until_clean this repeats while differences remain, up to the bound.
const reworkKeys = new Set(decided.filter(x => x.verdict === 'rework').map(x => x.key))
let targets = untilClean ? openNow : openNow.filter(d => reworkKeys.has(d.key))
let roundNow = rounds.count
while (targets.length) {
  if (roundNow - 1 >= REWORK_BOUND) { result.rework_stopped = `the bound of ${REWORK_BOUND} rework rounds is reached; accept or dispute what remains, or build the change again`; break }
  const next = roundNow + 1
  let built
  try { built = await workflow('rbb:build-change', { change, rework: { round: next, differences: targets.map(d => ({ n: d.n, key: d.key, text: d.text })) } }) } catch (e) { built = { error: `the build workflow could not run inside the settle workflow: ${e.message}` } }
  if (!built || built.error || built.stopped) { result.rework_error = built ? built.error || `the builder stopped: ${built.stopped}` : 'the build workflow returned nothing'; break }
  let checked
  try { checked = await workflow('rbb:check-change', { change, mode: check.mode || 'grouped' }) } catch (e) { checked = { verdict: 'error', error: { reason: `the check workflow could not run inside the settle workflow: ${e.message}` } } }
  // The rework verdicts, recorded with the round that answered them.
  const reworked = targets.map(d => verdictEntry({ n: d.n, kind: d.kind, key: d.key, text: d.text, verdict: 'rework', words: '', reworked_in: next, commit: built.commit || null }, roundNow))
  verdicts = verdictsRecord(verdicts, change, reworked)
  await recordJson(`${dir}/verdicts.json`, verdicts, 'Rework')
  result.rework_rounds.push({ round: next, commit: built.commit || null, resolved: built.resolved || [], verdict: checked ? checked.verdict : null, differences: (checked && checked.differences) || [], ...(built.left_untracked ? { left_untracked: built.left_untracked } : {}) })
  if (!checked || checked.verdict === 'error') { result.rework_error = `the check after rework round ${next} did not complete${checked && checked.error ? ` (${checked.error.reason})` : ''}`; break }
  roundNow = next
  result.verdict = checked.verdict; result.differences = checked.differences || []; result.rounds = checked.rounds || result.rounds; result.settled = (checked.settled || []).length
  result.review_recorded = checked.review_recorded
  if (!untilClean) break
  targets = checked.differences || []
}
return result
