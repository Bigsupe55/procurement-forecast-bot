// Renders the alert email (plain text + HTML) from the run's new and changed
// opportunities, ranked by the deterministic priority score (core/score.ts).
//
// The email leads with the few items worth acting on this week and collapses the
// long tail, so a large "relevant" set stays scannable:
//   1. PRIORITIES   — new items at/above the score threshold, full detail, ranked
//   2. ALSO NEW     — remaining new items, one compact line each
//   3. CHANGED      — already-seen items whose value / timing / type shifted
//
// Scores come pre-attached by the pipeline; we sort defensively here anyway.

import type { Opportunity, OppChange } from "./types.js";
import { config } from "../config.js";
import { WORTH_ACTING_ON } from "./score.js";
import { effectiveScore } from "./llmScore.js";
import type { PursuitState } from "./pursuit.js";

/** An opportunity you have actively marked in the dashboard, with its decision. */
export interface PursuitItem {
  opp: Opportunity;
  state: PursuitState;
  note?: string;
}

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

export interface DigestInput {
  newOpps: Opportunity[];
  changedOpps: OppChange[];
  isBaseline: boolean;
  totalTracked: number;
  streamBNote?: string; // set when a best-effort stream was skipped/failed
  // Items marked pursue/watch in the local dashboard. Rendered first, as a
  // standing worklist, so the email opens with what you already committed to
  // rather than with whatever happened to be new this week. Skipped items are
  // filtered out upstream in run.ts and never reach here.
  pursuits?: PursuitItem[];
}

const SITE = "https://osdbu.forecast.treasury.gov/";
const GOLD = "#e9d3ab";
const INK = "#1c2f74";

// Even when many items legitimately clear the priority bar (the federal IT
// forecast is dense with strong fits), a human can only act on so many. Render
// the top slice in full and fold the rest into the compact list below.
const MAX_PRIORITIES_SHOWN = 20;

// Rank on the LLM's judgment where it exists, the deterministic score otherwise.
// Note this mixes two scales: items the LLM never saw (below the shortlist cap) keep
// their provisional deterministic rank, so a high-scoring unjudged item can outrank
// one the LLM actively judged a poor fit. That is intended — a real assessment should
// be able to demote something the rules over-rated.
const byScore = (a: Opportunity, b: Opportunity) => effectiveScore(b) - effectiveScore(a);

export function buildDigest(input: DigestInput): Mail {
  if (input.isBaseline) return buildBaseline(input);

  const ranked = [...input.newOpps].sort(byScore);
  const clearing = ranked.filter((o) => effectiveScore(o) >= WORTH_ACTING_ON);
  const priorities = clearing.slice(0, MAX_PRIORITIES_SHOWN);
  // Anything that didn't make the priority cut — below threshold, or above it but
  // past the render cap — is collapsed into the compact "also new" list.
  const shownIds = new Set(priorities.map((o) => o.id));
  const alsoNew = ranked.filter((o) => !shownIds.has(o.id));
  const overflow = clearing.length - priorities.length; // priorities beyond the cap
  const changed = [...input.changedOpps].sort((a, b) => effectiveScore(b.opp) - effectiveScore(a.opp));

  const subject = `${config.orgName} forecast: ${priorities.length} priority of ${input.newOpps.length} new, ${input.changedOpps.length} changed (federal)`;

  const alsoTitle =
    overflow > 0 ? `ALSO NEW — ${overflow} more above threshold + lower priority` : "ALSO NEW — lower priority";

  // ---- plain text ----
  const t: string[] = [];
  t.push(subject, "=".repeat(Math.min(subject.length, 72)), "");
  pursuitSection(t, input.pursuits ?? []);
  fullSection(t, `PRIORITIES — worth acting on (score ≥ ${WORTH_ACTING_ON})`, priorities);
  compactSection(t, alsoTitle, alsoNew);
  if (changed.length) {
    t.push("", `CHANGED (${changed.length})`, "-".repeat(24));
    for (const c of changed) {
      t.push(`• ${scoreTag(c.opp)} ${c.opp.title} (${c.opp.bureau ?? c.opp.agency})`);
      for (const ch of c.changes) t.push(`    ${ch.field}: "${ch.from}" -> "${ch.to}"`);
    }
  }
  if (input.streamBNote) t.push("", `Note: ${input.streamBNote}`);
  t.push("", `Source: ${SITE}`, `Tracking ${input.totalTracked} relevant opportunities across federal agencies.`);

  // ---- html ----
  const h: string[] = [];
  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:${INK};max-width:680px">`);
  h.push(`<h2 style="margin:0 0 4px">${config.orgName} procurement forecast</h2>`);
  h.push(
    `<p style="margin:0 0 16px;color:#555"><strong>${priorities.length}</strong> priority of ${input.newOpps.length} new &middot; ${input.changedOpps.length} changed &middot; federal (all agencies)</p>`
  );
  htmlPursuitSection(h, input.pursuits ?? []);
  htmlFullSection(h, `Priorities — worth acting on (score ≥ ${WORTH_ACTING_ON})`, priorities, "#8a1c1c");
  htmlCompactSection(h, overflow > 0 ? `Also new — ${overflow} more above threshold + lower priority` : "Also new — lower priority", alsoNew);
  if (changed.length) {
    h.push(`<h3 style="border-bottom:2px solid ${GOLD};padding-bottom:4px">Changed (${changed.length})</h3>`);
    for (const c of changed) {
      h.push(
        `<p style="margin:6px 0">${scoreChip(c.opp)} <strong>${esc(c.opp.title)}</strong> <span style="color:#777">${esc(c.opp.bureau ?? c.opp.agency)}</span><br>`
      );
      h.push(
        c.changes
          .map((ch) => `<span style="color:#555">${esc(ch.field)}: &ldquo;${esc(ch.from)}&rdquo; &rarr; &ldquo;${esc(ch.to)}&rdquo;</span>`)
          .join("<br>")
      );
      h.push(`</p>`);
    }
  }
  if (input.streamBNote) h.push(`<p style="color:#8a1c1c;font-size:12px">Note: ${esc(input.streamBNote)}</p>`);
  h.push(
    `<p style="color:#777;font-size:12px;margin-top:20px">Source: <a href="${SITE}">${SITE}</a> &middot; Tracking ${input.totalTracked} relevant opportunities across federal agencies. Forecast data is for planning only and is not a government commitment.</p>`
  );
  h.push(`</div>`);

  return { subject, text: t.join("\n"), html: h.join("\n") };
}

function buildBaseline(input: DigestInput): Mail {
  const ranked = [...input.newOpps].sort(byScore);
  const direct = input.newOpps.filter((o) => o.fitTag === "direct-fit").length;
  const adjacent = input.newOpps.filter((o) => o.fitTag === "adjacent").length;
  const top = ranked.slice(0, 10);
  const subject = `${config.orgName} forecast baseline: tracking ${input.newOpps.length} federal opportunities`;

  const t: string[] = [];
  t.push(subject, "=".repeat(Math.min(subject.length, 72)), "");
  t.push(`This first run recorded a baseline. Future runs will alert you only on NEW or CHANGED opportunities, led by priority score.`, "");
  t.push(`Direct fit: ${direct}   Adjacent: ${adjacent}`, "");
  fullSection(t, "TOP OPPORTUNITIES BY SCORE (now tracked)", top);
  if (input.streamBNote) t.push("", `Note: ${input.streamBNote}`);
  t.push("", `Source: ${SITE}`);

  const h: string[] = [];
  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:${INK};max-width:680px">`);
  h.push(`<h2 style="margin:0 0 4px">${config.orgName} forecast: baseline established</h2>`);
  h.push(
    `<p style="color:#555">Recorded ${input.newOpps.length} relevant federal opportunities (${direct} direct fit, ${adjacent} adjacent). Future runs alert only on new or changed items, ranked by priority score.</p>`
  );
  htmlFullSection(h, "Top opportunities by score (now tracked)", top, INK);
  if (input.streamBNote) h.push(`<p style="color:#8a1c1c;font-size:12px">Note: ${esc(input.streamBNote)}</p>`);
  h.push(`<p style="color:#777;font-size:12px">Source: <a href="${SITE}">${SITE}</a></p></div>`);

  return { subject, text: t.join("\n"), html: h.join("\n") };
}

// ---- sections ----

function fullSection(lines: string[], title: string, opps: Opportunity[]): void {
  if (opps.length === 0) return;
  const heading = `${title} (${opps.length})`;
  lines.push("", heading, "-".repeat(Math.max(heading.length, 24)));
  for (const o of opps) {
    lines.push(`• ${scoreTag(o)} [${o.oppType}] ${o.title}`);
    lines.push(`    ${meta(o)}`);
    if (o.popEnd) lines.push(`    PoP ends: ${o.popEnd}${o.incumbent ? ` · incumbent: ${o.incumbent}` : ""}`);
    if (o.bureauPoc || o.programOfficePoc)
      lines.push(`    POC: ${[o.bureauPoc, o.programOfficePoc].filter(Boolean).join(" / ")}`);
    if (o.llmRationale) lines.push(`    assessment: ${o.llmRationale}`);
    if (o.llmAction) lines.push(`    next: ${o.llmAction}`);
    if (o.scoreReasons?.length) lines.push(`    signals: ${o.scoreReasons.join(" · ")}`);
  }
}

// Pursue before watch, then by score inside each: what you committed to leads.
const PURSUIT_ORDER: Record<PursuitState, number> = { pursue: 0, watch: 1, skip: 2 };
function byPursuit(a: PursuitItem, b: PursuitItem): number {
  return PURSUIT_ORDER[a.state] - PURSUIT_ORDER[b.state] || effectiveScore(b.opp) - effectiveScore(a.opp);
}

function pursuitSection(lines: string[], items: PursuitItem[]): void {
  if (items.length === 0) return;
  const sorted = [...items].sort(byPursuit);
  const heading = `YOUR PURSUITS (${sorted.length})`;
  lines.push("", heading, "-".repeat(Math.max(heading.length, 24)));
  for (const { opp, state, note } of sorted) {
    const who = opp.bureau && opp.bureau !== opp.agency ? `${opp.agency}/${opp.bureau}` : opp.agency;
    lines.push(`• [${state.toUpperCase()}] ${scoreTag(opp)} ${opp.title} — ${who}`);
    if (note) lines.push(`    note: ${note}`);
  }
}

function htmlPursuitSection(lines: string[], items: PursuitItem[]): void {
  if (items.length === 0) return;
  const sorted = [...items].sort(byPursuit);
  lines.push(
    `<h3 style="color:${INK};border-bottom:2px solid ${GOLD};padding-bottom:4px">Your pursuits (${sorted.length})</h3>`
  );
  for (const { opp, state, note } of sorted) {
    const bg = state === "pursue" ? "#442600" : "#5d574c";
    lines.push(`<div style="margin:0 0 10px">`);
    lines.push(
      `<div><span style="background:${bg};color:#fffbf4;font-size:11px;padding:1px 6px;border-radius:9999px;letter-spacing:.08em">${esc(
        state.toUpperCase()
      )}</span> ${scoreChip(opp)} ${linkTitle(opp)}</div>`
    );
    lines.push(`<div style="color:#555;font-size:13px">${esc(meta(opp))}</div>`);
    if (note) lines.push(`<div style="color:${INK};font-size:13px">note: ${esc(note)}</div>`);
    lines.push(`</div>`);
  }
}

function compactSection(lines: string[], title: string, opps: Opportunity[]): void {
  if (opps.length === 0) return;
  const heading = `${title} (${opps.length})`;
  lines.push("", heading, "-".repeat(Math.max(heading.length, 24)));
  for (const o of opps) {
    const who = o.bureau && o.bureau !== o.agency ? `${o.agency}/${o.bureau}` : o.agency;
    lines.push(`• ${scoreTag(o)} ${o.title} — ${who}${o.naics ? ` (NAICS ${o.naics})` : ""}`);
  }
}

function htmlFullSection(lines: string[], title: string, opps: Opportunity[], color: string): void {
  if (opps.length === 0) return;
  lines.push(`<h3 style="color:${color};border-bottom:2px solid ${GOLD};padding-bottom:4px">${esc(title)} (${opps.length})</h3>`);
  for (const o of opps) {
    lines.push(`<div style="margin:0 0 14px">`);
    lines.push(
      `<div>${scoreChip(o)} <strong>[${esc(o.oppType)}]</strong> ${linkTitle(o)}</div>`
    );
    lines.push(`<div style="color:#555;font-size:13px">${esc(meta(o))}</div>`);
    if (o.popEnd)
      lines.push(`<div style="color:#8a1c1c;font-size:13px">PoP ends ${esc(o.popEnd)}${o.incumbent ? ` &middot; incumbent: ${esc(o.incumbent)}` : ""}</div>`);
    if (o.bureauPoc || o.programOfficePoc)
      lines.push(`<div style="color:#555;font-size:13px">POC: ${esc([o.bureauPoc, o.programOfficePoc].filter(Boolean).join(" / "))}</div>`);
    if (o.llmRationale)
      lines.push(`<div style="color:${INK};font-size:13px;margin-top:2px">${esc(o.llmRationale)}</div>`);
    if (o.llmAction)
      lines.push(`<div style="color:#1c5c2f;font-size:13px"><strong>Next:</strong> ${esc(o.llmAction)}</div>`);
    if (o.scoreReasons?.length)
      lines.push(`<div style="color:#8892b0;font-size:12px">signals: ${esc(o.scoreReasons.join(" · "))}</div>`);
    lines.push(`</div>`);
  }
}

function htmlCompactSection(lines: string[], title: string, opps: Opportunity[]): void {
  if (opps.length === 0) return;
  lines.push(`<h3 style="color:#4a5578;border-bottom:2px solid ${GOLD};padding-bottom:4px">${esc(title)} (${opps.length})</h3>`);
  lines.push(`<ul style="margin:6px 0 16px;padding-left:18px;color:#555;font-size:13px">`);
  for (const o of opps) {
    const who = o.bureau && o.bureau !== o.agency ? `${o.agency}/${o.bureau}` : o.agency;
    lines.push(
      `<li>${scoreChip(o)} ${linkTitle(o)} <span style="color:#888">— ${esc(who)}${o.naics ? ` (NAICS ${esc(o.naics)})` : ""}</span></li>`
    );
  }
  lines.push(`</ul>`);
}

// ---- helpers ----

// A trailing "*" marks a score the LLM judged, distinguishing a real assessment
// from a provisional deterministic one at a glance.
function scoreTag(o: Opportunity): string {
  const mark = o.llmScore !== undefined ? "*" : " ";
  return `[${String(effectiveScore(o)).padStart(2, " ")}${mark}]`;
}

function scoreChip(o: Opportunity): string {
  const s = effectiveScore(o);
  const bg = s >= 80 ? "#8a1c1c" : s >= WORTH_ACTING_ON ? INK : "#8892b0";
  const judged = o.llmScore !== undefined
    ? ` <span style="color:#8892b0;font-size:11px" title="assessed by LLM">&#9679;</span>`
    : "";
  return `<span style="display:inline-block;min-width:22px;text-align:center;background:${bg};color:#fff;border-radius:4px;font-size:12px;font-weight:bold;padding:1px 5px">${s}</span>${judged}`;
}

function linkTitle(o: Opportunity): string {
  const title = esc(o.title);
  return o.url ? `<a href="${esc(o.url)}" style="color:${INK};text-decoration:none">${title}</a>` : title;
}

function meta(o: Opportunity): string {
  const who = o.bureau && o.bureau !== o.agency ? `${o.agency} (${o.bureau})` : o.agency;
  return [
    who,
    o.naics ? `NAICS ${o.naics}` : null,
    o.psc ? `PSC ${o.psc}` : null,
    o.estValue,
    o.awardQuarter ? `award ${o.awardQuarter}` : null,
    o.solicitationDate ? `solicitation ${o.solicitationDate}` : null,
    o.setAside && o.setAside !== "None" ? `set-aside ${o.setAside}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function esc(s: string | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
