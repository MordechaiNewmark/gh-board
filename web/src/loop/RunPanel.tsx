import { useEffect, useState } from "react";
import { ChevronDownIcon, OctagonXIcon, PauseIcon, PlayIcon, RepeatIcon, ShieldAlertIcon, SquareIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "@/lib/api";
import { ago, isActive, type Autonomy, type LoopHandle, type RunEvent } from "@/lib/loop";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Fact, Notice, chip, tone } from "./bits";

const DIAL: { id: Autonomy; title: string; note: string }[] = [
  { id: "supervised", title: "Supervised", note: "One action per tick. You merge every pull request." },
  { id: "parallel", title: "Parallel supervised", note: "Several tasks at once, one per module. You still merge every pull request." },
  { id: "auto", title: "Auto-merge", note: "Approved, green pull requests merge themselves. Agents can merge to your base branch." },
];
const STATUS = { idle: "Idle", starting: "Preparing workspace…", running: "Running", waiting: "Waiting for next tick", paused: "Paused" } as const;

function EventLine({ e }: { e: RunEvent }) {
  const time = e.t.slice(11, 19);
  const body = e.type === "tool" ? <><span className="text-foreground/60">{e.name === "Bash" ? "$" : e.name}</span> {e.summary}</>
    : e.type === "tool_result" ? <span className={e.isError ? "text-destructive" : "text-muted-foreground"}>{e.isError ? "✗ " : "↳ "}{e.text || "ok"}</span>
      : e.type === "result" ? <span className={e.isError ? "text-destructive" : "text-success"}>{e.isError ? "Failed: " : "Result: "}{e.text}</span>
        : e.type === "init" ? <span className="text-muted-foreground">session started · {e.model}</span>
          : e.type === "stderr" ? <span className="text-amber-700 dark:text-amber-400">{e.text}</span>
            : <span className={e.type === "note" ? "text-muted-foreground" : ""}>{e.text}</span>;
  return (
    <li className="flex gap-2 py-px">
      <span className="shrink-0 text-muted-foreground/60">{time}</span>
      {e.sub && <span className="shrink-0 text-brand" title="From a dispatched agent (implementer, reviewer or patcher)">agent</span>}
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</span>
    </li>
  );
}

/* Start, pause and stop delivery ticks for the selected repo, and watch what the loop is doing. */
export function RunPanel({ repo, loop, onToast }: { repo: string; loop: LoopHandle; onToast: (text: string, kind?: "error" | "info") => void }) {
  const { pre, run, act } = loop;
  const [dialog, setDialog] = useState<null | { kind: "start"; mode: "once" | "continuous" } | { kind: "setup" } | { kind: "dial"; to: Autonomy }>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ack, setAck] = useState("");
  const [parallel, setParallel] = useState(3);
  const [logOpen, setLogOpen] = useState(false);
  const [, tick] = useState(0);
  const active = isActive(run);
  useEffect(() => { if (!active) return; const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, [active]);
  useEffect(() => { if (run?.parallel) setParallel(run.parallel); }, [run?.parallel]);
  if (!run || !pre) return <div className="mx-3 mb-3 h-[74px] animate-pulse rounded-xl border bg-card md:mx-5" aria-busy="true" aria-label="Loading the run panel" />;

  const close = () => { setDialog(null); setErr(""); setAck(""); };
  const go = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setErr("");
    try { await fn(); close(); if (done) onToast(done); } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  };
  const quick = async (path: string, done: string) => { try { await act(path); onToast(done); } catch (e) { onToast(errMsg(e), "error"); } };

  const blockers = pre.blockers;
  const noGate = blockers.find((b) => b.code === "no-gate");
  const hard = blockers.filter((b) => b.code !== "no-gate");
  const canStart = !active && blockers.length === 0;
  const events = run.tick?.events ?? run.lastTick?.events ?? [];
  const dial = DIAL.find((d) => d.id === run.autonomy)!;
  const last = run.lastTick;
  const elapsed = run.tick ? ago(run.tick.startedAt) : "";
  const line = run.status === "running" ? run.tick?.activity
    : run.status === "waiting" ? `Next tick in ${run.nextAt ? ago(new Date(2 * Date.now() - Date.parse(run.nextAt)).toISOString()) : "a moment"}${last?.idle ? " · the last one found nothing to do" : ""}`
      : run.status === "paused" ? "Paused. Resume to run the next tick."
        : run.lastError ? run.lastError
          : last ? `Last ${last.kind === "init" ? "setup" : "tick"} ${ago(last.endedAt)} ago: ${last.error || (last.idle ? "nothing to dispatch" : last.text.split("\n")[0] || "done")}` : "No tick has run yet for this repository.";

  return (
    <section aria-label="Run control" className="mx-3 mb-3 shrink-0 rounded-xl border bg-card shadow-xs md:mx-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", run.status === "running" ? "animate-pulse bg-success motion-reduce:animate-none" : run.status === "idle" ? "bg-muted-foreground/40" : run.status === "paused" ? "bg-amber-500" : "bg-sky-500")} />
          <span className="text-[13px] font-semibold">{run.pausing ? "Pausing after this tick" : STATUS[run.status]}{run.status === "running" && elapsed && <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{elapsed}</span>}</span>
          {run.mode && <span className={cn(chip, tone.neutral)}>{run.mode === "once" ? "one tick" : run.mode}</span>}
        </div>

        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="hidden sm:inline">Autonomy</span>
          <select aria-label="Autonomy" value={run.autonomy} disabled={active || run.readOnly} title={dial.note}
            onChange={(e) => { const to = e.target.value as Autonomy; if (to === "supervised") void go(() => act("autonomy", { autonomy: to }), "Autonomy set to Supervised"); else setDialog({ kind: "dial", to }); }}
            className={cn("h-7 rounded-md border border-input bg-background px-2 text-[12.5px] font-medium text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30", run.autonomy === "auto" && "border-amber-500/60 text-amber-700 dark:text-amber-400")}>
            {DIAL.map((d) => <option key={d.id} value={d.id}>{d.title}{d.id === "parallel" || d.id === "auto" ? ` ×${run.parallel}` : ""}</option>)}
          </select>
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {!active ? (
            <>
              <Button size="sm" variant="outline" className="h-8" disabled={!canStart} onClick={() => setDialog({ kind: "start", mode: "once" })}><PlayIcon />Run one tick</Button>
              <Button size="sm" className="h-8 bg-brand text-brand-foreground hover:bg-brand/90" disabled={!canStart} onClick={() => setDialog({ kind: "start", mode: "continuous" })}><RepeatIcon />Run continuously</Button>
            </>
          ) : (
            <>
              {run.mode === "continuous" && (run.status === "paused" || run.pausing
                ? <Button size="sm" variant="outline" className="h-8" onClick={() => void quick("resume", "Resumed")}><PlayIcon />Resume</Button>
                : <Button size="sm" variant="outline" className="h-8" onClick={() => void quick("pause", "Pausing after the current tick")}><PauseIcon />Pause</Button>)}
              <Button size="sm" className="h-8 bg-destructive text-white hover:bg-destructive/90" onClick={() => void quick("stop", "Stopped. The session and everything it started were killed.")}><SquareIcon />Stop</Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-[12px]">
        <button type="button" onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen} className="flex min-w-0 flex-1 basis-64 items-center gap-1.5 rounded text-left text-muted-foreground hover:text-foreground">
          <TerminalIcon aria-hidden className="size-3.5 shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", run.status === "running" && "font-mono text-[11.5px] text-foreground/80", run.lastError && !active && "text-destructive")}>{line}</span>
          <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", logOpen && "rotate-180")} />
        </button>
        <dl className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
          {([["Ticks", run.counters.ticks], ["PRs opened", run.counters.prsOpened], ["Merged", run.counters.merged], ["Escalations", run.counters.escalations]] as const).map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-1"><dt>{k}</dt><dd className="font-semibold text-foreground">{v}</dd></div>
          ))}
          <div className="flex items-baseline gap-1" title={`Daily cap: ${run.today.cap} ticks per repository (RUNNER_DAILY_TICKS). Each tick: up to ${run.limits.maxTurns} turns and ${Math.round(run.limits.tickTimeoutS / 60)} minutes.`}>
            <dt>Today</dt><dd className={cn("font-semibold text-foreground", run.today.ticks >= run.today.cap && "text-destructive")}>{run.today.ticks}/{run.today.cap}</dd>
            {run.today.costUsd > 0 && <dd title="Cost reported by Claude Code for today's ticks (API-equivalent on a subscription)">· ${run.today.costUsd.toFixed(2)}</dd>}
          </div>
        </dl>
      </div>

      {logOpen && (
        <div className="border-t bg-muted/40">
          {last && !run.tick && last.denials.length > 0 && (
            <p className="border-b px-3 py-1.5 text-[12px] text-amber-700 dark:text-amber-400">
              {last.denials.length} action{last.denials.length === 1 ? " was" : "s were"} denied by the allowlist: <span className="font-mono">{last.denials.slice(0, 3).map((d) => d.summary).join(" · ")}</span>
            </p>
          )}
          <ol aria-label="Tick log" className="scroll-thin max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">
            {events.length ? events.slice(-80).map((e, i) => <EventLine key={`${e.t}-${i}`} e={e} />) : <li className="text-muted-foreground">Nothing logged yet. Each tick is kept in .runs/ on this machine, with tokens scrubbed.</li>}
          </ol>
        </div>
      )}

      {(noGate || hard.length > 0) && (
        <div className="flex flex-col gap-2 border-t px-3 py-2.5">
          {hard.map((b) => (
            <Notice key={b.code} kind="bad" icon={<OctagonXIcon aria-hidden />}>
              {b.text}
              {b.code === "plugin" && pre.plugin.help.length > 0 && (
                <span className="mt-1.5 block">Install it yourself in a terminal, then refresh (gh-board never installs plugins):
                  <code className="mt-1 block whitespace-pre-wrap rounded-md bg-background px-2 py-1.5 font-mono text-[11.5px] text-foreground">{pre.plugin.help.join("\n")}</code>
                </span>
              )}
            </Notice>
          ))}
          {noGate && (
            <Notice kind="warn" icon={<ShieldAlertIcon aria-hidden />} action={!hard.length && !active ? <Button size="sm" variant="outline" className="h-7" onClick={() => setDialog({ kind: "setup" })}><WrenchIcon />Set up this repo</Button> : undefined}>
              <span className="font-medium">The loop will not run without a gate.</span> {noGate.text}
            </Notice>
          )}
        </div>
      )}

      <ConfirmDialog open={dialog?.kind === "start"} busy={busy} error={err} onClose={close}
        title={dialog?.kind === "start" && dialog.mode === "continuous" ? `Run the loop continuously on ${repo}?` : `Run one tick on ${repo}?`}
        description="Agents will work in git worktrees on this machine, push branches and open pull requests on GitHub."
        confirmLabel={dialog?.kind === "start" && dialog.mode === "continuous" ? "Start the loop" : "Run one tick"}
        onConfirm={() => dialog?.kind === "start" && void go(() => act("start", { mode: dialog.mode, confirm: true }), dialog.mode === "continuous" ? "Loop started" : "Tick started")}>
        <div>
          <Fact label="Command"><span className="font-mono text-[12px]">{pre.permissions.command}</span></Fact>
          <Fact label="Autonomy">{dial.title}{run.autonomy !== "supervised" && ` ×${run.parallel}`}</Fact>
          <Fact label="Merges">{run.autonomy === "auto" ? "By the loop, when approved and green" : "By you, from the inbox"}</Fact>
          <Fact label="GitHub identity">@{pre.account} · {pre.token?.label}</Fact>
          <Fact label="Claude">{pre.claude.auth}{pre.claude.billing === "api" ? " · API billing" : ""}</Fact>
          <Fact label="Limits">{run.today.ticks}/{run.today.cap} ticks today · {Math.round(run.limits.tickTimeoutS / 60)} min and {run.limits.maxTurns} turns per tick</Fact>
        </div>
        {pre.token?.broad && <Notice kind="warn" icon={<ShieldAlertIcon aria-hidden />}>The session gets @{pre.account}&apos;s {pre.token.label}, which can reach every repository that account can. A fine-grained token limited to <span className="font-mono">{repo}</span> is the safe choice.</Notice>}
        {run.autonomy === "auto" && <Notice kind="warn" icon={<ShieldAlertIcon aria-hidden />}>Auto-merge is on: approved pull requests with green checks are merged without you.</Notice>}
        <p className="text-muted-foreground">Issues, pull requests and repository files are untrusted input to the agents. The gate and {run.autonomy === "auto" ? "CI" : "your merge"} are the controls. Stop kills the session and everything it started.</p>
      </ConfirmDialog>

      <ConfirmDialog open={dialog?.kind === "setup"} busy={busy} error={err} onClose={close} title={`Set up ${repo} for the delivery loop?`} confirmLabel="Run setup"
        description="Runs /delivery-loop:init once, through the same runner and limits as a tick."
        onConfirm={() => void go(() => act("setup", { confirm: true }), "Setup started")}>
        <p>This changes GitHub and the repository:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>creates the loop&apos;s labels (<span className="font-mono text-[12px]">task, epic, status:*, size:*, module:*, needs-human</span>);</li>
          <li>scaffolds <span className="font-mono text-[12px]">.claude/delivery.conf</span>, a starter gate <span className="font-mono text-[12px]">scripts/check.sh</span>, a styleguides stub, and ignores <span className="font-mono text-[12px]">.worktrees/</span>;</li>
          <li>pushes them on a branch and opens a pull request. Nothing is merged: review the gate, then merge it yourself.</li>
        </ul>
        <Fact label="GitHub identity">@{pre.account} · {pre.token?.label}</Fact>
      </ConfirmDialog>

      <ConfirmDialog open={dialog?.kind === "dial"} busy={busy} error={err} onClose={close} danger={dialog?.kind === "dial" && dialog.to === "auto"}
        title={dialog?.kind === "dial" && dialog.to === "auto" ? "Let the loop merge its own pull requests?" : "Run several tasks at once?"}
        confirmLabel={dialog?.kind === "dial" && dialog.to === "auto" ? "Enable auto-merge" : "Enable parallel runs"}
        disabled={dialog?.kind === "dial" && dialog.to === "auto" && ack !== "auto-merge"}
        onConfirm={() => dialog?.kind === "dial" && void go(() => act("autonomy", { autonomy: dialog.to, parallel, confirm: true, acknowledge: ack }), `Autonomy set to ${DIAL.find((d) => d.id === dialog.to)!.title}`)}>
        <p>{dialog?.kind === "dial" && DIAL.find((d) => d.id === dialog.to)!.note}</p>
        {dialog?.kind === "dial" && dialog.to === "auto" && (
          <Notice kind="bad" icon={<ShieldAlertIcon aria-hidden />}>
            You stop being the merge gate. A pull request merges when the reviewer agent approved it, it is mergeable and every check is green. The gate ({pre.gate?.cmd || "none"}) and CI are then the only controls, so a weak gate means weak protection. Start here only after supervised runs have been boringly reliable.
          </Notice>
        )}
        <label className="flex items-center justify-between gap-3">
          <span>Tasks in parallel (one per module)</span>
          <Input type="number" min={2} max={16} value={parallel} onChange={(e) => setParallel(Number(e.target.value))} className="h-8 w-20" />
        </label>
        {dialog?.kind === "dial" && dialog.to === "auto" && (
          <label className="flex flex-col gap-1.5">
            <span>Type <span className="font-mono font-semibold">auto-merge</span> to confirm</span>
            <Input value={ack} onChange={(e) => setAck(e.target.value)} autoComplete="off" spellCheck={false} className="h-8 font-mono" />
          </label>
        )}
      </ConfirmDialog>
    </section>
  );
}
