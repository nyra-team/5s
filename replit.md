# 5S Compliance App

## Overview
A full-stack web application designed for manufacturing environments to improve 5S compliance. The system enables operators to photograph workstations, receiving AI-powered 5S scores and VLM-generated improvement suggestions. Managers can track compliance rates, analyze score trends, manage reference photos, and label submissions for AI model calibration. The project aims to enhance workplace organization and efficiency through intelligent automation and real-time feedback.

This project is a full-stack web application designed for manufacturing environments to automate and track 5S compliance. It enables operators to photograph workstations, receiving AI-powered 5S scores and VLM-generated improvement suggestions. Managers gain a comprehensive dashboard to monitor compliance trends, analyze score trends, manage reference photos, and calibrate the AI model. The core purpose is to improve workplace organization and efficiency through AI-driven insights and streamlined management tools.

## User Preferences

- **Communication Style**: I prefer clear and direct communication.
- **Interaction**: Ask before making major architectural changes or introducing new external dependencies.
- **Code Style**: Prioritize readability and maintainability.
- **Workflow**: Emphasize iterative development with clear, small steps.
- **Testing**: Ensure robust testing for all new features and bug fixes.
- **Documentation**: Keep documentation updated with any changes to the system.
- **Notifications**: I prefer to be notified of critical system events and performance issues.



## System Architecture

The application is built as a monorepo using `pnpm workspaces` with Node.js 24 and TypeScript 5.9, maintaining a clear separation between frontend and backend.

- **Frontend**: Developed with React, Vite, and Tailwind CSS.
  - **UI/UX**: The design emphasizes clarity and ease of use for both operators and managers.
  - **Theming**: Supports automatic light/dark mode switching based on configurable `VITE_NIGHT_SHIFT_START_HOUR`, `VITE_NIGHT_SHIFT_END_HOUR`, and `VITE_NIGHT_SHIFT_TZ`.
- **Backend**: An Express 5 server handles API requests, authentication, and data management.
  - **API Definition**: An OpenAPI specification (`lib/api-spec/openapi.yaml`) serves as the single source of truth for all API endpoints.
  - **API Codegen**: Orval is used to generate React Query hooks and Zod schemas from the OpenAPI spec, ensuring type safety and consistency.
  - **File Storage**: Uploaded images are stored locally in the `uploads/` directory managed by Multer.
  - **Authentication**: JWT-based authentication (with email/password and bcryptjs) supports `OPERATOR` and `MANAGER` roles.
  - **Validation**: Zod and drizzle-zod are used for robust data validation.
- **Database**: PostgreSQL with Drizzle ORM is used for persistent data storage.
  - The `ai_scoring_metrics` table tracks VLM call outcomes (model version, retried flag, validation error) for reliability monitoring.
- **AI/ML Services**:
  - **ML Service (Python FastAPI)**: A dedicated internal Python service handles core AI functionalities, including CLIP ViT-B/32 embedding generation, cosine similarity calculations for 5S scoring, and Ridge regression for model training using scikit-learn.
  - **VLM Service**: Utilizes an OpenAI-compatible API (gpt-5-mini via Replit AI Integrations) for generating detailed, location-specific improvement suggestions and per-pillar scores.
  - **AI Scoring Pipeline**: Integrates CLIP embeddings and VLM output for comprehensive 5S scoring, with configurable scoring modes (CALIBRATED, VLM_BLENDED, SIMILARITY_ONLY, FALLBACK). Managers can label submissions with ground-truth pillar scores to calibrate the AI model.
- **Shift Management**: The system automatically detects shifts (A, B, C) based on configurable start times (`SHIFT_A_START_HOUR`, `SHIFT_B_START_HOUR`, `SHIFT_C_START_HOUR`) and timezone (`SHIFT_TIMEZONE`).
- **Notification System**: Supports email (via Resend) and Slack notifications for manager escalations, with grouping capabilities and re-ping reminders for open escalations.
- **Operator Threshold Tuning**: Key operator-facing parameters (e.g., encouragement thresholds, prior best lookback window, due soon lead time) are runtime-tunable via environment variables, database overrides, and shipped defaults.
- **Escalation Management**: A system for tracking and managing non-compliant submissions, including auto-escalation based on low scores and re-ping notifications for overdue open escalations.

**Key Features:**
- **Role-Based Access:** OPERATOR and MANAGER roles with JWT-based authentication.
- **Automated Shift Detection:** Operators' views adjust based on auto-detected shifts (A, B, C).
- **AI-Powered Scoring & Suggestions:** Provides 0-25 5S scores and VLM-generated, location-specific improvement suggestions.
- **Manager Dashboard:** Offers compliance tracking, score trends, submission browsing (with keyboard shortcuts), ideal photo management, and AI calibration tools.
- **AI Reliability Monitoring:** A dedicated dashboard panel (`AiReliabilityPanel`) and manager-only endpoint (`GET /api/dashboard/ai-reliability`) surface VLM first-try retry rates over the last 24h and 7d windows to help identify misbehaving models or elevated API costs.
- **Manager Triage Flow**: A dedicated `/live` manager landing page displays pending areas, overdue checks, low-scoring submissions, and open escalations. It includes inline quick-labeling, detailed submission lists with filtering, and keyboard shortcuts for efficient navigation and action.
- **Escalation Management:** Automatically escalates low-scoring submissions, with configurable notification channels (email, Slack) and re-ping reminders for open escalations. Supports multi-select and bulk actions (Acknowledge, Resolve, Clear).
- **Operator Threshold Tuning**: Runtime-tunable parameters for operator-facing cutoffs (e.g., encouragement thresholds, prior best lookback window, due soon lead time). Resolved per field with precedence: environment variables > per-area DB override > global DB override > shipped default. Per-area overrides live in `area_operator_settings` (one row per area) and let managers tighten or relax thresholds for individual workstations without affecting the rest of the plant.
- **Theming:** Dynamic light/dark theme switching based on configured night shift hours and timezone.

**UI/UX Decisions:**
- Frontend built with React and Tailwind CSS for a modern, responsive interface.
- Manager views include dashboards with charts for compliance and score trends, a submission browser, and an interface for managing ideal photos and labeling submissions.
- Keyboard shortcuts are implemented for managers in submission lists for efficient navigation and action.
- Notifications UI allows managers to configure preferences for email and Slack.
- Operator thresholds are managed via a dedicated manager admin UI with a scope selector that toggles between the global editor and a per-area editor; the per-area editor shows inherited values with "(global)" / "(default)" markers so the manager always knows what they're falling back to.

## External Dependencies

- **Database**: PostgreSQL (Primary database).
- **AI/ML Service**: Python FastAPI service running CLIP ViT-B/32 (open_clip_torch) and scikit-learn for embeddings, similarity, and model training.
- **VLM Service**: OpenAI-compatible API via Replit AI Integrations (gpt-5-mini) for visual language model capabilities.
- **Email Service**: Resend for sending email notifications.
- **Messaging Service**: Slack for sending notification webhooks.
- **Package Manager**: pnpm
- **Frontend Framework**: React
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **ORM**: Drizzle ORM
- **Authentication Libraries**: bcryptjs, jsonwebtoken (for JWT)
- **Validation Library**: Zod
- **API Codegen**: Orval
- **File Upload Middleware**: Multer
- **Testing Frameworks**: Vitest, Supertest, @testing-library/react

## Manager workflow notes

- `/live` is the manager landing page. Shows pending areas, overdue checks (per-machine when learned), low-scoring submissions (<60%), and open escalations for the current IST shift. Auto-refreshes every 30s.
- Inline quick-label on the audit log: `Approve` (1-click, copies AI pillar scores via `POST /labels/quick-approve`) and `Needs work` (opens detail with the label form auto-scrolled into view).
- Submissions list supports `q` (operator email / machine tag / area name), `minScorePercent`, `maxScorePercent` query params (debounced 250ms client-side).
- Keyboard shortcuts on submissions list (manager only, suppressed on touch-only devices via `(pointer: coarse)` && `!(any-pointer: fine)`): `j`/`↓` next row, `k`/`↑` previous, `Enter` open, `g` approve, `r` resolve the open escalation on the active row (toast if none), `?` cheat sheet, `Esc` close. The `Needs work` button stays mouse-accessible on every row.
- `GET /submissions` returns `openEscalationId` per row (max non-RESOLVED escalation id), which `r` uses to call `useResolveEscalation` and invalidate submissions / escalations / count queries.
- Escalations supports multi-select with a sticky bottom action bar (Acknowledge / Resolve / Clear).
- Operator clients pull active nudges every 60s via `GET /nudges` (OPERATOR-only — managers receive HTTP 403). The endpoint appends the caller's userId to `nudges.seen_by_user_ids_json` so each operator sees a nudge exactly once; the row stays alive (and the per-area/machine/shift dedupe stays active) until a manager explicitly resolves it.

## Escalation notifications (Task 14)

- Auto-escalation (score < 60%) fires-and-forgets `notifyEscalationCreated()` from `artifacts/api-server/src/lib/notifications.ts` after the escalation row is inserted. Failures are logged, never thrown back into the request path.
- Per-manager toggles live on `users.notify_email_enabled` (default true) and `users.notify_slack_enabled` (default false). All MANAGER rows with the relevant flag receive the notification.
- Email channel uses Resend (`RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL`). Sent per-recipient. No-op when env vars are missing.
- Slack channel uses a single channel webhook (`SLACK_WEBHOOK_URL`); we post once if at least one manager has Slack enabled (the channel is shared). No-op when env var is missing.
- Notification body includes area name, score %, failing pillars, operator email, and a deep link to `/escalations` (built from `APP_BASE_URL` or `REPLIT_DEV_DOMAIN`).
- Manager UI: `/notifications` page (Bell icon nav link) backed by `GET/PUT /api/me/notification-preferences`. Server response also returns `emailConfigured`/`slackConfigured` so the UI can warn when toggles will be no-ops.
- **Grouping (Task 36):** Multiple escalations in the same area within `ESCALATION_NOTIFICATION_WINDOW_MS` (default 300000 = 5 min) are batched into a single digest message ("N new escalations on Area X — lowest score Y%"). Each per-event link still resolves to the focused escalation in `/escalations`, plus a header link to the inbox. Set the env var to `0` to disable grouping (fire one message per event, like the original behavior). `flushPendingEscalationNotifications()` is exported for tests / graceful shutdown.

## Escalation re-pings (Task 41)

- A background sweep started in `index.ts` (`startRepingScheduler()` from `artifacts/api-server/src/lib/reping-scheduler.ts`) re-notifies managers when an escalation has been sitting in `OPEN` for too long.
- Schema: `escalations.reping_count` (int, default 0) and `escalations.last_reping_at` (timestamptz, nullable) track delivery state per row.
- An escalation re-pings when `status = 'OPEN'`, `repingCount < ESCALATION_REPING_MAX_COUNT`, and the most recent activity (`lastRepingAt` or `createdAt`) is older than `ESCALATION_REPING_THRESHOLD_MINUTES`. Acknowledging or resolving flips status away from `OPEN`, which silences future re-pings without touching the counter.
- The counter is bumped via a guarded `UPDATE … WHERE status='OPEN' AND reping_count = <observed>` so concurrent sweeps (or status changes) don't double-send.
- Re-ping notifications go out through the same email/Slack channels as the initial notify, but with an "Aging X min — reminder N/M" banner/headline.
- Env knobs (all optional): `ESCALATION_REPING_THRESHOLD_MINUTES` (default 15), `ESCALATION_REPING_MAX_COUNT` (default 2; set to `0` to disable the scheduler), `ESCALATION_REPING_CHECK_INTERVAL_MS` (default 60000).
- The interval is `unref()`-ed so it never blocks process exit. The scheduler is wired in `index.ts` only — tests load `app.ts` directly and therefore never start it.

## Operator threshold tuning (Task 69)

- Three operator-facing cutoffs are runtime-tunable without a redeploy:
  `encouragementMinPercent` (display % at which a submission is "good"),
  `priorBestWindowDays` (lookback for prior-best per area), and
  `dueSoonThresholdMinutes` ("due soon" lead time for area checks).
- Precedence: **env var > DB override > shipped default**. Defaults live in
  `artifacts/api-server/src/lib/operator-thresholds.ts` and the parallel
  frontend file `artifacts/five-s/src/lib/operator-thresholds.ts`.
- Env-var overrides (read once per process): `ENCOURAGEMENT_MIN_PERCENT`,
  `PRIOR_BEST_WINDOW_DAYS`, `DUE_SOON_THRESHOLD_MS` (note: ms, not minutes —
  legacy name preserved). Invalid values fall through to the next layer.
- DB overrides live in the singleton `operator_settings` row (id=1) with
  three nullable int columns + `updated_by_user_id` / `updated_at`.
- Endpoints: `GET /api/operator-thresholds` (any auth) returns the effective
  values plus full provenance (`defaults`, `envOverrides`, `dbOverrides`).
  `PUT /api/operator-thresholds` (manager-only) accepts a partial body —
  omitted = leave untouched, `null` = clear the override, integer = set.
  Out-of-range values are silently dropped (matches the permissive style of
  `/me/notification-preferences`).
- The operator UI (`useEffectiveOperatorThresholds`) polls every 60s; the
  server-side `/operator/recent` route reloads thresholds per request, so
  admin tweaks pick up on the next call without a process restart.
- Manager admin UI lives at `/operator-thresholds` (Sliders icon nav tab,
  manager-only route). Draft state syncs from server only when the saved
  override values change (content fingerprint), so polling refetches don't
  wipe in-flight edits.

## Architecture

- See `artifacts/api-server/src/routes/README.md` for route conventions (notably: never use `sql\`... = ANY(${jsArray})\`` — use drizzle's `inArray()` helper, which handles single-element arrays correctly)
- OpenAPI spec at `lib/api-spec/openapi.yaml` is single source of truth
- Codegen produces React Query hooks (`lib/api-client-react`) and Zod schemas (`lib/api-zod`). Both packages export from `./src` directly (no built `dist/` is committed); regenerate via `pnpm --filter @workspace/api-spec run codegen`.
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

## Frontend Config (Vite env)

- `VITE_NIGHT_SHIFT_START_HOUR` — hour (0-23) the "Auto" theme should switch to dark. Default `22`.
- `VITE_NIGHT_SHIFT_END_HOUR` — hour (0-23) the "Auto" theme should switch back to light. Default `6`. May be less than the start hour to wrap across midnight.
- `VITE_NIGHT_SHIFT_TZ` — IANA timezone the night-shift window is evaluated in. Default `Asia/Kolkata`.

## Backend Shift Config (api-server env)

The API server's notion of "current shift", per-shift dashboard windows, the
`/shift/current` and `/shift/live` endpoints, and shift-anchored due dates all
read from these per-facility env vars at startup. Defaults match the legacy
06/14/22 IST schedule so existing deployments need no changes.

- `SHIFT_TIMEZONE` — IANA timezone the shift clock is anchored to. Default `Asia/Kolkata`.
- `SHIFT_A_START_HOUR` — hour (0-23) shift A starts. Default `6`.
- `SHIFT_B_START_HOUR` — hour (0-23) shift B starts. Default `14`.
- `SHIFT_C_START_HOUR` — hour (0-23) shift C starts. Default `22`. Shift C wraps across midnight up to the next day's `SHIFT_A_START_HOUR`.

Constraints: must satisfy `SHIFT_A_START_HOUR < SHIFT_B_START_HOUR < SHIFT_C_START_HOUR`. Invalid values silently fall back to the defaults.

The frontend reads this same config via `GET /shift/config` (cached app-wide through `useShiftConfig()` in `artifacts/five-s/src/lib/shift-config.tsx`). Header clock, live shift header, quiet-hours badge/summary, the quiet-hours time-input labels, and the operator page's shift pill switcher (both the active-shift view and the unknown-shift fallback) all render against the configured timezone and `startHours` (e.g. "Shift A · 7 AM – 3 PM" instead of "6 AM – 2 PM" for a US site). The hook also exposes `shiftLabels`, derived from backend `startHours`, so the operator pills no longer rely on Vite build-time `VITE_NIGHT_SHIFT_*` env (which could drift from the backend). When the call is in flight, the hook falls back to the legacy IST defaults so the UI never blanks.
