// src/shared/ipc.ts — ALL IPC channel names (the const CH) + small shared payload types. Imported by main + preload.
// invoke = request/response; push = MAIN->renderer webContents.send (streams; invoke can't stream).
export type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
export interface TurnInput { transcript: string; sessionId: string }

export const CH = {
  micStatus: 'mic:status', micRequest: 'mic:request',
  windowMoveBy: 'window:moveBy',
  micToggleMute: 'mic:toggleMute',
  turnRun: 'turn:run', runTask: 'orch:runTask', cancelTask: 'orch:cancelTask',
  actionEvent: 'orch:actionEvent', runEnd: 'orch:runEnd',
  brainDecide: 'brain:decide', brainReasoning: 'brain:reasoning', brainContent: 'brain:content',
  brainDescribeScreen: 'brain:describeScreen', brainEmbed: 'brain:embed',
  visionAsk: 'vision:ask', memoryRemember: 'memory:remember', memoryRecall: 'memory:recall',
} as const;
