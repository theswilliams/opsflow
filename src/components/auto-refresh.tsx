"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * While a workflow is still being processed in the background, re-fetch the page every few seconds —
 * for at most `maxMinutes`, so a stuck workflow cannot keep a forgotten tab polling forever (the server-side
 * sweeper still recovers it; reloading the page resumes checking).
 */
export function AutoRefresh({ everyMs = 3000, active = true, maxMinutes = 5 }: { everyMs?: number; active?: boolean; maxMinutes?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > maxMinutes * 60_000) clearInterval(t);
      else router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, active, maxMinutes]);
  return null;
}
