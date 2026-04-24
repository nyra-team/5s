import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import sharp from "sharp";
import {
  __test__,
  compressForVLM,
  extractKeyframes,
  pickUniqueByHash,
  resolveCandidateCap,
} from "../keyframes.js";

const { computeDHash, hammingDistance } = __test__;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-test-"));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeGradient(name: string, opts: { tint?: [number, number, number] } = {}) {
  const tint = opts.tint ?? [0, 0, 0];
  // 256x256 horizontal gradient — encodes a clear left-to-right direction
  // so the dHash we get is non-trivial and stable.
  const w = 256;
  const h = 256;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      buf[idx] = Math.min(255, x + tint[0]);
      buf[idx + 1] = Math.min(255, x + tint[1]);
      buf[idx + 2] = Math.min(255, x + tint[2]);
    }
  }
  const out = path.join(tmpDir, name);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(out);
  return out;
}

async function makeInverseGradient(name: string) {
  // Same dimensions but reversed brightness direction → very different dHash.
  const w = 256;
  const h = 256;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const v = 255 - x;
      buf[idx] = v;
      buf[idx + 1] = v;
      buf[idx + 2] = v;
    }
  }
  const out = path.join(tmpDir, name);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(out);
  return out;
}

describe("resolveCandidateCap", () => {
  const ORIGINAL_ENV = process.env.KEYFRAMES_MAX_CANDIDATES;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.KEYFRAMES_MAX_CANDIDATES;
    else process.env.KEYFRAMES_MAX_CANDIDATES = ORIGINAL_ENV;
  });

  it("defaults to maxFrames * 3 when neither option nor env var is set", () => {
    delete process.env.KEYFRAMES_MAX_CANDIDATES;
    expect(resolveCandidateCap(6)).toBe(18);
    expect(resolveCandidateCap(4)).toBe(12);
  });

  it("honors the env var when no explicit option is given", () => {
    process.env.KEYFRAMES_MAX_CANDIDATES = "10";
    expect(resolveCandidateCap(6)).toBe(10);
  });

  it("explicit option overrides the env var", () => {
    process.env.KEYFRAMES_MAX_CANDIDATES = "10";
    expect(resolveCandidateCap(6, 25)).toBe(25);
  });

  it("never returns less than maxFrames so dedup can still produce a full result", () => {
    delete process.env.KEYFRAMES_MAX_CANDIDATES;
    // Caller asked for fewer candidates than output frames — bump up to maxFrames.
    expect(resolveCandidateCap(6, 2)).toBe(6);
  });

  it("ignores garbage env values and falls back to the derived default", () => {
    process.env.KEYFRAMES_MAX_CANDIDATES = "not-a-number";
    expect(resolveCandidateCap(6)).toBe(18);
    process.env.KEYFRAMES_MAX_CANDIDATES = "0";
    expect(resolveCandidateCap(6)).toBe(18);
    process.env.KEYFRAMES_MAX_CANDIDATES = "-5";
    expect(resolveCandidateCap(6)).toBe(18);
  });

  it("floors fractional values", () => {
    delete process.env.KEYFRAMES_MAX_CANDIDATES;
    expect(resolveCandidateCap(6, 12.7)).toBe(12);
  });
});

describe("pickUniqueByHash", () => {
  // Build an 8-byte buffer where every byte is `b`. Two such buffers with
  // different `b` values differ in every comparable bit slot — well above the
  // dedup hammingThreshold of 5 — so distinct values are reliably "unique".
  const h = (b: number) => Buffer.from([b, b, b, b, b, b, b, b]);

  it("keeps every frame when nothing is a near-duplicate", () => {
    const frames = [
      { name: "a.jpg", hash: h(0x00) },
      { name: "b.jpg", hash: h(0xff) },
      { name: "c.jpg", hash: h(0x0f) },
    ];
    const r = pickUniqueByHash(frames, 5, 6);
    expect(r.kept.map((k) => k.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(r.droppedDuplicate).toBe(0);
    expect(r.droppedOverCap).toBe(0);
  });

  it("counts duplicates dropped by the dedup pass separately from over-cap drops", () => {
    // a, a-dup, b, b-dup, c, d, e — with maxKeep=3 only a, b, c get kept.
    // a-dup and b-dup are dropped as duplicates; d and e are dropped as over-cap.
    const frames = [
      { name: "a.jpg", hash: h(0x00) },
      { name: "a-dup.jpg", hash: h(0x00) }, // identical → dup
      { name: "b.jpg", hash: h(0xff) },
      { name: "b-dup.jpg", hash: h(0xff) }, // identical → dup
      { name: "c.jpg", hash: h(0x0f) },
      { name: "d.jpg", hash: h(0xf0) }, // unique but cap is full
      { name: "e.jpg", hash: h(0x33) }, // unique but cap is full
    ];
    const r = pickUniqueByHash(frames, 5, 3);
    expect(r.kept.map((k) => k.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(r.droppedDuplicate).toBe(2);
    expect(r.droppedOverCap).toBe(2);
  });

  it("treats empty hash buffers as unhashable and keeps them defensively", () => {
    // First frame has a valid hash; the second's hash failed (empty buffer)
    // and must still be kept rather than silently dropped as evidence.
    const frames = [
      { name: "a.jpg", hash: h(0x00) },
      { name: "broken.jpg", hash: Buffer.alloc(0) },
      { name: "a-dup.jpg", hash: h(0x00) }, // identical to a → dup
    ];
    const r = pickUniqueByHash(frames, 5, 6);
    expect(r.kept.map((k) => k.name)).toEqual(["a.jpg", "broken.jpg"]);
    expect(r.droppedDuplicate).toBe(1);
    expect(r.droppedOverCap).toBe(0);
  });

  it("respects maxKeep=0 by dropping every candidate as over-cap", () => {
    const frames = [
      { name: "a.jpg", hash: h(0x00) },
      { name: "b.jpg", hash: h(0xff) },
    ];
    const r = pickUniqueByHash(frames, 5, 0);
    expect(r.kept).toEqual([]);
    expect(r.droppedDuplicate).toBe(0);
    expect(r.droppedOverCap).toBe(2);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical buffers", () => {
    expect(hammingDistance(Buffer.from([0xff, 0x00]), Buffer.from([0xff, 0x00]))).toBe(0);
  });
  it("counts differing bits", () => {
    expect(hammingDistance(Buffer.from([0xff]), Buffer.from([0xf0]))).toBe(4);
    expect(hammingDistance(Buffer.from([0x00]), Buffer.from([0xff]))).toBe(8);
  });
});

describe("computeDHash", () => {
  it("returns 8 bytes (64-bit hash)", async () => {
    const a = await makeGradient("a.jpg");
    const h = await computeDHash(a);
    expect(h).toBeInstanceOf(Buffer);
    expect(h.length).toBe(8);
  });

  it("treats near-identical images as duplicates (low Hamming distance)", async () => {
    const a = await makeGradient("dup-a.jpg");
    // A faintly tinted version of the same gradient — visually identical
    // brightness ramp, just biased a few channels. Should hash near-zero
    // distance.
    const b = await makeGradient("dup-b.jpg", { tint: [2, 2, 2] });
    const distance = hammingDistance(await computeDHash(a), await computeDHash(b));
    expect(distance).toBeLessThanOrEqual(5);
  });

  it("treats visually distinct images as different (high Hamming distance)", async () => {
    const a = await makeGradient("unique-a.jpg");
    const b = await makeInverseGradient("unique-b.jpg");
    const distance = hammingDistance(await computeDHash(a), await computeDHash(b));
    // Reversed brightness gradient flips every comparison bit → max distance.
    expect(distance).toBeGreaterThan(20);
  });
});

describe("compressForVLM", () => {
  it("downscales JPEG images larger than 1024x1024 and recompresses in place", async () => {
    // Build a 2000x1500 JPEG fixture so we can prove (a) it gets downscaled,
    // (b) its on-disk byte size shrinks, and (c) the output is still a valid
    // JPEG that sharp can re-read.
    const big = path.join(tmpDir, "big.jpg");
    const w = 2000;
    const h = 1500;
    const buf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = (i / 3) % 255;
      buf[i + 1] = ((i / 3) * 2) % 255;
      buf[i + 2] = ((i / 3) * 3) % 255;
    }
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 100 })
      .toFile(big);

    const beforeSize = fs.statSync(big).size;
    const out = await compressForVLM(big);
    const afterSize = fs.statSync(big).size;
    const meta = await sharp(big).metadata();

    expect(out).toBe(big);
    expect(meta.format).toBe("jpeg");
    expect(meta.width!).toBeLessThanOrEqual(1024);
    expect(meta.height!).toBeLessThanOrEqual(1024);
    expect(afterSize).toBeLessThan(beforeSize);
  });

  it("does not enlarge images smaller than the cap", async () => {
    const small = path.join(tmpDir, "small.jpg");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 100, b: 200 } },
    })
      .jpeg({ quality: 90 })
      .toFile(small);
    await compressForVLM(small);
    const meta = await sharp(small).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it("writes the compressed JPEG to a derivative path when one is given, leaving the original untouched", async () => {
    // PNG input simulates the real risk: an upload whose extension does not
    // match JPEG bytes. compressForVLM must never overwrite the original or
    // the served URL would deliver JPEG bytes under a `.png` MIME.
    const png = path.join(tmpDir, "original.png");
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .png()
      .toFile(png);

    const originalBytes = fs.readFileSync(png);
    const originalSize = originalBytes.length;
    const derivative = png + ".vlm.jpg";

    const out = await compressForVLM(png, derivative);
    expect(out).toBe(derivative);

    // Original is untouched (byte-identical).
    expect(fs.readFileSync(png).equals(originalBytes)).toBe(true);
    expect(fs.statSync(png).size).toBe(originalSize);
    expect((await sharp(png).metadata()).format).toBe("png");

    // Derivative is a valid downscaled JPEG.
    const dMeta = await sharp(derivative).metadata();
    expect(dMeta.format).toBe("jpeg");
    expect(dMeta.width!).toBeLessThanOrEqual(1024);
    expect(dMeta.height!).toBeLessThanOrEqual(1024);
  });
});

describe("extractKeyframes ffmpeg timeout", () => {
  const ORIGINAL_BIN = process.env.FFMPEG_BIN;
  const ORIGINAL_TIMEOUT = process.env.FFMPEG_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL_BIN === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = ORIGINAL_BIN;
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.FFMPEG_TIMEOUT_MS;
    else process.env.FFMPEG_TIMEOUT_MS = ORIGINAL_TIMEOUT;
  });

  it("kills a hanging ffmpeg and returns the empty-result path within the timeout budget", async () => {
    // A real malformed video would just stall ffmpeg's demuxer; we get the
    // same observable behavior — a child process that never exits — by
    // pointing the helper at a node script that hangs forever. This avoids
    // depending on a real ffmpeg build (or a fragile broken-video fixture)
    // while still exercising the timeout/SIGKILL path end-to-end.
    const fakeBin = path.join(tmpDir, "fake-ffmpeg.mjs");
    fs.writeFileSync(
      fakeBin,
      "#!/usr/bin/env node\n// Ignore all args; never exit so the wall-clock timeout has to fire.\nsetInterval(() => {}, 60_000);\n",
    );
    fs.chmodSync(fakeBin, 0o755);

    process.env.FFMPEG_BIN = fakeBin;
    // All three ffmpeg passes (scene + fallback + last-ditch) each get this
    // budget, so total wall time is ~3x. Keep small enough to stay well
    // under the suite timeout but large enough to dwarf process-spawn
    // jitter.
    process.env.FFMPEG_TIMEOUT_MS = "300";

    const start = Date.now();
    const result = await extractKeyframes("/tmp/does-not-matter.mp4", { maxFrames: 3 });
    const elapsed = Date.now() - start;

    // All ffmpeg passes should have timed out and the function should have
    // fallen through to the documented empty-result path — no throw, no
    // forever-hang waiting on the child.
    expect(result.frameUrls).toEqual([]);
    expect(result.frameAbsPaths).toEqual([]);
    // Generous upper bound: 3 timeouts (~900ms) + spawn/teardown overhead.
    // If the SIGKILL path regresses, this would balloon to the full suite
    // timeout instead.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("sweeps any partial JPEGs ffmpeg flushed before the SIGKILL fired", async () => {
    // Reproduces the failure mode the code review flagged: a real ffmpeg
    // (or a malformed input) sometimes flushes one or more partial frames
    // to disk before the wall-clock timeout fires and we kill it. Without
    // the cleanup pass in runFfmpeg those partials would accumulate in
    // uploads/ across a string of failures and never be reaped. Here a
    // fake binary writes two real JPEGs that match the per-call prefix
    // pattern then hangs, simulating exactly that race.
    const uploadsDir = path.resolve(process.cwd(), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Capture the existing uploads/ contents so the assertion can ignore
    // anything that was already in there (other tests, dev artifacts).
    const before = new Set(fs.readdirSync(uploadsDir));

    const fakeBin = path.join(tmpDir, "fake-ffmpeg-partial.mjs");
    // The fake binary is invoked with the standard runFfmpeg arg list; the
    // last arg is the output pattern (e.g. .../<id>_s_%03d.jpg). We
    // substitute the %03d placeholder for "001" / "002", write two real
    // JPEG bytes (sharp doesn't have to decode them — the cleanup pass
    // matches by filename), then hang so the timeout has to SIGKILL us.
    fs.writeFileSync(
      fakeBin,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const pattern = process.argv[process.argv.length - 1];",
        "const minimalJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);",
        "fs.writeFileSync(pattern.replace('%03d', '001'), minimalJpeg);",
        "fs.writeFileSync(pattern.replace('%03d', '002'), minimalJpeg);",
        "setInterval(() => {}, 60_000);",
      ].join("\n"),
    );
    fs.chmodSync(fakeBin, 0o755);

    process.env.FFMPEG_BIN = fakeBin;
    process.env.FFMPEG_TIMEOUT_MS = "200";

    const result = await extractKeyframes("/tmp/whatever.mp4", { maxFrames: 3 });

    // Function returned cleanly (empty result); now verify that none of
    // the partial JPEGs the fake binary wrote survived the cleanup. Match
    // by the .jpg suffix to ignore any non-frame upload artifacts.
    const after = fs.readdirSync(uploadsDir);
    const newJpegs = after.filter(
      (f) => !before.has(f) && f.endsWith(".jpg"),
    );
    expect(result.frameAbsPaths).toEqual([]);
    expect(newJpegs).toEqual([]);
  });
});
