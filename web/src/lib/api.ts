export type Label = { name: string; color: string };
export type Milestone = { number: number; title: string; state: string };
export type Issue = {
  number: number; title: string; state: "open" | "closed"; column: string;
  labels: string[]; labelObjs: Label[]; assignees: string[];
  milestone: { number: number; title: string } | null;
  parent: number | null; sub: { total: number; completed: number } | null;
  url: string; comments: number; body: string;
  sub_issues?: Issue[]; comment_list?: { by: string; at: string; body: string }[];
};
export type RepoAccess = { login: string; role: string };
/** account = the connected GitHub account used for this repo; accounts = every connected account that can open it. */
export type Repo = { name: string; private: boolean; issues: boolean; role: string; account?: string; accounts?: RepoAccess[] };
export type Account = { login: string; avatar: string; source: string; sourceLabel: string; addedAt: string | null; status: "ok" | "attention"; error: string; default: boolean };
export type HiddenAccount = { login: string; avatar: string; source: string; sourceLabel: string };
export type ClaudeMethod = "login" | "oauth" | "apikey";
export type ClaudeBrief = { method: ClaudeMethod; label: string; source: "saved" | "env" | "default"; tail: string; model: string; billing: "api" | "subscription" };
/** Secrets never come back from the server: only a masked tail such as "••••abcd". */
export type ClaudeSettings = ClaudeBrief & {
  saved: { oauth: string | null; apikey: string | null }; env: { oauth: boolean; apikey: boolean };
  ambientApiKeyIgnored: boolean; modelSource: "saved" | "env" | "default"; models: string[];
};
/** The default account fills login/avatar/source (the pre-multi-account shape); accounts lists all of them. */
export type Auth = {
  connected: boolean; login?: string; avatar?: string; source?: string; deviceFlow?: boolean;
  device?: { status: string; error?: string; login?: string } | null; error?: string; readOnly?: boolean;
  accounts?: Account[]; hidden?: HiddenAccount[]; notices?: string[]; claude?: ClaudeBrief; chatMode?: "planner" | "classic"; plannerModel?: string;
};
/** Which account a repo's reads and writes go through (this decides attribution on GitHub). */
export type RepoAccount = { repo: string; login: string; avatar: string; role: string; overridden: boolean; candidates: RepoAccess[] };
export type BoardData = { columns: string[]; prefix: string; issues: Issue[] };
export type Meta = { columns: string[]; prefix: string; labels: Label[]; milestones: Milestone[]; assignees: string[] };
export type TreeEntry = { name: string; path: string; type: "dir" | "file"; size: number };
export type RepoFile = { path: string; content: string; url: string; truncated?: boolean };

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}

export const q = (v: string) => encodeURIComponent(v);
export const hex = (c?: string) => (/^[0-9a-f]{6}$/i.test(c || "") ? c! : "888888");
/* Tinted chip in the label's own color; the text is pulled toward the foreground so it stays readable in light and dark. */
export const labelStyle = (c?: string) => ({
  backgroundColor: `color-mix(in oklab, #${hex(c)} 16%, transparent)`,
  borderColor: `color-mix(in oklab, #${hex(c)} 45%, transparent)`,
  color: `color-mix(in oklab, #${hex(c)} 32%, var(--foreground))`,
});
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
