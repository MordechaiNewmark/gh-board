import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, errMsg, q, type RepoFile, type TreeEntry } from "@/lib/api";

type Dir = { open: boolean; items: TreeEntry[] };
type Props = { repo: string; onNewIssue: (file: RepoFile) => void; onAsk: (file: RepoFile) => void };

export function Code({ repo, onNewIssue, onAsk }: Props) {
  const [tree, setTree] = useState<Record<string, Dir>>({});
  const [file, setFile] = useState<RepoFile | null>(null);
  const [error, setError] = useState("");

  const loadDir = async (path: string) => {
    try {
      const items = await api<TreeEntry[]>(`/api/tree?repo=${q(repo)}&path=${q(path)}`);
      setTree((t) => ({ ...t, [path]: { open: true, items } }));
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { setTree({}); setFile(null); setError(""); void loadDir(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [repo]);

  const toggle = (path: string) => (tree[path] ? setTree((t) => ({ ...t, [path]: { ...t[path], open: !t[path].open } })) : void loadDir(path));
  const open = async (path: string) => {
    try { setFile(await api<RepoFile>(`/api/file?repo=${q(repo)}&path=${q(path)}`)); }
    catch (e) { setFile({ path, content: errMsg(e), url: "" }); }
  };

  const list = (path: string, depth: number): ReactNode =>
    (tree[path]?.items ?? []).map((e) => (
      <div key={e.path}>
        <button
          type="button"
          className={cn("block w-full whitespace-pre rounded px-1.5 py-0.5 text-left", file?.path === e.path && "bg-secondary")}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => (e.type === "dir" ? toggle(e.path) : void open(e.path))}
        >
          {e.type === "dir" ? (tree[e.path]?.open ? "▾ " : "▸ ") : "  "}{e.name}
        </button>
        {e.type === "dir" && tree[e.path]?.open && list(e.path, depth + 1)}
      </div>
    ));

  return (
    <div className="flex flex-col items-stretch gap-3.5 md:flex-row md:items-start">
      <div className="max-h-52 overflow-auto rounded-lg border bg-card p-2 font-mono text-[12.5px] md:max-h-[calc(100dvh-150px)] md:w-64 md:shrink-0">
        {error ? <span className="text-destructive">{error}</span> : list("", 0)}
      </div>
      <div className="min-w-0 flex-1 rounded-lg border bg-card">
        {file ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <span className="min-w-0 flex-1 basis-40 break-all font-mono text-[12.5px]">{file.path}</span>
              <Button size="sm" variant="outline" onClick={() => onNewIssue(file)}>New issue from file</Button>
              <Button size="sm" variant="outline" onClick={() => onAsk(file)}>Ask Claude</Button>
              {file.url && <a className="text-sm text-brand underline" href={file.url} target="_blank" rel="noopener">GitHub</a>}
            </div>
            <pre className="overflow-auto p-3 font-mono text-[12.5px] leading-relaxed md:max-h-[calc(100dvh-200px)]">{file.content}{file.truncated ? "\n… truncated" : ""}</pre>
          </>
        ) : (
          <p className="p-3.5 text-sm text-muted-foreground">Pick a file to read it. Claude can read the same files when you ask in chat.</p>
        )}
      </div>
    </div>
  );
}
