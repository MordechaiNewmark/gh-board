import { useEffect, useSyncExternalStore } from "react";
import { api, errMsg } from "@/lib/api";
import { chatCtx } from "@/chat/runtime";

/* What the server tells the browser about a provider. It never includes a key: only whether one is set, its masked tail and where it came from. */
export type ProviderKind = "claude-agent-sdk" | "openai" | "gemini" | "openai-compatible";
export type ProviderStatus = "ready" | "off" | "needs-key" | "needs-model";
export type Provider = {
  id: string; label: string; kind: ProviderKind; builtin: boolean; needsKey: boolean;
  baseUrl?: string; baseUrlDefault?: string; baseUrlSource?: string; keyUrl?: string;
  models: string[]; enabled: boolean; status: ProviderStatus;
  hasKey: boolean; keySource: string | null; keyTail: string; keyEnv?: string[]; warnings: string[]; note?: string;
};
export type Preset = { name: string; baseUrl: string; keyEnv: string; needsKey: boolean; example: string };
export type ProvidersView = { providers: Provider[]; presets: Preset[]; defaultProvider: string; fileTooOpen?: boolean };
export type TestResult = { ok: boolean; message: string; models: string[] };

export const CLAUDE = "claude";
export const KIND_LABEL: Record<ProviderKind, string> = { "claude-agent-sdk": "Agent SDK", openai: "OpenAI API", gemini: "Gemini API", "openai-compatible": "OpenAI-compatible" };
export const CAPABILITY_NOTE = "Claude is the default and the most reliable here. Other models are often weaker at long, multi-step tool use, so big repo audits may stop early or miss steps.";

/* ---- provider list: one shared copy, so the picker updates the moment Settings changes something ---- */
type State = { view: ProvidersView | null; error: string; loading: boolean };
let state: State = { view: null, error: "", loading: false };
const subs = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export async function refreshProviders() {
  set({ loading: true });
  try { set({ view: await api<ProvidersView>("/api/providers"), error: "", loading: false }); }
  catch (e) { set({ error: errMsg(e), loading: false }); }
}
let started = false;
export function useProviders() {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => { if (!started) { started = true; void refreshProviders(); } }, []);
  return s;
}
const applied = <T extends ProvidersView>(view: T) => { set({ view, error: "" }); return view; };
export const saveProvider = async (id: string, patch: Record<string, unknown>) => applied(await api<ProvidersView>("/api/providers/save", { id, ...patch }));
export const addProvider = async (input: Record<string, unknown>) => applied(await api<ProvidersView & { id: string }>("/api/providers/add", input));
export const removeProvider = async (id: string) => applied(await api<ProvidersView>("/api/providers/remove", { id }));
export const testProvider = (id: string, model?: string) => api<TestResult>("/api/providers/test", { id, model });

/* ---- which provider + model the chat uses: remembered in this browser, Claude unless chosen otherwise ---- */
export type Selection = { provider: string; model: string };
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const P_KEY = "gh-board:provider";
const mKey = (id: string) => `gh-board:model:${id}`;

let selection: Selection = (() => { const provider = read(P_KEY) || CLAUDE; return { provider, model: provider === CLAUDE ? "" : read(mKey(provider)) }; })();
const selSubs = new Set<() => void>();
const pushToChat = () => { chatCtx.provider = selection.provider; chatCtx.model = selection.model; };
pushToChat();

export function selectModel(provider: string, model = "") {
  if (provider === selection.provider && model === selection.model) return;
  // History lives with the backend that produced it: Claude's in the Agent SDK, everyone else's in the server's provider sessions.
  if ((provider === CLAUDE) !== (selection.provider === CLAUDE)) chatCtx.sessionId = null;
  selection = { provider, model };
  write(P_KEY, provider);
  if (provider !== CLAUDE && model) write(mKey(provider), model);
  pushToChat();
  selSubs.forEach((f) => f());
}
export const lastModel = (p: Provider) => { const m = read(mKey(p.id)); return m && p.models.includes(m) ? m : p.models[0] ?? ""; };
export const useSelection = () => useSyncExternalStore((f) => { selSubs.add(f); return () => { selSubs.delete(f); }; }, () => selection);

/** Why the current selection cannot run, or "" when it can. */
export function selectionProblem(sel: Selection, view: ProvidersView | null): string {
  if (sel.provider === CLAUDE || !view) return "";
  const p = view.providers.find((x) => x.id === sel.provider);
  if (!p) return "The selected provider was removed.";
  if (p.status === "off") return `${p.label} is turned off.`;
  if (p.status === "needs-key") return `${p.label} has no API key yet.`;
  if (!sel.model || p.status === "needs-model") return `${p.label} has no model selected.`;
  if (!p.models.includes(sel.model)) return `${sel.model} is no longer in ${p.label}'s model list.`;
  return "";
}
