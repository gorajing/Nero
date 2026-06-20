# Aliveness Part 2 — Presence (petting, frame governor, sleep/wake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cat feel present — it can be *petted* (instant, repeatable), it *throttles itself* when idle/hidden (battery), and it *sleeps and wakes* with your activity.

**Architecture:** One shared, pure `Activity` signal (time since the last real interaction → an `Energy` of awake/drowsy/asleep) is the foundation. A pure `framePolicy()` maps `(visible, energy, busy)` → a target frame-rate + run/stop decision; the avatar applies it to the Pixi ticker (the frame governor). The same `Energy` drives sleep/wake poses. Petting rebinds the floating-window gesture: tap → pet, hold-still → push-to-talk, drag → move. Everything is additive over the merged cursor-gaze increment.

**Tech Stack:** Electron 42, PixiJS v7, TypeScript ~5.6, Vitest (already set up in Part 1).

## Global Constraints

- **Reference increment:** cursor-gaze (merged) established the pattern — pure logic module + `*.test.ts`, thin renderer consumer, typed IPC. Follow it.
- **Determinism / testability:** pure modules take `now: number` as a parameter — **no `Date.now()` / `Math.random()` inside them** (matches the existing `gaze.ts` discipline and keeps them unit-testable).
- **Four-color cat, no new state:** new poses reuse `px()` on the existing grid and the `CAT`/`EFFECT` palettes; do **not** add a 7th `AvatarState` (sleep/pet are layered on, like gaze was).
- **Near-zero idle is the point of Task 3:** the governor must take the idle cat to a low frame-rate and `app.stop()` it when occluded. Treat it as a real acceptance check.
- **Interaction model (decided):** tap = pet · hold-still = push-to-talk · drag = move · right-click/`M` = mute. Talking is no longer a plain single-click.
- **Preload sandbox rule** and **pure-shared rule** from Part 1 still hold.

---

### Task 1: Shared `Activity` + `framePolicy` (pure, TDD)

**Files:**
- Create: `src/renderer/character/activity.ts`
- Create: `src/renderer/character/activity.test.ts`
- Create: `src/renderer/character/framePolicy.ts`
- Create: `src/renderer/character/framePolicy.test.ts`

**Interfaces:**
- Produces: `type Energy = 'awake' | 'drowsy' | 'asleep'` and `class Activity { constructor(now: number, thresholds?); poke(now): void; idleMs(now): number; energy(now): Energy }` (activity.ts).
- Produces: `type PowerState`; `interface FramePlan { state: PowerState; running: boolean; targetFps: number }`; `function framePolicy(visible: boolean, energy: Energy, busy: boolean): FramePlan` (framePolicy.ts).

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/character/activity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Activity } from './activity';

describe('Activity', () => {
  const T = { drowsyMs: 1000, asleepMs: 3000 };

  it('starts awake at construction time', () => {
    expect(new Activity(0, T).energy(0)).toBe('awake');
  });

  it('goes drowsy then asleep as idle time crosses the thresholds', () => {
    const a = new Activity(0, T);
    expect(a.energy(999)).toBe('awake');
    expect(a.energy(1000)).toBe('drowsy');
    expect(a.energy(2999)).toBe('drowsy');
    expect(a.energy(3000)).toBe('asleep');
  });

  it('poke() resets idle so the cat wakes', () => {
    const a = new Activity(0, T);
    expect(a.energy(3000)).toBe('asleep');
    a.poke(3000);
    expect(a.energy(3000)).toBe('awake');
    expect(a.idleMs(3500)).toBe(500);
  });
});
```

Create `src/renderer/character/framePolicy.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — "Failed to load url ./activity" / "./framePolicy".

- [ ] **Step 3: Implement the two pure modules**

Create `src/renderer/character/activity.ts`:
```ts
// src/renderer/character/activity.ts — time-since-last-interaction -> energy.
// Pure & deterministic: `now` is always passed in (no Date.now()), so it unit-tests.

export type Energy = 'awake' | 'drowsy' | 'asleep';

export interface ActivityThresholds {
  /** idle ms after which the cat is drowsy */
  drowsyMs: number;
  /** idle ms after which the cat is asleep */
  asleepMs: number;
}

const DEFAULTS: ActivityThresholds = { drowsyMs: 45_000, asleepMs: 120_000 };

export class Activity {
  private lastPokeMs: number;

  constructor(now: number, private readonly thresholds: ActivityThresholds = DEFAULTS) {
    this.lastPokeMs = now;
  }

  /** Register a real interaction (cursor move, click, pet, summon). */
  poke(now: number): void {
    this.lastPokeMs = now;
  }

  idleMs(now: number): number {
    return Math.max(0, now - this.lastPokeMs);
  }

  energy(now: number): Energy {
    const idle = this.idleMs(now);
    if (idle >= this.thresholds.asleepMs) return 'asleep';
    if (idle >= this.thresholds.drowsyMs) return 'drowsy';
    return 'awake';
  }
}
```

Create `src/renderer/character/framePolicy.ts`:
```ts
// src/renderer/character/framePolicy.ts — pure map of (visible, energy, busy) -> a
// frame plan the avatar applies to the Pixi ticker. This is the frame governor's brain.

import type { Energy } from './activity';

export type PowerState = 'occluded' | 'asleep' | 'idle' | 'active';

export interface FramePlan {
  state: PowerState;
  /** false => app.stop() (cancel rAF, true zero idle); true => app.start(). */
  running: boolean;
  /** ticker.maxFPS when running (0 = unused while stopped). */
  targetFps: number;
}

export function framePolicy(visible: boolean, energy: Energy, busy: boolean): FramePlan {
  if (!visible) return { state: 'occluded', running: false, targetFps: 0 };
  if (busy) return { state: 'active', running: true, targetFps: 60 };
  if (energy === 'asleep') return { state: 'asleep', running: true, targetFps: 6 };
  if (energy === 'drowsy') return { state: 'idle', running: true, targetFps: 12 };
  return { state: 'active', running: true, targetFps: 60 };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — the 2 new files add 6 tests (15 total with Part 1).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/character/activity.ts src/renderer/character/activity.test.ts src/renderer/character/framePolicy.ts src/renderer/character/framePolicy.test.ts
git commit -m "feat(aliveness): activity/energy signal + frame policy (pure, tested)"
```

---

### Task 2: Petting (tap = pet, hold = push-to-talk)

**Files:**
- Modify: `src/renderer/character/types.ts` (add `pet()` to `CharacterDriver`)
- Modify: `src/renderer/character/driver.ts` (implement `pet()`)
- Modify: `src/renderer/character/avatar.ts` (a timed "pet" happy reaction in the placeholder)
- Modify: `src/renderer/bootstrap.ts` (rebind the gesture: tap→pet, hold→talk, drag→move)

**Interfaces:**
- Consumes: nothing new from Task 1 (petting is gesture + reaction).
- Produces: `CharacterDriver.pet(): void`; `Placeholder.pet(): void`; a rebound `installFloatingWindowGesture(canvas, { onPet, onTalkStart, onTalkEnd })`.

- [ ] **Step 1: Add `pet()` to the facade**

In `src/renderer/character/types.ts`, add to `CharacterDriver` (after `setGaze`):
```ts
  /** Trigger a one-shot happy "petted" reaction (ears perk, tail flick, sparkle). */
  pet?(): void;
```

In `src/renderer/character/driver.ts`, add to `Live2DCharacterDriver` (after `setGaze`):
```ts
  pet(): void {
    this.avatar.placeholder?.pet();
  }
```

- [ ] **Step 2: Add the pet reaction to the placeholder**

In `src/renderer/character/avatar.ts`:

(a) Add to the `Placeholder` interface (after `setGaze`):
```ts
  /** One-shot happy "petted" reaction. */
  pet(): void;
```

(b) In `buildPlaceholder`, near the other `let` vars, add:
```ts
  let petUntil = 0;
```

(c) Add an effect color for the pet sparkle to the `EFFECT` palette object:
```ts
    petHeart: 0xff6f91,
```

(d) Add a draw helper for the pet burst (place it next to `redrawAura`), and call it from the ticker. Add this function inside `buildPlaceholder`:
```ts
  const drawPetBurst = (tick = 0) => {
    foreground.clear();
    if (performance.now() >= petUntil) return;
    // little hearts/sparkles above the head while the reaction lasts
    const blink = Math.floor(tick / 8) % 2;
    px(foreground, 8, 0, 1, 1, EFFECT.petHeart);
    if (blink) px(foreground, 11, 1, 1, 1, EFFECT.successGold);
    px(foreground, 12, -1, 1, 1, EFFECT.petHeart);
  };
```
> NOTE: `redrawSignal()` also clears `foreground`. To avoid the two fighting, call `drawPetBurst(tick)` in the ticker AFTER `redrawSignal(tick)` and have it early-return (clearing then redrawing nothing) when not petting — which the code above does.

(e) In the ticker callback, while petting, perk the ears and flick the tail by forcing the perked look. Simplest: set a transient flag the existing draws already honor. Reuse `talking`-style perk: in the ticker, just call the new burst after the existing draws:
```ts
    redrawSignal(tick);
    drawPetBurst(tick);
    drawActivityProp(tick);
```
(Replace the existing `redrawSignal(tick);` + `drawActivityProp(tick);` pair at the end of the ticker with the three lines above.)

(f) Add `pet` to the returned object (after `setGaze`):
```ts
    pet: () => {
      petUntil = performance.now() + 900;
    },
```

- [ ] **Step 3: Rebind the floating-window gesture**

In `src/renderer/bootstrap.ts`, change `installFloatingWindowGesture` to take callbacks and implement tap/hold/drag. Replace the existing `installFloatingWindowGesture(canvas, startVoiceCall);` call site (in the `if (config.floatingWindow)` block) with:
```ts
    installFloatingWindowGesture(canvas, {
      onPet: () => driver.pet?.(),
      onTalkStart: () => { void startVoiceCall(); },
      onTalkEnd: () => { voice.endCall(); setCallActive(false); },
    });
```
And replace the whole `installFloatingWindowGesture` function with this signature + logic:
```ts
interface FloatingGestureHandlers {
  onPet: () => void;
  onTalkStart: () => void;
  onTalkEnd: () => void;
}

function installFloatingWindowGesture(
  canvas: HTMLCanvasElement,
  handlers: FloatingGestureHandlers,
): void {
  const dragThresholdPx = 4;
  const holdToTalkMs = 350; // hold still this long => push-to-talk
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let talking = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHold(): void {
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  }
  function resetGesture(): void {
    pointerId = null;
    dragging = false;
    clearHold();
    canvas.classList.remove('dragging');
    canvas.style.cursor = 'grab';
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    pointerId = ev.pointerId;
    startX = lastX = ev.screenX;
    startY = lastY = ev.screenY;
    dragging = false;
    talking = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
    // Hold still long enough with no drag => push-to-talk.
    holdTimer = setTimeout(() => { talking = true; handlers.onTalkStart(); }, holdToTalkMs);
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (pointerId !== ev.pointerId) return;
    const totalDx = ev.screenX - startX;
    const totalDy = ev.screenY - startY;
    if (!dragging && !talking && Math.hypot(totalDx, totalDy) >= dragThresholdPx) {
      dragging = true;
      clearHold(); // a drag is not a hold-to-talk
      canvas.classList.add('dragging');
    }
    if (!dragging) return;
    const dx = ev.screenX - lastX;
    const dy = ev.screenY - lastY;
    lastX = ev.screenX;
    lastY = ev.screenY;
    const companion = getCompanion();
    if (companion?.moveWindowBy) void companion.moveWindowBy({ dx, dy });
    ev.preventDefault();
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (pointerId !== ev.pointerId) return;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    clearHold();
    if (talking) {
      handlers.onTalkEnd();              // release ends push-to-talk
    } else if (!dragging) {
      handlers.onPet();                  // a quick tap (no drag, no hold) = pet
    }
    resetGesture();
    ev.preventDefault();
  });

  canvas.addEventListener('pointercancel', (ev) => {
    if (pointerId !== ev.pointerId) return;
    if (talking) handlers.onTalkEnd();
    resetGesture();
  });
}
```
Also update the floating-mode tooltip text near the top of the `if (config.floatingWindow)` block:
```ts
    canvas.title = 'Click to pet Nero. Hold to talk. Drag to move. Right-click or M to mute.';
```

- [ ] **Step 4: Verify type-check, lint, tests**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test`
Expected: 0 type errors, no new lint problems, all tests pass.

- [ ] **Step 5: Verify in the app (manual — GUI)**

Run: `COMPANION_FLOATING_WINDOW=1 npm start`
Expected: **single-click the cat** → instant happy burst (little hearts/sparkle above its head); click repeatedly → it keeps reacting, never starts a call. **Hold the cat ~⅓s** → a voice call starts; **release** → it ends. **Drag** → it moves. No call ever starts from a quick tap.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/character/types.ts src/renderer/character/driver.ts src/renderer/character/avatar.ts src/renderer/bootstrap.ts
git commit -m "feat(aliveness): tap to pet, hold to talk (push-to-talk), drag to move"
```

---

### Task 3: Frame governor (idle-battery)

**Files:**
- Modify: `src/renderer/character/avatar.ts` (own an `Activity`, apply `framePolicy` to the ticker, a `visibilitychange` listener, `poke()` + `setBusy()`)
- Modify: `src/renderer/character/types.ts` + `driver.ts` (expose `poke()` / `setBusy()`)
- Modify: `src/renderer/bootstrap.ts` (poke on cursor/pet/talk; set busy from run state)
- Modify: `src/main/window.ts` (stop the cursor poll when the window is hidden)

**Interfaces:**
- Consumes: `Activity`, `framePolicy` (Task 1).
- Produces: `CharacterDriver.poke()` and `CharacterDriver.setBusy(busy: boolean)`; the avatar self-governs its ticker.

- [ ] **Step 1: Govern the ticker in the avatar**

In `src/renderer/character/avatar.ts`:

(a) Add imports:
```ts
import { Activity, type Energy } from './activity';
import { framePolicy } from './framePolicy';
```

(b) In `buildPlaceholder`, add state near the other `let`s:
```ts
  const activity = new Activity(performance.now());
  let busy = false;
  let energy: Energy = 'awake';
  let docVisible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
```

(c) Add a `visibilitychange` listener after the existing `window.addEventListener('resize', fit);`:
```ts
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      docVisible = document.visibilityState !== 'hidden';
      // Re-start the loop on un-occlude; the in-ticker policy stops it on occlude.
      if (docVisible && !app.ticker.started) app.ticker.start();
    });
  }
```

(d) At the **top** of the ticker callback, apply the policy:
```ts
    const nowMs = performance.now();
    energy = activity.energy(nowMs);
    const plan = framePolicy(docVisible, energy, busy);
    app.ticker.maxFPS = plan.targetFps;
    if (!plan.running) { app.ticker.stop(); return; }
```
> `app.ticker.stop()` cancels the rAF; the `visibilitychange` handler restarts it. While running, `maxFPS` throttles to the planned rate.

(e) Add `poke` and `setBusy` to the returned object (after `pet`):
```ts
    poke: () => { activity.poke(performance.now()); },
    setBusy: (next: boolean) => { busy = next; },
```

(f) Add them to the `Placeholder` interface (after `pet()`):
```ts
  /** Register a real interaction to keep the cat awake. */
  poke(): void;
  /** Force full frame-rate while the agent is working/talking. */
  setBusy(busy: boolean): void;
```

- [ ] **Step 2: Expose `poke`/`setBusy` on the driver facade**

In `src/renderer/character/types.ts` (after `pet?`):
```ts
  /** Register a real interaction (keeps the cat awake / un-throttled). */
  poke?(): void;
  /** Force full frame-rate while busy (agent working / talking). */
  setBusy?(busy: boolean): void;
```
In `src/renderer/character/driver.ts` (after `pet`):
```ts
  poke(): void { this.avatar.placeholder?.poke(); }
  setBusy(busy: boolean): void { this.avatar.placeholder?.setBusy(busy); }
```

- [ ] **Step 3: Drive activity + busy from the renderer**

In `src/renderer/bootstrap.ts`:
- In the cursor subscription, poke on movement: change the existing line to
```ts
  getCompanion()?.onCursor?.((target) => { driver.poke?.(); driver.setGaze?.(target); });
```
- In the gesture handlers (Task 2), poke on pet and talk: `onPet: () => { driver.poke?.(); driver.pet?.(); }`.
- In the existing `onActionEvent` handler, set busy around runs:
```ts
    if (e.kind === 'run.started') { driver.setBusy?.(true); /* ...existing... */ }
    else if (e.kind === 'run.completed' || e.kind === 'run.failed') { driver.setBusy?.(false); /* ...existing... */ }
```

- [ ] **Step 4: Stop the cursor poll when the window is hidden**

In `src/main/window.ts`, the `startCursorTracking` interval already early-returns on `!win.isVisible()`. Also skip when the renderer reports occlusion is not available — no change needed beyond what exists, but add an `isVisible()`-and-`!isMinimized()` guard:
```ts
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
```

- [ ] **Step 5: Verify type-check, lint, tests**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test`
Expected: clean; all tests pass (the policy is already covered by Task 1).

- [ ] **Step 6: Verify in the app (manual — GUI + Activity Monitor)**

Run: `npm start` (windowed is easiest to occlude). Open **Activity Monitor → Energy/CPU** and watch the Electron renderer:
- Move the mouse over the cat → ~60fps, normal CPU.
- Leave it idle ~45s → motion visibly slows (drowsy, ~12fps), CPU drops; ~2min → barely moving (asleep, ~6fps).
- **Cover the window** with another app → CPU/GPU should drop to ~0 (ticker stopped); un-cover → it resumes.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/character/avatar.ts src/renderer/character/types.ts src/renderer/character/driver.ts src/renderer/bootstrap.ts src/main/window.ts
git commit -m "feat(aliveness): frame governor — throttle idle, stop when occluded"
```

---

### Task 4: Sleep / wake poses

**Files:**
- Modify: `src/renderer/character/avatar.ts` (curl-asleep + stretch-on-wake poses driven by `energy`)

**Interfaces:**
- Consumes: `energy` (already computed each tick in Task 3).
- Produces: visual only — no new public methods.

- [ ] **Step 1: Add a curl-asleep posture and a wake stretch**

In `src/renderer/character/avatar.ts`:

(a) Track wake transitions near the other `let`s:
```ts
  let prevEnergy: Energy = 'awake';
  let stretchUntil = 0;
```

(b) In the ticker, right after `energy = activity.energy(nowMs);`, detect the wake edge:
```ts
    if (prevEnergy === 'asleep' && energy !== 'asleep') stretchUntil = nowMs + 700;
    prevEnergy = energy;
```

(c) Extend `actionForTick` so a sleeping cat curls. Change its body to:
```ts
  const actionForTick = (tick = 0): CatAction => {
    if (busy && state === 'working') return 'walking';
    if (energy === 'asleep' && state === 'idle') return 'sitting'; // curled; see drawCat
    if (state === 'working') return 'walking';
    if (state === 'thinking') return 'sitting';
    if (state === 'idle' && isFloatingWindow()) {
      const cycle = Math.floor(tick / 240) % 3;
      if (cycle === 1) return 'sitting';
      if (cycle === 2) return 'walking';
      return 'standing';
    }
    return 'standing';
  };
```

(d) In `drawCat`, when `energy === 'asleep'` draw a tighter curl + closed eyes are handled in `redrawFace`. Add, at the very top of the sitting branch in `drawCat`, a sleeping override:
```ts
    if (energy === 'asleep' && state === 'idle') {
      // tight curl: low body, tail wrapped, no legs
      px(cat, 5, 13, 9, 2, CAT.black);
      px(cat, 6, 12, 7, 1, CAT.black);
      px(cat, 11, 13, 2, 2, CAT.white);
      drawHead('sitting');
      return;
    }
```
(place this as the first statement inside `drawCat`, before the `action === 'sitting'` branch; `drawHead` is already defined above it).

(e) In `redrawFace`, keep eyes closed while asleep. Change the eye-draw guard:
```ts
    const asleep = energy === 'asleep' && state === 'idle';
    if (!blink && !asleep) {
      px(eyes, face.eyeLeft + lookX, face.eyeY + lookY, 1, 1, eyeColor);
      px(eyes, face.eyeRight + lookX, face.eyeY + lookY, 1, 1, eyeColor);
    }
```

(f) Apply a small "stretch" lift on wake in the ticker body offset. Where `body.position.y = breathe + focusLift;` is set, add the stretch:
```ts
    const stretch = nowMs < stretchUntil ? -3 : 0;
    body.position.y = breathe + focusLift + stretch;
```

- [ ] **Step 2: Verify type-check, lint, tests**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test`
Expected: clean; all pass.

- [ ] **Step 3: Verify in the app (manual — GUI)**

Run: `COMPANION_FLOATING_WINDOW=1 npm start`
Expected: leave the cat untouched ~2 min → it **curls up, eyes closed** (asleep). Move the mouse / pet it → it **wakes with a brief stretch** and the eyes open and resume tracking. (Tip: to test fast, temporarily lower `asleepMs` in `activity.ts` to e.g. `8_000`.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/character/avatar.ts
git commit -m "feat(aliveness): sleep curl + wake stretch driven by energy"
```

---

## Notes for later increments (not in this plan)
- **Mood (`MoodCore`)** — a valence axis modulating pose params + the personality system-prompt rewrite (only exercised when the brain runs).
- **First-run + return rituals** — the "adopt your Nero" naming + a different greeting after time away.
- **Hold-to-talk polish** — a visible "listening" affordance during the hold; today it reuses the existing call start/stop.
