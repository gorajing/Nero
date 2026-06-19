// src/renderer/bootstrap.ts — wires the whole renderer together.
//
// Order:
//   1. load config (public Vapi key, proxy URL, model path)
//   2. build the character (real Live2D model OR placeholder) on #live2d-canvas
//   3. subscribe to the executor ActionEvent stream + brain reasoning
//   4. construct the Voice controller; bind the Start/Stop/Mute buttons
//
// The Vapi call is started behind a user gesture (Start button): getUserMedia +
// WebRTC + model.speak() all need a user-gesture-unlocked AudioContext.

import { loadConfig } from './config';
import { sessionId } from './session';
import { createCharacter } from './character/driver';
import { CaptionPanel, ActionTimeline } from './character/captions';
import { subscribeActionEvents } from './events/actionEvents';
import { getCompanion } from './events/bridge';
import { createVoice } from './voice';
import type { VapiToolCall } from './voice/messages';

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(text: string): void {
  const s = el('status');
  if (s) s.textContent = text;
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const canvas = el<HTMLCanvasElement>('live2d-canvas');
  if (!canvas) {
    console.error('[bootstrap] #live2d-canvas not found');
    return;
  }

  // 1 + 2: character (resolves even with no model — placeholder path).
  const { driver, hasModel } = await createCharacter(canvas, config.modelUrl);
  setStatus(hasModel ? 'Model loaded.' : 'No Live2D model — placeholder mode. See public/live2d/README.');

  // 3: captions + timeline + executor/brain subscriptions.
  const captions = new CaptionPanel();
  const timeline = new ActionTimeline();
  subscribeActionEvents({ character: driver, timeline, captions });

  // 4: voice.
  const onToolCalls = (list: VapiToolCall[]) => {
    for (const tc of list) {
      timeline.marker(`tool-call: ${tc.name} ${JSON.stringify(tc.arguments)}`);
      // The in-process orchestrator dispatch is owned by MAIN via turnRun; here
      // we just surface the request. Hook orchestrator.dispatch here if/when a
      // client-side tool path is added.
    }
  };

  const voice = createVoice({
    config,
    character: driver,
    captions,
    sessionId,
    onToolCalls,
    onError: (e) => setStatus(`Voice error: ${describeError(e)}`),
  });

  const startBtn = el<HTMLButtonElement>('start-btn');
  const stopBtn = el<HTMLButtonElement>('stop-btn');
  const muteBtn = el<HTMLButtonElement>('mute-btn');

  startBtn?.addEventListener('click', async () => {
    if (!config.vapiPublicKey) {
      setStatus('Set window.COMPANION_CFG.vapiPublicKey (or VITE_VAPI_PUBLIC_KEY) to start a call.');
      return;
    }
    try {
      setStatus('Starting call…');
      await voice.startCompanionCall();
      setStatus('Call active. Speak to Companion.');
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (muteBtn) muteBtn.disabled = false;
    } catch (e) {
      setStatus(`Could not start call: ${describeError(e)}`);
    }
  });

  stopBtn?.addEventListener('click', () => {
    voice.endCall();
    setStatus('Call ended.');
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (muteBtn) muteBtn.disabled = true;
  });

  muteBtn?.addEventListener('click', () => {
    const next = !voice.isMuted();
    voice.setMuted(next);
    if (muteBtn) muteBtn.textContent = next ? 'Unmute' : 'Mute';
  });

  // Text-input path: feed a typed task straight to MAIN's orchestrator
  // (turnRun -> recall[Insforge] -> decide[Nebius] -> executor[Codex]). No mic,
  // no Vapi call. ActionEvents stream back over the same subscribeActionEvents
  // wiring that drives the avatar, captions, and timeline.
  const promptForm = el<HTMLFormElement>('prompt-form');
  const promptInput = el<HTMLInputElement>('prompt-input');
  const sendBtn = el<HTMLButtonElement>('send-btn');
  const cancelBtn = el<HTMLButtonElement>('cancel-btn');

  // One turn at a time. A disabled submit button does NOT block the Enter key,
  // so re-entry is gated here — concurrent turns would scramble the shared
  // reasoning caption + button state.
  let turnInFlight = false;
  let cancelRequested = false;

  // Arm Stop ONLY once the coding agent actually starts: cancelTask can abort a
  // run only after the executor registers it. The pre-executor phase (Nebius
  // decide / vision) is bounded by the brain's own 60s timeout, so there's
  // nothing to abort there — enabling Stop then would be a lie.
  getCompanion()?.onActionEvent((e) => {
    if (e.kind === 'run.started') {
      if (cancelBtn) cancelBtn.disabled = false;
      setStatus('Coding agent running — click Stop to abort.');
    }
  });

  promptForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (turnInFlight) return;
    const text = promptInput?.value.trim() ?? '';
    if (!text) return;

    const companion = getCompanion();
    if (!companion?.turnRun) {
      setStatus('Orchestrator unavailable (window.companion.turnRun missing).');
      return;
    }

    // Keep the typed task on screen for the whole run (cleared in finally).
    turnInFlight = true;
    cancelRequested = false;
    if (sendBtn) sendBtn.disabled = true;
    captions.update('user', text, true);
    driver.setState('thinking');
    setStatus('Thinking… (Nebius brain)');

    try {
      // turnRun resolves once the whole turn (incl. the agent run) ends; live
      // feedback arrives meanwhile over the ActionEvent stream + reasoning caption.
      await companion.turnRun({ transcript: text, sessionId });
      setStatus(cancelRequested ? 'Stopped.' : 'Done — type another task.');
    } catch (e) {
      driver.setState('error');
      setStatus(`Turn failed: ${describeError(e)}`);
    } finally {
      turnInFlight = false;
      if (sendBtn) sendBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
      if (promptInput) promptInput.value = '';
    }
  });

  cancelBtn?.addEventListener('click', async () => {
    const companion = getCompanion();
    if (!companion?.cancelTask) return;
    cancelRequested = true;
    setStatus('Stopping the agent…');
    try {
      await companion.cancelTask(); // no id => orchestrator aborts the latest (executor) run
    } catch (e) {
      setStatus(`Stop failed: ${describeError(e)}`);
    }
  });

  // Expose a tiny dev handle for manual testing in DevTools (drive the avatar
  // without a model/keys). Non-enumerable-ish; purely a debugging aid.
  (window as unknown as { __companion?: unknown }).__companion = {
    driver,
    voice,
    setState: (s: Parameters<typeof driver.setState>[0]) => driver.setState(s),
    setMouthOpen: (v: number) => driver.setMouthOpen(v),
  };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
