// src/renderer/character/driver.ts — the CharacterDriver facade.
//
// Wraps AvatarStateMachine + AmplitudeLipSync behind the model-agnostic
// CharacterDriver surface. Voice and the action-event pipeline only ever see
// setState / setActivity / setMouthOpen / setTalking / speak. Whether a real
// Live2D model or the placeholder is mounted is invisible to them.

import { createAvatar, type Avatar } from './avatar';
import { AvatarStateMachine } from './stateMachine';
import { AmplitudeLipSync } from './lipsync';
import type { ActivityCue, CharacterDriver } from './types';
import type { AvatarState } from '../../shared/avatar';

class Live2DCharacterDriver implements CharacterDriver {
  private readonly sm: AvatarStateMachine;
  private readonly lipsync: AmplitudeLipSync;
  /** True while a pre-rendered speak() clip plays; amplitude is suppressed then. */
  private speaking = false;

  constructor(private readonly avatar: Avatar) {
    this.sm = new AvatarStateMachine(avatar);
    this.lipsync = new AmplitudeLipSync(avatar);
    // Amplitude lip-sync runs for the whole session; we only feed it 0 when the
    // assistant isn't talking, so the mouth rests closed.
    this.lipsync.start();
  }

  get state(): AvatarState | null {
    return this.sm.state;
  }

  setState(s: AvatarState): void {
    this.sm.setState(s);
  }

  setActivity(cue: ActivityCue | null): void {
    this.avatar.placeholder?.setActivity(cue);
  }

  setMouthOpen(v: number): void {
    // While a speak() clip drives the mouth itself, ignore live amplitude so the
    // two paths don't fight over ParamMouthOpenY.
    if (this.speaking) return;
    this.lipsync.setAmplitude(v);
  }

  setTalking(talking: boolean): void {
    // The 6 canonical states have no 'talking'; we keep state untouched and use
    // this only as a hook (and to rest the mouth closed when talk ends). When a
    // real model is present its talking body motion is implicit in the current
    // state; the placeholder uses this for its speech signal and mouth rest.
    this.avatar.placeholder?.setTalking(talking);
    if (!talking) this.lipsync.setAmplitude(0);
  }

  setMuted(muted: boolean): void {
    this.avatar.placeholder?.setMuted(muted);
    if (muted) this.lipsync.setAmplitude(0);
  }

  speak(audioUrl: string, onFinish?: () => void): void {
    const model = this.avatar.model;
    if (!model || typeof model.speak !== 'function') {
      // No model (placeholder): can't lip-sync a clip; just fire onFinish so
      // callers' state transitions still proceed. (Audio playback itself is the
      // Voice layer's concern via Vapi; this path is only for the model.speak
      // lip-sync integration.)
      onFinish?.();
      return;
    }
    this.speaking = true;
    void model.speak(audioUrl, {
      volume: 1.0,
      resetExpression: true,
      crossOrigin: 'anonymous',
      onFinish: () => {
        this.speaking = false;
        onFinish?.();
      },
      onError: (e: Error) => {
        this.speaking = false;
        console.error('[avatar] speak error', e);
      },
    });
  }

  stopSpeaking(): void {
    const model = this.avatar.model;
    if (model && typeof model.stopSpeaking === 'function') {
      model.stopSpeaking();
    }
    this.speaking = false;
    this.lipsync.setAmplitude(0);
  }
}

export interface Character {
  driver: CharacterDriver;
  avatar: Avatar;
  /** True when a real Live2D model is mounted (false => placeholder). */
  hasModel: boolean;
}

/**
 * Build the avatar + its CharacterDriver. Resolves even when no model file is
 * present (placeholder path) so the rest of the renderer always has a driver.
 */
export async function createCharacter(canvas: HTMLCanvasElement, modelUrl: string): Promise<Character> {
  const avatar = await createAvatar(canvas, modelUrl);
  const driver = new Live2DCharacterDriver(avatar);
  driver.setState('idle');
  return { driver, avatar, hasModel: avatar.hasModel };
}
