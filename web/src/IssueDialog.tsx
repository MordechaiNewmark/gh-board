import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, errMsg, labelStyle, q, type Issue, type Label as GhLabel, type Meta } from "@/lib/api";

export type IssueTarget = { number: number | null; parent?: number | null; title?: string; body?: string };
type Props = {
  repo: string; target: IssueTarget; meta: Meta;
  onClose: () => void; onSaved: () => void; onNavigate: (t: IssueTarget) => void;
  onLabelCreated: (l: GhLabel) => void; onAttach: (number: number) => void;
};

const selectCls = "h-9 w-full rounded-md border border-input bg-card px-2.5 text-base md:text-sm";

export function IssueDialog({ repo, target, meta, onClose, onSaved, onNavigate, onLabelCreated, onAttach }: Props) {
  const { number } = target;
  const isStatus = (l: string) => l.toLowerCase().startsWith(meta.prefix.toLowerCase());
  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(!!number);
  const [title, setTitle] = useState(target.title ?? "");
  const [body, setBody] = useState(target.body ?? "");
  const [column, setColumn] = useState(meta.columns[0] ?? "");
  const [milestone, setMilestone] = useState("");
  const [who, setWho] = useState("");
  const [parent, setParent] = useState(target.parent ? String(target.parent) : "");
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#c4552d");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!number) return;
    try {
      const it = await api<Issue>(`/api/issue?repo=${q(repo)}&number=${number}`);
      setIssue(it); setTitle(it.title); setBody(it.body); setColumn(it.column);
      setMilestone(it.milestone ? String(it.milestone.number) : ""); setWho(it.assignees.join(", "));
      setParent(it.parent ? String(it.parent) : ""); setLabels(it.labels.filter((l) => !isStatus(l)));
    } catch (e) { setError(errMsg(e)); }
    setLoading(false);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const toggle = (name: string) => setLabels((ls) => (ls.includes(name) ? ls.filter((l) => l !== name) : [...ls, name]));
  const addLabel = () => run(async () => {
    const name = newLabel.trim();
    if (!name) return;
    const l = await api<GhLabel>("/api/label/create", { repo, name, color: newColor });
    onLabelCreated(l); setLabels((ls) => [...ls, l.name]); setNewLabel("");
  });
  const save = () => run(async () => {
    if (!title.trim()) throw new Error("Title is required.");
    const assignees = who.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
    const ms = milestone ? Number(milestone) : null;
    const par = parent ? Number(parent) : null;
    if (!number) {
      await api("/api/issue/create", { repo, title: title.trim(), body, labels, assignees, column, ...(ms ? { milestone: ms } : {}), ...(par ? { parent_number: par } : {}) });
    } else if (issue) {
      const before = issue.labels.filter((l) => !isStatus(l));
      await api("/api/issue/update", {
        repo, number, title: title.trim(), body, assignees, milestone: ms,
        add_labels: labels.filter((l) => !before.includes(l)), remove_labels: before.filter((l) => !labels.includes(l)),
      });
      if (column !== issue.column) await api("/api/move", { repo, number, column });
      if (par !== (issue.parent ?? null)) await api("/api/issue/parent", { repo, number, parent: par });
    }
    onSaved();
  });
  const setState = () => run(async () => {
    await api("/api/issue/update", { repo, number, state: issue?.state === "open" ? "closed" : "open" });
    onSaved();
  });
  const addComment = () => run(async () => {
    if (!comment.trim()) return;
    await api("/api/issue/comment", { repo, number, body: comment.trim() });
    setComment(""); await load();
  });

  const pickable = meta.labels.filter((l) => !isStatus(l.name));
  const milestones = meta.milestones.filter((m) => m.state === "open" || String(m.number) === milestone);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{number ? `Issue #${number}` : "New issue"}</DialogTitle>
          <DialogDescription>{repo}{target.parent && !number ? ` · sub-issue of #${target.parent}` : ""}</DialogDescription>
        </DialogHeader>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="i-title">Title</Label><Input id="i-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="i-body">Description</Label><Textarea id="i-body" rows={7} value={body} onChange={(e) => setBody(e.target.value)} /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5"><Label htmlFor="i-col">Column</Label>
                <select id="i-col" className={selectCls} value={column} onChange={(e) => setColumn(e.target.value)}>{meta.columns.map((c) => <option key={c}>{c}</option>)}</select></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="i-ms">Milestone</Label>
                <select id="i-ms" className={selectCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>
                  <option value="">None</option>{milestones.map((m) => <option key={m.number} value={m.number}>{m.title}</option>)}
                </select></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="i-who">Assignees (comma-separated)</Label>
                <Input id="i-who" list="i-who-list" value={who} onChange={(e) => setWho(e.target.value)} />
                <datalist id="i-who-list">{meta.assignees.map((a) => <option key={a} value={a} />)}</datalist></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="i-parent">Parent issue number</Label>
                <Input id="i-parent" type="number" min={1} placeholder="None" value={parent} onChange={(e) => setParent(e.target.value)} /></div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Labels</Label>
              <div className="flex flex-wrap gap-1.5">
                {pickable.map((l) => (
                  <button key={l.name} type="button" aria-pressed={labels.includes(l.name)} onClick={() => toggle(l.name)}>
                    <Badge variant="outline" style={labelStyle(l.color)} className={cn(!labels.includes(l.name) && "opacity-45")}>{l.name}</Badge>
                  </button>
                ))}
              </div>
              <div className="mt-1 flex gap-1.5">
                <Input aria-label="New label name" placeholder="New label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                <input aria-label="Label color" type="color" className="h-9 w-11 rounded-md border border-input p-0.5" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
                <Button type="button" variant="outline" onClick={addLabel}>Add label</Button>
              </div>
            </div>
            {number && issue && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label>Sub-issues</Label>
                  {(issue.sub_issues ?? []).length === 0 && <span className="text-sm text-muted-foreground">None</span>}
                  {(issue.sub_issues ?? []).map((s) => (
                    <div key={s.number} className="text-sm">
                      <button type="button" className="font-medium text-brand" onClick={() => onNavigate({ number: s.number })}>#{s.number}</button> {s.title}{" "}
                      <Badge variant="secondary">{s.column}</Badge>
                    </div>
                  ))}
                  <div><Button type="button" variant="outline" size="sm" onClick={() => onNavigate({ number: null, parent: number })}>Add sub-issue</Button></div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="i-comment">Comments</Label>
                  {(issue.comment_list ?? []).map((c, i) => (
                    <div key={i} className="whitespace-pre-wrap break-words border-t pt-2 text-sm">
                      <span className="text-xs text-muted-foreground">{c.by} · {c.at.slice(0, 10)}</span>{"\n"}{c.body}
                    </div>
                  ))}
                  <Textarea id="i-comment" rows={2} placeholder="Write a comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div><Button type="button" variant="outline" size="sm" onClick={addComment}>Comment</Button></div>
                </div>
              </>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="gap-2">
              {number && issue && (
                <>
                  <a className="self-center text-sm text-brand underline sm:mr-auto" href={issue.url} target="_blank" rel="noopener">Open on GitHub</a>
                  <Button type="button" variant="outline" onClick={() => onAttach(number)}>Attach file</Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={setState}>{issue.state === "open" ? "Close issue" : "Reopen issue"}</Button>
                </>
              )}
              <Button type="submit" disabled={busy}>{number ? "Save changes" : "Create issue"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
