// src/renderer/character/avatar.ts — the canvas/mount layer.
//
// createAvatar() tries to load a real Cubism 4 Live2D model from the public dir.
// If the model file is absent (the repo ships NO model yet) OR Cubism Core failed
// to load OR Live2DModel.from() throws, we fall back to a PLACEHOLDER: a
// 16-bit pixel cat whose expression is driven by avatar state. Either way the
// returned `Avatar` exposes the SAME shape, so the state machine,
// lip-sync, and the CharacterDriver facade are identical for both — Voice/event
// code never knows whether a model is present.

import '@pixi/unsafe-eval';
import * as PIXI from 'pixi.js';
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display-lipsyncpatch';
import type { AvatarState } from '../../shared/avatar';
import type { ActivityCue } from './types';

const MUTED_MIC_BADGE_URL = 'assets/muted-mic-32-2color.png';

// REQUIRED by the plugin: it reads window.PIXI.Ticker to auto-update models, and
// for some bundlers grabs other PIXI internals. Must be set before from().
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
type Live2DModule = typeof import('pixi-live2d-display-lipsyncpatch');

export interface Avatar {
  app: PIXI.Application;
  /** The loaded Live2D model, or null when running the placeholder. */
  model: Live2DModelType | null;
  /** The placeholder display object, or null when a real model loaded. */
  placeholder: Placeholder | null;
  /** True when a real Live2D model is mounted. */
  readonly hasModel: boolean;
}

/** A state-aware fallback avatar shown when no model is available. */
export interface Placeholder {
  container: PIXI.Container;
  aura: PIXI.Graphics;
  body: PIXI.Container;
  mouth: PIXI.Graphics;
  label: PIXI.Text;
  /** Re-tint and re-label for a given state. */
  setTint(color: number): void;
  setLabel(text: string): void;
  /** State-aware expression, posture, and effect changes. */
  setState(state: AvatarState, color: number): void;
  /** Tiny work prop + short caption for the latest action-event beat. */
  setActivity(cue: ActivityCue | null): void;
  /** 0..1 mouth openness for lip-sync feedback. */
  setMouthOpen(v: number): void;
  /** Assistant speech boundary from Vapi. */
  setTalking(talking: boolean): void;
  /** Presentation-mode mic input gate. */
  setMuted(muted: boolean): void;
}

async function modelExists(url: string): Promise<boolean> {
  try {
    // HEAD avoids downloading the model just to probe. Some static servers don't
    // support HEAD; fall back to a ranged GET on failure.
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      return get.ok;
    }
    return false;
  } catch {
    // Network/path error => treat as absent so we render the placeholder.
    return false;
  }
}

async function loadLive2D(): Promise<Live2DModule | null> {
  try {
    const mod = await import('pixi-live2d-display-lipsyncpatch');
    // Belt-and-suspenders for tree-shaking bundlers.
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    mod.config.logLevel = mod.config.LOG_LEVEL_WARNING;
    // We drive audio ourselves (speak / amplitude); don't let motions trigger sound.
    mod.config.sound = false;
    return mod;
  } catch (err) {
    console.warn('[avatar] Live2D runtime unavailable; using placeholder:', err);
    return null;
  }
}

function isFloatingWindow(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains('floating-window');
}

function buildPlaceholder(app: PIXI.Application): Placeholder {
  const container = new PIXI.Container();
  container.sortableChildren = true;

  let state: AvatarState = 'idle';
  let mouthOpen = 0;
  let talking = false;
  let muted = false;
  let blinkUntil = 0;
  let nextBlink = performance.now() + 1700;
  let activity: ActivityCue | null = null;
  let activityStartedAt = 0;
  const activityTrail: string[] = [];

  const PIXEL = 16;
  const GRID_W = 18;
  const GRID_H = 17;
  const CAT = {
    black: 0x171821,
    white: 0xf4f0e8,
    eye: 0xffd61e,
    ear: 0x70736e,
  } as const;
  // The cat stays four-color; transient state effects get their own palette.
  const EFFECT = {
    thought: 0xffc94a,
    thoughtHot: 0xffe071,
    signal: 0x43d7ff,
    signalSoft: 0x9beeff,
    working: 0x7aa2ff,
    workingSoft: 0xd8e5ff,
    success: 0x67e878,
    successGold: 0xffdf4d,
    error: 0xff4d4d,
    errorHot: 0xff8a3d,
    muted: 0xff4d6d,
    mutedSoft: 0xffb0a8,
  } as const;

  const aura = new PIXI.Graphics();
  aura.zIndex = 0;

  const body = new PIXI.Container();
  body.zIndex = 2;

  const tail = new PIXI.Graphics();
  const cat = new PIXI.Graphics();
  const eyes = new PIXI.Graphics();
  const mouth = new PIXI.Graphics();
  const foreground = new PIXI.Graphics();
  const prop = new PIXI.Graphics();
  const signal = new PIXI.Graphics();
  const mutedBadge = PIXI.Sprite.from(MUTED_MIC_BADGE_URL);
  mutedBadge.anchor.set(0.5);
  mutedBadge.visible = false;
  mutedBadge.zIndex = 3;
  mutedBadge.texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;

  const px = (g: PIXI.Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 1) => {
    g.beginFill(color, alpha);
    g.drawRect((x - GRID_W / 2) * PIXEL, (y - GRID_H / 2) * PIXEL, w * PIXEL, h * PIXEL);
    g.endFill();
  };

  const activityColor = (cue: ActivityCue | null): number => {
    switch (cue?.kind) {
      case 'thinking':
        return EFFECT.thoughtHot;
      case 'memory':
        return EFFECT.success;
      case 'read':
      case 'command':
        return EFFECT.working;
      case 'edit':
        return EFFECT.successGold;
      case 'success':
        return EFFECT.success;
      case 'error':
        return EFFECT.error;
      case 'talking':
        return EFFECT.signal;
      case 'muted':
        return EFFECT.muted;
      default:
        return CAT.white;
    }
  };

  const trimActivityText = (text: string): string =>
    text.length > 28 ? `${text.slice(0, 25)}...` : text;

  type CatAction = 'standing' | 'sitting' | 'walking';

  const actionForTick = (tick = 0): CatAction => {
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

  const stepFrame = (tick = 0) => Math.floor(tick / 12) % 4;

  const walkOffset = (tick = 0) => Math.round(Math.sin(tick / 34) * 30);

  const walkDirection = (tick = 0) => (Math.cos(tick / 34) >= 0 ? 1 : -1);

  const headOriginForAction = (action: CatAction) => {
    if (action === 'walking') return { x: 8, y: 4 };
    if (action === 'sitting') return { x: 7, y: 4 };
    return { x: 8, y: 4 };
  };

  const faceForAction = (action: CatAction) => {
    const head = headOriginForAction(action);
    return {
      eyeLeft: head.x + 3,
      eyeRight: head.x + 6,
      eyeY: head.y + 3,
      mouthX: head.x + 4,
      mouthY: head.y + 4,
    };
  };

  const drawTail = (tick = 0, action = actionForTick(tick)) => {
    tail.clear();
    const wag = Math.floor(tick / 24) % 2;

    if (state === 'error') {
      px(tail, 4, 8, 1, 5, CAT.black);
      px(tail, 5, 11, 1, 2, CAT.black);
      return;
    }

    if (action === 'sitting') {
      px(tail, 5, 9, 1, 5, CAT.black);
      px(tail, 5, 12, 2, 1, CAT.black);
      px(tail, 4, 14, 3, 1, CAT.black);
      return;
    }

    px(tail, 3, 7, 1, 6, CAT.black);
    px(tail, 2, 4, 1, 4, CAT.black);
    px(tail, 2, 4, 2, 1, CAT.black);
    px(tail, 4, 11, 2, 1, CAT.black);
    px(tail, 4, 12, 2, 1, CAT.black);
    px(tail, 3 + wag, 4, 1, 1, CAT.black);
  };

  const drawCat = (tick = 0, action = actionForTick(tick)) => {
    cat.clear();

    const earsFlat = state === 'error';
    const earsPerked = state === 'listening' || talking;
    const earTop = earsPerked ? 2 : 3;
    const earTwitch = state === 'idle' && Math.floor(tick / 70) % 6 === 1;
    const leftEarTop = earTop - (earTwitch ? 1 : 0);
    const rightEarTop = earTop - (!earTwitch && state === 'idle' && Math.floor(tick / 90) % 7 === 2 ? 1 : 0);

    const drawHead = (action: CatAction) => {
      const { x, y } = headOriginForAction(action);
      px(cat, x + 1, y + 1, 7, 1, CAT.black);
      px(cat, x + 1, y + 2, 7, 4, CAT.black);
      px(cat, x, y + 3, 1, 2, CAT.black);
      px(cat, x + 8, y + 3, 1, 2, CAT.black);

      if (earsFlat) {
        px(cat, x + 1, y + 1, 3, 1, CAT.black);
        px(cat, x + 5, y + 1, 3, 1, CAT.black);
      } else {
        px(cat, x + 1, leftEarTop, 2, 3, CAT.black);
        px(cat, x + 6, rightEarTop, 2, 3, CAT.black);
        px(cat, x + 2, leftEarTop + 1, 1, 1, CAT.ear);
        px(cat, x + 6, rightEarTop + 1, 1, 1, CAT.ear);
      }
    };

    const drawToe = (x: number, y: number) => {
      px(cat, x, y, 1, 1, CAT.white);
    };

    if (action === 'sitting') {
      px(cat, 7, 9, 5, 6, CAT.black);
      px(cat, 6, 11, 7, 4, CAT.black);
      px(cat, 8, 8, 4, 1, CAT.black);
      px(cat, 10, 10, 2, 5, CAT.white);
      px(cat, 8, 14, 1, 2, CAT.black);
      px(cat, 11, 14, 1, 2, CAT.black);
      drawToe(8, 15);
      drawToe(11, 15);
      drawHead(action);
    } else if (action === 'walking') {
      const frame = stepFrame(tick);
      const frontLeg = frame === 0 || frame === 3 ? 1 : 0;
      const rearLeg = frame === 1 || frame === 2 ? 1 : 0;

      px(cat, 4, 10, 9, 4, CAT.black);
      px(cat, 6, 9, 5, 1, CAT.black);
      px(cat, 10, 10, 3, 4, CAT.white);
      px(cat, 5, 14, 1, 2 + rearLeg, CAT.black);
      px(cat, 8, 14, 1, 2 + frontLeg, CAT.black);
      px(cat, 11, 14, 1, 2 + rearLeg, CAT.black);
      px(cat, 13, 14, 1, 2 + frontLeg, CAT.black);
      drawToe(5, 15 + rearLeg);
      drawToe(8, 15 + frontLeg);
      drawToe(11, 15 + rearLeg);
      drawToe(13, 15 + frontLeg);
      drawHead(action);
    } else {
      px(cat, 5, 10, 8, 4, CAT.black);
      px(cat, 6, 9, 5, 1, CAT.black);
      px(cat, 10, 10, 3, 4, CAT.white);
      px(cat, 6, 14, 1, 2, CAT.black);
      px(cat, 8, 14, 1, 2, CAT.black);
      px(cat, 11, 14, 1, 2, CAT.black);
      px(cat, 13, 14, 1, 2, CAT.black);
      drawToe(6, 15);
      drawToe(8, 15);
      drawToe(11, 15);
      drawToe(13, 15);
      drawHead(action);
    }
  };

  const redrawFace = (tick = 0, action = actionForTick(tick)) => {
    const blink = performance.now() < blinkUntil;
    const eyeColor = CAT.eye;
    const lookX = state === 'thinking' ? -1 : 0;
    const lookY = state === 'thinking' ? -1 : 0;
    const face = faceForAction(action);

    eyes.clear();
    mouth.clear();
    if (!blink) {
      px(eyes, face.eyeLeft + lookX, face.eyeY + lookY, 1, 1, eyeColor);
      px(eyes, face.eyeRight + lookX, face.eyeY + lookY, 1, 1, eyeColor);
    }

    if (state === 'error') {
      px(mouth, face.mouthX, face.mouthY, 2, 1, EFFECT.error);
    } else if (talking || mouthOpen > 0.16) {
      px(mouth, face.mouthX, face.mouthY, 1, 1, CAT.white);
      if (mouthOpen > 0.48 || talking) px(mouth, face.mouthX + 1, face.mouthY, 1, 1, CAT.white);
    }
  };

  const redrawAura = (tick = 0) => {
    aura.clear();
    const blink = Math.floor(tick / 18) % 2;
    if (state === 'thinking') {
      px(aura, 10, 1, 1, 1, EFFECT.thought);
      if (blink) px(aura, 12, 0, 1, 1, EFFECT.thoughtHot);
      px(aura, 13, 1, 1, 1, EFFECT.thought);
    }
    if (state === 'working') {
      px(aura, 3, 7, 1, 1, EFFECT.workingSoft);
      if (blink) px(aura, 2, 9, 1, 1, EFFECT.working);
      px(aura, 15, 10, 1, 1, EFFECT.working);
      if (blink) px(aura, 16, 12, 1, 1, EFFECT.workingSoft);
    }
    if (state === 'done') {
      px(aura, 5, 3, 1, 1, EFFECT.success);
      if (blink) px(aura, 4, 4, 1, 1, EFFECT.successGold);
      px(aura, 15, 4, 1, 1, EFFECT.success);
      if (blink) px(aura, 16, 5, 1, 1, EFFECT.successGold);
      px(aura, 14, 10, 1, 1, EFFECT.success);
      // An unmistakable green check above the head so 'done' reads clearly even in
      // floating mode (where the timeline/caption are hidden and a standing cat
      // otherwise looks identical to idle).
      const DONE_GREEN = 0x5ad17a;
      px(aura, 8, 1, 1, 1, DONE_GREEN);
      px(aura, 9, 2, 1, 1, DONE_GREEN);
      px(aura, 10, 1, 1, 1, DONE_GREEN);
      px(aura, 11, 0, 1, 1, DONE_GREEN);
    }
    if (state === 'error') {
      px(aura, 6, 3, 1, 1, EFFECT.error);
      if (blink) px(aura, 15, 3, 1, 1, EFFECT.errorHot);
    }
  };

  const redrawSignal = (tick = 0) => {
    signal.clear();
    foreground.clear();

    if (muted) {
      return;
    }

    if (talking || state === 'listening') {
      const frame = Math.floor(tick / 16) % 3;
      px(signal, 15, 5, 1, 1, EFFECT.signal);
      if (frame > 0) px(signal, 16, 4, 1, 1, EFFECT.signalSoft);
      if (frame > 1) px(signal, 16, 7, 1, 1, EFFECT.signalSoft);
      px(signal, 6, 5, 1, 1, EFFECT.signalSoft);
      if (frame > 0) px(signal, 5, 4, 1, 1, EFFECT.signal);
    }
  };

  const activeActivity = (alpha: number): ActivityCue | null => {
    if (activity && alpha > 0) return activity;
    if (state === 'thinking') return { kind: 'thinking', text: 'thinking' };
    if (state === 'working') return { kind: 'command', text: 'working' };
    if (state === 'done') return { kind: 'success', text: 'done' };
    if (state === 'error') return { kind: 'error', text: 'stuck' };
    if (muted) return { kind: 'muted', text: 'muted' };
    if (talking) return { kind: 'talking', text: 'speaking' };
    return null;
  };

  const drawActivityProp = (tick = 0) => {
    prop.clear();
    const elapsed = performance.now() - activityStartedAt;
    const fade = activity ? Math.max(0, Math.min(1, 1 - (elapsed - 2200) / 800)) : 0;
    const cue = activeActivity(fade);
    if (!cue) return;
    const alpha = activity ? Math.max(0.45, fade) : 0.65;
    const blink = Math.floor(tick / 14) % 2;

    if (cue.kind === 'memory') {
      px(prop, 3, 5, 2, 2, EFFECT.signal, alpha);
      px(prop, 3, 5, 1, 1, EFFECT.success, alpha);
      px(prop, 5, 5, 1, 2, EFFECT.success, alpha);
      if (blink) px(prop, 4, 4, 1, 1, EFFECT.successGold, alpha);
    } else if (cue.kind === 'read') {
      px(prop, 14, 9, 3, 4, CAT.white, alpha);
      px(prop, 15, 10, 2, 1, EFFECT.workingSoft, alpha);
      px(prop, 15, 12, 2, 1, EFFECT.working, alpha);
    } else if (cue.kind === 'edit') {
      px(prop, 14, 11, 1, 1, EFFECT.successGold, alpha);
      px(prop, 15, 10, 1, 1, EFFECT.successGold, alpha);
      px(prop, 16, 9, 1, 1, CAT.ear, alpha);
      if (blink) px(prop, 13, 12, 1, 1, EFFECT.thoughtHot, alpha);
    } else if (cue.kind === 'command') {
      px(prop, 14, 10, 4, 3, CAT.black, alpha);
      px(prop, 14, 10, 4, 1, EFFECT.working, alpha);
      px(prop, 15, 12, 1, 1, EFFECT.success, alpha);
      if (blink) px(prop, 17, 12, 1, 1, EFFECT.workingSoft, alpha);
    } else if (cue.kind === 'success') {
      px(prop, 14, 8, 1, 2, EFFECT.success, alpha);
      px(prop, 15, 9, 1, 1, EFFECT.success, alpha);
      px(prop, 16, 7, 1, 1, EFFECT.successGold, alpha);
      if (blink) px(prop, 13, 6, 1, 1, EFFECT.successGold, alpha);
    } else if (cue.kind === 'error') {
      px(prop, 14, 7, 2, 1, EFFECT.error, alpha);
      px(prop, 15, 8, 1, 3, EFFECT.error, alpha);
      px(prop, 15, 12, 1, 1, EFFECT.errorHot, alpha);
      if (blink) px(prop, 13, 6, 1, 1, EFFECT.errorHot, alpha);
    } else if (cue.kind === 'talking') {
      px(prop, 15, 5, 1, 1, EFFECT.signal, alpha);
      px(prop, 16, 4, 1, 1, EFFECT.signalSoft, alpha);
      px(prop, 16, 7, 1, 1, EFFECT.signalSoft, alpha);
    } else if (cue.kind === 'muted') {
      return;
    } else if (cue.kind === 'thinking') {
      px(prop, 10, 1, 1, 1, EFFECT.thought, alpha);
      px(prop, 12, 0, 1, 1, EFFECT.thoughtHot, alpha);
      if (blink) px(prop, 13, 1, 1, 1, EFFECT.thought, alpha);
    }
  };

  const label = new PIXI.Text('idle', {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 18,
    fontWeight: '700',
    fill: 0xffffff,
    align: 'center',
  });
  label.anchor.set(0.5, 0);
  label.position.set(0, 142);

  const activityBlip = new PIXI.Text('', {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 12,
    fontWeight: '700',
    fill: CAT.white,
    align: 'center',
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowBlur: 0,
    dropShadowDistance: 2,
  });
  activityBlip.anchor.set(0.5, 0.5);

  const activityTail = new PIXI.Text('', {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    fontSize: 9,
    fontWeight: '700',
    fill: CAT.white,
    align: 'left',
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowBlur: 0,
    dropShadowDistance: 1,
  });
  activityTail.anchor.set(0, 0);

  const refreshActivityText = () => {
    const floating = isFloatingWindow();
    const elapsed = performance.now() - activityStartedAt;
    const cueFade = activity ? Math.max(0, Math.min(1, 1 - (elapsed - 2200) / 800)) : 0;
    const cue = activeActivity(cueFade);
    const blipVisible = floating && !!activity?.text && cueFade > 0;
    activityBlip.visible = blipVisible;
    if (blipVisible) {
      activityBlip.text = trimActivityText(activity.text ?? '');
      activityBlip.style.fill = activityColor(activity);
      activityBlip.alpha = cueFade;
      activityBlip.position.set(0, -128 - (1 - cueFade) * 16);
    }

    const trailVisible = floating && activityTrail.length > 1 && elapsed >= 3000 && elapsed < 5200;
    activityTail.visible = trailVisible;
    if (trailVisible) {
      activityTail.text = activityTrail.slice(-3).map((item) => `· ${trimActivityText(item)}`).join('\n');
      activityTail.alpha = Math.min(0.74, Math.max(0, 1 - (elapsed - 3600) / 1600));
      activityTail.position.set(-118, 104);
    }

    if (!cue && !blipVisible) {
      activityBlip.text = '';
    }
  };

  const refreshLabelVisibility = () => {
    label.visible = !isFloatingWindow();
  };
  refreshLabelVisibility();

  body.addChild(tail, cat, eyes, mouth, foreground, prop, signal);
  container.addChild(aura, body, mutedBadge, activityBlip, activityTail, label);
  app.stage.addChild(container);

  let lastFitWidth = 0;
  let lastFitHeight = 0;
  const positionContainer = () => {
    const width = app.screen.width;
    const height = app.screen.height;
    const floating = isFloatingWindow();
    container.position.set(width / 2, height / 2 - (floating ? 8 : 16));
  };

  const fit = () => {
    const width = app.screen.width;
    const height = app.screen.height;
    const baseScale = Math.min(1.35, Math.max(0.72, Math.min(width / 380, height / 390)));
    const scale = isFloatingWindow() ? baseScale * 0.76 : baseScale;
    container.scale.set(scale);
    positionContainer();
    lastFitWidth = width;
    lastFitHeight = height;
  };
  fit();
  window.addEventListener('resize', fit);

  drawTail();
  drawCat();
  redrawFace();
  redrawAura();
  drawActivityProp();
  refreshActivityText();

  app.ticker.add(() => {
    if (app.screen.width !== lastFitWidth || app.screen.height !== lastFitHeight) fit();
    refreshLabelVisibility();
    refreshActivityText();

    const now = performance.now();
    if (now > nextBlink) {
      blinkUntil = now + 90;
      nextBlink = now + 1600 + Math.random() * 2200;
    }
    const tick = app.ticker.lastTime / 16.67;
    const action = actionForTick(tick);
    positionContainer();
    const breathe = action === 'walking' ? Math.round(Math.abs(Math.sin(tick / 12)) * -2) * 2 : Math.round(Math.sin(tick / 34) * 2) * 2;
    const focusLift = state === 'working' ? -6 : state === 'thinking' ? -4 : state === 'error' ? 4 : 0;
    body.scale.x = action === 'walking' ? walkDirection(tick) : 1;
    body.position.x = action === 'walking' ? walkOffset(tick) : 0;
    body.position.y = breathe + focusLift;
    mutedBadge.visible = muted;
    if (muted) {
      const badgeScale = 0.22 + Math.sin(tick / 30) * 0.006;
      mutedBadge.scale.set(badgeScale);
      mutedBadge.alpha = 0.96;
      mutedBadge.position.set(132, -122 + Math.round(Math.sin(tick / 26) * 4));
    }
    drawTail(tick, action);
    drawCat(tick, action);
    redrawFace(tick, action);
    redrawAura(tick);
    redrawSignal(tick);
    drawActivityProp(tick);
  }, undefined, PIXI.UPDATE_PRIORITY.LOW);

  const applyState = (nextState: AvatarState, color: number) => {
    void color;
    state = nextState;
    drawCat();
    redrawFace();
    redrawAura();
    redrawSignal();
    drawActivityProp();
    refreshActivityText();
  };

  const applyActivity = (cue: ActivityCue | null) => {
    activity = cue;
    activityStartedAt = performance.now();
    if (cue?.text) {
      const text = trimActivityText(cue.text);
      if (activityTrail[activityTrail.length - 1] !== text) activityTrail.push(text);
      if (activityTrail.length > 3) activityTrail.splice(0, activityTrail.length - 3);
    }
    drawActivityProp();
    refreshActivityText();
  };

  return {
    container,
    aura,
    body,
    mouth,
    label,
    setTint: (color: number) => {
      void color;
      redrawSignal();
    },
    setLabel: (text: string) => {
      label.text = text;
      refreshLabelVisibility();
    },
    setState: applyState,
    setActivity: applyActivity,
    setMouthOpen: (v: number) => {
      mouthOpen = Math.max(0, Math.min(1, v));
      redrawFace();
    },
    setTalking: (nextTalking: boolean) => {
      talking = nextTalking;
      if (nextTalking && !muted) applyActivity({ kind: 'talking', text: 'speaking' });
      redrawFace();
      redrawSignal();
    },
    setMuted: (nextMuted: boolean) => {
      muted = nextMuted;
      if (muted) {
        talking = false;
        mouthOpen = 0;
      }
      redrawFace();
      redrawSignal();
      drawActivityProp();
      refreshActivityText();
    },
  };
}

function fitModel(app: PIXI.Application, model: Live2DModelType) {
  model.anchor.set(0.5, 0.5);
  model.position.set(app.renderer.width / 2, app.renderer.height / 2);
  // internalModel.height is native px height (NOT scaled) — avoids a feedback loop.
  const target = app.renderer.height * 0.85;
  const nativeH = model.internalModel?.height ?? target;
  model.scale.set(target / nativeH);
}

/**
 * Mount the avatar onto `canvas`. Loads a real Live2D model when `modelUrl`
 * resolves; otherwise renders the placeholder. Never throws on a missing model.
 */
export async function createAvatar(canvas: HTMLCanvasElement, modelUrl: string): Promise<Avatar> {
  const app = new PIXI.Application({
    view: canvas,
    resizeTo: window,
    backgroundAlpha: 0, // transparent: the avatar floats over the UI
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  const coreLoaded = typeof (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !== 'undefined';
  const present = coreLoaded && (await modelExists(modelUrl));

  if (present) {
    try {
      const live2d = await loadLive2D();
      if (!live2d) throw new Error('Live2D runtime import failed');
      const model = await live2d.Live2DModel.from(modelUrl, { autoInteract: false });
      app.stage.addChild(model);
      const fit = () => fitModel(app, model);
      fit();
      window.addEventListener('resize', fit);
      console.info('[avatar] loaded Live2D model:', modelUrl);
      return { app, model, placeholder: null, hasModel: true };
    } catch (err) {
      // Loading failed despite the file existing (bad/missing texture, etc.).
      // Fall through to the placeholder rather than leaving a blank canvas.
      console.warn('[avatar] Live2D model failed to load, using placeholder:', err);
    }
  } else if (!coreLoaded) {
    console.warn('[avatar] Live2DCubismCore not loaded; using placeholder. See public/live2d/README.');
  } else {
    console.warn('[avatar] no model at', modelUrl, '— using placeholder.');
  }

  const placeholder = buildPlaceholder(app);
  return { app, model: null, placeholder, hasModel: false };
}
