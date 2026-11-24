import { ChevronRightIcon, FileTextIcon, FolderSearchIcon, GitBranchIcon, ListIcon, LoaderIcon, SearchIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { answerApproval, useApproval, useGenerated, useProgress } from "./runtime";

type Props = { toolCallId: string; toolName: string; args?: unknown; result?: unknown; isError?: boolean };
type Args = Record<string, any>;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* Read-only steps render as one quiet line each, so a long exploration stays scannable. */
const READ_STEPS: Record<string, { icon: LucideIcon; verb: string; target: (a: Args) => string }> = {
  sync_repo: { icon: GitBranchIcon, verb: "Sync", target: (a) => `${str(a.repo)}${a.ref ? ` @ ${str(a.ref)}` : ""}` },
  Read: { icon: FileTextIcon, verb: "Read", target: (a) => `${str(a.file_path)}${a.offset ? `:${a.offset}${a.limit ? `-${Number(a.offset) + Number(a.limit)}` : ""}` : ""}` },
  Grep: { icon: SearchIcon, verb: "Search", target: (a) => `${clip(str(a.pattern), 48)}${a.glob ? ` in ${str(a.glob)}` : a.path && a.path !== "." ? ` in ${str(a.path)}` : ""}` },
  Glob: { icon: FolderSearchIcon, verb: "Find files", target: (a) => `${str(a.pattern)}${a.path && a.path !== "." ? ` in ${str(a.path)}` : ""}` },
  read_file: { icon: FileTextIcon, verb: "Read (API)", target: (a) => str(a.path) },
  search_code: { icon: SearchIcon, verb: "Search (API)", target: (a) => clip(str(a.q), 48) },
  list_tree: { icon: FolderSearchIcon, verb: "List", target: (a) => str(a.path) || "/" },
  list_issues: { icon: ListIcon, verb: "List issues", target: (a) => [a.state, a.label].filter(Boolean).join(" · ") },
  get_issue: { icon: ListIcon, verb: "Open issue", target: (a) => `#${str(a.number)}` },
  list_sub_issues: { icon: ListIcon, verb: "List sub-issues", target: (a) => `#${str(a.number)}` },
  list_labels: { icon: ListIcon, verb: "List labels", target: () => "" },
  list_milestones: { icon: ListIcon, verb: "List milestones", target: () => "" },
  list_assignees: { icon: ListIcon, verb: "List assignees", target: () => "" },
  list_repos: { icon: ListIcon, verb: "List repositories", target: () => "" },
};

/** Short human description of a tool call, shared with the tool group header. */
export function describeTool(toolName: string, args: unknown): string {
  const step = READ_STEPS[toolName];
  const a = (args && typeof args === "object" ? args : {}) as Args;
  if (!step) return toolName;
  const target = step.target(a);
  return target ? `${step.verb} ${target}` : step.verb;
}

type Draft = { title?: string; body?: string; labels?: string[]; assignees?: string[]; column?: string; children?: Draft[] };
const countDrafts = (items: Draft[]): number => items.reduce((n, i) => n + 1 + countDrafts(i.children ?? []), 0);

function DraftIssue({ draft, depth = 0 }: { draft: Draft; depth?: number }) {
  const kids = draft.children ?? [];
  const tags = [...(draft.labels ?? []), ...(draft.column ? [`→ ${draft.column}`] : []), ...(draft.assignees ?? []).map((a) => `@${a}`)];
  return (
    <li className={cn(depth > 0 && "ml-3 border-l pl-2.5")}>
      <details className="group/draft">
        <summary className="flex cursor-pointer list-none items-start gap-1.5 rounded-md px-1 py-1 hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/draft:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className={cn("text-[13px] leading-snug", depth === 0 && kids.length > 0 ? "font-semibold" : "font-medium")}>{draft.title || "(untitled)"}</span>
            {(tags.length > 0 || kids.length > 0) && (
              <span className="mt-1 flex flex-wrap items-center gap-1">
                {kids.length > 0 && <span className="rounded bg-brand/10 px-1.5 text-[10.5px] font-medium leading-[18px] text-brand">{kids.length} sub-issue{kids.length === 1 ? "" : "s"}</span>}
                {tags.map((t) => <span key={t} className="rounded border px-1.5 text-[10.5px] leading-[16px] text-muted-foreground">{t}</span>)}
              </span>
            )}
          </span>
        </summary>
        <div className="scroll-thin mb-1.5 ml-5 mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 text-xs leading-relaxed text-foreground/85">
          {draft.body?.trim() || <span className="text-muted-foreground">No description.</span>}
        </div>
      </details>
      {kids.length > 0 && <ul className="mt-0.5 flex flex-col gap-0.5">{kids.map((k, i) => <DraftIssue key={i} draft={k} depth={depth + 1} />)}</ul>}
    </li>
  );
}

/* Readable preview of what create_issue / create_issues will write: titles, labels, hierarchy, expandable bodies. */
function IssuePreview({ toolName, args }: { toolName: string; args: Args }) {
  const drafts: Draft[] = toolName === "create_issues" ? (Array.isArray(args.issues) ? args.issues : []) : [args as Draft];
  const total = countDrafts(drafts);
  const epics = drafts.filter((d) => d.children?.length).length;
  return (
    <div className="mt-2">
      <p className="mb-1 text-xs text-muted-foreground">
        {total} issue{total === 1 ? "" : "s"}{epics > 0 && ` · ${epics} epic${epics === 1 ? "" : "s"}`} in <span className="font-mono text-foreground/80">{str(args.repo)}</span>
        {args.parent_number ? ` under #${args.parent_number}` : ""}. Open one to read its full body.
      </p>
      <ul aria-label="Proposed issues" className="scroll-thin flex max-h-[26rem] flex-col gap-0.5 overflow-auto rounded-md border bg-background p-1.5">
        {drafts.map((d, i) => <DraftIssue key={i} draft={d} />)}
      </ul>
    </div>
  );
}

/* Shown for every tool call: what Claude is doing, an Approve / Reject gate for writes, and download links. */
export function ToolCard({ toolCallId, toolName, args, result, isError }: Props) {
  const approval = useApproval(toolCallId);
  const file = useGenerated(toolCallId);
  const note = useProgress(toolCallId);
  const done = result !== undefined;
  const failed = !!isError && approval?.state !== "rejected" && approval?.state !== "blocked";
  const step = READ_STEPS[toolName];

  if (step && !approval) {
    const Icon = step.icon;
    const a = (args && typeof args === "object" ? args : {}) as Args;
    const target = step.target(a);
    return (
      <div className="py-0.5 text-xs text-muted-foreground" title={`${toolName} ${JSON.stringify(args ?? {})}`.slice(0, 600)}>
        <div className="flex items-center gap-1.5">
          {done ? <Icon aria-hidden className="size-3.5 shrink-0" /> : <LoaderIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
          <span className="min-w-0 flex-1 truncate">
            <span className="text-foreground/80">{step.verb}</span>{target && <> <span className="font-mono text-[11.5px]">{target}</span></>}
          </span>
          {failed && <span className="shrink-0 font-medium text-destructive">{result === "Stopped" ? "Stopped" : "Denied"}</span>}
        </div>
        {note && (toolName === "sync_repo" || !done) && <div className="truncate pl-5 text-[11.5px]">{note}</div>}
      </div>
    );
  }

  const full = (approval?.input && typeof approval.input === "object" ? approval.input : args) as Args | undefined;
  const hasArgs = !!full && typeof full === "object" && Object.keys(full).length > 0;
  const preview = hasArgs && (toolName === "create_issue" || toolName === "create_issues");
  const state = approval?.state === "blocked" ? "Blocked (read-only)" : approval?.state === "rejected" ? "Rejected" : isError ? "Failed" : done ? "Done" : approval?.state === "pending" ? "Approval needed" : "Running…";
  const bad = approval?.state === "rejected" || approval?.state === "blocked" || isError;
  const count = preview && toolName === "create_issues" ? countDrafts(Array.isArray(full!.issues) ? full!.issues : []) : 0;

  return (
    <div className="my-2 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs">{toolName}</span>
        <span className={bad ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{state}</span>
      </div>
      {preview ? <IssuePreview toolName={toolName} args={full!} /> : hasArgs && (
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(full, null, 2)}
        </pre>
      )}
      {approval?.state === "pending" && !done && (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => answerApproval(toolCallId, approval, true)}>{count > 1 ? `Create ${count} issues` : "Approve"}</Button>
          <Button size="sm" variant="outline" onClick={() => answerApproval(toolCallId, approval, false)}>Reject</Button>
        </div>
      )}
      {file && (
        <div className="mt-2">
          <a className="font-medium text-brand underline" href={`/api/download?id=${encodeURIComponent(file.id)}`} download={file.name}>{file.name}</a>{" "}
          <span className="text-xs text-muted-foreground">{Math.max(1, Math.round(file.size / 1024))} KB</span>
        </div>
      )}
    </div>
  );
}
