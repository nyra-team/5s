import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { MaskedImage, type IssueRegion } from "@/components/masked-image";

/**
 * A single frame to show in the lightbox. `regions` are passed straight to
 * MaskedImage, which filters them by `frameIndex` — so callers can hand over
 * the whole submission's regions and let each frame light up only its own.
 */
export type LightboxFrame = {
  src: string;
  alt?: string;
  regions?: IssueRegion[];
  frameIndex: number;
};

type OpenLightbox = (frames: LightboxFrame[], startIndex?: number) => void;

const LightboxContext = createContext<OpenLightbox>(() => {});

/**
 * Tap-to-enlarge for keyframe thumbnails. Any descendant can call
 * `useLightbox()` to open a full-screen viewer for a set of frames, each
 * rendered through MaskedImage so the red issue overlays line up exactly as
 * they do on the cards. Arrow keys / on-screen chevrons page between frames;
 * Esc, the close button, or a backdrop tap dismiss it.
 *
 * Mounted once near the app root so thumbnails buried inside dialogs and
 * deeply-nested rows don't have to prop-drill an open handler.
 */
export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [frames, setFrames] = useState<LightboxFrame[] | null>(null);
  const [index, setIndex] = useState(0);

  const open = useCallback<OpenLightbox>((next, startIndex = 0) => {
    if (!next || next.length === 0) return;
    setFrames(next);
    setIndex(Math.max(0, Math.min(startIndex, next.length - 1)));
  }, []);

  const close = useCallback(() => setFrames(null), []);

  return (
    <LightboxContext.Provider value={open}>
      {children}
      <FrameLightbox
        frames={frames}
        index={index}
        onIndexChange={setIndex}
        onClose={close}
      />
    </LightboxContext.Provider>
  );
}

export function useLightbox(): OpenLightbox {
  return useContext(LightboxContext);
}

function FrameLightbox({
  frames,
  index,
  onIndexChange,
  onClose,
}: {
  frames: LightboxFrame[] | null;
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const isOpen = !!frames && frames.length > 0;
  const count = frames?.length ?? 0;
  const indexRef = useRef(index);
  indexRef.current = index;

  // Keyboard: Esc closes, arrows page. Capture phase + stopPropagation so an
  // Esc while the lightbox sits on top of a Radix dialog dismisses only the
  // lightbox, not the dialog underneath it.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" && count > 1) {
        onIndexChange((indexRef.current + 1) % count);
      } else if (e.key === "ArrowLeft" && count > 1) {
        onIndexChange((indexRef.current - 1 + count) % count);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, count, onClose, onIndexChange]);

  // Lock body scroll while the overlay is up.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  if (typeof document === "undefined") return null;

  const frame = frames?.[index];
  const go = (delta: number) => onIndexChange((index + delta + count) % count);

  return createPortal(
    <AnimatePresence>
      {isOpen && frame && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={frame.alt ?? `Frame ${frame.frameIndex + 1}`}
          data-testid="frame-lightbox"
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-2.5 rounded-full text-white/80 hover:text-white bg-white/10 hover:bg-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Close"
            data-testid="frame-lightbox-close"
          >
            <X className="w-5 h-5" />
          </button>

          {count > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
                className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 p-2.5 rounded-full text-white/80 hover:text-white bg-white/10 hover:bg-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Previous frame"
                data-testid="frame-lightbox-prev"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
                className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 p-2.5 rounded-full text-white/80 hover:text-white bg-white/10 hover:bg-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Next frame"
                data-testid="frame-lightbox-next"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            </>
          )}

          {/* Stop propagation so taps on the image itself don't dismiss. */}
          <div
            className="flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <MaskedImage
              key={frame.src}
              src={frame.src}
              alt={frame.alt ?? `Frame ${frame.frameIndex + 1}`}
              regions={frame.regions}
              frameIndex={frame.frameIndex}
              className="inline-block max-w-[92vw] max-h-[82vh] rounded-lg shadow-2xl"
              imgClassName="max-w-[92vw] max-h-[82vh] w-auto h-auto object-contain"
            />
            <div className="text-white/80 text-[13px] font-medium tabular-nums">
              Frame {frame.frameIndex + 1}
              {count > 1 && <span className="text-white/50"> · {index + 1} of {count}</span>}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
