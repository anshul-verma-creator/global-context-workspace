/**
 * Large content reference — used when payload content exceeds inline threshold.
 * Raw content is stored in local chunk files (runtime) or object storage (cloud).
 * The event references the location, not the content.
 *
 * Per spec §4 (Technical Specification): Do not embed large raw content in events.
 */
export interface LargeContentRef {
  /** Opaque reference ID — chunk file + offset, or cloud object key */
  rawRef: string;
  /** MIME type of the content */
  contentType: string;
  /** Size of the raw content in bytes */
  sizeBytes: number;
  /** SHA-256 of the raw content for integrity verification */
  sha256: string;
  /** Short human-readable preview (first N chars / lines) */
  preview?: string;
}

/**
 * Threshold in bytes above which content is stored as a LargeContentRef
 * rather than inlined in the event payload.
 */
export const LARGE_CONTENT_THRESHOLD_BYTES = 4096;
