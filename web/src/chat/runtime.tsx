import { useSyncExternalStore, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AttachmentAdapter,
  type ChatModelAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";

/* Small keyed stores the tool cards subscribe to (approvals and generated files). */
function createStore<T>() {
  let map = new Map<string, T>();
  const subs = new Set<() => void>();
  return {
    set(key: string, value: T) { map = new Map(map).set(key, value); subs.forEach((f) => f()); },
    snapshot: () => map,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type Approval = { id: string; state: "pending" | "approved" | "rejected" | "blocked"; input?: unknown };
export type GeneratedFile = { id: string; name: string; size: number };
export const approvals = createStore<Approval>();
export const generated = createStore<GeneratedFile>();
/* Latest progress line per tool call (sync_repo: cloning, checking out, indexing). */
export const progress = createStore<string>();
/* The repo the board is showing, readable from chat components. */
const repoStore = createStore<string>();
export const setChatRepo = (repo: string) => { chatCtx.repo = repo; repoStore.set("repo", repo); };
export const useChatRepo = () => useSyncExternalStore(repoStore.subscribe, repoStore.snapshot).get("repo") ?? "";
export const useApprovals = () => useSyncExternalStore(approvals.subscribe, approvals.snapshot);
export const useProgress = (toolCallId: string) => useSyncExternalStore(progress.subscribe, progress.snapshot).get(toolCallId);
export const useApproval = (toolCallId: string) => useSyncExternalStore(approvals.subscribe, approvals.snapshot).get(toolCallId);
export const useGenerated = (toolCallId: string) => useSyncExternalStore(generated.subscribe, generated.snapshot).get(toolCallId);

export async function answerApproval(toolCallId: string, approval: Approval, ok: boolean) {
  approvals.set(toolCallId, { ...approval, state: ok ? "approved" : "rejected" });
  await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: approval.id, ok }) }).catch(() => {});
}

/* What the board tells the chat about (set by App). */
export const chatCtx = {
  repo: "",
  autoApprove: false,
  sessionId: null as string | null,
  provider: "claude", // set by the provider picker (settings/providers.ts)
  model: "",
  chatId: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
  onDone: () => {},
};

/* Attachments: keep the raw bytes here and send them with the next message. */
type Upload = { name: string; type: string; b64: string };
const uploads = new Map<string, Upload>();
const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const attachments: AttachmentAdapter = {
  accept: "*",
  async add({ file }): Promise<PendingAttachment> {
    if (file.size > 20e6) throw new Error("Attachments are limited to 20 MB.");
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: file.type.startsWith("image/") ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async send(attachment): Promise<CompleteAttachment> {
    const b64 = await toBase64(attachment.file);
    uploads.set(attachment.id, { name: attachment.name, type: attachment.contentType ?? "", b64 });
    const image = (attachment.contentType ?? "").startsWith("image/");
    return {
      ...attachment,
      status: { type: "complete" },
      content: image
        ? [{ type: "image", image: `data:${attachment.contentType};base64,${b64}` }]
        : [{ type: "text", text: `[Attached file: ${attachment.name}]` }],
    };
  },
  async remove(attachment) { uploads.delete(attachment.id); },
};

type Part =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; argsText: string; result?: unknown; isError?: boolean };

/* One run = one POST /api/chat; the server streams events until the agent is done. */
const adapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const last = messages[messages.length - 1];
    const message = (last?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    const files = ((last as any)?.attachments ?? []).map((a: any) => uploads.get(a.id)).filter(Boolean);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, files, repo: chatCtx.repo, sessionId: chatCtx.sessionId, autoApprove: chatCtx.autoApprove, chatId: chatCtx.chatId, provider: chatCtx.provider, model: chatCtx.model }),
      signal: abortSignal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

    const parts: Part[] = [];
    const snapshot = () => ({ content: parts.map((p) => ({ ...p })) }) as any;
    const tools = () => parts.filter((p): p is Extract<Part, { type: "tool-call" }> => p.type === "tool-call");
    const addText = (text: string) => {
      const tail = parts[parts.length - 1];
      if (tail?.type === "text") tail.text += `\n\n${text}`;
      else parts.push({ type: "text", text });
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        let changed = false;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, "");
          buf = buf.slice(i + 2);
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "session") chatCtx.sessionId = ev.sessionId;
          else if (ev.type === "text") { addText(ev.text); changed = true; }
          else if (ev.type === "delta") { // streamed text from non-Claude providers: append as-is
            const tail = parts[parts.length - 1];
            if (tail?.type === "text") tail.text += ev.text; else parts.push({ type: "text", text: String(ev.text ?? "") });
            changed = true;
          }
          else if (ev.type === "tool") {
            parts.push({ type: "tool-call", toolCallId: ev.id || `tool-${++n}`, toolName: ev.name, args: ev.input ?? {}, argsText: JSON.stringify(ev.input ?? {}) });
            changed = true;
          } else if (ev.type === "tool_result") {
            const t = tools().find((p) => p.toolCallId === ev.id);
            if (t) { t.result = ev.isError ? "Failed" : "Done"; t.isError = !!ev.isError; changed = true; }
          } else if (ev.type === "approval") {
            const waiting = approvals.snapshot();
            const t = tools().find((p) => p.toolCallId === ev.toolUseId) ?? tools().reverse().find((p) => p.toolName === ev.tool && p.result === undefined && !waiting.has(p.toolCallId));
            if (t) approvals.set(t.toolCallId, { id: ev.id, state: ev.blocked ? "blocked" : "pending", input: ev.input });
            changed = true;
          } else if (ev.type === "progress") {
            const t = tools().find((p) => p.toolCallId === ev.id) ?? tools().reverse().find((p) => p.toolName === (ev.tool ?? "sync_repo") && p.result === undefined) ?? tools().reverse().find((p) => p.result === undefined);
            if (t) progress.set(t.toolCallId, String(ev.text ?? ""));
          } else if (ev.type === "file") {
            const t = tools().reverse().find((p) => p.toolName === "generate_file" && !generated.snapshot().has(p.toolCallId));
            if (t) generated.set(t.toolCallId, { id: ev.id, name: ev.name, size: ev.size });
            else addText(`File ready: [${ev.name}](/api/download?id=${encodeURIComponent(ev.id)})`);
            changed = true;
          } else if (ev.type === "error" || (ev.type === "done" && ev.error)) { addText(`Error: ${ev.error}`); changed = true; }
        }
        if (changed) yield snapshot();
      }
    } finally {
      for (const t of tools()) if (t.result === undefined) t.result = abortSignal.aborted ? "Stopped" : "Done";
      chatCtx.onDone();
    }
    if (!parts.length) addText("Done.");
    yield snapshot();
  },
};

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(adapter, { adapters: { attachments } });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
