import fs from 'node:fs';
import path from 'node:path';
import { generateId, nowMs, sha256, ChunkIntegrityError, StorageError, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'chunk-store' });

/**
 * Chunk storage — append-only binary length-prefixed records.
 * Per spec §6 (Technical Specification) and Phase 3 of the build plan.
 *
 * Record format:
 * [4 bytes: payload length][36 bytes: eventId][8 bytes: timestamp][N bytes: payload]
 *
 * Chunk rules:
 * - Configurable maximum size (default 64MB)
 * - Rotate on size or event-count threshold
 * - Closed chunks are immutable
 * - Chunk integrity verified with SHA-256
 *
 * Design decision: We use a simple binary format rather than a log-structured
 * storage library to minimize dependencies and keep the format auditable.
 */

export const CHUNK_HEADER_SIZE = 4 + 36 + 8; // length(4) + eventId(36) + timestamp(8)
export const DEFAULT_MAX_CHUNK_SIZE_BYTES = 64 * 1024 * 1024; // 64MB
export const DEFAULT_MAX_CHUNK_EVENTS = 10_000;

export interface ChunkInfo {
  chunkId: string;
  filePath: string;
  eventCount: number;
  sizeBytes: number;
  createdAt: number;
  closedAt?: number;
  sha256?: string;
}

export interface RawRecord {
  eventId: string;
  timestamp: number;
  payload: Buffer;
}

export interface ChunkRef {
  chunkId: string;
  offset: number;
  length: number;
}

export interface ChunkStoreOptions {
  baseDir: string;
  maxChunkSizeBytes?: number;
  maxChunkEvents?: number;
}

/**
 * Manages append-only binary chunk files.
 * Each repository/session has its own chunk store.
 */
export class ChunkStore {
  private readonly options: Required<ChunkStoreOptions>;
  private currentChunkId: string | null = null;
  private currentFilePath: string | null = null;
  private currentEventCount: number = 0;
  private currentSizeBytes: number = 0;

  constructor(options: ChunkStoreOptions) {
    this.options = {
      maxChunkSizeBytes: DEFAULT_MAX_CHUNK_SIZE_BYTES,
      maxChunkEvents: DEFAULT_MAX_CHUNK_EVENTS,
      ...options,
    };
    fs.mkdirSync(this.options.baseDir, { recursive: true });
  }

  /**
   * Append a raw record to the current chunk.
   * Returns the chunk reference (chunkId, offset, length) for SQLite indexing.
   * Automatically rotates chunks when thresholds are exceeded.
   */
  append(record: RawRecord): ChunkRef {
    this._ensureOpenChunk();

    const payloadLength = record.payload.byteLength;

    // Build the binary record
    const recordBuffer = Buffer.allocUnsafe(CHUNK_HEADER_SIZE + payloadLength);
    let offset = 0;

    // Write payload length (4 bytes, big-endian)
    recordBuffer.writeUInt32BE(payloadLength, offset);
    offset += 4;

    // Write eventId (36 bytes ASCII, padded if needed)
    const eventIdBytes = Buffer.from(record.eventId.padEnd(36, ' ').substring(0, 36), 'ascii');
    eventIdBytes.copy(recordBuffer, offset);
    offset += 36;

    // Write timestamp (8 bytes, big-endian — uses two 32-bit writes for JS compatibility)
    const ts = record.timestamp;
    recordBuffer.writeUInt32BE(Math.floor(ts / 0x100000000), offset);
    recordBuffer.writeUInt32BE(ts >>> 0, offset + 4);
    offset += 8;

    // Write payload
    record.payload.copy(recordBuffer, offset);

    const filePath = this.currentFilePath;
    if (filePath === null) throw new StorageError('No open chunk file');

    const fileOffset = this.currentSizeBytes;

    try {
      fs.appendFileSync(filePath, recordBuffer);
    } catch (e) {
      throw new StorageError(
        `Failed to append to chunk: ${String(e)}`,
        e instanceof Error ? e : undefined,
      );
    }

    const chunkId = this.currentChunkId;
    if (chunkId === null) throw new StorageError('No open chunk ID');

    const ref: ChunkRef = {
      chunkId,
      offset: fileOffset,
      length: recordBuffer.byteLength,
    };

    this.currentEventCount++;
    this.currentSizeBytes += recordBuffer.byteLength;

    // Rotate if thresholds exceeded
    if (
      this.currentSizeBytes >= this.options.maxChunkSizeBytes ||
      this.currentEventCount >= this.options.maxChunkEvents
    ) {
      this._closeCurrentChunk();
    }

    return ref;
  }

  /**
   * Read a raw record by chunk reference.
   * Performs direct byte-offset lookup — no scanning required.
   */
  read(ref: ChunkRef): RawRecord {
    const filePath = this._getChunkFilePath(ref.chunkId);

    if (!fs.existsSync(filePath)) {
      throw new ChunkIntegrityError(ref.chunkId, `Chunk file not found: ${filePath}`);
    }

    const fileHandle = fs.openSync(filePath, 'r');
    try {
      const recordBuffer = Buffer.allocUnsafe(ref.length);
      const bytesRead = fs.readSync(fileHandle, recordBuffer, 0, ref.length, ref.offset);

      if (bytesRead !== ref.length) {
        throw new ChunkIntegrityError(
          ref.chunkId,
          `Expected ${ref.length} bytes, read ${bytesRead}`,
        );
      }

      return this._parseRecord(ref.chunkId, recordBuffer);
    } finally {
      fs.closeSync(fileHandle);
    }
  }

  /**
   * Verify the integrity of a closed chunk using SHA-256.
   */
  verifyIntegrity(chunkId: string, expectedSha256: string): boolean {
    const filePath = this._getChunkFilePath(chunkId);
    try {
      const content = fs.readFileSync(filePath);
      const actual = sha256(content);
      return actual === expectedSha256;
    } catch {
      return false;
    }
  }

  /**
   * Compute SHA-256 of a chunk file (for integrity sealing).
   */
  computeChunkHash(chunkId: string): string {
    const filePath = this._getChunkFilePath(chunkId);
    const content = fs.readFileSync(filePath);
    return sha256(content);
  }

  /**
   * Close the current chunk explicitly (e.g., on shutdown).
   */
  closeCurrentChunk(): ChunkInfo | null {
    return this._closeCurrentChunk();
  }

  private _ensureOpenChunk(): void {
    if (this.currentChunkId === null) {
      this._openNewChunk();
    }
  }

  private _openNewChunk(): void {
    this.currentChunkId = generateId();
    this.currentFilePath = this._getChunkFilePath(this.currentChunkId);
    this.currentEventCount = 0;
    this.currentSizeBytes = 0;

    // Create the file (or truncate existing)
    fs.writeFileSync(this.currentFilePath, Buffer.alloc(0));
    log.debug('Opened new chunk', { chunkId: this.currentChunkId });
  }

  private _closeCurrentChunk(): ChunkInfo | null {
    if (this.currentChunkId === null) return null;

    const info: ChunkInfo = {
      chunkId: this.currentChunkId,
      filePath: this.currentFilePath ?? '',
      eventCount: this.currentEventCount,
      sizeBytes: this.currentSizeBytes,
      createdAt: nowMs(),
    };

    log.debug('Closed chunk', {
      chunkId: info.chunkId,
      eventCount: info.eventCount,
      sizeBytes: info.sizeBytes,
    });

    this.currentChunkId = null;
    this.currentFilePath = null;
    this.currentEventCount = 0;
    this.currentSizeBytes = 0;

    return info;
  }

  private _getChunkFilePath(chunkId: string): string {
    return path.join(this.options.baseDir, `${chunkId}.chunk`);
  }

  private _parseRecord(chunkId: string, buffer: Buffer): RawRecord {
    if (buffer.byteLength < CHUNK_HEADER_SIZE) {
      throw new ChunkIntegrityError(chunkId, `Record too small: ${buffer.byteLength} bytes`);
    }

    let offset = 0;

    const payloadLength = buffer.readUInt32BE(offset);
    offset += 4;

    const eventId = buffer.slice(offset, offset + 36).toString('ascii').trim();
    offset += 36;

    const tsHigh = buffer.readUInt32BE(offset);
    const tsLow = buffer.readUInt32BE(offset + 4);
    const timestamp = tsHigh * 0x100000000 + tsLow;
    offset += 8;

    if (buffer.byteLength < offset + payloadLength) {
      throw new ChunkIntegrityError(
        chunkId,
        `Payload length mismatch: expected ${payloadLength}, available ${buffer.byteLength - offset}`,
      );
    }

    const payload = buffer.slice(offset, offset + payloadLength);

    return { eventId, timestamp, payload };
  }
}
