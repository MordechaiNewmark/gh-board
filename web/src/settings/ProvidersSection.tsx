import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Switch } from "radix-ui";
import { CheckCircle2Icon, ChevronRightIcon, CircleAlertIcon, Loader2Icon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errMsg } from "@/lib/api";
import {
  CAPABILITY_NOTE, KIND_LABEL, addProvider, removeProvider, saveProvider, testProvider, useProviders,
  type Preset, type Provider, type TestResult,
} from "./providers";

/*
 * Settings > Providers. Self-contained: it loads and saves through /api/providers itself, so any Settings
 * dialog can render <ProvidersSection /> with no props. Keys are write-only here: the server never sends
 * one back, only a masked tail and where the key came from.
 */

const STATUS: Record<string, { text: string; dot: string }> = {
  ready: { text: "Ready", dot: "bg-success" },
  off: { text: "Off", dot: "bg-muted-foreground/40" },
  "needs-key": { text: "Needs API key", dot: "bg-amber-500" },
  "needs-model": { text: "Needs a model", dot: "bg-amber-500" },
};
const secretProps = { type: "password", autoComplete: "new-password", "data-1p-ignore": true, "data-lpignore": "true", "data-form-type": "other", spellCheck: false } as const;
const plainProps = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", spellCheck: false, autoCapitalize: "off", autoCorrect: "off" } as const;
const splitModels = (s: string) => s.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);

function Warn({ children }: { children: ReactNode }) {
  return <p className="flex items-start gap-1.5 text-xs leading-snug text-amber-800 dark:text-amber-300"><TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /><span>{children}</span></p>;
}
function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <div className="text-xs leading-snug text-muted-foreground">{hint}</div>}
    </div>
  );
}
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Switch.Root checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-input outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 data-[state=checked]:bg-brand">
      <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </Switch.Root>
  );
}

function ModelList({ id, models, onChange, suggestions }: { id: string; models: string[]; onChange: (m: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState("");
  const add = () => { const next = splitModels(draft).filter((m) => !models.includes(m)); if (next.length) onChange([...models, ...next]); setDraft(""); };
  const more = suggestions.filter((m) => !models.includes(m));
  return (
    <div className="flex flex-col gap-1.5">
      {models.length > 0 && (
        <ul aria-label="Models" className="flex flex-wrap gap-1">
          {models.map((m) => (
            <li key={m} className="flex max-w-full items-center gap-0.5 rounded-md border bg-muted/60 py-0.5 pl-2 pr-0.5 font-mono text-[11.5px]">
              <span className="truncate">{m}</span>
              <button type="button" aria-label={`Remove ${m}`} onClick={() => onChange(models.filter((x) => x !== m))} className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <Input id={id} {...plainProps} list={`${id}-list`} placeholder={more.length ? `Add a model id (${more.length} available from the provider)` : "Add a model id, e.g. gpt-5-mini"} className="h-8 font-mono text-[12.5px] md:text-[12.5px]"
          value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} />
        <datalist id={`${id}-list`}>{more.slice(0, 200).map((m) => <option key={m} value={m} />)}</datalist>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>Add</Button>
      </div>
    </div>
  );
}

function TestLine({ result, busy }: { result: TestResult | null; busy: boolean }) {
  if (busy) return <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2Icon aria-hidden className="size-3.5 animate-spin" />Testing the connection…</p>;
  if (!result) return null;
  return result.ok
    ? <p role="status" className="flex items-start gap-1.5 text-xs leading-snug text-success"><CheckCircle2Icon aria-hidden className="mt-px size-3.5 shrink-0" /><span>{result.message}</span></p>
    : <p role="alert" className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-snug text-destructive"><CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /><span className="min-w-0 break-words">{result.message}</span></p>;
}

function ProviderCard({ p }: { p: Provider }) {
  const uid = useId();
  const [open, setOpen] = useState(p.status !== "ready" && p.status !== "off" && !p.builtin);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const st = STATUS[p.status] ?? STATUS.off;
  const dirty = !!key.trim() || baseUrl !== null || models !== null;
  const shownUrl = baseUrl ?? p.baseUrl ?? "";
  const shownModels = models ?? p.models;
  const envName = p.keySource?.startsWith("env:") ? p.keySource.slice(4) : "";

  const run = async (what: "save" | "test" | "remove", fn: () => Promise<void>) => {
    setBusy(what); setError("");
    try { await fn(); } catch (e) { setError(errMsg(e)); }
    setBusy("");
  };
  const save = async () => {
    if (!dirty) return;
    await saveProvider(p.id, { ...(key.trim() ? { apiKey: key.trim() } : {}), ...(baseUrl !== null ? { baseUrl } : {}), ...(models !== null ? { models } : {}) });
    setKey(""); setBaseUrl(null); setModels(null);
  };
  const onSave = (e: FormEvent) => { e.preventDefault(); void run("save", async () => { await save(); setResult(null); }); };
  const onTest = () => run("test", async () => {
    setResult(null);
    await save();
    const r = await testProvider(p.id, shownModels[0]);
    setResult(r);
    if (r.ok && r.models.length) setSuggestions(r.models);
  });
  const onToggle = (enabled: boolean) => run("save", async () => { await saveProvider(p.id, { enabled }); });
  const onClearKey = () => run("save", async () => { await saveProvider(p.id, { clearKey: true }); setKey(""); setResult(null); });
  const onRemove = () => run("remove", async () => { await removeProvider(p.id); setKey(""); setBaseUrl(null); setModels(null); setResult(null); });

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button type="button" aria-expanded={open} aria-controls={`${uid}-body`} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate text-sm font-semibold">{p.label}</span>
              <span className="rounded border px-1.5 text-[10.5px] leading-[16px] text-muted-foreground">{KIND_LABEL[p.kind]}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", st.dot)} />
              <span className="truncate">{st.text}{p.hasKey && <> · key <span className="font-mono">{p.keyTail}</span>{envName && ` from ${envName}`}</>}{p.status === "ready" && !p.needsKey && !p.hasKey && " · no key needed"}{p.status === "ready" && ` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}`}</span>
            </span>
          </span>
        </button>
        <Toggle checked={p.enabled} onChange={onToggle} disabled={!!busy} label={`${p.enabled ? "Disable" : "Enable"} ${p.label}`} />
      </div>

      {open && (
        <form id={`${uid}-body`} onSubmit={onSave} className="flex flex-col gap-3.5 border-t px-3 pb-3 pt-3 sm:pl-[2.6rem]">
          <Field label={p.needsKey ? "API key" : "API key (optional)"} htmlFor={`${uid}-key`}
            hint={<>
              {p.keySource === "saved" && <>A key is saved on this computer ({p.keyTail}). It is never shown again; paste a new one to replace it.{" "}<button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={onClearKey}>Remove saved key</button></>}
              {envName && <>Using <code className="rounded bg-secondary px-1 font-mono text-foreground">{envName}</code> from the environment. A key saved here takes priority.</>}
              {!p.hasKey && (p.needsKey ? <>Stored only on the computer running gh-board, never sent to the browser.{p.keyEnv?.length ? <> Or set <code className="rounded bg-secondary px-1 font-mono text-foreground">{p.keyEnv[0]}</code> in <code className="font-mono">.env</code>.</> : null}</> : "Local servers such as Ollama and LM Studio do not need one.")}
              {p.keyUrl && !p.hasKey && <>{" "}<a className="font-medium text-brand underline underline-offset-2" href={p.keyUrl} target="_blank" rel="noopener noreferrer">Get a key</a></>}
            </>}>
            <Input id={`${uid}-key`} name={`provider-key-${uid}`} {...secretProps} className="font-mono" placeholder={p.hasKey ? `${p.keyTail}  (paste to replace)` : "Paste the API key"} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>

          <Field label={p.builtin ? "Base URL (advanced)" : "Base URL"} htmlFor={`${uid}-url`}
            hint={p.builtin && p.baseUrlSource !== "default" ? <>Overridden{p.baseUrlSource?.startsWith("env:") ? ` by ${p.baseUrlSource.slice(4)}` : ""}. Default: <span className="font-mono">{p.baseUrlDefault}</span>.{" "}{p.baseUrlSource === "saved" && <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setBaseUrl("")}>Use the default</button>}</> : undefined}>
            <Input id={`${uid}-url`} name={`provider-url-${uid}`} type="url" inputMode="url" {...plainProps} className="font-mono text-[12.5px] md:text-[12.5px]" placeholder={p.baseUrlDefault ?? "https://api.example.com/v1"} value={shownUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            {baseUrl === null && p.warnings.map((w) => <Warn key={w}>{w}</Warn>)}
          </Field>

          <Field label="Models" htmlFor={`${uid}-model`} hint="Model ids exactly as the provider names them. These appear in the chat's model picker. Use a model that supports tool calling.">
            <ModelList id={`${uid}-model`} models={shownModels} onChange={setModels} suggestions={suggestions} />
          </Field>

          {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{error}</p>}
          <TestLine result={result} busy={busy === "test"} />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!dirty || !!busy} className="bg-brand text-brand-foreground hover:bg-brand/90">{busy === "save" && <Loader2Icon className="animate-spin" />}Save</Button>
            <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={onTest}>{dirty ? "Save and test" : "Test connection"}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={onRemove} className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              title={p.builtin ? `Forget the saved key and settings for ${p.label}` : `Remove ${p.label}`}>{busy === "remove" && <Loader2Icon className="animate-spin" />}{p.builtin ? "Reset" : "Remove"}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

function AddCustom({ presets, onDone }: { presets: Preset[]; onDone: () => void }) {
  const uid = useId();
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [keyEnv, setKeyEnv] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usePreset = (p: Preset) => { setLabel(p.name); setBaseUrl(p.baseUrl); setKeyEnv(p.keyEnv); setModels(p.example); setError(""); };
  const plainHttp = /^http:\/\/(?!localhost[:/]|127\.|\[::1\])/i.test(baseUrl.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await addProvider({ label, baseUrl, apiKey: key.trim() || undefined, keyEnv: keyEnv.trim() || undefined, models: splitModels(models) }); onDone(); }
    catch (err) { setError(errMsg(err)); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5 rounded-lg border border-dashed bg-muted/30 p-3">
      <div>
        <p className="text-sm font-semibold">Add a custom provider</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">Any endpoint that speaks the OpenAI chat-completions API. Start from one of these, or fill it in yourself.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {presets.map((p) => <Button key={p.name} type="button" variant={label === p.name ? "secondary" : "outline"} size="xs" onClick={() => usePreset(p)}>{p.name}</Button>)}
        </div>
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${uid}-name`}><Input id={`${uid}-name`} name="provider-name" {...plainProps} placeholder="OpenRouter" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} required /></Field>
        <Field label="Base URL" htmlFor={`${uid}-url`}><Input id={`${uid}-url`} name="provider-base-url" type="url" inputMode="url" {...plainProps} className="font-mono text-[12.5px] md:text-[12.5px]" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required /></Field>
      </div>
      {plainHttp && <Warn>This address is plain http and not this computer: the key and everything the model reads would travel unencrypted.</Warn>}
      <Field label="API key (optional for local servers)" htmlFor={`${uid}-key`} hint={keyEnv ? <>Leave empty to use <code className="rounded bg-secondary px-1 font-mono text-foreground">{keyEnv}</code> from <code className="font-mono">.env</code>.</> : "Stored only on the computer running gh-board."}>
        <Input id={`${uid}-key`} name={`provider-new-key-${uid}`} {...secretProps} className="font-mono" placeholder="Paste the API key" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <Field label="Model ids" htmlFor={`${uid}-models`} hint="Separate several with commas. You can add more later.">
        <Input id={`${uid}-models`} name="provider-models" {...plainProps} className="font-mono text-[12.5px] md:text-[12.5px]" placeholder="llama-3.3-70b-versatile, qwen2.5-coder:14b" value={models} onChange={(e) => setModels(e.target.value)} />
      </Field>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !label.trim() || !baseUrl.trim()} className="bg-brand text-brand-foreground hover:bg-brand/90">{busy && <Loader2Icon className="animate-spin" />}Add provider</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function ProvidersSection() {
  const { view, error, loading } = useProviders();
  const [adding, setAdding] = useState(false);
  const claude = view?.providers.find((p) => p.kind === "claude-agent-sdk");
  const rest = view?.providers.filter((p) => p.kind !== "claude-agent-sdk") ?? [];

  return (
    <section aria-labelledby="providers-heading" className="flex flex-col gap-3">
      <div>
        <h3 id="providers-heading" className="text-sm font-semibold">Providers</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Choose which models the chat can run on, then pick one in the chat header. Every provider gets the same board tools, read-only repo access and approval step. {CAPABILITY_NOTE}
        </p>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">Could not load providers: {error}</p>}
      {view?.fileTooOpen && <Warn>The provider settings file is readable by other users on this computer. Run <code className="font-mono">chmod 600 .providers.json</code>.</Warn>}
      {!view && loading && <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2Icon aria-hidden className="size-3.5 animate-spin" />Loading providers…</p>}

      <ul className="flex flex-col gap-2">
        {claude && (
          <li className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5">
            <span aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="text-sm font-semibold">{claude.label}</span><span className="rounded border px-1.5 text-[10.5px] leading-[16px] text-muted-foreground">{KIND_LABEL[claude.kind]}</span><span className="rounded bg-brand/10 px-1.5 text-[10.5px] font-medium leading-[18px] text-brand">Default</span></span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{claude.note}</span>
            </span>
          </li>
        )}
        {rest.map((p) => <ProviderCard key={p.id} p={p} />)}
      </ul>

      {adding
        ? <AddCustom presets={view?.presets ?? []} onDone={() => setAdding(false)} />
        : <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)} disabled={!view}><PlusIcon />Add custom provider</Button>}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Keys are kept in <code className="rounded bg-secondary px-1 font-mono text-foreground">.providers.json</code> next to the server (owner-only, git-ignored) and are sent only to their own provider. With a non-Claude provider, your prompts, issue text and the repo files the model reads go to that provider.
      </p>
    </section>
  );
}
