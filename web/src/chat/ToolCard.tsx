import { Button } from "@/components/ui/button";
import { answerApproval, useApproval, useGenerated } from "./runtime";

type Props = { toolCallId: string; toolName: string; args?: unknown; result?: unknown; isError?: boolean };

/* Shown for every tool call: what Claude is doing, an Approve / Reject gate for writes, and download links. */
export function ToolCard({ toolCallId, toolName, args, result, isError }: Props) {
  const approval = useApproval(toolCallId);
  const file = useGenerated(toolCallId);
  const done = result !== undefined;
  const state = approval?.state === "rejected" ? "Rejected" : isError ? "Failed" : done ? "Done" : approval?.state === "pending" ? "Approval needed" : "Running…";
  const hasArgs = !!args && typeof args === "object" && Object.keys(args as object).length > 0;

  return (
    <div className="my-2 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs">{toolName}</span>
        <span className={approval?.state === "rejected" || isError ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{state}</span>
      </div>
      {hasArgs && (
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
      {approval?.state === "pending" && !done && (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => answerApproval(toolCallId, approval, true)}>Approve</Button>
          <Button size="sm" variant="outline" onClick={() => answerApproval(toolCallId, approval, false)}>Reject</Button>
        </div>
      )}
      {file && (
        <div className="mt-2">
          <a className="font-medium text-brand underline" href={`/api/download?id=${encodeURIComponent(file.id)}`} download={file.name}>{file.name}</a>{" "}
          <span className="text-xs text-muted-foreground">{Math.max(1, Math.round(file.size / 1024))} KB</span>
        </div>
      )}
    </div>
  );
}
