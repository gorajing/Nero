// src/preload.ts — the ONLY bridge between the sandboxed renderer and MAIN. Exposes four
// contextBridge namespaces (window.companion / window.brain / window.memory / window.vision)
// that wrap ipcRenderer.invoke (request/response) and ipcRenderer.on (push streams).
//
// Sandbox rules: this file may import 'electron' and the PURE src/shared/* modules (string
// consts + types, bundled by plugin-vite) — nothing that pulls Node builtins. NEVER expose
// ipcRenderer itself; only wrapped functions with structured-cloneable args. Every on()
// subscription returns an unsubscribe fn so the renderer can avoid listener leaks.
import { contextBridge, ipcRenderer } from 'electron';
import { CH } from './shared/ipc';
import type { MicStatus, TurnInput } from './shared/ipc';
import type { ActionEvent } from './shared/events';
import type { Decision, DecideInput } from './shared/brain';
import type { RememberInput, MemoryRow, MemoryMatch } from './shared/memory';

type AgentKindArg = 'codex' | 'claude';

// Renderer-safe runtime config injected by MAIN via webPreferences.additionalArguments.
// A sandboxed preload CAN read process.argv, so we parse the --companion-cfg= argv element
// here and expose it as window.COMPANION_CFG for src/renderer/config.ts to consume.
const cfgArg = process.argv.find((a) => a.startsWith('--companion-cfg='));
let companionCfg: Record<string, string | boolean> = {};
if (cfgArg) {
  try {
    companionCfg = JSON.parse(cfgArg.slice('--companion-cfg='.length));
  } catch {
    /* ignore malformed cfg — renderer falls back to empty defaults */
  }
}

/** Subscribe to a MAIN->renderer push channel; returns an unsubscribe fn. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const companion = {
  mic: {
    status: (): Promise<MicStatus> => ipcRenderer.invoke(CH.micStatus),
    request: (): Promise<MicStatus> => ipcRenderer.invoke(CH.micRequest),
  },
  // PRIMARY entrypoint: full voice turn (recall -> decide -> dispatch). Events stream back.
  turnRun: (input: TurnInput): Promise<{ runId: string }> =>
    ipcRenderer.invoke(CH.turnRun, input),
  // Direct executor dispatch (brain already produced a command).
  runTask: (prompt: string, agent: AgentKindArg): Promise<{ runId: string }> =>
    ipcRenderer.invoke(CH.runTask, { prompt, agent }),
  cancelTask: (runId?: string): Promise<void> =>
    ipcRenderer.invoke(CH.cancelTask, runId),
  moveWindowBy: (delta: { dx: number; dy: number }): Promise<void> =>
    ipcRenderer.invoke(CH.windowMoveBy, delta),
  // Push streams.
  onActionEvent: (cb: (e: ActionEvent) => void): (() => void) =>
    subscribe<ActionEvent>(CH.actionEvent, cb),
  onRunEnd: (cb: (p: { runId: string }) => void): (() => void) =>
    subscribe<{ runId: string }>(CH.runEnd, cb),
  onMicToggleMute: (cb: () => void): (() => void) =>
    subscribe<void>(CH.micToggleMute, () => cb()),
};

const brain = {
  decide: (input: DecideInput): Promise<Decision> =>
    ipcRenderer.invoke(CH.brainDecide, input),
  describeScreen: (input: { b64: string; mime: string }): Promise<string> =>
    ipcRenderer.invoke(CH.brainDescribeScreen, input),
  embed: (input: string | string[]): Promise<number[] | number[][]> =>
    ipcRenderer.invoke(CH.brainEmbed, input),
  // DeepSeek reasoning_content deltas -> avatar 'thinking'.
  onReasoning: (cb: (delta: string) => void): (() => void) =>
    subscribe<string>(CH.brainReasoning, cb),
  // Optional live JSON-preview content deltas.
  onContent: (cb: (delta: string) => void): (() => void) =>
    subscribe<string>(CH.brainContent, cb),
};

const memory = {
  remember: (input: RememberInput): Promise<MemoryRow> =>
    ipcRenderer.invoke(CH.memoryRemember, input),
  recall: (input: {
    query: string;
    k?: number;
    sessionId?: string;
  }): Promise<MemoryMatch[]> => ipcRenderer.invoke(CH.memoryRecall, input),
};

const vision = {
  // May reject with BlackFrameError — the renderer must catch and show onboarding.
  ask: (prompt: string): Promise<string> =>
    ipcRenderer.invoke(CH.visionAsk, prompt),
};

contextBridge.exposeInMainWorld('companion', companion);
contextBridge.exposeInMainWorld('brain', brain);
contextBridge.exposeInMainWorld('memory', memory);
contextBridge.exposeInMainWorld('vision', vision);
contextBridge.exposeInMainWorld('COMPANION_CFG', companionCfg);
