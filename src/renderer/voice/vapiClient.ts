// src/renderer/voice/vapiClient.ts — the Vapi singleton + inline assistant config.
//
// Renderer-only (@vapi-ai/web needs getUserMedia + WebRTC). Constructed lazily so
// importing this module never throws when the public key is absent; the call is
// only attempted from startCompanionCall(). We keep ONE module-level instance so
// listeners are wired exactly once (the SDK is an EventEmitter — re-.on() leaks).

import Vapi from '@vapi-ai/web';
import type { CompanionConfig } from '../config';

let instance: Vapi | null = null;

/** Returns the singleton, constructing it on first use. Throws if key is empty. */
export function getVapi(publicKey: string): Vapi {
  if (instance) return instance;
  if (!publicKey) {
    throw new Error('Vapi public key missing (window.COMPANION_CFG.vapiPublicKey / VITE_VAPI_PUBLIC_KEY).');
  }
  instance = new Vapi(publicKey);
  return instance;
}

/** Already-constructed singleton, or null if startCompanionCall was never called. */
export function peekVapi(): Vapi | null {
  return instance;
}

/**
 * Dev/demo reload safety: Vite can reload the renderer while a Vapi singleton is
 * still alive in module state. Drop it so a fresh bootstrap cannot inherit stale
 * listeners or a stale active-call flag.
 */
export function resetVapi(): void {
  if (!instance) return;
  try {
    void instance.stop();
  } catch (err) {
    console.error('[vapi] reset stop failed', err);
  } finally {
    instance = null;
  }
}

/**
 * Build the inline custom-llm assistant. We type it as `unknown`-cast at the
 * start() boundary: Vapi's CreateAssistantDTO is a large generated discriminated
 * union and coupling to it would make this component brittle. The shape below is
 * the documented inline-assistant contract.
 */
export function buildAssistant(cfg: CompanionConfig): Record<string, unknown> {
  return {
    transcriber: { provider: 'deepgram', model: cfg.transcriberModel, language: 'en' },
    voice: { provider: '11labs', voiceId: cfg.voiceId },
    model: {
      provider: 'custom-llm',
      // ngrok ROOT — Vapi APPENDS /chat/completions. MAIN PATCHes the live URL
      // onto the assistant each launch, but the inline assistant still needs one.
      url: cfg.customLlmUrl,
      model: cfg.customLlmModel,
      metadataSendMode: 'variable',
      temperature: 0.6,
      messages: [
        {
          role: 'system',
          content:
            'You are Nero, a friendly pixel-cat coding-agent narrator. ' +
            'Speak naturally and concisely; the orchestrator handles the actual coding.',
        },
      ],
    },
    // Which message types Vapi pushes to THIS web client over the data channel.
    clientMessages: ['transcript', 'tool-calls', 'conversation-update', 'model-output', 'status-update'],
    firstMessage: 'Hey, I am Nero. What should we build?',
  };
}
