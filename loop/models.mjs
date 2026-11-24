// Model allocation policy: "the review side is strongest". Checking is cheaper and more reliable than
// producing, so a modest writer under a strong, independent checker converges, while a weak reviewer lets
// bugs through with false confidence. Three tiers (cheap < strong < top) are mapped onto the keys the
// delivery-loop plugin ALREADY reads from .claude/delivery.conf (MODEL_IMPLEMENT_S/_M/_L, MODEL_REVIEW,
// MODEL_REREVIEW, MODEL_PATCH, REREVIEW_SCOPE). The plugin passes each value to the Agent tool's `model`
// input, which takes Claude Code model aliases (sonnet, opus, fable, haiku); empty means "inherit the session
// model". Nothing here writes anywhere: it computes the values and the exact diff for a human (or a loop
// task) to apply.
import { CONF_PATH, parseConf } from './conf.mjs';

export const MODEL_KEYS = ['MODEL_IMPLEMENT_S', 'MODEL_IMPLEMENT_M', 'MODEL_IMPLEMENT_L', 'MODEL_REVIEW', 'MODEL_REREVIEW', 'MODEL_PATCH', 'REREVIEW_SCOPE'];
export const TIERS = ['cheap', 'strong', 'top'];
export const DEFAULT_TIERS = { cheap: 'sonnet', strong: 'opus', top: 'fable' };
const RANK = { cheap: 1, strong: 2, top: 3 };
const ROLE = {
  MODEL_IMPLEMENT_S: 'Implementer, size:S', MODEL_IMPLEMENT_M: 'Implementer, size:M', MODEL_IMPLEMENT_L: 'Implementer, size:L',
  MODEL_REVIEW: 'Reviewer, first review', MODEL_REREVIEW: 'Reviewer, after a patch', MODEL_PATCH: 'Patcher (after a failed review or red CI)', REREVIEW_SCOPE: 'Re-review scope',
};
const IMPLEMENT = ['MODEL_IMPLEMENT_S', 'MODEL_IMPLEMENT_M', 'MODEL_IMPLEMENT_L'];
const REVIEW = ['MODEL_REVIEW', 'MODEL_REREVIEW'];
const WHY = {
  MODEL_IMPLEMENT_S: 'Small tasks inside lint, types and tests: a cheaper writer, checked by the gate and a stronger reviewer.',
  MODEL_IMPLEMENT_M: 'Same. Raise it for hard or novel work (algorithms, concurrency, unfamiliar domains), where a weak writer costs more in retries than it saves.',
  MODEL_IMPLEMENT_L: 'Large work needs a stronger writer (size:L is normally split before anyone claims it).',
  MODEL_REVIEW: 'The first, independent review is the control. The plugin cannot tell a risky change from a safe one, so every first review gets this tier.',
  MODEL_REREVIEW: 'A narrow re-review of an incremental diff: still never weaker than the writer.',
  MODEL_PATCH: 'Escalation: once the cheap writer has failed review or CI, a stronger model fixes it.',
  REREVIEW_SCOPE: 'Keeps the re-review affordable: only the incremental diff, the failing criteria and the full gate.',
};

/** role -> tier, per preset. `planner` is the chat (and spec authoring / decompose, which you run with it). */
export const PRESETS = {
  balanced: { title: 'Balanced', cost: '$$', note: 'Top model plans and does the first review; strong re-reviews and patches; cheap implements.',
    planner: 'top', MODEL_IMPLEMENT_S: 'cheap', MODEL_IMPLEMENT_M: 'cheap', MODEL_IMPLEMENT_L: 'strong', MODEL_REVIEW: 'top', MODEL_REREVIEW: 'strong', MODEL_PATCH: 'strong' },
  frugal: { title: 'Frugal', cost: '$', note: 'Strong model plans and reviews; cheap implements. No top-tier spend.',
    planner: 'strong', MODEL_IMPLEMENT_S: 'cheap', MODEL_IMPLEMENT_M: 'cheap', MODEL_IMPLEMENT_L: 'strong', MODEL_REVIEW: 'strong', MODEL_REREVIEW: 'strong', MODEL_PATCH: 'strong' },
  max: { title: 'Max quality', cost: '$$$', note: 'Top model plans, reviews, re-reviews, patches and writes large tasks; cheap only for small ones.',
    planner: 'top', MODEL_IMPLEMENT_S: 'cheap', MODEL_IMPLEMENT_M: 'cheap', MODEL_IMPLEMENT_L: 'top', MODEL_REVIEW: 'top', MODEL_REREVIEW: 'top', MODEL_PATCH: 'top' },
};
export const DEFAULT_PRESET = 'balanced';

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]\/-]{0,99}$/;
/** Alias the Agent tool accepts for a model id or alias ("claude-opus-5-5" -> "opus"); '' when it is not a known family. */
export const aliasOf = (m) => ALIASES.find((a) => String(m || '').toLowerCase() === a || String(m || '').toLowerCase().includes(`-${a}-`)) || '';
const same = (a, b) => !!a && !!b && (String(a).toLowerCase() === String(b).toLowerCase() || (aliasOf(a) && aliasOf(a) === aliasOf(b)));

/** Validate and complete a { cheap, strong, top } choice. Throws on anything that is not a plain model name. */
export function checkTiers(t = {}) {
  const out = { ...DEFAULT_TIERS };
  for (const k of TIERS) {
    const v = String(t[k] ?? '').trim();
    if (!v) continue;
    if (!MODEL_RE.test(v)) throw new Error(`"${v}" does not look like a model name.`);
    out[k] = v;
  }
  return out;
}
/** Which tier a configured value belongs to: 'cheap' | 'strong' | 'top' | '' (inherit, or a model outside the tiers). */
export const tierOf = (value, tiers) => [...TIERS].reverse().find((t) => same(value, tiers[t])) || '';
/** Full model id for an alias, from the ids the credential offers ("opus" -> "claude-opus-5-5"); the value itself if it is already an id. */
export const resolveId = (value, ids = []) => (!value ? '' : ids.find((i) => i.toLowerCase() === String(value).toLowerCase()) || ids.find((i) => aliasOf(i) && aliasOf(i) === aliasOf(value) && aliasOf(value) === String(value).toLowerCase()) || String(value));

/** Recommended delivery.conf values for a preset, with tier and reason. */
export function recommended({ preset = DEFAULT_PRESET, tiers = DEFAULT_TIERS } = {}) {
  const p = PRESETS[preset] || PRESETS[DEFAULT_PRESET];
  const out = {};
  for (const k of MODEL_KEYS) out[k] = k === 'REREVIEW_SCOPE' ? { value: 'narrow', tier: '', why: WHY[k] } : { value: tiers[p[k]], tier: p[k], why: WHY[k] };
  return out;
}

/**
 * The rule the whole policy rests on: a reviewer is never a lower tier than an implementer, and ideally a
 * different model. `values` is { MODEL_*: model }. Returns [{ level: 'error'|'warn', message }].
 */
export function validate(values, tiers) {
  const out = [];
  const tier = (k) => tierOf(values[k], tiers);
  const short = (k) => k.replace('MODEL_', '');
  for (const r of REVIEW) {
    if (!values[r]) { out.push({ level: 'warn', message: `${short(r)} is empty: the reviewer inherits the session model, so its tier is unknown and it may be the same model as the writer.` }); continue; }
    if (!tier(r)) { out.push({ level: 'warn', message: `${short(r)}="${values[r]}" is not one of the three tiers, so it cannot be compared with the writers.` }); continue; }
    for (const i of IMPLEMENT) {
      if (!tier(i)) continue;
      if (RANK[tier(r)] < RANK[tier(i)]) out.push({ level: 'error', message: `${short(r)} (${tier(r)}: ${values[r]}) is a lower tier than ${short(i)} (${tier(i)}: ${values[i]}). A weak reviewer over a strong writer lets bugs through with false confidence.` });
      else if (same(values[r], values[i]) && i !== 'MODEL_IMPLEMENT_L') out.push({ level: 'warn', message: `${short(r)} and ${short(i)} are the same model (${values[r]}): the review is independent in context only.` });
    }
  }
  for (const i of IMPLEMENT) if (!values[i]) { out.push({ level: 'warn', message: 'An implementer key is empty: that writer inherits the session model, so the reviewer may not outrank it.' }); break; }
  if (RANK.cheap && same(tiers.cheap, tiers.strong)) out.push({ level: 'warn', message: 'CHEAP_MODEL and STRONG_MODEL are the same model.' });
  if (same(tiers.strong, tiers.top)) out.push({ level: 'warn', message: 'STRONG_MODEL and TOP_MODEL are the same model.' });
  return out.filter((x, n, a) => a.findIndex((y) => y.message === x.message) === n);
}

/** Replace or append KEY="value" lines, keeping everything else in the file as it is. */
export function applyToConf(text, changes) {
  const lines = String(text ?? '').split(/\r?\n/);
  const left = new Map(Object.entries(changes));
  const out = lines.map((l) => {
    const m = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
    if (!m || !left.has(m[2])) return l;
    const v = left.get(m[2]); left.delete(m[2]);
    const comment = /^(?:"[^"]*"|'[^']*'|\S*)(\s+#.*)$/.exec(m[3])?.[1] || '';
    return `${m[1]}${m[2]}="${v}"${comment}`;
  });
  if (left.size) {
    if (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('', '# Model allocation: the review side is strongest (set from gh-board).', ...[...left].map(([k, v]) => `${k}="${v}"`), '');
  }
  return out.join('\n');
}

/** Line diff of the conf before and after. applyToConf only rewrites lines in place or appends, so an index walk is exact. */
export function diffLines(before, after, path = CONF_PATH) {
  const a = String(before ?? '').split(/\r?\n/); const b = String(after ?? '').split(/\r?\n/);
  const out = []; let last = -2;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (i !== last + 1) out.push(`@@ line ${i + 1} @@`); // one header per run of changed lines
    last = i;
    if (a[i] !== undefined && !(a[i] === '' && i === a.length - 1)) out.push(`-${a[i]}`);
    if (b[i] !== undefined && !(b[i] === '' && i === b.length - 1)) out.push(`+${b[i]}`);
  }
  return out.length ? [`--- a/${path}`, `+++ b/${path}`, ...out].join('\n') : '';
}

/**
 * The Model policy panel.
 *   reader     { read(path) }
 *   tiers      { cheap, strong, top } for this repo (already merged with the .env defaults)
 *   preset     'balanced' | 'frugal' | 'max'
 *   available  { ids: string[], verified: boolean } - model ids this credential can use
 *   risky      [{ number, title, why }] open tasks labeled risk:high or in a module marked sensitive
 */
export async function modelPolicy(reader, { tiers = DEFAULT_TIERS, preset = DEFAULT_PRESET, available = { ids: [], verified: false }, billing = 'subscription', plannerModel = '', risky = [], sensitive = [] } = {}) {
  tiers = checkTiers(tiers);
  if (!PRESETS[preset]) preset = DEFAULT_PRESET;
  const text = await reader.read(CONF_PATH);
  const { values, set } = parseConf(text);
  const rec = recommended({ preset, tiers });
  const rows = MODEL_KEYS.map((k) => ({
    key: k, role: ROLE[k], current: values[k] || '', inFile: set.has(k), currentTier: k === 'REREVIEW_SCOPE' ? '' : tierOf(values[k], tiers), currentId: k === 'REREVIEW_SCOPE' ? '' : resolveId(values[k], available.ids),
    recommended: rec[k].value, tier: rec[k].tier, id: k === 'REREVIEW_SCOPE' ? '' : resolveId(rec[k].value, available.ids), why: rec[k].why, matches: (values[k] || '') === rec[k].value,
  }));
  const changes = Object.fromEntries(rows.filter((r) => !r.matches).map((r) => [r.key, r.recommended]));
  const next = text === null ? null : applyToConf(text, changes);
  const families = new Set(available.ids.map(aliasOf).filter(Boolean));
  const usable = (m) => !available.ids.length || available.ids.some((i) => i.toLowerCase() === String(m).toLowerCase()) || families.has(aliasOf(m));
  const plannerTier = PRESETS[preset].planner;
  const reviewTier = PRESETS[preset].MODEL_REVIEW;

  const notes = [];
  if (text === null) notes.push('This repo has no .claude/delivery.conf yet. Run setup first; the policy is applied to that file.');
  if (!available.verified) notes.push(`Model access is not verified: a Claude ${billing === 'api' ? 'API key' : 'subscription'} sign-in has no free way to list models. "Test models" sends one tiny prompt per tier to find out.`);
  for (const t of TIERS) if (!usable(tiers[t])) notes.push(`${t}: "${tiers[t]}" was not found among the models this credential offers.`);
  if (reviewTier === 'top') notes.push(billing === 'api'
    ? `Cost: every first review runs on the top model ("${tiers.top}"), billed per token at the highest rate. A review reads a diff and runs commands, so it is much smaller than the implementation it checks, but it happens on every PR.`
    : `Cost: every first review runs on the top model ("${tiers.top}"), which draws down a subscription's usage limits fastest. If reviews stall on rate limits, switch this repo to Frugal.`);
  else notes.push(`Cost: no top-tier spend in the loop under this preset. Risky changes are reviewed by "${tiers.strong}" like everything else.`);
  notes.push('Escalation gap: the plugin has no "escalate after two failed gate runs" rule and no per-task review tier. MODEL_PATCH applies from the first patch round, and MODEL_REVIEW applies to every PR. See docs/PLATFORM.md (Model allocation) for the proposed plugin changes.');

  return {
    initialized: text !== null, preset, presets: Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, cost: p.cost, note: p.note })),
    tiers, tierIds: Object.fromEntries(TIERS.map((t) => [t, resolveId(tiers[t], available.ids)])),
    rows, changes, inPolicy: Object.keys(changes).length === 0,
    // Problems with what is in the file today, and with what the preset would write (the latter only if tiers were set oddly).
    problems: validate(values, tiers), presetProblems: validate(Object.fromEntries(MODEL_KEYS.map((k) => [k, rec[k].value])), tiers).filter((p) => p.level === 'error'),
    diff: next === null ? '' : diffLines(text, next), path: CONF_PATH, available, notes,
    planner: { model: plannerModel || tiers[plannerTier], tier: plannerModel ? tierOf(plannerModel, tiers) : plannerTier, source: plannerModel ? 'saved' : 'preset', recommended: tiers[plannerTier], recommendedTier: plannerTier, id: resolveId(plannerModel || tiers[plannerTier], available.ids) },
    // Risk-based review cannot be expressed in delivery.conf: it is one MODEL_REVIEW for every PR. gh-board shows which
    // open tasks are risky and what tier their first review gets, so the user can pick the preset (or review them by hand).
    risk: { sensitive, tasks: risky, reviewTier, suggestedTier: 'top', covered: reviewTier === 'top', perTask: false },
    task: Object.keys(changes).length ? `File a module:infra task (size:S) to apply the "${PRESETS[preset].title}" model allocation to .claude/delivery.conf: set ${Object.entries(changes).map(([k, v]) => `${k}="${v}"`).join(', ')}. Acceptance criteria: \`grep -q '^MODEL_REVIEW="${rec.MODEL_REVIEW.value}"' .claude/delivery.conf\` and the gate passes. Context: the review side is strongest; the reviewer is never a lower tier than the implementer.` : '',
  };
}
