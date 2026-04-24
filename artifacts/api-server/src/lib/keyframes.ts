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

/**
 * Per-call metrics for a single video walk-through analysis. Returned from
 * `extractKeyframes` and emitted as a structured info log so operators can see
 * exactly where time went and how aggressive the dedup pass was.
 *
 * - `candidatesProduced` is the total number of raw frames ffmpeg yielded
 *   (across the scene-detect pass and, if it found nothing, the fallback
 *   interval pass).
 * - `candidatesKept` is the number of frames that survived dedup and made it
 *   into the VLM payload.
 * - `droppedDuplicate` is the number of frames the perceptual-hash dedup pass
 *   discarded as visually-identical to an already-kept frame.
 * - `droppedOverCap` is the number of remaining candidates that were
 *   discarded after `maxFrames` slots had already been filled. (They are
 *   still hashed first, so this number reflects evidence we threw away to
 *   respect the output cap, not work we skipped.)
 */
export interface KeyframeMetrics {
  candidatesProduced: number;
  candidatesKept: number;
  droppedDuplicate: number;
  droppedOverCap: number;
  /** True iff the fallback fixed-interval pass had to run. */
  usedFallback: boolean;
  totalMs: number;
  sceneDetectMs: number;
  /** Only present when scene detection produced nothing. */
  fallbackSampleMs?: number;
  dedupMs: number;
  compressMs: number;
}

export interface KeyframeResult {
  frameUrls: string[];
  frameAbsPaths: string[];
  metrics: KeyframeMetrics;
}

/**
 * Stable log event name for the structured per-call timing/counts payload.
 * Emitted from `extractKeyframes` so log consumers (operators triaging slow
 * audits, dashboards) can filter on a single field instead of grepping a
 * human-readable message string.
 */
export const KEYFRAME_LOG_EVENT = "keyframe_extraction";

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
 * Override via FFMPEG_TIMEOUT_MS (e.g. 30000) for slow CI hosts. Resolved per
 * call so tests (and operators) can tweak the env var without restarting.
 */
function getFfmpegTimeoutMs(): number {
  const raw = Number(process.env.FFMPEG_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Resolve the ffmpeg binary to spawn. Defaults to `ffmpeg` on PATH; tests
 * point this at a fake hanging binary to exercise the timeout path without
 * requiring a real malformed video.
 */
function getFfmpegBin(): string {
  const bin = process.env.FFMPEG_BIN;
  return bin && bin.length > 0 ? bin : "ffmpeg";
}

/**
 * Run ffmpeg with the given filter graph. Returns the list of frame files
 * produced (sorted). Throws on non-zero exit OR on timeout (so callers can
 * fall back to a different sampling strategy or to single-frame mode).
 */
async function runFfmpeg(videoAbsPath: string, vfilter: string, maxCandidates: number, idPrefix: string): Promise<string[]> {
  const pattern = path.join(UPLOAD_DIR, `${idPrefix}_%03d.jpg`);
  const timeoutMs = getFfmpegTimeoutMs();
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
    const proc = spawn(getFfmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    proc.stderr.on("data", (b) => { stderr += b.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { videoAbsPath, vfilter, timeoutMs },
        "ffmpeg invocation exceeded timeout; killing",
      );
      try { proc.kill("SIGKILL"); } catch { /* best-effort */ }
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
 * One frame produced by ffmpeg, paired with its perceptual hash. A zero-length
 * hash buffer signals "hashing failed for this frame" so the dedup helper can
 * keep the frame defensively without comparing it against anything.
 */
interface HashedFrame {
  name: string;
  hash: Buffer;
}

/**
 * Pure dedup decision: walk `candidates` in order, keep the first `maxKeep`
 * that aren't within `hammingThreshold` bits of an already-kept frame, and
 * report counts of what was kept vs. dropped vs. never looked at.
 *
 * Extracted so the dropped-as-duplicate vs. dropped-as-over-cap accounting
 * can be unit-tested without spinning up ffmpeg or touching the filesystem.
 *
 * NOTE: Frames whose hash buffer is empty (length 0) are treated as
 * unhashable: they bypass the duplicate check (so they're kept rather than
 * silently dropped as evidence), but they still respect `maxKeep` and will
 * be counted as `droppedOverCap` if the cap is already full.
 */
export function pickUniqueByHash(
  candidates: HashedFrame[],
  hammingThreshold: number,
  maxKeep: number,
): { kept: HashedFrame[]; droppedDuplicate: number; droppedOverCap: number } {
  const kept: HashedFrame[] = [];
  let droppedDuplicate = 0;
  let droppedOverCap = 0;
  for (const c of candidates) {
    if (kept.length >= maxKeep) {
      droppedOverCap++;
      continue;
    }
    const isDup =
      c.hash.length > 0 &&
      kept.some((k) => k.hash.length > 0 && hammingDistance(k.hash, c.hash) <= hammingThreshold);
    if (isDup) {
      droppedDuplicate++;
      continue;
    }
    kept.push(c);
  }
  return { kept, droppedDuplicate, droppedOverCap };
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
 *
 * Per-step timings and per-call counts (candidates produced, kept, dropped as
 * duplicate, dropped as over-cap) are recorded on the returned `metrics` and
 * also emitted as a single structured info log under the `KEYFRAME_LOG_EVENT`
 * event name so an operator/manager can audit how long a walk-through took
 * and how aggressive the dedup pass was.
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
  // VLM-prep compression. Exposed via the returned metrics AND a single
  // structured log line at the end.
  const t0 = Date.now();
  let sceneDetectMs = 0;
  let fallbackSampleMs: number | undefined;
  let dedupMs = 0;
  let compressMs = 0;

  // 1. Scene-change selection. Pre-scale to keep ffmpeg cheap.
  const sceneFilter = `select='gt(scene\\,${sceneThreshold})',scale=720:-2`;
  let candidates: string[] = [];
  const tScene = Date.now();
  try {
    candidates = await runFfmpeg(videoAbsPath, sceneFilter, maxCandidates, `${id}_s`);
  } catch (err) {
    logger.warn({ err, videoAbsPath }, "scene-change ffmpeg pass failed");
  }
  sceneDetectMs = Date.now() - tScene;

  // 2. Fallback to fixed interval if scene detection found nothing.
  let usedFallback = false;
  if (candidates.length === 0) {
    usedFallback = true;
    const intervalFilter = `fps=1/${fallbackInterval},scale=720:-2`;
    const tFallback = Date.now();
    try {
      candidates = await runFfmpeg(videoAbsPath, intervalFilter, maxCandidates, `${id}_i`);
    } catch (err) {
      logger.warn({ err, videoAbsPath }, "fallback interval ffmpeg pass failed");
    }
    fallbackSampleMs = Date.now() - tFallback;
  }

  if (candidates.length === 0) {
    const metrics: KeyframeMetrics = {
      candidatesProduced: 0,
      candidatesKept: 0,
      droppedDuplicate: 0,
      droppedOverCap: 0,
      usedFallback,
      totalMs: Date.now() - t0,
      sceneDetectMs,
      ...(fallbackSampleMs !== undefined ? { fallbackSampleMs } : {}),
      dedupMs: 0,
      compressMs: 0,
    };
    logger.warn(
      { event: KEYFRAME_LOG_EVENT, videoAbsPath, ...metrics },
      "Keyframe extraction produced no frames",
    );
    return { frameUrls: [], frameAbsPaths: [], metrics };
  }

  // 3. Perceptual-hash dedup — hash each candidate, then let pickUniqueByHash
  //    decide what to keep vs. drop. The dropped-as-duplicate vs.
  //    dropped-as-over-cap split is what we surface in the metrics.
  const tDedup = Date.now();
  const hashed: HashedFrame[] = [];
  for (const name of candidates) {
    const abs = path.join(UPLOAD_DIR, name);
    try {
      hashed.push({ name, hash: await computeDHash(abs) });
    } catch (err) {
      // Mark unhashable so pickUniqueByHash keeps the frame defensively
      // (see helper docstring).
      logger.warn({ err, name }, "dHash failed; keeping frame without dedup");
      hashed.push({ name, hash: Buffer.alloc(0) });
    }
  }
  const { kept, droppedDuplicate, droppedOverCap } = pickUniqueByHash(
    hashed,
    hammingThreshold,
    maxFrames,
  );
  dedupMs = Date.now() - tDedup;

  // Drop the on-disk files for everything we discarded (duplicates and
  // over-cap candidates alike) so the uploads dir doesn't accumulate
  // inspector frames between submissions.
  const keptNames = new Set(kept.map((k) => k.name));
  for (const name of candidates) {
    if (keptNames.has(name)) continue;
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
  compressMs = Date.now() - tCompress;

  const metrics: KeyframeMetrics = {
    candidatesProduced: candidates.length,
    candidatesKept: survivors.length,
    droppedDuplicate,
    droppedOverCap,
    usedFallback,
    totalMs: Date.now() - t0,
    sceneDetectMs,
    ...(fallbackSampleMs !== undefined ? { fallbackSampleMs } : {}),
    dedupMs,
    compressMs,
  };

  logger.info(
    { event: KEYFRAME_LOG_EVENT, videoAbsPath, ...metrics },
    "keyframe extraction completed",
  );

  return {
    frameUrls: survivors.map((f) => `/uploads/${f}`),
    frameAbsPaths: survivors.map((f) => path.join(UPLOAD_DIR, f)),
    metrics,
  };
}

// Exposed for tests.
export const __test__ = { computeDHash, hammingDistance };
