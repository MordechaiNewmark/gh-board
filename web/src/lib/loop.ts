/* Types for the delivery-loop views (server: loop/*.mjs and runner/*.mjs) and the hook that keeps them live. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg, q, type Label } from "@/lib/api";

export type LoopStateId = "blocked" | "ready" | "claimed" | "in-review" | "changes-requested" | "approved" | "needs-human" | "done";
export type Ci = "none" | "pending" | "success" | "failure";
export type LintProblem = { code: string; level: "error" | "warn"; message: string };
export type Lint = { kind: "task" | "epic" | "other"; ready: boolean | null; problems: LintProblem[] };
export type Dep = { number: number; state: "open" | "closed" | "unknown"; title: string };
export type CardPr = { number: number; url: string; title: string; ci: Ci; iteration: number; of: number; draft: boolean; needsHuman: boolean; agent: boolean };
export type LoopCard = {
  number: number; title: string; url: string; open: boolean; state: LoopStateId; derived: boolean; size: string; module: string; epic: number | null;
  labels: Label[]; assignees: string[]; claim: { by: string; kind: "agent" | "human"; idleHours: number; stale: boolean } | null;
  deps: Dep[]; blockedBy: Dep[]; pr: CardPr | null; lint: Lint | null; comments: number; updated_at: string;
};
export type LoopColumn = { id: LoopStateId; title: string; label: string | null; hint: string; cards: number[] };
export type InboxKind = "needs-human" | "merge" | "ci-failed" | "stale-claim";
export type InboxItem = { id: string; kind: InboxKind; rank: number; issue: number | null; pr: number | null; title: string; detail: string; at: string; ci?: Ci };
export type LoopData = {
  repo: string; at: string; modules: string[]; columns: LoopColumn[]; cards: LoopCard[];
  epics: { number: number; title: string; url: string; open: boolean; total: number; closed: number }[];
  unqueued: { number: number; title: string; url: string; lint: Lint }[]; inbox: InboxItem[]; counts: Record<string, number>;
};

export type RunEvent = { t: string; type: "init" | "text" | "tool" | "tool_result" | "result" | "note" | "stderr"; sub?: boolean; text?: string; name?: string; summary?: string; isError?: boolean; model?: string };
export type TickSummary = { id: string; kind: "tick" | "init"; startedAt: string; endedAt: string; ok: boolean; error: string; stopped: boolean; turns: number; costUsd: number; idle: boolean; text: string; denials: { tool: string; summary: string }[]; did: { dispatched: number; prOpened: number; merged: number; escalation: number }; events: RunEvent[] };
export type Autonomy = "supervised" | "parallel" | "auto";
export type RunStatus = {
  repo: string; status: "idle" | "starting" | "running" | "waiting" | "paused"; mode: "" | "once" | "continuous" | "setup"; pausing: boolean; autonomy: Autonomy; parallel: number; readOnly: boolean;
  tick: { id: string; kind: "tick" | "init"; startedAt: string; activity: string; model: string; turns: number; events: RunEvent[]; prompt: string } | null;
  lastTick: TickSummary | null; lastError: string; nextAt: string | null;
  counters: { ticks: number; prsOpened: number; merged: number; escalations: number; costUsd: number };
  today: { ticks: number; costUsd: number; cap: number };
  limits: { tickTimeoutS: number; maxTurns: number; intervalS: number; dailyTicks: number; budgetUsd: number };
};
export type Preflight = RunStatus & {
  account: string; token: { kind: string; label: string; broad: boolean } | null;
  plugin: { ok: boolean; installed: boolean; version: string; source: string; ref: string; expected: string; problem: string; help: string[] };
  claude: { ok: boolean; error: string; auth: string; billing: string };
  gate: { ok: boolean; cmd: string; script: string | null; reason: string; verified: boolean } | null;
  initialized: boolean; workspace: boolean; blockers: { code: string; text: string; action?: string }[];
  permissions: { mode: string; prompts: string; allow: string[]; deny: string[]; command: string };
};

export type GapAction = { kind: "planner"; label: string; prompt: string } | { kind: "setup"; label: string };
export type ReadinessItem = { label: string; ok: boolean; detail: string; action: GapAction | null };
export type Layer = { id: "design" | "checks" | "verification" | "prose"; title: string; hint: string; status: "ok" | "partial" | "missing"; items: ReadinessItem[] };
export type Readiness = { repo: string; from: "workspace" | "github"; initialized: boolean; gate: NonNullable<Preflight["gate"]>; conf: Record<string, string>; modules: string[]; layers: Layer[] };

export type CriterionStatus = "pass" | "fail" | "carried" | "unknown";
export type Media = { type: "image" | "video" | "artifact"; url: string; alt: string; source: string };
export type Review = {
  repo: string; as: string;
  pr: { number: number; title: string; url: string; state: string; merged: boolean; draft: boolean; mergeable: boolean | null; mergeable_state: string; head: { ref: string; sha: string }; base: string; by: string; labels: string[]; additions: number; deletions: number; changed_files: number; body: string };
  issue: { number: number; title: string; url: string; state: string; open: boolean } | null;
  verdict: { state: "approved" | "changes-requested" | "needs-human" | "reviewed" | "unreviewed"; by: string; at: string; form: string; commit: string; stale: boolean };
  criteria: { criterion: string; status: CriterionStatus; evidence: string; claim: CriterionStatus }[];
  extra: { status: CriterionStatus; text: string }[];
  gate: { review: { status: CriterionStatus; text: string } | null; ci: Ci; runs: { name: string; status: string; conclusion: string | null; url: string }[] };
  findings: string[]; reviews: { id: number; by: string; state: string; at: string; body: string }[];
  patches: { iteration: number; of: number; rounds: { n: number; of: number; rebase: boolean; reset: boolean; by: string; at: string; note: string }[] };
  media: Media[]; files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[]; diffUrl: string;
  merge: { ok: boolean; blockers: string[]; cautions: string[]; sha: string; method: string };
};

export const isActive = (s?: RunStatus | null) => !!s && s.status !== "idle";

/** "3m", "2h", "5d" since an ISO time. */
export function ago(iso?: string | null, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.max(1, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Loop state for the selected repo: the board/inbox snapshot from GitHub, the runner status, and the preflight
 * (plugin, gate, token, permissions). Polls quickly while a run is active and slowly otherwise.
 */
export function useLoop(repo: string, enabled: boolean) {
  const [data, setData] = useState<LoopData | null>(null);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const live = useRef({ repo: "", ticket: 0 });

  const loadData = useCallback(async (fresh = false, background = false) => {
    if (!repo) return;
    const ticket = ++live.current.ticket;
    try {
      const d = await api<LoopData>(`/api/loop?repo=${q(repo)}${fresh ? "&fresh=1" : ""}`, undefined, { background });
      if (ticket === live.current.ticket && live.current.repo === repo) { setData(d); setError(""); }
    } catch (e) { if (ticket === live.current.ticket) setError(errMsg(e)); }
  }, [repo]);
  const loadPre = useCallback(async () => {
    if (!repo) return;
    try { const p = await api<Preflight>(`/api/runner?repo=${q(repo)}`); if (live.current.repo === repo) { setPre(p); setRun(p); } } catch { /* shown through the board error */ }
  }, [repo]);

  useEffect(() => {
    live.current.repo = repo;
    setData(null); setPre(null); setRun(null); setError("");
    if (!repo || !enabled) return;
    setLoading(true);
    void Promise.all([loadData(), loadPre()]).finally(() => setLoading(false));
  }, [repo, enabled, loadData, loadPre]);

  const active = isActive(run);
  useEffect(() => {
    if (!repo || !enabled) return;
    const status = window.setInterval(() => {
      if (document.hidden) return;
      api<RunStatus>(`/api/runner/status?repo=${q(repo)}`, undefined, { background: true }).then((s) => { if (live.current.repo === repo) setRun(s); }).catch(() => {});
    }, active ? 1500 : 15000);
    const board = window.setInterval(() => { if (!document.hidden) void loadData(false, true); }, active ? 6000 : 90000);
    return () => { window.clearInterval(status); window.clearInterval(board); };
  }, [repo, enabled, active, loadData]);

  // When a run stops, pick up what it changed.
  const wasActive = useRef(false);
  useEffect(() => { if (wasActive.current && !active) { void loadData(true); void loadPre(); } wasActive.current = active; }, [active, loadData, loadPre]);

  const refresh = useCallback(async () => { setLoading(true); await Promise.all([loadData(true), loadPre()]); setLoading(false); }, [loadData, loadPre]);
  /** POST to a runner route and take its answer as the new status. */
  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    const s = await api<RunStatus>(`/api/runner/${path}`, { repo, ...body });
    if ((s as RunStatus).status) setRun(s);
    void loadPre();
    return s;
  }, [repo, loadPre]);

  return { data, pre, run: run ?? pre, error, loading, refresh, act, reloadData: loadData };
}
export type LoopHandle = ReturnType<typeof useLoop>;
