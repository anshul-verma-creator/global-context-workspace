#!/usr/bin/env bash
# ==============================================================================
# Global Context Workspace — Production Restore Script
# Restores PostgreSQL database and local storage from backup archive
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup_directory_or_timestamp>"
  exit 1
fi

BACKUP_SOURCE="$1"
DATABASE_URL="${DATABASE_URL:-postgresql://context_admin:context_secure_password@localhost:5432/context_workspace}"
LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-/data}"

if [ ! -d "${BACKUP_SOURCE}" ]; then
  echo "Error: Backup directory ${BACKUP_SOURCE} does not exist."
  exit 1
fi

echo "==> Verifying backup checksums..."
cd "${BACKUP_SOURCE}"
sha256sum --check SHA256SUMS

# 1. Restore PostgreSQL Database
if [ -f "${BACKUP_SOURCE}/postgres_context.dump" ]; then
  echo "--> Restoring PostgreSQL database from dump..."
  pg_restore --clean --if-exists --dbname="${DATABASE_URL}" "${BACKUP_SOURCE}/postgres_context.dump"
fi

# 2. Restore Local Storage & Chunks
if [ -f "${BACKUP_SOURCE}/local_storage.tar.gz" ]; then
  echo "--> Restoring local storage to ${LOCAL_DATA_DIR}..."
  mkdir -p "${LOCAL_DATA_DIR}"
  tar -xzf "${BACKUP_SOURCE}/local_storage.tar.gz" -C "${LOCAL_DATA_DIR}"
fi

echo "==> Restore completed successfully from ${BACKUP_SOURCE}!"
