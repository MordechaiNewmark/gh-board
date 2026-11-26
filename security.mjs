// Request and response hardening shared by every deployment of the board.
import { createHash } from 'node:crypto';

// Images may come only from the board itself and GitHub. Chat answers and issue text are partly written by a model
// or by strangers, and an image loaded from their server would carry data out as soon as it renders.
const IMAGES = ["'self'", 'data:', 'blob:', 'https://github.com', 'https://avatars.githubusercontent.com', 'https://raw.githubusercontent.com',
  'https://user-images.githubusercontent.com', 'https://private-user-images.githubusercontent.com', 'https://github-production-user-asset-6210df.s3.amazonaws.com'];

const policy = (scripts) => [
  "default-src 'self'", `script-src ${scripts}`, "style-src 'self' 'unsafe-inline'", `img-src ${IMAGES.join(' ')}`,
  "font-src 'self' data:", "media-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(res, { https = false, api = false } = {}) {
  res.setHeader('Content-Security-Policy', policy("'self'"));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // same-origin, not no-referrer: the latter makes the sign-in form send "Origin: null".
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (api) res.setHeader('Cache-Control', 'no-store');
}

/** The unbuilt fallback page is one file with its script inline: allow exactly that script. */
export function allowInlineScripts(res, html) {
  const hashes = [...String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1].replace(/\r\n/g, '\n')).digest('base64')}'`);
  res.setHeader('Content-Security-Policy', policy(["'self'", ...hashes].join(' ')));
}

/**
 * A GitHub API path is built from a repo name and numbers that a request or a model supplied. Refuse anything that
 * would make the URL point at a different endpoint than the code wrote.
 */
export function assertApiPath(path) {
  const route = String(path).split('?')[0];
  if (!route.startsWith('/') || /[#\\\s]/.test(String(path)) || route.split('/').some((s) => /^(\.|%2e){1,2}$/i.test(s))) throw new Error('Refused: that is not a valid GitHub API path.');
  return path;
}

export const assertRepo = (repo) => {
  const parts = String(repo ?? '').split('/');
  if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')) throw new Error('repo must be "owner/name"');
  return repo;
};

export const issueNumber = (n) => {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v < 1) throw new Error('Issue number must be a positive whole number.');
  return v;
};
