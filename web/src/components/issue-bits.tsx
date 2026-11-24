import { useState, type ReactNode } from "react";
import { CircleCheckIcon, CircleDotIcon, ListTreeIcon, MessageSquareIcon, MilestoneIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { labelStyle, type Issue, type Label } from "@/lib/api";

export function LabelChip({ label, className }: { label: Label; className?: string }) {
  return (
    <span style={labelStyle(label.color)} className={cn("inline-flex max-w-full items-center rounded-full border px-2 py-px text-[11px] font-medium leading-[18px]", className)}>
      <span className="truncate">{label.name}</span>
    </span>
  );
}

const HUES = [222, 262, 334, 12, 36, 152, 184, 204];
const hueOf = (s: string) => HUES[[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];

/** GitHub avatar with coloured initials as the fallback (also shown while offline). */
export function UserAvatar({ login, src, size = 20, className }: { login: string; src?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = src ?? `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`;
  return (
    <span
      title={`@${login}`}
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold uppercase text-white ring-2 ring-card", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42), backgroundColor: `hsl(${hueOf(login)} 45% 45%)` }}
    >
      {failed ? login.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?" : <img src={url} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />}
    </span>
  );
}

export function AvatarStack({ logins, size = 20, max = 3 }: { logins: string[]; size?: number; max?: number }) {
  if (!logins.length) return null;
  const extra = logins.length - max;
  return (
    <span className="flex shrink-0 items-center -space-x-1.5" aria-label={`Assigned to ${logins.join(", ")}`}>
      {logins.slice(0, max).map((a) => <UserAvatar key={a} login={a} size={size} />)}
      {extra > 0 && (
        <span className="inline-flex items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-muted-foreground ring-2 ring-card" style={{ width: size, height: size }}>+{extra}</span>
      )}
    </span>
  );
}

export function StateIcon({ state, className }: { state: Issue["state"]; className?: string }) {
  return state === "closed"
    ? <CircleCheckIcon aria-label="Closed" className={cn("size-3.5 shrink-0 text-done", className)} />
    : <CircleDotIcon aria-label="Open" className={cn("size-3.5 shrink-0 text-success", className)} />;
}

const metaCls = "inline-flex items-center gap-1 text-[11.5px] tabular-nums text-muted-foreground [&>svg]:size-3.5";

export function SubProgress({ sub }: { sub: Issue["sub"] }) {
  if (!sub || sub.total <= 0) return null;
  return <span className={metaCls} title={`${sub.completed} of ${sub.total} sub-issues done`}><ListTreeIcon aria-hidden />{sub.completed}/{sub.total}</span>;
}
export function MilestoneTag({ milestone }: { milestone: Issue["milestone"] }) {
  if (!milestone) return null;
  return <span className={cn(metaCls, "min-w-0")} title={`Milestone: ${milestone.title}`}><MilestoneIcon aria-hidden className="shrink-0" /><span className="truncate">{milestone.title}</span></span>;
}
export function CommentCount({ count }: { count: number }) {
  if (!count) return null;
  return <span className={metaCls} title={`${count} comment${count === 1 ? "" : "s"}`}><MessageSquareIcon aria-hidden />{count}</span>;
}

export const visibleLabels = (issue: Issue, prefix: string) => issue.labelObjs.filter((l) => !l.name.toLowerCase().startsWith(prefix.toLowerCase()));

/** Inline labels, sub-issue progress, milestone and assignees (used by the hierarchy rows). */
export function IssueMeta({ issue, prefix }: { issue: Issue; prefix: string }) {
  return (
    <>
      {visibleLabels(issue, prefix).map((l) => <LabelChip key={l.name} label={l} />)}
      <SubProgress sub={issue.sub} />
      <MilestoneTag milestone={issue.milestone} />
      <AvatarStack logins={issue.assignees} />
    </>
  );
}

export function EmptyState({ icon, title, children, action, className }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-56 flex-col items-center justify-center gap-3 p-8 text-center", className)}>
      <div className="flex size-11 items-center justify-center rounded-xl border bg-muted text-muted-foreground [&>svg]:size-5">{icon}</div>
      <div>
        <p className="text-[15px] font-semibold">{title}</p>
        {children && <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** GitHub mark (lucide no longer ships brand icons). */
export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
