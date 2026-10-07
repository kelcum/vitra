import { useEffect, useRef } from "react";

/**
 * Draws a player's face (base + hat layer) from a skin texture, pixel-perfect.
 * Without a skin it shows a neutral placeholder head.
 */
export function PlayerHead({ src, size = 28, radius = 7 }: { src?: string | null; size?: number; radius?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 8, 8);
    if (!src) {
      ctx.fillStyle = "#5b6478";
      ctx.fillRect(0, 0, 8, 8);
      ctx.fillStyle = "#3e4556";
      ctx.fillRect(0, 0, 8, 2);
      ctx.fillStyle = "#e8ecf5";
      ctx.fillRect(1, 4, 2, 1);
      ctx.fillRect(5, 4, 2, 1);
      return;
    }
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, 8, 8);
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
    };
    img.src = src;
  }, [src]);

  return (
    <canvas
      ref={ref}
      width={8}
      height={8}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        imageRendering: "pixelated",
        flex: "none",
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.12), 0 2px 6px rgb(0 0 0 / 0.3)",
      }}
    />
  );
}

/** Flat front view of a full skin (head, body, arms, legs) for thumbnails. */
export function SkinFront({ src, slim, height = 96 }: { src: string; slim?: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.imageSmoothingEnabled = false;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, 16, 32);
      const legacy = img.height === 32;
      const arm = slim ? 3 : 4;
      const d = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
        if (flip) {
          ctx.save();
          ctx.translate(dx + w, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
          ctx.restore();
        } else ctx.drawImage(img, sx, sy, w, h, dx, dy, w, h);
      };
      // Base layer
      d(8, 8, 8, 8, 4, 0); // head
      d(20, 20, 8, 12, 4, 8); // body
      d(44, 20, arm, 12, 4 - arm, 8); // right arm (viewer's left)
      if (legacy) d(44, 20, arm, 12, 12, 8, true);
      else d(36, 52, arm, 12, 12, 8); // left arm
      d(4, 20, 4, 12, 4, 20); // right leg
      if (legacy) d(4, 20, 4, 12, 8, 20, true);
      else d(20, 52, 4, 12, 8, 20); // left leg
      // Overlay layer
      d(40, 8, 8, 8, 4, 0);
      if (!legacy) {
        d(20, 36, 8, 12, 4, 8);
        d(44, 36, arm, 12, 4 - arm, 8);
        d(52, 52, arm, 12, 12, 8);
        d(4, 36, 4, 12, 4, 20);
        d(4, 52, 4, 12, 8, 20);
      }
    };
    img.src = src;
  }, [src, slim]);
  return (
    <canvas
      ref={ref}
      width={16}
      height={32}
      style={{ height, width: height / 2, imageRendering: "pixelated", filter: "drop-shadow(0 6px 10px rgb(0 0 0 / 0.35))" }}
    />
  );
}
