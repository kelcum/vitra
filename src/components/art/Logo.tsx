import { motion } from "motion/react";

export function Logo({ size = 22, reveal = false }: { size?: number; reveal?: boolean }) {
  const faces = [
    { d: "M50 8 L88 30 L50 52 L12 30 Z", fill: "url(#lg-top)", delay: 0.05 },
    { d: "M12 30 L50 52 L50 94 L12 72 Z", fill: "url(#lg-left)", delay: 0.18 },
    { d: "M88 30 L50 52 L50 94 L88 72 Z", fill: "url(#lg-right)", delay: 0.3 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden style={{ flex: "none", overflow: "visible" }}>
      <defs>
        <linearGradient id="lg-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e4f7ff" />
          <stop offset="1" stopColor="#86ceff" />
        </linearGradient>
        <linearGradient id="lg-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a96ff" />
          <stop offset="1" stopColor="#3d44d6" />
        </linearGradient>
        <linearGradient id="lg-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9a7dff" />
          <stop offset="1" stopColor="#4d30c8" />
        </linearGradient>
      </defs>
      {faces.map((f, i) =>
        reveal ? (
          <motion.path
            key={i}
            d={f.d}
            fill={f.fill}
            initial={{ opacity: 0, y: i === 0 ? -14 : 10, scale: 0.9 }}
            animate={{ opacity: 0.95, y: 0, scale: 1 }}
            transition={{ delay: f.delay, type: "spring", stiffness: 180, damping: 18 }}
            style={{ transformOrigin: "50px 52px" }}
          />
        ) : (
          <path key={i} d={f.d} fill={f.fill} opacity={0.95} />
        ),
      )}
      {reveal ? (
        <motion.path
          d="M12 30 L50 52 L88 30 M50 52 L50 94"
          fill="none"
          stroke="#fff"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeOpacity={0.7}
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      ) : (
        <path d="M12 30 L50 52 L88 30 M50 52 L50 94" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinejoin="round" strokeOpacity={0.7} />
      )}
    </svg>
  );
}
