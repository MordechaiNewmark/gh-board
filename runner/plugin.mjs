// Is the delivery-loop plugin installed in Claude Code, and is it the expected fork? Read-only: this looks at
// Claude Code's own plugin metadata (installed_plugins.json, known_marketplaces.json) and never installs,
// updates or enables anything. If something is off, the caller shows the user the commands to run.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN_ID = 'delivery-loop@delivery-loop';
export const SKILLS = ['init', 'author-styleguides', 'author-spec', 'decompose', 'next-task', 'review-task', 'patch-task', 'deliver-task', 'delivery-tick', 'task-status'];

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export function installHelp(repo, ref) {
  return [`claude plugin marketplace add "${repo}${ref ? `#${ref}` : ''}"`, 'claude plugin install delivery-loop@delivery-loop'];
}

/**
 * @param o.configDir  Claude Code config dir (CLAUDE_CONFIG_DIR, default ~/.claude)
 * @param o.repo       expected marketplace source, "owner/name"
 * @param o.ref        expected branch/ref of that marketplace ('' = any)
 */
export function checkPlugin({ configDir, repo = 'MordechaiNewmark/delivery-loop', ref = 'cost-aware-defaults' } = {}) {
  const dir = join(configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins');
  const help = installHelp(repo, ref);
  const base = { ok: false, installed: false, fork: false, version: '', path: '', source: '', ref: '', expected: `${repo}${ref ? `#${ref}` : ''}`, help, problem: '' };

  const entries = readJson(join(dir, 'installed_plugins.json'))?.plugins?.[PLUGIN_ID];
  const entry = Array.isArray(entries) ? entries.find((e) => e.scope === 'user') || entries[0] : null;
  if (!entry?.installPath) return { ...base, problem: 'The delivery-loop plugin is not installed in Claude Code.' };
  const market = readJson(join(dir, 'known_marketplaces.json'))?.['delivery-loop']?.source || {};
  const source = market.repo || market.url || market.path || '';
  const out = { ...base, installed: true, version: String(entry.version || ''), path: entry.installPath, source: String(source), ref: String(market.ref || ''), commit: String(entry.gitCommitSha || '').slice(0, 12) };
  if (!existsSync(join(entry.installPath, 'skills', 'delivery-tick', 'SKILL.md'))) return { ...out, problem: `The plugin folder is incomplete (${entry.installPath}). Reinstall it.` };
  const sameRepo = String(source).toLowerCase() === repo.toLowerCase();
  const sameRef = !ref || out.ref === ref;
  if (!sameRepo || !sameRef) {
    return { ...out, problem: `delivery-loop is installed from ${source || 'an unknown source'}${out.ref ? `#${out.ref}` : ''}, not from ${base.expected}. Remove that marketplace and add the expected one.`,
      help: ['claude plugin uninstall delivery-loop@delivery-loop', 'claude plugin marketplace remove delivery-loop', ...help] };
  }
  return { ...out, ok: true, fork: true };
}
