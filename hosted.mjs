// Hosted mode (Vercel): the board for reviewing, updating, closing and analysing issues, with no computer of yours
// behind it. There is no shell, no repo checkout and no durable disk there, so the delivery-loop runner, local code
// search and the Claude subscription chat stay with the copy on your computer. Accounts and keys added in the UI
// are saved to a database (vault.mjs). Configuration comes
// from environment variables, and ACCESS_KEY guards every request. See docs/PLATFORM.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const isHosted = (env = process.env) => !!env.VERCEL || /^(1|true)$/i.test(env.HOSTED || '');

export const GATEWAY_ID = 'ai-gateway';
export const GATEWAY_KEY_ENV = 'AI_GATEWAY_API_KEY';

/** A scratch data directory holding the chat provider (Vercel AI Gateway). Returns the paths. */
export function prepareHosted(env = process.env) {
  const dir = env.GH_BOARD_DATA_DIR || join(tmpdir(), 'gh-board');
  mkdirSync(dir, { recursive: true });
  const providersFile = join(dir, 'providers.json');
  const models = String(env.HOSTED_MODELS || 'anthropic/claude-sonnet-5.5,anthropic/claude-opus-5.5').split(',').map((s) => s.trim()).filter(Boolean);
  writeFileSync(providersFile, JSON.stringify({ version: 1, providers: {}, custom: [{ id: GATEWAY_ID, label: 'Vercel AI Gateway', baseUrl: env.AI_GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh/v1', keyEnv: GATEWAY_KEY_ENV, needsKey: true, models }] }));
  return { dir, providersFile, model: models[0] };
}

const LOCAL_ONLY = /^POST \/api\/(runner\/|settings\/|auth\/device$|models\/|tunnel\/)/;
/** Routes whose changes go to the database. */
export const savesState = (key) => /^POST \/api\/(auth\/(token|logout|default|reconnect)|providers\/(save|add|remove)|repo\/account)$/.test(key);
export const localOnlyRoute = (key) => LOCAL_ONLY.test(key);

export const HOSTED_TOOLS_OFF = new Set(['sync_repo', 'run_loop_skill']);

export const hostedNote = (repo) => `

# This is the hosted board (overrides anything above that says otherwise)
- ${repo ? `The selected repo is ${repo}.` : 'No repo is selected; ask the user to pick one.'} There is no local checkout, and sync_repo, Read, Glob and Grep do not exist here. Read code with list_tree, read_file and search_code.
- The delivery loop cannot run here and run_loop_skill does not exist. Help with reviewing, writing, updating, closing and analysing issues; for loop runs, tell the user to use the board on their computer.`;
