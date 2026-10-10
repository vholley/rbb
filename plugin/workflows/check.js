export const meta = {
  name: 'check',
  description: 'RBB: check a change against its approved spec and plan, with agents that never see the builder\'s conversation, and record the result',
  whenToUse: 'Started by the rbb:check skill; not for direct use.',
  phases: [
    { title: 'Facts', detail: 'git output relayed twice, verified, parsed by code' },
    { title: 'Judge', detail: 'grouping, plan adherence, spec mapping, then claims last' },
    { title: 'Record', detail: 'check.json written and read back' },
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

// Relayed stdout in canonical form: trailing newlines removed. Agents differ on whether they
// keep the final "\n" that terminates a command's output; it carries no meaning, and every
// parser below is indifferent to it. Everything else must match exactly.
function canon(s) {
  return String(s).replace(/\n+$/, '')
}

function parseArgs(a) {
  if (typeof a === 'string') {
    const [change, mode] = a.trim().split(/\s+/)
    return { change, mode: mode || 'grouped' }
  }
  return { change: a && a.change, mode: (a && a.mode) || 'grouped' }
}

// git diff --numstat: "<added>\t<deleted>\t<path>"; binary files show "-\t-".
function parseNumstat(text) {
  const files = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) throw new Error(`numstat: unexpected line: ${line}`)
    const binary = m[1] === '-'
    files.push({ path: gitPath(m[3]), binary, added: binary ? null : +m[1], deleted: binary ? null : +m[2] })
  }
  return files
}

// A path as git prints it in a diff header or numstat. Git ends a ---/+++ path that contains a
// space with a tab, and C-quotes a path with special characters ("a/x\"y", octal bytes for
// UTF-8 when core.quotepath is on). Returns the path unquoted, without any trailing tab.
function gitPath(raw) {
  let s = raw.endsWith('\t') ? raw.slice(0, -1) : raw
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s
  s = s.slice(1, -1)
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  const hex = b => '%' + b.toString(16).padStart(2, '0')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { out += encodeURIComponent(c); continue }
    const n = s[i + 1]
    if (/[0-7]/.test(n)) { out += hex(parseInt(s.slice(i + 1, i + 4), 8)); i += 3 }
    else if (n in esc) { out += hex(esc[n]); i += 1 }
    else throw new Error(`path: unknown escape \\${n} in ${raw}`)
  }
  return decodeURIComponent(out)
}

// A ---/+++ header path: null for /dev/null, else the path without its a/ or b/ prefix.
function headerPath(rest) {
  if (rest === '/dev/null') return null
  const p = gitPath(rest)
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p
}

// git diff -U0 with --no-renames. Hunk header: @@ -a[,b] +c[,d] @@ ; an omitted length means 1.
function parseDiff(text) {
  const files = []
  let cur = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      cur = { path: null, oldPath: null, newPath: null, newFile: false, deleted: false, binary: false, modeChange: false, modeOnly: false, emptyFile: false, hunks: [] }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('new file mode')) cur.newFile = true
    else if (line.startsWith('deleted file mode')) cur.deleted = true
    else if (line.startsWith('old mode ') || line.startsWith('new mode ')) cur.modeChange = true
    else if (line.startsWith('Binary files ')) cur.binary = true
    else if (line.startsWith('--- ')) cur.oldPath = headerPath(line.slice(4))
    else if (line.startsWith('+++ ')) cur.newPath = headerPath(line.slice(4))
    else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m) throw new Error(`diff: bad hunk header: ${line}`)
      const hunk = {
        oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4],
        header: line,
        body: [],
      }
      // With -U0 a hunk holds exactly oldLen '-' lines and newLen '+' lines (plus any
      // '\ No newline' markers). Read by count, never by guessing where a header starts:
      // a removed line whose content is '-- x' appears as '--- x'.
      let del = 0, add = 0, j = i + 1
      while (j < lines.length && (del < hunk.oldLen || add < hunk.newLen || (lines[j] || '').startsWith('\\'))) {
        const l = lines[j]
        if (l.startsWith('-') && del < hunk.oldLen) del++
        else if (l.startsWith('+') && add < hunk.newLen) add++
        else if (!l.startsWith('\\')) throw new Error(`diff: hunk ${line} ends early at: ${l}`)
        hunk.body.push(l); j++
      }
      // A body cut off at the end of the text (a truncated relay) must not pass as a whole hunk.
      if (del < hunk.oldLen || add < hunk.newLen) throw new Error(`diff: hunk ${line} is cut off: ${del} of ${hunk.oldLen} removed and ${add} of ${hunk.newLen} added lines present`)
      i = j - 1
      cur.hunks.push(hunk)
    }
  }
  for (const f of files) {
    f.path = f.newPath || f.oldPath
  }
  return files
}

// Fill in paths for binary and mode-only entries from numstat, and cross-check the rest.
function crossCheck(diffFiles, numstat) {
  const problems = []
  const byPath = new Map(numstat.map(n => [n.path, n]))
  const pathless = diffFiles.filter(f => !f.path)
  const withPath = new Set(diffFiles.filter(f => f.path).map(f => f.path))
  const unmatched = numstat.filter(n => !withPath.has(n.path))
  if (pathless.length !== unmatched.length) problems.push(`files: ${pathless.length} diff entries without a path, ${unmatched.length} numstat entries unmatched`)
  pathless.forEach((f, k) => { if (unmatched[k]) { f.path = unmatched[k].path; f.binary = f.binary || unmatched[k].binary } })
  // A file with no hunks is binary, a mode change, or an empty file created or deleted.
  for (const f of diffFiles) if (f.hunks.length === 0 && !f.binary) { f.modeOnly = f.modeChange && !f.newFile && !f.deleted; f.emptyFile = !f.modeOnly }
  for (const f of diffFiles) {
    const n = byPath.get(f.path)
    if (!n) { problems.push(`${f.path}: in the diff but not in numstat`); continue }
    if (n.binary || f.binary) { f.binary = true; continue }
    const added = f.hunks.reduce((s, h) => s + h.newLen, 0)
    const deleted = f.hunks.reduce((s, h) => s + h.oldLen, 0)
    if (added !== n.added || deleted !== n.deleted) problems.push(`${f.path}: hunks add ${added} and delete ${deleted}, numstat says ${n.added} and ${n.deleted}`)
    for (let k = 1; k < f.hunks.length; k++) {
      const p = f.hunks[k - 1], h = f.hunks[k]
      const pEnd = p.oldLen === 0 ? p.oldStart : p.oldStart + p.oldLen - 1
      if (h.oldStart <= pEnd) problems.push(`${f.path}: hunks out of order or overlapping at ${h.header}`)
    }
  }
  for (const n of numstat) if (!diffFiles.some(f => f.path === n.path)) problems.push(`${n.path}: in numstat but not in the diff`)
  return problems
}

// Hunk base range vs planned range [s,e]. A pure insertion after base line a is inside when s-1 <= a <= e.
function hunkInRange(h, r) {
  if (h.oldLen === 0) return r.start - 1 <= h.oldStart && h.oldStart <= r.end
  const end = h.oldStart + h.oldLen - 1
  return h.oldStart <= r.end && end >= r.start
}

function planFacts(spec, diffFiles) {
  const hunks = []
  for (const f of diffFiles) {
    if (f.hunks.length === 0) hunks.push({ id: null, file: f.path, whole: true, binary: f.binary, modeOnly: f.modeOnly, emptyFile: f.emptyFile, newFile: f.newFile, deleted: f.deleted })
    for (const h of f.hunks) hunks.push({ id: null, file: f.path, whole: false, newFile: f.newFile, deleted: f.deleted, ...h })
  }
  hunks.forEach((h, n) => { h.id = `H${n + 1}` })
  const locs = []
  for (const s of spec.plan.steps) s.locations.forEach((l, k) => locs.push({ step: s.id, index: k, ...l }))
  const covers = (l, h) => {
    if (l.file !== h.file) return false
    if (l.change === 'new file') return !!h.newFile
    if (l.change === 'delete' && h.deleted) return true
    if (h.whole) return l.change === 'edit' || l.change === 'delete'
    return !!l.lines && hunkInRange(h, l.lines)
  }
  const trace = locs.map(l => ({ step: l.step, file: l.file, lines: l.lines || null, symbol: l.symbol || null, change: l.change, hunks: hunks.filter(h => covers(l, h)).map(h => h.id) }))
  const planned = new Set(locs.map(l => l.file))
  const unplannedFiles = [...new Set(hunks.map(h => h.file))].filter(f => !planned.has(f))
  const unplannedHunks = hunks.filter(h => !locs.some(l => covers(l, h))).map(h => h.id)
  return { hunks, trace, unplannedFiles, unplannedHunks }
}

// The first lines a hunk adds (or, for a pure removal, removes), shortened: what the review shows.
function hunkPreview(h) {
  if (h.whole || !h.body) return null
  const added = h.body.filter(l => l.startsWith('+')).map(l => l.slice(1).trim()).filter(Boolean)
  const lines = added.length ? added : h.body.filter(l => l.startsWith('-')).map(l => l.slice(1).trim()).filter(Boolean)
  if (!lines.length) return null
  const shown = lines.slice(0, 2).map(l => (l.length > 80 ? `${l.slice(0, 77)}...` : l)).join(' / ')
  return `${added.length ? 'Adds' : 'Removes'}: ${shown}${lines.length > 2 ? ` (and ${lines.length - 2} more line${lines.length - 2 === 1 ? '' : 's'})` : ''}`
}

function hunkLabel(h) {
  if (h.whole) return `${h.file} (${h.binary ? 'binary' : h.modeOnly ? 'mode only' : 'empty file'})`
  const span = h.oldLen === 0 ? `insert after ${h.oldStart}` : `${h.oldStart}-${h.oldStart + h.oldLen - 1}`
  return `${h.file}:${span}`
}

// The diff as the judging agents see it: every hunk labelled with its ID and base range.
function annotate(hunks) {
  return hunks.map(h => h.whole
    ? `### ${h.id} ${hunkLabel(h)}`
    : `### ${h.id} ${hunkLabel(h)}\n${h.header}\n${h.body.join('\n')}`).join('\n\n')
}

function checkUnits(units, hunkIds) {
  const seen = new Map()
  for (const u of units) for (const h of u.hunks) seen.set(h, (seen.get(h) || 0) + 1)
  const problems = []
  const ids = units.map(u => u.id)
  for (const id of new Set(ids.filter((x, n) => ids.indexOf(x) !== n))) problems.push(`${id}: more than one unit has this id`)
  for (const h of hunkIds) if (!seen.has(h)) problems.push(`${h}: in no unit`)
  for (const [h, n] of seen) {
    if (!hunkIds.includes(h)) problems.push(`${h}: not a hunk`)
    else if (n > 1) problems.push(`${h}: in ${n} units`)
  }
  return problems
}

// Each judging agent must answer for every id it was given, once, and invent none.
function sameIds(label, want, got) {
  const w = [...want].sort().join(','), g = [...got].sort().join(',')
  return w === g ? [] : [`${label}: expected [${w}], got [${g}]`]
}
function adherenceCoverage(spec, adherence) {
  return sameIds('plan steps', spec.plan.steps.map(s => s.id), adherence.steps.map(s => s.id))
}
function mappingCoverage(spec, units, mapping) {
  const problems = [
    ...sameIds('done-when items', spec.done_when.map(i => i.id), mapping.items.map(i => i.id)),
    ...sameIds('constraints', spec.constraints.map(i => i.id), mapping.constraints.map(i => i.id)),
    ...sameIds('units', units.map(u => u.id), mapping.units.map(u => u.unit)),
  ]
  // The mapping answers twice, from the item's side and from the unit's; both must agree.
  const serves = new Map(mapping.units.map(u => [u.unit, new Set(u.serves)]))
  for (const i of mapping.items) {
    for (const u of i.units) if (!(serves.get(u) || new Set()).has(i.id)) problems.push(`${i.id} lists ${u}, but ${u} does not list ${i.id} among what it serves`)
    for (const [u, s] of serves) if (s.has(i.id) && !i.units.includes(u)) problems.push(`${u} serves ${i.id}, but ${i.id} does not list ${u}`)
  }
  return problems
}
function coverageProblems(spec, units, adherence, mapping) {
  return [...adherenceCoverage(spec, adherence), ...mappingCoverage(spec, units, mapping)]
}

function assemble(x) {
  const exceptions = []
  const unitServes = new Map(x.mapping.units.map(u => [u.unit, u.serves]))
  // In scope: what the goal asks (examples, constraints), what the requester agreed to (agreed
  // extras), and what an approved decision calls for (decisions). The plan's wording is not.
  const required = new Set([...x.spec.done_when.map(i => i.id), ...x.spec.constraints.map(i => i.id), ...(x.spec.agreed_extras || []).map(i => i.id), ...x.spec.decisions.map(d => d.id)])
  const agreedIds = new Set((x.spec.agreed_extras || []).map(i => i.id))
  const outOfScope = new Set(x.spec.out_of_scope.map(i => i.id))
  const unrequested = x.units.filter(u => {
    const s = unitServes.get(u.id) || []
    return !s.some(id => required.has(id)) || s.some(id => outOfScope.has(id))
  }).map(u => u.id)
  for (const t of x.unapproved) exceptions.push({ kind: 'spec_integrity', detail: `commit ${t.sha} changed the spec without approval${t.trailer ? ` (trailer: ${t.trailer})` : ''}` })
  for (const u of unrequested) exceptions.push({ kind: 'unrequested', unit: u, hunks: x.units.find(v => v.id === u).hunks })
  // A unit can serve an item and also carry changes no item needs (a rename or tidy-up
  // interleaved with the fix). Those extras are unrequested too, whatever the unit's label.
  // Each is reported on its own, at its own hunks (only the unit's; all of them if none named).
  const unitExtras = new Map(x.mapping.units.map(u => [u.unit, u.extras || []]))
  for (const u of x.units) {
    if (unrequested.includes(u.id)) continue
    for (const ex of unitExtras.get(u.id) || []) {
      const own = (ex.hunks || []).filter(h => u.hunks.includes(h))
      exceptions.push({ kind: 'unrequested', unit: u.id, hunks: own.length ? own : u.hunks, extras: [ex.text], near: ex.near || null })
    }
  }
  for (const i of x.mapping.items) if (i.status !== 'done') exceptions.push({ kind: 'item_' + i.status, item: i.id })
  for (const c of x.mapping.constraints) if (c.status !== 'held') exceptions.push({ kind: 'constraint_violated', item: c.id })
  for (const s of x.adherence.steps) if (s.status === 'not_done') exceptions.push({ kind: 'step_not_done', step: s.id })
  const explained = new Map(x.claims.deviations.map(d => [d.hunk, d.explained_by]))
  const unplanned = x.plan.unplannedHunks.map(h => ({ hunk: h, label: hunkLabel(x.plan.hunks.find(k => k.id === h)), explained_by: explained.get(h) || null }))
  for (const u of unplanned) if (!u.explained_by) exceptions.push({ kind: 'unexplained_deviation', hunks: [u.hunk], where: u.label })
  // Only a claim the change contradicts is an exception. One the change cannot show (a test run,
  // a timing) is listed for a person to confirm, without failing the check.
  for (const c of x.claims.claims) if (c.status === 'contradicted') exceptions.push({ kind: 'unsupported_claim', claim: c.text })
  for (const d of x.claims.decision_conflicts) exceptions.push({ kind: 'decision_conflict', entry: d.entry, conflicts_with: d.conflicts_with, reason: d.reason || null })
  const stepExplained = new Map()
  for (const d of x.claims.deviations) if (d.explained_by && d.step) stepExplained.set(d.step, d.explained_by)
  return {
    v: 1,
    change: x.change,
    mode: x.mode,
    head: x.head,
    dirty: x.dirty,
    spec_intact: x.unapproved.length === 0,
    approval: x.approval,
    plan: {
      unplanned_files: x.plan.unplannedFiles,
      unplanned_hunks: unplanned,
      steps: x.adherence.steps.map(s => ({ id: s.id, status: s.status, note: s.note || null, explained_by: stepExplained.get(s.id) || null })),
      trace: x.plan.trace,
    },
    hunks: x.plan.hunks.map(h => ({ id: h.id, file: h.file, old_start: h.whole ? null : h.oldStart, old_len: h.whole ? null : h.oldLen, new_start: h.whole ? null : h.newStart, new_len: h.whole ? null : h.newLen, preview: hunkPreview(h), where: hunkLabel(h) })),
    units: x.units.map(u => ({ id: u.id, summary: u.summary || null, hunks: u.hunks, serves: unitServes.get(u.id) || [], extras: (x.mapping.units.find(m => m.unit === u.id) || {}).extras || [] })),
    items: x.mapping.items,
    constraints: x.mapping.constraints,
    unrequested,
    // Units that serve an agreed extra: requested, and shown in the review as agreed extras.
    agreed: x.units.filter(u => (unitServes.get(u.id) || []).some(id => agreedIds.has(id))).map(u => u.id),
    claims: x.claims.claims,
    for_a_person: x.claims.claims.filter(c => c.status === 'unverifiable').map(c => ({ claim: c.text, why: c.evidence })),
    exceptions,
    verdict: exceptions.length === 0 ? 'aligned' : 'exceptions',
  }
}

// Judge schemas are built from the spec: every id field is an enum of exactly the ids the
// agent may use, and every list has exactly one entry per id, so an invented or misplaced id
// (an O item among the constraints, a C item among the examples) is rejected at the tool call.
const oneEach = (ids, entry) => ({ type: 'array', minItems: ids.length, maxItems: ids.length, items: entry })
// An empty enum is unsatisfiable in JSON Schema; with no ids the list is empty anyway.
const idOf = ids => (ids.length ? { type: 'string', enum: ids } : { type: 'string' })
const ADHERENCE = pIds => ({ type: 'object', properties: { steps: oneEach(pIds, { type: 'object', properties: { id: idOf(pIds), status: { type: 'string', enum: ['followed', 'deviated', 'not_done'] }, note: { type: 'string', description: 'one line of evidence' } }, required: ['id', 'status', 'note'] }) }, required: ['steps'] })
const MAPPING = (eIds, cIds, oIds, unitIds, xIds = [], dIds = [], hIds = []) => ({ type: 'object', properties: {
  units: oneEach(unitIds, { type: 'object', properties: { unit: idOf(unitIds), serves: { type: 'array', items: idOf([...eIds, ...cIds, ...oIds, ...xIds, ...dIds]) }, extras: { type: 'array', description: 'each thing this unit changes that no item needs; empty if none', items: { type: 'object', properties: { text: { type: 'string', description: 'what it changes, in one line' }, hunks: { type: 'array', minItems: 1, items: idOf(hIds) }, near: idOrNull([...eIds, ...cIds, ...oIds, ...xIds, ...dIds]) }, required: ['text', 'hunks', 'near'] } } }, required: ['unit', 'serves', 'extras'] }),
  items: oneEach(eIds, { type: 'object', properties: { id: idOf(eIds), status: { type: 'string', enum: ['done', 'missing', 'partial', 'contradicts', 'needs_a_person'] }, units: { type: 'array', items: idOf(unitIds) }, note: { type: 'string', description: 'one line of evidence' } }, required: ['id', 'status', 'units', 'note'] }),
  constraints: oneEach(cIds, { type: 'object', properties: { id: idOf(cIds), status: { type: 'string', enum: ['held', 'violated'] }, note: { type: 'string', description: 'one line of evidence' } }, required: ['id', 'status', 'note'] }),
}, required: ['units', 'items', 'constraints'] })

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

// <lib:review> copied from src/lib/review.js by tools/sync-lib.mjs; edit the source, not this copy
// The review (architecture section 8): information for a person reading the change alongside the
// code. It presents; it never tells the reader how to review. Sections: the goal, what changed and
// where, warnings (every difference from the approved spec, in a table), and the important or
// questionable decisions in full. Generated by code from the spec, the build log and the check.
// Never shows ID codes, and never refers to something by a number defined elsewhere.
// Needs the spec and build libraries.

// With { reasons: false }, the decisions are one line each and the page says where the reasons are.
function reviewPage(spec, log, check, opts = {}) {
  const hunks = new Map((check.hunks || []).map(h => [h.id, h]))
  const units = check.units || []
  const unitOfHunk = new Map(units.flatMap(u => u.hunks.map(h => [h, u])))
  const b = parseBuild(JSON.stringify(log || { v: 1, entries: [] }), spec)
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
  const all = [...spec.done_when, ...spec.constraints, ...spec.out_of_scope, ...(spec.agreed_extras || [])]
  const words = id => {
    const d = spec.decisions.find(x => x.id === id)
    if (d) return `the decision to ${oneLine(d.choice).replace(/^[A-Z]/, c => c.toLowerCase())}`
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

  // One row per difference: Item | Location | Reason | What was requested | What the outcome was.
  const row = e => {
    switch (e.kind) {
      case 'unrequested': {
        const u = units.find(x => x.id === e.unit)
        return e.extras && e.extras.length
          ? ['Change not asked for, inside a requested change', where(e.hunks), 'No example, constraint, agreed extra or approved decision asks for it.', e.near ? words(e.near) : asked(u && u.serves), [e.extras.map(x => sentence(typeof x === 'string' ? x : x.text)).join(' '), 'near' in e ? shows(e.hunks) : ''].filter(Boolean).join(' ')]
          : ['Change not asked for', where(e.hunks), (u && u.serves || []).some(x => x[0] === 'O') ? 'It does something the spec names as out of scope.' : 'No example, constraint, agreed extra or approved decision asks for it.', asked(u && u.serves), sentence(u && u.summary)]
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
        return ['Plan step not done', p ? p.locations.map(l => `${l.file}${l.lines ? `, lines ${l.lines.start}–${l.lines.end} (before the change)` : ''}`).join('; ') : '', sentence(s && s.note), sentence(p && p.does), 'Not done.']
      }
      case 'unsupported_claim': {
        const c = (check.claims || []).find(x => x.text === e.claim)
        return ["The builder's claim is contradicted", '', sentence(c && c.evidence), '', `The builder said: "${oneLine(e.claim)}"`]
      }
      case 'decision_conflict': {
        const d = b.decisions.find(x => x.id === e.entry)
        return ['A build decision goes against the spec', '', sentence(e.reason), words(e.conflicts_with), d ? sentence(d.choice) : '']
      }
      case 'spec_integrity': return ['The approved spec was changed without approval', '', sentence(e.detail), 'The spec as approved.', 'Changed by a later commit.']
      default: return [e.kind, '', '', '', '']
    }
  }

  const parts = [`# Review: ${spec.title || spec.change}`, `## Goal\n\n${spec.goal}`]

  // What changed, each change once, with where it is in the changed code.
  parts.push(`## What changed\n\n${units.length ? units.map(u => `- ${sentence(u.summary || 'A change')} *${where(u.hunks)}*`).join('\n') : 'Nothing.'}`)
  // What the scout saw that no example exercises, and the defects it found off the path, which this
  // change leaves alone: the reviewer should know both before reading on.
  if (spec.review_focus && spec.review_focus.length) parts.push(reviewFocusSection(spec))
  if (spec.follow_ups && spec.follow_ups.length) parts.push(followUpsSection(spec))

  // A change outside the plan that the builder explained is not an exception, but it is still a
  // difference from the approved plan: it is shown with the builder's own reason.
  const cap = t => (/^[a-z]+[\s,:;]/.test(t) ? t.replace(/^[a-z]/, x => x.toUpperCase()) : t) // a file or code name keeps its case
  const logged = id => [...b.deviations, ...b.decisions].find(x => x.id === id)
  const explainedRows = ((check.plan && check.plan.unplanned_hunks) || []).filter(u => u.explained_by).map(u => {
    const h = hunks.get(u.hunk); const l = logged(u.explained_by); const u2 = unitOfHunk.get(u.hunk)
    const reason = !l ? 'The builder logged a reason.' : l.kind === 'deviation' ? `The builder's logged reason: ${cap(sentence(l.because))}` : `The builder's logged decision: ${cap(sentence(l.choice))} ${cap(sentence(l.because))}`
    return ['Changed outside the plan, with a reason', at(u.hunk), reason, planned(h ? h.file : ''), shows([u.hunk]) || sentence(u2 && u2.summary)]
  })

  // Warnings: the summary, how complete the check was, then every difference.
  const n = (check.exceptions || []).length + explainedRows.length
  const total = (check.hunks || []).length
  const files = new Set((check.hunks || []).map(h => h.file)).size
  const summary = check.verdict === 'error'
    ? `**The check could not complete:** ${check.error ? sentence(check.error.reason) : 'reason unknown.'} Nothing below has been checked.`
    : n === 0
      ? '**No differences from the approved spec were found.**'
      : `**${n} difference${n === 1 ? '' : 's'} from the approved spec.**`
  const coverage = check.verdict === 'error' ? '' : `All ${total} changed place${total === 1 ? '' : 's'}, in ${files} file${files === 1 ? '' : 's'}, were checked against the spec; none was left unaccounted for. The check judges what the change does, not whether the code is correct beyond the examples.`
  const warnings = [summary, coverage]
  if (n) warnings.push(table(['Item', 'Location', 'Reason', 'What was requested', 'What the outcome was'], [...(check.exceptions || []).map(row), ...explainedRows]))
  if (check.for_a_person && check.for_a_person.length) warnings.push(`**Not verified.** The builder says the following, and the change alone cannot show it. The person who ran the build should confirm it:\n\n${check.for_a_person.map(c => `- "${oneLine(c.claim)}" ${sentence(c.why)}`).join('\n')}`)
  parts.push(`## Warnings\n\n${warnings.filter(Boolean).join('\n\n')}`)

  // Decisions: the judgment calls of the spec and the builder's own, in full.
  const decision = (d, origin) => [`### ${sentence(d.choice)}`, ...decisionLines(d, origin)].join('\n')
  const brief = (d, origin) => `- ${sentence(d.choice)} ${origin}`
  const calls = spec.decisions.filter(d => d.judgment !== false)
  if (opts.reasons === false) {
    const lines = [...calls.map(d => brief(d, 'Made while planning.')), ...b.decisions.map(d => brief(d, 'Made while building.'))]
    parts.push(`## Decisions\n\nThe choices a competent developer could have made another way.\n\n${lines.length ? `${lines.join('\n')}\n\n${reasonsLeftOut(['scout.json', 'plan.json', 'build.json'])}` : 'None.'}`)
  } else {
    parts.push(`## Decisions\n\nThe choices a competent developer could have made another way, with the reasoning behind each.\n\n${[...calls.map(d => decision(d, 'Made while planning.')), ...b.decisions.map(d => decision(d, 'Made while building.'))].join('\n\n') || 'None.'}`)
  }
  return parts.join('\n\n') + '\n'
}
// </lib:review>

// The claims judge answers only with ids that exist: unplanned hunk ids, the log's deviation
// ids (or null), plan step ids (or null), claim ids, decision ids and the spec's D and C ids.
const idOrNull = ids => (ids.length ? { type: ['string', 'null'], enum: [...ids, null] } : { type: 'null' })
const CLAIMS = (hunkIds, devIds, stepIds, claimIds, decisionIds, dcIds) => ({ type: 'object', properties: {
  deviations: oneEach(hunkIds, { type: 'object', properties: { hunk: idOf(hunkIds), explained_by: idOrNull([...devIds, ...decisionIds]), step: idOrNull(stepIds) }, required: ['hunk', 'explained_by', 'step'] }),
  claims: oneEach(claimIds, { type: 'object', properties: { id: idOf(claimIds), status: { type: 'string', enum: ['supported', 'contradicted', 'unverifiable'], description: 'unverifiable when the change cannot show it either way, such as a test run' }, evidence: { type: 'string', description: 'one line' } }, required: ['id', 'status', 'evidence'] }),
  decision_conflicts: { type: 'array', maxItems: decisionIds.length ? decisionIds.length * Math.max(1, dcIds.length) : 0, items: { type: 'object', properties: { entry: idOf(decisionIds), conflicts_with: idOf(dcIds), reason: { type: 'string', description: 'one line' } }, required: ['entry', 'conflicts_with', 'reason'] } },
}, required: ['deviations', 'claims', 'decision_conflicts'] })

function claimsCoverage(hunkIds, claimIds, r) {
  return [
    ...sameIds('unplanned hunks', hunkIds, r.deviations.map(d => d.hunk)),
    ...sameIds('claims', claimIds, r.claims.map(c => c.id)),
  ]
}

// </pure>

// ---- schemas for agent outputs ----
const str = d => ({ type: 'string', description: d })
// refused separates a command that was never allowed to run from one that ran and printed nothing:
// both give an empty string, and two matching empty relays would otherwise pass as an empty change.
const RELAY = keys => ({ type: 'object', properties: { ...Object.fromEntries(keys.map(k => [k, str(`stdout of the command labelled ${k}, verbatim`)])), refused: { type: 'array', items: { type: 'string', enum: keys }, description: 'labels of commands you were not allowed to run (refused, denied, or waiting for approval); empty if all ran' } }, required: [...keys, 'refused'] })
const UNITS = { type: 'object', properties: { units: { type: 'array', items: { type: 'object', properties: { id: str('U1, U2, ...'), summary: str('one line: what this unit does'), hunks: { type: 'array', items: str('hunk id') } }, required: ['id', 'summary', 'hunks'] } } }, required: ['units'] }


const RELAY_PROMPT = cmds => `Run these commands in the current directory, exactly as written, one at a time, and return each one's standard output verbatim under its label: every character and newline, nothing added, removed or summarised. Return standard output only: never an error message the command printed instead. If a command prints nothing to standard output, or fails, return an empty string for it. If you were not allowed to run a command (it was refused, denied, or needs approval), return an empty string for it and list its label under refused; a command that ran and exited with an error is not refused.\n\n${cmds.map(([k, c]) => `${k}: ${c}`).join('\n')}`

const { change, mode } = parseArgs(args)
const DIFF = `git -c core.quotepath=false diff --no-renames --no-color --no-ext-diff`
const specPath = `.rbb/${change}/spec.json`
const outPath = `.rbb/${change}/check.json`

async function relay(label, cmds) {
  // Nothing to run: nothing to relay, and no schema with an empty enum, which the host rejects.
  if (!cmds.length) return { out: {}, attempts: 0 }
  const keys = cmds.map(([k]) => k)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [a, b] = await parallel([1, 2].map(i => () => agent(RELAY_PROMPT(cmds), { label: `${label} ${attempt}.${i}`, phase: 'Facts', agentType: 'rbb:checker', effort: 'low', schema: RELAY(keys) })))
    const refused = [...new Set([...((a && a.refused) || []), ...((b && b.refused) || [])])]
    if (refused.length) return { refused: refused.map(k => cmds.find(([l]) => l === k)[1]) }
    if (a && b && keys.every(k => canon(a[k]) === canon(b[k]))) return { out: Object.fromEntries(keys.map(k => [k, canon(a[k])])), attempts: attempt }
    log(`${label}: the two relays differ (attempt ${attempt})`)
  }
  return null
}

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

// check.json is compared as data, so formatting differences in the read-back don't matter.
function record(result) {
  const sameData = t => { try { return JSON.stringify(JSON.parse(t)) === JSON.stringify(result) } catch (e) { return false } }
  return recordFile(outPath, JSON.stringify(result, null, 2) + '\n', 'Record', sameData)
}

async function fail(stage, reason, extra) {
  const result = { v: 1, change, mode, verdict: 'error', error: { stage, reason }, ...(extra || {}) }
  result.recorded = await record(result)
  return result
}

if (!change) throw new Error('rbb:check needs a change name')

phase('Facts')
// Documents mode (architecture 9.1). In mode none the spec and the build log are local, ignored
// files: each is read twice and compared, like the git facts, and the spec must have the approved hash.
const cfgBack = await agent('Read the file .rbb/config.json and return its content verbatim, without line numbers. If it does not exist, return an empty string.', { label: 'read config', phase: 'Facts', agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })
let config = null
try { config = cfgBack && cfgBack.content.trim() ? JSON.parse(cfgBack.content) : null } catch (e) { config = null }
const none = documentsMode(config) === 'none'
async function readTwice(file, label) {
  const [a, b] = await parallel([1, 2].map(i => () => agent(`Read the file ${file} and return its content verbatim, without line numbers. If it does not exist, return an empty string.`, { label: `${label} ${i}`, phase: 'Facts', agentType: 'rbb:checker', effort: 'low', schema: READBACK_SCHEMA })))
  return a && b && canon(a.content) === canon(b.content) ? canon(a.content) : null
}

// The spec is its manifest and the files it names (architecture 5.2.1); its integrity covers them all.
const specPaths = SPEC_FILES.map(f => `.rbb/${change}/${f}`)
const factsA = await relay('head and approvals', [
  ['head', 'git rev-parse HEAD'],
  ['status', `git status --porcelain=v1 -uall -- . ':(exclude).rbb'`],
  ...(none ? [] : [
    ['log', `git log --format='%H %(trailers:key=RBB-Approved,valueonly,separator=%x2C)' -- ${specPaths.join(' ')}`],
    ['build', `git show HEAD:.rbb/${change}/build.json`],
    ['build_meta', `git show HEAD:.rbb/${change}/build-meta.json`],
  ]),
])
if (factsA && factsA.refused) return await fail('permission', `these read-only commands were not allowed to run; allow them and run the check again: ${factsA.refused.join(' ; ')}`)
if (!factsA) return await fail('facts', 'relays of HEAD, status and the approval log never matched')

let approvals, specText, buildText, factsB = null
if (none) {
  let approval = null
  try { approval = JSON.parse(await readTwice(`.rbb/${change}/approval.json`, 'approval')) } catch (e) { approval = null }
  if (approvalProblems(approval, change).length) return await fail('facts', `no valid approval for ${change}: approve the spec first`, { approval_problems: approvalProblems(approval, change) })
  // The files the approval froze are hashed again: the manifest at approval time names them.
  const hashed = await relay('spec hashes', [['hash', `git hash-object ${hashedFiles(approval).map(f => `.rbb/${change}/${f}`).join(' ')}`]])
  if (hashed && hashed.refused) return await fail('permission', `these read-only commands were not allowed to run; allow them and run the check again: ${hashed.refused.join(' ; ')}`)
  if (!hashed) return await fail('facts', 'relays of the spec hashes never matched')
  const changed = changedSpecFiles(approval, hashed.out.hash)
  if (changed.length) return await fail('spec', `the spec changed after it was approved: ${changed.join(', ')} no longer has its approved hash`)
  const texts = await parallel(SPEC_FILES.map(f => () => readTwice(`.rbb/${change}/${f}`, f)))
  if (texts.some(t => t === null)) return await fail('facts', 'the two reads of a spec file never matched')
  specText = Object.fromEntries(SPEC_FILES.map((f, n) => [f, texts[n]]))
  buildText = buildLogText((await readTwice(`.rbb/${change}/build.json`, 'build log')) || '', (await readTwice(`.rbb/${change}/build-meta.json`, 'build meta')) || '')
  approvals = { latest: `spec hashes, ${approval.hashes['spec.json'].slice(0, 10)}`, unapproved: [] }
} else {
  approvals = parseLog(factsA.out.log, change)
  if (!approvals.latest) return await fail('facts', `no approval commit for ${change}: the spec has no commit with the trailer RBB-Approved: ${change}`)
  factsB = await relay('spec', SPEC_FILES.map((f, n) => [`f${n}`, `git show ${approvals.latest}:.rbb/${change}/${f}`]))
  if (factsB && factsB.refused) return await fail('permission', `these read-only commands were not allowed to run; allow them and run the check again: ${factsB.refused.join(' ; ')}`)
  if (!factsB) return await fail('facts', 'relays of the approved spec never matched')
  specText = Object.fromEntries(SPEC_FILES.map((f, n) => [f, factsB.out[`f${n}`]]))
  buildText = buildLogText(factsA.out.build, factsA.out.build_meta)
}
const builtSpec = specFromTexts(change, specText)
if (!builtSpec.spec) return await fail('spec', `the approved spec could not be rebuilt: ${builtSpec.error}`)
const spec = builtSpec.spec
const specErrors = validateSpec(spec, change)
if (specErrors.length) return await fail('spec', 'the approved spec does not meet the schema', { spec_errors: specErrors })

const factsC = await relay('diff', [
  ['diff', `${DIFF} -U0 ${spec.base} HEAD -- . ':(exclude).rbb'`],
  ['numstat', `${DIFF} --numstat ${spec.base} HEAD -- . ':(exclude).rbb'`],
])
if (factsC && factsC.refused) return await fail('permission', `these read-only commands were not allowed to run; allow them and run the check again: ${factsC.refused.join(' ; ')}`)
if (!factsC) return await fail('facts', 'relays of the diff never matched')
let diffFiles, numstat
try { diffFiles = parseDiff(factsC.out.diff); numstat = parseNumstat(factsC.out.numstat) } catch (e) { return await fail('facts', e.message) }
const crossProblems = crossCheck(diffFiles, numstat)
if (crossProblems.length) return await fail('facts', 'the diff and numstat disagree', { cross_check: crossProblems })

const plan = planFacts(spec, diffFiles)
const diffView = annotate(plan.hunks)
const hunkIds = plan.hunks.map(h => h.id)
const specView = JSON.stringify({ goal: spec.goal, done_when: spec.done_when, constraints: spec.constraints, out_of_scope: spec.out_of_scope, agreed_extras: spec.agreed_extras || [], decisions: spec.decisions, plan: spec.plan }, null, 2)
log(`${plan.hunks.length} hunks; ${plan.unplannedHunks.length} outside the plan`)

phase('Judge')
let units
if (mode === 'per-hunk') {
  units = plan.hunks.map(h => ({ id: h.id, summary: null, hunks: [h.id] }))
} else {
  for (let attempt = 1; attempt <= 2 && !units; attempt++) {
    const g = await agent(`Group these hunks into logical units: one unit per coherent change (one behaviour, one refactor, one doc entry). Every hunk must be in exactly one unit. Give each unit an id (U1, U2, ...) and a one-line summary of what it does.\n\nThe change, each hunk labelled with its id and its range in the base commit:\n\n${diffView}`, { label: `group ${attempt}`, phase: 'Judge', agentType: 'rbb:checker', effort: 'high', schema: UNITS })
    if (g && checkUnits(g.units, hunkIds).length === 0) units = g.units
    else log(`grouping attempt ${attempt} did not cover every hunk exactly once`)
  }
  if (!units) return await fail('grouping', 'no grouping covered every hunk exactly once')
}
const unitView = units.map(u => `${u.id}${u.summary ? `: ${u.summary}` : ''} [${u.hunks.join(', ')}]`).join('\n')

// Each judge answers through a schema built from the spec; if its answer still fails the
// coverage backstop, that judge alone runs once more before the check ends in an error.
async function judge(label, effort, prompt, schema, problemsOf) {
  let last = ['returned nothing']
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await agent(prompt, { label: attempt === 1 ? label : `${label} (retry)`, phase: 'Judge', agentType: 'rbb:checker', effort, schema })
    if (r && (last = problemsOf(r)).length === 0) return { r, attempts: attempt }
    log(`${label}: ${last.join('; ')}`)
  }
  return { r: null, problems: last }
}
const eIds = spec.done_when.map(i => i.id), cIds = spec.constraints.map(i => i.id), oIds = spec.out_of_scope.map(i => i.id)
const [adh, map] = await parallel([
  () => judge('plan adherence', 'medium', ADHERENCE_PROMPT(), ADHERENCE(spec.plan.steps.map(s => s.id)), r => adherenceCoverage(spec, r)),
  () => judge('spec mapping', 'high', MAPPING_PROMPT(), MAPPING(eIds, cIds, oIds, units.map(u => u.id), (spec.agreed_extras || []).map(i => i.id), spec.decisions.map(d => d.id), plan.hunks.map(h => h.id)), r => mappingCoverage(spec, units, r)),
])
if (!adh || !adh.r || !map || !map.r) return await fail('judge', 'a judging agent did not cover every id exactly once', { coverage: [...((adh && adh.problems) || []), ...((map && map.problems) || [])] })
const adherence = adh.r, mapping = map.r

function ADHERENCE_PROMPT() { return `Judge whether the change followed each step of the approved plan. Use only the plan, the change and the trace below.\n\nFor each plan step: followed (its changes are made at the locations it named), deviated (it was done, but partly or wholly elsewhere or otherwise than planned), or not_done (its changes are absent). Give one line of evidence each. The evidence is shown to people: name code by file, line and function, and the spec's items in words, never by an id such as a hunk, step or item code.\n\nThe approved spec and plan:\n${specView}\n\nWhich hunks touched each planned location (computed by code):\n${JSON.stringify(plan.trace, null, 2)}\n\nHunks outside every planned location: ${plan.unplannedHunks.join(', ') || 'none'}\n\nThe change:\n\n${diffView}` }
function MAPPING_PROMPT() { return `Map the change to the approved spec, starting from the spec's side.\n\n- For each done-when item (E…): done, missing, partial or contradicts, or needs_a_person when the change alone cannot settle it, with the ${mode === 'per-hunk' ? 'hunks' : 'units'} that serve it.\n- For each constraint (C…): held or violated by the change.\n- For each ${mode === 'per-hunk' ? 'hunk' : 'unit'}: the E, C, O, X or D items it serves. A change an approved decision (D…) calls for serves that decision. An agreed extra (X…) is something the requester agreed to beyond the request; a ${mode === 'per-hunk' ? 'hunk' : 'unit'} that does one serves it. A ${mode === 'per-hunk' ? 'hunk' : 'unit'} serves an item only if the item needs it; a change that is merely nearby, or a tidy-up nobody asked for, serves nothing. List an out-of-scope item (O…) only if the ${mode === 'per-hunk' ? 'hunk' : 'unit'} does what that item excludes. Leave the list empty if it serves nothing. Only the goal, the requester's words (constraints and agreed extras) or an approved decision make a change in scope; the plan's wording does not.
- When code satisfies an example, check whether it is general or matches only that example's input; code that special-cases the example does not meet it.
- For each ${mode === 'per-hunk' ? 'hunk' : 'unit'}, also list its extras: each thing it changes that no item needs, even when the rest of it serves an item. Renaming, reformatting, rewording or restructuring code the change did not need is an extra; so is any behaviour no item asks for. For each extra, give the hunks it is in, and the item it sits next to, or none. New code that the change needs, with comments and docstrings that explain it, is not an extra. In extras and notes, refer to items in words ("the fourth decision"), never by their codes.\n\nThe approved spec:\n${specView}\n\n${mode === 'per-hunk' ? '' : `The units:\n${unitView}\n\n`}The change:\n\n${diffView}` }

// The builder's log was relayed with the git facts from committed HEAD (section 7.1); this step
// is the first and only one that sees it (ADR-005).
const build = parseBuild(buildText, spec)
if (build.errors.length) return await fail('build', 'the builder log at HEAD does not meet its format', { build_errors: build.errors })
const devIds = build.deviations.map(d => d.id), claimIds = build.claims.map(c => c.id), decisionIds = build.decisions.map(d => d.id)
let claims = { deviations: [], claims: [], decision_conflicts: [] }
if (plan.unplannedHunks.length || claimIds.length || decisionIds.length) {
  const logView = JSON.stringify({ deviations: build.deviations, decisions: build.decisions, claims: build.claims }, null, 2)
  const r = await judge('claims', 'high', `You are the last step of the check. Below is the builder's own log, as committed. Verify it; do not trust it.\n\n1. For each hunk outside the plan (${plan.unplannedHunks.join(', ') || 'none'}): the id of the logged deviation, or of the logged decision, that explains it, and the plan step it departs from; null for both if nothing logged explains it. A decision explains a hunk only if it names this place or what was put there, not merely the same topic.\n2. For each logged claim, by its id: supported or contradicted by the change and the verdicts below, or unverifiable when the change cannot show it either way (a test run, a timing, behaviour outside the diff), with one line of evidence. The evidence is shown to people: name code by file, line and function, and the spec's items in words, never by an id such as a hunk, step or item code.\n3. For each logged decision: list it only if it conflicts with a decision (D…) or constraint (C…) of the approved spec.\n\nThe builder's log:\n${logView}\n\nThe approved spec:\n${specView}\n\nVerdicts already fixed (do not change them):\nplan adherence: ${JSON.stringify(adherence.steps)}\nspec mapping: ${JSON.stringify(mapping.items)}\nconstraints: ${JSON.stringify(mapping.constraints)}\n\nThe change:\n\n${diffView}`,
    CLAIMS(plan.unplannedHunks, devIds, spec.plan.steps.map(x => x.id), claimIds, decisionIds, [...spec.decisions.map(d => d.id), ...cIds]),
    x => claimsCoverage(plan.unplannedHunks, claimIds, x))
  if (!r.r) return await fail('claims', 'the claims judge did not answer for every unplanned hunk and claim', { coverage: r.problems })
  const text = new Map(build.claims.map(c => [c.id, c.text]))
  claims = { ...r.r, claims: r.r.claims.map(c => ({ id: c.id, text: text.get(c.id), status: c.status, evidence: c.evidence })) }
}

const result = assemble({
  change, mode, spec, units, adherence, mapping, claims, plan,
  head: factsA.out.head.trim(),
  dirty: factsA.out.status.trim().length > 0,
  approval: approvals.latest,
  unapproved: approvals.unapproved,
})
result.facts_attempts = { head: factsA.attempts, spec: factsB ? factsB.attempts : null, diff: factsC.attempts }
result.documents = none ? 'none' : 'committed'

phase('Record')
result.recorded = await record(result)
if (!result.recorded) log('check.json could not be verified after two writes')
// The review page, generated by code from the spec, the build log and this result: what the
// skill shows the requester, exactly as written.
let buildLog = null
try { buildLog = buildText.trim() ? JSON.parse(buildText) : null } catch (e) { buildLog = null }
result.review = `.rbb/${change}/review.md`
// 'full', or 'reduced' (without the reasoning) when the full page's save is refused (architecture 5.2.1).
result.review_recorded = await recordPage(result.review, reviewPage(spec, buildLog, result), reviewPage(spec, buildLog, result, { reasons: false }), 'Record')
return result
