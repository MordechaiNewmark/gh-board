import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, CircleCheckIcon, CircleDotIcon, ExternalLinkIcon, Loader2Icon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ActorChip } from "@/components/actor";
import { StateIcon, UserAvatar } from "@/components/issue-bits";
import { cn } from "@/lib/utils";
import { api, errMsg, labelStyle, q, type Issue, type Label as GhLabel, type Meta, type RepoAccount } from "@/lib/api";

export type IssueTarget = { number: number | null; parent?: number | null; title?: string; body?: string; column?: string };
type Props = {
  repo: string; target: IssueTarget; meta: Meta;
  /** The GitHub account this repo's writes go out as, and a way to pick another one that can access it. */
  actor?: RepoAccount | null; onActorChange?: (login: string) => void;
  onClose: () => void; onSaved: (message: string) => void; onNavigate: (t: IssueTarget) => void;
  onLabelCreated: (l: GhLabel) => void; onAttach: (number: number) => void;
};

const selectCls = "h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";
const logins = (s: string) => s.split(/[,\s]+/).map((x) => x.trim().replace(/^@/, "")).filter(Boolean);
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        {htmlFor ? <Label htmlFor={htmlFor} className="text-xs font-semibold text-muted-foreground">{label}</Label> : <span className="text-xs font-semibold text-muted-foreground">{label}</span>}
        {hint}
      </div>
      {children}
    </div>
  );
}

export function IssueDialog({ repo, target, meta, actor, onActorChange, onClose, onSaved, onNavigate, onLabelCreated, onAttach }: Props) {
  const { number } = target;
  const isStatus = (l: string) => l.toLowerCase().startsWith(meta.prefix.toLowerCase());
  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(!!number);
  const [title, setTitle] = useState(target.title ?? "");
  const [body, setBody] = useState(target.body ?? "");
  const [column, setColumn] = useState(target.column ?? meta.columns[0] ?? "");
  const [milestone, setMilestone] = useState("");
  const [who, setWho] = useState<string[]>([]);
  const [whoDraft, setWhoDraft] = useState("");
  const [parent, setParent] = useState(target.parent ? String(target.parent) : "");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelQuery, setLabelQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#4353e0");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!number) return;
    try {
      const it = await api<Issue>(`/api/issue?repo=${q(repo)}&number=${number}`);
      setIssue(it); setTitle(it.title); setBody(it.body); setColumn(it.column);
      setMilestone(it.milestone ? String(it.milestone.number) : ""); setWho(it.assignees);
      setParent(it.parent ? String(it.parent) : ""); setLabels(it.labels.filter((l) => !isStatus(l)));
    } catch (e) { setError(errMsg(e)); }
    setLoading(false);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const toggle = (name: string) => setLabels((ls) => (ls.includes(name) ? ls.filter((l) => l !== name) : [...ls, name]));
  const toggleWho = (login: string) => { setWho((w) => (w.includes(login) ? w.filter((x) => x !== login) : [...w, login])); setWhoDraft(""); };
  const commitWho = () => { const add = logins(whoDraft); if (add.length) setWho((w) => [...new Set([...w, ...add])]); setWhoDraft(""); };
  const addLabel = () => run(async () => {
    const name = newLabel.trim();
    if (!name) return;
    const l = await api<GhLabel>("/api/label/create", { repo, name, color: newColor });
    onLabelCreated(l); setLabels((ls) => [...ls, l.name]); setNewLabel(""); setCreating(false);
  });
  const save = () => run(async () => {
    if (!title.trim()) throw new Error("Title is required.");
    const assignees = [...new Set([...who, ...logins(whoDraft)])];
    const ms = milestone ? Number(milestone) : null;
    const par = parent ? Number(parent) : null;
    if (!number) {
      await api("/api/issue/create", { repo, title: title.trim(), body, labels, assignees, column, ...(ms ? { milestone: ms } : {}), ...(par ? { parent_number: par } : {}) });
      onSaved("Issue created");
    } else if (issue) {
      const before = issue.labels.filter((l) => !isStatus(l));
      await api("/api/issue/update", {
        repo, number, title: title.trim(), body, assignees, milestone: ms,
        add_labels: labels.filter((l) => !before.includes(l)), remove_labels: before.filter((l) => !labels.includes(l)),
      });
      if (column !== issue.column) await api("/api/move", { repo, number, column });
      if (par !== (issue.parent ?? null)) await api("/api/issue/parent", { repo, number, parent: par });
      onSaved(`#${number} saved`);
    }
  });
  const setState = () => run(async () => {
    const next = issue?.state === "open" ? "closed" : "open";
    await api("/api/issue/update", { repo, number, state: next });
    onSaved(`#${number} ${next === "closed" ? "closed" : "reopened"}`);
  });
  const addComment = () => run(async () => {
    if (!comment.trim()) return;
    await api("/api/issue/comment", { repo, number, body: comment.trim() });
    setComment(""); await load();
  });

  const pickable = meta.labels.filter((l) => !isStatus(l.name));
  const lq = labelQuery.trim().toLowerCase();
  const shownLabels = pickable.filter((l) => !lq || l.name.toLowerCase().includes(lq)).sort((a, b) => Number(labels.includes(b.name)) - Number(labels.includes(a.name)));
  const milestones = meta.milestones.filter((m) => m.state === "open" || String(m.number) === milestone);
  const people = [...new Set([...who, ...meta.assignees])];
  const wq = whoDraft.trim().replace(/^@/, "").toLowerCase();
  const shownPeople = people.filter((p) => who.includes(p) || (wq ? p.toLowerCase().includes(wq) : people.length <= 8)).slice(0, 12);
  const comments = issue?.comment_list ?? [];
  const failed = !!number && !loading && !issue;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[min(92dvh,860px)] flex-col gap-0 overflow-hidden rounded-xl p-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[94dvh] max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none sm:max-w-[min(960px,calc(100%-2rem))]"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !loading && !failed) { e.preventDefault(); void save(); } }}
        onOpenAutoFocus={(e) => { const t = document.getElementById("i-title"); if (t) { e.preventDefault(); t.focus(); } }}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b px-5 py-3 pr-12">
          {issue ? (
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", issue.state === "open" ? "bg-success/15 text-success" : "bg-done/15 text-done")}>
              <StateIcon state={issue.state} className="text-current" />{issue.state === "open" ? "Open" : "Closed"}
            </span>
          ) : null}
          <DialogTitle className="text-[14px] font-semibold leading-6">{number ? `Issue #${number}` : target.parent ? "New sub-issue" : "New issue"}</DialogTitle>
          <DialogDescription className="min-w-0 truncate text-[13px]">{repo}{target.parent && !number ? ` · sub-issue of #${target.parent}` : ""}</DialogDescription>
          {actor && <ActorChip actor={actor} onChange={onActorChange} className="ml-auto" title={`Changes and comments you save here are made on GitHub as @${actor.login}`} />}
        </div>

        {loading ? (
          <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_260px]" aria-busy="true" aria-label="Loading issue">
            <div className="flex flex-col gap-4"><Skeleton className="h-9 w-3/4" /><Skeleton className="h-52 w-full" /><Skeleton className="h-4 w-1/3" /></div>
            <div className="flex flex-col gap-4">{[0, 1, 2, 3].map((k) => <div key={k} className="flex flex-col gap-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-8 w-full" /></div>)}</div>
          </div>
        ) : failed ? (
          <div className="p-5">
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error || "Could not load this issue."}</p>
          </div>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="scroll-thin grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_272px]">
              {/* Main column: title, description, sub-issues, activity */}
              <div className="flex min-w-0 flex-col gap-5 p-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="i-title" className="sr-only">Title</Label>
                  <Input id="i-title" name="issue-title" autoComplete="off" placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} required
                    className="h-11 text-[17px] font-semibold tracking-[-0.01em] md:text-[17px]" />
                </div>
                <Field label="Description" htmlFor="i-body" hint={<span className="text-[11px] text-muted-foreground">Markdown supported</span>}>
                  <Textarea id="i-body" placeholder="Add context, steps, acceptance criteria…" value={body} onChange={(e) => setBody(e.target.value)}
                    className="scroll-thin max-h-[46dvh] min-h-52 resize-y font-mono text-[13px] leading-relaxed md:text-[13px]" />
                </Field>

                {number && issue && (
                  <>
                    <section aria-label="Sub-issues" className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold text-muted-foreground">Sub-issues{(issue.sub_issues ?? []).length > 0 && ` · ${(issue.sub_issues ?? []).filter((s) => s.state === "closed").length}/${(issue.sub_issues ?? []).length} done`}</h3>
                        <Button type="button" variant="ghost" size="xs" onClick={() => onNavigate({ number: null, parent: number })}><PlusIcon />Add sub-issue</Button>
                      </div>
                      {(issue.sub_issues ?? []).length === 0
                        ? <p className="rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">No sub-issues yet.</p>
                        : (
                          <ul className="divide-y overflow-hidden rounded-lg border">
                            {(issue.sub_issues ?? []).map((s) => (
                              <li key={s.number}>
                                <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted/60" onClick={() => onNavigate({ number: s.number })}>
                                  <StateIcon state={s.state} />
                                  <span className="font-mono text-[11.5px] text-muted-foreground">#{s.number}</span>
                                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                                  <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium">{s.column}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                    </section>

                    <section aria-label="Activity" className="-mx-5 -mb-5 mt-1 flex flex-col gap-3 border-t bg-muted/40 p-5">
                      <h3 className="text-xs font-semibold text-muted-foreground">Activity · {comments.length} comment{comments.length === 1 ? "" : "s"}</h3>
                      {comments.map((c, i) => (
                        <div key={i} className="flex gap-2.5">
                          <UserAvatar login={c.by} size={26} className="mt-0.5 ring-0" />
                          <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
                            <div className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{c.by}</span> · {c.at.slice(0, 10)}</div>
                            <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere]">{c.body}</div>
                          </div>
                        </div>
                      ))}
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="i-comment" className="sr-only">Write a comment</Label>
                        <Textarea id="i-comment" rows={2} placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-16 bg-card text-[13px] md:text-[13px]"
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); void addComment(); } }} />
                        <div className="flex justify-end"><Button type="button" variant="outline" size="sm" disabled={busy || !comment.trim()} onClick={addComment}>Comment</Button></div>
                      </div>
                    </section>
                  </>
                )}
              </div>

              {/* Sidebar: status and metadata */}
              <aside aria-label="Issue details" className="flex flex-col gap-4 border-t bg-muted/40 p-5 md:border-l md:border-t-0">
                <Field label="Column" htmlFor="i-col">
                  <select id="i-col" className={selectCls} value={column} onChange={(e) => setColumn(e.target.value)}>{meta.columns.map((c) => <option key={c}>{c}</option>)}</select>
                </Field>

                <Field label="Assignees" htmlFor="i-who">
                  {shownPeople.length > 0 && (
                    <div className="flex flex-col">
                      {shownPeople.map((p) => {
                        const on = who.includes(p);
                        return (
                          <button key={p} type="button" role="checkbox" aria-checked={on} onClick={() => toggleWho(p)}
                            className={cn("flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-accent", !on && "text-muted-foreground")}>
                            <UserAvatar login={p} size={20} className="ring-0" />
                            <span className="min-w-0 flex-1 truncate">{p}</span>
                            {on && <CheckIcon aria-hidden className="size-3.5 text-brand" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <Input id="i-who" name="assignee-login" autoComplete="off" spellCheck={false} placeholder={people.length > 8 ? "Search or add a login" : "Add a login"} value={whoDraft}
                    className="h-8 bg-background text-[13px] md:text-[13px]"
                    onChange={(e) => setWhoDraft(e.target.value)}
                    onKeyDown={(e) => { if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === ",") { e.preventDefault(); commitWho(); } }} />
                </Field>

                <Field label="Labels" hint={<button type="button" className="rounded text-[11px] font-medium text-brand hover:underline" onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New label"}</button>}>
                  {pickable.length > 10 && (
                    <Input aria-label="Filter labels" name="label-filter" autoComplete="off" placeholder="Filter labels" value={labelQuery} onChange={(e) => setLabelQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) e.preventDefault(); }} className="h-8 bg-background text-[13px] md:text-[13px]" />
                  )}
                  {pickable.length === 0 && !creating && <p className="text-[13px] text-muted-foreground">This repository has no labels yet.</p>}
                  <div className="scroll-thin -mr-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-2">
                    {shownLabels.map((l) => {
                      const on = labels.includes(l.name);
                      return (
                        <button key={l.name} type="button" aria-pressed={on} onClick={() => toggle(l.name)} style={on ? labelStyle(l.color) : undefined}
                          className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-[11.5px] font-medium leading-5 transition-colors", !on && "border-input bg-background text-muted-foreground hover:text-foreground")}>
                          {on ? <CheckIcon aria-hidden className="size-3" /> : <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: `#${l.color}` }} />}
                          <span className="truncate">{l.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  {creating && (
                    <div className="flex gap-1.5 rounded-lg border bg-background p-1.5">
                      <input aria-label="Label color" type="color" className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
                      <Input aria-label="New label name" name="new-label" autoComplete="off" autoFocus placeholder="Label name" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void addLabel(); } }} className="h-8 text-[13px] md:text-[13px]" />
                      <Button type="button" size="sm" variant="outline" disabled={busy || !newLabel.trim()} onClick={addLabel}>Add</Button>
                    </div>
                  )}
                </Field>

                <Field label="Milestone" htmlFor="i-ms">
                  <select id="i-ms" className={selectCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>
                    <option value="">None</option>{milestones.map((m) => <option key={m.number} value={m.number}>{m.title}</option>)}
                  </select>
                </Field>

                <Field label="Parent issue" htmlFor="i-parent" hint={parent && number ? <button type="button" className="rounded text-[11px] font-medium text-brand hover:underline" onClick={() => onNavigate({ number: Number(parent) })}>Open #{parent}</button> : undefined}>
                  <div className="relative">
                    <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[13px] text-muted-foreground">#</span>
                    <Input id="i-parent" type="number" min={1} placeholder="None" value={parent} onChange={(e) => setParent(e.target.value)} className="h-8 bg-background pl-6 text-[13px] md:text-[13px]" />
                  </div>
                </Field>
              </aside>
            </div>

            {error && <p role="alert" className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-5 py-2 text-[13px] text-destructive">{error}</p>}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background px-5 py-3">
              {number && issue && (
                <>
                  <Button type="button" variant="ghost" size="sm" asChild><a href={issue.url} target="_blank" rel="noopener">GitHub<ExternalLinkIcon /></a></Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => onAttach(number)}><PaperclipIcon />Attach file</Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={setState}>
                    {issue.state === "open" ? <><CircleCheckIcon className="text-done" />Close issue</> : <><CircleDotIcon className="text-success" />Reopen issue</>}
                  </Button>
                </>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onClose}><XIcon className="sm:hidden" /><span>Cancel</span></Button>
                <Button type="submit" size="sm" disabled={busy} className="bg-brand text-brand-foreground hover:bg-brand/90" aria-keyshortcuts="Control+Enter">
                  {busy && <Loader2Icon className="animate-spin" />}
                  {number ? "Save changes" : "Create issue"}
                  <span aria-hidden className="hidden rounded bg-black/15 px-1 font-mono text-[10.5px] font-normal sm:inline">{isMac ? "⌘" : "Ctrl"} ↵</span>
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
