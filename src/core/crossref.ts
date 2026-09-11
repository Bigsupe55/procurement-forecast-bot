// Joins the two streams. A predicted opportunity (expiring contract) that also
// appears in the published forecast is "confirmed"; one that does NOT is
// "predicted, not yet forecasted" — the earliest signal, and the most valuable.
// Published forecast entries with a matching expiring contract are also flagged
// confirmed (extra confidence + an incumbent to displace).

import type { Opportunity } from "./types.js";

const MATCH_THRESHOLD = 0.34; // Jaccard on description tokens

export function crossReference(
  forecast: Opportunity[],
  predicted: Opportunity[]
): { forecast: Opportunity[]; predicted: Opportunity[] } {
  const forecastByNaics = new Map<string, Opportunity[]>();
  for (const f of forecast) {
    if (!f.naics) continue;
    const arr = forecastByNaics.get(f.naics) ?? [];
    arr.push(f);
    forecastByNaics.set(f.naics, arr);
  }

  const confirmedForecastIds = new Set<string>();
  const outPredicted = predicted.map((p) => {
    const candidates = p.naics ? forecastByNaics.get(p.naics) ?? [] : [];
    let best: { f: Opportunity; score: number } | null = null;
    for (const f of candidates) {
      const score = tokenOverlap(text(p), text(f));
      if (!best || score > best.score) best = { f, score };
    }
    if (best && best.score >= MATCH_THRESHOLD) {
      confirmedForecastIds.add(best.f.id);
      return { ...p, crossRef: "confirmed" as const };
    }
    return { ...p, crossRef: "predicted-not-forecasted" as const };
  });

  const outForecast = forecast.map((f) => ({
    ...f,
    crossRef: confirmedForecastIds.has(f.id) ? ("confirmed" as const) : ("forecast-only" as const),
  }));

  return { forecast: outForecast, predicted: outPredicted };
}

function text(o: Opportunity): string {
  return `${o.title} ${o.description ?? ""}`;
}

function tokenOverlap(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}
