# Community Service & Care Platform

A multi-platform community care and service coordination architecture consisting of a React Native / Expo cross-platform mobile application, a Next.js administrative dashboard, and a local Supabase / PostgreSQL backend.

---

## Architecture Overview

* **Mobile Application (`/mobile`)**: Built with React Native and Expo. Serves mobile users requesting and offering community services, with strictly scoped permissions and guided flows.
* **Admin Dashboard (`/admin`)**: Built with Next.js 16 (App Router), React 19, and Tailwind CSS. Enables platform administrators to audit requests, verify areas, and manage community compliance.
* **Backend Infrastructure (`/supabase`)**: Self-hosted Supabase stack orchestrated via Docker and the Supabase CLI, providing PostgreSQL, Auth, Realtime, Storage, and Edge Functions.

---

## Core Architectural Guardrails

1. **Privacy-Preserving Contact Mediation**
   * User and service provider phone numbers and direct contact details are hidden and masked by default.
   * Voluntary sharing of external contact information occurs strictly through mutual, explicit confirmation within an active, request-linked coordination session.
2. **Adult-Only Accounts & Child Safety**
   * Direct user accounts are strictly restricted to verified adults (18+).
   * Parents and legal guardians must arrange, supervise, and coordinate services for minors; no minor accounts or unmonitored direct messaging are permitted on the platform.
3. **Zero In-App Service Payments in V1**
   * Version 1 charges zero platform commissions, booking fees, or in-app payment transactions.
   * Service terms, reimbursements, or voluntary gratuities are handled directly offline between participants.
4. **Central Governance with Localized Area Verification**
   * Central platform governance establishes safety standards and automated oversight.
   * Community verifiers and localized area coordinators review operational requests within designated geographic zones.

---

## Prerequisites

Before setting up the repository on a fresh machine, ensure the following tooling is installed:

* **Node.js**: LTS version (v20.x or v22.x recommended)
* **npm**: v10.x+
* **Docker Desktop**: Docker engine running with compose support (required to run the local Supabase container stack)
* **Supabase CLI**: Installed globally (`npm install -g supabase`) or invoked via `npx supabase`

---

## Step-by-Step Setup Guide

### 1. Clone the Repository

```bash
git clone <repository-url>
cd <repository-directory>
```

### 2. Install Project Dependencies

Install dependencies cleanly using `npm ci` within each project directory:

```bash
# Install mobile dependencies
cd mobile
npm ci
cd ..

# Install admin dependencies
cd admin
npm ci
cd ..
```

---

## Running Local Verification Suites

Each subproject contains independent TypeScript, ESLint, and Jest test suites. Run these checks to verify codebase integrity:

### Mobile Project (`/mobile`)

```bash
cd mobile

# 1. Typecheck (TypeScript compiler check)
npm run typecheck

# 2. Lint (ESLint validation)
npm run lint

# 3. Unit & Integration Tests (Jest)
npm test

cd ..
```

### Admin Dashboard (`/admin`)

```bash
cd admin

# 1. Typecheck (TypeScript compiler check)
npm run typecheck

# 2. Lint (ESLint 9 validation)
npm run lint

# 3. Unit & Integration Tests (Jest)
npm test

cd ..
```

---

## Local Supabase Environment

The repository includes a reproducible Supabase local environment configuration in `/supabase`.

### Initialize Supabase Configuration (Already Initialized)
```bash
npx supabase init
```

### Start Local Supabase Stack
Make sure Docker Desktop is active, then run:
```bash
npx supabase start
```
This boots the local Supabase container infrastructure:
* **PostgreSQL Database**: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
* **REST API (PostgREST)**: `http://127.0.0.1:54321`
* **Supabase Studio (Web UI)**: `http://127.0.0.1:54323`
* **Inbucket (Local Email Testing)**: `http://127.0.0.1:54324`

### Stop Local Supabase Stack
```bash
npx supabase stop
```

### Check Container Status
```bash
npx supabase status
```

---

## Automated CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) triggers on every `push` and `pull_request` targeting the `main` branch. It executes two parallel validation jobs:

1. **`mobile-check`**: Validates `/mobile` (`npm ci`, `typecheck`, `lint`, `test`).
2. **`admin-check`**: Validates `/admin` (`npm ci`, `typecheck`, `lint`, `test`).

A failure at any step fails the entire CI pipeline and prevents merging.

### Local Pre-Push CI Simulation Command

Run this one-liner from the repository root to verify all CI requirements pass locally before pushing:

```bash
(cd mobile && npm run typecheck && npm run lint && npm test) && (cd admin && npm run typecheck && npm run lint && npm test)
```
