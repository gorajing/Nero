// src/renderer/character/framePolicy.ts — pure map of (visible, energy, busy, inCall)
// -> a frame plan the avatar applies to the Pixi ticker. The frame governor's brain.

import type { Energy } from './activity';

export type PowerState = 'occluded' | 'asleep' | 'idle' | 'active';

export interface FramePlan {
  state: PowerState;
  /** false => app.stop() (cancel rAF, true zero idle); true => app.start(). */
  running: boolean;
  /** ticker.maxFPS when running (0 = unused while stopped). */
  targetFps: number;
}

/**
 * @param busy   an agent run is in flight
 * @param inCall a live voice conversation is active
 * Either keeps the cat at full frame-rate (a call must stay responsive even when
 * the user is idle), so an idle in-call cat never throttles to the sleep rate.
 */
export function framePolicy(visible: boolean, energy: Energy, busy: boolean, inCall = false): FramePlan {
  if (!visible) return { state: 'occluded', running: false, targetFps: 0 };
  if (busy || inCall) return { state: 'active', running: true, targetFps: 60 };
  if (energy === 'asleep') return { state: 'asleep', running: true, targetFps: 6 };
  if (energy === 'drowsy') return { state: 'idle', running: true, targetFps: 12 };
  return { state: 'active', running: true, targetFps: 60 };
}
