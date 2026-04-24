import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  areasTable,
  submissionsTable,
  labelsTable,
  nudgesTable,
  escalationsTable,
  areaSchedulesTable,
  areaProfilesTable,
} from "@workspace/db";
import app from "../src/app.js";
import { signToken } from "../src/lib/auth.js";

export interface TestUser {
  id: number;
  email: string;
  role: "MANAGER" | "OPERATOR";
  token: string;
}

export interface TestArea {
  id: number;
  name: string;
  tag: string;
}

/**
 * Per-test bookkeeping. Every row inserted via this object is tracked so
 * `cleanup()` can remove just the data this test created — important because
 * the integration tests run against the real dev database that may also
 * contain seeded data we must not touch.
 */
export class TestWorld {
  userIds: number[] = [];
  areaIds: number[] = [];

  async createUser(role: "MANAGER" | "OPERATOR", emailHint = "user"): Promise<TestUser> {
    const tag = randomBytes(6).toString("hex");
    const email = `${emailHint}-${tag}@5s.test`;
    const passwordHash = await bcrypt.hash("test", 4);
    const [u] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role })
      .returning();
    this.userIds.push(u.id);
    return { id: u.id, email, role, token: signToken({ userId: u.id, role }) };
  }

  async createArea(nameHint = "Area"): Promise<TestArea> {
    const tag = randomBytes(6).toString("hex");
    const name = `${nameHint}-test-${tag}`;
    const [a] = await db.insert(areasTable).values({ name }).returning();
    this.areaIds.push(a.id);
    return { id: a.id, name, tag };
  }

  async cleanup(): Promise<void> {
    if (this.areaIds.length > 0) {
      await db.delete(escalationsTable).where(inArray(escalationsTable.areaId, this.areaIds));
      const subs = await db
        .select({ id: submissionsTable.id })
        .from(submissionsTable)
        .where(inArray(submissionsTable.areaId, this.areaIds));
      const subIds = subs.map((s) => s.id);
      if (subIds.length > 0) {
        await db.delete(labelsTable).where(inArray(labelsTable.submissionId, subIds));
        await db.delete(submissionsTable).where(inArray(submissionsTable.id, subIds));
      }
      await db.delete(nudgesTable).where(inArray(nudgesTable.areaId, this.areaIds));
      await db.delete(areaSchedulesTable).where(inArray(areaSchedulesTable.areaId, this.areaIds));
      await db.delete(areaProfilesTable).where(inArray(areaProfilesTable.areaId, this.areaIds));
      await db.delete(areasTable).where(inArray(areasTable.id, this.areaIds));
    }
    if (this.userIds.length > 0) {
      // Some users (operators) may also own escalations or submissions in
      // OTHER areas only if a previous test crashed. Best-effort: rely on
      // the per-area cascade above for normal cleanup.
      await db.delete(usersTable).where(inArray(usersTable.id, this.userIds));
    }
  }
}

let server: Server | null = null;
let baseUrl: string | null = null;

export async function getBaseUrl(): Promise<string> {
  if (baseUrl) return baseUrl;
  return new Promise((resolve, reject) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve(baseUrl);
      } else {
        reject(new Error("Failed to obtain server address"));
      }
    });
    server.on("error", reject);
  });
}

export async function closeServer(): Promise<void> {
  if (server) {
    await new Promise<void>((res) => server!.close(() => res()));
    server = null;
    baseUrl = null;
  }
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const url = (await getBaseUrl()) + path;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: resp.status, body: parsed as T };
}
