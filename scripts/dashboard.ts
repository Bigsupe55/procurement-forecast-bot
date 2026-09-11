// Local triage dashboard server.
//
//   npm run dashboard        then open http://127.0.0.1:4317
//
// LOCAL ONLY BY DESIGN. It binds 127.0.0.1 explicitly, never 0.0.0.0, so it is
// not reachable from the network. This data is which federal opportunities
// the company is tracking and how it rates them, which is not something to
// serve publicly. Do not "fix" the bind address to make it remotely reachable
// without deciding on authentication first.
//
// Why a server rather than a plain HTML file: triage decisions have to persist
// somewhere the weekly digest can read them (data/pursuit.json, committed).
// A file:// page could only write to browser storage, which CI cannot see and
// which vanishes when site data is cleared.
//
// No dependencies: node:http and node:fs only.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { paths } from "../src/config.js";
import { readSnapshot } from "../src/core/snapshot.js";
import { assessEligibility, COMPANY_STATUS, summarizeEligibility } from "../src/core/eligibility.js";
import { loadPursuit, savePursuit, setPursuit, isPursuitState, countByState } from "../src/core/pursuit.js";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4317);
const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Serve a file from dashboard/ only. Rejects anything that escapes the folder. */
function sendStatic(res: import("node:http").ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = normalize(join(paths.dashboard, rel));
  if (!resolved.startsWith(paths.dashboard) || !existsSync(resolved)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(resolved)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(resolved));
}

/** Snapshot + eligibility + current triage state, everything the page needs. */
function buildPayload() {
  const snapshot = readSnapshot(paths.snapshot);
  const pursuit = loadPursuit(paths.pursuit);

  if (!snapshot) {
    return {
      ready: false as const,
      message: "No snapshot yet. Run `npm run dry` to generate one, then reload.",
      companyStatus: COMPANY_STATUS,
    };
  }

  return {
    ready: true as const,
    meta: snapshot.meta,
    companyStatus: COMPANY_STATUS,
    eligibilitySummary: summarizeEligibility(snapshot.opportunities.map((o) => o.setAside)),
    pursuitCounts: countByState(pursuit),
    opportunities: snapshot.opportunities.map((o) => ({
      fingerprint: o.fingerprint,
      title: o.title,
      description: o.description,
      agency: o.agency,
      bureau: o.bureau,
      source: o.source,
      oppType: o.oppType,
      naics: o.naics,
      naicsDesc: o.naicsDesc,
      estValue: o.estValue,
      setAside: o.setAside,
      awardQuarter: o.awardQuarter,
      solicitationDate: o.solicitationDate,
      popEnd: o.popEnd,
      incumbent: o.incumbent,
      bureauPoc: o.bureauPoc,
      placeState: o.placeState,
      phase: o.phase,
      url: o.url,
      fitTag: o.fitTag,
      crossRef: o.crossRef,
      score: o.score,
      scoreReasons: o.scoreReasons,
      eligibility: assessEligibility(o.setAside),
      pursuit: pursuit[o.fingerprint] ?? null,
    })),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/data") {
    try {
      sendJson(res, 200, buildPayload());
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pursuit") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // A local tool still should not accept an unbounded body.
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as {
          fingerprint?: string;
          state?: string | null;
          note?: string;
          title?: string;
        };
        if (!body.fingerprint) return sendJson(res, 400, { error: "fingerprint required" });
        if (body.state !== null && !isPursuitState(body.state)) {
          return sendJson(res, 400, { error: `state must be null, pursue, watch, or skip` });
        }
        const next = setPursuit(loadPursuit(paths.pursuit), body.fingerprint, {
          state: body.state as never,
          note: body.note,
          title: body.title,
        });
        savePursuit(paths.pursuit, next);
        sendJson(res, 200, {
          ok: true,
          entry: next[body.fingerprint] ?? null,
          counts: countByState(next),
        });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
    });
    return;
  }

  if (req.method === "GET") return sendStatic(res, url.pathname);

  res.writeHead(405, { "content-type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  const snapshot = readSnapshot(paths.snapshot);
  console.log(`\n  the company forecast triage`);
  console.log(`  http://${HOST}:${PORT}\n`);
  if (snapshot) {
    console.log(`  ${snapshot.opportunities.length} opportunities from the run at ${snapshot.meta.generatedAt}`);
    console.log(`  Refresh the data with: npm run dry`);
  } else {
    console.log(`  No snapshot found. Run \`npm run dry\` first, then reload.`);
  }
  console.log(`  Decisions are written to data/pursuit.json (committed, read by the weekly digest).\n`);
});
