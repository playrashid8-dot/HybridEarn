"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Smooth count-up for numeric dashboard values (UI only).
 * @param {number} target
 * @param {number} duration
 */
export function useAnimatedNumber(target, duration = 1000) {
  const [display, setDisplay] = useState(() => Number(target) || 0);
  const fromRef = useRef(0);

  useEffect(() => {
    const end = Number(target) || 0;
    const from = fromRef.current;
    const startTime = performance.now();
    let frame = 0;

    const tick = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - (1 - t) ** 3;
      const next = from + (end - from) * eased;
      setDisplay(next);
      if (t < 1) frame = requestAnimationFrame(tick);
      else fromRef.current = end;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return display;
}
