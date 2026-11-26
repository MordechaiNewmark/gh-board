import { createContext, useContext } from "react";
import { ZapIcon } from "lucide-react";
import { ActorChip } from "@/components/actor";
import type { Auth, RepoAccount } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AnalyzeButton } from "./Analyze";
import { ProviderNotice, ProviderPicker } from "./ProviderPicker";

type Controls = {
  auth: Auth;
  actor: RepoAccount | null;
  autoApprove: boolean;
  setAutoApprove: (on: boolean) => void;
  changeActor: (login: string) => void;
  changeClaudeModel: (model: string) => void;
  openSettings: () => void;
};

/* The thread's composer slots take no props, so the app's chat state reaches them through here. */
export const ChatControlsContext = createContext<Controls | null>(null);

const useControls = () => {
  const c = useContext(ChatControlsContext);
  if (!c) throw new Error("ChatControlsContext is missing");
  return c;
};

/* Inside the message box, beside the attach button: actions and modes. */
export function ComposerModes() {
  const { autoApprove, setAutoApprove } = useControls();
  return (
    <>
      <AnalyzeButton />
      <button type="button" aria-pressed={autoApprove} onClick={() => setAutoApprove(!autoApprove)} aria-label="Auto-approve writes"
        title={autoApprove ? "Auto-approve writes is on: changes run without asking. Click to turn it off." : "Auto-approve writes is off: you approve each change. Click to turn it on."}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          autoApprove ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-200" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}>
        <ZapIcon aria-hidden className={cn("size-3.5", autoApprove && "fill-current")} />
        <span className="hidden @[26rem]:inline">Auto-approve</span>
      </button>
    </>
  );
}

/* Inside the message box, beside the send button: which model answers. */
export function ComposerModel() {
  const { auth, changeClaudeModel, openSettings } = useControls();
  return <ProviderPicker claudeModel={auth.claude?.model ?? ""} onClaudeModel={changeClaudeModel} onOpenSettings={openSettings} />;
}

/* Under the message box: provider problems, then what this chat can do and who it acts as. */
export function ComposerFooter() {
  const { auth, actor, changeActor, openSettings } = useControls();
  return (
    <div className="-mt-2 flex flex-col gap-1.5 empty:hidden">
      <ProviderNotice onOpenSettings={openSettings} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11.5px] text-muted-foreground empty:hidden">
        {auth.chatMode !== "classic" && (
          <span title="This chat plans with you and creates issues only. It has no tool that commits files: code is written by the delivery loop from the issues you approve here.">
            <span className="font-medium text-foreground/80">Planner</span> · creates issues only
          </span>
        )}
        {actor && (
          <span className="flex items-center gap-1.5">GitHub writes<ActorChip actor={actor} onChange={changeActor} title={`Issues, comments and commits made from this chat are attributed to @${actor.login}`} /></span>
        )}
        {auth.claude && (
          <button type="button" onClick={openSettings} title="Claude sign-in method. Click to change it in Settings."
            className="ml-auto rounded px-1 text-right hover:bg-accent hover:text-foreground">
            {auth.claude.label}{auth.claude.tail && <span className="font-mono"> {auth.claude.tail}</span>}{auth.claude.billing === "api" && " · API billing"}
          </button>
        )}
      </div>
    </div>
  );
}
