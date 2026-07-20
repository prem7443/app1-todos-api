# Todos CRUD API — App 1 (DevOps Technical Task)

Simple Express + Prisma + PostgreSQL CRUD API with a `/health` endpoint,
deployed alongside Multi-Auth (App 2) on one EC2 instance behind Nginx.

## Architecture Overview

- **Server**: single AWS EC2 instance (t3.small), Ubuntu 22.04, hosting both applications.
- **App 1** (this repo): Express + Prisma, runs on internal port `3001` via PM2.
- **App 2** (Multi-Auth): Node/Express + React + Prisma, runs on internal port `3002` via PM2.
- **Reverse proxy**: Nginx listens on 80/443 publicly; routes to the correct app based on `server_name` (subdomain), proxying to `127.0.0.1:3001` or `127.0.0.1:3002`. Neither app port is exposed publicly.
- **Databases**: one RDS PostgreSQL instance, two separate databases (`app1_db`, `multiauth_db`), each with its own DB user and credentials.
- **CI/CD**: two independent Jenkins pipeline jobs (Jenkinsfile per repo), triggered on push, each with build → test/migrate → deploy → health check → automatic rollback.

## Port List & Justification

| Port | Purpose | Exposure |
|------|---------|----------|
| 22   | SSH admin access | Restricted to admin's IP /32 only |
| 80   | HTTP (Nginx) | Public — redirects to 443 if SSL configured |
| 443  | HTTPS (Nginx) | Public |
| 8090 | Jenkins UI | Public, but access gated by a read-only viewer account for the reviewer; consider restricting to admin IP + reviewer IP if known ahead of time |
| 3001 | App 1 internal (Express) | Localhost only, never exposed — Nginx upstream only |
| 3002 | App 2 internal (Express) | Localhost only, never exposed — Nginx upstream only |
| 5432 | PostgreSQL (RDS) | Not on this server — RDS security group allows inbound only from the EC2 instance's security group, not the public internet |

No other inbound ports are open. Any port not listed above is closed.

## Instance Sizing Rationale

`t3.small` chosen over `t3.micro` because the server concurrently runs: Jenkins (JVM, memory-heavy during builds), two Node.js apps under PM2, and Nginx. `t3.micro`'s 1GB RAM risks OOM during a Jenkins build while both apps are also serving traffic. `t3.small` (2GB) gives headroom without paying for a full `t3.medium`, since this is a technical assessment, not production load.

RDS `db.t3.micro` is sufficient since both databases here have effectively zero real production traffic — this is a capacity trade-off explicitly made for the scope of the task, not a template for production sizing.

---

## Logic & Reasoning Answers

### 1. Reverse Proxy Design
Nginx routes purely on the `Host` header via `server_name` directives in two separate `server` blocks — not on port, since both apps live behind the same 80/443. Each block has its own `upstream` pointing at the app's internal port (127.0.0.1:3001 / 3002). This is what prevents interference: the apps never share a listening port, and neither is directly reachable from outside — only Nginx is. Non-obvious decision: internal ports are on loopback only (no `0.0.0.0` binding for App processes), so even if someone scanned the server's open ports, they'd only ever see 22/80/443/8090 — 3001/3002 aren't attackable directly.

### 2. Database Separation Strategy
Chose **one RDS instance, two databases** over two instances. Trade-offs considered:
- **Cost**: one instance is materially cheaper — two `db.t3.micro` instances roughly double the RDS bill for no real isolation benefit at this scale.
- **Isolation**: separate databases (not just separate schemas) on the same instance still gives full logical isolation — different users, different privileges, one app cannot query the other's tables.
- **Connection limits**: a shared instance means both apps compete for the same max_connections pool. At this scale (assessment, not production) this isn't a real constraint; at higher scale I'd revisit.
- **Failover**: a shared instance means a failure affects both apps simultaneously — this is the main downside. Accepted here because the task scope doesn't call for independent failure domains, but I'd flag it explicitly as the trade-off made.

### 3. MERN Pipeline — Prisma Migration Safety
Running `prisma migrate deploy` on every push is risky because most deploys don't touch the schema, and re-running it unnecessarily still executes lock/inspection queries against production. The pipeline hashes `prisma/schema.prisma` and compares it to the hash recorded at the last deploy; migrate only runs if it changed. `prisma migrate deploy` applies migrations transactionally per-migration file and refuses to mark a migration as applied if it fails partway — so a failed migration does not leave the schema in an ambiguous "half applied" state, and Prisma will error out rather than let the app start against it. The pipeline treats a failed migration as a pipeline failure, which triggers the rollback stage (code only — see below), and does not restart the app under the new code with a broken schema.

### 4. Rollback Trigger Logic
A health check is considered failed if, after **5 attempts at 3-second intervals** (15 seconds total), the health endpoint hasn't returned HTTP `200`. Any non-200 status, connection refused, or timeout counts as unhealthy — no partial-credit on status codes (e.g. a 500 counts the same as no response). These numbers (5 retries / 3s) were chosen to give the app enough time to finish booting the Express server, connecting Prisma, and warming up, while keeping total pipeline time bounded to under 20 seconds of health-check overhead per deploy.

### 5. Secrets Across Stages
- **Build time**: no secrets needed — `npm ci`/`npm install` and `prisma generate` don't touch real credentials.
- **Deploy time**: Jenkins SSHes into the server and reads the *already-present* `.env` file on the server (not injected via Jenkins) — Jenkins itself never sees or logs the DB password. `.env` files are created manually once during initial server setup and are `.gitignore`d, never touched by CI.
- **Runtime**: the app reads `DATABASE_URL` from `.env` via `dotenv`/PM2 environment — the process has it in memory only, never written to a log line.
- Result: credentials exist in exactly one place at rest (the server's `.env` file, file-permissioned to the deploy user), never in git history, never in a Docker image layer (no image is built with secrets baked in — env is injected at container/process start, not build time).

### 6. IAM Scoping
The reviewer's IAM user has exactly: `ec2:DescribeInstances`, `ec2:DescribeSecurityGroups` (to verify the server exists and confirm the port/SSH restrictions claimed in this README), `rds:DescribeDBInstances` (to confirm the DB is not publicly accessible), and `logs:Describe*/Get*` (to inspect CloudWatch logs if configured). No `List*` beyond what's needed, no write actions, no access to any other AWS service. The broad AWS-managed `ReadOnlyAccess` policy was deliberately **not** used — it grants read access to effectively every service in the account (S3 bucket contents, IAM configuration, billing, etc.), which is far more exposure than a reviewer verifying this specific task needs. Minimal scope reduces blast radius if these keys ever leaked, even though they're read-only.

---

## Known Gaps / Time-Boxed Items

(Fill in honestly before submission — e.g. "SSL/Let's Encrypt not configured due to time constraint, HTTP only was verified working," or "automated backups not implemented, manual RDS snapshot taken before submission instead.")

## Non-Obvious Third-Party Choices

- **PM2** for process management/restart-on-crash instead of a raw `node` process or systemd unit — chosen for simplicity of `pm2 reload` in the Jenkins deploy stage without writing custom systemd unit files.
- **sslip.io** (or nip.io) for subdomains instead of a purchased domain — free, resolves directly to the server IP with no DNS propagation delay, acceptable per task rules ("a free subdomain service is fine").
