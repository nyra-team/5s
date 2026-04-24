import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
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

/**
 * Extract up to `maxFrames` evenly-spaced JPEG keyframes from a video file.
 * Returns the urls (uploads-relative) and absolute disk paths.
 */
export async function extractKeyframes(
  videoAbsPath: string,
  opts: { maxFrames?: number; intervalSec?: number } = {}
): Promise<KeyframeResult> {
  const maxFrames = opts.maxFrames ?? 6;
  const intervalSec = opts.intervalSec ?? 2;
  const id = crypto.randomUUID();
  const pattern = path.join(UPLOAD_DIR, `${id}_%03d.jpg`);

  // Sample 1 frame every `intervalSec` seconds, scale down for cost, cap at maxFrames.
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i", videoAbsPath,
      "-vf", `fps=1/${intervalSec},scale=720:-2`,
      "-frames:v", String(maxFrames),
      "-q:v", "3",
      pattern,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });

  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => f.startsWith(`${id}_`) && f.endsWith(".jpg"))
    .sort();

  if (files.length === 0) {
    logger.warn({ videoAbsPath }, "Keyframe extraction produced no frames");
  }

  return {
    frameUrls: files.map((f) => `/uploads/${f}`),
    frameAbsPaths: files.map((f) => path.join(UPLOAD_DIR, f)),
  };
}
