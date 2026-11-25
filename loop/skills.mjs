// Planner skills: small playbooks the chat loads on demand with the use_skill tool, so each ask gets the
// procedure that fits it (look something up, plan a feature, audit, triage a bug, groom, write a spec) instead
// of one long prompt for everything. Files live in loop/skills/*.md with `name` and `description` frontmatter.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills');

export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) { const k = /^(\w+):\s*(.*)$/.exec(line); if (k) meta[k[1]] = k[2].trim(); }
  if (!meta.name || !meta.description) return null;
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

export function loadSkills(dir = DIR) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const s = parseSkill(readFileSync(join(dir, f), 'utf8'));
    if (s) out.push(s);
  }
  return out;
}

export const SKILLS = loadSkills();
export const skillNames = () => SKILLS.map((s) => s.name);
export const getSkill = (name) => SKILLS.find((s) => s.name === name) || null;
export const skillCatalog = () => SKILLS.map((s) => `- \`${s.name}\`: ${s.description}`).join('\n');
