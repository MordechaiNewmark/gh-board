import { useState, type PropsWithChildren } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "@/components/tool-group.aui";
import { describeTool } from "./ToolCard";
import { useApprovals, useProgress } from "./runtime";

type Group = { indices: readonly number[]; status: { type: string } };

/* A run of tool calls. Collapsed, it shows live progress ("Read src/app.ts"); it opens by itself when a write needs approval. */
export function ToolGroup({ group, children }: PropsWithChildren<{ group: Group }>) {
  const [open, setOpen] = useState<boolean | null>(null);
  const parts = useAuiState((s) => s.message.parts) as readonly any[];
  const approvals = useApprovals();
  const calls = group.indices.map((i) => parts[i]).filter((p) => p?.type === "tool-call");
  const waiting = calls.some((p) => approvals.get(p.toolCallId)?.state === "pending" && p.result === undefined);
  const reviewed = calls.some((p) => approvals.has(p.toolCallId));
  const active = group.status.type === "running";
  const current = [...calls].reverse().find((p) => p.result === undefined) ?? calls[calls.length - 1];
  const note = useProgress(current?.toolCallId ?? "");
  const count = calls.length;
  const label = waiting ? "Waiting for your approval"
    : active && current ? `${describeTool(current.toolName, current.args)}${note ? ` · ${note}` : ""}${count > 1 ? `  (${count} steps)` : ""}`
    : `${count} step${count === 1 ? "" : "s"}`;

  return (
    <ToolGroupRoot variant="ghost" open={waiting || (open ?? reviewed)} onOpenChange={setOpen}>
      <ToolGroupTrigger count={count} active={active && !waiting} label={<span className="block max-w-[70vw] truncate md:max-w-[min(calc(var(--chat-w)-90px),40vw)]">{label}</span>} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
