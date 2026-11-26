import { useEffect, useState } from "react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errMsg } from "@/lib/api";

type Tunnel = {
  hosted?: boolean; local: boolean; enabled: boolean; url: string | null; link?: string | null;
  ready?: boolean; live?: boolean; public?: boolean; error?: string;
  publicElsewhere?: { address: string; to: string }[];
};

/* Settings > Remote access: publish the board to your tailnet. Self-contained, like ProvidersSection. */
export function TunnelSection({ open }: { open: boolean }) {
  const [t, setT] = useState<Tunnel | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) { setShow(false); setAsking(false); setError(""); setCopied(false); return; }
    let live = true;
    api<Tunnel>("/api/tunnel").then((r) => { if (live) setT(r); }).catch((e) => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [open]);

  const run = async (name: "enable" | "disable" | "rotate") => {
    if (busy) return;
    setBusy(name); setError(""); setCopied(false);
    try { setT(await api<Tunnel>(`/api/tunnel/${name}`, { confirm: true })); setAsking(false); }
    catch (e) {
      setError(errMsg(e));
      await api<Tunnel>("/api/tunnel").then(setT).catch(() => {});
    }
    setBusy("");
  };
  const copy = async () => {
    if (!t?.link) return;
    try { await navigator.clipboard.writeText(t.link); setCopied(true); } catch { setShow(true); }
  };
  const spin = (name: string) => busy === name && <Loader2Icon className="animate-spin" />;
  const state = !t ? "" : !t.enabled ? "Off" : !t.local || t.live ? "On" : "On, but the address is not being served";

  if (t?.hosted) return <p className="text-xs text-muted-foreground">This is the hosted board. Sign-in, accounts and models are set in the Vercel project's environment variables; the delivery loop runs on your computer.</p>;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Remote access</h3>
        <p className="text-xs font-medium">{state}</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">Open this board from your phone or another computer through Tailscale. It is reachable only inside your tailnet, needs an access key, and works while this computer is on and awake.</p>

      {t && !t.local && <p className="text-xs text-muted-foreground">You are connected remotely. Change this setting on the computer running gh-board.</p>}

      {t?.local && t.publicElsewhere?.map((p) => (
        <p key={p.address} className="flex items-start gap-1.5 text-xs leading-snug text-amber-800 dark:text-amber-300">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="[overflow-wrap:anywhere]">Separate from this board: Tailscale Funnel makes {p.address} public on the internet, forwarding to {p.to}.</span>
        </p>
      ))}
      {t?.public && <p role="alert" className="text-xs text-destructive">Funnel is on for the board's address, so it is public. Turn it off with <code className="font-mono">tailscale funnel --https=8443 off</code>.</p>}

      {t?.local && t.enabled && t.link && (
        <div className="flex flex-col gap-2">
          <code className="rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">{show ? t.link : `${t.url}/?key=••••••••`}</code>
          <p className="text-xs text-muted-foreground">Open this link once on each device. Anyone who has it and is on your tailnet can act on your GitHub accounts and spend your Claude usage.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
            <Button type="button" variant="outline" onClick={() => setShow((v) => !v)}>{show ? "Hide key" : "Show key"}</Button>
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => run("rotate")}>{spin("rotate")}New key</Button>
            {!t.live && <Button type="button" variant="outline" disabled={!!busy} onClick={() => run("enable")}>{spin("enable")}Reconnect</Button>}
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => run("disable")}>{spin("disable")}Turn off</Button>
          </div>
        </div>
      )}

      {t?.local && !t.enabled && !asking && (
        <div><Button type="button" variant="outline" disabled={!t.ready} onClick={() => setAsking(true)}>Turn on</Button></div>
      )}
      {t?.local && !t.enabled && asking && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 px-3 py-2.5">
          <p className="text-xs leading-relaxed">Devices in your tailnet that have the key will be able to use this board as you: change GitHub, run the delivery loop and spend Claude usage.</p>
          <div className="flex gap-2">
            <Button type="button" disabled={!!busy} onClick={() => run("enable")} className="bg-brand text-brand-foreground hover:bg-brand/90">{spin("enable")}Turn on remote access</Button>
            <Button type="button" variant="ghost" disabled={!!busy} onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {t?.local && t.error && <p className="text-xs text-destructive [overflow-wrap:anywhere]">{t.error}</p>}
      {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive [overflow-wrap:anywhere]">{error}</p>}
    </section>
  );
}
