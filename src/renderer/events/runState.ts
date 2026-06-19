// src/renderer/events/runState.ts — a tiny shared flag for "an executor run is in
// flight." Set from the ActionEvent stream (run.started -> true; run end -> false).
//
// Two consumers rely on it:
//   - voice/wireEvents: a Vapi/Daily error must NOT clobber the avatar to 'error'
//     while a coding run owns the avatar state.
//   - events/actionEvents: after a run ends, settle the avatar back to idle only
//     if no new run has started in the meantime.

let active = false;

export const runState = {
  get active(): boolean {
    return active;
  },
  set(v: boolean): void {
    active = v;
  },
};
