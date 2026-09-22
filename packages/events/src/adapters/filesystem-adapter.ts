import type { AdapterEvent } from '../normalizer.js';
import { EventTypes, EventSources, EventVisibility } from '@context-workspace/protocol';

/**
 * Filesystem adapter — converts filesystem watcher events into AdapterEvents.
 *
 * Per spec §4 (Workflow): IDE file activity captured.
 */

export interface FsWatchEvent {
  type: 'created' | 'modified' | 'deleted' | 'read';
  path: string;
  timestamp?: number;
}

export function normalizeFsEvent(event: FsWatchEvent): AdapterEvent {
  const typeMap = {
    created: EventTypes.FILE_CREATED,
    modified: EventTypes.FILE_MODIFIED,
    deleted: EventTypes.FILE_DELETED,
    read: EventTypes.FILE_READ,
  } as const;

  const visibilityMap = {
    created: EventVisibility.REPOSITORY,
    modified: EventVisibility.REPOSITORY,
    deleted: EventVisibility.REPOSITORY,
    read: EventVisibility.LOCAL,
  } as const;

  return {
    type: typeMap[event.type],
    source: EventSources.FILESYSTEM,
    visibility: visibilityMap[event.type],
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
    payload: {
      kind: 'file',
      path: event.path,
      operation: event.type,
    },
  };
}
