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
import type { CharacterDriver, CaptionSink } from '../character/types';
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

export function subscribeActionEvents(opts: SubscribeOptions): () => void {
  const { character, timeline, captions } = opts;
  const unsubs: Array<() => void> = [];

  const companion = getCompanion();
  if (companion?.onActionEvent) {
    unsubs.push(
      companion.onActionEvent((e: ActionEvent) => {
        const next = eventToAvatarState(e);
        // null => leave the avatar in its current state.
        if (next !== null) character.setState(next);
        timeline.append(e);
        // Surface narration + final summary as assistant caption lines so the
        // text-input turn is legible without Vapi TTS.
        if (captions) {
          if (e.kind === 'message' && e.text) {
            captions.update('assistant', e.text, true);
          } else if (e.kind === 'run.completed' && e.finalText) {
            captions.update('assistant', e.finalText, true);
          }
        }
      }),
    );
  } else {
    console.warn('[events] window.companion.onActionEvent unavailable — avatar will not animate from executor events yet.');
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
      brain.onReasoning(() => {
        // R1 reasoning_content tokens stream -> 'thinking'. We don't render the
        // tokens here (the timeline shows 'reasoning' ActionEvents); we only gate
        // the animation so it fires even before the first reasoning ActionEvent.
        character.setState('thinking');
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
