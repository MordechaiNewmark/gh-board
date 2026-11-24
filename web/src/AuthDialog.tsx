import { useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GithubIcon, UserAvatar } from "@/components/issue-bits";
import { api, errMsg, type Auth } from "@/lib/api";

type Props = { open: boolean; auth: Auth; onOpenChange: (open: boolean) => void; onChanged: () => void };

export function AuthDialog({ open, auth, onOpenChange, onChanged }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stop = () => { window.clearInterval(timer.current); timer.current = undefined; };
  useEffect(() => { if (!open) { stop(); setCode(null); setError(""); setToken(""); setBusy(false); } return stop; }, [open]);

  const connect = async () => {
    if (!token.trim() || busy) return;
    setBusy(true); setError("");
    try { await api("/api/auth/token", { token }); onChanged(); onOpenChange(false); }
    catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const disconnect = async () => { await api("/api/auth/logout", {}).catch(() => {}); onChanged(); };
  const signIn = async () => {
    try {
      setError("");
      setCode(await api("/api/auth/device", {}));
      stop();
      timer.current = window.setInterval(async () => {
        const s = await api<Auth>("/api/auth/status").catch(() => null);
        if (s?.connected) { stop(); onChanged(); onOpenChange(false); }
        else if (s?.device?.status === "error") { stop(); setCode(null); setError(s.device.error || "Sign-in failed."); }
      }, 3000);
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-base">GitHub account</DialogTitle>
          <DialogDescription>gh-board reads and updates issues with your GitHub credentials.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2.5">
          {auth.connected && auth.login ? (
            <>
              <UserAvatar login={auth.login} src={auth.avatar} size={32} className="ring-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{auth.login}</p>
                <p className="text-xs text-muted-foreground">Connected via {auth.source ?? "token"}</p>
              </div>
              <Button variant="outline" size="sm" onClick={disconnect}>Disconnect</Button>
            </>
          ) : (
            <>
              <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-muted-foreground"><GithubIcon className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Not connected</p>
                <p className="text-xs text-muted-foreground">{auth.error || "Sign in or paste a token below."}</p>
              </div>
            </>
          )}
        </div>

        {auth.deviceFlow && (
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={signIn}><GithubIcon className="size-4" />Sign in with GitHub</Button>
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
          <Label htmlFor="gh-token">{auth.connected ? "Replace with a personal access token" : "Personal access token"}</Label>
          <Input id="gh-token" name="gh-token" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" spellCheck={false} placeholder="ghp_…" className="font-mono"
            value={token} onChange={(e) => setToken(e.target.value)} aria-describedby="gh-token-help" aria-invalid={!!error || undefined} />
          <p id="gh-token-help" className="text-xs leading-relaxed text-muted-foreground">
            Use a classic token with <code className="rounded bg-secondary px-1 font-mono text-foreground">repo</code> and <code className="rounded bg-secondary px-1 font-mono text-foreground">read:org</code> so repos you were invited to show up.{" "}
            <a className="font-medium text-brand underline underline-offset-2" href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=gh-board" target="_blank" rel="noopener">Create one on GitHub</a>.
            If an org uses SSO, authorize the token for it. The token is saved only on the computer running gh-board.
          </p>
          {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            <Button type="submit" disabled={!token.trim() || busy} className="bg-brand text-brand-foreground hover:bg-brand/90">{busy && <Loader2Icon className="animate-spin" />}Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
