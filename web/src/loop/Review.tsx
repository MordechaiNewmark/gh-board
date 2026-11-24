import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, CircleAlertIcon, ExternalLinkIcon, FileDiffIcon, GitMergeIcon, GitPullRequestIcon, ImageIcon, MessageSquareWarningIcon, PaperclipIcon, RepeatIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, errMsg, q } from "@/lib/api";
import { ago, type Media, type Review as ReviewModel } from "@/lib/loop";
import { cn } from "@/lib/utils";
import { CiChip, ConfirmDialog, Fact, Notice, StatusMark, chip, tone } from "./bits";

/* Only GitHub-hosted media is loaded inline; anything else in a PR comment is shown as a link the user can choose to open. */
const INLINE_HOST = /^https:\/\/(github\.com\/user-attachments\/|github\.com\/[^/]+\/[^/]+\/assets\/|[\w.-]+\.githubusercontent\.com\/)/i;
const VERDICT = {
  approved: { text: "Approved by the reviewer", cls: tone.good }, "changes-requested": { text: "Changes requested", cls: tone.warn },
  "needs-human": { text: "Escalated to you", cls: tone.bad }, reviewed: { text: "Reviewed", cls: tone.neutral }, unreviewed: { text: "Not reviewed yet", cls: tone.neutral },
} as const;

/* Inline `code` in criteria and evidence lines. */
function Code({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2
    ? <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[12px] text-foreground">{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}</>;
}
function Section({ icon, title, aside, children }: { icon: React.ReactNode; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">{aside}</span>
      </header>
      {children}
    </section>
  );
}
function MediaTile({ m }: { m: Media }) {
  const [failed, setFailed] = useState(false);
  const inline = INLINE_HOST.test(m.url) && !failed;
  const link = <a href={m.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1.5 truncate text-[12px] text-brand hover:underline"><ExternalLinkIcon aria-hidden className="size-3 shrink-0" /><span className="truncate">{m.alt || m.url.replace(/^https:\/\//, "")}</span></a>;
  if (m.type === "artifact" || !inline) return <li className="flex min-h-10 flex-col justify-center rounded-lg border bg-background px-3 py-2">{link}<span className="text-[11px] text-muted-foreground">{m.type}{!INLINE_HOST.test(m.url) && m.type !== "artifact" ? " · not loaded: external host" : ""} · {m.source}</span></li>;
  return (
    <li className="overflow-hidden rounded-lg border bg-background">
      {m.type === "video"
        ? <video src={m.url} controls preload="metadata" className="aspect-video w-full bg-black/80" onError={() => setFailed(true)} />
        : <a href={m.url} target="_blank" rel="noreferrer noopener"><img src={m.url} alt={m.alt || "Evidence attached to the pull request"} loading="lazy" referrerPolicy="no-referrer" className="aspect-video w-full object-cover" onError={() => setFailed(true)} /></a>}
      <div className="px-2.5 py-1.5">{link}<span className="text-[11px] text-muted-foreground">{m.source}</span></div>
    </li>
  );
}

type Action = null | "merge" | "changes" | "close";

/* Evidence first: criteria and their results, the gate, what was attached, the review trail. The diff comes last. */
export function Review({ repo, number, readOnly, onBack, onDone, onOpenIssue }: {
  repo: string; number: number; readOnly?: boolean; onBack?: () => void; onDone: (message: string) => void; onOpenIssue: (n: number) => void;
}) {
  const [r, setR] = useState<ReviewModel | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState("");
  const [text, setText] = useState("");
  const [reset, setReset] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try { setR(await api<ReviewModel>(`/api/loop/pr?repo=${q(repo)}&number=${number}`)); } catch (e) { setError(errMsg(e)); }
  }, [repo, number]);
  useEffect(() => { setR(null); setAction(null); setText(""); setReset(false); void load(); }, [load]);

  if (error) return <div className="p-6"><Notice kind="bad" action={<Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>}>Could not load PR #{number}: {error}</Notice></div>;
  if (!r) return <div className="flex flex-col gap-3 p-4 md:p-5" aria-busy="true"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-3 h-40 w-full rounded-xl" /><Skeleton className="h-24 w-full rounded-xl" /></div>;

  const close = () => { setAction(null); setActErr(""); };
  const submit = async (path: string, body: Record<string, unknown>, done: string) => {
    setBusy(true); setActErr("");
    try { await api(`/api/loop/pr/${path}`, { repo, number, confirm: true, ...body }); close(); onDone(done); void load(); } catch (e) { setActErr(errMsg(e)); }
    setBusy(false);
  };
  const v = VERDICT[r.verdict.state];
  const pass = r.criteria.filter((c) => c.status === "pass" || c.status === "carried").length;
  const fail = r.criteria.filter((c) => c.status === "fail").length;
  const escalated = r.verdict.state === "needs-human" || r.patches.iteration >= r.patches.of;
  const open = r.pr.state === "open";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3 md:p-5">
          <header>
            {onBack && <button type="button" onClick={onBack} className="mb-2 flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground md:hidden"><ArrowLeftIcon className="size-3.5" />Inbox</button>}
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn(chip, v.cls, "px-2 text-[12px] leading-[22px]")}>{v.text}</span>
              <CiChip ci={r.gate.ci} />
              {r.patches.iteration > 0 && <span className={cn(chip, r.patches.iteration >= r.patches.of ? tone.bad : tone.warn)}><RepeatIcon aria-hidden className="size-3" />patch {r.patches.iteration}/{r.patches.of}</span>}
              {!open && <span className={cn(chip, tone.neutral)}>{r.pr.merged ? "merged" : "closed"}</span>}
            </div>
            <h2 className="mt-2 text-[17px] font-semibold leading-snug tracking-[-0.01em] [overflow-wrap:anywhere]">{r.pr.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
              <a href={r.pr.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-foreground/80 hover:underline"><GitPullRequestIcon aria-hidden className="size-3.5" />PR #{r.pr.number}<ExternalLinkIcon aria-hidden className="size-3" /></a>
              {r.issue && <>delivers <button type="button" onClick={() => onOpenIssue(r.issue!.number)} className="font-medium text-foreground/80 hover:underline">#{r.issue.number} {r.issue.title}</button></>}
              <span>· <span className="font-mono">{r.pr.head.ref}</span> → <span className="font-mono">{r.pr.base}</span></span>
              <span>· by @{r.pr.by}</span>
            </p>
          </header>

          <Section icon={<ShieldCheckIcon aria-hidden />} title="Acceptance criteria"
            aside={r.criteria.length ? <><span className={cn(fail ? "text-destructive" : pass === r.criteria.length ? "text-success" : "")}>{pass}/{r.criteria.length} passed{fail > 0 && ` · ${fail} failed`}</span>{r.verdict.by && <span>· run by @{r.verdict.by} {ago(r.verdict.at)} ago</span>}</> : null}>
            {r.criteria.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted-foreground">{r.issue ? "The linked task has no acceptance-criteria checklist, so there is nothing to check this PR against." : "This PR does not say which task it closes (no \"Closes #N\"), so there are no criteria to check."}</p>
            ) : (
              <ul className="divide-y">
                {r.criteria.map((c, i) => (
                  <li key={i} className="flex gap-3 px-4 py-2.5">
                    <StatusMark status={c.status} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium [overflow-wrap:anywhere]"><Code text={c.criterion} /></p>
                      <p className={cn("mt-0.5 text-[12.5px] [overflow-wrap:anywhere]", c.status === "fail" ? "text-destructive" : "text-muted-foreground")}>
                        {c.evidence ? <Code text={c.evidence} /> : r.verdict.state === "unreviewed" ? "Waiting for the reviewer." : "The reviewer's comment does not report this criterion."}
                      </p>
                    </div>
                    {c.claim !== "unknown" && c.status === "unknown" && <span className={cn(chip, tone.neutral, "self-start")} title="Checked off in the PR description by the implementer. A claim, not evidence.">implementer: {c.claim}</span>}
                  </li>
                ))}
              </ul>
            )}
            {r.verdict.stale && <p className="border-t px-4 py-2 text-[12px] text-amber-700 dark:text-amber-400">The latest review was made on an earlier commit ({r.verdict.commit.slice(0, 7)}); the branch has moved to {r.pr.head.sha.slice(0, 7)} since.</p>}
          </Section>

          <Section icon={<CircleAlertIcon aria-hidden />} title="Gate and CI" aside={<span className="font-mono">{r.pr.head.sha.slice(0, 7)}</span>}>
            <div className="flex flex-col gap-2 px-4 py-3 text-[13px]">
              <div className="flex gap-3">
                <StatusMark status={r.gate.review?.status ?? "unknown"} className="mt-0.5" />
                <p className="min-w-0 [overflow-wrap:anywhere]"><span className="font-medium">Gate, run by the reviewer in a clean checkout. </span><span className="text-muted-foreground">{r.gate.review ? <Code text={r.gate.review.text} /> : "Not reported in the review."}</span></p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-8">
                {r.gate.runs.length === 0 && <span className="text-[12.5px] text-muted-foreground">No CI checks reported for this commit.</span>}
                {r.gate.runs.map((c) => {
                  const bad = c.conclusion && !["success", "skipped", "neutral"].includes(c.conclusion);
                  return <a key={c.name} href={c.url || undefined} target="_blank" rel="noreferrer noopener" className={cn(chip, c.status !== "completed" ? tone.info : bad ? tone.bad : tone.good, "hover:underline")}>{c.name} · {c.status !== "completed" ? "running" : c.conclusion}</a>;
                })}
              </div>
            </div>
          </Section>

          {r.media.length > 0 && (
            <Section icon={<ImageIcon aria-hidden />} title="Evidence attached" aside={`${r.media.length} item${r.media.length === 1 ? "" : "s"}`}>
              <ul className="grid gap-3 p-3 sm:grid-cols-2">{r.media.map((m) => <MediaTile key={m.url} m={m} />)}</ul>
            </Section>
          )}

          <Section icon={<MessageSquareWarningIcon aria-hidden />} title="Findings and patch history" aside={r.patches.rounds.length > 0 ? `${r.patches.rounds.length} round${r.patches.rounds.length === 1 ? "" : "s"}` : null}>
            <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
              {r.findings.length > 0 ? (
                <ul className="flex flex-col gap-1.5">{r.findings.map((f, i) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-orange-500" /><span className="min-w-0 [overflow-wrap:anywhere]"><Code text={f} /></span></li>)}</ul>
              ) : <p className="text-muted-foreground">{r.reviews.length ? "The latest review lists no open findings." : "No review has been posted yet."}</p>}
              {r.patches.rounds.length > 0 && (
                <ol className="flex flex-col gap-1.5 border-t border-dashed pt-3">
                  {r.patches.rounds.map((p, i) => (
                    <li key={i} className="flex gap-2 text-[12.5px]">
                      <span className={cn(chip, p.n >= p.of ? tone.bad : tone.warn, "self-start")}>{p.n}/{p.of}</span>
                      <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]"><span className="text-foreground">{p.rebase ? "Rebase" : p.reset ? "Budget reset" : "Patch"}</span> {ago(p.at)} ago{p.note && <> · {p.note}</>}</span>
                    </li>
                  ))}
                </ol>
              )}
              {r.reviews.length > 0 && (
                <details className="border-t border-dashed pt-2">
                  <summary className="cursor-pointer text-[12.5px] text-muted-foreground hover:text-foreground">Full review text ({r.reviews.length})</summary>
                  <ol className="mt-2 flex flex-col gap-2">
                    {r.reviews.map((rv) => (
                      <li key={rv.id} className="rounded-lg bg-muted px-3 py-2">
                        <p className="text-[11.5px] text-muted-foreground">@{rv.by} · {ago(rv.at)} ago · {rv.state === "COMMENTED" ? "comment-form review" : rv.state.toLowerCase().replace("_", " ")}</p>
                        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed">{rv.body}</pre>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          </Section>

          <Section icon={<FileDiffIcon aria-hidden />} title="Changed files" aside={<><span className="text-success">+{r.pr.additions}</span><span className="text-destructive">−{r.pr.deletions}</span><span>· {r.pr.changed_files} file{r.pr.changed_files === 1 ? "" : "s"}</span></>}>
            <ul className="divide-y">
              {r.files.map((f) => (
                <li key={f.filename}>
                  <details className="group/file">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-1.5 text-[12.5px] hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 flex-1 truncate font-mono">{f.filename}</span>
                      {f.status !== "modified" && <span className={cn(chip, tone.neutral)}>{f.status}</span>}
                      <span className="shrink-0 tabular-nums text-success">+{f.additions}</span><span className="shrink-0 tabular-nums text-destructive">−{f.deletions}</span>
                    </summary>
                    {f.patch
                      ? <pre className="scroll-thin max-h-80 overflow-auto border-t bg-muted/50 px-4 py-2 font-mono text-[11.5px] leading-relaxed">{f.patch.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("+") ? "text-success" : l.startsWith("-") ? "text-destructive" : l.startsWith("@@") ? "text-muted-foreground" : "")}>{l || " "}</span>)}</pre>
                      : <p className="border-t px-4 py-2 text-[12px] text-muted-foreground">No inline diff for this file.</p>}
                  </details>
                </li>
              ))}
            </ul>
            <p className="border-t px-4 py-2 text-[12px] text-muted-foreground">The diff is secondary here. <a href={r.diffUrl} target="_blank" rel="noreferrer noopener" className="text-brand hover:underline">Open the full diff on GitHub</a>.</p>
          </Section>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card px-3 py-2.5 md:px-5">
        <span className="mr-auto text-[12px] text-muted-foreground">{readOnly ? "Read-only mode: actions are disabled." : <>Acting as <span className="font-medium text-foreground/80">@{r.as}</span></>}</span>
        <Button size="sm" variant="ghost" disabled={!open || readOnly} onClick={() => setAction("close")}><XCircleIcon />Close</Button>
        <Button size="sm" variant="outline" disabled={!open || readOnly} onClick={() => { setReset(escalated); setAction("changes"); }}><MessageSquareWarningIcon />Request changes</Button>
        <Button size="sm" disabled={!open || readOnly} onClick={() => setAction("merge")} className="bg-success text-white hover:bg-success/90 dark:text-background"><GitMergeIcon />Approve &amp; merge</Button>
      </footer>

      <ConfirmDialog open={action === "merge"} busy={busy} error={actErr} onClose={close} title={`Squash-merge PR #${r.pr.number}?`} description={r.pr.title}
        confirmLabel={r.merge.cautions.length ? "Merge anyway" : `Merge PR #${r.pr.number}`} danger={r.merge.cautions.length > 0} disabled={!r.merge.ok}
        onConfirm={() => void submit("merge", { sha: r.merge.sha }, `PR #${r.pr.number} merged into ${r.pr.base}`)}>
        <div>
          <Fact label="Into"><span className="font-mono">{r.pr.base}</span> of {repo}, as @{r.as}</Fact>
          <Fact label="Commit"><span className="font-mono">{r.merge.sha.slice(0, 10)}</span> · squash</Fact>
          <Fact label="Change">{r.pr.changed_files} files, +{r.pr.additions} −{r.pr.deletions}</Fact>
          <Fact label="Criteria">{r.criteria.length ? `${pass}/${r.criteria.length} passed${fail ? `, ${fail} failed` : ""}` : "none"}</Fact>
          <Fact label="CI">{r.gate.ci === "none" ? "no checks" : r.gate.ci}</Fact>
          {r.issue && <Fact label="Closes">#{r.issue.number} {r.issue.title}</Fact>}
        </div>
        {r.merge.blockers.map((b) => <Notice key={b} kind="bad">{b}</Notice>)}
        {r.merge.cautions.map((c) => <Notice key={c} kind="warn">{c}</Notice>)}
        <p className="text-muted-foreground">Only this exact commit is merged: if the branch moved since you loaded this page, GitHub refuses and nothing happens.</p>
      </ConfirmDialog>

      <ConfirmDialog open={action === "changes"} busy={busy} error={actErr} onClose={close} title={`Request changes on PR #${r.pr.number}`} confirmLabel="Post and hand back to the loop"
        description="Your comment is posted on the pull request and the task is relabeled status:changes-requested, so the patcher picks it up on the next tick."
        disabled={text.trim().length < 3} onConfirm={() => void submit("request-changes", { body: text, resetBudget: reset }, `Changes requested on PR #${r.pr.number}`)}>
        <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="What has to change, as concretely as you can. The patcher works from this text." className="text-[13px]" />
        {escalated && (
          <label className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={reset} onCheckedChange={(c) => setReset(c === true)} className="mt-0.5" />
            <span>Restart the patch budget and remove <span className="font-mono text-[12px]">needs-human</span>. Without this the loop will not touch an escalated pull request.</span>
          </label>
        )}
        <p className="flex items-start gap-1.5 text-muted-foreground"><PaperclipIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />If you are giving the same correction a second time, ask the planner for a task that adds a check to the gate instead.</p>
      </ConfirmDialog>

      <ConfirmDialog open={action === "close"} busy={busy} error={actErr} onClose={close} danger title={`Close PR #${r.pr.number} without merging?`} confirmLabel="Close pull request"
        description={r.issue ? `Task #${r.issue.number} is parked as needs-human so no agent re-claims it until you decide what happens next.` : "The pull request is closed on GitHub."}
        onConfirm={() => void submit("close", { reason: text }, `PR #${r.pr.number} closed`)}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Reason (optional, posted on the task)" className="text-[13px]" />
      </ConfirmDialog>
    </div>
  );
}
