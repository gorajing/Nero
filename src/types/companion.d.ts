// src/types/companion.d.ts — ambient typings for the contextBridge surfaces the renderer
// consumes. These mirror EXACTLY what src/preload.ts exposes via contextBridge. Imported
// implicitly by the renderer (TS global augmentation); never imported at runtime.
//
// The canonical ActionEvent is the 11-kind union from src/shared/events.ts (the flat
// electron-shell union in the BUILD_GUIDE prose is deleted per the central design decision).
import type { ActionEvent } from '../shared/events';
import type { MicStatus, TurnInput } from '../shared/ipc';
import type { Decision, DecideInput } from '../shared/brain';
import type { RememberInput, MemoryRow, MemoryMatch } from '../shared/memory';

export interface CompanionBridge {
  mic: {
    /** Current macOS TCC mic status (never inferred from getUserMedia). */
    status(): Promise<MicStatus>;
    /** Triggers the TCC prompt (or returns the already-decided status). */
    request(): Promise<MicStatus>;
  };
  /**
   * PRIMARY orchestration entrypoint: hand MAIN a final transcript to run a full voice
   * turn (recall -> decide -> dispatch executor). Action/run events stream back over
   * onActionEvent / onRunEnd; this promise resolves only with the runId.
   */
  turnRun(input: TurnInput): Promise<{ runId: string }>;
  /** Direct executor dispatch, bypassing the brain (decide() already produced a command). */
  runTask(prompt: string, agent: AgentKindArg): Promise<{ runId: string }>;
  /** SIGTERM/abort the active runner for a given runId (or the latest run if omitted). */
  cancelTask(runId?: string): Promise<void>;
  /** Move the current floating BrowserWindow by screen-pixel deltas. */
  moveWindowBy(delta: { dx: number; dy: number }): Promise<void>;
  /** Subscribe to the normalized executor event stream; returns an unsubscribe fn. */
  onActionEvent(cb: (e: ActionEvent) => void): () => void;
  /** Subscribe to run-finished markers; returns an unsubscribe fn. */
  onRunEnd(cb: (p: { runId: string }) => void): () => void;
  /** Subscribe to global demo mute toggles; returns an unsubscribe fn. */
  onMicToggleMute(cb: () => void): () => void;
}

export type AgentKindArg = 'codex' | 'claude';

export interface BrainBridge {
  decide(input: DecideInput): Promise<Decision>;
  describeScreen(input: { b64: string; mime: string }): Promise<string>;
  embed(input: string | string[]): Promise<number[] | number[][]>;
  /** DeepSeek reasoning_content token deltas -> avatar 'thinking'. Returns unsubscribe. */
  onReasoning(cb: (delta: string) => void): () => void;
  /** Optional live JSON-preview content deltas. Returns unsubscribe. */
  onContent(cb: (delta: string) => void): () => void;
}

export interface MemoryBridge {
  remember(input: RememberInput): Promise<MemoryRow>;
  recall(input: { query: string; k?: number; sessionId?: string }): Promise<MemoryMatch[]>;
}

export interface VisionBridge {
  /** MAIN captures the screen + Qwen2.5-VL; may reject with BlackFrameError (TCC denied). */
  ask(prompt: string): Promise<string>;
}

declare global {
  interface Window {
    companion: CompanionBridge;
    brain: BrainBridge;
    memory: MemoryBridge;
    vision: VisionBridge;
  }
}

export {};
