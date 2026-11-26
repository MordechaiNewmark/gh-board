// The locked page: the access key is typed into a form and sent in the request body, so it needs no URL encoding
// and stays out of addresses and history. Nothing here holds a key.
export const readForm = (req) => new Promise((resolve) => {
  let text = '';
  req.on('data', (c) => { text += c; if (text.length > 4000) req.destroy(); });
  req.on('end', () => resolve(new URLSearchParams(text)));
  req.on('error', () => resolve(new URLSearchParams()));
});

export function locked(req, res, url, message = 'Locked. Enter your access key.') {
  if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end(message); }
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gh-board sign in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;padding:16px;box-sizing:border-box;color-scheme:light dark}form{display:grid;gap:12px;width:min(100%,20rem)}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #8886}h1{font-size:1.2rem;margin:0}p{margin:0}</style></head>
<body><form method="post" action="/signin"><h1>gh-board</h1><p>${message}</p>
<input type="password" name="key" aria-label="Access key" autocomplete="current-password" required autofocus>
<button type="submit">Open the board</button></form></body></html>`);
}
