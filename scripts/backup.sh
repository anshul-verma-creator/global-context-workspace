#!/usr/bin/env bash
# ==============================================================================
# Global Context Workspace — Production Backup Script
# Performs atomic backups of PostgreSQL database and SQLite raw chunk storage
# ==============================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_DIR="${BACKUP_DIR}/backup_${TIMESTAMP}"

DATABASE_URL="${DATABASE_URL:-postgresql://context_admin:context_secure_password@localhost:5432/context_workspace}"
LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-/data}"

echo "==> Starting Global Context Workspace Backup: ${TIMESTAMP}"
mkdir -p "${TARGET_DIR}"

# 1. PostgreSQL Database Dump (Custom binary format for atomic restore)
echo "--> Backing up PostgreSQL events and context stores..."
pg_dump --dbname="${DATABASE_URL}" --format=custom --file="${TARGET_DIR}/postgres_context.dump"

# 2. Local Chunk & SQLite Storage Backup
if [ -d "${LOCAL_DATA_DIR}" ]; then
  echo "--> Backing up local storage and raw chunks from ${LOCAL_DATA_DIR}..."
  tar -czf "${TARGET_DIR}/local_storage.tar.gz" -C "${LOCAL_DATA_DIR}" .
fi

# 3. Create Manifest and Checksum
echo "--> Generating backup verification checksums..."
cd "${TARGET_DIR}"
sha256sum * > SHA256SUMS

echo "==> Backup completed successfully: ${TARGET_DIR}"
echo "Manifest:"
cat "${TARGET_DIR}/SHA256SUMS"
