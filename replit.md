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
