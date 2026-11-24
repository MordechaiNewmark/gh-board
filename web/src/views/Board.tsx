import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { labelStyle, type Issue } from "@/lib/api";

export function IssueMeta({ issue, prefix }: { issue: Issue; prefix: string }) {
  const labels = issue.labelObjs.filter((l) => !l.name.toLowerCase().startsWith(prefix.toLowerCase()));
  return (
    <>
      {labels.map((l) => <Badge key={l.name} variant="outline" style={labelStyle(l.color)}>{l.name}</Badge>)}
      {issue.sub && issue.sub.total > 0 && <Badge variant="outline">{issue.sub.completed}/{issue.sub.total} sub</Badge>}
      {issue.milestone && <Badge variant="outline">{issue.milestone.title}</Badge>}
      {issue.assignees.length > 0 && <span className="text-xs text-muted-foreground">{issue.assignees.map((a) => `@${a}`).join(" ")}</span>}
    </>
  );
}

type Props = { columns: string[]; prefix: string; issues: Issue[]; onOpen: (n: number) => void; onMove: (n: number, column: string) => void };

export function Board({ columns, prefix, issues, onOpen, onMove }: Props) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="-mx-3 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-3 pb-2 md:mx-0 md:snap-none md:px-0">
      {columns.map((col) => {
        const items = issues.filter((i) => i.column === col);
        return (
          <section
            key={col}
            aria-label={col}
            className={cn("w-[84vw] shrink-0 snap-center rounded-xl bg-secondary p-2.5 md:w-auto md:min-w-56 md:flex-1", over === col && "outline-2 outline-brand")}
            onDragOver={(e) => { e.preventDefault(); setOver(col); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const n = Number(e.dataTransfer.getData("text/plain"));
              if (n) onMove(n, col);
            }}
          >
            <h2 className="mx-1 mb-2.5 mt-0.5 flex items-center justify-between text-[12.5px] font-semibold">
              {col}
              <span className="rounded-full bg-background px-2 text-xs font-normal text-muted-foreground">{items.length}</span>
            </h2>
            <div className="flex min-h-10 flex-col gap-2">
              {items.map((i) => (
                <button
                  key={i.number}
                  type="button"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.number))}
                  onClick={() => onOpen(i.number)}
                  className="rounded-lg border border-input bg-card px-3 py-2.5 text-left hover:border-muted-foreground"
                >
                  <span className="block font-mono text-xs text-muted-foreground">#{i.number}{i.parent ? ` · child of #${i.parent}` : ""}</span>
                  <span className="mt-0.5 block text-sm font-medium">{i.title}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-1.5"><IssueMeta issue={i} prefix={prefix} /></span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
