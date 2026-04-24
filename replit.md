# 5S Compliance App

## Overview
A full-stack web application for manufacturing environments to enforce 5S compliance. It allows operators to submit workstation photos, which an AI scores using CLIP embedding similarity against ideal reference photos. VLM-generated suggestions provide location-specific improvement recommendations. Managers can track compliance, analyze score trends, manage reference photos, and label submissions for continuous AI model calibration. The project aims to enhance workplace organization and efficiency.

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
- **Frontend**: Built with React, Vite, and Tailwind CSS for a modern, responsive UI.
- **Operator View**: Guides operators through photo submission, displays AI-powered 5S scores, and provides actionable, location-specific improvement suggestions.
- **Manager View**: Features a dashboard for compliance tracking, score trends, submission browsing, ideal photo management, and AI model calibration through labeling.
- **Design Approach**: Intuitive UI with quick-labeling and keyboard shortcuts for managers. Uses color schemes and visual feedback to highlight compliance status. Operator thresholds are managed via a dedicated manager admin UI with global and per-area editing.
- **Theming**: Dynamic light/dark theme switching, with an "Auto" theme linked to the facility's shift schedule.

### Technical Implementations
- **Monorepo**: Uses pnpm workspaces.
- **Backend**: Express 5 for API, authentication, and database interactions.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication**: JWT-based with email/password and bcryptjs for user roles (OPERATOR, MANAGER).
- **Validation**: Zod for schema validation.
- **API Codegen**: Orval generates API hooks and Zod schemas from an OpenAPI specification.
- **File Uploads**: Multer for local image storage.
- **AI Scoring Pipeline**:
    - Leverages CLIP ViT-B/32 embeddings to compare submission photos against ideal workstation photos using cosine similarity.
    - Multiple scoring modes: `CALIBRATED` (using Ridge regression from manager labels), `VLM_BLENDED` (70% VLM, 30% CLIP), `SIMILARITY_ONLY`, and `FALLBACK`.
    - CLIP similarity is rescaled to a 0-25 score range for granular differentiation.
    - VLM (gpt-5-mini) provides per-pillar scores (0-5) along with textual issues and recommendations, including location references. VLM scores are blended with CLIP for comprehensive feedback.
- **Manager Labeling**: Managers provide ground-truth pillar scores for submissions, which are used to train and calibrate the AI model using Ridge regression.
- **Escalation System**:
    - Automatic escalation for low-scoring submissions (<60%).
    - Managers receive notifications via email (Resend) and Slack for new and aging escalations, with configurable grouping and re-ping mechanisms.
- **Operator Threshold Tuning**: Runtime-tunable parameters (`encouragementMinPercent`, `priorBestWindowDays`, `dueSoonThresholdMinutes`) with precedence: environment variables > per-area DB override > global DB override > shipped default. Every per-field change writes to `operator_settings_audit`; that table is bounded by an inline post-insert prune that keeps the last N rows per field (default 50, override via `OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD`) so the table can't grow unbounded — see `artifacts/api-server/src/lib/audit-prune.ts`.
- **Shift Management**: Automatically detects operator shifts. Managers can configure timezone and shift start hours in-app, with environment variables taking precedence.

### Feature Specifications
- **Roles**: OPERATOR and MANAGER with distinct access levels.
- **Shifts**: Supports A, B, C shifts with configurable start times.
- **Data Models**: Comprehensive models for users, areas, submissions, labels, escalations, nudges, profiles, schedules, and settings.
- **Manager Triage Flow**: Dedicated `/live` page for triaging pending areas, overdue checks, low-scoring submissions, and open escalations, with quick-labeling and keyboard shortcuts.
- **Notification Grouping**: Batches multiple escalations within a configurable window to reduce notification fatigue.
- **Escalation Re-pings**: A background scheduler re-notifies managers about unaddressed open escalations based on configurable thresholds.
- **AI Metrics Retention**: A daily background sweep (`startMetricsRetentionScheduler` in `artifacts/api-server/src/lib/metrics-retention.ts`) deletes `ai_scoring_metrics` rows older than 30 days. The dashboard only reads the last 7 days from this table; the 30-day buffer keeps room for ad-hoc investigations while preventing unbounded growth. Tune the window by editing the `AI_SCORING_METRICS_RETENTION_DAYS` constant.
- **AI Reliability Monitoring**: Dashboard panel and endpoint to surface VLM first-try retry rates.
- **Area Auto-Detect Agreement**: Tracks agreement between operator-selected area and auto-detected area.

### System Design Choices
- **OpenAPI Specification**: Single source of truth for API definitions.
- **Monolithic API Server**: Core business logic in a single Express server.
- **Dedicated ML Service**: Separate Python FastAPI service for AI/ML computations (CLIP, Ridge regression).
- **VLM Integration**: Utilizes an OpenAI-compatible API via Replit AI Integrations.
- **Robust Error Handling**: Fire-and-forget notifications for escalations; AI scoring falls back gracefully if unavailable.

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
- **Authentication Libraries**: bcryptjs, jsonwebtoken
- **Validation Library**: Zod
- **API Codegen**: Orval
- **File Upload Middleware**: Multer
- **Testing Frameworks**: Vitest, Supertest, @testing-library/react
