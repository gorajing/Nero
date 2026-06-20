// src/renderer/voice/index.ts — the Voice facade the rest of the renderer uses.
//
// startCompanionCall() constructs the Vapi singleton (if needed), wires events
// ONCE, and starts the call with the inline custom-llm assistant. Narration
// helpers (narrateExact / narrateViaLLM) and teardown (endCall) round it out.

import type { CompanionConfig } from '../config';
import type { CharacterDriver, CaptionSink } from '../character/types';
import { getVapi, peekVapi, resetVapi, buildAssistant } from './vapiClient';
import { wireVapiEvents } from './wireEvents';
import type { VapiToolCall } from './messages';

let wired = false;
let callActive = false;

export interface VoiceController {
  startCompanionCall(): Promise<void>;
  endCall(): void;
  setMuted(m: boolean): void;
  isMuted(): boolean;
  /** Deterministic TTS of an exact string (wraps vapi.say). */
  narrateExact(text: string): void;
  /** Inject a system add-message so the brain narrates in-character. */
  narrateViaLLM(eventText: string): void;
  /** Return a client tool-call result so the assistant can speak the outcome. */
  returnToolResult(toolCallId: string, result: unknown): void;
  readonly isActive: boolean;
}

export interface CreateVoiceOptions {
  config: CompanionConfig;
  character: CharacterDriver;
  captions: CaptionSink;
  sessionId: string;
  onToolCalls?: (list: VapiToolCall[]) => void;
  onError?: (e: unknown) => void;
  onCallActiveChange?: (active: boolean) => void;
  isInputMuted?: () => boolean;
}

export function createVoice(opts: CreateVoiceOptions): VoiceController {
  const { config, character, captions, sessionId, onToolCalls, onError } = opts;
  resetVapi();
  wired = false;
  callActive = false;

  return {
    get isActive() {
      return callActive;
    },

    async startCompanionCall() {
      if (callActive) return;
      // Throws if the public key is missing — surfaced to the caller/UI.
      const vapi = getVapi(config.vapiPublicKey);
      if (!wired) {
        wireVapiEvents(vapi, {
          character,
          captions,
          sessionId,
          onToolCalls,
          onError,
          onCallActiveChange: (active) => {
            callActive = active;
            opts.onCallActiveChange?.(active);
          },
          isInputMuted: opts.isInputMuted,
        });
        wired = true;
      }
      if (config.vapiAssistantId) {
        // Server-side path: start with the existing hosted Nero assistant id.
        // No local custom-llm proxy needed yet; the brain swaps to Nebius server-side
        // later (by repointing this assistant's model), not in the renderer.
        // @vapi-ai/web's start() accepts an assistant-id string as its first arg.
        await vapi.start(config.vapiAssistantId);
      } else {
        // Fallback: inline custom-llm assistant (needs a running proxy at customLlmUrl).
        // CreateAssistantDTO is a large generated union; cast at this boundary only.
        await vapi.start(buildAssistant(config) as never);
      }
      callActive = true;
      opts.onCallActiveChange?.(true);
    },

    endCall() {
      const vapi = peekVapi();
      if (vapi) void vapi.stop();
      callActive = false;
      opts.onCallActiveChange?.(false);
      character.setTalking(false);
      character.setState('idle');
    },

    setMuted(m: boolean) {
      peekVapi()?.setMuted(m);
    },

    isMuted() {
      return peekVapi()?.isMuted() ?? false;
    },

    narrateExact(text: string) {
      peekVapi()?.say(text, false, true);
    },

    narrateViaLLM(eventText: string) {
      peekVapi()?.send({
        type: 'add-message',
        message: { role: 'system', content: eventText },
        triggerResponseEnabled: true,
      });
    },

    returnToolResult(toolCallId: string, result: unknown) {
      peekVapi()?.send({
        type: 'add-message',
        message: {
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCallId,
        },
        triggerResponseEnabled: true,
      });
    },
  };
}
