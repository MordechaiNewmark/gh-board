import { useAui, useAuiState } from "@assistant-ui/react";
import { ScanSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatRepo } from "./runtime";

/* Starting points for a whole-repo analysis. The title is what the user sees; the prompt is what Claude gets. */
export const ANALYSES = [
  {
    title: "Audit this repo and propose a backlog",
    prompt: "Audit this repo end to end: sync it, survey the structure, architecture, README/specs, tests, config and CI, and look for bugs, risks and gaps. Summarize your findings with path:line evidence, then propose a backlog of epics and child issues and submit it with create_issues for my approval.",
  },
  {
    title: "Find TODOs and turn them into issues",
    prompt: "Sync the repo and find every TODO, FIXME, HACK and XXX, plus skipped or disabled tests. Read the surrounding code for each, group related ones, drop the trivial ones, and propose issues (with path:line and the snippet) via create_issues for my approval. Skip anything an open issue already covers.",
  },
  {
    title: "Compare README/specs to the code and file gaps",
    prompt: "Sync the repo, read the README and any docs/specs, and compare what they promise with what the code actually does. List each gap (documented but missing, implemented but undocumented, or contradicting) with evidence from both sides, then propose issues for the gaps via create_issues for my approval.",
  },
  {
    title: "Review test coverage gaps",
    prompt: "Sync the repo and map the tests to the code: which modules and critical paths have tests, which have none, and which tests are skipped or shallow. Summarize the riskiest untested areas with path:line references and propose focused testing issues via create_issues for my approval.",
  },
];

function useAnalyze() {
  const aui = useAui();
  const repo = useChatRepo();
  const running = useAuiState((s) => s.thread.isRunning);
  return { repo, disabled: !repo || running, run: (prompt: string) => aui.thread().append(prompt) };
}

/* Chat header action: one click starts the full audit on the selected repo. */
export function AnalyzeButton() {
  const { repo, disabled, run } = useAnalyze();
  return (
    <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={disabled} onClick={() => run(ANALYSES[0].prompt)}
      title={repo ? `Explore all of ${repo} and propose a backlog of issues` : "Pick a repository first"}>
      <ScanSearchIcon aria-hidden className="size-3.5" />Analyze repo
    </Button>
  );
}

/* Empty-state for the chat: what it can do, and the analysis starting points. */
export function ChatWelcome() {
  const { repo, disabled, run } = useAnalyze();
  return (
    <div className="mb-5 flex flex-col px-2">
      <p className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">How can I help you today?</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        {repo
          ? <>I can manage the board, or read all of <span className="font-mono text-foreground/80">{repo}</span> and turn what I find into issues you approve.</>
          : "Pick a repository to manage its board or analyze its code."}
      </p>
      <ul aria-label="Analysis starting points" className="mt-4 flex flex-col">
        {ANALYSES.map((a) => (
          <li key={a.title}>
            <button type="button" disabled={disabled} onClick={() => run(a.prompt)}
              className="group flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none">
              <span aria-hidden className="font-mono text-xs text-muted-foreground/60 transition-colors group-hover:text-brand">{">"}</span>
              <span className="min-w-0 flex-1">{a.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
