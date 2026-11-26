import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errMsg } from "@/lib/api";

type Session = { signedIn: boolean; idleHours: number; maxDays: number };

/* Settings > Sign-in session. Renders nothing where no sign-in is needed (the board on this computer). */
export function SessionSection({ open }: { open: boolean }) {
  const [s, setS] = useState<Session | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) { setError(""); return; }
    let live = true;
    api<Session>("/api/session").then((r) => { if (live) setS(r); }).catch(() => {});
    return () => { live = false; };
  }, [open]);

  const out = async (name: "logout" | "logout-all") => {
    if (busy) return;
    setBusy(name); setError("");
    try { await api(`/api/session/${name}`, {}); window.location.assign("/"); }
    catch (e) { setError(errMsg(e)); setBusy(""); }
  };

  if (!s?.signedIn) return null;
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sign-in session</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">This session ends after {s.idleHours} hours without use, and {s.maxDays} days after you signed in.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!!busy} onClick={() => out("logout")}>{busy === "logout" && <Loader2Icon className="animate-spin" />}Sign out</Button>
        <Button type="button" variant="outline" disabled={!!busy} onClick={() => out("logout-all")}>{busy === "logout-all" && <Loader2Icon className="animate-spin" />}Sign out everywhere</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
