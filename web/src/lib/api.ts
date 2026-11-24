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
export type Repo = { name: string; private: boolean; issues: boolean; role: string };
export type Auth = { connected: boolean; login?: string; avatar?: string; source?: string; deviceFlow?: boolean; device?: { status: string; error?: string } | null; error?: string };
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
