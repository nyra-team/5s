import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";
import { logger } from "./logger.js";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

let ffmpegAvailable: boolean | null = null;

/**
 * Probe ffmpeg once at startup. Logs a warning if missing — video walk-throughs
 * will fall back to single-frame analysis (operators get clear messaging) but
 * the API stays up so escalations and other features remain reachable.
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
  if (!ffmpegAvailable) {
    logger.warn(
      "ffmpeg not found on PATH — video walk-throughs will be analyzed as a single frame. Install ffmpeg for full multi-frame keyframe analysis.",
    );
  } else {
    logger.info("ffmpeg available — multi-frame keyframe analysis enabled.");
  }
  return ffmpegAvailable;
}

export function isFfmpegAvailable(): boolean {
  return ffmpegAvailable === true;
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".3gp", ".ogv"]);
const VIDEO_MIME_PREFIX = "video/";

export function isVideoFile(file: { mimetype?: string; originalname?: string; filename?: string }): boolean {
  if (file.mimetype?.startsWith(VIDEO_MIME_PREFIX)) return true;
  const name = file.originalname || file.filename || "";
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

export interface KeyframeResult {
  frameUrls: string[];
  frameAbsPaths: string[];
}

export interface KeyframeOptions {
  /** Hard cap on number of frames returned. Default: 6. */
  maxFrames?: number;
  /**
   * Hard cap on the number of *raw* candidate frames pulled out of ffmpeg
   * before the dedup pass runs. Bounding this keeps both the ffmpeg pass and
   * the per-frame dHash work from growing with video length / scene density.
   *
   * Resolution order: explicit option → `KEYFRAMES_MAX_CANDIDATES` env var →
   * `maxFrames * 3`. Always coerced to be at least `maxFrames` so dedup can
   * still produce a full result set.
   */
  maxCandidates?: number;
  /** Scene-change threshold for ffmpeg's `select=gt(scene,X)` filter. 0..1. Default: 0.3 */
  sceneThreshold?: number;
  /** Hamming-distance threshold for the dHash dedup pass; lower = stricter. Default: 5 */
  dedupHammingThreshold?: number;
  /** Fallback fixed-interval (seconds) used when scene detection finds nothing. Default: 2 */
  fallbackIntervalSec?: number;
}

/**
 * Resolve the upstream candidate cap used when invoking ffmpeg. Pulled out so
 * tests can lock the precedence rules (option > env var > derived default)
 * without spinning up ffmpeg.
 */
export function resolveCandidateCap(maxFrames: number, optsOverride?: number): number {
  const envRaw = process.env.KEYFRAMES_MAX_CANDIDATES;
  let envVal: number | undefined;
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) envVal = Math.floor(parsed);
  }
  const chosen = optsOverride ?? envVal ?? maxFrames * 3;
  // Floor to maxFrames so we never starve the dedup pass below the desired
  // output size, and clamp negatives/NaN defensively.
  if (!Number.isFinite(chosen) || chosen <= 0) return maxFrames;
  return Math.max(maxFrames, Math.floor(chosen));
}

/**
 * Compute a 64-bit difference hash (dHash) for a small image. Two images with
 * a Hamming distance ≤ ~5 are visually near-identical, regardless of minor
 * compression artifacts. Returned as 8 bytes so we can cheaply XOR.
 */
async function computeDHash(absPath: string): Promise<Buffer> {
  // 9x8 grayscale → compare each pixel to its right-hand neighbor → 8 rows x 8 bits.
  const raw = await sharp(absPath)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  // raw is row-major; index = row*9 + col
  const out = Buffer.alloc(8);
  for (let row = 0; row < 8; row++) {
    let bits = 0;
    for (let col = 0; col < 8; col++) {
      const left = raw[row * 9 + col];
      const right = raw[row * 9 + col + 1];
      bits = (bits << 1) | (left < right ? 1 : 0);
    }
    out[row] = bits & 0xff;
  }
  return out;
}

function hammingDistance(a: Buffer, b: Buffer): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Resize and re-encode an image as a JPEG suited for VLM input (max 1024px
 * on the longest side, q=85). If `outputPath` is omitted the file is
 * rewritten in place — only safe when the input is already a JPEG (e.g.
 * ffmpeg-extracted keyframes). For arbitrary uploads (PNG, HEIC, etc.) the
 * caller MUST pass an explicit `outputPath` so the original media file
 * keeps its declared extension/MIME and stays viewable as evidence.
 */
export async function compressForVLM(
  absPath: string,
  outputPath?: string,
  maxDim = 1024,
  quality = 85,
): Promise<string> {
  const target = outputPath ?? absPath;
  try {
    if (target === absPath) {
      // In-place rewrite: stage to a sibling tmp file then atomic-rename so
      // a partial write can't leave the original truncated.
      const tmpPath = absPath + ".tmp.jpg";
      await sharp(absPath)
        .rotate() // honor EXIF orientation
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, absPath);
    } else {
      await sharp(absPath)
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toFile(target);
    }
    return target;
  } catch (err) {
    logger.warn({ err, absPath, outputPath }, "compressForVLM failed; sending original");
    return absPath;
  }
}

/**
 * Wall-clock budget for any single ffmpeg invocation. Broken or maliciously
 * long uploads would otherwise stall an API worker indefinitely (each scoring
 * call awaits ffmpeg synchronously). On timeout we SIGKILL and let the caller
 * fall back to interval sampling or to a single-frame error result.
 *
 * Override via FFMPEG_TIMEOUT_MS (e.g. 30000) for slow CI hosts.
 */
const FFMPEG_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FFMPEG_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * Run ffmpeg with the given filter graph. Returns the list of frame files
 * produced (sorted). Throws on non-zero exit OR on timeout (so callers can
 * fall back to a different sampling strategy or to single-frame mode).
 */
async function runFfmpeg(videoAbsPath: string, vfilter: string, maxCandidates: number, idPrefix: string): Promise<string[]> {
  const pattern = path.join(UPLOAD_DIR, `${idPrefix}_%03d.jpg`);
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i", videoAbsPath,
      "-vf", vfilter,
      "-vsync", "vfr",
      // Cap raw candidate frames so ffmpeg short-circuits on long videos and
      // the dedup pass never has to hash more than this many frames.
      "-frames:v", String(maxCandidates),
      "-q:v", "3",
      pattern,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    proc.stderr.on("data", (b) => { stderr += b.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { videoAbsPath, vfilter, timeoutMs: FFMPEG_TIMEOUT_MS },
        "ffmpeg invocation exceeded timeout; killing",
      );
      try { proc.kill("SIGKILL"); } catch { /* best-effort */ }
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    timer.unref?.();

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
  return fs.readdirSync(UPLOAD_DIR)
    .filter((f) => f.startsWith(`${idPrefix}_`) && f.endsWith(".jpg"))
    .sort();
}

/**
 * Extract up to `maxFrames` keyframes from a video. Uses ffmpeg's scene-change
 * detection so the model sees visually distinct moments rather than a stream
 * of near-identical 2-second snapshots. A perceptual-hash dedup pass drops any
 * frames that survive scene detection but are still near-duplicates of an
 * already-selected one. Each surviving frame is downscaled and recompressed
 * to keep VLM payloads small.
 *
 * If scene detection returns nothing (very static video), we fall back to a
 * fixed-interval sample so the operator still gets analysis.
 */
export async function extractKeyframes(
  videoAbsPath: string,
  opts: KeyframeOptions = {}
): Promise<KeyframeResult> {
  const maxFrames = opts.maxFrames ?? 6;
  const sceneThreshold = opts.sceneThreshold ?? 0.3;
  const hammingThreshold = opts.dedupHammingThreshold ?? 5;
  const fallbackInterval = opts.fallbackIntervalSec ?? 2;
  const maxCandidates = resolveCandidateCap(maxFrames, opts.maxCandidates);
  const id = crypto.randomUUID();

  // Per-step timings let operators (and on-call) see exactly where a slow
  // walk-through went: scene detection vs. fallback sample vs. dedup vs.
  // VLM-prep compression. Exposed as a single structured log line at the end.
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const tick = (label: string, since: number) => {
    timings[label] = Date.now() - since;
  };

  // 1. Scene-change selection. Pre-scale to keep ffmpeg cheap.
  const sceneFilter = `select='gt(scene\\,${sceneThreshold})',scale=720:-2`;
  let candidates: string[] = [];
  const tScene = Date.now();
  try {
    candidates = await runFfmpeg(videoAbsPath, sceneFilter, maxCandidates, `${id}_s`);
  } catch (err) {
    logger.warn({ err, videoAbsPath }, "scene-change ffmpeg pass failed");
  }
  tick("sceneDetectMs", tScene);

  // 2. Fallback to fixed interval if scene detection found nothing.
  if (candidates.length === 0) {
    const intervalFilter = `fps=1/${fallbackInterval},scale=720:-2`;
    const tFallback = Date.now();
    try {
      candidates = await runFfmpeg(videoAbsPath, intervalFilter, maxCandidates, `${id}_i`);
    } catch (err) {
      logger.warn({ err, videoAbsPath }, "fallback interval ffmpeg pass failed");
    }
    tick("fallbackSampleMs", tFallback);
  }

  if (candidates.length === 0) {
    logger.warn(
      { videoAbsPath, totalMs: Date.now() - t0, ...timings },
      "Keyframe extraction produced no frames",
    );
    return { frameUrls: [], frameAbsPaths: [] };
  }

  // 3. Perceptual-hash dedup — drop any frame within hammingThreshold bits of
  //    an already-kept frame. This catches duplicates that survive scene
  //    detection (e.g. flicker / slow pans) before the expensive VLM call.
  const tDedup = Date.now();
  const kept: { name: string; hash: Buffer }[] = [];
  for (const name of candidates) {
    const abs = path.join(UPLOAD_DIR, name);
    let hash: Buffer;
    try { hash = await computeDHash(abs); }
    catch (err) {
      // If hashing fails, keep the frame defensively rather than dropping it.
      logger.warn({ err, name }, "dHash failed; keeping frame without dedup");
      kept.push({ name, hash: Buffer.alloc(8) });
      if (kept.length >= maxFrames) break;
      continue;
    }
    const dup = kept.some((k) => k.hash.length > 0 && hammingDistance(k.hash, hash) <= hammingThreshold);
    if (dup) {
      try { fs.unlinkSync(abs); } catch { /* best-effort */ }
      continue;
    }
    kept.push({ name, hash });
    if (kept.length >= maxFrames) break;
  }
  tick("dedupMs", tDedup);

  // Anything beyond the cap that we never inspected — clean up disk too.
  for (const name of candidates) {
    if (kept.find((k) => k.name === name)) continue;
    const abs = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch { /* best-effort */ }
    }
  }

  // 4. Compress survivors for the VLM payload.
  const tCompress = Date.now();
  const survivors = kept.map((k) => k.name);
  await Promise.all(
    survivors.map((name) => compressForVLM(path.join(UPLOAD_DIR, name)))
  );
  tick("compressMs", tCompress);

  logger.info(
    {
      videoAbsPath,
      candidates: candidates.length,
      survivors: survivors.length,
      totalMs: Date.now() - t0,
      ...timings,
    },
    "keyframe extraction completed",
  );

  return {
    frameUrls: survivors.map((f) => `/uploads/${f}`),
    frameAbsPaths: survivors.map((f) => path.join(UPLOAD_DIR, f)),
  };
}

// Exposed for tests.
export const __test__ = { computeDHash, hammingDistance };
