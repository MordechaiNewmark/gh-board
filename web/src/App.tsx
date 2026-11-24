import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { CircleAlertIcon, FolderGit2Icon, KanbanIcon, LockIcon, PlusIcon, RefreshCwIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, GithubIcon, UserAvatar } from "@/components/issue-bits";
import { Toaster, useToasts } from "@/components/toasts";
import { useResizable } from "@/hooks/use-resizable";
import { cn } from "@/lib/utils";
import { api, errMsg, q, type Auth, type BoardData, type Label, type Meta, type Milestone, type Repo } from "@/lib/api";
import { AuthDialog } from "./AuthDialog";
import { IssueDialog, type IssueTarget } from "./IssueDialog";
import { AnalyzeButton, ChatWelcome } from "./chat/Analyze";
import { ChatRuntimeProvider, chatCtx, setChatRepo } from "./chat/runtime";
import { Thread } from "./chat/thread";
import { ToolCard } from "./chat/ToolCard";
import { ToolGroup } from "./chat/ToolGroup";
import { Board, BoardSkeleton } from "./views/Board";
import { Code } from "./views/Code";
import { Hierarchy, HierarchySkeleton } from "./views/Hierarchy";

type View = "board" | "tree" | "code" | "chat";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const THREAD_COMPONENTS = { ToolFallback: ToolCard, ToolGroup, Welcome: ChatWelcome };
const EMPTY: BoardData = { columns: [], prefix: "status:", issues: [] };

const stored = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

/* Put text in the chat composer without depending on a specific assistant-ui runtime API. */
function prefillChat(text: string) {
  const el = document.querySelector<HTMLTextAreaElement>("#chat textarea");
  if (!el) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

function Splitter(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        "group/split relative z-10 hidden w-px shrink-0 cursor-col-resize touch-none bg-border outline-none md:block",
        "after:absolute after:inset-y-0 after:-left-px after:w-[3px] after:bg-brand after:opacity-0 after:transition-opacity",
        "hover:after:opacity-100 focus-visible:after:opacity-100 data-[dragging]:after:opacity-100",
      )}
    >
      {/* Wider invisible hit area so the 1px line is easy to grab. */}
      <span aria-hidden className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<Auth>({ connected: false });
  const [booted, setBooted] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const [repo, setRepo] = useState(() => stored("repo"));
  const [data, setData] = useState<BoardData>(EMPTY);
  const [loadedRepo, setLoadedRepo] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [labels, setLabels] = useState<Label[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [view, setView] = useState<View>("board");
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<IssueTarget | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const { toasts, push: toast, dismiss } = useToasts();
  const filterRef = useRef<HTMLInputElement>(null);
  const latestLoad = useRef(0);

  const nav = useResizable({ storageKey: "gh-board:nav-width", defaultWidth: 240, min: 180, max: 420, side: "left", label: "Resize repository list" });
  const chatPane = useResizable({ storageKey: "gh-board:chat-width", defaultWidth: 400, min: 300, max: 720, side: "right", label: "Resize Claude chat" });

  const load = useCallback(async (name: string) => {
    if (!name) return;
    const ticket = ++latestLoad.current;
    setLoading(true); setLoadError("");
    try {
      const r = q(name);
      const [d, ls, ms, as] = await Promise.all([
        api<BoardData>(`/api/issues?repo=${r}`),
        api<Label[]>(`/api/labels?repo=${r}`).catch(() => []),
        api<Milestone[]>(`/api/milestones?repo=${r}`).catch(() => []),
        api<string[]>(`/api/assignees?repo=${r}`).catch(() => []),
      ]);
      if (ticket !== latestLoad.current) return;
      setData(d); setLabels(ls); setMilestones(ms); setAssignees(as); setLoadedRepo(name);
    } catch (e) {
      if (ticket !== latestLoad.current) return;
      setLoadError(errMsg(e));
    }
    setLoading(false);
  }, []);

  const boot = useCallback(async () => {
    const a = await api<Auth>("/api/auth/status").catch((e) => ({ connected: false, error: errMsg(e) }) as Auth);
    setAuth(a); setBooted(true);
    if (!a.connected) { setRepos([]); setAuthOpen(true); return; }
    setReposLoading(true);
    setRepos((await api<Repo[]>("/api/repos").catch(() => [])).filter((r) => r.issues));
    setReposLoading(false);
    void load(stored("repo"));
  }, [load]);
  useEffect(() => { void boot(); }, [boot]);

  // Keep the chat in sync with what the board is showing.
  useEffect(() => { setChatRepo(repo); chatCtx.autoApprove = autoApprove; chatCtx.onDone = () => void load(repo); }, [repo, autoApprove, load]);

  const pickRepo = (name: string) => { store("repo", name); setRepo(name); setFilter(""); void load(name); };
  const newIssue = useCallback((extra: Partial<IssueTarget> = {}) => {
    if (repo) setTarget({ number: null, ...extra });
    else toast("Pick a repository first.", "error");
  }, [repo, toast]);
  const move = async (number: number, column: string) => {
    const issue = data.issues.find((i) => i.number === number);
    if (!issue || issue.column === column) return;
    const prev = issue.column;
    const put = (col: string) => setData((d) => ({ ...d, issues: d.issues.map((i) => (i.number === number ? { ...i, column: col } : i)) }));
    put(column);
    try { await api("/api/move", { repo, number, column }); toast(`#${number} moved to ${column}`); }
    catch (e) { put(prev); toast(`Move failed: ${errMsg(e)}`, "error"); }
  };

  // Shortcuts: / filter, n new issue, r refresh, 1-3 switch view. Ignored while typing or when a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "/") { e.preventDefault(); setView((v) => (v === "tree" ? v : "board")); requestAnimationFrame(() => { filterRef.current?.focus(); filterRef.current?.select(); }); }
      else if (e.key === "n") { e.preventDefault(); newIssue(); }
      else if (e.key === "r") { e.preventDefault(); void load(repo); }
      else if (e.key === "1") setView("board");
      else if (e.key === "2") setView("tree");
      else if (e.key === "3") setView("code");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newIssue, load, repo]);

  const current = loadedRepo === repo ? data : EMPTY;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return current.issues;
    return current.issues.filter((i) => `${i.title} ${i.labels.join(" ")} ${i.assignees.map((a) => `@${a}`).join(" ")} #${i.number} ${i.milestone?.title ?? ""}`.toLowerCase().includes(f));
  }, [current.issues, filter]);
  const filtered = !!filter.trim();
  const groups = useMemo(() => {
    const f = repoQuery.trim().toLowerCase();
    const by = new Map<string, Repo[]>();
    for (const r of repos) {
      if (f && !r.name.toLowerCase().includes(f)) continue;
      const owner = r.name.split("/")[0];
      by.set(owner, [...(by.get(owner) ?? []), r]);
    }
    return [...by.entries()];
  }, [repos, repoQuery]);
  const meta: Meta = { columns: current.columns, prefix: current.prefix, labels, milestones, assignees };
  const chat = view === "chat";
  const firstLoad = !!repo && loadedRepo !== repo && !loadError;
  const [owner, name] = repo.includes("/") ? repo.split("/") : ["", repo];
  const typedRepo = REPO_RE.test(repoQuery.trim()) ? repoQuery.trim() : "";
  const askChat = (text: string) => { setView((v) => (window.matchMedia("(max-width: 767px)").matches ? "chat" : v)); setTimeout(() => prefillChat(text), 50); };

  const body = () => {
    if (!booted) return view === "tree" ? <HierarchySkeleton /> : <BoardSkeleton columns={[]} />;
    if (!auth.connected) return (
      <EmptyState icon={<GithubIcon />} title="Connect your GitHub account" action={<Button className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => setAuthOpen(true)}>Connect GitHub</Button>}>
        gh-board shows the issues of any repository you can access as a Kanban board. {auth.error}
      </EmptyState>
    );
    if (!repo) return <EmptyState icon={<FolderGit2Icon />} title="Pick a repository">Choose one from the list, or type <span className="font-mono">owner/name</span> in the search box and press Enter.</EmptyState>;
    if (view === "code") return <Code repo={repo} onNewIssue={(f) => setTarget({ number: null, title: `Change in ${f.path}`, body: `File: \`${f.path}\`\n${f.url}\n\n` })} onAsk={(f) => askChat(`Read ${f.path} and `)} />;
    if (loadError && loadedRepo !== repo) return (
      <EmptyState icon={<CircleAlertIcon />} title={`Could not load ${repo}`} action={<Button variant="outline" onClick={() => void load(repo)}><RefreshCwIcon />Try again</Button>}>{loadError}</EmptyState>
    );
    if (firstLoad) return view === "tree" ? <HierarchySkeleton /> : <BoardSkeleton columns={data.columns} />;
    if (view === "tree") return <Hierarchy prefix={current.prefix} issues={shown} filtered={filtered} onOpen={(n) => setTarget({ number: n })} onAddSub={(p) => setTarget({ number: null, parent: p })} />;
    return <Board columns={current.columns} prefix={current.prefix} issues={shown} filtered={filtered} onOpen={(n) => setTarget({ number: n })} onMove={move} onNew={(column) => newIssue({ column })} />;
  };

  return (
    <ChatRuntimeProvider>
      <div className="flex h-dvh flex-col bg-background" style={{ "--nav-w": `${nav.width}px`, "--chat-w": `${chatPane.width}px` } as CSSProperties}>
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-3 py-2 md:px-4">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span className="flex size-6 items-center justify-center rounded-md bg-brand text-brand-foreground"><KanbanIcon aria-hidden className="size-4" /></span>
            gh-board
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as View)} className="order-2 w-full md:order-none md:w-auto">
            <TabsList className="h-8 w-full md:w-auto">
              <TabsTrigger value="board" className="px-3 text-[13px]">Board</TabsTrigger>
              <TabsTrigger value="tree" className="px-3 text-[13px]">Hierarchy</TabsTrigger>
              <TabsTrigger value="code" className="px-3 text-[13px]">Code</TabsTrigger>
              <TabsTrigger value="chat" className="px-3 text-[13px] md:hidden">Chat</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="ghost" size="sm" className="ml-auto h-8 gap-2 px-2" onClick={() => setAuthOpen(true)} aria-label={auth.connected ? `GitHub account: ${auth.login}` : "Connect GitHub"}>
            {auth.connected && auth.login
              ? <><UserAvatar login={auth.login} src={auth.avatar} size={22} className="ring-0" /><span className="text-[13px]">{auth.login}</span></>
              : <><GithubIcon />Connect GitHub</>}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label="Repositories" className={cn("shrink-0 border-b bg-sidebar md:flex md:w-[min(var(--nav-w),32vw)] md:flex-col md:border-b-0", chat && "hidden md:flex")}>
            <div className="p-2 md:p-3 md:pb-2">
              <div className="relative">
                <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Find repository" name="repo-search" type="search" autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false}
                  placeholder="Find or type owner/name" className="h-8 bg-background pl-8 text-[13px] md:text-[13px]" value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && typedRepo) { pickRepo(typedRepo); setRepoQuery(""); } else if (e.key === "Escape") setRepoQuery(""); }} />
              </div>
            </div>
            <div className="scroll-thin flex gap-1.5 overflow-x-auto px-2 pb-2 md:block md:min-h-0 md:flex-1 md:overflow-x-hidden md:overflow-y-auto md:pb-3">
              {reposLoading && repos.length === 0 && (
                <div className="hidden flex-col gap-2.5 px-2 pt-2 md:flex" aria-busy="true" aria-label="Loading repositories">
                  {[70, 55, 80, 60, 75, 50, 65].map((w, k) => <Skeleton key={k} className="h-4" style={{ width: `${w}%` }} />)}
                </div>
              )}
              {groups.map(([o, list]) => (
                <div key={o} className="contents md:mb-2 md:block" role="group" aria-label={o}>
                  <div className="hidden truncate px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:block">{o}</div>
                  {list.map((r) => {
                    const selected = r.name === repo;
                    return (
                      <button key={r.name} type="button" onClick={() => pickRepo(r.name)} aria-current={selected ? "page" : undefined} title={`${r.name} · ${r.role}${r.private ? " · private" : ""}`}
                        className={cn(
                          "relative flex shrink-0 items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-left text-[13px] transition-colors md:w-full md:rounded-md md:border-0 md:bg-transparent md:px-2 md:py-[5px]",
                          selected ? "border-brand/50 bg-brand/10 font-medium text-foreground md:bg-accent" : "text-foreground/80 hover:text-foreground md:hover:bg-accent/60",
                        )}>
                        {selected && <span aria-hidden className="absolute inset-y-1.5 -left-2 hidden w-[3px] rounded-r bg-brand md:block" />}
                        <span className="min-w-0 truncate"><span className="text-muted-foreground md:hidden">{o}/</span>{r.name.slice(o.length + 1)}</span>
                        {r.private && <LockIcon aria-label="Private" className="size-3 shrink-0 text-muted-foreground" />}
                        {r.role !== "admin" && <span className="ml-auto hidden shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground md:inline">{r.role}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {auth.connected && !reposLoading && groups.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {typedRepo ? <>Press <kbd>Enter</kbd> to open <span className="font-mono text-foreground">{typedRepo}</span>.</> : repoQuery ? "No match. Type a full owner/name to open any repository." : "No repositories with issues found."}
                </p>
              )}
            </div>
          </nav>
          <Splitter {...nav.handleProps} />

          <main className={cn("min-h-0 min-w-0 flex-1 flex-col", chat ? "hidden md:flex" : "flex")}>
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2.5 md:px-5 md:py-3">
              <div className="flex min-w-0 flex-1 basis-0 items-baseline gap-2">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                  {repo ? <>{owner && <span className="hidden font-normal text-muted-foreground sm:inline">{owner} / </span>}{name}</> : "No repository"}
                </h1>
                {repo && loadedRepo === repo && view !== "code" && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{filtered ? `${shown.length} of ${current.issues.length}` : current.issues.length} issue{current.issues.length === 1 ? "" : "s"}</span>
                )}
              </div>
              {view !== "code" && (
                <div className="relative order-last w-full sm:order-none sm:w-64">
                  <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input ref={filterRef} aria-label="Filter issues" aria-keyshortcuts="/" name="issue-filter" autoComplete="off" spellCheck={false} placeholder="Filter by title, label, @person" value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setFilter(""); e.currentTarget.blur(); } }}
                    className="h-8 bg-background px-8 text-[13px] md:text-[13px]" />
                  {filter
                    ? <button type="button" aria-label="Clear filter" onClick={() => { setFilter(""); filterRef.current?.focus(); }} className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-3.5" /></button>
                    : <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 md:inline-flex">/</kbd>}
                </div>
              )}
              <Button variant="outline" size="icon-sm" aria-label="Refresh" aria-keyshortcuts="r" title="Refresh (r)" disabled={!repo || loading} onClick={() => void load(repo)}>
                <RefreshCwIcon className={cn(loading && "animate-spin")} />
              </Button>
              <Button size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90" aria-keyshortcuts="n" title="New issue (n)" onClick={() => newIssue()}><PlusIcon />New issue</Button>
            </div>
            {loadError && loadedRepo === repo && (
              <p role="alert" className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive md:mx-5"><CircleAlertIcon aria-hidden className="size-4 shrink-0" />Refresh failed: {loadError}</p>
            )}
            <div className="min-h-0 flex-1">{body()}</div>
          </main>

          <Splitter {...chatPane.handleProps} />
          <aside id="chat" aria-label="Claude chat" className={cn("min-h-0 flex-1 flex-col bg-background md:flex md:w-[min(var(--chat-w),45vw)] md:flex-none", chat ? "flex" : "hidden")}>
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2">
              <span className="mr-auto flex items-center gap-2 text-[14px] font-semibold"><SparklesIcon aria-hidden className="size-4 text-brand" />Ask Claude</span>
              <AnalyzeButton />
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={autoApprove} onCheckedChange={(v) => setAutoApprove(v === true)} /> Auto-approve writes
              </label>
            </div>
            <div className="min-h-0 flex-1"><Thread components={THREAD_COMPONENTS} /></div>
          </aside>
        </div>
      </div>

      <AuthDialog open={authOpen} auth={auth} onOpenChange={setAuthOpen} onChanged={() => void boot()} />
      {target && (
        <IssueDialog
          key={`${target.number ?? "new"}-${target.parent ?? ""}-${target.column ?? ""}`}
          repo={repo} target={target} meta={meta}
          onClose={() => setTarget(null)}
          onSaved={(message) => { setTarget(null); toast(message); void load(repo); }}
          onNavigate={setTarget}
          onLabelCreated={(l) => setLabels((ls) => [...ls, l])}
          onAttach={(n) => { setTarget(null); askChat(`Attach the file(s) to #${n}`); }}
        />
      )}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ChatRuntimeProvider>
  );
}
