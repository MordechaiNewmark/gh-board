import { useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, MessageSquarePlusIcon, RefreshCwIcon, WrenchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errMsg, q } from "@/lib/api";
import type { GapAction, Layer, LoopHandle, Readiness } from "@/lib/loop";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Notice, chip, tone } from "@/loop/bits";

type PolicyRow = { key: string; role: string; current: string; inFile: boolean; recommended: string; why: string; matches: boolean };
type Policy = {
  initialized: boolean; strong: string; cheap: string; rows: PolicyRow[]; changes: Record<string, string>; inPolicy: boolean; diff: string; path: string;
  available: { ids: string[]; verified: boolean }; notes: string[]; planner: { model: string; source: string }; task: string;
};

const FILL = { ok: "bg-success/85 text-white dark:text-background", partial: "bg-amber-500/85 text-white dark:text-background", missing: "bg-muted text-muted-foreground ring-1 ring-inset ring-border" };
const WORD = { ok: "in place", partial: "partly", missing: "missing" };
/* Widest at the bottom: the layer agents can lean on most. */
const WIDTH = { prose: "52%", verification: "68%", checks: "84%", design: "100%" } as const;
const SHORT = { prose: "Prose rules", verification: "Verification", checks: "Lint, types, tests", design: "Codebase design" } as const;

function Pyramid({ layers }: { layers: Layer[] }) {
  const top = [...layers].reverse();
  return (
    <ol aria-label="Trust pyramid, weakest layer at the top" className="flex flex-col items-center gap-1.5">
      {top.map((l) => (
        <li key={l.id} style={{ width: WIDTH[l.id] }} className={cn("flex min-w-[150px] items-center justify-between gap-2 rounded-md px-3 py-2 text-[12.5px] font-medium", FILL[l.status])} title={l.hint}>
          <span className="truncate">{SHORT[l.id]}</span><span className="shrink-0 text-[11px] font-normal opacity-90">{WORD[l.status]}</span>
        </li>
      ))}
    </ol>
  );
}

/* Per-repo readiness: what exists at each layer of the trust pyramid, an action for each gap, and the model policy. */
export function RepoReadiness({ repo, loop, onAsk, onOpenSettings, onToast }: { repo: string; loop: LoopHandle; onAsk: (prompt: string) => void; onOpenSettings: () => void; onToast: (t: string, k?: "error" | "info") => void }) {
  const [r, setR] = useState<Readiness | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupErr, setSetupErr] = useState("");
  const [rules, setRules] = useState(false);
  const pre = loop.pre;
  const load = async () => {
    setError("");
    try { const [a, b] = await Promise.all([api<Readiness>(`/api/readiness?repo=${q(repo)}`), api<Policy>(`/api/models/policy?repo=${q(repo)}`).catch(() => null)]); setR(a); setPolicy(b); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { setR(null); setPolicy(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [repo]);

  if (error) return <div className="p-5"><Notice kind="bad" action={<Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>}>Could not read {repo}: {error}</Notice></div>;
  if (!r) return <div className="flex flex-col gap-3 p-5" aria-busy="true"><Skeleton className="h-36 w-full rounded-xl" /><Skeleton className="h-48 w-full rounded-xl" /></div>;

  const act = (a: GapAction) => (a.kind === "setup" ? setSetup(true) : onAsk(a.prompt));
  const canSetup = pre && !pre.readOnly && pre.plugin.ok && pre.claude.ok && pre.status === "idle";
  const facts: [string, boolean, string][] = pre ? [
    ["Plugin", pre.plugin.ok, pre.plugin.ok ? `delivery-loop ${pre.plugin.version} from ${pre.plugin.source}#${pre.plugin.ref}` : pre.plugin.problem],
    ["Claude Code", pre.claude.ok, pre.claude.ok ? `${pre.claude.auth}${pre.claude.billing === "api" ? " · API billing" : ""}` : pre.claude.error],
    ["GitHub token", !pre.token?.broad, pre.token ? `@${pre.account} · ${pre.token.label}${pre.token.broad ? ". It reaches every repo of that account; prefer a fine-grained token limited to this one." : ""}` : "no account"],
    ["Gate", !!pre.gate?.ok, pre.gate?.ok ? pre.gate.cmd : pre.gate?.reason || "unknown"],
    ["Workspace", pre.workspace, pre.workspace ? "cloned on this machine (.workspaces/)" : "not cloned yet; the first run clones it"],
  ] : [];

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3 md:p-5">
        <section className="rounded-xl border bg-card">
          <header className="flex items-center gap-2 border-b px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">Trust pyramid</h2>
            <span className="text-[12px] text-muted-foreground">read from {r.from === "workspace" ? "the workspace" : "GitHub (default branch)"}</span>
            <Button variant="ghost" size="icon-sm" className="ml-auto size-7" aria-label="Refresh" title="Refresh" onClick={() => { void load(); void loop.refresh(); }}><RefreshCwIcon /></Button>
          </header>
          <div className="grid gap-5 p-4 md:grid-cols-[260px_1fr]">
            <div className="flex flex-col justify-center gap-3">
              <Pyramid layers={r.layers} />
              <p className="text-center text-[12px] leading-snug text-muted-foreground">Agents trust the bottom most. If you correct an agent twice, add a check, not another prose rule.</p>
            </div>
            <div className="flex flex-col gap-3">
              {!r.initialized && (
                <Notice kind="warn" action={<Button size="sm" variant="outline" className="h-7" disabled={!canSetup} onClick={() => setSetup(true)}><WrenchIcon />Set up this repo</Button>}>
                  <span className="font-medium">Not set up for the delivery loop.</span> There is no <span className="font-mono text-[12px]">.claude/delivery.conf</span> on the default branch.
                </Notice>
              )}
              {r.layers.map((l) => (
                <div key={l.id}>
                  <h3 className="text-[12.5px] font-semibold">{l.title}</h3>
                  <p className="text-[12px] text-muted-foreground">{l.hint}</p>
                  <ul className="mt-1.5 flex flex-col">
                    {l.items.map((i) => (
                      <li key={i.label} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-dashed py-1.5 text-[12.5px] first:border-t-0">
                        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full [&>svg]:size-2.5", i.ok ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>{i.ok ? <CheckIcon strokeWidth={3} aria-label="In place" /> : <XIcon strokeWidth={3} aria-label="Missing" />}</span>
                        <span className="font-medium">{i.label}</span>
                        <span className="min-w-0 flex-1 basis-40 text-muted-foreground [overflow-wrap:anywhere]">{i.detail}</span>
                        {i.action && (
                          <Button size="xs" variant="outline" disabled={i.action.kind === "setup" && !canSetup} onClick={() => act(i.action!)}>
                            {i.action.kind === "setup" ? <WrenchIcon /> : <MessageSquarePlusIcon />}{i.action.label}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {policy && (
          <section className="rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Model policy</h2>
              <span className="text-[12px] text-muted-foreground">the review side is strongest</span>
              <span className={cn(chip, policy.inPolicy ? tone.good : tone.warn, "ml-auto")}>{policy.inPolicy ? "matches the preset" : `${Object.keys(policy.changes).length} value${Object.keys(policy.changes).length === 1 ? "" : "s"} differ`}</span>
            </header>
            <div className="flex flex-col gap-3 p-4 text-[12.5px]">
              <p className="text-muted-foreground">Checking is cheaper and more reliable than producing: a modest writer under a strong, independent reviewer converges, while a weak reviewer lets bugs through. Preset: <span className="font-mono text-foreground">{policy.strong}</span> reviews and patches, <span className="font-mono text-foreground">{policy.cheap}</span> implements small tasks.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left">
                  <thead><tr className="text-[11px] uppercase tracking-wider text-muted-foreground"><th className="py-1 pr-3 font-semibold">Role</th><th className="py-1 pr-3 font-semibold">Key</th><th className="py-1 pr-3 font-semibold">Now</th><th className="py-1 font-semibold">Preset</th></tr></thead>
                  <tbody>
                    {policy.rows.map((row) => (
                      <tr key={row.key} className="border-t border-dashed" title={row.why}>
                        <td className="py-1.5 pr-3">{row.role}</td>
                        <td className="py-1.5 pr-3 font-mono text-[11.5px] text-muted-foreground">{row.key}</td>
                        <td className="py-1.5 pr-3 font-mono">{row.current || <span className="font-sans text-muted-foreground">inherit</span>}</td>
                        <td className="py-1.5"><span className={cn(chip, row.matches ? tone.good : tone.warn, "font-mono")}>{row.recommended}</span></td>
                      </tr>
                    ))}
                    <tr className="border-t border-dashed" title="The planner writes the issues every agent runs from, so it gets the strongest model. Change it in Settings.">
                      <td className="py-1.5 pr-3">Planner chat</td><td className="py-1.5 pr-3 text-muted-foreground">Settings &gt; Claude &gt; Model</td>
                      <td className="py-1.5 pr-3 font-mono">{policy.planner.model}{policy.planner.source === "default" && <span className="font-sans text-muted-foreground"> (default)</span>}</td>
                      <td className="py-1.5"><button type="button" onClick={onOpenSettings} className="text-brand hover:underline">Change</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {policy.diff && (
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-medium">Change to apply to <span className="font-mono text-[12px]">{policy.path}</span></span>
                    <Button size="xs" variant="outline" className="ml-auto" onClick={() => { void navigator.clipboard?.writeText(policy.diff).then(() => onToast("Diff copied")); }}><CopyIcon />Copy diff</Button>
                    <Button size="xs" variant="outline" onClick={() => onAsk(policy.task)}><MessageSquarePlusIcon />Ask the planner to file a task</Button>
                  </div>
                  <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed">{policy.diff.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("+") && !l.startsWith("+++") ? "text-success" : l.startsWith("-") && !l.startsWith("---") ? "text-destructive" : "text-muted-foreground")}>{l || " "}</span>)}</pre>
                  <p className="mt-1 text-muted-foreground">gh-board does not write this for you. It reaches the base branch like any other change: a task, a pull request, your merge.</p>
                </div>
              )}
              <ul className="flex flex-col gap-1 text-muted-foreground">{policy.notes.map((n) => <li key={n} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />{n}</li>)}</ul>
            </div>
          </section>
        )}

        {pre && (
          <section className="rounded-xl border bg-card">
            <header className="border-b px-4 py-2.5"><h2 className="text-[13px] font-semibold">Runner</h2></header>
            <ul className="px-4 py-2">
              {facts.map(([k, ok, text]) => (
                <li key={k} className="flex items-start gap-2 border-t border-dashed py-1.5 text-[12.5px] first:border-t-0">
                  <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full [&>svg]:size-2.5", ok ? "bg-success/15 text-success" : "bg-amber-500/15 text-amber-600 dark:text-amber-400")}>{ok ? <CheckIcon strokeWidth={3} /> : <XIcon strokeWidth={3} />}</span>
                  <span className="w-24 shrink-0 font-medium">{k}</span><span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{text}</span>
                </li>
              ))}
            </ul>
            {!pre.plugin.ok && pre.plugin.help.length > 0 && <code className="mx-4 mb-3 block whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-[11.5px]">{pre.plugin.help.join("\n")}</code>}
            <button type="button" aria-expanded={rules} onClick={() => setRules((o) => !o)} className="flex w-full items-center gap-1.5 border-t px-4 py-2 text-left text-[12.5px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", rules && "rotate-90")} />What a session may do ({pre.permissions.allow.length} allowed, {pre.permissions.deny.length} denied)
            </button>
            {rules && (
              <div className="grid gap-3 border-t px-4 py-3 text-[12px] md:grid-cols-2">
                <p className="text-muted-foreground md:col-span-2">Permission mode <span className="font-mono text-foreground">{pre.permissions.mode}</span>, prompts answered by <span className="font-mono text-foreground">{pre.permissions.prompts}</span>: file reads and edits are accepted inside the workspace only; anything not allowed below is refused. This is a seatbelt, not a sandbox: the gate runs the repository&apos;s own code.</p>
                <div><h3 className="mb-1 font-semibold text-success">Allowed</h3><ul className="font-mono text-[11px] leading-relaxed">{pre.permissions.allow.map((a) => <li key={a} className="[overflow-wrap:anywhere]">{a}</li>)}</ul></div>
                <div><h3 className="mb-1 font-semibold text-destructive">Denied</h3><ul className="font-mono text-[11px] leading-relaxed">{pre.permissions.deny.map((a) => <li key={a} className="[overflow-wrap:anywhere]">{a}</li>)}</ul></div>
              </div>
            )}
          </section>
        )}
      </div>

      <ConfirmDialog open={setup} busy={busy} error={setupErr} onClose={() => { setSetup(false); setSetupErr(""); }} title={`Set up ${repo} for the delivery loop?`} confirmLabel="Run setup"
        description="Runs /delivery-loop:init once. It creates the loop's labels on GitHub, scaffolds the config and a starter gate, and opens a pull request with them. Nothing is merged."
        onConfirm={async () => { setBusy(true); setSetupErr(""); try { await loop.act("setup", { confirm: true }); setSetup(false); onToast("Setup started. Watch it in the Run panel on the board."); } catch (e) { setSetupErr(errMsg(e)); } setBusy(false); }} />
    </div>
  );
}
