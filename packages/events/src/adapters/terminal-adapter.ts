import type { AdapterEvent } from '../normalizer.js';
import { EventTypes, EventSources, EventVisibility } from '@context-workspace/protocol';

/**
 * Terminal adapter — converts terminal/command events into AdapterEvents.
 */

export type TerminalEventInput =
  | { op: 'started'; command: string }
  | { op: 'completed'; command: string; exitCode: number; preview?: string }
  | { op: 'failed'; command: string; exitCode: number; preview?: string };

export function normalizeTerminalEvent(event: TerminalEventInput): AdapterEvent {
  const typeMap = {
    started: EventTypes.COMMAND_STARTED,
    completed: EventTypes.COMMAND_COMPLETED,
    failed: EventTypes.COMMAND_FAILED,
  } as const;

  const exitCode = event.op !== 'started' ? event.exitCode : undefined;
  const preview = event.op !== 'started' ? event.preview : undefined;

  return {
    type: typeMap[event.op],
    source: EventSources.TERMINAL,
    visibility: event.op === 'started' ? EventVisibility.LOCAL : EventVisibility.REPOSITORY,
    payload: {
      kind: 'command',
      command: event.command,
      status: event.op,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(preview !== undefined ? { preview } : {}),
    },
  };
}
