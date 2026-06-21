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
  document.documentElement.classList.toggle('floating-window', config.floatingWindow);
  document.body.classList.toggle('floating-window', config.floatingWindow);

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

  // Aliveness: the cat watches the cursor (gaze eased toward the pointer). Gaze
  // ONLY — cursor movement must NOT keep the cat awake; poke is reserved for real
  // interactions (pet/summon/task), which is what makes idle->sleep reachable.
  getCompanion()?.onCursor?.((target) => driver.setGaze?.(target));

  // 4: voice.
  const onToolCalls = (list: VapiToolCall[]) => {
    for (const tc of list) {
      timeline.marker(`tool-call: ${tc.name} ${JSON.stringify(tc.arguments)}`);
      // The in-process orchestrator dispatch is owned by MAIN via turnRun; here
      // we just surface the request. Hook orchestrator.dispatch here if/when a
      // client-side tool path is added.
    }
  };

  const startBtn = el<HTMLButtonElement>('start-btn');
  const stopBtn = el<HTMLButtonElement>('stop-btn');
  const muteBtn = el<HTMLButtonElement>('mute-btn');

  let callActive = false;
  let callStarting = false;
  let micMuted = false;

  const setCallActive = (active: boolean, status?: string): void => {
    callActive = active;
    driver.setInCall?.(active);
    if (status) setStatus(status);
    if (startBtn) startBtn.disabled = active || callStarting;
    if (stopBtn) stopBtn.disabled = !active;
    if (muteBtn) muteBtn.disabled = !active;
  };

  const setMicMuted = (next: boolean, status?: string): void => {
    micMuted = next;
    driver.setMuted(next);
    if (voice.isActive) voice.setMuted(next);
    if (muteBtn) muteBtn.textContent = next ? 'Unmute' : 'Mute';
    setStatus(status ?? (next ? 'Nero mic muted. Judge-talk is ignored.' : 'Nero mic live.'));
  };

  const voice = createVoice({
    config,
    character: driver,
    captions,
    sessionId,
    onToolCalls,
    onError: (e) => setStatus(`Voice error: ${describeError(e)}`),
    onCallActiveChange: (active) => {
      setCallActive(
        active,
        active
          ? micMuted
            ? 'Call active. Nero mic muted.'
            : 'Call active. Speak to Nero.'
          : 'Call ended. Click Nero to talk.',
      );
      if (active) voice.setMuted(micMuted);
    },
    isInputMuted: () => micMuted,
  });

  const startVoiceCall = async () => {
    if (callActive || callStarting) return;
    if (!config.vapiPublicKey) {
      setStatus('Set window.COMPANION_CFG.vapiPublicKey (or VITE_VAPI_PUBLIC_KEY) to start a call.');
      return;
    }
    callStarting = true;
    if (startBtn) startBtn.disabled = true;
    try {
      setStatus('Starting call…');
      await voice.startCompanionCall();
      voice.setMuted(micMuted);
      setCallActive(true, micMuted ? 'Call active. Nero mic muted.' : 'Call active. Speak to Nero.');
    } catch (e) {
      setStatus(`Could not start call: ${describeError(e)}`);
    } finally {
      callStarting = false;
      if (!callActive && startBtn) startBtn.disabled = false;
    }
  };

  startBtn?.addEventListener('click', () => {
    void startVoiceCall();
  });

  if (config.floatingWindow) {
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'Start talking to Nero');
    canvas.title = 'Click or hold to pet Nero. Drag to move. Right-click or M to mute.';
    canvas.style.cursor = 'grab';
    // The cat's body carries ONLY affection + move (interaction spec §4.1). Talk
    // is no longer a body gesture — it moves to the menu/console (Phase B/C).
    installFloatingWindowGesture(canvas, {
      onPet: () => { driver.poke?.(); driver.pet?.(); },
    });
    canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      setMicMuted(!micMuted);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key.toLowerCase() !== 'm' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      ev.preventDefault();
      setMicMuted(!micMuted);
    });
  }

  getCompanion()?.onMicToggleMute?.(() => {
    setMicMuted(!micMuted);
  });

  stopBtn?.addEventListener('click', () => {
    voice.endCall();
    setCallActive(false, 'Call ended.');
  });

  muteBtn?.addEventListener('click', () => {
    setMicMuted(!micMuted);
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
      driver.setBusy?.(true);
      if (cancelBtn) cancelBtn.disabled = false;
      setStatus('Coding agent running — click Stop to abort.');
    } else if (e.kind === 'run.completed') {
      driver.setBusy?.(false);
      if (voice.isActive) voice.narrateExact('Done. I finished that.');
    } else if (e.kind === 'run.failed') {
      driver.setBusy?.(false);
      if (voice.isActive) voice.narrateExact('I got stuck. Please check the app.');
    }
  });

  promptForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (turnInFlight) return;
    const text = promptInput?.value.trim() ?? '';
    if (!text) return;

    const companion = getCompanion();
    if (!companion?.turnRun) {
      setStatus('Nero bridge unavailable (window.companion.turnRun missing).');
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
    setActivity: (cue: Parameters<typeof driver.setActivity>[0]) => driver.setActivity(cue),
    setMouthOpen: (v: number) => driver.setMouthOpen(v),
    setMuted: (v: boolean) => setMicMuted(v),
  };
}

interface FloatingGestureHandlers {
  /** Affection — fired instantly on press, then repeated while held still. */
  onPet: () => void;
}

// The cat's body carries exactly two verbs (interaction spec §4.1): TAP/HOLD = pet
// (instant, then sustained), DRAG (past threshold) = move. No timer arbitrates
// between meanings, so nothing is ambiguous and a press can never start a call.
function installFloatingWindowGesture(
  canvas: HTMLCanvasElement,
  handlers: FloatingGestureHandlers,
): void {
  const dragThresholdPx = 6;
  const sustainedPetMs = 450; // keep petting while the press is held still
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let petTimer: ReturnType<typeof setInterval> | null = null;

  function stopPet(): void {
    if (petTimer !== null) {
      clearInterval(petTimer);
      petTimer = null;
    }
  }
  function resetGesture(): void {
    pointerId = null;
    dragging = false;
    stopPet();
    canvas.classList.remove('dragging');
    canvas.style.cursor = 'grab';
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return; // left button only; right-click = mute/menu
    pointerId = ev.pointerId;
    startX = lastX = ev.screenX;
    startY = lastY = ev.screenY;
    dragging = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
    // Pet immediately (instant feedback, Law 1), then keep petting while held still
    // (sustained affection). A drag cancels the sustained pet (it's a move, not a pet).
    handlers.onPet();
    petTimer = setInterval(() => {
      if (!dragging) handlers.onPet();
    }, sustainedPetMs);
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (pointerId !== ev.pointerId) return;
    const totalDx = ev.screenX - startX;
    const totalDy = ev.screenY - startY;
    if (!dragging && Math.hypot(totalDx, totalDy) >= dragThresholdPx) {
      dragging = true;
      stopPet(); // a drag is a move, not petting
      canvas.classList.add('dragging');
    }
    if (!dragging) return;
    const dx = ev.screenX - lastX;
    const dy = ev.screenY - lastY;
    lastX = ev.screenX;
    lastY = ev.screenY;
    const companion = getCompanion();
    if (companion?.moveWindowBy) {
      void companion.moveWindowBy({ dx, dy });
    }
    ev.preventDefault();
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (pointerId !== ev.pointerId) return;
    if (canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    resetGesture();
    ev.preventDefault();
  });

  canvas.addEventListener('pointercancel', (ev) => {
    if (pointerId !== ev.pointerId) return;
    resetGesture();
  });
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
