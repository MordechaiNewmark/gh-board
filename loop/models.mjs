// Model allocation policy: "the review side is strongest". Checking is cheaper and more reliable than
// producing, so a modest writer under a strong, independent checker converges, while a weak reviewer lets
// bugs through with false confidence. This maps that stance onto the keys the delivery-loop plugin ALREADY
// reads from .claude/delivery.conf (MODEL_IMPLEMENT_S/_M/_L, MODEL_REVIEW, MODEL_REREVIEW, MODEL_PATCH,
// REREVIEW_SCOPE). The plugin passes each value to the Agent tool's `model` input, which takes Claude Code
// model aliases (opus, sonnet, haiku, fable); empty means "inherit the session model". Nothing here writes
// anywhere: it computes the recommended values and the exact diff for a human (or a loop task) to apply.
import { CONF_PATH, parseConf } from './conf.mjs';

export const MODEL_KEYS = ['MODEL_IMPLEMENT_S', 'MODEL_IMPLEMENT_M', 'MODEL_IMPLEMENT_L', 'MODEL_REVIEW', 'MODEL_REREVIEW', 'MODEL_PATCH', 'REREVIEW_SCOPE'];
const ROLE = {
  MODEL_IMPLEMENT_S: 'Implementer, size:S', MODEL_IMPLEMENT_M: 'Implementer, size:M', MODEL_IMPLEMENT_L: 'Implementer, size:L',
  MODEL_REVIEW: 'Reviewer, first review', MODEL_REREVIEW: 'Reviewer, after a patch', MODEL_PATCH: 'Patcher (after a failed review or red CI)', REREVIEW_SCOPE: 'Re-review scope',
};
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
/** Alias the Agent tool accepts for a model id or alias ("claude-opus-5-5" -> "opus"); '' when it is not a known family. */
export const aliasOf = (m) => ALIASES.find((a) => String(m || '').toLowerCase() === a || String(m || '').toLowerCase().includes(`-${a}-`)) || '';

/**
 * @param strong / cheap  aliases chosen by the operator (STRONG_MODEL / CHEAP_MODEL in .env)
 * Recommended values, with the reason for each.
 */
export function recommended({ strong = 'opus', cheap = 'sonnet' } = {}) {
  return {
    MODEL_IMPLEMENT_S: { value: cheap, why: 'Small tasks inside lint, types and tests: a cheaper writer, checked by the gate and a strong reviewer.' },
    MODEL_IMPLEMENT_M: { value: cheap, why: 'Same. Raise it for hard or novel work (algorithms, concurrency, unfamiliar domains), where a weak writer costs more in retries than it saves.' },
    MODEL_IMPLEMENT_L: { value: strong, why: 'Large work needs a strong writer (size:L is normally split before anyone claims it).' },
    MODEL_REVIEW: { value: strong, why: 'The reviewer is the control: strongest model, fresh context, and a different model than the writer.' },
    MODEL_REREVIEW: { value: strong, why: 'A weak re-review is where false confidence gets in.' },
    MODEL_PATCH: { value: strong, why: 'Escalation: once the cheap writer has failed review or CI, the strong model fixes it.' },
    REREVIEW_SCOPE: { value: 'narrow', why: 'Keeps the strong re-review affordable: only the incremental diff, the failing criteria and the full gate.' },
  };
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
 * The Model policy panel: current values, the preset, what would change, and honest notes about availability.
 * reader: { read(path) }. available: { ids: string[], verified: boolean } - model ids this credential can use.
 */
export async function modelPolicy(reader, { strong = 'opus', cheap = 'sonnet', available = { ids: [], verified: false }, billing = 'subscription', plannerModel = '' } = {}) {
  const text = await reader.read(CONF_PATH);
  const { values, set } = parseConf(text);
  const rec = recommended({ strong, cheap });
  const rows = MODEL_KEYS.map((k) => ({ key: k, role: ROLE[k], current: values[k] || '', inFile: set.has(k), recommended: rec[k].value, why: rec[k].why, matches: (values[k] || '') === rec[k].value }));
  const changes = Object.fromEntries(rows.filter((r) => !r.matches).map((r) => [r.key, r.recommended]));
  const next = text === null ? null : applyToConf(text, changes);
  const families = new Set(available.ids.map(aliasOf).filter(Boolean));
  const usable = (a) => !available.ids.length || families.has(a);
  const notes = [];
  if (text === null) notes.push('This repo has no .claude/delivery.conf yet. Run setup first; the policy is applied to that file.');
  if (!available.verified) notes.push(`Model availability was not verified: a Claude ${billing === 'api' ? 'API key' : 'subscription'} sign-in has no free way to list models. The names below are the ones Claude Code offers (${available.ids.join(', ') || 'none listed'}); if a run reports an unknown model, change the value.`);
  for (const a of new Set([strong, cheap])) if (!usable(a)) notes.push(`"${a}" was not found among the models this credential can use.`);
  notes.push(billing === 'api'
    ? `Cost: with an API key every review on "${strong}" is billed per token. Reviews read a diff and run commands, so they are usually far smaller than the implementation they check.`
    : `Cost: on a subscription the strong model draws down your usage limits fastest. If "${strong}" is rate-limited on your plan, reviews will stall before implementation does; keep REREVIEW_SCOPE=narrow, or set MODEL_REREVIEW to "${cheap}" and accept a weaker re-review.`);
  if (strong === cheap) notes.push('The strong and the cheap model are the same, so the reviewer is not a different model than the writer.');
  notes.push('Escalation gap: the plugin has no "escalate after two failed gate runs" rule. MODEL_PATCH applies from the first patch round, which is the closest setting; see docs/PLATFORM.md (Model allocation) for the proposed plugin change.');
  return {
    initialized: text !== null, strong, cheap, rows, changes, inPolicy: Object.keys(changes).length === 0,
    diff: next === null ? '' : diffLines(text, next), path: CONF_PATH, available, notes,
    planner: { model: plannerModel || strong, source: plannerModel ? 'saved' : 'default' },
    task: Object.keys(changes).length ? `File a module:infra task (size:S) to apply the model allocation policy to .claude/delivery.conf: set ${Object.entries(changes).map(([k, v]) => `${k}="${v}"`).join(', ')}. Acceptance criteria: \`grep -q '^MODEL_REVIEW="${rec.MODEL_REVIEW.value}"' .claude/delivery.conf\` and the gate passes. Context: the review side is strongest; implementers on size:S/M use the cheaper model, reviewers and the patcher use the strong one.` : '',
  };
}
