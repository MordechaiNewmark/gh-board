import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Issue } from "@/lib/api";
import { IssueMeta } from "./Board";

type Props = { prefix: string; issues: Issue[]; onOpen: (n: number) => void; onAddSub: (parent: number) => void };

export function Hierarchy({ prefix, issues, onOpen, onAddSub }: Props) {
  const have = new Set(issues.map((i) => i.number));
  const kids = new Map<number, Issue[]>();
  for (const i of issues) {
    const p = i.parent && have.has(i.parent) ? i.parent : 0;
    kids.set(p, [...(kids.get(p) ?? []), i]);
  }
  const rows = (list: Issue[], depth: number): ReactNode =>
    list.map((i) => (
      <div key={i.number}>
        <div className="flex flex-wrap items-center gap-2.5 border-b bg-card py-2 pr-3" style={{ paddingLeft: 12 + depth * 26 }}>
          <button type="button" className="flex min-w-0 flex-1 basis-52 items-center gap-2.5 text-left" onClick={() => onOpen(i.number)}>
            <span className="font-mono text-xs text-muted-foreground">#{i.number}</span>
            <span className={i.state === "closed" ? "text-sm text-muted-foreground line-through" : "text-sm font-medium"}>{i.title}</span>
          </button>
          <IssueMeta issue={i} prefix={prefix} />
          <Badge variant="secondary">{i.column}</Badge>
          <Button variant="link" size="sm" className="h-auto p-0 text-brand" onClick={() => onAddSub(i.number)}>Add sub-issue</Button>
        </div>
        {depth < 8 && rows(kids.get(i.number) ?? [], depth + 1)}
      </div>
    ));
  return (
    <div>
      <div className="overflow-hidden rounded-lg border">
        {(kids.get(0) ?? []).length ? rows(kids.get(0)!, 0) : <div className="p-3.5 text-sm text-muted-foreground">No issues.</div>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Hierarchy uses GitHub sub-issues. Open an issue to change its parent.</p>
    </div>
  );
}
