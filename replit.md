# 5S Compliance App

## Overview
A full-stack web application designed for manufacturing environments to enforce 5S compliance. The system enables operators to photograph workstations, which are then scored by an AI using CLIP embedding similarity against ideal reference photos. VLM-generated suggestions provide location-specific improvement recommendations. Managers can track compliance, analyze score trends, manage reference photos, and label submissions for continuous AI model calibration. The project aims to significantly improve workplace organization and efficiency in manufacturing settings.

## User Preferences

- **Communication Style**: I prefer clear and direct communication, and simple language.
- **Interaction**: Ask before making major architectural changes or introducing new external dependencies.
- **Code Style**: Prioritize readability and maintainability.
- **Workflow**: Emphasize iterative development with clear, small steps.
- **Testing**: Ensure robust testing for all new features and bug fixes.
- **Documentation**: Keep documentation updated with any changes to the system.
- **Notifications**: I prefer to be notified of critical system events and performance issues.

## System Architecture

### UI/UX Decisions
- **Frontend**: Built with React, Vite, and Tailwind CSS, providing a modern and responsive user interface.
- **Operator View**: Automatically detects the current shift and guides operators through photographing designated areas. Displays AI-powered 5S scores and actionable, location-specific improvement suggestions.
- **Manager View**: Features a comprehensive dashboard with compliance percentages, score trends, a submission browser, tools for ideal photo management, and an interface for labeling submissions to calibrate the AI model.
- **Design Approach**: The UI is designed to be intuitive for both operators and managers, with quick-labeling options and keyboard shortcuts for managers to streamline the triage process. Color schemes and visual feedback are used to highlight compliance status and areas needing attention.
- **Operator Thresholds Admin**: Operator thresholds are managed via a dedicated manager admin UI with a scope selector that toggles between the global editor and a per-area editor; the per-area editor shows inherited values with "(global)" / "(default)" markers so the manager always knows what they're falling back to.

### Technical Implementations
- **Monorepo**: Uses pnpm workspaces for managing multiple packages (frontend, backend, shared libraries).
- **Backend**: Implemented with Express 5, handling API requests, authentication, and database interactions.
- **Database**: PostgreSQL with Drizzle ORM for robust data storage and retrieval.
- **Authentication**: JWT-based authentication with email/password and bcryptjs for secure user access and role management (OPERATOR, MANAGER).
- **Validation**: Zod is used for schema validation across the application, ensuring data integrity.
- **API Codegen**: Orval generates API hooks and Zod schemas from an OpenAPI specification, maintaining consistency between frontend and backend.
- **File Uploads**: Multer handles image uploads, storing them locally.
- **AI Scoring Pipeline**:
    - Leverages CLIP ViT-B/32 embeddings to compare submission photos against ideal workstation photos using cosine similarity.
    - Multiple scoring modes: `CALIBRATED` (using Ridge regression from manager labels), `VLM_BLENDED` (70% VLM, 30% CLIP), `SIMILARITY_ONLY`, and `FALLBACK`.
    - CLIP similarity is rescaled to a 0-25 score range for granular differentiation.
    - VLM (gpt-5-mini) provides per-pillar scores (0-5) along with textual issues and recommendations, including location references. VLM scores are blended with CLIP for comprehensive feedback.
- **Manager Labeling**: Managers provide ground-truth pillar scores for submissions, which are used to train and calibrate the AI model using Ridge regression.
- **Escalation System**:
    - Automatically creates escalations for low-scoring submissions (<60%).
    - Managers receive notifications via email (Resend) and Slack for new and aging escalations, with configurable grouping and re-ping mechanisms.
    - Escalation notifications are configurable per manager, with options to toggle email/Slack alerts.
- **Operator Threshold Tuning**: Key operational parameters like `encouragementMinPercent`, `priorBestWindowDays`, and `dueSoonThresholdMinutes` are runtime-tunable. Resolved per field with precedence: environment variables > per-area DB override > global DB override > shipped default. Per-area overrides live in `area_operator_settings` (one row per area) and let managers tighten or relax thresholds for individual workstations without affecting the rest of the plant.
- **Shift Management**: The system automatically detects operator shifts and displays relevant data. Managers can edit the timezone and Shift A/B/C start hours from the in-app "Shifts" page (`/facility-settings`); env vars (`SHIFT_TIMEZONE`, `SHIFT_A/B/C_START_HOUR`) still take precedence and lock the row for ops-pinned deployments.
- **Theming**: Dynamic light/dark theme switching. The "Auto" theme reads the DB-backed facility shift schedule (Shift C → Shift A as the night window) so manager edits to the schedule re-shape the operator UI without a redeploy.

### Feature Specifications
- **Roles**: OPERATOR and MANAGER, with distinct access levels.
- **Shifts**: Supports A, B, and C shifts with configurable start times.
- **Data Models**: Comprehensive data models for users, areas, submissions (with both `tappedAreaId` and `areaId` for auto-detect agreement tracking), labels, escalations, nudges, area profiles, area schedules, operator settings (global + per-area), facility settings, and AI scoring metrics to support all application functionalities.
- **Manager Triage Flow**: A dedicated `/live` page for managers to triage pending areas, overdue checks, low-scoring submissions, and open escalations. Includes inline quick-labeling, searchable submission lists, and keyboard shortcuts for efficient workflow.
- **Notification Grouping**: Batches multiple escalations within a configurable window into a single digest message to reduce notification fatigue.
- **Escalation Re-pings**: A background scheduler re-notifies managers about unaddressed open escalations, with configurable thresholds and maximum re-ping counts.
- **AI Reliability Monitoring**: A dedicated dashboard panel (`AiReliabilityPanel`) and manager-only endpoint (`GET /api/dashboard/ai-reliability`) surface VLM first-try retry rates over the last 24h and 7d windows to help identify misbehaving models or elevated API costs.
- **Area Auto-Detect Agreement (Task #83):** Submissions persist both `tappedAreaId` (operator intent) and `areaId` (chosen area). Manager dashboard surfaces overall + per-area + per-operator agreement so drift between auto-detect suggestions and operator corrections is visible. Disagreements are structure-logged for future profile-prompt tuning.

### System Design Choices
- **OpenAPI Specification**: A single source of truth for API definitions, driving code generation for client-side hooks and validation schemas.
- **Monolithic API Server**: The core business logic resides in a single Express server.
- **Dedicated ML Service**: A separate Python FastAPI service handles AI/ML computations (CLIP embeddings, similarity, Ridge regression).
- **VLM Integration**: Utilizes an OpenAI-compatible API for advanced VLM capabilities, integrated via Replit AI Integrations.
- **Robust Error Handling**: Notifications for escalations are fire-and-forget, ensuring they do not block the main request path. AI scoring gracefully falls back to conservative defaults if the AI pipeline is unavailable.

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
- Precedence: **env var > per-area DB override > global DB override > shipped default**. Defaults live in
  `artifacts/api-server/src/lib/operator-thresholds.ts` and the parallel
  frontend file `artifacts/five-s/src/lib/operator-thresholds.ts`.
- Env-var overrides (read once per process): `ENCOURAGEMENT_MIN_PERCENT`,
  `PRIOR_BEST_WINDOW_DAYS`, `DUE_SOON_THRESHOLD_MS` (note: ms, not minutes —
  legacy name preserved). Invalid values fall through to the next layer.
- Global DB overrides live in the singleton `operator_settings` row (id=1) with
  three nullable int columns + `updated_by_user_id` / `updated_at`.
- Per-area DB overrides live in `area_operator_settings` (one row per area)
  and let managers tighten or relax thresholds for individual workstations
  without affecting the rest of the plant.
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
  manager-only route) with a scope selector that toggles between the global
  editor and a per-area editor; the per-area editor shows inherited values
  with "(global)" / "(default)" markers. Draft state syncs from server only
  when the saved override values change (content fingerprint), so polling
  refetches don't wipe in-flight edits.

## Facility shift settings (Task 71)

- Single-row `facility_settings` table backs a layered shift config: env var > DB > shipped default. `loadEffectiveShiftConfig()` in `artifacts/api-server/src/lib/facility-settings.ts` is the canonical reader; all routes that need shift/timezone info call it per request and pass the resulting `cfg` into scoring helpers (`getCurrentShift`, `getISTDayRange`, `getISTShiftRange`, `getTodayDateString`).
- Endpoints: `GET /api/facility-settings` (public — operational metadata, no PII; needed for the Auto theme on the unauthenticated login screen) and `PUT /api/facility-settings` (manager-only). The PUT validates IANA timezone, integer hours 0–23, and `A < B < C` ordering; bad combinations are rejected outright rather than half-applied.
- Manager admin UI lives at `/facility-settings` (Shifts nav tab, manager-only). Per-field DB override + env-lock badges + effective values + cross-field ordering check, modeled on `/operator-thresholds`.
- Frontend Auto theme subscribes to the live DB-backed schedule via `useNightShiftWindow()` in `artifacts/five-s/src/lib/theme.tsx`; build-time `VITE_NIGHT_SHIFT_*` env vars are no longer read.

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

## Backend Shift Config (api-server env)

The API server's notion of "current shift", per-shift dashboard windows, the
`/shift/current` and `/shift/live` endpoints, and shift-anchored due dates all
read through `loadEffectiveShiftConfig()`, which layers env vars > DB > shipped
defaults. The legacy 06/14/22 IST schedule remains the default so existing
deployments need no changes.

- `SHIFT_TIMEZONE` — IANA timezone the shift clock is anchored to. Default `Asia/Kolkata`.
- `SHIFT_A_START_HOUR` — hour (0-23) shift A starts. Default `6`.
- `SHIFT_B_START_HOUR` — hour (0-23) shift B starts. Default `14`.
- `SHIFT_C_START_HOUR` — hour (0-23) shift C starts. Default `22`. Shift C wraps across midnight up to the next day's `SHIFT_A_START_HOUR`.

Constraints: must satisfy `SHIFT_A_START_HOUR < SHIFT_B_START_HOUR < SHIFT_C_START_HOUR`. Invalid values silently fall back to the defaults. When env vars are set they lock out the corresponding DB field on the manager `/facility-settings` page (badge + disabled input).

The frontend reads this same config via `GET /shift/config` (cached app-wide through `useShiftConfig()` in `artifacts/five-s/src/lib/shift-config.tsx`) and the unauthenticated Auto theme reads `GET /facility-settings` via `useNightShiftWindow()`. Header clock, live shift header, quiet-hours badge/summary, the quiet-hours time-input labels, and the operator page's shift pill switcher (both the active-shift view and the unknown-shift fallback) all render against the configured timezone and `startHours` (e.g. "Shift A · 7 AM – 3 PM" instead of "6 AM – 2 PM" for a US site). The hook also exposes `shiftLabels`, derived from backend `startHours`, so the operator pills no longer rely on Vite build-time `VITE_NIGHT_SHIFT_*` env (which could drift from the backend). When the call is in flight, the hook falls back to the legacy IST defaults so the UI never blanks.

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
