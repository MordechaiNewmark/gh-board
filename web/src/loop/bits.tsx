import type { ReactNode } from "react";
import { BanIcon, CheckIcon, CircleDashedIcon, CircleHelpIcon, HistoryIcon, LoaderIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Ci, CriterionStatus, LoopStateId } from "@/lib/loop";

/* One colour per loop state, used for lane dots, pills and inbox markers. */
export const STATE_DOT: Record<LoopStateId, string> = {
  blocked: "bg-muted-foreground/50", ready: "bg-success", claimed: "bg-amber-500", "in-review": "bg-sky-500",
  "changes-requested": "bg-orange-500", approved: "bg-teal-500", "needs-human": "bg-destructive", done: "bg-done",
};
export const STATE_TITLE: Record<LoopStateId, string> = {
  blocked: "Blocked", ready: "Ready", claimed: "Claimed", "in-review": "In review", "changes-requested": "Changes requested",
  approved: "Approved", "needs-human": "Needs human", done: "Done",
};

export const chip = "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium leading-[18px] tabular-nums";
export const tone = {
  neutral: "border-border bg-background text-muted-foreground",
  good: "border-success/30 bg-success/10 text-success",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  brand: "border-brand/30 bg-brand/10 text-brand",
};

export function CiChip({ ci, className }: { ci: Ci; className?: string }) {
  if (ci === "none") return <span className={cn(chip, tone.neutral, className)} title="No CI checks reported for this commit"><CircleDashedIcon aria-hidden className="size-3" />no CI</span>;
  if (ci === "pending") return <span className={cn(chip, tone.info, className)} title="Checks are running"><LoaderIcon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />CI</span>;
  if (ci === "failure") return <span className={cn(chip, tone.bad, className)} title="A check is failing"><XIcon aria-hidden className="size-3" />CI</span>;
  return <span className={cn(chip, tone.good, className)} title="All checks passed"><CheckIcon aria-hidden className="size-3" />CI</span>;
}

export function StatusMark({ status, className }: { status: CriterionStatus; className?: string }) {
  const base = cn("flex size-5 shrink-0 items-center justify-center rounded-full [&>svg]:size-3", className);
  if (status === "pass") return <span title="Passed" className={cn(base, "bg-success/15 text-success")}><CheckIcon aria-label="Passed" strokeWidth={3} /></span>;
  if (status === "fail") return <span title="Failed" className={cn(base, "bg-destructive/15 text-destructive")}><XIcon aria-label="Failed" strokeWidth={3} /></span>;
  if (status === "carried") return <span title="Carried forward from an earlier review" className={cn(base, "bg-success/10 text-success")}><HistoryIcon aria-label="Carried forward" /></span>;
  return <span title="The review does not mention this criterion" className={cn(base, "bg-muted text-muted-foreground")}><CircleHelpIcon aria-label="Not reported" /></span>;
}

export function Notice({ kind = "warn", icon, children, action, className }: { kind?: "warn" | "bad" | "info"; icon?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={kind === "bad" ? "alert" : "note"} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-[13px]", tone[kind], "text-foreground", className)}>
      <span className={cn("mt-0.5 shrink-0 [&>svg]:size-4", kind === "bad" ? "text-destructive" : kind === "info" ? "text-sky-600 dark:text-sky-400" : "text-amber-600 dark:text-amber-400")}>{icon ?? <BanIcon aria-hidden />}</span>
      <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">{children}</div>
      {action}
    </div>
  );
}

/* Every action that changes GitHub or starts agents goes through this: what will happen, then an explicit button. */
export function ConfirmDialog({ open, title, description, children, confirmLabel, danger, disabled, busy, error, onConfirm, onClose }: {
  open: boolean; title: string; description?: ReactNode; children?: ReactNode; confirmLabel: string; danger?: boolean; disabled?: boolean; busy?: boolean; error?: string;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <div className="border-b px-5 py-4">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          {description && <DialogDescription className="mt-1 text-[13px]">{description}</DialogDescription>}
        </div>
        {children && <div className="flex flex-col gap-3 px-5 py-4 text-[13px]">{children}</div>}
        {error && <p role="alert" className="mx-5 mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive [overflow-wrap:anywhere]">{error}</p>}
        <div className="flex justify-end gap-2 border-t bg-muted/40 px-5 py-3">
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={disabled || busy} onClick={onConfirm} className={danger ? "bg-destructive text-white hover:bg-destructive/90" : "bg-brand text-brand-foreground hover:bg-brand/90"}>
            {busy && <LoaderIcon className="animate-spin" />}{confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-dashed py-1.5 last:border-b-0">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</span>
  </div>
);
