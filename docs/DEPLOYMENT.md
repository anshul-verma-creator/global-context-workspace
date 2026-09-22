# Global Context Workspace — Production Deployment Guide

## Overview

The Global Context Workspace is a local-first, multi-agent coordination and context synthesis platform. This guide covers deploying the server cluster, configuring production databases (PostgreSQL with `pgvector` and Redis 7), establishing high availability, running automated migrations, setting up health and readiness probes, and performing backup and disaster recovery.

---

## Architecture Topology

```
                  +-----------------------------------+
                  |  Load Balancer (Nginx / Cloud LB) |
                  |         (TLS Termination)         |
                  +-----------------+-----------------+
                                    |
                    +---------------+---------------+
                    |                               |
       +------------v------------+     +------------v------------+
       | Context Server Node 1   |     | Context Server Node 2   |
       | (Fastify + WS + Leases) |     | (Fastify + WS + Leases) |
       +------------+------------+     +------------+------------+
                    |                               |
                    +---------------+---------------+
                                    |
          +-------------------------+-------------------------+
          |                                                   |
+---------v-------------------+             +-----------------v---------+
| PostgreSQL 16 + pgvector    |             | Redis 7 (AOF + RDB)       |
| (Events, Objects, Relations)|             | (Event Streams, Leases)   |
+-----------------------------+             +---------------------------+
```

---

## 1. Quickstart: Docker Compose Deployment

The simplest and recommended deployment for single-node environments is using Docker Compose.

### Step 1: Clone and Configure Environment

```bash
git clone https://github.com/your-org/global-context-workspace.git
cd global-context-workspace/context-workspace

cp .env.production.example .env.production
# Edit .env.production and set strong secrets
```

### Step 2: Launch Stack

```bash
docker compose up -d --build
```

### Step 3: Verify Services

```bash
# Check container status
docker compose ps

# Check Server Health
curl http://localhost:3000/health
# Response: {"status":"ok","timestamp":1726938000000}

# Check Server Readiness (verifies Postgres & Redis connection)
curl http://localhost:3000/ready
# Response: {"status":"ready","timestamp":1726938000000}
```

---

## 2. Infrastructure Requirements

### Minimum Resource Allocations
- **Context Server**: 1 vCPU, 1 GB RAM
- **PostgreSQL 16**: 2 vCPU, 4 GB RAM (with SSD for WAL)
- **Redis 7**: 1 vCPU, 2 GB RAM

### Recommended Production Sizing
- **Context Server**: 2+ replicas, 2 vCPU, 2 GB RAM per replica
- **PostgreSQL 16**: 4 vCPU, 16 GB RAM (High IOPS SSD)
- **Redis 7**: 2 vCPU, 8 GB RAM (AOF enabled on NVMe SSD)

---

## 3. Database Configuration

### PostgreSQL with pgvector

Ensure the `pgvector` extension is installed and available:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

#### Production PostgreSQL Settings (`postgresql.conf`)
```ini
max_connections = 200
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 64MB
maintenance_work_mem = 512MB
wal_level = replica
max_wal_size = 16GB
min_wal_size = 1GB
checkpoint_completion_target = 0.9
```

### Automatic Migrations

Migrations execute automatically upon server startup:
- Initial schema: schema_migrations
- Relational schema: repositories, capsules, sessions, events, context_objects, relations
- Vector schema: HNSW index over embeddings (`vector(1536)`)
- Inverted index: PostgreSQL Full-Text Search (tsvector)

---

## 4. Redis Configuration

Redis handles live ephemeral state, event broadcast streams (`XADD`), and agent lease management.

#### Recommended `redis.conf`
```ini
# Persistence: AOF every second + RDB snapshots
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Memory management
maxmemory 4gb
maxmemory-policy noeviction

# Security
requirepass your_strong_redis_password
protected-mode yes
```

---

## 5. Kubernetes & Container Orchestration

### Health & Readiness Probes

Configure Kubernetes probes to target the server endpoints:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
  timeoutSeconds: 3
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 2
```

- `/health`: Liveness probe — checks if the Node.js event loop and Fastify HTTP listener are active.
- `/ready`: Readiness probe — performs live SQL query (`SELECT 1`) and Redis `PING`. Returns HTTP 503 if infrastructure dependencies are unavailable.

---

## 6. Backup & Disaster Recovery

### Automated Backups

Run the automated backup script daily via cron:

```bash
0 2 * * * /app/scripts/backup.sh >> /var/log/context_backup.log 2>&1
```

The script performs:
1. `pg_dump` with custom binary format of all events, objects, and relations.
2. Compression of raw chunks and SQLite snapshots.
3. Checksum generation (`SHA256SUMS`) for integrity verification.

### Disaster Recovery / Restore

To restore from a backup:

```bash
/app/scripts/restore.sh /backups/backup_20260921_020000
```

---

## 7. Security Best Practices

1. **TLS / HTTPS**: Always terminate TLS using a reverse proxy (e.g. Nginx, Traefik, AWS ALB) in front of the Context Server.
2. **Secret Filtering**: The server and agent run `@context-workspace/security` to scan for and redact credentials (AWS, OpenAI, Slack tokens, private keys) before persistence.
3. **Repository Isolation**: Multi-tenant or cross-team environments must use repository-scoped tokens (`allowedRepositories`). Tokens targeting unauthorized repositories are rejected with HTTP 403.
4. **Device Revocation**: Stolen or compromised laptops/nodes can be immediately revoked via `DeviceRegistry.revokeDevice()`, which instantly invalidates all associated tokens.

---

## 8. Observability & Logging

1. **Structured JSON Logs**: All logs follow standard structured JSON with `timestamp`, `level`, `component`, and contextual metadata.
2. **Prometheus Metrics**: Integrated `MetricsRegistry` captures throughput, query latencies, cache hit rates, and lease contentions.
3. **Event Tracing**: `EventTracer` tracks parent-child event causal lineage across agents.
