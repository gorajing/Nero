// src/renderer/events/actionEvents.ts — drive the avatar + timeline from the
// normalized executor ActionEvent stream pushed by MAIN over the preload bridge.
//
// For each ActionEvent:
//   - CharacterDriver.setState(eventToAvatarState(e) ?? current)  (null keeps the
//     current state; message/message.delta don't change it)
//   - append the event to the ActionTimeline
// Also subscribes brain.onReasoning -> setState('thinking') and onRunEnd -> a
// timeline marker. Returns a single unsubscribe that detaches everything.

import { eventToAvatarState } from '../../shared/avatar';
import type { ActionEvent } from '../../shared/events';
import type { ActivityCue, CharacterDriver, CaptionSink } from '../character/types';
import type { ActionTimeline } from '../character/captions';
import { getCompanion, getBrain } from './bridge';

export interface SubscribeOptions {
  character: CharacterDriver;
  timeline: ActionTimeline;
  /**
   * Optional captions sink. When present, the brain's narration ('message'
   * events) and the agent's final summary ('run.completed' finalText) are shown
   * as assistant caption lines — this is what makes the text-input turn readable
   * on screen without a Vapi voice call.
   */
  captions?: CaptionSink;
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const compact = (text: string, max = 28): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

function commandLabel(command: string): string {
  const trimmed = command.trim();
  if (/pytest|py\.test/.test(trimmed)) return 'running pytest';
  if (/npm\s+(test|run|start|install)/.test(trimmed)) return compact(`running ${trimmed.match(/npm\s+\S+/)?.[0] ?? 'npm'}`);
  if (/git\s+/.test(trimmed)) return compact(`running ${trimmed.match(/git\s+\S+/)?.[0] ?? 'git'}`);
  return 'running command';
}

function activityForEvent(e: ActionEvent): ActivityCue | null {
  switch (e.kind) {
    case 'run.started':
    case 'turn.started':
      return { kind: 'command', text: 'starting' };
    case 'reasoning':
      return { kind: 'thinking', text: 'thinking' };
    case 'command':
      if (e.status === 'failed') return { kind: 'error', text: 'command failed' };
      if (e.status === 'completed') return { kind: 'success', text: e.exitCode === 0 ? 'command passed' : 'command finished' };
      return { kind: 'command', text: commandLabel(e.command) };
    case 'file_change': {
      const file = e.files.length === 1 ? basename(e.files[0].path) : `${e.files.length} files`;
      if (e.status === 'failed') return { kind: 'error', text: `could not edit ${file}` };
      return { kind: 'edit', text: `${e.status === 'completed' ? 'changed' : 'editing'} ${file}` };
    }
    case 'tool': {
      if (e.status === 'failed') return { kind: 'error', text: `${e.tool} failed` };
      const tool = e.tool.toLowerCase();
      if (tool.includes('read') || tool.includes('search') || tool.includes('fetch')) {
        return { kind: 'read', text: e.summary ? compact(e.summary) : 'reading' };
      }
      return { kind: 'command', text: e.summary ? compact(e.summary) : compact(e.tool) };
    }
    case 'message':
      if (e.text.startsWith('Insforge memory')) {
        return { kind: 'memory', text: e.text.includes('no prior') ? 'checking memory' : 'recalled memory' };
      }
      return null;
    case 'run.completed':
      return { kind: 'success', text: 'done' };
    case 'run.failed':
      return { kind: 'error', text: 'stuck' };
    case 'message.delta':
      return null;
  }
}

export function subscribeActionEvents(opts: SubscribeOptions): () => void {
  const { character, timeline, captions } = opts;
  const unsubs: Array<() => void> = [];
  // Accumulates DeepSeek reasoning_content deltas for the current turn so the
  // otherwise-silent decide phase shows live proof-of-life. Reset when the turn's
  // narration / final summary lands (see the message / run.completed branch).
  let reasoningBuf = '';

  const companion = getCompanion();
  if (companion?.onActionEvent) {
    unsubs.push(
      companion.onActionEvent((e: ActionEvent) => {
        const next = eventToAvatarState(e);
        // null => leave the avatar in its current state.
        if (next !== null) character.setState(next);
        const activity = activityForEvent(e);
        if (activity) character.setActivity(activity);
        timeline.append(e);
        // Surface narration + final summary as assistant caption lines so the
        // text-input turn is legible without Vapi TTS.
        if (captions) {
          if (e.kind === 'message' && e.text) {
            reasoningBuf = ''; // turn's spoken line has landed; end the live-reasoning view
            captions.update('assistant', e.text, true);
          } else if (e.kind === 'run.completed' && e.finalText) {
            reasoningBuf = '';
            captions.update('assistant', e.finalText, true);
          }
        }
      }),
    );
  } else {
    console.warn('[events] Nero bridge unavailable: window.companion.onActionEvent missing.');
  }

  if (companion?.onRunEnd) {
    unsubs.push(
      companion.onRunEnd(({ runId }) => {
        timeline.marker(`— run ended: ${runId} —`);
        // Settle back to listening if a call is up, else idle. The state machine
        // is idempotent, so a redundant set is harmless. We pick 'idle' here and
        // let Voice's speech/listening transitions take over if a call is active.
      }),
    );
  }

  const brain = getBrain();
  if (brain?.onReasoning) {
    unsubs.push(
      brain.onReasoning((delta: string) => {
        // DeepSeek reasoning_content streams during decide() -> 'thinking' pose AND
        // a live caption so the decide phase isn't silent dead air. Show the tail
        // (most recent reasoning) labelled as Nebius for sponsor visibility.
        character.setState('thinking');
        character.setActivity({ kind: 'thinking', text: 'thinking' });
        if (captions) {
          reasoningBuf += delta;
          const tail =
            reasoningBuf.length > 240 ? '…' + reasoningBuf.slice(-240) : reasoningBuf;
          captions.update('assistant', `DeepSeek (Nebius) is reasoning: ${tail}`, false);
        }
      }),
    );
  }

  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch (err) {
        console.error('[events] unsubscribe failed', err);
      }
    }
    unsubs.length = 0;
  };
}
