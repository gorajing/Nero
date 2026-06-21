import { describe, it, expect } from 'vitest';
import { framePolicy } from './framePolicy';

describe('framePolicy', () => {
  it('stops the loop entirely when occluded', () => {
    expect(framePolicy(false, 'awake', false)).toEqual({ state: 'occluded', running: false, targetFps: 0 });
  });

  it('runs full-rate when visible and busy, regardless of energy', () => {
    expect(framePolicy(true, 'asleep', true)).toEqual({ state: 'active', running: true, targetFps: 60 });
  });

  it('throttles down by energy when visible and not busy', () => {
    expect(framePolicy(true, 'awake', false)).toEqual({ state: 'active', running: true, targetFps: 60 });
    expect(framePolicy(true, 'drowsy', false)).toEqual({ state: 'idle', running: true, targetFps: 12 });
    expect(framePolicy(true, 'asleep', false)).toEqual({ state: 'asleep', running: true, targetFps: 6 });
  });

  it('keeps full-rate during an active call even when idle (inCall)', () => {
    expect(framePolicy(true, 'asleep', false, true)).toEqual({ state: 'active', running: true, targetFps: 60 });
    expect(framePolicy(true, 'drowsy', false, true)).toEqual({ state: 'active', running: true, targetFps: 60 });
  });

  it('still stops when occluded even if in a call', () => {
    expect(framePolicy(false, 'awake', false, true)).toEqual({ state: 'occluded', running: false, targetFps: 0 });
  });
});
