import { useState, type ReactNode } from "react";
import { ChevronRightIcon, ListTreeIcon, PlusIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, IssueMeta, StateIcon } from "@/components/issue-bits";
import { cn } from "@/lib/utils";
import type { Issue } from "@/lib/api";

type Props = { prefix: string; issues: Issue[]; filtered: boolean; onOpen: (n: number) => void; onAddSub: (parent: number) => void };

export function Hierarchy({ prefix, issues, filtered, onOpen, onAddSub }: Props) {
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const have = new Set(issues.map((i) => i.number));
  const kids = new Map<number, Issue[]>();
  for (const i of issues) {
    const p = i.parent && have.has(i.parent) ? i.parent : 0;
    kids.set(p, [...(kids.get(p) ?? []), i]);
  }
  const toggle = (n: number) => setClosed((s) => { const next = new Set(s); if (next.has(n)) next.delete(n); else next.add(n); return next; });

  const rows = (list: Issue[], depth: number): ReactNode =>
    list.map((i) => {
      const children = depth < 8 ? kids.get(i.number) ?? [] : [];
      const open = !closed.has(i.number);
      return (
        <li key={i.number} role="treeitem" aria-expanded={children.length ? open : undefined} aria-level={depth + 1}>
          <div className="group/row flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t py-2 pr-3 transition-colors hover:bg-muted/60" style={{ paddingLeft: 8 + depth * 22 }}>
            {children.length ? (
              <button type="button" aria-label={open ? "Collapse sub-issues" : "Expand sub-issues"} onClick={() => toggle(i.number)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              </button>
            ) : <span className="size-5 shrink-0" />}
            <button type="button" className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded text-left" onClick={() => onOpen(i.number)}>
              <StateIcon state={i.state} />
              <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">#{i.number}</span>
              <span className={cn("truncate text-[13.5px]", i.state === "closed" ? "text-muted-foreground line-through decoration-muted-foreground/40" : "font-medium")}>{i.title}</span>
            </button>
            <IssueMeta issue={i} prefix={prefix} />
            <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">{i.column}</span>
            <button type="button" aria-label={`Add sub-issue to #${i.number}`} title="Add sub-issue" onClick={() => onAddSub(i.number)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover/row:opacity-100">
              <PlusIcon className="size-4" />
            </button>
          </div>
          {children.length > 0 && open && <ul role="group">{rows(children, depth + 1)}</ul>}
        </li>
      );
    });

  const roots = kids.get(0) ?? [];
  return (
    <div className="scroll-thin h-full overflow-y-auto px-3 pb-4 md:px-5">
      {roots.length ? (
        <>
          <ul role="tree" aria-label="Issue hierarchy" className="overflow-hidden rounded-xl border bg-card shadow-xs [&>li:first-child>div]:border-t-0">{rows(roots, 0)}</ul>
          <p className="mt-2.5 text-xs text-muted-foreground">Hierarchy uses GitHub sub-issues. Open an issue to change its parent.</p>
        </>
      ) : (
        <EmptyState icon={<ListTreeIcon />} title={filtered ? "No matching issues" : "No issues yet"}>
          {filtered ? "Nothing matches the current filter. Clear it to see every issue." : "Create an issue, then add sub-issues to build a hierarchy."}
        </EmptyState>
      )}
    </div>
  );
}

export function HierarchySkeleton() {
  return (
    <div className="px-3 md:px-5" aria-busy="true" aria-label="Loading issues">
      <div className="overflow-hidden rounded-xl border bg-card">
        {[0, 1, 1, 0, 1, 2, 0, 0].map((d, k) => (
          <div key={k} className="flex items-center gap-3 border-b py-2.5 pr-3 last:border-b-0" style={{ paddingLeft: 16 + d * 22 }}>
            <Skeleton className="size-3.5 rounded-full" /><Skeleton className="h-3 w-8" /><Skeleton className="h-3.5" style={{ width: `${30 + ((k * 17) % 35)}%` }} />
            <Skeleton className="ml-auto h-4 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
