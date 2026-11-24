import { useState, type DragEvent } from "react";
import { CornerDownRightIcon, PlusIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarStack, CommentCount, LabelChip, MilestoneTag, StateIcon, SubProgress, visibleLabels } from "@/components/issue-bits";
import { cn } from "@/lib/utils";
import type { Issue } from "@/lib/api";

type Props = {
  columns: string[]; prefix: string; issues: Issue[];
  /** True when a filter is hiding some issues (changes the empty-lane hint). */
  filtered: boolean;
  onOpen: (n: number) => void;
  onMove: (n: number, column: string) => void;
  onNew: (column: string) => void;
};

const DRAG_TYPE = "application/x-gh-board-issue";
/* Lane accent dots, by position; the last lane (which closes issues) always gets the "done" colour. */
const DOTS = ["bg-muted-foreground/50", "bg-sky-500", "bg-amber-500", "bg-fuchsia-500", "bg-teal-500"];
const laneCls = "flex h-full w-[85vw] max-w-[340px] shrink-0 snap-center flex-col rounded-xl border border-lane-border bg-lane md:w-auto md:min-w-[264px] md:max-w-[380px] md:flex-1 md:snap-align-none";
const boardCls = "scroll-thin flex h-full min-h-0 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-3 pb-3 md:snap-none md:px-5 md:pb-4";

function Card({ issue, prefix, dragging, onOpen, onDragStart, onDragEnd }: {
  issue: Issue; prefix: string; dragging: boolean; onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void; onDragEnd: () => void;
}) {
  const labels = visibleLabels(issue, prefix);
  const hasFooter = !!issue.milestone || issue.comments > 0 || issue.assignees.length > 0 || (issue.sub?.total ?? 0) > 0;
  return (
    <article
      role="button"
      tabIndex={0}
      draggable
      aria-label={`#${issue.number} ${issue.title}`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={cn(
        "group/card cursor-pointer select-none rounded-lg bg-card px-3 py-2.5 text-left shadow-card transition-[box-shadow,transform,opacity] duration-150",
        "hover:-translate-y-px hover:shadow-card-hover active:translate-y-0 active:cursor-grabbing",
        dragging && "opacity-40 shadow-none",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <StateIcon state={issue.state} />
        <span className="font-mono font-medium tabular-nums">#{issue.number}</span>
        {issue.parent ? (
          <span className="inline-flex items-center gap-0.5 font-mono" title={`Sub-issue of #${issue.parent}`}><CornerDownRightIcon aria-hidden className="size-3" />#{issue.parent}</span>
        ) : null}
      </div>
      <p className={cn("mt-1 text-[13.5px] font-medium leading-snug text-card-foreground [overflow-wrap:anywhere]", issue.state === "closed" && "text-muted-foreground")}>{issue.title}</p>
      {labels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{labels.map((l) => <LabelChip key={l.name} label={l} />)}</div>}
      {hasFooter && (
        <div className="mt-2.5 flex items-center gap-3">
          <SubProgress sub={issue.sub} />
          <CommentCount count={issue.comments} />
          <MilestoneTag milestone={issue.milestone} />
          <span className="ml-auto"><AvatarStack logins={issue.assignees} /></span>
        </div>
      )}
    </article>
  );
}

export function Board({ columns, prefix, issues, filtered, onOpen, onMove, onNew }: Props) {
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ number: number; from: string } | null>(null);
  const last = columns[columns.length - 1];

  return (
    <div className={boardCls} role="list" aria-label="Board columns">
      {columns.map((col, idx) => {
        const items = issues.filter((i) => i.column === col);
        const target = !!dragging && dragging.from !== col;
        const active = target && over === col;
        return (
          <section
            key={col}
            role="listitem"
            aria-label={`${col}, ${items.length} issue${items.length === 1 ? "" : "s"}`}
            className={cn(laneCls, "transition-colors", active && "border-brand bg-brand/[0.07] ring-2 ring-brand/40")}
            onDragOver={(e) => { if (!e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== col) setOver(col); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col ? null : o)); }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null); setDragging(null);
              const n = Number(e.dataTransfer.getData(DRAG_TYPE));
              if (n) onMove(n, col);
            }}
          >
            <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-2.5">
              <span aria-hidden className={cn("size-2 rounded-full", col === last && columns.length > 1 ? "bg-done" : DOTS[idx % DOTS.length])} />
              <h2 className="truncate text-[13px] font-semibold tracking-[-0.005em]">{col}</h2>
              <span className="rounded-full bg-background/80 px-1.5 text-[11.5px] font-medium tabular-nums leading-5 text-muted-foreground ring-1 ring-lane-border">{items.length}</span>
              <button type="button" aria-label={`New issue in ${col}`} title={`New issue in ${col}`} onClick={() => onNew(col)}
                className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
                <PlusIcon className="size-4" />
              </button>
            </header>
            <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2 pt-0.5">
              {items.map((i) => (
                <Card
                  key={i.number} issue={i} prefix={prefix} dragging={dragging?.number === i.number}
                  onOpen={() => onOpen(i.number)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, String(i.number));
                    e.dataTransfer.setData("text/plain", `#${i.number} ${i.title}`);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging({ number: i.number, from: col });
                  }}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                />
              ))}
              {(items.length === 0 || target) && (
                <div className={cn(
                  "flex shrink-0 items-center justify-center rounded-lg border border-dashed px-3 text-center text-[12.5px] text-muted-foreground transition-colors",
                  items.length === 0 ? "min-h-24 flex-1" : "min-h-12",
                  active ? "border-brand bg-brand/10 text-brand" : "border-input/80",
                )}>
                  {target ? (col === last ? "Drop to move here and close" : "Drop to move here") : filtered ? "No matching issues" : col === last ? "Nothing done yet. Issues dropped here are closed." : "No issues. Drag a card here."}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const SKELETON = [3, 2, 4, 1, 2];
export function BoardSkeleton({ columns }: { columns: string[] }) {
  const cols = columns.length ? columns : ["Backlog", "Todo", "In progress", "Review", "Done"];
  return (
    <div className={boardCls} aria-busy="true" aria-label="Loading board">
      {cols.map((col, i) => (
        <section key={col} className={laneCls}>
          <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
            <span className="size-2 rounded-full bg-muted-foreground/30" />
            <h2 className="text-[13px] font-semibold text-muted-foreground">{col}</h2>
          </header>
          <div className="flex flex-col gap-2 overflow-hidden px-2 pb-2">
            {Array.from({ length: SKELETON[i % SKELETON.length] }, (_, k) => (
              <div key={k} className="rounded-lg bg-card px-3 py-3 shadow-card">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="mt-2.5 h-3.5 w-full" />
                <Skeleton className="mt-1.5 h-3.5 w-2/3" />
                <div className="mt-3 flex gap-1.5"><Skeleton className="h-4 w-12 rounded-full" /><Skeleton className="h-4 w-14 rounded-full" /></div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
