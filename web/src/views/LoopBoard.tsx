import { BotIcon, CircleAlertIcon, CircleCheckIcon, GitPullRequestIcon, HourglassIcon, RepeatIcon, UserIcon } from "lucide-react";
import { LabelChip } from "@/components/issue-bits";
import { CiChip, STATE_DOT, chip, tone } from "@/loop/bits";
import { cn } from "@/lib/utils";
import type { LoopCard, LoopData } from "@/lib/loop";

type Props = {
  data: LoopData; filter: string;
  onOpen: (n: number) => void;
  /** Open the evidence-first review of a PR. */
  onReview: (pr: number) => void;
  /** Hand a prompt to the planner chat. */
  onAsk: (prompt: string) => void;
};

const laneCls = "flex h-full w-[82vw] max-w-[320px] shrink-0 snap-center flex-col rounded-xl border border-lane-border bg-lane md:w-[272px] md:max-w-none md:snap-align-none";
const fmtIdle = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

function Card({ card, onOpen, onReview, onAsk }: { card: LoopCard } & Pick<Props, "onOpen" | "onReview" | "onAsk">) {
  const errors = card.lint?.problems.filter((p) => p.level === "error") ?? [];
  const warns = card.lint?.problems.filter((p) => p.level === "warn") ?? [];
  const gaps = card.lint ? [...errors, ...warns] : [];
  const waiting = card.state === "blocked" && card.blockedBy.length > 0;
  return (
    <article
      role="button" tabIndex={0} aria-label={`#${card.number} ${card.title}`}
      onClick={() => onOpen(card.number)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(card.number); } }}
      className={cn("cursor-pointer rounded-lg bg-card px-3 py-2.5 text-left shadow-card transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-card-hover", card.state === "needs-human" && "ring-1 ring-destructive/40")}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="font-mono font-medium tabular-nums">#{card.number}</span>
        {card.size && <span className={cn(chip, tone.neutral)} title={`size:${card.size}`}>{card.size}</span>}
        {card.module && <span className={cn(chip, tone.neutral, "min-w-0 font-mono")} title={`module:${card.module} (one task in flight per module)`}><span className="truncate">{card.module}</span></span>}
        {card.epic && <span className="ml-auto shrink-0 font-mono" title={`Part of epic #${card.epic}`}>epic #{card.epic}</span>}
      </div>
      <p className={cn("mt-1 text-[13.5px] font-medium leading-snug text-card-foreground [overflow-wrap:anywhere]", !card.open && "text-muted-foreground")}>{card.title}</p>

      {waiting && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground">
          <HourglassIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>Waits for {card.blockedBy.map((d, i) => <span key={d.number}>{i > 0 && ", "}<span title={d.title} className="font-mono font-medium text-foreground/80">#{d.number}</span></span>)}</span>
        </p>
      )}
      {card.claim && card.open && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground", card.claim.stale && "text-amber-700 dark:text-amber-400")}>
          {card.claim.kind === "agent" ? <BotIcon aria-hidden className="size-3.5 shrink-0" /> : <UserIcon aria-hidden className="size-3.5 shrink-0" />}
          <span className="truncate">{card.claim.kind === "agent" ? "Agent" : "Human"}{card.claim.by && <> as <span className="font-medium text-foreground/80">@{card.claim.by}</span></>} · idle {fmtIdle(card.claim.idleHours)}{card.claim.stale && " · stale"}</span>
        </p>
      )}
      {card.pr && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button type="button" onClick={(e) => { e.stopPropagation(); onReview(card.pr!.number); }} title={`Review the evidence for PR #${card.pr.number}`}
            className={cn(chip, tone.brand, "hover:bg-brand/20")}>
            <GitPullRequestIcon aria-hidden className="size-3" />PR #{card.pr.number}
          </button>
          <CiChip ci={card.pr.ci} />
          {card.pr.iteration > 0 && (
            <span className={cn(chip, card.pr.iteration >= card.pr.of ? tone.bad : tone.warn)} title={`Patch round ${card.pr.iteration} of ${card.pr.of}; after ${card.pr.of} the loop escalates to you`}>
              <RepeatIcon aria-hidden className="size-3" />patch {card.pr.iteration}/{card.pr.of}
            </span>
          )}
        </div>
      )}
      {card.labels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{card.labels.map((l) => <LabelChip key={l.name} label={l} />)}</div>}
      {card.lint && (card.state === "ready" || card.state === "blocked" || gaps.length > 0) && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-dashed pt-2">
          {errors.length > 0 ? (
            <button type="button" title={gaps.map((p) => p.message).join("\n")}
              onClick={(e) => { e.stopPropagation(); onAsk(`Issue #${card.number} is not ready for the delivery loop. Fix it with update_issue:\n${gaps.map((p) => `- ${p.message}`).join("\n")}`); }}
              className={cn(chip, tone.bad, "hover:bg-destructive/20")}>
              <CircleAlertIcon aria-hidden className="size-3" />Not ready · {errors.length} gap{errors.length === 1 ? "" : "s"}
            </button>
          ) : (
            <span className={cn(chip, tone.good)} title="Has what the loop needs: executable criteria, size, module, status, valid dependencies"><CircleCheckIcon aria-hidden className="size-3" />Loop-ready</span>
          )}
          {errors.length === 0 && warns.length > 0 && <span className="truncate text-[11.5px] text-muted-foreground" title={warns.map((p) => p.message).join("\n")}>{warns.length} note{warns.length === 1 ? "" : "s"}</span>}
          {errors.length > 0 && <span className="truncate text-[11.5px] text-muted-foreground">{errors[0].message}</span>}
        </div>
      )}
    </article>
  );
}

/* The live loop: one lane per state of the delivery-loop plugin. The loop moves the cards, not the user. */
export function LoopBoard({ data, filter, onOpen, onReview, onAsk }: Props) {
  const f = filter.trim().toLowerCase();
  const match = (c: LoopCard) => !f || `${c.title} #${c.number} ${c.module} size:${c.size} ${c.labels.map((l) => l.name).join(" ")} ${c.assignees.map((a) => `@${a}`).join(" ")} ${c.pr ? `pr #${c.pr.number}` : ""}`.toLowerCase().includes(f);
  const byNum = new Map(data.cards.map((c) => [c.number, c]));
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(data.epics.some((e) => e.open) || data.unqueued.length > 0) && (
        <div className="scroll-thin flex shrink-0 items-center gap-2 overflow-x-auto px-3 pb-2.5 md:px-5">
          {data.epics.filter((e) => e.open).map((e) => (
            <button key={e.number} type="button" onClick={() => onOpen(e.number)} title={`Epic #${e.number}: ${e.closed} of ${e.total} tasks done`}
              className="flex shrink-0 items-center gap-2 rounded-full border bg-card py-1 pl-2.5 pr-3 text-[12px] hover:bg-accent/60">
              <span className="max-w-[180px] truncate font-medium">{e.title.replace(/^Epic:\s*/i, "")}</span>
              <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-done" style={{ width: `${e.total ? (e.closed / e.total) * 100 : 0}%` }} /></span>
              <span className="tabular-nums text-muted-foreground">{e.closed}/{e.total}</span>
            </button>
          ))}
          {data.unqueued.length > 0 && (
            <button type="button" title={data.unqueued.map((u) => `#${u.number} ${u.title}`).join("\n")}
              onClick={() => onAsk(`These open issues are not labeled \`task\`, so the delivery loop ignores them: ${data.unqueued.slice(0, 20).map((u) => `#${u.number}`).join(", ")}. Read them and propose how to turn each into loop-ready tasks (or say which are not work items).`)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[12px] text-muted-foreground hover:bg-accent/60 hover:text-foreground">
              {data.unqueued.length} issue{data.unqueued.length === 1 ? "" : "s"} not in the loop · ask the planner
            </button>
          )}
        </div>
      )}
      <div className="scroll-thin flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-3 pb-3 md:snap-none md:px-5 md:pb-4" role="list" aria-label="Loop states">
        {data.columns.map((col) => {
          const items = col.cards.map((n) => byNum.get(n)!).filter((c) => c && match(c));
          return (
            <section key={col.id} role="listitem" aria-label={`${col.title}, ${items.length} task${items.length === 1 ? "" : "s"}`} className={cn(laneCls, col.id === "needs-human" && items.length > 0 && "border-destructive/40")}>
              <header className="shrink-0 px-3 pb-2 pt-2.5">
                <div className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2 rounded-full", STATE_DOT[col.id])} />
                  <h2 className="truncate text-[13px] font-semibold tracking-[-0.005em]">{col.title}</h2>
                  <span className="rounded-full bg-background/80 px-1.5 text-[11.5px] font-medium tabular-nums leading-5 text-muted-foreground ring-1 ring-lane-border">{items.length}</span>
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={col.label ? `${col.hint} (label ${col.label})` : col.hint}>{col.hint}</p>
              </header>
              <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2 pt-0.5">
                {items.map((c) => <Card key={c.number} card={c} onOpen={onOpen} onReview={onReview} onAsk={onAsk} />)}
                {items.length === 0 && <div className="flex min-h-20 flex-1 items-center justify-center rounded-lg border border-dashed border-input/80 px-3 text-center text-[12.5px] text-muted-foreground">{f ? "No matching tasks" : "Nothing here"}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
