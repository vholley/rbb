export const meta = {
  name: 'scout',
  description: 'RBB: explore the code for an approved goal and save the findings as .rbb/<change>/scout.json',
  whenToUse: 'Started by RBB skills after the goal is ready; not for direct use.',
  phases: [
    { title: 'Scout', detail: 'reproduction, impact, conventions, decisions and planned locations, through a schema' },
    { title: 'Review', detail: 'an independent agent keeps only the real alternatives of each decision' },
    { title: 'Record', detail: 'the saves verified by hash and structure; scout-meta.json written' },
    { title: 'Specify', detail: 'the plan and the spec, drafted by the specify workflow from the findings in memory' },
  ],
}

// <pure> -- deterministic functions only; unit-tested by tests/check/unit.mjs with no model.

// <lib:spec> copied from src/lib/spec.js by tools/sync-lib.mjs; edit the source, not this copy
// The goal and spec formats (docs/spec-format.md) and their validation. Pure functions only.
// Workflow scripts cannot import, so this file is copied into a marked region of each workflow
// that needs it by tools/sync-lib.mjs; tests/check/unit.mjs fails if any copy differs.

const SPEC_V = 1
const ID = { E: /^E\d+$/, C: /^C\d+$/, O: /^O\d+$/, X: /^X\d+$/, D: /^D\d+$/, P: /^P\d+$/ }
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
const KIND = { E: ['example', 'examples'], C: ['constraint', 'constraints'], O: ['exclusion', 'exclusions'], X: ['agreed extra', 'agreed extras'], D: ['decision', 'decisions'], P: ['step', 'steps'] }
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
// The reading: one sentence saying how the request is taken, first on the page, so that a wrong one
// is the first thing the requester sees and rejects.
const READING_HEADING = '## How the request is read'
const EXAMINED_HEADING = '## Examined'
const FOLLOW_UPS_HEADING = '## Found along the way, not part of this change'
const IMPACT_HEADING = '## What the change touches'
const bullets = (list, f = x => oneLine(x)) => (list && list.length ? list.map(x => `- ${f(x)}`).join('\n') : 'None.')

// The prose a person must read before approving, for the reading-length limit (the old RBB's rule:
// not counting code, tables, the alternatives considered or the Examined list). Left out: the
// reference sections (what the change touches, what was examined, the request as written), tables,
// and sub-bullets (evidence, alternatives considered, who decided).
function readingText(page) {
  const skip = new Set([IMPACT_HEADING, EXAMINED_HEADING, REQUEST_HEADING])
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
function requestSection(text) {
  return `${REQUEST_HEADING}\n\n${String(text).split('\n').map(l => `> ${l}`.trimEnd()).join('\n')}`
}

// Every item id this goal or spec defines.
function specIds(o) {
  const lists = [o.done_when, o.constraints, o.out_of_scope, o.agreed_extras, o.decisions, o.plan && o.plan.steps]
  return new Set(lists.filter(Array.isArray).flat().filter(Boolean).map(i => i.id))
}

// Text a model wrote that cites one of this goal's or spec's own items by its code. Used only to
// ask the writer to rephrase (once); text is never rewritten by code, because the same token can
// legitimately mean something else (an error code, a cell, a version). Only codes this goal or
// spec defines are looked for. Returns [{ where, code }].
function codeMentions(o, ids) {
  const found = []
  const scan = (where, text) => {
    for (const m of String(text || '').matchAll(/\b[ECOXDP]\d+\b/g)) if (ids.has(m[0])) found.push({ where, code: m[0] })
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
  parts.push(requestSection(g.source_request))
  return parts.join('\n\n') + '\n'
}

// The independent review of alternatives (architecture 5.1.3). Each alternative is named by
// position: "2.1" is the first alternative of the second decision given.
function altIds(decisions) {
  return decisions.flatMap((d, i) => (d.alternatives || []).map((_, j) => `${i + 1}.${j + 1}`))
}

function ALT_REVIEW_SCHEMA(ids) {
  return { type: 'object', properties: { verdicts: { type: 'array', minItems: ids.length, maxItems: ids.length, items: { type: 'object', properties: {
    id: { type: 'string', enum: ids }, keep: { type: 'boolean', description: 'true only for a real alternative' }, why: { type: 'string', description: 'one line' },
  }, required: ['id', 'keep', 'why'] } } }, required: ['verdicts'] }
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

What the change must achieve:
${must}

The decisions and their alternatives:
${list}`
}

function altReviewProblems(ids, answer) {
  const seen = (answer && answer.verdicts || []).map(v => v.id)
  const missing = ids.filter(id => !seen.includes(id))
  const twice = seen.filter((id, n) => seen.indexOf(id) !== n)
  return [...missing.map(id => `no verdict for ${id}`), ...[...new Set(twice)].map(id => `more than one verdict for ${id}`)]
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
    return { ...d, alternatives: kept, ...(dropped.length ? { dropped_alternatives: dropped } : {}), ...(d.sure !== undefined ? { sure: d.sure || kept.length === 0 } : {}), alternatives_reviewed_by: who }
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
      return {
        // A call with no real alternative is not a judgment call, whatever the scout said; one that
        // gains an alternative, from the scout or the advocate, is a judgment call, whatever it said.
        id: `D${n + 1}`, choice: d.choice, because: d.because, sure: all.length === 0,
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
  const kind = id => ({ E: 'example', C: 'constraint', O: 'exclusion', X: 'agreed extra' })[String(id)[0]]
  const items = [...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || [])].map(i => ({ id: i.id, kind: kind(i.id) }))
  return {
    v: 1, change: spec.change, base: spec.base, title: spec.title,
    items,
    decisions: spec.decisions.map(d => ({ id: d.id, sure: !!d.sure })),
    steps: spec.plan.steps.map(s => ({ id: s.id, serves: s.serves, locations: s.locations.map(l => ({ file: l.file, ...(l.lines ? { lines: l.lines } : {}), ...(l.symbol ? { symbol: l.symbol } : {}), change: l.change })) })),
    hashes: Object.fromEntries(RECORD_FILES.filter(f => hashes && /^[0-9a-f]{40}$/.test(hashes[f] || '')).map(f => [f, hashes[f]])),
  }
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
  return errs
}
// The spec's structure as a later stage's code needs it, from the index alone: ids for the schemas,
// steps and locations for the mapping, the title for commit subjects. Every text field is absent.
function specFromIndex(x) {
  const of = k => x.items.filter(i => i.kind === k).map(i => ({ id: i.id }))
  return {
    v: 1, change: x.change, base: x.base, title: x.title,
    done_when: of('example'), constraints: of('constraint'), out_of_scope: of('exclusion'), agreed_extras: of('agreed extra'),
    decisions: x.decisions.map(d => ({ id: d.id, sure: d.sure })),
    plan: { steps: x.steps.map(s => ({ id: s.id, serves: s.serves, locations: s.locations })) },
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
  return [
    `- **Why:** ${stop(d.because)}`,
    alts.length ? `- **Alternatives considered:**\n${alts.map(a => `  - ${a.raised_by === 'advocate' ? `${oneLine(a.option).replace(/\.$/, '')}: raised by an independent advocate, not weighed by the decider. Its case: ${stop(a.case)}${a.evidence ? ` Evidence: ${stop(a.evidence)}` : ''}` : a.why_not ? `${oneLine(a.option).replace(/\.$/, '')}: not taken because ${lower(stop(a.why_not))}` : stop(a.option)}`).join('\n')}` : '',
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
  const sure = s.decisions.filter(d => d.judgment === false)
  const brief = d => `- **Decision ${num(d.id)}:** ${oneLine(d.choice)}${who(d) ? ` (${who(d)})` : ''}`
  const decisions = [
    calls.length ? (opts.reasons === false ? `### Judgment calls\n\n${calls.map(brief).join('\n')}` : calls.map(decision).join('\n\n')) : '',
    sure.length ? `### Settled, with no credible alternative\n\n${sure.map(brief).join('\n')}` : '',
    opts.reasons === false && s.decisions.length ? reasonsLeftOut(['scout.json', 'plan.json']) : '',
  ].filter(Boolean).join('\n\n')
  parts.push(`## Decisions\n\n${decisions || 'None.'}`)
  parts.push(`## Plan\n\n${s.plan.approach || ''}\n\n${table(['Step', 'What it does', 'Serves', 'Where'], s.plan.steps.map(p => [num(p.id), p.does, refs(p.serves), p.locations.map(where).join('; ')]))}`)
  if (s.amendments && s.amendments.length) parts.push(`## Amendments\n\n${s.amendments.map((a, n) => `${n + 1}. ${typeof a === 'string' ? a : JSON.stringify(a)}`).join('\n')}`)
  parts.push(reviewFocusSection(s), followUpsSection(s), examinedSection(s), requestSection(s.source_request))
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

const str = d => ({ type: 'string', description: d })
const strs = d => ({ type: 'array', items: { type: 'string' }, description: d })
const LINES = { type: ['object', 'null'], properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } }, required: ['start', 'end'] }
const SCOUT_SCHEMA = { type: 'object', properties: {
  saved_hash: { type: 'string', description: 'the output of git hash-object on the file you saved, run after saving it: 40 hex characters' },
  reproduction: { type: 'object', properties: {
    outcome: { type: 'string', enum: ['reproduced', 'partly reproduced', 'not reproduced', 'nothing to change', 'not a failure'] },
    observed: str('what you saw, marked observed or inferred'), cause: str('the cause, marked observed or inferred'), evidence: strs('commands and outputs, or file:line'),
  }, required: ['outcome', 'observed', 'cause', 'evidence'] },
  impact: { type: 'object', properties: {
    code: { type: 'array', items: { type: 'object', properties: { file: str(''), symbol: str(''), lines: LINES }, required: ['file', 'symbol', 'lines'] } },
    callers: strs('file:line and symbol'), tests_covering: strs(''), tests_asserting_changed_behaviour: strs(''), docs_and_config: strs(''), read: strs('every file read'), ran: strs('every command run'),
  }, required: ['code', 'callers', 'tests_covering', 'tests_asserting_changed_behaviour', 'docs_and_config', 'read', 'ran'] },
  conventions: { type: 'object', properties: {
    test_command: str('how the project runs its tests, or empty'), changelog: str('how changes are recorded, or "none"'), docs: str('whether comparable changes touched docs'), guidance_files: strs(''),
  }, required: ['test_command', 'changelog', 'docs', 'guidance_files'] },
  decisions: { type: 'array', items: { type: 'object', properties: {
    choice: str(''), because: str(''), basis: { type: 'string', enum: BASES }, sure: { type: 'boolean' },
    alternatives: { type: 'array', description: REAL_ALTERNATIVE, items: { type: 'object', properties: { option: str(''), why_not: str('') }, required: ['option', 'why_not'] } },
    would_change_if: str('what would reverse it; empty when sure'),
  }, required: ['choice', 'because', 'basis', 'sure', 'alternatives', 'would_change_if'] } },
  locations: { type: 'array', minItems: 1, items: { type: 'object', properties: {
    file: str(''), lines: LINES, symbol: str(''), change: { type: 'string', enum: CHANGES }, why: str('what this place needs'),
  }, required: ['file', 'lines', 'symbol', 'change', 'why'] } },
  follow_ups: { type: 'array', items: { type: 'object', properties: { text: str(''), evidence: str('') }, required: ['text', 'evidence'] } },
  review_focus: strs('ways the change could fail that no example exercises: each one sentence stating a concrete case (the input or the path, with file:line where it applies) as a fact a reviewer can check; no advice. Empty when the examples cover every way'),
  questions: { type: 'array', items: { type: 'object', properties: { question: str(''), recommendation: str(''), why: str('citing the codebase') }, required: ['question', 'recommendation', 'why'] } },
}, required: ['reproduction', 'impact', 'conventions', 'decisions', 'locations', 'follow_ups', 'review_focus', 'questions', 'saved_hash'] }

// Each proposed location must be one a plan can use (spec-format.md, the plan).
function locationProblems(locations) {
  const errs = []
  locations.forEach((l, n) => {
    if (!isStr(l.file)) errs.push(`locations[${n}]: missing file`)
    const needsLines = l.change === 'edit' || l.change === 'add'
    if (needsLines && !(l.lines && l.lines.end >= l.lines.start)) errs.push(`locations[${n}] ${l.file}: lines {start,end} required for ${l.change}`)
  })
  return errs
}

// Seconds between the relayed clock stamps, phase by phase; null where a stamp is missing. The
// advocate's span includes the read-back of scout.json before it, the review's the advocate's save.
function phaseSeconds(s) {
  const span = (a, b) => (Number.isFinite(s[a]) && Number.isFinite(s[b]) && s[b] >= s[a] ? s[b] - s[a] : null)
  return { seconds: { total: span('start', 'end'), scout: span('scoutStart', 'scoutEnd'), advocate: span('scoutEnd', 'advocateEnd'), review: span('advocateEnd', 'end') }, by: 'the clock relayed at phase ends; a resumed run repeats cached stamps' }
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

// The skill passes {"change": ...}; an agent that passes the argument text itself means its first word.
const change = typeof args === 'string' ? args.trim().split(/\s+/)[0] : args && args.change
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(change || '')) throw new Error(`rbb:scout needs a change name, got: ${change}`)
// Who decides is configured, never inherited, so the record can say which model it was.
const run = { model: (args && args.model) || 'opus', effort: (args && args.effort) || 'high' }
run.alias = !/^claude-/.test(run.model)
const dir = `.rbb/${change}`

phase('Scout')
const back = await agent(`Read the file ${dir}/goal.json and return its content verbatim, without line numbers.`, { label: 'read goal', phase: 'Scout', agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })
let goal = null
try { goal = back && JSON.parse(back.content) } catch (e) { goal = null }
if (!goal || validateGoal(goal).length) return { change, error: `${dir}/goal.json is missing or does not meet the goal format`, problems: goal ? validateGoal(goal) : [] }
if (!goalReady(goal)) return { change, error: 'the goal still has open questions; settle them with /rbb:goal first' }

// The commit the scout explores: its line numbers refer to it, and it becomes the spec's base.
// Relayed twice and compared, like the check's git facts.
// The clock rides on relays that run anyway: a workflow script cannot read it (Date throws, so that
// a resumed run can replay cached results), so `date +%s` is relayed at the phase ends, and the
// durations in scout-meta.json say where the minutes went. A resumed run repeats cached stamps.
const NOW = { now: { type: 'string', description: 'stdout of date +%s, verbatim' } }
const stamp = r => (r && /^\d{9,11}$/.test(String(r.now || '').trim()) ? Number(String(r.now).trim()) : null)
const HEAD_SCHEMA = { type: 'object', properties: { head: { type: 'string', description: 'stdout of git rev-parse HEAD, verbatim' }, ...NOW }, required: ['head', 'now'] }
const heads = await parallel([1, 2].map(i => () => agent('Run `git rev-parse HEAD` and then `date +%s` in the current directory and return each one\'s standard output verbatim.', { label: `base ${i}`, phase: 'Scout', agentType: 'rbb:checker', effort: 'low', schema: HEAD_SCHEMA })))
const stamps = { start: stamp(heads[0]) }
const base = heads.every(h => h && /^[0-9a-f]{40}$/.test(h.head.trim())) && heads[0].head.trim() === heads[1].head.trim() ? heads[0].head.trim() : null
if (!base) return { change, error: 'could not establish the commit being explored (the two relays of git rev-parse HEAD disagreed or failed)' }

// The scout runs the project's code; the tree must be the same after it as before, or the build
// would start from files nobody approved. Relayed twice, before and after.
const STATUS_SCHEMA = { type: 'object', properties: { status: { type: 'string', description: 'stdout of the git command, verbatim' }, ...NOW }, required: ['status', 'now'] }
const treeStatus = async label => {
  const r = await parallel([1, 2].map(i => () => agent("Run `git status --porcelain=v1 -uall -- . ':(exclude).rbb'` and then `date +%s` in the current directory and return each one's standard output verbatim; an empty string for the git command if it prints nothing.", { label: `${label} ${i}`, phase: 'Scout', agentType: 'rbb:checker', effort: 'low', schema: STATUS_SCHEMA })))
  return r.every(x => x) && r[0].status.trim() === r[1].status.trim() ? { status: r[0].status.trim(), now: stamp(r[0]) } : null
}
const beforeTree = await treeStatus('tree before')
if (beforeTree === null) return { change, error: 'could not read git status (the two relays disagreed or failed)' }
const before = beforeTree.status
stamps.scoutStart = beforeTree.now

let findings = null, problems = []
for (let attempt = 1; attempt <= 2 && !findings; attempt++) {
  const prompt = `Explore the change for this approved goal, in the current repository. When your findings are complete, save them to ${dir}/scout.json as described in your instructions, then return the same findings as your answer.\n\nThe goal:\n${JSON.stringify(goal, null, 2)}` + (problems.length ? `\n\nYour last answer broke these rules; fix them:\n${problems.join('\n')}` : '')
  const answer = await agent(prompt, { label: `scout ${attempt}`, phase: 'Scout', agentType: 'rbb:scout', model: run.model, effort: run.effort, schema: SCOUT_SCHEMA })
  if (!answer) { problems = ['the scout returned nothing']; continue }
  problems = locationProblems(answer.locations)
  if (!problems.length) findings = answer
}
if (!findings) return { change, error: 'the scout findings did not meet their format', problems }
const afterTree = await treeStatus('tree after')
const after = afterTree ? afterTree.status : null
stamps.scoutEnd = afterTree ? afterTree.now : null
if (after !== before) return { change, error: 'the scout changed files in the repository while exploring; restore them (git status shows which), then run the scout again', before, after }

// The scout saved its own findings. A read-back would ask another agent to reproduce its reasoning,
// which the reasoning_extraction safeguard refuses (architecture 5.2.2), so the save is verified by
// hash and structure: the author's own blob id against two relays' and a count of the record's ids.
// Prose equality is not proven; the design says so. verifySave is the record library's.
phase('Record')
const { saved_hash: scoutHash, ...found } = findings
// The scout's decisions carry no ids until code composes them: each has one choice.
const scoutSaved = await verifySave(`${dir}/scout.json`, scoutHash, '"choice" *:', found.decisions.length, 'Record')
if (scoutSaved.error) return { change, error: scoutSaved.error }
const hashes = { 'scout.json': scoutSaved.hash }
findings = found

// An independent advocate argues from the code for the best way of deciding otherwise, for every
// decision, the settled ones included (architecture 5.1.3). It saves its own cases; a failed or
// refused advocate leaves an empty file, which code saves, so the spec's files are complete.
phase('Advocate')
const advPath = `${dir}/advocate.json`
let advocate = { v: 1, cases: [] }
if (findings.decisions.length) {
  const n = findings.decisions.length
  const a = await agent(`${advocatePrompt(goal, findings.decisions)}\n\nWhen your cases are complete, save them to ${advPath} as described in your instructions (one JSON object: {"v": 1, "cases": [...]}, the same cases you then return), then return them.`, { label: 'advocate', phase: 'Advocate', agentType: 'rbb:scout', model: ADVOCATE.model, effort: ADVOCATE.effort, schema: ADVOCATE_SCHEMA(n) })
  // The advocate's save is verified as the scout's: by its own hash and the count of its cases.
  const advSaved = a && !advocateProblems(n, a).length ? await verifySave(advPath, a.saved_hash, '"decision" *:', n, 'Advocate') : null
  stamps.advocateEnd = advSaved && !advSaved.error ? advSaved.now : null
  if (advSaved && !advSaved.error) { advocate = { v: 1, cases: a.cases }; hashes['advocate.json'] = advSaved.hash }
  else log(a ? `the advocate's cases could not be verified (${advSaved ? advSaved.error : 'its answer did not meet its format'}); the spec goes on without them` : 'the advocate returned nothing; the spec goes on without its cases')
}
const advocateSaved = advocate.cases.length ? true : await recordFile(advPath, JSON.stringify(advocate, null, 2) + '\n', 'Advocate', t => { try { return sameJson(JSON.parse(t), advocate) } catch (e) { return false } })
if (!advocateSaved) return { change, error: `${advPath} could not be saved; the spec's files would be incomplete` }

// An agent that saw neither the scout's conversation nor its reasons judges each alternative, the
// advocate's included. Its verdicts reach the record only as keep or drop, in the meta file.
phase('Review')
const pre = composeFindings(findings, { base, run }, advocate)
const reviewed = await reviewAlternatives(goal, pre.decisions, 'Review')
const anyAlts = pre.decisions.some(d => d.alternatives.length)
// A completed review stamps who reviewed; the not-reviewed marker composeFindings put on pre is not a verdict.
const done = reviewed.some(d => d.alternatives_reviewed_by)
const scoutAlts = (d, i) => d.alternatives.filter(a => a.raised_by !== 'advocate')
const review = anyAlts && done ? { by: ALT_REVIEWER, keep: pre.decisions.map((d, i) => scoutAlts(d).map(a => reviewed[i].alternatives.includes(a))) } : null
const advStamp = { model: ADVOCATE.model, effort: ADVOCATE.effort, ...(ADVOCATE.alias ? { alias: true } : {}) }
const advocateMeta = advocate.cases.length ? { by: advStamp, keep: pre.decisions.map((d, i) => d.alternatives.some(a => a.raised_by === 'advocate' && (!done || reviewed[i].alternatives.includes(a)))) } : null

phase('Record')
// One short relay closes the clock; the durations are what a person needs to see where the time goes.
const closing = await agent('Run `date +%s` in the current directory and return its standard output verbatim.', { label: 'clock', phase: 'Record', agentType: 'rbb:checker', effort: 'low', schema: { type: 'object', properties: NOW, required: ['now'] } })
stamps.end = stamp(closing)
const took = phaseSeconds(stamps)
const scoutMeta = { v: 1, base, run: { model: run.model, effort: run.effort, ...(run.alias ? { alias: true } : {}) }, review, advocate: advocateMeta, hashes, took }
const recorded = await recordFile(`${dir}/scout-meta.json`, JSON.stringify(scoutMeta, null, 2) + '\n', 'Record', t => { try { return sameJson(JSON.parse(t), scoutMeta) } catch (e) { return false } })
const composed = composeFindings(findings, scoutMeta, advocate)
const result = { change, recorded, took: took.seconds, files: [`${dir}/scout.json`, `${dir}/scout-meta.json`, advPath], locations: composed.locations.length, decisions: composed.decisions.length, judgment_calls: composed.decisions.filter(d => !d.sure).length, raised_by_advocate: composed.decisions.filter(d => d.alternatives.some(a => a.raised_by === 'advocate')).length, questions: composed.questions }
if (!recorded || composed.questions.length) return result

// The spec is drafted here, inside this run, so that the specify workflow takes the findings, the
// cases and the meta as values in memory and reads back nothing an author wrote (architecture 5.2.2).
phase('Specify')
let spec
try { spec = await workflow('rbb:specify', { change, model: run.model, effort: run.effort, goal, scout: findings, scoutMeta, advocate }) } catch (e) { spec = { error: `the specify workflow could not run inside the scout: ${e.message}` } }
return { ...result, spec }
