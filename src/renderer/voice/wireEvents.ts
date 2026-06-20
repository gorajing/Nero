// src/renderer/voice/wireEvents.ts — subscribe to Vapi lifecycle/speech/volume/
// message/error events and translate them into CharacterDriver + captions calls.
//
// Wired EXACTLY ONCE per Vapi singleton (the SDK is an EventEmitter; re-.on()
// stacks duplicate handlers -> the mouth driver / transcripts fire N times).
//
// State mapping (within the 6 canonical AvatarStates — there is no 'talking'
// AvatarState, so assistant-speech boundaries toggle CharacterDriver.setTalking
// and keep the avatar in 'listening'):
//   call-start        -> setState('listening')
//   call-end          -> setState('idle')
//   speech-start      -> setTalking(true)   (assistant TTS begins)
//   speech-end        -> setTalking(false) + setState('listening')
//   volume-level      -> setMouthOpen(v)    (live lip-sync while assistant talks)
//   message[transcript]-> captions.update; user partial -> setState('listening')
//   message[final,user]-> window.companion.turnRun({transcript, sessionId})
//   message[tool-calls]-> onToolCalls (orchestrator hook)
//   error             -> setState('error') only when no executor run is active

import type Vapi from '@vapi-ai/web';
import type { CharacterDriver, CaptionSink } from '../character/types';
import { type VapiMessage, isTranscript, isToolCalls, type VapiToolCall } from './messages';
import { getCompanion } from '../events/bridge';
import { runState } from '../events/runState';

export interface WireOptions {
  character: CharacterDriver;
  captions: CaptionSink;
  sessionId: string;
  /** Optional handler for client-side tool-calls (orchestrator dispatch). */
  onToolCalls?: (list: VapiToolCall[]) => void;
  /** Optional surface for fatal voice errors (e.g. show a banner). */
  onError?: (e: unknown) => void;
  /** Keep the UI's call gate in sync with Vapi/Daily ending the call externally. */
  onCallActiveChange?: (active: boolean) => void;
  /** Hard gate final user transcripts during demo/presentation mute. */
  isInputMuted?: () => boolean;
}

export function wireVapiEvents(vapi: Vapi, opts: WireOptions): void {
  const {
    character,
    captions,
    sessionId,
    onToolCalls,
    onError,
    onCallActiveChange,
    isInputMuted,
  } = opts;
  let turnInFlight = false;

  vapi.on('call-start', () => {
    onCallActiveChange?.(true);
    character.setState('listening');
  });
  vapi.on('call-end', () => {
    onCallActiveChange?.(false);
    turnInFlight = false;
    character.setTalking(false);
    character.setState('idle');
  });

  // speech-start/speech-end track the ASSISTANT's audio in this SDK.
  vapi.on('speech-start', () => character.setTalking(true));
  vapi.on('speech-end', () => {
    character.setTalking(false);
    character.setState('listening');
  });

  // 0..1 amplitude, ~per audio frame while the assistant talks.
  vapi.on('volume-level', (v: number) => character.setMouthOpen(v));

  vapi.on('message', (raw: unknown) => {
    const m = raw as VapiMessage;
    if (isTranscript(m)) {
      const isFinal = m.transcriptType === 'final';
      captions.update(m.role, m.transcript, isFinal);
      // Detect the USER talking off transcript partials (not speech-start).
      if (m.role === 'user' && !isFinal) character.setState('listening');
      // Hand the final user transcript to the orchestrator (the primary handoff).
      if (m.role === 'user' && isFinal && m.transcript.trim()) {
        if (isInputMuted?.()) return;
        const companion = getCompanion();
        if (!companion?.turnRun || turnInFlight) return;
        turnInFlight = true;
        companion
          .turnRun({ transcript: m.transcript, sessionId })
          .catch((err) => console.error('[voice] turnRun failed', err))
          .finally(() => {
            turnInFlight = false;
          });
      }
      return;
    }
    if (isToolCalls(m)) {
      onToolCalls?.(m.toolCallList);
      return;
    }
    // conversation-update / model-output / status-update: ignored here.
  });

  vapi.on('error', (e: unknown) => {
    console.error('[vapi] error', describeVapiError(e));
    // Don't let a voice/Daily error (e.g. "Meeting has ended") clobber the avatar
    // while an executor run is in flight — the coding run owns the avatar state.
    // The error is still surfaced via onError (the status banner).
    if (!runState.active) character.setState('error');
    onError?.(e);
  });
}

/** Vapi/Daily errors are plain objects that log as "[object Object]"; surface their real content. */
function describeVapiError(e: unknown): string {
  if (e == null) return String(e);
  if (typeof e === 'string') return e;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try {
    const o = e as Record<string, unknown>;
    const fields = [o.errorMsg, o.message, o.type, o.action, o.error]
      .filter((v) => v != null)
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    const full = JSON.stringify(e, Object.getOwnPropertyNames(e as object));
    return (fields.length ? fields.join(' | ') + ' ' : '') + full;
  } catch {
    return Object.prototype.toString.call(e);
  }
}
