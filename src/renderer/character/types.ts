// src/renderer/character/types.ts — the public facade the rest of the renderer
// targets. Voice and the action-event pipeline NEVER touch Pixi/Live2D directly;
// they only call CharacterDriver. This is what makes the renderer model-agnostic:
// a real Live2D model and the placeholder both implement this identical surface.

import type { AvatarState } from '../../shared/avatar';
import type { GazeTarget } from '../../shared/gaze';

export type { AvatarState };

export type ActivityCueKind =
  | 'thinking'
  | 'memory'
  | 'read'
  | 'edit'
  | 'command'
  | 'success'
  | 'error'
  | 'talking'
  | 'muted';

export interface ActivityCue {
  kind: ActivityCueKind;
  text?: string;
}

/**
 * The single avatar control surface.
 *
 * - setState(s): reflect agent activity via the 6 canonical AvatarStates
 *   (idle/listening/thinking/working/done/error). Idempotent.
 * - setMouthOpen(v): live amplitude lip-sync, 0..1, driven by Vapi volume-level
 *   while the assistant TTS speaks. Independent of setState.
 */
export interface CharacterDriver {
  setState(s: AvatarState): void;
  setActivity(cue: ActivityCue | null): void;
  setMouthOpen(v: number): void;
  /** Current state (or null before the first setState). */
  readonly state: AvatarState | null;
  /**
   * Optional: gate the "talking" body animation on/off. The 6 canonical states
   * have no 'talking' member, so assistant-speech boundaries (Vapi
   * speech-start/speech-end) toggle this instead of inventing a 7th state.
   * No-op for the placeholder beyond a visual cue.
   */
  setTalking(talking: boolean): void;
  /** Presentation-mode input gate: show whether the user's mic is muted. */
  setMuted(muted: boolean): void;
  /** Point the eyes toward a normalized cursor target; null re-centres. No-op for a real model. */
  setGaze?(target: GazeTarget | null): void;
  /** Trigger a one-shot happy "petted" reaction (ears perk, tail flick, sparkle). */
  pet?(): void;
  /** Register a real interaction (keeps the cat awake / un-throttled). */
  poke?(): void;
  /** Force full frame-rate while busy (agent working / talking). */
  setBusy?(busy: boolean): void;
  /** A live voice call is active (keeps the cat awake). */
  setInCall?(active: boolean): void;
  /** Play a pre-rendered narration clip with built-in lip-sync (model.speak). */
  speak?(audioUrl: string, onFinish?: () => void): void;
  /** Stop any speak() playback. */
  stopSpeaking?(): void;
}

/** Sink for the live captions / transcript line. */
export interface CaptionSink {
  update(role: 'user' | 'assistant', text: string, isFinal: boolean): void;
}
