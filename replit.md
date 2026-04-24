# 5S Compliance App

## Overview

Full-stack 5S Compliance web app for manufacturing. Operators photograph workstations per shift, receive AI-powered 5S scores (0-25) based on CLIP embedding similarity to ideal reference photos, and get VLM-generated improvement suggestions with specific location references. Managers track compliance rates, score trends, label submissions for model calibration, and manage reference photos.

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
- **AI/ML**: Python FastAPI service with CLIP ViT-B/32 (open_clip_torch) + scikit-learn
- **VLM**: OpenAI-compatible API via Replit AI Integrations (gpt-5-mini)

## Login Credentials

- **Manager**: manager@5s.com / manager123
- **Operator**: operator@5s.com / operator123

## Key Features

- **Operator view**: Auto-detect shift (A/B/C), photograph areas, get AI-powered 5S scores + location-specific suggestions
- **Manager view**: Dashboard with compliance %, score charts, submission browser, ideal photo management, submission labeling for AI calibration
- **Roles**: OPERATOR, MANAGER with JWT-based auth
- **Shifts**: A (6am-2pm), B (2pm-10pm), C (10pm-6am)
- **AI Scoring Pipeline**:
  - CLIP ViT-B/32 embeddings computed for submission and ideal photos
  - Cosine similarity between submission embedding and ideal centroid
  - Scoring modes: CALIBRATED (Ridge regression from labels), VLM_BLENDED (70% VLM + 30% CLIP), SIMILARITY_ONLY (cosine→score), FALLBACK (conservative zeros)
  - CLIP similarity rescaled: 0.75–0.98 range maps to 0–25 score range for meaningful differentiation
  - VLM (gpt-5-mini) provides per-pillar scores (0-5) alongside issues/recommendations with location references
  - VLM scores are blended with CLIP similarity as primary signal; CLIP acts as weighting/adjustment factor
- **Manager Labeling**: Rate submissions with ground-truth pillar scores (0-5 each) for model calibration
- **Model Training**: Ridge regression per pillar using labeled CLIP embeddings (min 5 labels to train)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run seed` — seed database with default data
- `python ml_service/app.py` — start CLIP ML service on port 8100

## Data Models

- **users**: id, email, password_hash, role (OPERATOR/MANAGER)
- **areas**: id, name (6 manufacturing areas)
- **ideal_photos**: id, area_id, image_url, embedding_json, created_at
- **submissions**: id, area_id, user_id, shift, score_total, score_json, suggestions_json, image_url, embedding_hash, similarity_to_ideal, ai_total_score, ai_pillars_json, ai_recommendations_json, ai_issues_json, model_version, scoring_mode, created_at
- **labels**: id, submission_id, labeled_by_user_id, pillars_json, total_score, created_at
- **escalations**: id, submission_id, area_id, operator_id, score_total, score_percent, failing_pillars_json, recommended_actions_json, evidence_urls_json, status (OPEN/ACKNOWLEDGED/RESOLVED), acknowledged/resolved metadata
- **nudges**: id, area_id, machine, shift, operator_id, manager_id, dismissed_at, created_at — manager-to-operator pings de-duped per area+machine+shift while undismissed
- **area_profiles / area_schedules**: learned area metadata + per-machine cadence

## Manager triage flow (Task 20)

- `/live` is the manager landing page. Shows pending areas, overdue checks (per-machine when learned), low-scoring submissions (<60%), and open escalations for the current IST shift. Auto-refreshes every 30s.
- Inline quick-label on the audit log: `Approve` (1-click, copies AI pillar scores via `POST /labels/quick-approve`) and `Needs work` (opens detail with the label form auto-scrolled into view).
- Submissions list supports `q` (operator email / machine tag / area name), `minScorePercent`, `maxScorePercent` query params (debounced 250ms client-side).
- Keyboard shortcuts on submissions list (manager only, suppressed on touch-only devices via `(pointer: coarse)` && `!(any-pointer: fine)`): `j`/`↓` next row, `k`/`↑` previous, `Enter` open, `g` approve, `r` resolve the open escalation on the active row (toast if none), `?` cheat sheet, `Esc` close. The `Needs work` button stays mouse-accessible on every row.
- `GET /submissions` returns `openEscalationId` per row (max non-RESOLVED escalation id), which `r` uses to call `useResolveEscalation` and invalidate submissions / escalations / count queries.
- Escalations supports multi-select with a sticky bottom action bar (Acknowledge / Resolve / Clear).
- Operator clients pull active nudges every 60s via `GET /nudges` (OPERATOR-only — managers receive HTTP 403). The endpoint appends the caller's userId to `nudges.seen_by_user_ids_json` so each operator sees a nudge exactly once; the row stays alive (and the per-area/machine/shift dedupe stays active) until a manager explicitly resolves it.

## Architecture

- OpenAPI spec at `lib/api-spec/openapi.yaml` is single source of truth
- Codegen produces React Query hooks (`lib/api-client-react`) and Zod schemas (`lib/api-zod`)
- Static file serving for uploads at `/api/uploads/`
- Image uploads stored in `uploads/` directory at project root
- ML Service (Python FastAPI, port 8100): CLIP embeddings, similarity computation, Ridge regression training/prediction
- VLM Service: OpenAI-compatible API via `@workspace/integrations-openai-ai-server` for structured issue/recommendation generation
- AI scoring is called on every submission creation; falls back to conservative zero defaults (not random) if AI pipeline is unavailable

## Services

- **API Server**: Express 5 on port 8080, proxied to /api
- **Frontend**: Vite dev server (dynamic port), proxied to /
- **ML Service**: Python FastAPI on port 8100, internal only
- **Mockup Sandbox**: Vite on port 8081, for component previews
