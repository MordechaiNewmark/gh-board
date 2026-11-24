import { DropdownMenu } from "radix-ui";
import { CheckIcon, ChevronDownIcon, Settings2Icon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAPABILITY_NOTE, CLAUDE, lastModel, selectModel, selectionProblem, useProviders, useSelection, type Provider } from "@/settings/providers";

type Props = { onOpenSettings: () => void };

const WHY: Record<string, string> = { off: "Turned off", "needs-key": "Needs an API key", "needs-model": "Needs a model" };
const item = "relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/* Chat header control: which provider and model answer in this chat. Remembered per browser; Claude unless changed. */
export function ProviderPicker({ onOpenSettings }: Props) {
  const { view } = useProviders();
  const sel = useSelection();
  const providers = view?.providers ?? [];
  const current = providers.find((p) => p.id === sel.provider);
  const problem = selectionProblem(sel, view);
  const others = providers.filter((p) => p.id !== CLAUDE);
  const ready = others.filter((p) => p.status === "ready");
  const pendingSetup = others.filter((p) => p.status !== "ready");
  const name = sel.provider === CLAUDE ? "Claude" : current?.label ?? "Unknown provider";

  return (
    <div className={cn("mr-auto flex min-w-0 flex-1", sel.model ? "basis-44" : "basis-16")}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Model for this chat: ${name}${sel.model ? `, ${sel.model}` : ""}. Change`}
        className="group -ml-1.5 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[14px] font-semibold outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-accent"
      >
        {problem ? <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-amber-600 dark:text-amber-400" /> : <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />}
        <span className="shrink-0">{name}</span>
        {sel.model && <span className="min-w-0 truncate font-mono text-[11.5px] font-normal text-muted-foreground">{sel.model}</span>}
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start" sideOffset={6} collisionPadding={8}
          className="scroll-thin z-50 max-h-[min(var(--radix-dropdown-menu-content-available-height),30rem)] w-[min(19rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DropdownMenu.RadioGroup value={`${sel.provider}\n${sel.model}`}>
            <DropdownMenu.RadioItem value={`${CLAUDE}\n`} onSelect={() => selectModel(CLAUDE)} className={item}>
              <DropdownMenu.ItemIndicator className="absolute left-2"><CheckIcon className="size-3.5 text-brand" /></DropdownMenu.ItemIndicator>
              <span className="font-medium">Claude</span>
              <span className="ml-auto text-[11px] text-muted-foreground">Default</span>
            </DropdownMenu.RadioItem>
            {ready.map((p) => <ProviderGroup key={p.id} p={p} />)}
          </DropdownMenu.RadioGroup>

          {pendingSetup.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Not set up</DropdownMenu.Label>
              {pendingSetup.map((p) => (
                <DropdownMenu.Item key={p.id} onSelect={onOpenSettings} className={cn(item, "text-muted-foreground")}>
                  <span>{p.label}</span>
                  <span className="ml-auto text-[11px]">{WHY[p.status] ?? ""}</span>
                </DropdownMenu.Item>
              ))}
            </>
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item onSelect={onOpenSettings} className={item}>
            <Settings2Icon aria-hidden className="absolute left-2 size-3.5 text-muted-foreground" />Manage providers…
          </DropdownMenu.Item>
          <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-snug text-muted-foreground">{CAPABILITY_NOTE} Switching between Claude and another provider starts a fresh conversation.</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </div>
  );
}

function ProviderGroup({ p }: { p: Provider }) {
  return (
    <>
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <DropdownMenu.Label className="truncate px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{p.label}</DropdownMenu.Label>
      {p.models.map((m) => (
        <DropdownMenu.RadioItem key={m} value={`${p.id}\n${m}`} onSelect={() => selectModel(p.id, m)} className={item}>
          <DropdownMenu.ItemIndicator className="absolute left-2"><CheckIcon className="size-3.5 text-brand" /></DropdownMenu.ItemIndicator>
          <span className="min-w-0 truncate font-mono text-[12px]">{m}</span>
        </DropdownMenu.RadioItem>
      ))}
    </>
  );
}

/* Inline note under the chat header when the chosen provider or model cannot run yet. */
export function ProviderNotice({ onOpenSettings }: Props) {
  const { view } = useProviders();
  const sel = useSelection();
  const problem = selectionProblem(sel, view);
  if (!problem) return null;
  const p = view?.providers.find((x) => x.id === sel.provider);
  const fixable = p?.status === "ready" && p.models.length > 0;
  return (
    <p role="status" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12.5px] leading-snug text-amber-900 dark:text-amber-200">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 basis-40">{problem} Messages will fail until this is fixed.</span>
      <span className="flex gap-3">
        {fixable && <button type="button" className="font-medium underline underline-offset-2" onClick={() => selectModel(p!.id, lastModel(p!))}>Use {lastModel(p!)}</button>}
        <button type="button" className="font-medium underline underline-offset-2" onClick={onOpenSettings}>Open settings</button>
        <button type="button" className="font-medium underline underline-offset-2" onClick={() => selectModel(CLAUDE)}>Use Claude</button>
      </span>
    </p>
  );
}
