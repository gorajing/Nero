// src/main/ipc.ts — registers every CH channel handler (ipcMain.handle, request/response).
//
// Streaming channels (CH.actionEvent, CH.runEnd, CH.brainReasoning, CH.brainContent) are
// PUSH-only (webContents.send) and are NOT registered here — they are emitted by the
// orchestrator / brain wiring. ipcMain.handle resolves with a final value only.
//
// Each handler's sibling call:
//   CH.micStatus          -> mic.getMicStatus()                (this component)
//   CH.micRequest         -> mic.ensureMicAccess()             (this component)
//   CH.windowMoveBy       -> current BrowserWindow.setPosition()
//   CH.turnRun            -> orchestrator.runTurn()            (recall+decide+dispatch)
//   CH.runTask            -> orchestrator.runTask()            -> executor.getExecutor()
//   CH.cancelTask         -> orchestrator.cancelTask()
//   CH.brainDecide        -> brain.decide()                    (sibling: src/brain)
//   CH.brainDescribeScreen-> brain.describeScreen()            (sibling: src/brain)
//   CH.brainEmbed         -> brain.embed()                     (sibling: src/brain)
//   CH.memoryRemember     -> memory.remember()                 (sibling: src/memory)
//   CH.memoryRecall       -> memory.recall()                   (sibling: src/memory)
//   CH.visionAsk          -> vision.askScreen()                (sibling: src/vision)
import { BrowserWindow, ipcMain } from 'electron';
import { CH } from '../shared/ipc';
import type { MicStatus, TurnInput } from '../shared/ipc';
import type { Decision, DecideInput } from '../shared/brain';
import type { RememberInput, MemoryRow, MemoryMatch } from '../shared/memory';
import type { AgentKind } from '../shared/events';
import { getMicStatus, ensureMicAccess } from './mic';
import { runTurn, runTask, cancelTask } from './orchestrator';
import { loadBrain, loadMemory, loadVision } from './siblings';

/** Coerce a renderer-supplied agent arg to a valid AgentKind (default codex). */
function asAgentKind(v: unknown): AgentKind {
  return v === 'claude' ? 'claude' : 'codex';
}

function finitePixelDelta(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

export function registerIpcHandlers(): void {
  // ---- Mic (this component) ----
  ipcMain.handle(CH.micStatus, (): MicStatus => getMicStatus());
  ipcMain.handle(CH.micRequest, (): Promise<MicStatus> => ensureMicAccess());

  // ---- Window chrome (floating Nero) ----
  ipcMain.handle(
    CH.windowMoveBy,
    (event, delta: { dx?: unknown; dy?: unknown }): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      const dx = finitePixelDelta(delta?.dx);
      const dy = finitePixelDelta(delta?.dy);
      if (dx === 0 && dy === 0) return;

      const [x, y] = win.getPosition();
      win.setPosition(x + dx, y + dy, false);
    },
  );

  // ---- Orchestrator ----
  ipcMain.handle(
    CH.turnRun,
    (_e, input: TurnInput): Promise<{ runId: string }> => runTurn(input),
  );
  ipcMain.handle(
    CH.runTask,
    (_e, arg: { prompt: string; agent?: AgentKind }): Promise<{ runId: string }> =>
      runTask(arg.prompt, asAgentKind(arg.agent)),
  );
  ipcMain.handle(CH.cancelTask, (_e, runId?: string): void => cancelTask(runId));

  // ---- Brain (sibling: src/brain) ----
  ipcMain.handle(
    CH.brainDecide,
    async (_e, input: DecideInput): Promise<Decision> => {
      const brain = await loadBrain();
      return brain.decide(input);
    },
  );
  ipcMain.handle(
    CH.brainDescribeScreen,
    async (_e, input: { b64: string; mime: string }): Promise<string> => {
      const brain = await loadBrain();
      return brain.describeScreen(input);
    },
  );
  ipcMain.handle(
    CH.brainEmbed,
    async (_e, input: string | string[]): Promise<number[] | number[][]> => {
      const brain = await loadBrain();
      return brain.embed(input);
    },
  );

  // ---- Memory (sibling: src/memory) ----
  ipcMain.handle(
    CH.memoryRemember,
    async (_e, input: RememberInput): Promise<MemoryRow> => {
      const memory = await loadMemory();
      return memory.remember(input);
    },
  );
  ipcMain.handle(
    CH.memoryRecall,
    async (
      _e,
      input: { query: string; k?: number; sessionId?: string },
    ): Promise<MemoryMatch[]> => {
      const memory = await loadMemory();
      return memory.recall(input);
    },
  );

  // ---- Vision (sibling: src/vision) ----
  // THROWS BlackFrameError up to the renderer (which must catch + show onboarding).
  // askScreen captures the screen then calls the injected describe callback (brain) to caption.
  ipcMain.handle(CH.visionAsk, async (_e, prompt: string): Promise<string> => {
    const [vision, brain] = await Promise.all([loadVision(), loadBrain()]);
    return vision.askScreen(prompt, (img) => brain.describeScreen(img));
  });
}
