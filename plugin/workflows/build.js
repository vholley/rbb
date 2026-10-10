export const meta = {
  name: 'build',
  description: 'RBB: build an approved change from its frozen spec, save the build log, and commit the build',
  whenToUse: 'Started by RBB skills after approval; not for direct use.',
  phases: [
    { title: 'Ready', detail: 'the frozen spec from the approval commit, and a clean working tree' },
    { title: 'Build', detail: 'the builder works from the spec alone and returns its log through a schema' },
    { title: 'Review', detail: 'an independent agent keeps only the real alternatives of each decision' },
    { title: 'Commit', detail: 'build.json recorded, the build committed and verified from git' },
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
  return { type: 'object', properties: { cases: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', properties: {
    decision: { type: 'integer', minimum: 1, maximum: n, description: 'the decision number, each once' },
    option: { type: 'string', description: 'the best other way of deciding, in a few words; empty when no other way meets the goal, every constraint and every example' },
    case: { type: 'string', description: 'why a competent developer could defensibly decide that way: the trade-off it wins, in terms of the code and the goal; empty when option is empty' },
    evidence: { type: 'string', description: 'file:line or a command and its output that the case rests on; empty when option is empty' },
  }, required: ['decision', 'option', 'case', 'evidence'] } } }, required: ['cases'] }
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
const SPEC_PARTS = ['goal.json', 'scout.json', 'scout-meta.json', 'plan.json', 'advocate.json']
const SPEC_FILES = ['spec.json', ...SPEC_PARTS]
const specManifest = (change, base, title) => ({ v: 2, change, base, title, parts: SPEC_PARTS })

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
const reasonsLeftOut = files => `*The reasons behind each decision, the alternatives considered and what could change it are left off this page: the agent saving it was not allowed to copy another agent's reasoning. They are in full in ${files.map(f => `\`${f}\``).join(', ')}.*`

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

// <lib:build> copied from src/lib/build.js by tools/sync-lib.mjs; edit the source, not this copy
// The builder's log (architecture 5.3): its schema, validation and page. Pure functions only.
// Needs the spec library (copied before this one): ID, KIND, num, refs, oneLine.

const BUILD_KINDS = ['evidence', 'decision', 'deviation', 'claim']

// The log as the builder answers it, through a schema built from the approved spec: it can cite
// only examples, steps and items that exist.
function BUILD_SCHEMA(spec) {
  const eIds = spec.done_when.map(i => i.id)
  const pIds = spec.plan.steps.map(p => p.id)
  const itemIds = [...eIds, ...spec.constraints.map(i => i.id), ...spec.out_of_scope.map(i => i.id), ...(spec.agreed_extras || []).map(i => i.id), ...spec.decisions.map(d => d.id)]
  const s = d => ({ type: 'string', description: d })
  return { type: 'object', properties: {
    evidence: { type: 'array', items: { type: 'object', properties: { item: { type: 'string', enum: eIds }, before: s('what the example gave before the change'), after: s('what it gives after'), how: s('the command or check that showed it') }, required: ['item', 'before', 'after', 'how'] } },
    decisions: { type: 'array', items: { type: 'object', properties: { serves: { type: 'array', items: { type: 'string', enum: itemIds } }, choice: s(''), because: s(''), alternatives: { type: 'array', description: REAL_ALTERNATIVE, items: { type: 'object', properties: { option: s(''), why_not: s('') }, required: ['option', 'why_not'] } }, would_change_if: s('what would make another choice right; empty if nothing would'), basis: { type: 'string', enum: BASES, description: 'the criterion that settled it' } }, required: ['serves', 'choice', 'because', 'alternatives', 'would_change_if', 'basis'] } },
    deviations: { type: 'array', items: { type: 'object', properties: { step: { type: 'string', enum: pIds }, planned: s('what the plan said'), actual: s('what was done instead'), because: s('') }, required: ['step', 'planned', 'actual', 'because'] } },
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
  const items = spec ? new Set([...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || []), ...spec.decisions].map(i => i.id)) : null
  b.entries.forEach((e, n) => {
    const at = `build.json entries[${n}]`
    if (!e || !BUILD_KINDS.includes(e.kind)) errors.push(`${at}: kind must be one of ${BUILD_KINDS.join(', ')}`)
    else if ((e.kind === 'decision' || e.kind === 'deviation') && !/^B\d+$/.test(e.id || '')) errors.push(`${at}: a ${e.kind} needs an id B1, B2, ...`)
    else if (e.kind === 'claim' && !(typeof e.text === 'string' && e.text.trim())) errors.push(`${at}: a claim needs text`)
    else if (spec && e.kind === 'evidence' && !eIds.has(e.item)) errors.push(`${at}: evidence for ${e.item}, which is not an example of the spec`)
    else if (spec && e.kind === 'deviation' && !pIds.has(e.step)) errors.push(`${at}: a deviation from ${e.step}, which is not a step of the plan`)
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
  parts.push(`## Deviations from the plan\n\n${b.deviations.length ? b.deviations.map(d => `- **Step ${num(d.step)}.** Planned: ${oneLine(d.planned)}. Done instead: ${oneLine(d.actual)}. Because: ${oneLine(d.because)}`).join('\n') : 'None.'}`)
  parts.push(`## What the builder says the change does\n\nThese are the builder's own claims; the check verifies each against the change.\n\n${b.claims.length ? b.claims.map(c => `- ${oneLine(c.text)}`).join('\n') : 'None.'}`)
  return parts.join('\n\n') + '\n'
}
// </lib:build>

// What the builder answers: its log, plus a stop when an example does not behave as the spec
// expects before the change, plus the kind of change for a conventional commit message.
const COMMIT_TYPES = ['fix', 'feat', 'refactor', 'docs', 'test', 'perf', 'chore']
function BUILDER_SCHEMA(spec) {
  const log = BUILD_SCHEMA(spec)
  return { ...log, properties: { ...log.properties,
    stop: { type: ['string', 'null'], description: 'why you stopped without changing anything, or null' },
    commit_type: { type: 'string', enum: COMMIT_TYPES, description: 'the kind of change, for the commit message' },
    files_created: { type: 'array', items: { type: 'string' }, description: 'the path of every new file that is part of the change, relative to the repository root; files your runs produced are not part of it' },
  }, required: [...log.required, 'stop', 'commit_type', 'files_created'] }
}

// Paths as git prints them: forward slashes, no leading ./, no trailing slash.
const normPath = f => String(f).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
// Whether an untracked file is one the builder named, as the file itself or by its new directory.
const namedBy = (file, created) => created.some(n => file === n || file.startsWith(`${n}/`))
// git -c core.quotepath=false ls-files --others --exclude-standard -- . ':(exclude).rbb' lists the
// untracked files outside .rbb, one per line: those the builder did not name as part of the change
// are left in the tree, uncommitted, and reported. They are never deleted by RBB.
function strayFiles(untrackedOutput, created) {
  const named = (created || []).map(normPath)
  return String(untrackedOutput || '').split('\n').map(l => l.trim()).filter(Boolean).filter(f => !namedBy(f, named))
}

function buildSubject(spec, style, type) {
  return commitSubject(style && style.kind === 'conventional' ? `${type}: ` : '', spec.title || spec.change)
}

// The build's commit: every change to a tracked file outside .rbb (the tree was clean before the
// build, so every change is the builder's), the new files the builder named as part of the change,
// and the build log. A file the builder's runs left behind is not staged. Hooks run; nothing is amended.
function buildCommands(change, subject, created = []) {
  const quote = f => `'${String(f).replace(/'/g, `'\\''`)}'`
  return [
    `git add -u -- . ':(exclude).rbb'`,
    ...(created.length ? [`git add -- ${created.map(quote).join(' ')}`] : []),
    `git add -- .rbb/${change}/build.json .rbb/${change}/build-meta.json`,
    `git commit -m "${subject}"`,
  ]
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
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(change || '')) throw new Error(`rbb:build needs a change name, got: ${change}`)
const run = { model: (args && args.model) || 'sonnet', effort: (args && args.effort) || 'medium' }
run.alias = !/^claude-/.test(run.model)
const specPath = `.rbb/${change}/spec.json`
const RELAY = keys => ({ type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])), required: keys })
async function relay(label, cmds) {
  const keys = cmds.map(([k]) => k)
  const p = `Run these commands in the current directory, exactly as written, and return each one's standard output verbatim under its label; an empty string if it fails or prints nothing.\n${cmds.map(([k, c]) => `${k}: ${c}`).join('\n')}`
  const [a, b] = await parallel([1, 2].map(i => () => agent(p, { label: `${label} ${i}`, phase: 'Ready', agentType: 'rbb:checker', effort: 'low', schema: RELAY(keys) })))
  return a && b && keys.every(k => a[k].trim() === b[k].trim()) ? a : null
}

phase('Ready')
const config = await (async () => {
  const back = await agent('Read the file .rbb/config.json and return its content verbatim, without line numbers. If it does not exist, return an empty string.', { label: 'read config', phase: 'Ready', agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })
  try { return back && back.content.trim() ? JSON.parse(back.content) : null } catch (e) { return null }
})()
const none = documentsMode(config) === 'none'
const f1 = await relay('approval and tree', [
  ['head', 'git rev-parse HEAD'],
  ['log', `git log --format='%H %(trailers:key=RBB-Approved,valueonly,separator=%x2C)' -- ${specPath}`],
  ['status', `git status --porcelain=v1 -uall -- . ':(exclude).rbb'`],
])
if (!f1) return { change, error: 'the two relays of git facts disagreed or failed' }
if (f1.status.trim()) return { change, error: 'the working tree has changes outside .rbb; commit or stash them first, so every change after this point is the build', status: f1.status.trim() }
// The spec, rebuilt in memory from its manifest and the files it names (architecture 5.2.1).
const dir = `.rbb/${change}`
const readText = async (file, label) => { const b = await agent(`Read the file ${file} and return its content verbatim, without line numbers. If it does not exist, return an empty string.`, { label, phase: 'Ready', agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA }); return b ? b.content : '' }
let spec = null
if (none) {
  // Mode none (architecture 9.1): the files on this machine, accepted only if each has its approved hash.
  let approval = null
  try { approval = JSON.parse(await readText(`${dir}/approval.json`, 'read approval')) } catch (e) { approval = null }
  if (approvalProblems(approval, change).length) return { change, error: `no valid approval for ${change}; approve the spec first`, problems: approvalProblems(approval, change) }
  const h = await relay('spec hashes', [['hashes', `git hash-object ${hashedFiles(approval).map(f => `${dir}/${f}`).join(' ')}`]])
  const changed = h ? changedSpecFiles(approval, h.hashes) : hashedFiles(approval)
  if (changed.length) return { change, error: `the spec changed after it was approved (${changed.join(', ')}); approve it again` }
  const texts = await parallel(SPEC_FILES.map(f => () => readText(`${dir}/${f}`, `read ${f}`)))
  const built = specFromTexts(change, Object.fromEntries(SPEC_FILES.map((f, n) => [f, texts[n]])))
  spec = built.spec
  if (!spec || validateSpec(spec, change).length || spec.base !== approval.base) return { change, error: `the approved spec could not be read, or does not meet its format${built.error ? `: ${built.error}` : ''}` }
} else {
  const approvals = parseLog(f1.log, change)
  if (!approvals.latest) return { change, error: `no approval commit for ${change}; approve the spec first` }
  const f2 = await relay('frozen spec', SPEC_FILES.map((f, n) => [`f${n}`, `git show ${approvals.latest}:${dir}/${f}`]))
  const built = f2 ? specFromTexts(change, Object.fromEntries(SPEC_FILES.map((f, n) => [f, f2[`f${n}`]]))) : { error: 'the relays of the spec disagreed' }
  spec = built.spec
  if (!spec || validateSpec(spec, change).length) return { change, error: `the approved spec could not be read from its approval commit, or does not meet its format${built.error ? `: ${built.error}` : ''}` }
}

phase('Build')
let answer = null, problems = []
for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
  // A retry only corrects the log: the change is already made, and building again would stack edits.
  const prompt = attempt === 1
    ? `Build this approved change in the current repository. When you are done, run git diff and check every claim and decision of your log against it: the log says only what the diff shows. Then save your log to ${dir}/build.json as described in your instructions, and return the same log.\n\nThe approved spec:\n${JSON.stringify(spec, null, 2)}`
    : `You have already built this change. Change no file of the project. Save your log again to ${dir}/build.json, corrected for these problems, then return the same log:\n${problems.join('\n')}\n\nThe approved spec:\n${JSON.stringify(spec, null, 2)}`
  const a = await agent(prompt, { label: `build ${attempt}`, phase: 'Build', agentType: 'rbb:builder', model: run.model, effort: run.effort, schema: BUILDER_SCHEMA(spec) })
  if (!a) { problems = ['the builder returned nothing']; continue }
  if (a.stop) return { change, stopped: a.stop, note: 'nothing was committed; review the spec or the example' }
  const log = toBuildLog(a, run)
  problems = parseBuild(JSON.stringify(log), spec).errors
  if (!problems.length) answer = { a, log }
}
if (!answer) return { change, error: 'the build log did not meet its format', problems }

// The builder saved its own log (architecture 5.2.1): read back, it must equal its answer. No retry,
// since another agent would have to re-type it.
const savedBack = await readText(`${dir}/build.json`, 'read back build.json')
let savedLog = null
try { savedLog = savedBack.trim() ? JSON.parse(savedBack) : null } catch (e) { savedLog = null }
if (!savedLog || !sameJson(savedLog, answer.a)) return { change, error: `the builder did not save ${dir}/build.json, or saved something other than its log; nothing was committed` }

// An agent that saw neither the builder's conversation nor its reasons judges each alternative. Its
// verdicts reach the record only as keep or drop, in build-meta.json, with the stamps code adds.
phase('Review')
const runStamp = { model: run.model, effort: run.effort, ...(run.alias ? { alias: true } : {}) }
const pre = composeBuildLog(answer.a, { run: runStamp }).entries.filter(e => e.kind === 'decision')
const reviewed = await reviewAlternatives(spec, pre, 'Review')
const done = reviewed.some(d => d.alternatives_reviewed_by)
const review = pre.some(d => (d.alternatives || []).length) && done ? { by: ALT_REVIEWER, keep: pre.map((d, i) => (d.alternatives || []).map(a => reviewed[i].alternatives.includes(a))) } : null
const buildMeta = { v: 1, run: runStamp, review }

phase('Commit')
const style = config && config.commit
const recorded = await recordFile(`${dir}/build-meta.json`, JSON.stringify(buildMeta, null, 2) + '\n', 'Commit', t => { try { return sameJson(JSON.parse(t), buildMeta) } catch (e) { return false } })
if (!recorded) return { change, error: 'build-meta.json could not be saved and verified; nothing was committed' }
const subject = buildSubject(spec, style, answer.a.commit_type)
// New files the builder named are committed; any other untracked file outside .rbb is a leftover
// of its runs: left in the tree and reported, never deleted.
const untracked = await relay('untracked', [['files', `git -c core.quotepath=false ls-files --others --exclude-standard -- . ':(exclude).rbb'`]])
if (!untracked) return { change, error: 'the two relays of the untracked files disagreed or failed; nothing was committed' }
const allUntracked = strayFiles(untracked.files, [])
// Only names that match an untracked file or directory are staged, so a mistaken name cannot fail git add.
const created = (answer.a.files_created || []).map(normPath).filter(f => allUntracked.some(u => namedBy(u, [f])))
const stray = strayFiles(untracked.files, created)
const cmds = buildCommands(change, subject, created).filter(c => !(none && c.includes('build.json')))
await agent(`Run these commands:\n${cmds.map((c, n) => `${n + 1}. ${c}`).join('\n')}`, { label: 'commit', phase: 'Commit', agentType: 'rbb:committer', effort: 'low' })
const v = await relay('verify', [['last', "git log -1 --format='%H %P'"], ['files', 'git show --name-only --format= HEAD']])
const [sha, parent] = v ? v.last.trim().split(/\s+/) : []
if (!v || parent !== f1.head.trim()) return { change, error: 'the build commit was not found on top of the approval; check git status', commands: cmds }
return { change, built: true, commit: sha, subject, files: v.files.trim().split('\n'), decisions: answer.a.decisions.length, deviations: answer.a.deviations.length, ...(stray.length ? { left_untracked: stray, note: 'files the build left in the tree and did not commit; delete them, or add them to the change yourself' } : {}) }
