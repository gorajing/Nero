# Nero — Interaction Design Spec

**Status:** Proposed (for review) · **Date:** 2026-06-20 · **Owner:** Jin
**Supersedes:** the ad-hoc gesture handling in `src/renderer/bootstrap.ts::installFloatingWindowGesture`, the piecemeal "tap=pet / hold=talk" iterations, **and the interaction sections of the product-plan docs** — this is now the authoritative interaction document.

> This spec defines the **entire interaction model** for Nero — every way a user touches, summons, tasks, moves, mutes, and dismisses the pet, across every state — as one coherent system, so we stop patching gestures one at a time. It is the contract the implementation plans build against.

---

## 1. The problem we're solving

The floating cat's body is a single left-pointer event stream that was forced to carry **four** intents — pet, talk, move, mute — disambiguated only by **time and distance** (`holdMs=350`, `dragThresholdPx=4`, boolean latches in `installFloatingWindowGesture`). Every new need carved another timing slice out of the same pixels. Consequences observed in the current build:

- The pet-vs-billed-call boundary is **~20ms of dwell** across the 350ms mark — a lingering, affectionate press silently starts a paid Vapi call. Affection and the most expensive action share one motion.
- Talk churned (single-click → push-to-talk → toggle) because a **stateful mode** was being expressed through a **transient on-body gesture** that also collides with affection.
- The **reliable** trick (typed task → `turnRun`) lives only in a separate console window, while the **flaky** trick (Vapi voice) sits on the most prominent gesture (hold). The build inverted reliability and prominence.
- Cursor-gaze **pokes the activity timer on every cursor sample**, so the cat can never reach `asleep` and idle CPU is never near-zero (both regressions).

## 2. The governing law (the cure)

**Disambiguate by SURFACE + BUTTON + STATE — never by milliseconds.** Sort every intent on two axes and route it accordingly:

| Intent class | Definition | Home |
|---|---|---|
| **Continuous-physical & reversible** | has position/duration; feels like touching a creature (pet, pick-up-and-move) | **The cat's body** — no labels needed (reversibility makes a mis-gesture free) |
| **Named verb / command** | a labelled action with a result (task, talk, stop, mute, sleep, customize, quit) | **A command surface**: the right-click **Menu** ≡ the **Tray** ≡ (later) a **⌘K palette** — one mirrored command set, each item showing its shortcut |
| **Mode** | a sustained state you enter and leave (voice call, screen-watching) | A **deliberate toggle** with a persistent visible indicator — never a body gesture |

This law is **decidable for any future intent**: *Continuous-physical + reversible → body. Named verb → Menu/Tray (and ⌘K) + keyboard mirror. Mode → explicit toggle with visible state.* Adding a verb means adding a menu item, never another timing window.

**Safety corollary:** an action's *accidental-trigger probability* must be **inversely proportional** to its cost/irreversibility. Today this is inverted (the costliest action — a billed call — is the easiest to trigger). The model below fixes that: the costliest/destructive actions (start call, stop run, quit) are the hardest to trigger and the most clearly labelled.

## 3. The five micro-interaction laws (invariants enforced in code)

1. **Instant feedback** — every input produces a body response on the cat in **<100ms, before any network/agent work** (hearts on tap, ear-perk on hover, grab-pose on drag-start). Feedback is the cat's body, never a toast.
2. **Never-punish** — no input scolds, guilt-trips, or locks the user out. Errors get *comfort*: **petting an errored cat un-flattens its ears**.
3. **Always-reversible** — nothing consequential fires on a timer or on a release-you-didn't-mean. Start-work, start-voice, mute, hide are all explicit; **Stop is always reachable mid-work**.
4. **Always-pettable** — **a tap = pet, in every state** (asleep, idle, listening, thinking, working, done, error, in-call). The cat is always safe to touch; a tap never starts work, starts a call, hangs up a call, or cancels a run.
5. **One deliberate action to start work** — giving Nero a task is exactly one intentional act (submit the Ask input, or pick *Ask…* from the menu), routed to the reliable typed `turnRun`. Never a gesture, never voice-by-accident.

## 4. The three surfaces

### 4.1 The cat's body (the creature) — exactly four bindings, forever

| Input | Intent | Notes |
|---|---|---|
| **Left tap** (click, no drag) | **Pet** — instant hearts | Universal across all states (Law 4). No timer → instant. |
| **Left press-and-hold** (no movement) | **Sustained petting** — more hearts / purr | *Affection only — NOT a mode, NOT a menu.* This deliberately keeps the primary button free of any timing-based mode switch (the root cause of the churn). |
| **Left drag** (past threshold) | **Move the window** | Only ever move. Never cancels a run/call. Single drag implementation (the JS `moveWindowBy` path). |
| **Hover / cursor over the cat** | **Attention** (passive) | Eyes track the cursor (gaze, already built); ears perk; the Ask affordance fades in. No command — never an accidental trigger. |
| **Right-click** (= control-click / two-finger tap on macOS) | **Open the Menu** (§4.2) | The *only* way a verb is expressed via the cat. Replaces today's right-click=mute. |

**Rule:** the body never gains a fifth meaning. Any proposal to add one is a smell — route it to the Menu/Tray/keyboard instead. *Double-tap stays unbound* (reserved as future affection headroom, e.g. a "favorite trick").

### 4.2 The command surface — one menu, state-aware, mirrored to Tray and ⌘K

The same command set is reachable three ways (right-click Menu, Tray, and later a ⌘K palette) so **no capability is ever reachable only through a hidden gesture**. Items are **filtered and labelled by the cat's current state** (full table in §8):

- **Ask Nero a task…** — focuses the Ask input (the killer trick; §5).
- **Talk** — toggle a voice conversation (§6). Off by default.
- **Stop the run** — abort the in-flight executor run (`cancelTask`); shown **only while working**, with a confirm; **greyed in `thinking`** (matches the real "Stop is a lie before the executor registers" truth in `bootstrap.ts`).
- **End call** — shown only while in-call; the labelled exit from a voice call.
- **Mute / Unmute** — with current state shown (checkmark); keeps the ⌘⇧M global.
- **Sleep / Do Not Disturb** — manual override of the automatic idle→asleep energy model.
- **Let Nero see my screen…** — screen-vision consent toggle (deferred to Pillar 4; listed for completeness).
- **What Nero knows…** — open the memory panel (deferred to Pillar 2).
- **Customize Nero…** — name/appearance (deferred).
- **Open console** — the windowed surface (timeline, full prompt).
- **Hide** — dismiss the window (≡ ⌘⇧Space).
- **Quit Nero** — **Tray only** (never on the cat), plus ⌘Q.

Each item shows its keyboard accelerator inline, so the Menu doubles as the self-documenting index of the shortcut layer.

### 4.3 The keyboard (power-user mirror — never owns, always mirrors)

| Shortcut | Intent | Status |
|---|---|---|
| **⌘⇧Space** | Summon / hide the window **+ focus the Ask input** | Exists (summon); extend to also focus Ask |
| **⌘⇧M** | Mute / unmute | Exists |
| **Esc** | Stop the run / dismiss the Ask input (only when Nero is focused) | New |
| **⌘K** | Command palette (the developer-native "do anything") | Later (Phase E) |
| **⌘Q** | Quit | Standard |

Every shortcut has a visible twin in the Menu/Tray showing its accelerator — that is how the hidden power-user layer stays discoverable without cluttering the cat.

## 5. The Ask input — the killer trick, local and typed-first

**The single biggest fix.** The floating cat gets its **own task entry** so it no longer has to context-switch to the console window for its killer trick:

- A **slim text affordance fades in just below the cat** on hover or summon (a one-line "Ask Nero…" input). It is a **separate element from the cat body** — so *tapping the cat = pet*, *clicking/typing the input = task*. No conflict.
- **Enter** dispatches the typed instruction to the reliable **`turnRun`** path (recall → decide → executor); the cat animates `thinking → working → done` and narrates, exactly as the console path does today.
- It is **focused by ⌘⇧Space** (summon-and-task in one chord) and by the Menu's **Ask…** item.
- **Mid-run**, submitting a new task surfaces **"Stop current & start this?"** — never silently queues or kills (honors the existing one-turn-at-a-time guard + Law 3).

This corrects the reliability inversion: the **reliable typed path becomes the prominent, local, default** way to task Nero; voice becomes an opt-in.

## 6. Voice (Talk) — a deliberate toggle, off the body

Voice (Vapi) is deprioritized and historically flaky, so:

- **Talk is an explicit toggle**, reachable only from the Menu / Tray / ⌘K — **never a body gesture**. This permanently ends the hold-to-talk saga.
- Entering Talk puts the cat into a **persistent, unmistakable "on a call" state** (a visible tell); you **barge-in by speaking** (Vapi VAD); you leave via the Menu's **End call** (top item while in-call) or ⌘⇧Space.
- **Tap still pets during a call** and never hangs up (Law 4).
- **Idle-silence auto-timeout**: a forgotten call auto-ends after N seconds of silence so it can't bill indefinitely.
- **Off by default** in v1: present but not prominent, so its flakiness never shapes the core loop.

## 7. The full input → intent grammar (binding table)

| Surface | Input | Intent | Reversible? | Cost |
|---|---|---|---|---|
| Body | Left tap | Pet | n/a (free) | none |
| Body | Left hold (still) | Sustained pet | n/a | none |
| Body | Left drag | Move window | yes (drag back) | none |
| Body | Hover | Attention/gaze + reveal Ask | n/a | none |
| Body | Right-click | Open Menu | yes (preview) | none |
| Ask | Type + Enter | Give a coding task (`turnRun`) | mid-run confirm | agent run |
| Menu/Tray | Talk | Toggle voice call | yes (End call) | billed minutes |
| Menu | Stop the run (working only) | Abort run (`cancelTask`) | **no** (confirm required) | loses partial work |
| Menu/Tray/⌘⇧M | Mute | Toggle mic mute (visible tell) | yes | none |
| Menu/Tray | Sleep / DND | Suppress activity | yes | none |
| Menu/Tray | Hide / ⌘⇧Space | Show/hide window | yes | none |
| Tray / ⌘Q | Quit | Quit app | n/a | ends session |

## 8. States × gestures matrix (one creature, context-aware reactions)

**Invariant:** each *input* keeps **one intent** across all states; the **state only colors the cat's reaction** and which **Menu items** are offered. This is what makes it read as one creature, not a mode-switch panel.

| State | Tap | Hover | Right-click → Menu shows | Drag | Typed task | Auto-behavior |
|---|---|---|---|---|---|---|
| **asleep** | wake + pet (stretch→blink→hearts) | one ear lifts, slow-blink toward cursor; → drowsy | Wake · Do Not Disturb · Quit | wake-to-carry, move | wakes → thinking | — |
| **idle (awake)** | pet, hearts, tail-flick | gaze locks, ears perk, **Ask fades in** | Ask… · Talk · Mute · Sleep/DND · Hide · Settings · Quit | grab→move→settle | → thinking → working | drowsy→asleep after 45s/2min |
| **listening / in-call** | pet (does **not** hang up) | gaze + "hearing you" pulse | **End call** · Mute · Hide | move; call continues | works (text+voice coexist) | idle-silence auto-timeout |
| **thinking** | pet over amber aura (no interrupt) | gaze flicks to you then back | *Stop (greyed)* · Mute · Hide | move; keeps thinking | "replace current?" | bounded by brain timeout |
| **working** | pet over working aura (**never cancels**) | gaze up then back; **Stop affordance fades in** | **Stop the run** (confirm) · What's it doing? · Mute · Hide | move; run continues | "Stop current & start this?" | — |
| **done** | pet, hearts pile on celebration | green-check holds a beat | Ask again · Mute · Hide | move | starts next turn | **self-decays to idle ~4s**, then sleeps |
| **error** | **pet = comfort** (ears un-flatten) | "what happened?" hint fades in | Try again · Show what happened · Mute · Hide | move | re-ask clears error → thinking | **self-decays to idle ~4s** |

**No dead-ends:** every state has an input that advances it; every input wakes the cat (poke); both terminal states (done/error) self-decay to idle so the user never has to dismiss them. Barge-in (Stop) is always reachable while working.

## 9. The Tray (menubar) — discoverability + safety backstop

Ship the planned Tray as the **always-available** home for ambient state and the actions that must never be a gesture. It mirrors the Menu command set and adds the things that need to work **when the cat is hidden or asleep**:

- Show / Hide Nero · Sleep / Wake (DND) · Mute (with checkmark) · Let Nero see my screen… · What Nero knows… · Open console · Settings · **Quit Nero** (lives **only** here).
- Left-click the Tray icon opens this menu (macOS convention); show/hide stays on ⌘⇧Space.
- The Tray makes a hidden floating window discoverable again and is the anti-Clippy escape hatch (there is *always* a one-action way out).

## 10. Discoverability & onboarding

Solved **structurally**, not with a tooltip pile:

1. **First-run onboarding** (the planned "adopt + name" ritual) teaches the only two things that aren't self-evident: **tap = pet** (you'll click the cute thing → hearts) and **right-click / ⌘⇧Space for everything else**. ~30 seconds, because the body grammar is tiny.
2. The **Menu and Tray are the self-documenting index** of every verb, each with its shortcut shown inline.
3. The cat **teaches by reaction** — hover reveals the Ask affordance; a mis-gesture is harmless and instructive (Law 2/3).
4. **No coachmark** for anything already visible in a menu; never style help like a real widget.

## 11. Anti-Clippy invariants (hard rules)

The pet bond dies the instant the creature feels in control of the user. Non-negotiable:

- **Never steal the cursor or focus.** Never capture the user's input device.
- **Never interrupt unprompted.** The cat is quiet/ambient by default; loud only when you act on it or it's mid-task you started.
- **Dismiss/hide is always one action**, always available (⌘⇧Space + Tray).
- **Sleep / Do Not Disturb is first-class** and easy to reach.

## 12. Bugs fixed as part of this work (grounded in the current code)

| Bug | Where | Fix |
|---|---|---|
| **Cat can never sleep + idle CPU not near-zero** — gaze pokes the activity timer on every ~90ms cursor sample | `bootstrap.ts` `onCursor → driver.poke()`; `window.ts` cursor poll; `activity.ts` thresholds | **Cursor drives gaze ONLY** (drop the poke). Poke only on *real intent* (pet, summon, task-submit, explicit wake). **Freeze gaze when asleep.** |
| **Lingering pet → billed call** (~20ms dwell boundary) | `bootstrap.ts` `installFloatingWindowGesture` hold-timer | **Delete the hold-to-talk timer.** Hold = sustained pet. |
| **Two drag implementations fight** | `index.css` body `app-region: drag` + `bootstrap.ts` JS `moveWindowBy` | Keep the **JS drag only**; remove the CSS app-region drag. |
| **Cancel unreachable from the cat** | only the console Stop button exists | **Stop in the working-state Menu** (maps to existing `cancelTask`). |
| **Mute state invisible** | `driver.setMuted` exists, no persistent tell | **Persistent muted badge** on the cat in every state. |
| **Bare `m` key has no focus guard** | `bootstrap.ts` document keydown | Focus-guard or remove; keep ⌘⇧M global. |
| **Voice call can't be exited cleanly / bills forever** | `voice/index.ts` | Explicit **End call** + **idle auto-timeout** + persistent "on a call" tell. |
| **Temp sleep thresholds** (4s/10s) left in for testing | `activity.ts` | **Revert to 45_000 / 120_000.** |
| **Frame governor ignores `inCall`** — `framePolicy(visible, energy, busy)` never sees `inCall`, so an *idle voice call* throttles the cat to sleep-fps (6) while the pose stays awake (caught in audit) | `avatar.ts` ticker / `framePolicy.ts` | **Feed `inCall` into the policy** — treat `busy ∥ inCall` as keep-full-rate — or set `busy` for the duration of a call. |
| **done/error can strand the cat** | avatar state handling | **Self-decay to idle ~4s** after a terminal state. |

## 13. What changes vs. the current code (concrete)

- **`src/renderer/bootstrap.ts`** — rewrite `installFloatingWindowGesture`: body = `tap/hold → pet`, `drag → move` (single threshold), `right-click → open Menu`. **Delete** `onToggleTalk`/hold-timer and the `FloatingGestureHandlers.onToggleTalk` interface. Change `onCursor` wiring to **gaze only (no poke)**. Remove/guard the bare `m` keydown. Add Ask-input wiring + the summon-chord-focuses-Ask behavior.
- **`src/renderer/character/avatar.ts` / `driver.ts` / `types.ts`** — freeze gaze when `asleep`; ensure a persistent muted tell in all states; add done/error→idle self-decay; (the `pet/poke/setBusy/setInCall/setGaze` facade stays).
- **`src/renderer/character/activity.ts`** — revert `DEFAULTS` to `{ drowsyMs: 45_000, asleepMs: 120_000 }`.
- **`src/main/window.ts`** — keep the global cursor poll (gaze source); ensure it pauses when hidden; (proximity-gating optional, deferred).
- **`src/index.css`** — remove the body `-webkit-app-region: drag`.
- **New (renderer): Ask input** — a slim input in the floating window, wired to `turnRun`, with the mid-run "stop current & start this?" prompt.
- **New (main): context Menu** — built via Electron `Menu.popup()` from MAIN over IPC, items computed from the cat's current state; replaces the renderer right-click=mute handler.
- **New (main): Tray** — Electron `Tray` in `main.ts` with the mirrored command set; Quit lives here.

## 14. Decisions (resolved — flip any during review)

| # | Decision | Resolution (recommended) |
|---|---|---|
| 1 | How you task the cat from the floating surface | **A local "Ask" input** that fades in below the cat → `turnRun`. (vs. console-only.) |
| 2 | Tap purity | **Tap = pet only.** Ask reached via hover-reveal + ⌘⇧Space + Menu. (Not "click opens Ask.") |
| 3 | Voice in v1 | **"Talk" as an off-by-default Menu/Tray toggle.** Not removed; not prominent. |
| 4 | Menu form | **Native context menu (right-click) in v1**; charming radial later — identical model. |
| 5 | Click-through | **Defer.** Ship always-click-receiving v1; design the silhouette-hit re-enable for later. |
| 6 | Long-press meaning | **Sustained petting** (not "open menu"); the Menu is strictly on right-click — keeps the primary button timing-free. |

## 15. Scope & phasing (each phase its own implementation plan)

- **Phase A — The deletion + the fixes** *(first; mostly removal, high value, low risk)*: rewrite the gesture handler (tap/hold=pet, drag=move; **right-click temporarily keeps mute** until the Menu lands in Phase C), **decouple gaze from poke** (fixes sleep + idle), revert temp thresholds, single drag path (remove the CSS `app-region: drag`), persistent mute badge, **feed `inCall` into `framePolicy`**, done/error self-decay, and **update `README.md` / `RUN.md`** (window is 380×400 not 420×460; tap=pet, not click=voice) to point at this spec.
- **Phase B — The Ask input**: the floating task entry → `turnRun` (+ ⌘⇧Space focuses it; mid-run confirm). Closes the deepest seam.
- **Phase C — The context Menu**: state-aware right-click Menu (Ask, Talk, Stop[working], Mute, Sleep/DND, Hide, Quit-not-here) + Stop-from-cat.
- **Phase D — The Tray**: menubar Tray mirroring the Menu; Quit; show/hide; mute-with-state.
- **Phase E — Later**: ⌘K palette, radial menu, click-through silhouette hit-testing, eyes/screen-consent, memory panel, customize.

## 16. Success criteria (acceptance — verify in the running app, not just types)

1. **Tap is instant pet** in every state (no 350ms delay); **repeated tapping never starts a call**; tapping a working/in-call/error cat pets and never cancels/hangs-up.
2. **Drag moves**; a sub-threshold press never drags; a press that doesn't move always pets; only one drag path is active.
3. **Right-click opens a menu whose items match the cat's state** (Stop only while working and greyed while thinking; End call only while in-call; no Talk while asleep).
4. **The cat actually reaches `asleep`** when you stop interacting *with it* (even while you keep using your editor), and **idle CPU is near-zero** when asleep/occluded.
5. **A typed task from the floating Ask** drives the cat thinking→working→done and narrates — without opening the console window.
6. **No consequential action fires on a timer or release**; **Stop is reachable from the cat while working**; **mute state is always visible**.
7. **done/error self-decay to idle**; nothing strands the cat.

## 17. Open questions (resolve before/within Phase B–C)

- Idle-silence auto-timeout for a voice call: 30s or 60s?
- Ask input: dismiss on blur, on Esc, or persist a small "tasked" history line?
- Does hovering *over the cat* (cursor on its silhouette) count as light attention that keeps it from sleeping, or only deliberate pet/summon/task? (Recommendation: only deliberate interactions poke; cursor-over-cat optionally keeps it `drowsy` not `asleep` — defer.)
- Stop-the-run confirm: inline two-step in the menu, or a tiny confirm bubble on the cat?
