// Normalized shape every source adapter produces. One record = one planned
// procurement (from Treasury's published forecast) or one predicted upcoming
// procurement (from an expiring federal contract).

export type OppSource = "treasury-forecast" | "acquisition-gateway" | "dhs-apfs" | "usaspending-predict";

export type OppType =
  | "New"
  | "Recompete"
  | "Micropurchase"
  | "SAT"
  | "Above250k"
  | "Predicted";

export type FitTag = "direct-fit" | "adjacent" | "other";

// Where the opportunity sits relative to the two streams after cross-referencing.
export type CrossRefStatus =
  | "confirmed" // in the published forecast AND backed by an expiring contract
  | "predicted-not-forecasted" // expiring contract with no matching forecast entry (earliest signal)
  | "forecast-only"; // published forecast entry, no matching expiring contract found

export interface Opportunity {
  source: OppSource;
  id: string; // source-native id
  fingerprint: string; // stable hash for dedup
  title: string;
  description?: string;

  agency: string; // "Treasury"
  bureau?: string;

  oppType: OppType;
  naics?: string; // e.g. "541512"
  naicsDesc?: string;
  psc?: string; // e.g. "DA01"
  pscDesc?: string;

  estValue?: string; // bucket text (forecast) or formatted dollars (predictor)
  setAside?: string; // e.g. "SB", "None"
  placeState?: string;
  awardQuarter?: string; // "FY 2025 Q2" — expected award timing
  solicitationDate?: string; // expected solicitation date (Gateway forecasts)
  popStart?: string; // ISO date
  popEnd?: string; // ISO date — the key predictor signal
  incumbent?: string;

  bureauPoc?: string; // named point of contact (useful for later outreach)
  programOfficePoc?: string;
  contractVehicle?: string;

  active?: boolean;
  phase?: string; // acquisition phase, e.g. "Early Market Research", "Canceled"

  url: string; // link back to the source

  // Filled in by the pipeline:
  fitTag: FitTag;
  matchedTerms: string[];
  crossRef?: CrossRefStatus;

  // Filled in by the scorer (core/score.ts): a 0-100 priority score plus the
  // short human-readable reasons behind it, so the digest can rank and explain.
  score?: number;
  scoreReasons?: string[];

  // Filled in by the optional LLM pass (core/llmScore.ts) for shortlisted items
  // only. Absent when the pass is disabled, skipped, or failed — everything
  // downstream must fall back to the deterministic `score`.
  llmScore?: number; // 0-100 judged fit against config/profile.md
  llmRationale?: string; // one line on why it does or does not fit
  llmAction?: string; // concrete suggested next step

  // Field watched for change-detection between runs (value bucket by default).
  watchedValue?: string;
}

// A change detected on an already-seen opportunity between runs.
export interface OppChange {
  opp: Opportunity;
  changes: Array<{ field: string; from: string; to: string }>;
}
