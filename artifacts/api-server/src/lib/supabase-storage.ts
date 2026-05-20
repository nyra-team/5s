/**
 * Supabase Storage helper — talks to the Storage REST API directly via
 * fetch() rather than via @supabase/supabase-js. The full SDK pulls in a
 * Realtime client that needs native WebSocket support, which Node 20
 * doesn't have, and would crash module init at startup. We only need
 * upload + signed-URL, so a thin REST wrapper is more honest about the
 * surface we use anyway.
 *
 * `enabled()` short-circuits the whole subsystem when SUPABASE_URL or the
 * service-role key isn't set, so local-only dev works without any
 * Supabase configuration.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

let _url = "";
let _key = "";
let _bucket = "uploads";
let _enabled = false;

function init(): void {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  _bucket = process.env["SUPABASE_STORAGE_BUCKET"] || "uploads";
  if (!url || !key) {
    _enabled = false;
    return;
  }
  _url = url.replace(/\/+$/, "");
  _key = key;
  _enabled = true;
}

init();

export function isStorageEnabled(): boolean {
  return _enabled;
}

export function storageBucket(): string {
  return _bucket;
}

/**
 * Replicate a local file into Supabase Storage. Idempotent — `x-upsert: true`
 * means a re-upload overwrites the existing object instead of 409-ing.
 * Returns true if the file landed; false otherwise.
 */
export async function uploadFileToStorage(
  localPath: string,
  storagePath: string,
  contentType: string,
): Promise<boolean> {
  if (!_enabled) return false;
  try {
    const buf = fs.readFileSync(localPath);
    const res = await fetch(
      `${_url}/storage/v1/object/${encodeURIComponent(_bucket)}/${encodeURI(storagePath)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${_key}`,
          apikey: _key,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: new Uint8Array(buf),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200), storagePath }, "supabase storage upload failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, localPath, storagePath }, "supabase storage upload threw");
    return false;
  }
}

/**
 * Mint a signed URL for a file in Storage. Returns null on failure so the
 * caller can fall back to local serving or surface a 404.
 *
 * Default TTL: 1 hour. The frontend's `<img>` tag holds the URL for
 * roughly that long; if a manager keeps the page open longer they'll
 * either re-fetch or trigger a fresh signed URL on the next render.
 */
export async function signedUrlForStorage(
  storagePath: string,
  ttlSeconds = 3600,
): Promise<string | null> {
  if (!_enabled) return null;
  try {
    const res = await fetch(
      `${_url}/storage/v1/object/sign/${encodeURIComponent(_bucket)}/${encodeURI(storagePath)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${_key}`,
          apikey: _key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200), storagePath }, "supabase signed-url request failed");
      return null;
    }
    const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
    // The REST API returns a `signedURL` relative path (e.g. /object/sign/...);
    // we prepend the project base so the caller gets a fully-qualified URL
    // ready to use as a redirect target.
    const rel = data.signedURL ?? data.signedUrl;
    if (!rel) return null;
    return rel.startsWith("http") ? rel : `${_url}/storage/v1${rel}`;
  } catch (err) {
    logger.warn({ err, storagePath }, "supabase signed-url threw");
    return null;
  }
}

/**
 * Determine the storage path for a local filename, preserving the basename
 * so the dHash-keyed cache and existing imageUrl references still resolve.
 * Strips any leading path components and leading slashes.
 */
export function storagePathForFilename(localPathOrName: string): string {
  return path.basename(localPathOrName);
}
