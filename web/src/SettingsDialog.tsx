import { useEffect, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProvidersSection } from "./settings/ProvidersSection";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api, errMsg, type ClaudeMethod, type ClaudeSettings } from "@/lib/api";

type Props = { open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => void };
type TestResult = { ok: boolean; detail?: string; error?: string };

const METHODS: { id: ClaudeMethod; title: string; body: string; placeholder?: string }[] = [
  { id: "login", title: "Claude login session", body: "Uses the `claude login` session on this computer. No secret is stored. Usage counts against your Claude subscription." },
  { id: "oauth", title: "OAuth token", body: "Paste the token printed by `claude setup-token`. Usage counts against your Claude subscription.", placeholder: "sk-ant-oat…" },
  { id: "apikey", title: "Anthropic API key", body: "From console.anthropic.com. Usage is billed per token to that API account, not to a Claude subscription.", placeholder: "sk-ant-api…" },
];
const SOURCE = { saved: "chosen here", env: "from .env", default: "default" } as const;
const code = (text: string) => text.split("`").map((part, i) => (i % 2 ? <code key={i} className="rounded bg-secondary px-1 font-mono text-foreground">{part}</code> : part));

/** Settings: how the chat authenticates to Claude, and which model it uses. Secrets are write-only from here. */
export function SettingsDialog({ open, onOpenChange, onChanged }: Props) {
  const [cfg, setCfg] = useState<ClaudeSettings | null>(null);
  const [method, setMethod] = useState<ClaudeMethod>("login");
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);

  const adopt = (c: ClaudeSettings) => { setCfg(c); setMethod(c.method); setModel(c.model); setSecret(""); };
  useEffect(() => {
    if (!open) { setSecret(""); setError(""); setResult(null); setBusy(""); return; }
    let live = true;
    api<{ claude: ClaudeSettings }>("/api/settings").then((r) => { if (live) adopt(r.claude); }).catch((e) => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [open]);

  const key = method === "login" ? null : method;
  const savedTail = key && cfg ? cfg.saved[key] : null;
  const fromEnv = !!(key && cfg?.env[key]);
  const needsSecret = !!key && !savedTail && !fromEnv;
  const dirty = !!cfg && (method !== cfg.method || model.trim() !== cfg.model || !!secret.trim());

  const run = async (name: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setError("");
    try { await fn(); } catch (e) { setError(errMsg(e)); }
    setBusy("");
  };
  const persist = async () => {
    const r = await api<{ claude: ClaudeSettings }>("/api/settings/claude", { method, ...(secret.trim() && key ? { secret: secret.trim() } : {}), model: model.trim() });
    adopt(r.claude); onChanged();
  };
  const save = () => run("save", async () => { setResult(null); await persist(); });
  const test = () => run("test", async () => {
    setResult(null);
    if (dirty) await persist();
    setResult(await api<TestResult>("/api/settings/claude/test", {}));
  });
  const remove = () => run("remove", async () => {
    if (!key) return;
    setResult(null);
    const r = await api<{ claude: ClaudeSettings }>("/api/settings/claude/remove", { method: key });
    adopt(r.claude); onChanged();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scroll-thin max-h-[92dvh] gap-5 overflow-y-auto rounded-xl sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-base">Settings</DialogTitle>
          <DialogDescription>How the chat signs in to Claude. Keys and tokens are saved only on the computer running gh-board and are never shown again.</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude</h3>
            {cfg && (
              <p className="min-w-0 truncate text-xs text-muted-foreground">
                Active: <span className="font-medium text-foreground">{cfg.label}</span>{cfg.tail && <span className="font-mono"> {cfg.tail}</span>} · {SOURCE[cfg.source]}
              </p>
            )}
          </div>

          <div role="radiogroup" aria-label="Claude sign-in method" className="divide-y overflow-hidden rounded-lg border bg-muted/50">
            {METHODS.map((m) => {
              const on = method === m.id;
              const tail = m.id !== "login" && cfg ? cfg.saved[m.id] : null;
              const env = m.id !== "login" && !!cfg?.env[m.id];
              return (
                <button key={m.id} type="button" role="radio" aria-checked={on} disabled={!cfg} onClick={() => { setMethod(m.id); setSecret(""); setResult(null); setError(""); }}
                  className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors focus-visible:bg-accent/60", on ? "bg-brand/10" : "hover:bg-accent/60")}>
                  <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-brand" : "border-input bg-background")}>
                    {on && <span className="size-2 rounded-full bg-brand" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                      {m.title}
                      {tail && <span className="rounded border px-1 font-mono text-[10px] font-normal leading-4 text-muted-foreground">saved {tail}</span>}
                      {!tail && env && <span className="rounded border px-1 text-[10px] font-normal leading-4 text-muted-foreground">in .env</span>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{code(m.body)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {key && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="claude-secret">{key === "apikey" ? "API key" : "OAuth token"}{savedTail ? " (replace)" : ""}</Label>
              <div className="flex gap-2">
                <Input id="claude-secret" name="claude-secret" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" spellCheck={false}
                  placeholder={savedTail ? `Saved ${savedTail}` : fromEnv ? "Using the value from .env" : METHODS.find((m) => m.id === key)?.placeholder}
                  className="font-mono" value={secret} onChange={(e) => setSecret(e.target.value)} aria-invalid={!!error || undefined} />
                {savedTail && <Button type="button" variant="outline" disabled={!!busy} onClick={remove}>{busy === "remove" && <Loader2Icon className="animate-spin" />}Remove</Button>}
              </div>
              {key === "apikey" && <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400">With an API key, every chat message and repo analysis is charged to your Anthropic API account.</p>}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="claude-model">Planner model</Label>
            <Input id="claude-model" name="claude-model" list="claude-models" autoComplete="off" spellCheck={false} placeholder="Default for your account" className="font-mono text-[13px] md:text-[13px]"
              value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="claude-models">{(cfg?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
            <p className="text-xs text-muted-foreground">The model the planner chat thinks with. Leave empty for the strongest (the review side and planning get the strong model; the loop sets its own per role in each repo, see the Repo tab), or pick or type a model ID.{cfg?.modelSource === "env" && " Currently set by CLAUDE_MODEL in .env."}</p>
          </div>

          {cfg?.ambientApiKeyIgnored && <p className="text-xs text-muted-foreground">An <code className="rounded bg-secondary px-1 font-mono text-foreground">ANTHROPIC_API_KEY</code> is set in the shell that started gh-board. It is not used unless you save a key here or put it in .env.</p>}
          {result && (
            <p role="status" className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", result.ok ? "border-success/40 bg-success/10 text-success" : "border-destructive/40 bg-destructive/10 text-destructive")}>
              {result.ok ? <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{result.ok ? `Connection works. ${result.detail ?? ""}` : `Connection failed: ${result.error ?? "unknown error"}`}</span>
            </p>
          )}
          {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}

          <DialogFooter className="mt-1 sm:justify-between">
            <Button type="button" variant="outline" disabled={!cfg || !!busy || (needsSecret && !secret.trim())} onClick={test}>
              {busy === "test" && <Loader2Icon className="animate-spin" />}{dirty ? "Save and test" : "Test connection"}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
              <Button type="submit" disabled={!dirty || !!busy || (needsSecret && !secret.trim())} className="bg-brand text-brand-foreground hover:bg-brand/90">{busy === "save" && <Loader2Icon className="animate-spin" />}Save</Button>
            </div>
          </DialogFooter>
        </form>
        <div className="border-t pt-4">
          <ProvidersSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
