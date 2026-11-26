// Run this yourself in a terminal: node scripts/vercel-setup.mjs
// Stores GITHUB_TOKEN (typed hidden) and a new random ACCESS_KEY in the linked Vercel project, redeploys, and
// copies the sign-in link to the clipboard. Neither secret is printed or written to a file on this computer.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SITE = 'https://gh-board.vercel.app';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const stop = (msg) => { console.error(msg); process.exit(1); };

if (!process.stdin.isTTY) stop('Run this in your own terminal window: it has to ask you for the token.');

const askHidden = (question) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(question);
  rl._writeToOutput = () => {};
  rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
});

// The command line is fixed text; values only travel over stdin.
const vercel = (args, options) => spawnSync(`vercel ${args}`, { cwd, shell: true, ...options });
const store = (name, value) => {
  const r = vercel(`env add ${name} production --force`, { input: value, encoding: 'utf8' });
  if (r.status !== 0) stop(`Could not save ${name}:\n${r.stderr || r.stdout}`);
  console.log(`Saved ${name}.`);
};

console.log('Create a fine-grained token at https://github.com/settings/personal-access-tokens/new');
console.log('Pick only the repos you want. Permissions: Issues read and write; Contents and Pull requests read-only.\n');
const token = await askHidden('Paste the GitHub token (hidden), then press Enter: ');
if (!/^(github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}$/.test(token)) stop('That does not look like a GitHub token. Nothing was changed.');
store('GITHUB_TOKEN', token);

const key = randomBytes(24).toString('hex');
store('ACCESS_KEY', key);

console.log('Redeploying (about a minute)...');
if (vercel('deploy --prod --yes', { stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0) stop('The redeploy failed. Run this script again.');

const link = `${SITE}/?key=${key}`;
const clip = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
if (spawnSync(clip, { input: link, shell: true }).status !== 0) stop('Deployed, but the link could not be copied. Run this script again.');
console.log(`\nDone. Your sign-in link is on the clipboard. Save it in your password manager, then open it in a browser.`);
