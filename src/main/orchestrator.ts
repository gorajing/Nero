// src/main/orchestrator.ts — the MAIN-process orchestrator core.
//
// turnRun (the PRIMARY entrypoint): final transcript -> memory.recall -> brain.decide
// (streaming reasoning/content to the renderer) -> dispatch on Decision.command:
//   - run_agent      -> executor.run(...) for-await the ActionEvent stream
//   - answer/clarify -> push narration (a synthetic 'message' event), no executor
//   - capture_screen -> vision.ask -> decide() ONCE more with the screen, then re-dispatch
//
// runTask/cancelTask: direct executor dispatch (used after decide() already produced a
// command). One AbortController per run; cancelTask aborts it (the CLI executors translate
// an aborted signal into a run.failed('aborted')).
//
// STREAMING RULE (BUILD_GUIDE): ipcMain.handle is request/response only. ALL token/action
// streams go over webContents.send push channels (CH.actionEvent, CH.runEnd, CH.brainReasoning,
// CH.brainContent). The invoke promise resolves only with the final {runId}.
import { BrowserWindow, Notification } from 'electron';
import { CH } from '../shared/ipc';
import type { TurnInput } from '../shared/ipc';
import type { ActionEvent, AgentKind } from '../shared/events';
import { newRunId } from '../shared/events';
import type { Command, Decision, DecideInput } from '../shared/brain';
import type { MemoryKind } from '../shared/memory';
import { getExecutor } from '../executor';
import { loadBrain, loadMemory, loadVision } from './siblings';

const RECALL_K = 5;
const RECALL_MIN_SIMILARITY = 0.3;
const DEFAULT_AGENT: AgentKind = 'codex';

/** Holds the active AbortController per runId so cancelTask can target a specific run. */
const activeRuns = new Map<string, AbortController>();

/** Resolve the scratch git repo the coding agents run in. */
function workdir(): string {
  return process.env.COMPANION_WORKDIR ?? process.cwd();
}

function getWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

function pushEvent(e: ActionEvent): void {
  getWindow()?.webContents.send(CH.actionEvent, e);
}

function pushRunEnd(runId: string): void {
  getWindow()?.webContents.send(CH.runEnd, { runId });
}

function pushReasoning(delta: string): void {
  getWindow()?.webContents.send(CH.brainReasoning, delta);
}

function pushContent(delta: string): void {
  getWindow()?.webContents.send(CH.brainContent, delta);
}

/**
 * Fire a native OS notification when an agent run finishes. This is the reliable
 * "job done" signal even when the window is hidden, backgrounded, or in cat-only
 * floating mode (where the timeline/caption are not visible). Best-effort.
 */
function notifyJobDone(ok: boolean, detail?: string): void {
  try {
    if (!Notification.isSupported()) return;
    const body =
      (detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 180) ||
      (ok ? 'The coding agent finished.' : 'The coding agent stopped with an error.');
    new Notification({
      title: ok ? '✓ Companion — job complete' : '✗ Companion — job failed',
      body,
    }).show();
  } catch (err) {
    console.error('[orchestrator] notification failed:', (err as Error).message);
  }
}

/** Map a canonical event to the memory kind we persist it under. */
function memoryKind(e: ActionEvent): MemoryKind {
  switch (e.kind) {
    case 'message':
    case 'message.delta':
      return 'narration';
    case 'reasoning':
      return 'observation';
    default:
      return 'action';
  }
}

/** Short human summary of an event for the memory text column. */
function summarizeEvent(e: ActionEvent): string {
  switch (e.kind) {
    case 'run.started':
      return `run started (${e.agent})`;
    case 'turn.started':
      return 'turn started';
    case 'reasoning':
      return `reasoning: ${e.text.slice(0, 200)}`;
    case 'command':
      return `command ${e.status}: ${e.command.slice(0, 200)}`;
    case 'file_change':
      return `file_change ${e.status}: ${e.files.map((f) => `${f.op} ${f.path}`).join(', ')}`;
    case 'tool':
      return `tool ${e.status}: ${e.tool}${e.summary ? ` ${e.summary}` : ''}`;
    case 'message':
      return `message: ${e.text.slice(0, 200)}`;
    case 'message.delta':
      return e.text;
    case 'run.completed':
      return `run completed${e.finalText ? `: ${e.finalText.slice(0, 200)}` : ''}`;
    case 'run.failed':
      return `run failed: ${e.error}`;
  }
}

/** Persist a meaningful event to memory; best-effort (memory may be unavailable). */
async function rememberEvent(sessionId: string, e: ActionEvent): Promise<void> {
  // Skip noisy streaming deltas; persist concrete actions + final text only.
  if (e.kind === 'message.delta') return;
  try {
    const memory = await loadMemory();
    await memory.remember({
      session_id: sessionId,
      kind: memoryKind(e),
      text: summarizeEvent(e),
      payload: e,
    });
  } catch (err) {
    // Memory is best-effort during a run; log loud but never abort the turn.
    console.error('[orchestrator] remember failed:', (err as Error).message);
  }
}

/**
 * Build the joined memory context string for a decide() call: recall top-k, keep matches
 * above the similarity floor, join their text. Returns undefined when memory is unavailable
 * or yields nothing (decide() treats memory as optional).
 */
async function recallContext(
  query: string,
  sessionId: string,
  runId: string,
): Promise<string | undefined> {
  try {
    const memory = await loadMemory();
    const matches = await memory.recall({ query, k: RECALL_K, sessionId });
    const kept = matches.filter((m) => m.similarity > RECALL_MIN_SIMILARITY);
    // Visible Insforge beat: the pgvector recall emits no ActionEvent of its own,
    // so surface it here as a message so the memory round-trip is legible on the
    // timeline/captions (rides the existing message wiring; no frozen-union change).
    pushEvent({
      kind: 'message',
      runId,
      text:
        kept.length > 0
          ? `Insforge memory (pgvector): recalled ${kept.length} relevant ${kept.length === 1 ? 'item' : 'items'}`
          : 'Insforge memory (pgvector): no prior context yet',
      ts: Date.now(),
    });
    if (kept.length === 0) return undefined;
    return kept.map((m) => m.text).join('\n');
  } catch (err) {
    console.error('[orchestrator] recall failed:', (err as Error).message);
    return undefined;
  }
}

/** Call the brain, streaming reasoning/content deltas to the renderer as they arrive. */
async function decideStreaming(input: DecideInput): Promise<Decision> {
  const brain = await loadBrain();
  return brain.decide(input, {
    onReasoning: (delta) => pushReasoning(delta),
    onContent: (delta) => pushContent(delta),
  });
}

/** Emit a synthetic final-message event so the renderer can speak a narration string. */
function emitNarration(runId: string, text: string): void {
  pushEvent({ kind: 'message', runId, text, ts: Date.now() });
}

/**
 * Dispatch the executor for a run, streaming every ActionEvent to the renderer and memory.
 * Owns the AbortController lifecycle for `runId`. Resolves when the stream ends.
 */
async function dispatchExecutor(
  runId: string,
  sessionId: string,
  prompt: string,
  agent: AgentKind,
): Promise<void> {
  const controller = new AbortController();
  activeRuns.set(runId, controller);
  try {
    const executor = getExecutor(agent);
    for await (const ev of executor.run({
      repo: workdir(),
      prompt,
      agent,
      signal: controller.signal,
    })) {
      pushEvent(ev);
      // Native "job done" notification on terminal events — visible even when the
      // window is hidden or in floating mode.
      if (ev.kind === 'run.completed') notifyJobDone(true, ev.finalText);
      else if (ev.kind === 'run.failed') notifyJobDone(false, ev.error);
      // Fire-and-forget memory persistence so it never stalls the event stream.
      void rememberEvent(sessionId, ev);
    }
  } catch (err) {
    // The executors normally translate failures into a run.failed event, but guard the
    // for-await itself so a thrown error still produces a terminal event + runEnd.
    pushEvent({
      kind: 'run.failed',
      runId,
      ok: false,
      error: (err as Error).message,
      ts: Date.now(),
    });
    notifyJobDone(false, (err as Error).message);
  } finally {
    activeRuns.delete(runId);
    pushRunEnd(runId);
  }
}

/**
 * PRIMARY entrypoint. Runs a full voice turn for a final transcript.
 * Returns {runId} immediately-ish (after decide); the action stream arrives over push channels.
 */
export async function runTurn(input: TurnInput): Promise<{ runId: string }> {
  const { transcript, sessionId } = input;
  const runId = newRunId();

  // Recall BEFORE storing this turn's transcript so the query isn't matched
  // against itself.
  const memory = await recallContext(transcript, sessionId, runId);

  // Persist what the USER said (not just the cat's paraphrase) so facts and
  // preferences stated by the user are recallable verbatim in later turns.
  await rememberUserSaid(sessionId, transcript);

  // Visible (and truthful) Nebius beat: DeepSeek produces the decision +
  // narration that follow, so name the brain doing the planning here.
  pushEvent({
    kind: 'message',
    runId,
    text: 'DeepSeek (Nebius) is planning the task…',
    ts: Date.now(),
  });

  let decision: Decision;
  try {
    decision = await decideStreaming({ transcript, memory });
  } catch (err) {
    // Brain unavailable / failed: surface a terminal failure event so the avatar shows error.
    pushEvent({
      kind: 'run.failed',
      runId,
      ok: false,
      error: `decide failed: ${(err as Error).message}`,
      ts: Date.now(),
    });
    pushRunEnd(runId);
    return { runId };
  }

  await actOnDecision(runId, input, decision, /* screenAlreadyCaptured */ false);
  return { runId };
}

/** Dispatch logic for a Decision; capture_screen may loop back into decide() exactly once. */
async function actOnDecision(
  runId: string,
  input: TurnInput,
  decision: Decision,
  screenAlreadyCaptured: boolean,
): Promise<void> {
  const { transcript, sessionId } = input;
  const command: Command = decision.command;

  // Always persist the narration the brain produced.
  void rememberNarration(sessionId, decision.narration);

  switch (command) {
    case 'answer':
    case 'clarify': {
      // Push the narration for the renderer to speak; no executor, no run.
      emitNarration(runId, decision.narration);
      pushRunEnd(runId);
      return;
    }

    case 'capture_screen': {
      if (screenAlreadyCaptured) {
        // Guard against an infinite capture loop: if the brain asks again, fall back to
        // answering with whatever narration it gave.
        emitNarration(runId, decision.narration);
        pushRunEnd(runId);
        return;
      }
      let screen: string;
      try {
        const [vision, brain] = await Promise.all([loadVision(), loadBrain()]);
        // Inject the brain's describeScreen so vision captures, then captions via Qwen2-VL.
        screen = await vision.askScreen(transcript, (img) => brain.describeScreen(img));
      } catch (err) {
        pushEvent({
          kind: 'run.failed',
          runId,
          ok: false,
          error: `vision failed: ${(err as Error).message}`,
          ts: Date.now(),
        });
        pushRunEnd(runId);
        return;
      }
      // Loop back into decide() ONCE with the screen description, then re-dispatch.
      let next: Decision;
      try {
        const recalled = await recallContext(transcript, sessionId, runId);
        next = await decideStreaming({ transcript, memory: recalled, screen });
      } catch (err) {
        pushEvent({
          kind: 'run.failed',
          runId,
          ok: false,
          error: `decide (post-vision) failed: ${(err as Error).message}`,
          ts: Date.now(),
        });
        pushRunEnd(runId);
        return;
      }
      await actOnDecision(runId, input, next, /* screenAlreadyCaptured */ true);
      return;
    }

    case 'run_agent': {
      // Speak the narration first, then run the coding agent on args.task.
      if (decision.narration) emitNarration(runId, decision.narration);
      const task =
        typeof decision.args.task === 'string'
          ? decision.args.task
          : transcript;
      const agent: AgentKind =
        decision.args.agent === 'claude' ? 'claude' : DEFAULT_AGENT;
      await dispatchExecutor(runId, sessionId, task, agent);
      return;
    }
  }
}

async function rememberNarration(sessionId: string, text: string): Promise<void> {
  if (!text) return;
  try {
    const memory = await loadMemory();
    await memory.remember({
      session_id: sessionId,
      kind: 'narration',
      text,
    });
  } catch (err) {
    console.error('[orchestrator] remember narration failed:', (err as Error).message);
  }
}

/** Persist the user's raw transcript so their stated facts/preferences recall verbatim. */
async function rememberUserSaid(sessionId: string, transcript: string): Promise<void> {
  if (!transcript.trim()) return;
  try {
    const memory = await loadMemory();
    await memory.remember({
      session_id: sessionId,
      kind: 'observation',
      text: transcript,
    });
  } catch (err) {
    console.error('[orchestrator] remember user transcript failed:', (err as Error).message);
  }
}

/**
 * Direct executor dispatch (CH.runTask): bypass the brain. Returns {runId}; events stream
 * over the push channels. sessionId is unknown here (no turn context) so memory uses a
 * synthetic per-task session id derived from the runId.
 */
export async function runTask(prompt: string, agent: AgentKind): Promise<{ runId: string }> {
  const runId = newRunId();
  // Fire the dispatch but DON'T await it — the renderer gets {runId} now and the stream later.
  void dispatchExecutor(runId, `task_${runId}`, prompt, agent);
  return { runId };
}

/** Abort a specific run (CH.cancelTask). If runId is omitted, abort the most recent run. */
export function cancelTask(runId?: string): void {
  if (runId) {
    activeRuns.get(runId)?.abort();
    return;
  }
  // No id: abort the latest started run (Map preserves insertion order).
  const ids = [...activeRuns.keys()];
  const last = ids[ids.length - 1];
  if (last) activeRuns.get(last)?.abort();
}

/** Abort every active run (called on app quit). */
export function cancelAllRuns(): void {
  for (const c of activeRuns.values()) c.abort();
  activeRuns.clear();
}
