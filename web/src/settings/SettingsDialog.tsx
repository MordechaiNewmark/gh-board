import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProvidersSection } from "./ProvidersSection";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

/* Minimal Settings shell. Sections are self-contained components; add more next to <ProvidersSection />. */
export function SettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus(); }} tabIndex={-1} className="flex max-h-[min(92dvh,52rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
          <DialogTitle className="text-base">Settings</DialogTitle>
          <DialogDescription>Saved on the computer running gh-board.</DialogDescription>
        </DialogHeader>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <ProvidersSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
