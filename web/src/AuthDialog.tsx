import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg, type Auth } from "@/lib/api";

type Props = { open: boolean; auth: Auth; onOpenChange: (open: boolean) => void; onChanged: () => void };

export function AuthDialog({ open, auth, onOpenChange, onChanged }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stop = () => { window.clearInterval(timer.current); timer.current = undefined; };
  useEffect(() => { if (!open) { stop(); setCode(null); setError(""); setToken(""); } return stop; }, [open]);

  const connect = async () => {
    try { await api("/api/auth/token", { token }); onChanged(); onOpenChange(false); }
    catch (e) { setError(errMsg(e)); }
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>GitHub account</DialogTitle>
          <DialogDescription>
            {auth.connected ? `Connected as ${auth.login} (${auth.source ?? "token"}).` : "Not connected."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {auth.deviceFlow && (
            <div>
              <Button onClick={signIn}>Sign in with GitHub</Button>
              {code && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Open <a className="text-brand underline" href={code.verification_uri} target="_blank" rel="noopener">{code.verification_uri}</a> and enter code{" "}
                  <code className="rounded bg-secondary px-1.5 py-0.5 font-mono">{code.user_code}</code>. Waiting…
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-token">Personal access token</Label>
            <Input id="gh-token" type="password" autoComplete="off" placeholder="ghp_…" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} />
          </div>
          <p className="text-xs text-muted-foreground">
            Use a classic token with <code className="font-mono">repo</code> and <code className="font-mono">read:org</code> so repos you were invited to show up.{" "}
            <a className="text-brand underline" href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=gh-board" target="_blank" rel="noopener">Create one on GitHub</a>.
            If an org uses SSO, authorize the token for it. The token is saved only on the computer running gh-board.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          {auth.connected && <Button variant="outline" onClick={disconnect}>Disconnect</Button>}
          <Button onClick={connect}>Connect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
