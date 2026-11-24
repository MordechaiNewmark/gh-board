import { useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, MessageSquarePlusIcon, RefreshCwIcon, WrenchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errMsg, q } from "@/lib/api";
import type { GapAction, Layer, LoopHandle, Readiness } from "@/lib/loop";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { ConfirmDialog, Notice, chip, tone } from "@/loop/bits";

type Tier = "cheap" | "strong" | "top";
type PolicyRow = { key: string; role: string; current: string; inFile: boolean; currentTier: Tier | ""; currentId: string; recommended: string; tier: Tier | ""; id: string; why: string; matches: boolean };
type Policy = {
  initialized: boolean; preset: string; presets: { id: string; title: string; cost: string; note: string }[]; tiers: Record<Tier, string>; tierIds: Record<Tier, string>;
  rows: PolicyRow[]; changes: Record<string, string>; inPolicy: boolean; problems: { level: "error" | "warn"; message: string }[]; presetProblems: { level: string; message: string }[];
  diff: string; path: string; available: { ids: string[]; verified: boolean }; notes: string[];
  planner: { model: string; tier: Tier | ""; source: string; recommended: string; recommendedTier: Tier; id: string };
  risk: { sensitive: string[]; tasks: { number: number; title: string; state: string; why: string }[]; reviewTier: Tier; suggestedTier: Tier; covered: boolean };
  task: string;
};
type ModelTest = { results: { model: string; ok: boolean; served: string; ms: number; costUsd: number; error: string }[]; at: string };
const TIER_TONE: Record<Tier, string> = { cheap: tone.neutral, strong: tone.info, top: tone.brand };
const TIER_ORDER: Tier[] = ["cheap", "strong", "top"];
function TierChip({ tier }: { tier: Tier | "" }) {
  return tier ? <span className={cn(chip, TIER_TONE[tier])}>{tier}</span> : <span className={cn(chip, "border-dashed text-muted-foreground")} title="Not one of the three tiers (empty means: inherit the session model)">no tier</span>;
}

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
  const [tierDraft, setTierDraft] = useState<Record<Tier, string> | null>(null);
  const [sensDraft, setSensDraft] = useState<string | null>(null);
  const [testing, setTesting] = useState<"" | "ask" | "run">("");
  const [test, setTest] = useState<ModelTest | null>(null);
  const [testErr, setTestErr] = useState("");
  const savePolicy = async (body: Record<string, unknown>, done: string) => {
    try { setPolicy(await api<Policy>("/api/models/policy", { repo, ...body })); setTierDraft(null); setSensDraft(null); onToast(done); } catch (e) { onToast(errMsg(e), "error"); }
  };
  const runTest = async () => {
    setTesting("run"); setTestErr("");
    try { setTest(await api<ModelTest>("/api/models/test", { repo, confirm: true })); setTesting(""); } catch (e) { setTestErr(errMsg(e)); setTesting("ask"); }
  };
  const pre = loop.pre;
  const load = async () => {
    setError("");
    try { const [a, b] = await Promise.all([api<Readiness>(`/api/readiness?repo=${q(repo)}`), api<Policy>(`/api/models/policy?repo=${q(repo)}`).catch(() => null)]); setR(a); setPolicy(b); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { setR(null); setPolicy(null); setTest(null); setTierDraft(null); setSensDraft(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [repo]);

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

        {policy && (() => {
          const tiers = tierDraft ?? policy.tiers;
          const nChanges = Object.keys(policy.changes).length;
          const errors = policy.problems.filter((p) => p.level === "error");
          const warns = policy.problems.filter((p) => p.level === "warn");
          return (
          <section aria-label="Model policy" className="rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Model policy</h2>
              <span className="text-[12px] text-muted-foreground">the review side is strongest</span>
              <span className={cn(chip, errors.length ? tone.bad : policy.inPolicy ? tone.good : tone.warn, "ml-auto")}>{errors.length ? "reviewer outranked" : policy.inPolicy ? "matches the preset" : `${nChanges} value${nChanges === 1 ? "" : "s"} differ`}</span>
            </header>
            <div className="flex flex-col gap-4 p-4 text-[12.5px]">
              <p className="text-muted-foreground">Checking is cheaper and more reliable than producing: a modest writer under a strong, independent reviewer converges, while a weak reviewer lets bugs through. The reviewer is never a lower tier than the implementer.</p>

              <div role="radiogroup" aria-label="Preset" className="grid gap-2 sm:grid-cols-3">
                {policy.presets.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={policy.preset === p.id} onClick={() => policy.preset !== p.id && void savePolicy({ preset: p.id }, `Preset for ${repo}: ${p.title}`)}
                    className={cn("flex flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors", policy.preset === p.id ? "border-brand bg-brand/[0.07] ring-1 ring-brand/40" : "hover:bg-accent/50")}>
                    <span className="flex items-center justify-between gap-2"><span className="text-[13px] font-semibold">{p.title}</span><span className="font-mono text-[11.5px] text-muted-foreground" title="Relative cost">{p.cost}</span></span>
                    <span className="text-[12px] leading-snug text-muted-foreground">{p.note}</span>
                  </button>
                ))}
              </div>

              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void savePolicy({ tiers }, "Tier models saved for this repo"); }}>
                {TIER_ORDER.map((t) => (
                  <label key={t} className="flex min-w-[130px] flex-1 flex-col gap-1">
                    <span className="flex items-center gap-1.5"><TierChip tier={t} /><span className="truncate font-mono text-[11px] text-muted-foreground" title="Resolved model id">{policy.tierIds[t]}</span></span>
                    <Input aria-label={`${t} tier model`} value={tiers[t]} spellCheck={false} autoComplete="off" onChange={(e) => setTierDraft({ ...tiers, [t]: e.target.value })} className="h-8 font-mono text-[12.5px] md:text-[12.5px]" />
                  </label>
                ))}
                <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!tierDraft}>Save tiers</Button>
                <Button type="button" size="sm" variant="outline" className="h-8" disabled={testing === "run"} onClick={() => setTesting("ask")}>Test models</Button>
              </form>
              {test && (
                <ul aria-label="Model test results" className="flex flex-wrap gap-1.5">
                  {test.results.map((x) => (
                    <li key={x.model} title={x.ok ? `Answered as ${x.served || x.model} in ${(x.ms / 1000).toFixed(1)}s` : x.error} className={cn(chip, x.ok ? tone.good : tone.bad, "max-w-full font-mono")}>
                      {x.ok ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}<span className="truncate">{x.model}{x.ok ? ` → ${x.served || "ok"}` : `: ${x.error}`}</span>
                    </li>
                  ))}
                </ul>
              )}

              {errors.map((p) => <Notice key={p.message} kind="bad">{p.message}</Notice>)}
              {policy.presetProblems.map((p) => <Notice key={p.message} kind="bad">With these tier models the preset itself breaks the rule: {p.message}</Notice>)}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left">
                  <thead><tr className="text-[11px] uppercase tracking-wider text-muted-foreground"><th className="py-1 pr-3 font-semibold">Role</th><th className="py-1 pr-3 font-semibold">Now in delivery.conf</th><th className="py-1 font-semibold">Preset</th></tr></thead>
                  <tbody>
                    <tr className="border-t border-dashed" title="The planner writes the issues every agent runs from. It also covers spec authoring and decompose, which you run with the same model. Change it in Settings.">
                      <td className="py-1.5 pr-3">Planner chat and specs<span className="block font-mono text-[11px] text-muted-foreground">Settings &gt; Claude &gt; Planner model</span></td>
                      <td className="py-1.5 pr-3"><span className="flex flex-wrap items-center gap-1.5"><TierChip tier={policy.planner.tier} /><span className="font-mono">{policy.planner.model}</span>{policy.planner.source === "preset" ? <span className="text-muted-foreground">(from the preset)</span> : <button type="button" onClick={onOpenSettings} className="text-brand hover:underline">change</button>}</span></td>
                      <td className="py-1.5"><span className="flex flex-wrap items-center gap-1.5"><TierChip tier={policy.planner.recommendedTier} /><span className="font-mono">{policy.planner.recommended}</span></span></td>
                    </tr>
                    {policy.rows.map((row) => (
                      <tr key={row.key} className="border-t border-dashed" title={row.why}>
                        <td className="py-1.5 pr-3">{row.role}<span className="block font-mono text-[11px] text-muted-foreground">{row.key}</span></td>
                        <td className="py-1.5 pr-3">
                          {row.key === "REREVIEW_SCOPE" ? <span className="font-mono">{row.current}</span> : row.current
                            ? <span className="flex flex-wrap items-center gap-1.5"><TierChip tier={row.currentTier} /><span className="font-mono">{row.current}</span>{row.currentId !== row.current && <span className="font-mono text-[11px] text-muted-foreground">{row.currentId}</span>}</span>
                            : <span className="text-muted-foreground">inherit the session model</span>}
                        </td>
                        <td className="py-1.5">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {row.tier && <TierChip tier={row.tier} />}<span className={cn("font-mono", !row.matches && "font-semibold")}>{row.recommended}</span>
                            {row.id && row.id !== row.recommended && <span className="font-mono text-[11px] text-muted-foreground">{row.id}</span>}
                            {row.matches && <CheckIcon aria-label="Matches" className="size-3 text-success" />}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg border border-dashed px-3 py-2.5">
                <h3 className="font-semibold">Risky changes</h3>
                <p className="mt-0.5 text-muted-foreground">The plugin has one <span className="font-mono text-[11.5px]">MODEL_REVIEW</span> for every pull request: it cannot review only risky changes with the top model. Under this preset every first review runs on the <span className="font-medium text-foreground">{policy.risk.reviewTier}</span> tier{policy.risk.covered ? ", so risky tasks are covered." : ". Tasks listed here would deserve the top tier: switch to Balanced, or review them yourself."}</p>
                <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void savePolicy({ sensitive: (sensDraft ?? "").split(/[\s,]+/).filter(Boolean) }, "Sensitive modules saved"); }}>
                  <label htmlFor="sensitive-modules" className="shrink-0">Sensitive modules</label>
                  <Input id="sensitive-modules" value={sensDraft ?? policy.risk.sensitive.join(" ")} placeholder={r.modules.length ? `e.g. ${r.modules[0]}` : "module names"} spellCheck={false} onChange={(e) => setSensDraft(e.target.value)} className="h-7 min-w-[140px] flex-1 font-mono text-[12px] md:text-[12px]" />
                  <Button type="submit" size="xs" variant="outline" disabled={sensDraft === null}>Save</Button>
                </form>
                {policy.risk.tasks.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {policy.risk.tasks.slice(0, 8).map((t) => (
                      <li key={t.number} className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-muted-foreground">#{t.number}</span><span className="min-w-0 truncate">{t.title}</span><span className={cn(chip, tone.warn)}>{t.why}</span><span className="text-muted-foreground">first review:</span><TierChip tier={policy.risk.reviewTier} />{!policy.risk.covered && <><span className="text-muted-foreground">suggested:</span><TierChip tier={policy.risk.suggestedTier} /></>}</li>
                    ))}
                  </ul>
                ) : <p className="mt-2 text-muted-foreground">No open task is labeled <span className="font-mono text-[11.5px]">risk:high</span> or sits in a sensitive module.</p>}
              </div>

              {policy.diff && (
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium">Change to apply to <span className="font-mono text-[12px]">{policy.path}</span></span>
                    <Button size="xs" variant="outline" className="ml-auto" onClick={() => { void navigator.clipboard?.writeText(policy.diff).then(() => onToast("Diff copied")); }}><CopyIcon />Copy diff</Button>
                    <Button size="xs" variant="outline" onClick={() => onAsk(policy.task)}><MessageSquarePlusIcon />Ask the planner to file a task</Button>
                  </div>
                  <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed">{policy.diff.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("+") && !l.startsWith("+++") ? "text-success" : l.startsWith("-") && !l.startsWith("---") ? "text-destructive" : "text-muted-foreground")}>{l || " "}</span>)}</pre>
                  <p className="mt-1 text-muted-foreground">gh-board does not write this for you. It reaches the base branch like any other change: a task, a pull request, your merge. The preset, tiers and sensitive modules above are saved on this machine only.</p>
                </div>
              )}
              <ul className="flex flex-col gap-1 text-muted-foreground">{[...warns.map((w) => w.message), ...policy.notes].map((n) => <li key={n} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />{n}</li>)}</ul>
            </div>
          </section>
          );
        })()}

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

      <ConfirmDialog open={testing !== ""} busy={testing === "run"} error={testErr} onClose={() => { setTesting(""); setTestErr(""); }} title="Test the three tier models?" confirmLabel="Send the test prompts"
        description="Sends one short prompt (reply with the word ok; no tools, no repository, no GitHub token) to each tier's model through Claude Code, to see whether your sign-in can use it. It costs a few cents of usage per model and never runs on its own."
        onConfirm={() => void runTest()}>
        {policy && <ul className="flex flex-col gap-1">{TIER_ORDER.map((t) => <li key={t} className="flex items-center gap-2"><TierChip tier={t} /><span className="font-mono">{policy.tiers[t]}</span></li>)}</ul>}
      </ConfirmDialog>

      <ConfirmDialog open={setup} busy={busy} error={setupErr} onClose={() => { setSetup(false); setSetupErr(""); }} title={`Set up ${repo} for the delivery loop?`} confirmLabel="Run setup"
        description="Runs /delivery-loop:init once. It creates the loop's labels on GitHub, scaffolds the config and a starter gate, and opens a pull request with them. Nothing is merged."
        onConfirm={async () => { setBusy(true); setSetupErr(""); try { await loop.act("setup", { confirm: true }); setSetup(false); onToast("Setup started. Watch it in the Run panel on the board."); } catch (e) { setSetupErr(errMsg(e)); } setBusy(false); }} />
    </div>
  );
}
