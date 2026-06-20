# Aliveness — Cursor Gaze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pixel cat's eyes ease toward the user's mouse pointer so it visibly "watches" the cursor — the first increment of the Aliveness slice.

**Architecture:** A pure, framework-free gaze model (a shared `cursorToGazeTarget()` + a renderer-side `Gaze` easing class) holds all the testable math. The MAIN process polls the global cursor (`screen.getCursorScreenPoint()`), normalizes it against the window bounds, and pushes a target over a new IPC channel; the renderer feeds that into the placeholder cat, which already has `lookX/lookY` eye offsets in `redrawFace()`. No new avatar state, no change to the frozen 11-kind ActionEvent union.

**Tech Stack:** Electron 42, PixiJS v7 (the v8 port is a *later* increment — do not upgrade here), TypeScript ~5.6, Vitest (added in Task 1).

## Global Constraints

- TypeScript `~5.6.3`; the build is `@electron-forge/plugin-vite`. Keep PixiJS at the existing `^7.4.3` for this increment.
- **Preload sandbox rule:** `src/preload.ts` may import only `electron` and *pure* `src/shared/*` modules (string consts + types). Never import Node builtins or renderer/Pixi code there.
- **Pure-shared rule:** `src/shared/gaze.ts` must import nothing (no `electron`, no `pixi.js`) so MAIN, the renderer, and tests can all import it.
- **The cat is four colors** (`CAT.black/white/eye/ear`); this increment adds *no* new colors and *no* new avatar state — it only moves the existing eye pixels.
- **Near-zero idle:** the cursor poll is a single `setInterval` at `CURSOR_POLL_MS = 90` that early-returns when the window is hidden/destroyed. Do not add a per-frame main-process poll.
- **Determinism:** the `Gaze` easing is a plain function of its previous value + target; no `Math.random()` / `Date.now()` inside it (keeps it unit-testable and reproducible).

---

### Task 1: Pure gaze model + Vitest harness

**Files:**
- Create: `src/shared/gaze.ts`
- Create: `src/renderer/character/gaze.ts`
- Create: `src/shared/gaze.test.ts`
- Create: `src/renderer/character/gaze.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json` (add `vitest` devDep + `test` scripts)

**Interfaces:**
- Produces: `GazeTarget { x: number; y: number }` and `cursorToGazeTarget(cursor: {x,y}, bounds: {x,y,width,height}, reach: number): GazeTarget` (from `src/shared/gaze.ts`).
- Produces: `class Gaze { constructor(ease?: number, maxLook?: number); setTarget(t: GazeTarget | null): void; step(): { lookX: number; lookY: number } }` (from `src/renderer/character/gaze.ts`).

- [ ] **Step 1: Add Vitest to the toolchain**

In `package.json`, add to `devDependencies`:
```json
"vitest": "^2.1.9"
```
And add to `scripts` (after the `lint` line):
```json
"test": "vitest run",
"test:watch": "vitest"
```
Then run:
```bash
npm install
```

- [ ] **Step 2: Add the Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Write the failing tests for the shared cursor math**

Create `src/shared/gaze.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { cursorToGazeTarget } from './gaze';

describe('cursorToGazeTarget', () => {
  // window centred at (200, 200)
  const bounds = { x: 100, y: 100, width: 200, height: 200 };

  it('is centred (0,0) when the cursor is at the window centre', () => {
    expect(cursorToGazeTarget({ x: 200, y: 200 }, bounds, 100)).toEqual({ x: 0, y: 0 });
  });

  it('maps a cursor one reach right/below to (1,1)', () => {
    expect(cursorToGazeTarget({ x: 300, y: 300 }, bounds, 100)).toEqual({ x: 1, y: 1 });
  });

  it('maps a cursor up-left to negative axes', () => {
    expect(cursorToGazeTarget({ x: 150, y: 150 }, bounds, 100)).toEqual({ x: -0.5, y: -0.5 });
  });

  it('clamps beyond the reach radius to [-1, 1]', () => {
    expect(cursorToGazeTarget({ x: 9999, y: 9999 }, bounds, 100)).toEqual({ x: 1, y: 1 });
  });
});
```

Create `src/renderer/character/gaze.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Gaze } from './gaze';

describe('Gaze', () => {
  it('rests at centre with no target', () => {
    expect(new Gaze().step()).toEqual({ lookX: 0, lookY: 0 });
  });

  it('eases toward a target and converges to the max offset', () => {
    const g = new Gaze(0.5, 1);
    g.setTarget({ x: 1, y: -1 });
    let last = g.step();
    for (let i = 0; i < 50; i++) last = g.step();
    expect(last).toEqual({ lookX: 1, lookY: -1 });
  });

  it('approaches gradually (not instantly) on the first step', () => {
    const g = new Gaze(0.2, 10); // maxLook 10 so rounding reveals partial progress
    g.setTarget({ x: 1, y: 0 });
    const first = g.step();
    expect(first.lookX).toBeGreaterThan(0);
    expect(first.lookX).toBeLessThan(10);
  });

  it('returns to centre when the target is cleared', () => {
    const g = new Gaze(0.5, 1);
    g.setTarget({ x: 1, y: 1 });
    for (let i = 0; i < 50; i++) g.step();
    g.setTarget(null);
    let last = g.step();
    for (let i = 0; i < 50; i++) last = g.step();
    expect(last).toEqual({ lookX: 0, lookY: 0 });
  });

  it('clamps an out-of-range target', () => {
    const g = new Gaze(1, 1); // ease 1 => instant
    g.setTarget({ x: 5, y: -5 });
    expect(g.step()).toEqual({ lookX: 1, lookY: -1 });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — both files error with "Failed to resolve import './gaze'" / "cursorToGazeTarget is not a function" (modules don't exist yet).

- [ ] **Step 5: Implement the shared cursor math**

Create `src/shared/gaze.ts`:
```ts
// src/shared/gaze.ts — pure, dependency-free gaze math shared by MAIN and the renderer.
// Imports NOTHING (no electron, no pixi) so it is importable everywhere and unit-testable.

export interface GazeTarget {
  /** -1 (left) .. 1 (right): cursor x relative to the cat. */
  x: number;
  /** -1 (up) .. 1 (down): cursor y relative to the cat. */
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Convert a global cursor point + the window's screen bounds into a normalized
 * gaze target in [-1, 1] per axis. `reach` is the pixel distance from the window
 * centre at which the gaze is fully deflected.
 */
export function cursorToGazeTarget(
  cursor: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  reach: number,
): GazeTarget {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const r = Math.max(1, reach);
  return {
    x: clamp((cursor.x - cx) / r, -1, 1),
    y: clamp((cursor.y - cy) / r, -1, 1),
  };
}
```

Create `src/renderer/character/gaze.ts`:
```ts
// src/renderer/character/gaze.ts — eases the cat's gaze toward a target each tick.
// Pure (no Pixi); the renderer feeds step()'s rounded offsets into the eye pixels.

import type { GazeTarget } from '../../shared/gaze';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Gaze {
  private curX = 0;
  private curY = 0;
  private tgtX = 0;
  private tgtY = 0;

  /**
   * @param ease    per-step approach fraction (0..1). Higher = snappier.
   * @param maxLook largest eye offset in grid-pixels.
   */
  constructor(
    private readonly ease = 0.18,
    private readonly maxLook = 1,
  ) {}

  /** Set the gaze target; null returns the gaze to centre. */
  setTarget(target: GazeTarget | null): void {
    this.tgtX = target ? clamp(target.x, -1, 1) : 0;
    this.tgtY = target ? clamp(target.y, -1, 1) : 0;
  }

  /** Advance one step; returns rounded eye offsets in grid-pixels. */
  step(): { lookX: number; lookY: number } {
    this.curX += (this.tgtX - this.curX) * this.ease;
    this.curY += (this.tgtY - this.curY) * this.ease;
    return {
      lookX: Math.round(this.curX * this.maxLook),
      lookY: Math.round(this.curY * this.maxLook),
    };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests across the two files green.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/shared/gaze.ts src/shared/gaze.test.ts src/renderer/character/gaze.ts src/renderer/character/gaze.test.ts
git commit -m "feat(aliveness): pure gaze model + vitest harness"
```

---

### Task 2: Wire cursor → eyes end-to-end

**Files:**
- Modify: `src/shared/ipc.ts` (add the `cursorMove` channel)
- Modify: `src/main/window.ts` (poll cursor, push target)
- Modify: `src/main.ts:45` (start tracking on the created window)
- Modify: `src/preload.ts` (expose `onCursor`)
- Modify: `src/renderer/events/bridge.ts` (declare `onCursor` on the bridge)
- Modify: `src/renderer/character/types.ts` (add `setGaze` to `CharacterDriver`)
- Modify: `src/renderer/character/driver.ts` (implement `setGaze`)
- Modify: `src/renderer/character/avatar.ts` (gaze in the placeholder + ticker + `redrawFace`)
- Modify: `src/renderer/bootstrap.ts` (subscribe cursor → `driver.setGaze`)

**Interfaces:**
- Consumes: `cursorToGazeTarget` and `GazeTarget` (Task 1, `src/shared/gaze.ts`); `Gaze` (Task 1, `src/renderer/character/gaze.ts`).
- Produces: `startCursorTracking(win: BrowserWindow): () => void` (window.ts); `CharacterDriver.setGaze(target: GazeTarget | null): void`; `Placeholder.setGaze(target: GazeTarget | null): void`; `window.companion.onCursor(cb): () => void`; `CH.cursorMove`.

- [ ] **Step 1: Add the IPC channel**

In `src/shared/ipc.ts`, add `cursorMove` next to `windowMoveBy`:
```ts
  windowMoveBy: 'window:moveBy',
  cursorMove: 'cursor:move',
```

- [ ] **Step 2: Poll the cursor in MAIN**

In `src/main/window.ts`, add `screen` to the electron import and import the shared math:
```ts
import { BrowserWindow, globalShortcut, screen } from 'electron';
import path from 'node:path';
import { CH } from '../shared/ipc';
import { cursorToGazeTarget } from '../shared/gaze';
```
Then append this exported function (e.g. after `createWindow`):
```ts
const CURSOR_POLL_MS = 90;
// Pixel distance from the window centre at which the gaze is fully deflected.
const CURSOR_REACH_PX = 520;

/**
 * Poll the global cursor and push a normalized gaze target to the renderer so
 * the cat can "watch" the pointer. Returns a stop fn; also self-stops on close.
 */
export function startCursorTracking(win: BrowserWindow): () => void {
  const timer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const cursor = screen.getCursorScreenPoint();
    const target = cursorToGazeTarget(cursor, win.getBounds(), CURSOR_REACH_PX);
    win.webContents.send(CH.cursorMove, target);
  }, CURSOR_POLL_MS);
  win.on('closed', () => clearInterval(timer));
  return () => clearInterval(timer);
}
```

- [ ] **Step 3: Start tracking on the created window**

In `src/main.ts`, import the new fn and call it. Change the import on line 13:
```ts
import { createWindow, registerSummonShortcut, unregisterShortcuts, startCursorTracking } from './main/window';
```
Change `createWindow();` (line 45) to:
```ts
  const win = createWindow();
  startCursorTracking(win);
```

- [ ] **Step 4: Expose `onCursor` in preload**

In `src/preload.ts`, add to the `companion` object (after `onMicToggleMute`):
```ts
  onCursor: (cb: (t: { x: number; y: number }) => void): (() => void) =>
    subscribe<{ x: number; y: number }>(CH.cursorMove, cb),
```

- [ ] **Step 5: Declare `onCursor` on the renderer bridge**

In `src/renderer/events/bridge.ts`, add to `interface CompanionBridgeLike` (after `onMicToggleMute`):
```ts
  /** Subscribe to normalized cursor-gaze targets pushed from MAIN. */
  onCursor?(cb: (t: { x: number; y: number }) => void): () => void;
```

- [ ] **Step 6: Add `setGaze` to the CharacterDriver facade**

In `src/renderer/character/types.ts`, import the shared type at the top:
```ts
import type { AvatarState } from '../../shared/avatar';
import type { GazeTarget } from '../../shared/gaze';
```
And add to `interface CharacterDriver` (after `setMuted`):
```ts
  /** Point the eyes toward a normalized cursor target; null re-centres. No-op for a real model. */
  setGaze?(target: GazeTarget | null): void;
```

In `src/renderer/character/driver.ts`, add the method to `Live2DCharacterDriver` (after `setMuted`):
```ts
  setGaze(target: import('../../shared/gaze').GazeTarget | null): void {
    this.avatar.placeholder?.setGaze(target);
  }
```

- [ ] **Step 7: Render the gaze in the placeholder cat**

In `src/renderer/character/avatar.ts`:

(a) Add imports near the top (with the other imports):
```ts
import { Gaze } from './gaze';
import type { GazeTarget } from '../../shared/gaze';
```

(b) Add `setGaze` to the `Placeholder` interface (after `setMuted`):
```ts
  /** Point the eyes toward a normalized cursor target; null re-centres. */
  setGaze(target: GazeTarget | null): void;
```

(c) Inside `buildPlaceholder`, declare the gaze state near the other `let` vars (after `let muted = false;`):
```ts
  const gaze = new Gaze();
  let gazeLookX = 0;
  let gazeLookY = 0;
```

(d) In `redrawFace`, replace the two `lookX/lookY` lines:
```ts
    const lookX = state === 'thinking' ? -1 : 0;
    const lookY = state === 'thinking' ? -1 : 0;
```
with:
```ts
    const lookX = state === 'thinking' ? -1 : gazeLookX;
    const lookY = state === 'thinking' ? -1 : gazeLookY;
```

(e) In the `app.ticker.add(...)` callback, advance the gaze just before the `drawTail(tick, action)` call:
```ts
    const g = gaze.step();
    gazeLookX = g.lookX;
    gazeLookY = g.lookY;
    drawTail(tick, action);
```

(f) Add `setGaze` to the returned object (after the `setMuted` entry):
```ts
    setGaze: (target: GazeTarget | null) => {
      gaze.setTarget(target);
    },
```

- [ ] **Step 8: Subscribe cursor → gaze in bootstrap**

In `src/renderer/bootstrap.ts`, after the `subscribeActionEvents({ character: driver, timeline, captions });` line (≈ line 48), add:
```ts
  // Aliveness: the cat watches the cursor (gaze eased toward the pointer).
  getCompanion()?.onCursor?.((target) => driver.setGaze?.(target));
```

- [ ] **Step 9: Verify it type-checks, lints, and unit tests still pass**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test`
Expected: no TypeScript errors, no new lint errors, 9 tests pass.

- [ ] **Step 10: Verify it works in the running app (manual — GUI)**

> This step needs a real macOS desktop; the GUI can't be observed from a headless agent. Run it and watch the cat.

Run: `COMPANION_FLOATING_WINDOW=1 npm start`
Expected: the floating pixel cat appears; as you move the mouse around the screen, the cat's eyes shift toward the pointer (left/right/up/down by one pixel) and ease back to centre when the pointer is near the cat. Also run plain `npm start` (windowed) and confirm the eyes track the cursor over the canvas. No console errors referencing `cursor:move`, `gaze`, or `setGaze`.

- [ ] **Step 11: Commit**

```bash
git add src/shared/ipc.ts src/main/window.ts src/main.ts src/preload.ts src/renderer/events/bridge.ts src/renderer/character/types.ts src/renderer/character/driver.ts src/renderer/character/avatar.ts src/renderer/bootstrap.ts
git commit -m "feat(aliveness): cat eyes follow the cursor (gaze) end-to-end"
```

---

## Notes for the next increments (not in this plan)

- **Frame governor** (idle battery): stop the Pixi ticker on `document.visibilitychange` (occlusion) and throttle `maxFPS` when at rest; pause cursor polling when the window is hidden.
- **Petting:** double-click the cat → a short happy burst (ears perk, tail wag, sparkle). Wire via the existing `installFloatingWindowGesture` tap path + a new `driver.pet()`.
- **Sleep/wake:** an energy axis (awake→drowsy→asleep) driven by idle time + cursor proximity; a new curl-asleep pose.
- **Mood + personality voice:** a `MoodCore` valence vector modulating pose params, and the `NERO_PERSONALITY` system-prompt rewrite (only exercised when the brain runs).
