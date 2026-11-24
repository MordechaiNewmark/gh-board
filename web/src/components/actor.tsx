import { UserAvatar } from "@/components/issue-bits";
import { cn } from "@/lib/utils";
import type { RepoAccount } from "@/lib/api";

/**
 * "as @login": the GitHub account a repo's writes are attributed to.
 * When more than one connected account can open the repo it becomes a picker (the choice is remembered per repo).
 */
export function ActorChip({ actor, onChange, className, title }: { actor: RepoAccount; onChange?: (login: string) => void; className?: string; title?: string }) {
  const choices = actor.candidates.filter((c) => c.login);
  const pickable = !!onChange && choices.length > 1;
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border bg-background py-px pl-1 pr-2 text-[11.5px] font-medium leading-5 text-foreground/80", pickable && "pr-0.5", className)}>
      <UserAvatar login={actor.login} src={actor.avatar || undefined} size={14} className="ring-0" />
      <span className="text-muted-foreground">as</span>
      {pickable ? (
        <select aria-label="GitHub account used for this repository" value={actor.login} onChange={(e) => onChange?.(e.target.value)}
          className="max-w-36 cursor-pointer truncate rounded-full bg-transparent pr-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {choices.map((c) => <option key={c.login} value={c.login}>@{c.login}{c.role ? ` (${c.role})` : ""}</option>)}
        </select>
      ) : <span className="max-w-36 truncate">@{actor.login}</span>}
    </span>
  );
}
