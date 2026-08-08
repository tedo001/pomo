import { useEffect, useState } from "react";

/**
 * Re-render clock. The interval decides only how often the countdown *repaints*; the
 * value shown is always computed from `Date.now()`, so a throttled or skipped tick
 * costs a frame of smoothness, never a second of tracked time.
 */
export function useNow(intervalMs = 250, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    // A tab restored from the background may have missed every tick; repaint at once
    // rather than showing a stale countdown until the next interval fires.
    const onVisible = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, active]);

  return now;
}
