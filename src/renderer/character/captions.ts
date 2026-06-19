// src/renderer/character/captions.ts — the live captions line + action timeline.
//
// Two DOM-backed views, both fed by the rest of the renderer:
//   - CaptionPanel implements CaptionSink: shows the current user/assistant
//     transcript line (partial updates in place; final lines are committed).
//   - ActionTimeline: an append-only log of ActionEvents (and run-end markers).
//
// All DOM ids are looked up once; missing elements are tolerated (the panel just
// no-ops) so this is safe to construct before the DOM is fully built.

import type { CaptionSink } from './types';
import type { ActionEvent } from '../../shared/events';

export class CaptionPanel implements CaptionSink {
  private partialEl: HTMLElement | null;
  private finalEl: HTMLElement | null;

  constructor(partialId = 'caption-partial', finalId = 'caption-final') {
    this.partialEl = document.getElementById(partialId);
    this.finalEl = document.getElementById(finalId);
  }

  update(role: 'user' | 'assistant', text: string, isFinal: boolean): void {
    const line = `${role === 'user' ? 'You' : 'Companion'}: ${text}`;
    if (isFinal) {
      if (this.finalEl) this.finalEl.textContent = line;
      if (this.partialEl) this.partialEl.textContent = '';
    } else if (this.partialEl) {
      this.partialEl.textContent = line;
    }
  }
}

function summarizeEvent(e: ActionEvent): { label: string; detail: string; status?: string } {
  switch (e.kind) {
    case 'run.started':
      return { label: `${e.agent === 'claude' ? 'Claude' : 'Codex'} agent started`, detail: e.runId };
    case 'turn.started':
      return { label: 'turn.started', detail: e.runId };
    case 'reasoning':
      return { label: 'DeepSeek reasoning (Nebius)', detail: e.text };
    case 'command':
      return { label: 'command', detail: e.command, status: e.status };
    case 'file_change':
      return {
        label: 'file_change',
        detail: e.files.map((f) => `${f.op} ${f.path}`).join(', '),
        status: e.status,
      };
    case 'tool':
      return { label: `tool: ${e.tool}`, detail: e.summary ?? '', status: e.status };
    case 'message.delta':
      return { label: 'message.delta', detail: e.text };
    case 'message':
      return { label: 'message', detail: e.text };
    case 'run.completed':
      return { label: 'run.completed', detail: e.finalText ?? '', status: 'completed' };
    case 'run.failed':
      return { label: 'run.failed', detail: `Agent hit an error — ${e.error.slice(0, 200)}`, status: 'failed' };
    default: {
      // Exhaustiveness guard: if a new ActionEvent kind is added, this errors.
      const _never: never = e;
      return { label: 'event', detail: String(_never) };
    }
  }
}

export class ActionTimeline {
  private listEl: HTMLElement | null;
  private readonly max: number;

  constructor(listId = 'timeline', max = 200) {
    this.listEl = document.getElementById(listId);
    this.max = max;
  }

  append(e: ActionEvent): void {
    if (!this.listEl) return;
    const { label, detail, status } = summarizeEvent(e);
    const row = document.createElement('div');
    row.className = 'timeline-row' + (status ? ` status-${status}` : '');

    const time = new Date(e.ts).toLocaleTimeString();
    const kindEl = document.createElement('span');
    kindEl.className = 'tl-kind';
    kindEl.textContent = status ? `${label} [${status}]` : label;

    const detailEl = document.createElement('span');
    detailEl.className = 'tl-detail';
    detailEl.textContent = detail;

    const timeEl = document.createElement('span');
    timeEl.className = 'tl-time';
    timeEl.textContent = time;

    row.append(timeEl, kindEl, detailEl);
    this.listEl.prepend(row); // newest first
    this.trim();
  }

  marker(text: string): void {
    if (!this.listEl) return;
    const row = document.createElement('div');
    row.className = 'timeline-row status-marker';
    row.textContent = text;
    this.listEl.prepend(row);
    this.trim();
  }

  private trim(): void {
    if (!this.listEl) return;
    while (this.listEl.childElementCount > this.max) {
      this.listEl.lastElementChild?.remove();
    }
  }
}
