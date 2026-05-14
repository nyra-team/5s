import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type IssueRegion = {
  frameIndex: number;
  box: [number, number, number, number]; // x, y, w, h — normalized 0..1, top-left origin
};

/**
 * Pull the `region` field off each issue in `aiIssuesJson`. The OpenAPI type
 * doesn't include the field yet (it's stored transparently in the JSONB
 * blob), so we read it via an `any` cast and validate at the boundary.
 */
export function extractRegions(aiIssuesJson: unknown): IssueRegion[] {
  if (!Array.isArray(aiIssuesJson)) return [];
  const out: IssueRegion[] = [];
  for (const issue of aiIssuesJson) {
    const r = (issue as any)?.region;
    if (!r) continue;
    const fi = Number(r.frameIndex);
    const box = r.box;
    if (!Number.isFinite(fi) || !Array.isArray(box) || box.length !== 4) continue;
    const nums = box.map((v: unknown) => Number(v));
    if (!nums.every((n) => Number.isFinite(n))) continue;
    out.push({ frameIndex: fi, box: nums as [number, number, number, number] });
  }
  return out;
}

interface MaskedImageProps {
  src: string;
  alt?: string;
  regions?: IssueRegion[];
  /** Overlay only regions whose frameIndex matches. Default 0. */
  frameIndex?: number;
  /** Wrapper classes — caller controls outer sizing. */
  className?: string;
  /** Override the inner <img> classes (default `object-contain`). */
  imgClassName?: string;
}

/**
 * Renders an image with semi-transparent red rectangles overlaid on each
 * region. Boxes are given in normalized image coordinates (0..1) and laid
 * out against the actual rendered image rect inside the wrapper, so they
 * stay aligned even when `object-contain` letterboxes the image inside a
 * fixed-aspect container. Re-measures on resize.
 */
export function MaskedImage({
  src,
  alt,
  regions = [],
  frameIndex = 0,
  className,
  imgClassName,
}: MaskedImageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const measure = () => {
    const img = imgRef.current;
    const wrap = wrapperRef.current;
    if (!img || !wrap || !img.complete || img.naturalWidth === 0) return;
    const wRect = wrap.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    setRect({
      left: iRect.left - wRect.left,
      top: iRect.top - wRect.top,
      width: iRect.width,
      height: iRect.height,
    });
  };

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined" || !wrapperRef.current) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, [src]);

  const visible = regions.filter((r) => r.frameIndex === frameIndex);

  return (
    <div ref={wrapperRef} className={cn("relative overflow-hidden", className)}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={measure}
        className={cn("w-full h-full object-contain", imgClassName)}
      />
      {rect &&
        visible.map((r, i) => {
          const [x, y, w, h] = r.box;
          return (
            <div
              key={i}
              className="absolute pointer-events-none bg-red-500/30 ring-1 ring-red-500/70 rounded-sm"
              style={{
                left: rect.left + x * rect.width,
                top: rect.top + y * rect.height,
                width: w * rect.width,
                height: h * rect.height,
              }}
            />
          );
        })}
    </div>
  );
}
