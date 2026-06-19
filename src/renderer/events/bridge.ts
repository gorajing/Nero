// src/renderer/events/bridge.ts — narrow, defensive access to the preload bridges.
//
// We do NOT depend on src/types/companion.d.ts being present (another agent owns
// it). Instead we describe ONLY the members this component calls and reach them
// through a single cast. If companion.d.ts IS present its richer types apply
// elsewhere; here we keep our own minimal, self-sufficient view so this
// component's tsc is green in isolation.

import type { ActionEvent } from '../../shared/events';
import type { TurnInput } from '../../shared/ipc';

/** The slice of window.companion this component consumes. */
interface CompanionBridgeLike {
  onActionEvent(cb: (e: ActionEvent) => void): () => void;
  onRunEnd?(cb: (p: { runId: string }) => void): () => void;
  turnRun?(input: TurnInput): Promise<{ runId: string }>;
  /** Abort the most recent run when called with no id (orchestrator aborts the latest). */
  cancelTask?(runId?: string): Promise<void>;
}

/** The slice of window.brain this component consumes. */
interface BrainBridgeLike {
  onReasoning?(cb: (delta: string) => void): () => void;
}

interface BridgeWindow {
  companion?: CompanionBridgeLike;
  brain?: BrainBridgeLike;
}

function bridgeWindow(): BridgeWindow {
  // Single cast point. `unknown` first so this is valid no matter what (if
  // anything) the global Window already declares for these members.
  return window as unknown as BridgeWindow;
}

/** Returns window.companion if MAIN/preload has exposed it, else undefined. */
export function getCompanion(): CompanionBridgeLike | undefined {
  return bridgeWindow().companion;
}

/** Returns window.brain if MAIN/preload has exposed it, else undefined. */
export function getBrain(): BrainBridgeLike | undefined {
  return bridgeWindow().brain;
}
