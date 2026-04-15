# 5S Compliance App

## Overview

Full-stack 5S Compliance web app for manufacturing. Operators photograph workstations per shift, receive automated 5S scores (0-25), and get improvement suggestions. Managers track compliance rates and score trends via dashboards.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS (artifacts/five-s)
- **Backend**: Express 5 (artifacts/api-server)
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: JWT (email/password, bcryptjs)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **File uploads**: Multer → local /uploads directory
- **Build**: esbuild (CJS bundle)

## Login Credentials

- **Manager**: manager@5s.com / manager123
- **Operator**: operator@5s.com / operator123

## Key Features

- **Operator view**: Auto-detect shift (A/B/C), photograph areas, get 5S scores + suggestions
- **Manager view**: Dashboard with compliance %, score charts, submission browser, ideal photo management
- **Roles**: OPERATOR, MANAGER with JWT-based auth
- **Shifts**: A (6am-2pm), B (2pm-10pm), C (10pm-6am)
- **Scoring**: Fixed logic scoring 5 pillars (Sort, Set, Shine, Standardize, Sustain) each 0-5, total 0-25
- **Clean abstraction for future Vision AI** in artifacts/api-server/src/lib/scoring.ts

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run seed` — seed database with default data

## Data Models

- **users**: id, email, password_hash, role (OPERATOR/MANAGER)
- **areas**: id, name (6 manufacturing areas)
- **ideal_photos**: id, area_id, image_url, created_at
- **submissions**: id, area_id, user_id, shift, score_total, score_json, suggestions_json, image_url, created_at

## Architecture

- OpenAPI spec at `lib/api-spec/openapi.yaml` is single source of truth
- Codegen produces React Query hooks (`lib/api-client-react`) and Zod schemas (`lib/api-zod`)
- Static file serving for uploads at `/api/uploads/`
- Image uploads stored in `uploads/` directory at project root
