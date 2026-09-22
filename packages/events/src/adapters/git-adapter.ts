import type { AdapterEvent } from '../normalizer.js';
import { EventTypes, EventSources, EventVisibility } from '@context-workspace/protocol';

/**
 * Git adapter — converts Git hook/watch events into AdapterEvents.
 * Per spec §4 (Workflow): Git branch, checkout, commit, merge/rebase captured.
 */

export type GitOperation =
  | { op: 'branch_changed'; branch: string; fromBranch?: string }
  | { op: 'checkout'; branch: string; commitSha?: string }
  | { op: 'commit'; commitSha: string; message?: string; branch?: string }
  | { op: 'merge'; fromBranch: string; toBranch: string; commitSha?: string }
  | { op: 'rebase'; fromBranch: string; toBranch: string };

export function normalizeGitEvent(operation: GitOperation): AdapterEvent {
  const typeMap = {
    branch_changed: EventTypes.GIT_BRANCH_CHANGED,
    checkout: EventTypes.GIT_CHECKOUT,
    commit: EventTypes.GIT_COMMIT,
    merge: EventTypes.GIT_MERGE,
    rebase: EventTypes.GIT_REBASE,
  } as const;

  const branch = 'branch' in operation ? operation.branch : undefined;
  const commitSha = 'commitSha' in operation ? operation.commitSha : undefined;
  const message = 'message' in operation ? operation.message : undefined;
  const fromBranch = 'fromBranch' in operation ? operation.fromBranch : undefined;
  const toBranch = 'toBranch' in operation ? operation.toBranch : undefined;

  return {
    type: typeMap[operation.op],
    source: EventSources.GIT,
    visibility: EventVisibility.REPOSITORY,
    payload: {
      kind: 'git',
      operation: operation.op,
      ...(branch !== undefined ? { branch } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(fromBranch !== undefined ? { fromBranch } : {}),
      ...(toBranch !== undefined ? { toBranch } : {}),
    },
  };
}
