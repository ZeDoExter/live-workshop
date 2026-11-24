# Live WorkShop

## Proprietary Notice & Evaluation Terms
Copyright (c) 2026 The Project Owner. All Rights Reserved.
This repository is provided **solely for private evaluation purposes** under [`COPYRIGHT.md`](./COPYRIGHT.md).
No open-source license is granted. Commercial use, redistribution, public display, or derivative works are prohibited without explicit written permission from the copyright owner.

## Architecture & Stack
Lean, real-time 3-surface workshop application (~30 mobile participants, 1 facilitator, post-session HR insights; zero AI, payments, participant accounts, or hardcoded mock data):
- **Frontend (`frontend/`)**: Next.js (App Router) + TypeScript + Tailwind CSS (`/` landing, `/join/[code]` mobile room, `/facilitator` live console, `/dashboard/[code]` HR PostgreSQL dashboard).
- **Backend (`backend/`)**: Rust + Axum + Tokio + SQLx (`tls-rustls-ring-webpki`) with a per-session `tokio::sync::broadcast` WebSocket hub (`/api/*`, `/ws/sessions/:code`).
- **Database**: PostgreSQL 16 (`backend/migrations/0001_init.sql`: `sessions`, `activities`, `participants`, `responses`, `app_controls`).
- **Infrastructure & CI (`infra/`, `k8s/`, `.github/workflows/ci.yml`)**: AWS EKS Kubernetes & ECS Fargate + ALB (WebSocket-enabled, `idle_timeout = 300`) + private RDS PostgreSQL + Secrets Manager + **$10 USD Monthly AWS Cost Budget** (`aws_budgets_budget`) + Kubernetes manifests (`k8s/manifests.yaml`) + GitHub Actions CI.

## Local Development Setup (Kiri Services / Containers / Kubernetes)
1. **Configure runtime environment** (never commit `.env`):
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with local placeholder values for `POSTGRES_PASSWORD`, `DATABASE_URL`, `DEMO_ACCESS_TOKEN`, `FACILITATOR_TOKEN`, and `ADMIN_TOKEN`.
2. **Run all services on Kiri (PostgreSQL + Backend + Frontend containers)**:
   ```bash
   kiri compose up -d --build
   ```
   Or deploy on Kiri Kubernetes (`kiri k8s start --use`):
   ```bash
   kubectl apply -f k8s/manifests.yaml
   ```
3. **Optional standalone local dev**:
   - Start PostgreSQL 16: `kiri compose up -d postgres`
   - Run Backend (`127.0.0.1:3001`): `cd backend && cargo run`
   - Run Frontend (`http://localhost:3000`): `cd frontend && pnpm install && pnpm dev`

## Verification Commands
- **Backend lint, tests & 30+ WS concurrency benchmark**:
  ```bash
  cd backend
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo test
  cargo test --test ws_load_test -- --nocapture
  ```
- **Frontend lint, typecheck & production build**:
  ```bash
  cd frontend
  pnpm lint && pnpm typecheck && pnpm build
  ```
- **Playwright E2E suite** (`e2e/`):
  ```bash
  cd e2e
  pnpm install && pnpm exec playwright install chromium
  pnpm test
  ```
- **Terraform & GitHub Actions CI validation** (local check only, no live AWS apply):
  ```bash
  terraform -chdir=infra fmt -check -recursive
  terraform -chdir=infra init -backend=false -input=false
  terraform -chdir=infra validate
  actionlint -verbose .github/workflows/ci.yml
  ```

## Runtime Environment Variables
*(Names and purpose only — set via `.env` locally or AWS Secrets Manager in ECS.)*

| Variable | Component | Purpose |
|---|---|---|
| `DATABASE_URL` | Backend | PostgreSQL connection URI |
| `BETTER_AUTH_DB_URL` | Frontend | PostgreSQL connection URI for Better Auth server |
| `BETTER_AUTH_SECRET` | Frontend | Signing secret for Better Auth facilitator/HR sessions |
| `BETTER_AUTH_URL` | Frontend | Base URL for Better Auth endpoints (`http://localhost:3000`) |
| `FACILITATOR_TOKEN` | Backend | Runtime service token for facilitator & HR API automation |
| `ADMIN_TOKEN` | Backend | Owner token gating `POST /api/admin/access` |
| `DEMO_ENABLED` | Backend | Kill switch (`true`/`false`); `false` disables live service |
| `BIND_ADDR` | Backend | Listen socket address (`127.0.0.1:3001` in `.env.example`; defaults to `0.0.0.0:3001` if unset) |
| `ALLOWED_ORIGINS` | Backend | Comma-separated CORS origins for cross-port local dev |
| `NEXT_PUBLIC_API_URL` | Frontend | Optional HTTP API base URL (unset for same-origin ALB `/api/*`) |
| `NEXT_PUBLIC_WS_URL` | Frontend | Optional WS base URL (unset for same-origin ALB `/ws/*`) |

## Owner Access Revocation & AWS Shutdown
Access can be revoked or shut down at any time **without code edits**:
1. **Instant runtime revocation** (blocks new requests and disconnects active WebSockets immediately):
   ```bash
   curl -X POST "$API_URL/api/admin/access" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"demo_active":false}'
   ```
   *(Pass `{"demo_active":true}` to re-enable.)*
2. **Scale ECS compute to zero & disable demo env**:
   ```bash
   terraform -chdir=infra apply -var="demo_enabled=false"
   ```
3. **Full AWS environment teardown**:
   ```bash
   terraform -chdir=infra destroy
   ```
   *(Before enabling `demo_enabled=true` on a fresh AWS apply, populate `DEMO_ACCESS_TOKEN`, `FACILITATOR_TOKEN`, and `ADMIN_TOKEN` in AWS Secrets Manager via `aws secretsmanager put-secret-value`.)*
