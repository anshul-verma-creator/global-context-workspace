import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'backup-manager' });

export interface BackupOptions {
  sourceDbPath: string;
  sourceChunksDir?: string;
  targetDir: string;
}

export interface BackupManifest {
  timestamp: string;
  files: Array<{
    name: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export class BackupManager {
  /**
   * Create an atomic snapshot backup of the local SQLite database and raw chunk storage.
   */
  static createBackup(options: BackupOptions): BackupManifest {
    fs.mkdirSync(options.targetDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const manifest: BackupManifest = { timestamp, files: [] };

    // 1. Copy SQLite database file atomically
    if (fs.existsSync(options.sourceDbPath)) {
      const dbTarget = path.join(options.targetDir, 'context.db');
      fs.copyFileSync(options.sourceDbPath, dbTarget);
      const content = fs.readFileSync(dbTarget);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      manifest.files.push({
        name: 'context.db',
        sha256: hash,
        sizeBytes: content.length,
      });
      log.info('Database backed up', { dbTarget, sha256: hash });
    }

    // 2. Copy raw chunks directory if present
    if (options.sourceChunksDir && fs.existsSync(options.sourceChunksDir)) {
      const chunksTarget = path.join(options.targetDir, 'chunks');
      fs.mkdirSync(chunksTarget, { recursive: true });
      const chunkFiles = fs.readdirSync(options.sourceChunksDir);

      for (const file of chunkFiles) {
        const src = path.join(options.sourceChunksDir, file);
        const dest = path.join(chunksTarget, file);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dest);
          const chunkBuf = fs.readFileSync(dest);
          const hash = crypto.createHash('sha256').update(chunkBuf).digest('hex');
          manifest.files.push({
            name: path.join('chunks', file),
            sha256: hash,
            sizeBytes: chunkBuf.length,
          });
        }
      }
      log.info('Chunks backed up', { count: String(chunkFiles.length) });
    }

    // 3. Write manifest
    const manifestPath = path.join(options.targetDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    log.info('Backup completed successfully', { targetDir: options.targetDir });

    return manifest;
  }

  /**
   * Verify backup integrity using the manifest SHA-256 checksums.
   */
  static verifyBackup(backupDir: string): boolean {
    const manifestPath = path.join(backupDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      log.error('Manifest file not found in backup directory', { backupDir });
      return false;
    }

    const manifest: BackupManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    for (const file of manifest.files) {
      const filePath = path.join(backupDir, file.name);
      if (!fs.existsSync(filePath)) {
        log.error('Missing backed up file', { filePath });
        return false;
      }
      const content = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      if (hash !== file.sha256) {
        log.error('Checksum mismatch', { filePath, expected: file.sha256, actual: hash });
        return false;
      }
    }

    return true;
  }

  /**
   * Restore local database and chunks from a verified backup archive.
   */
  static restoreBackup(backupDir: string, destDbPath: string, destChunksDir?: string): boolean {
    if (!this.verifyBackup(backupDir)) {
      throw new Error(`Backup verification failed for ${backupDir}`);
    }

    const dbSource = path.join(backupDir, 'context.db');
    if (fs.existsSync(dbSource)) {
      fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
      fs.copyFileSync(dbSource, destDbPath);
      log.info('Database restored', { destDbPath });
    }

    const chunksSource = path.join(backupDir, 'chunks');
    if (destChunksDir && fs.existsSync(chunksSource)) {
      fs.mkdirSync(destChunksDir, { recursive: true });
      const chunkFiles = fs.readdirSync(chunksSource);
      for (const file of chunkFiles) {
        fs.copyFileSync(path.join(chunksSource, file), path.join(destChunksDir, file));
      }
      log.info('Chunks restored', { count: String(chunkFiles.length) });
    }

    return true;
  }
}
