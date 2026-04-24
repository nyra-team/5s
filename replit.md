# 5S Compliance App

## Overview

This project is a full-stack web application designed to enhance 5S compliance in manufacturing environments. It enables operators to photograph workstations, receiving AI-powered 5S scores and VLM-generated improvement suggestions. Managers can track compliance, analyze score trends, manage reference photos, and label submissions for AI model calibration. The core purpose is to improve workplace organization and efficiency through AI-driven insights and streamlined management tools.

## User Preferences

The user has not specified any preferences.

## System Architecture

The application is built as a monorepo using pnpm workspaces, with Node.js 24 and TypeScript 5.9.

**Frontend:**
-   Developed with React, Vite, and Tailwind CSS.

**Backend:**
-   Uses Express 5.
-   Authentication is handled via JWT with email/password and bcryptjs.
-   Data validation uses Zod and drizzle-zod.
-   API client code generation is performed using Orval from an OpenAPI specification.
-   File uploads (images) are managed by Multer and stored locally in an `uploads/` directory.

**Database:**
-   PostgreSQL is used as the database, interfaced with Drizzle ORM.

**AI/ML Services:**
-   A dedicated Python FastAPI service (internal only) handles CLIP ViT-B/32 embeddings, similarity computations, and Ridge regression for AI scoring and model training.
-   An OpenAI-compatible API (via Replit AI Integrations, specifically gpt-5-mini) provides VLM capabilities for generating detailed improvement suggestions and per-pillar scores.
-   AI scoring involves computing CLIP embeddings, comparing them via cosine similarity to ideal reference photos, and applying various scoring modes (CALIBRATED, VLM_BLENDED, SIMILARITY_ONLY, FALLBACK).
-   VLM provides per-pillar scores (0-5) and location-specific issues/recommendations, which are blended with CLIP similarity.
-   Managers can label submissions with ground-truth pillar scores to calibrate the AI model using Ridge regression.

**Key Features:**
-   **Role-Based Access:** OPERATOR and MANAGER roles with JWT-based authentication.
-   **Automated Shift Detection:** Operators' views adjust based on auto-detected shifts (A, B, C).
-   **AI-Powered Scoring & Suggestions:** Provides 0-25 5S scores and VLM-generated, location-specific improvement suggestions.
-   **Manager Dashboard:** Offers compliance tracking, score trends, submission browsing, ideal photo management, and AI calibration tools.
-   **Escalation Management:** Automatically escalates low-scoring submissions, with configurable notification channels (email, Slack) and re-ping reminders for open escalations.
-   **Operator Threshold Tuning:** Runtime-tunable parameters for operator-facing cutoffs (e.g., encouragement thresholds, prior best lookback window, due soon lead time). Resolved per field with precedence: environment variables > per-area DB override > global DB override > shipped default. Per-area overrides live in `area_operator_settings` (one row per area) and let managers tighten or relax thresholds for individual workstations without affecting the rest of the plant.
-   **Theming:** Dynamic light/dark theme switching based on configured night shift hours and timezone.

**UI/UX Decisions:**
-   Frontend built with React and Tailwind CSS for a modern, responsive interface.
-   Manager views include dashboards with charts for compliance and score trends, a submission browser, and an interface for managing ideal photos and labeling submissions.
-   Keyboard shortcuts are implemented for managers in submission lists for efficient navigation and action.
-   Notifications UI allows managers to configure preferences for email and Slack.
-   Operator thresholds are managed via a dedicated manager admin UI with a scope selector that toggles between the global editor and a per-area editor; the per-area editor shows inherited values with "(global)" / "(default)" markers so the manager always knows what they're falling back to.

## External Dependencies

-   **PostgreSQL**: Primary database.
-   **OpenAI-compatible API (Replit AI Integrations)**: For VLM (gpt-5-mini) capabilities.
-   **Resend**: For sending email notifications.
-   **Slack Webhooks**: For sending Slack notifications.
-   **CLIP ViT-B/32 (open_clip_torch)**: Used in the ML service for image embedding.
-   **scikit-learn**: Used in the ML service for Ridge regression.