import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, ExternalLinkIcon, FileCode2Icon, FileIcon, FolderIcon, FolderOpenIcon, Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/issue-bits";
import { cn } from "@/lib/utils";
import { api, errMsg, q, type RepoFile, type TreeEntry } from "@/lib/api";

type Dir = { open: boolean; items: TreeEntry[] };
type Props = { repo: string; onNewIssue: (file: RepoFile) => void; onAsk: (file: RepoFile) => void };

export function Code({ repo, onNewIssue, onAsk }: Props) {
  const [tree, setTree] = useState<Record<string, Dir>>({});
  const [file, setFile] = useState<RepoFile | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busyDir, setBusyDir] = useState<string | null>(null);
  const [error, setError] = useState("");

  const loadDir = async (path: string) => {
    setBusyDir(path);
    try {
      const items = await api<TreeEntry[]>(`/api/tree?repo=${q(repo)}&path=${q(path)}`);
      setTree((t) => ({ ...t, [path]: { open: true, items } }));
    } catch (e) { setError(errMsg(e)); }
    setBusyDir((b) => (b === path ? null : b));
  };
  useEffect(() => { setTree({}); setFile(null); setError(""); setPending(null); void loadDir(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [repo]);

  const toggle = (path: string) => (tree[path] ? setTree((t) => ({ ...t, [path]: { ...t[path], open: !t[path].open } })) : void loadDir(path));
  const open = async (path: string) => {
    setPending(path);
    try { setFile(await api<RepoFile>(`/api/file?repo=${q(repo)}&path=${q(path)}`)); }
    catch (e) { setFile({ path, content: errMsg(e), url: "" }); }
    setPending((p) => (p === path ? null : p));
  };

  const list = (path: string, depth: number): ReactNode =>
    (tree[path]?.items ?? []).map((e) => {
      const isDir = e.type === "dir";
      const isOpen = isDir && !!tree[e.path]?.open;
      const selected = (pending ?? file?.path) === e.path;
      return (
        <li key={e.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={selected}>
          <button
            type="button"
            className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] hover:bg-accent", selected && "bg-accent font-medium text-foreground")}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => (isDir ? toggle(e.path) : void open(e.path))}
          >
            {isDir ? <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} /> : <span className="size-3.5 shrink-0" />}
            {busyDir === e.path || pending === e.path ? <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              : isDir ? (isOpen ? <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-brand" /> : <FolderIcon aria-hidden className="size-3.5 shrink-0 text-brand" />)
              : <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate font-mono">{e.name}</span>
          </button>
          {isOpen && <ul role="group">{list(e.path, depth + 1)}</ul>}
        </li>
      );
    });

  const lines = file ? file.content.split("\n") : [];
  const rootLoading = !tree[""] && !error;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 md:flex-row md:px-5 md:pb-4">
      <div className="scroll-thin max-h-52 shrink-0 overflow-auto rounded-xl border bg-card p-1.5 shadow-xs md:max-h-none md:w-64">
        {error ? <p className="p-2 text-[13px] text-destructive">{error}</p>
          : rootLoading ? <div className="flex flex-col gap-2 p-2" aria-busy="true">{[60, 45, 70, 50, 65, 40].map((w, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${w}%` }} />)}</div>
          : <ul role="tree" aria-label="Repository files">{list("", 0)}</ul>}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
        {file ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
              <span className="min-w-0 flex-1 basis-24 break-all font-mono text-[12.5px] font-medium">{file.path}</span>
              <Button size="sm" variant="outline" onClick={() => onNewIssue(file)}><PlusIcon />New issue</Button>
              <Button size="sm" variant="outline" onClick={() => onAsk(file)}><SparklesIcon />Ask Claude</Button>
              {file.url && <Button size="sm" variant="ghost" asChild><a href={file.url} target="_blank" rel="noopener">GitHub<ExternalLinkIcon /></a></Button>}
            </div>
            <div className="scroll-thin flex min-h-0 flex-1 items-start overflow-auto font-mono text-[12.5px] leading-[1.6]">
              <pre aria-hidden className="sticky left-0 shrink-0 select-none border-r bg-card px-3 py-3 text-right text-muted-foreground/70">{lines.map((_, i) => i + 1).join("\n")}</pre>
              <pre className="min-w-0 flex-1 px-4 py-3">{file.content}{file.truncated ? "\n… truncated" : ""}</pre>
            </div>
          </>
        ) : (
          <EmptyState icon={<FileCode2Icon />} title="Pick a file to read it">Claude can read the same files when you ask in chat.</EmptyState>
        )}
      </div>
    </div>
  );
}
