import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import sharp from "sharp";
import { __test__, compressForVLM } from "../keyframes.js";

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
