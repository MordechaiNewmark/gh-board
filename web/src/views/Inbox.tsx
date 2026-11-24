import { useEffect } from "react";
import { BotIcon, CircleXIcon, GitMergeIcon, InboxIcon, OctagonAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/issue-bits";
import { CiChip } from "@/loop/bits";
import { Review } from "@/loop/Review";
import { ago, type InboxItem, type InboxKind, type LoopData } from "@/lib/loop";
import { cn } from "@/lib/utils";

const KIND: Record<InboxKind, { title: string; icon: typeof InboxIcon; cls: string }> = {
  "needs-human": { title: "Needs you", icon: OctagonAlertIcon, cls: "text-destructive" },
  merge: { title: "Ready to merge", icon: GitMergeIcon, cls: "text-teal-600 dark:text-teal-400" },
  "ci-failed": { title: "Failing checks", icon: CircleXIcon, cls: "text-orange-600 dark:text-orange-400" },
  "stale-claim": { title: "Stale claims", icon: BotIcon, cls: "text-amber-600 dark:text-amber-400" },
};
const ORDER: InboxKind[] = ["needs-human", "merge", "ci-failed", "stale-claim"];

type Props = {
  repo: string; data: LoopData; readOnly?: boolean;
  /** Selected item id, or "pr-<n>" when a PR was opened from the board. */
  selected: string; onSelect: (id: string) => void;
  onOpenIssue: (n: number) => void; onDone: (message: string) => void;
};

/* What waits on the human, most urgent first, with the evidence-first review beside it. */
export function Inbox({ repo, data, readOnly, selected, onSelect, onOpenIssue, onDone }: Props) {
  const items = data.inbox;
  const direct = /^pr-(\d+)$/.exec(selected);
  const current = items.find((i) => i.id === selected) ?? null;
  const pr = direct ? Number(direct[1]) : current?.pr ?? null;
  // Desktop always shows something on the right: default to the first item.
  useEffect(() => { if (!selected && items.length && window.matchMedia("(min-width: 768px)").matches) onSelect(items[0].id); }, [selected, items, onSelect]);

  const detail = pr ? (
    <Review repo={repo} number={pr} readOnly={readOnly} onBack={() => onSelect("")} onOpenIssue={onOpenIssue} onDone={(m) => { onSelect(""); onDone(m); }} />
  ) : current ? (
    <EmptyState icon={<BotIcon />} title={current.title} action={<Button variant="outline" size="sm" onClick={() => current.issue && onOpenIssue(current.issue)}>Open issue #{current.issue}</Button>}>
      {current.detail}
    </EmptyState>
  ) : null;

  if (!items.length && !pr) return <EmptyState icon={<InboxIcon />} title="Nothing needs you">No escalations, no approved pull requests waiting, no failing checks and no stale claims in {repo}.</EmptyState>;

  return (
    <div className="flex h-full min-h-0">
      <div className={cn("scroll-thin min-h-0 w-full shrink-0 overflow-y-auto border-r md:w-[340px]", (pr || current) && "hidden md:block")}>
        {ORDER.filter((k) => items.some((i) => i.kind === k)).map((k) => {
          const K = KIND[k];
          return (
            <section key={k} aria-label={K.title}>
              <h2 className="sticky top-0 z-[1] flex items-center gap-1.5 border-b bg-sidebar px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:px-4">
                <K.icon aria-hidden className={cn("size-3.5", K.cls)} />{K.title}<span className="ml-auto tabular-nums">{items.filter((i) => i.kind === k).length}</span>
              </h2>
              <ul>
                {items.filter((i) => i.kind === k).map((i: InboxItem) => (
                  <li key={i.id}>
                    <button type="button" onClick={() => onSelect(i.id)} aria-current={selected === i.id ? "true" : undefined}
                      className={cn("relative flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors hover:bg-accent/50 md:px-4", selected === i.id && "bg-accent/70")}>
                      {selected === i.id && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-brand" />}
                      <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        {i.pr ? <span className="font-mono font-medium">PR #{i.pr}</span> : <span className="font-mono font-medium">#{i.issue}</span>}
                        {i.pr && i.issue && <span className="font-mono">· task #{i.issue}</span>}
                        {i.ci && <CiChip ci={i.ci} className="ml-1" />}
                        <span className="ml-auto shrink-0 tabular-nums">{ago(i.at)}</span>
                      </span>
                      <span className="text-[13.5px] font-medium leading-snug [overflow-wrap:anywhere]">{i.title}</span>
                      <span className="text-[12.5px] leading-snug text-muted-foreground">{i.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1", !(pr || current) && "hidden md:block")}>
        {detail ?? <EmptyState icon={<InboxIcon />} title="Pick an item">The review opens here, evidence first.</EmptyState>}
      </div>
    </div>
  );
}
