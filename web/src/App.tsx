import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api, errMsg, q, type Auth, type BoardData, type Label, type Meta, type Milestone, type Repo } from "@/lib/api";
import { AuthDialog } from "./AuthDialog";
import { IssueDialog, type IssueTarget } from "./IssueDialog";
import { ChatRuntimeProvider, chatCtx } from "./chat/runtime";
import { Thread } from "./chat/thread";
import { ToolCard } from "./chat/ToolCard";
import { Board } from "./views/Board";
import { Code } from "./views/Code";
import { Hierarchy } from "./views/Hierarchy";

type View = "board" | "tree" | "code" | "chat";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/* Put text in the chat composer without depending on a specific assistant-ui runtime API. */
function prefillChat(text: string) {
  const el = document.querySelector<HTMLTextAreaElement>("#chat textarea");
  if (!el) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

export default function App() {
  const [auth, setAuth] = useState<Auth>({ connected: false });
  const [authOpen, setAuthOpen] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoQuery, setRepoQuery] = useState("");
  const [repo, setRepo] = useState(() => localStorage.getItem("repo") ?? "");
  const [data, setData] = useState<BoardData>({ columns: [], prefix: "status:", issues: [] });
  const [labels, setLabels] = useState<Label[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [view, setView] = useState<View>("board");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [target, setTarget] = useState<IssueTarget | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);

  const load = useCallback(async (name: string) => {
    if (!name) return setStatus({ text: "Pick a repository." });
    setStatus({ text: `Loading ${name}…` });
    try {
      const r = q(name);
      const [d, ls, ms, as] = await Promise.all([
        api<BoardData>(`/api/issues?repo=${r}`),
        api<Label[]>(`/api/labels?repo=${r}`).catch(() => []),
        api<Milestone[]>(`/api/milestones?repo=${r}`).catch(() => []),
        api<string[]>(`/api/assignees?repo=${r}`).catch(() => []),
      ]);
      setData(d); setLabels(ls); setMilestones(ms); setAssignees(as);
      setStatus({ text: `${name} · ${d.issues.length} issues` });
    } catch (e) { setStatus({ text: errMsg(e), error: true }); }
  }, []);

  const boot = useCallback(async () => {
    const a = await api<Auth>("/api/auth/status").catch((e) => ({ connected: false, error: errMsg(e) }) as Auth);
    setAuth(a);
    if (!a.connected) { setRepos([]); setAuthOpen(true); setStatus({ text: "Connect your GitHub account to start." }); return; }
    setRepos((await api<Repo[]>("/api/repos").catch(() => [])).filter((r) => r.issues));
    void load(localStorage.getItem("repo") ?? "");
  }, [load]);
  useEffect(() => { void boot(); }, [boot]);

  // Keep the chat in sync with what the board is showing.
  useEffect(() => { chatCtx.repo = repo; chatCtx.autoApprove = autoApprove; chatCtx.onDone = () => void load(repo); }, [repo, autoApprove, load]);

  const pickRepo = (name: string) => { localStorage.setItem("repo", name); setRepo(name); void load(name); };
  const move = async (number: number, column: string) => {
    const issue = data.issues.find((i) => i.number === number);
    if (!issue || issue.column === column) return;
    const prev = issue.column;
    const put = (col: string) => setData((d) => ({ ...d, issues: d.issues.map((i) => (i.number === number ? { ...i, column: col } : i)) }));
    put(column);
    try { await api("/api/move", { repo, number, column }); }
    catch (e) { put(prev); setStatus({ text: `Move failed: ${errMsg(e)}`, error: true }); }
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return data.issues;
    return data.issues.filter((i) => `${i.title} ${i.labels.join(" ")} ${i.assignees.map((a) => `@${a}`).join(" ")} #${i.number} ${i.milestone?.title ?? ""}`.toLowerCase().includes(f));
  }, [data.issues, filter]);
  const shownRepos = repos.filter((r) => !repoQuery || r.name.toLowerCase().includes(repoQuery.trim().toLowerCase()));
  const meta: Meta = { columns: data.columns, prefix: data.prefix, labels, milestones, assignees };
  const chat = view === "chat";
  const askChat = (text: string) => { setView((v) => (window.matchMedia("(max-width: 767px)").matches ? "chat" : v)); setTimeout(() => prefillChat(text), 50); };

  return (
    <ChatRuntimeProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 md:gap-3 md:px-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><span className="size-5 rounded-md bg-brand" />gh-board</div>
          <Tabs value={view} onValueChange={(v) => setView(v as View)} className="order-2 w-full md:order-none md:w-auto">
            <TabsList className="w-full md:w-auto">
              <TabsTrigger value="board">Board</TabsTrigger>
              <TabsTrigger value="tree">Hierarchy</TabsTrigger>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="chat" className="md:hidden">Chat</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input aria-label="Filter issues" placeholder="Filter by title, label, @person" value={filter} onChange={(e) => setFilter(e.target.value)}
            className={cn("order-3 w-full bg-card md:order-none md:w-56", chat && "hidden md:block")} />
          <Button className="bg-brand text-white hover:bg-brand/90" onClick={() => (repo ? setTarget({ number: null }) : setStatus({ text: "Pick a repository first.", error: true }))}>New issue</Button>
          <Button variant="outline" className="hidden md:inline-flex" onClick={() => void load(repo)}>Refresh</Button>
          <Button variant="outline" className="ml-auto" onClick={() => setAuthOpen(true)}>
            {auth.connected ? <>{auth.avatar && <img src={auth.avatar} alt="" className="size-5 rounded-full" />}{auth.login}</> : "Connect GitHub"}
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label="Repositories" className={cn("border-b bg-muted/40 md:flex md:w-56 md:shrink-0 md:flex-col md:border-b-0 md:border-r", chat && "hidden md:flex")}>
            <div className="p-2 md:p-3">
              <Input aria-label="Find repository" name="repo-search" type="search" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder="Find or type owner/name" className="bg-card" value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && REPO_RE.test(repoQuery.trim())) pickRepo(repoQuery.trim()); }} />
            </div>
            <div className="flex gap-1.5 overflow-x-auto px-2 pb-2 md:block md:overflow-y-auto md:px-2">
              {shownRepos.map((r) => (
                <button key={r.name} type="button" onClick={() => pickRepo(r.name)}
                  className={cn("flex shrink-0 items-center justify-between gap-2 rounded-full border border-input px-3 py-1 text-left font-mono text-[12.5px] md:w-full md:rounded-md md:border-0 md:px-2.5 md:py-1.5", r.name === repo && "bg-secondary")}>
                  <span className="truncate">{r.name}</span>
                  <span className="hidden font-sans text-[11px] text-muted-foreground md:inline">{r.role}</span>
                </button>
              ))}
              {auth.connected && shownRepos.length === 0 && <p className="px-2 text-xs text-muted-foreground">No match. Press Enter to open what you typed.</p>}
            </div>
          </nav>

          <main className={cn("min-w-0 flex-1 overflow-auto p-3 md:px-5 md:py-4", chat && "hidden md:block")}>
            <p className={cn("mb-2 min-h-5 text-[12.5px]", status.error ? "text-destructive" : "text-muted-foreground")}>{status.text}</p>
            {view === "tree" ? (
              <Hierarchy prefix={data.prefix} issues={shown} onOpen={(n) => setTarget({ number: n })} onAddSub={(p) => setTarget({ number: null, parent: p })} />
            ) : view === "code" ? (
              repo ? <Code repo={repo} onNewIssue={(f) => setTarget({ number: null, title: `Change in ${f.path}`, body: `File: \`${f.path}\`\n${f.url}\n\n` })} onAsk={(f) => askChat(`Read ${f.path} and `)} /> : null
            ) : (
              <Board columns={data.columns} prefix={data.prefix} issues={shown} onOpen={(n) => setTarget({ number: n })} onMove={move} />
            )}
          </main>

          <aside id="chat" aria-label="Claude chat" className={cn("min-h-0 flex-1 flex-col border-l bg-card md:flex md:w-[400px] md:flex-none", chat ? "flex" : "hidden")}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="font-semibold">Ask Claude</span>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={autoApprove} onCheckedChange={(v) => setAutoApprove(v === true)} /> Auto-approve writes
              </label>
            </div>
            <div className="min-h-0 flex-1"><Thread components={{ ToolFallback: ToolCard }} /></div>
          </aside>
        </div>
      </div>

      <AuthDialog open={authOpen} auth={auth} onOpenChange={setAuthOpen} onChanged={() => void boot()} />
      {target && (
        <IssueDialog
          key={`${target.number ?? "new"}-${target.parent ?? ""}`}
          repo={repo} target={target} meta={meta}
          onClose={() => setTarget(null)}
          onSaved={() => { setTarget(null); void load(repo); }}
          onNavigate={setTarget}
          onLabelCreated={(l) => setLabels((ls) => [...ls, l])}
          onAttach={(n) => { setTarget(null); askChat(`Attach the file(s) to #${n}`); }}
        />
      )}
    </ChatRuntimeProvider>
  );
}
