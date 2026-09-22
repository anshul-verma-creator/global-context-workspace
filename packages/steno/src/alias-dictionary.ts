import { nowMs } from '@context-workspace/shared';

/**
 * Alias dictionary for Steno.
 *
 * Per spec §17 (Technical Specification):
 * - alias only after a configurable repetition threshold
 * - do not alias short/common strings
 * - dictionary changes must be versioned
 * - stable within capsule/session scope
 *
 * Design decision: We only alias long entity values (>20 chars) that
 * appear multiple times. Aliasing short strings wastes tokens.
 */

export interface AliasEntry {
  alias: string;
  canonicalValue: string;
  scope: 'capsule' | 'session' | 'repository';
  createdAt: number;
  version: number;
  usageCount: number;
}

export interface AliasDictionary {
  version: number;
  scope: string;
  entries: Map<string, AliasEntry>; // alias → entry
  reverseMap: Map<string, string>;   // canonicalValue → alias
}

/** Minimum string length before aliasing is considered. */
const MIN_ALIAS_LENGTH = 20;
/** Minimum repetition count before aliasing. */
const DEFAULT_REPETITION_THRESHOLD = 3;

export class AliasDictionaryManager {
  private readonly dict: AliasDictionary;
  private readonly repetitionThreshold: number;
  private readonly candidateCounts = new Map<string, number>();
  private aliasCounter = 0;

  constructor(
    scope: string,
    initialVersion: number = 1,
    repetitionThreshold: number = DEFAULT_REPETITION_THRESHOLD,
  ) {
    this.dict = {
      version: initialVersion,
      scope,
      entries: new Map(),
      reverseMap: new Map(),
    };
    this.repetitionThreshold = repetitionThreshold;
  }

  /**
   * Record a string value being used.
   * If it exceeds the repetition threshold, an alias is created.
   * Returns the alias if one exists, otherwise the original value.
   */
  recordUsage(value: string): string {
    // Don't alias short strings
    if (value.length < MIN_ALIAS_LENGTH) return value;

    // Check if already aliased
    const existing = this.dict.reverseMap.get(value);
    if (existing !== undefined) {
      const entry = this.dict.entries.get(existing);
      if (entry !== undefined) {
        entry.usageCount++;
      }
      return existing;
    }

    // Track candidate
    const count = (this.candidateCounts.get(value) ?? 0) + 1;
    this.candidateCounts.set(value, count);

    if (count >= this.repetitionThreshold) {
      return this._createAlias(value);
    }

    return value;
  }

  /**
   * Resolve an alias back to its canonical value.
   */
  resolve(alias: string): string {
    return this.dict.entries.get(alias)?.canonicalValue ?? alias;
  }

  /**
   * Get all current alias entries.
   */
  getEntries(): Map<string, AliasEntry> {
    return this.dict.entries;
  }

  /** Current dictionary version. */
  get version(): number {
    return this.dict.version;
  }

  /** Export the dictionary for persistence/transmission. */
  export(): Array<[string, AliasEntry]> {
    return [...this.dict.entries.entries()];
  }

  /** Import a previously exported dictionary. */
  import(entries: Array<[string, AliasEntry]>): void {
    for (const [alias, entry] of entries) {
      this.dict.entries.set(alias, entry);
      this.dict.reverseMap.set(entry.canonicalValue, alias);
    }
    this.dict.version++;
  }

  private _createAlias(value: string): string {
    this.aliasCounter++;
    const alias = `~${this.aliasCounter}`;

    const entry: AliasEntry = {
      alias,
      canonicalValue: value,
      scope: 'session',
      createdAt: nowMs(),
      version: this.dict.version,
      usageCount: this.repetitionThreshold,
    };

    this.dict.entries.set(alias, entry);
    this.dict.reverseMap.set(value, alias);
    this.dict.version++;

    return alias;
  }
}
