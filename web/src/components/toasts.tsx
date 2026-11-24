import { useCallback, useRef, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type Toast = { id: number; text: string; kind: "error" | "info" };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => dismiss(id), kind === "error" ? 8000 : 3500);
  }, [dismiss]);
  return { toasts, push, dismiss };
}

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} className={cn("toast-in pointer-events-auto flex max-w-md items-start gap-2.5 rounded-lg border bg-popover py-2.5 pl-3 pr-2 text-[13px] text-popover-foreground shadow-lg", t.kind === "error" && "border-destructive/40")}>
          {t.kind === "error" ? <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /> : <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
          <span className="min-w-0 break-words">{t.text}</span>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onDismiss(t.id)}><XIcon className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
}
