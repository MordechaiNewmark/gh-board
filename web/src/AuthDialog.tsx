import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GithubIcon, UserAvatar } from "@/components/issue-bits";
import { api, errMsg, type Account, type Auth } from "@/lib/api";

type Props = { open: boolean; auth: Auth; onOpenChange: (open: boolean) => void; onChanged: () => void };
type Checked = Pick<Auth, "accounts" | "hidden" | "notices">;

/** Account manager: every connected GitHub account, per-account actions, and "Add account". */
export function AuthDialog({ open, auth, onOpenChange, onChanged }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stop = () => { window.clearInterval(timer.current); timer.current = undefined; };

  // Opening the dialog re-validates every token, so a revoked one shows up as "Needs attention" right away.
  useEffect(() => {
    if (!open) { stop(); setCode(null); setError(""); setNote(""); setToken(""); setBusy(""); setAdding(false); setChecked(null); return stop; }
    let live = true;
    api<Checked>("/api/auth/accounts?check=1").then((c) => { if (live) setChecked(c); }).catch(() => {});
    return () => { live = false; stop(); };
  }, [open]);
  // Anything newer from the app (after add / remove / default) replaces the snapshot taken on open.
  useEffect(() => { setChecked(null); }, [auth]);

  const accounts: Account[] = checked?.accounts ?? auth.accounts ?? [];
  const hidden = checked?.hidden ?? auth.hidden ?? [];
  const notices = checked?.notices ?? auth.notices ?? [];
  const none = accounts.length === 0;
  const showAdd = adding || none;

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setError(""); setNote("");
    try { await fn(); } catch (e) { setError(errMsg(e)); }
    setBusy("");
  };
  const connect = () => act("add", async () => {
    if (!token.trim()) return;
    const r = await api<Auth & { added?: { login: string; updated: boolean } }>("/api/auth/token", { token });
    setToken(""); setAdding(false);
    setNote(r.added ? (r.added.updated ? `Updated the token for @${r.added.login}.` : `Connected @${r.added.login}.`) : "Connected.");
    onChanged();
    if (none) onOpenChange(false);
  });
  const disconnect = (login: string) => act(`out:${login}`, async () => { await api("/api/auth/logout", { login }); setNote(`Disconnected @${login}. Its repositories were removed from the list.`); onChanged(); });
  const makeDefault = (login: string) => act(`def:${login}`, async () => { await api("/api/auth/default", { login }); onChanged(); });
  const reconnect = (login: string) => act(`re:${login}`, async () => { await api("/api/auth/reconnect", { login }); onChanged(); });
  const signIn = () => act("device", async () => {
    setCode(await api("/api/auth/device", {}));
    stop();
    timer.current = window.setInterval(async () => {
      const s = await api<Auth>("/api/auth/status").catch(() => null);
      if (s?.device?.status === "done") { stop(); setCode(null); setAdding(false); setNote(`Connected @${s.device.login ?? "account"}.`); onChanged(); if (none) onOpenChange(false); }
      else if (s?.device?.status === "error") { stop(); setCode(null); setError(s.device.error || "Sign-in failed."); }
    }, 3000);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scroll-thin max-h-[92dvh] gap-5 overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-base">GitHub accounts</DialogTitle>
          <DialogDescription>Connect every identity you use. Each repository is read and updated with the account that can access it.</DialogDescription>
        </DialogHeader>

        {none ? (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-muted-foreground"><GithubIcon className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Not connected</p>
              <p className="text-xs text-muted-foreground">{notices[0] || auth.error || "Sign in or paste a token below."}</p>
            </div>
          </div>
        ) : (
          <ul aria-label="Connected accounts" className="divide-y overflow-hidden rounded-lg border bg-muted/50">
            {accounts.map((a) => (
              <li key={a.login} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <UserAvatar login={a.login} src={a.avatar || undefined} size={32} className="ring-0" />
                <div className="min-w-0 flex-1 basis-32">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className="truncate">{a.login}</span>
                    {a.default && accounts.length > 1 && <span className="shrink-0 rounded border border-brand/40 bg-brand/10 px-1 text-[10px] font-medium leading-4 text-brand">Default</span>}
                  </p>
                  {a.status === "attention"
                    ? <p role="status" className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"><TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" /><span>{a.error || "Token rejected."} Add a new token for it.</span></p>
                    : <p className="truncate text-xs text-muted-foreground">Connected via {a.sourceLabel}</p>}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {!a.default && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => makeDefault(a.login)}>Set as default</Button>}
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => disconnect(a.login)} aria-label={`Disconnect ${a.login}`}>
                    {busy === `out:${a.login}` && <Loader2Icon className="animate-spin" />}Disconnect
                  </Button>
                </div>
              </li>
            ))}
            {hidden.map((h) => (
              <li key={`h-${h.login}`} className="flex items-center gap-3 px-3 py-2 text-muted-foreground">
                <UserAvatar login={h.login} src={h.avatar || undefined} size={24} className="opacity-60 ring-0 grayscale" />
                <p className="min-w-0 flex-1 truncate text-xs">{h.login} · {h.sourceLabel} · disconnected</p>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => reconnect(h.login)}>Reconnect</Button>
              </li>
            ))}
          </ul>
        )}

        {!none && accounts.length > 1 && (
          <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
            When two accounts can open the same repository, the one with the higher permission is used; on a tie, the default account. You can change it per repository from the "as @login" control.
          </p>
        )}
        {!none && notices.map((n) => <p key={n} className="-mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"><TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />{n}</p>)}
        {note && <p role="status" className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-[13px] text-success">{note}</p>}

        {!showAdd ? (
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setAdding(true)}><PlusIcon />Add account</Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        ) : (
          <section aria-label="Add account" className="flex flex-col gap-4">
            {!none && <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add account</h3>}
            {auth.deviceFlow && (
              <div className="flex flex-col gap-2">
                <Button variant="outline" disabled={!!busy} onClick={signIn}><GithubIcon className="size-4" />Sign in with GitHub</Button>
                {!none && <p className="text-xs text-muted-foreground">To add a different identity, first switch accounts on github.com in your browser, then sign in here.</p>}
                {code && (
                  <p className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">
                    <Loader2Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                    <span>Open <a className="font-medium text-brand underline underline-offset-2" href={code.verification_uri} target="_blank" rel="noopener">{code.verification_uri}</a> and enter{" "}
                      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono font-semibold text-foreground">{code.user_code}</code>. Waiting…</span>
                  </p>
                )}
                <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
              </div>
            )}

            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
              <Label htmlFor="gh-token">Personal access token</Label>
              <Input id="gh-token" name="gh-token" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" spellCheck={false} placeholder="ghp_…" className="font-mono"
                value={token} onChange={(e) => setToken(e.target.value)} aria-describedby="gh-token-help" aria-invalid={!!error || undefined} />
              <p id="gh-token-help" className="text-xs leading-relaxed text-muted-foreground">
                Use a classic token with <code className="rounded bg-secondary px-1 font-mono text-foreground">repo</code> and <code className="rounded bg-secondary px-1 font-mono text-foreground">read:org</code> so repos you were invited to show up.{" "}
                <a className="font-medium text-brand underline underline-offset-2" href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=gh-board" target="_blank" rel="noopener">Create one on GitHub</a>{" "}
                while signed in as the account you want to add. If an org uses SSO, authorize the token for it. A token for an account that is already connected replaces its old token. {auth.hosted ? (auth.database ? "On this hosted board the token is stored encrypted in its database." : "No database is connected yet, so a token cannot be saved here.") : "Tokens are saved only on the computer running gh-board."}
              </p>
              {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}
              <DialogFooter className="mt-2">
                <Button type="button" variant="ghost" onClick={() => (none ? onOpenChange(false) : setAdding(false))}>{none ? "Close" : "Cancel"}</Button>
                <Button type="submit" disabled={!token.trim() || !!busy} className="bg-brand text-brand-foreground hover:bg-brand/90">{busy === "add" && <Loader2Icon className="animate-spin" />}{none ? "Connect" : "Add account"}</Button>
              </DialogFooter>
            </form>
          </section>
        )}
        {!showAdd && error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
