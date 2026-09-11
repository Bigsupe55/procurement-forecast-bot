/* Forecast triage client.
 *
 * Talks to the local server only: GET /api/data for everything, POST
 * /api/pursuit for each decision. State lives on disk in data/pursuit.json,
 * never in browser storage, so the weekly digest can read it.
 *
 * Every value rendered here comes from federal source systems, so it is
 * escaped on the way into the DOM rather than trusted.
 */

const PAGE_SIZE = 100;

/* Static export mode. `npm run dashboard:export` inlines the payload as
 * window.__STATIC__ and there is no server behind the page, so every mutation
 * is removed: no triage buttons, no note saving, no write endpoint to call.
 * Reading, expanding, filtering and searching all still work. */
const STATIC = typeof window !== 'undefined' && window.__STATIC__;
const READONLY = !!STATIC;

const state = {
  all: [],
  filtered: [],
  shown: PAGE_SIZE,
  meta: null,
  companyStatus: null,
  expanded: new Set(),
  filters: { q: '', source: '', elig: '', triage: '', priorityOnly: false },
};

const $ = (id) => document.getElementById(id);

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const num = (n) => Number(n || 0).toLocaleString('en-US');

/* Deterministic initials and tone, the kit's "identity without logos" rule. */
function monogram(name) {
  const clean = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  return { initials: initials || '?', tone: hash % 6 };
}

/* Some sources ship a present-but-blank date (the Gateway does this), which
   would otherwise render a bare "Sol." with nothing after it. Trim first and
   drop anything that is empty once trimmed. */
function datePart(v) {
  const s = String(v ?? '').trim();
  return s ? esc(s.slice(0, 10)) : '';
}

function timing(o) {
  const bits = [];
  const award = String(o.awardQuarter ?? '').trim();
  if (award) bits.push(`Award ${esc(award)}`);
  const sol = datePart(o.solicitationDate);
  if (sol) bits.push(`Sol. ${sol}`);
  const pop = datePart(o.popEnd);
  if (pop) bits.push(`PoP ends ${pop}`);
  return bits.length ? bits.join('<br>') : '<span class="score-of">Not stated</span>';
}

/* ---------- rendering ---------- */

function renderHead() {
  const m = state.meta;
  const when = new Date(m.generatedAt);
  const stamp = when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  $('head-meta').innerHTML =
    `Last run ${esc(stamp)} &middot; ${num(m.totalScored)} opportunities scored &middot; ` +
    `${num(m.priorityCount)} at or above the priority threshold of ${m.worthActingOn}. ` +
    (READONLY
      ? 'Read-only snapshot: triage is disabled in this exported copy.'
      : 'Refresh the data with <code>npm run dry</code>.');
}

function renderGate(summary) {
  const gate = $('gate');
  const blocked = summary['blocked-cert'] || 0;
  const unknown = summary.unknown || 0;
  if (state.companyStatus.samRegistered && blocked === 0) { gate.hidden = true; return; }

  gate.hidden = false;
  if (!state.companyStatus.samRegistered) {
    $('gate-mark').textContent = 'Blocked';
    $('gate-line').innerHTML =
      '<strong>No SAM.gov registration and no UEI.</strong> No federal award can be received until that is done, ' +
      'so every item below is currently unreachable as a prime. This is paperwork, not a capability gap, ' +
      'and it is the single highest-leverage thing that would make this list actionable.';
  } else {
    $('gate-mark').textContent = 'Note';
    $('gate-line').innerHTML = '<strong>SAM.gov registration is active.</strong>';
  }
  $('gate-sub').innerHTML =
    `Separately, <strong>${num(blocked)}</strong> ${blocked === 1 ? 'item is' : 'items are'} reserved for a certification ` +
    `the company does not hold (teaming or subcontracting is the only route to those), and ` +
    `<strong>${num(unknown)}</strong> have no usable set-aside stated.`;
}

function renderMetrics(summary, counts) {
  const m = state.meta;
  const cards = [
    { label: 'Tracked', value: num(m.totalScored), foot: 'scored this run', tone: '' },
    { label: `Priority ${m.worthActingOn}+`, value: num(m.priorityCount), foot: 'worth acting on', tone: 'tone-gold' },
    { label: 'Pursuing', value: num(counts.pursue), foot: `${num(counts.watch)} watching`, tone: 'tone-sage' },
    { label: 'Open to us', value: num(summary.open), foot: `${num(summary['sb-set-aside'])} small business`, tone: 'tone-sky' },
    { label: 'Cert blocked', value: num(summary['blocked-cert']), foot: 'teaming only', tone: '' },
  ];
  $('metrics').innerHTML = cards
    .map(
      (c) => `<div class="metric ${c.tone}">
        <span class="label">${esc(c.label)}</span>
        <div class="metric-value">${c.value}</div>
        <div class="metric-foot">${esc(c.foot)}</div>
      </div>`
    )
    .join('');
}

function rowHtml(o) {
  const mono = monogram(o.agency);
  const who = o.bureau && o.bureau !== o.agency ? `${o.agency} / ${o.bureau}` : o.agency;
  const pct = Math.max(0, Math.min(100, o.score));
  const st = o.pursuit ? o.pursuit.state : null;
  const open = state.expanded.has(o.fingerprint);

  return `
  <tr class="row-main${st === 'skip' ? ' is-skipped' : ''}" data-fp="${esc(o.fingerprint)}">
    <td>
      <div style="display:flex;gap:.75rem;align-items:flex-start">
        <span class="mono mono-${mono.tone}" aria-hidden="true">${esc(mono.initials)}</span>
        <span>
          <button class="cell-title" data-act="toggle" aria-expanded="${open}">${esc(o.title)}</button>
          <div class="cell-sub">${esc(who)}${o.naics ? ` &middot; NAICS ${esc(o.naics)}` : ''} &middot; ${esc(o.oppType)}</div>
        </span>
      </div>
    </td>
    <td>${esc(o.estValue || 'Not stated')}</td>
    <td style="font-size:.8125rem">${timing(o)}</td>
    <td>
      <span class="badge elig-${esc(o.eligibility.level)}">${esc(o.eligibility.label)}</span>
    </td>
    <td class="score">
      <span class="score-top"><span class="score-num">${o.score}</span><span class="score-of">/ 100</span></span>
      <span class="score-track">
        <span class="score-fill${o.score >= state.meta.worthActingOn ? ' is-priority' : ''}" style="width:${pct}%"></span>
        <span class="score-mark" style="left:${state.meta.worthActingOn}%"></span>
      </span>
    </td>
    <td>
      ${
        READONLY
          ? st
            ? `<span class="badge state-${esc(st)}">${esc(st)}</span>`
            : '<span class="score-of">Untriaged</span>'
          : `<div class="triage">
        ${['pursue', 'watch', 'skip']
          .map(
            (s) =>
              `<button class="tbtn" data-act="triage" data-state="${s}" aria-pressed="${st === s}" title="${
                st === s ? 'Click to clear' : ''
              }">${s[0].toUpperCase() + s.slice(1)}</button>`
          )
          .join('')}
      </div>`
      }
    </td>
  </tr>
  ${open ? detailHtml(o) : ''}`;
}

function detailHtml(o) {
  const fields = [
    ['Source', o.source],
    ['Agency', o.bureau && o.bureau !== o.agency ? `${o.agency} / ${o.bureau}` : o.agency],
    ['NAICS', o.naics ? `${o.naics}${o.naicsDesc ? ` ${o.naicsDesc}` : ''}` : null],
    ['Set-aside', o.setAside],
    ['Incumbent', o.incumbent],
    ['Point of contact', o.bureauPoc],
    ['Phase', o.phase],
    ['Place', o.placeState],
    ['Fit', o.fitTag],
    ['Cross-reference', o.crossRef],
  ].filter(([, v]) => v);

  const note = o.pursuit && o.pursuit.note ? o.pursuit.note : '';

  return `
  <tr class="detail" data-fp="${esc(o.fingerprint)}">
    <td colspan="6">
      ${o.description ? `<p class="detail-desc">${esc(o.description)}</p>` : ''}
      <p class="detail-desc"><strong>Can we bid:</strong> ${esc(o.eligibility.detail)}</p>
      ${
        o.scoreReasons && o.scoreReasons.length
          ? `<div class="signals">${o.scoreReasons.map((r) => `<span class="signal">${esc(r)}</span>`).join('')}</div>`
          : ''
      }
      <div class="detail-grid">
        ${fields
          .map(([k, v]) => `<div><span class="label">${esc(k)}</span>${esc(v)}</div>`)
          .join('')}
      </div>
      ${
        READONLY
          ? note
            ? `<p class="detail-desc"><strong>Note:</strong> ${esc(note)}</p>`
            : ''
          : `<div class="note-row">
        <textarea data-act="note" placeholder="Note: why this matters, who to call, what to do next">${esc(note)}</textarea>
        <button class="btn" data-act="save-note">Save note</button>
      </div>`
      }
      <p style="margin:0 0 1rem"><a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">Open at source</a>
      <span class="saving" data-role="status"></span></p>
    </td>
  </tr>`;
}

function renderRows() {
  const slice = state.filtered.slice(0, state.shown);
  $('rows').innerHTML = slice.map(rowHtml).join('');
  $('empty').hidden = state.filtered.length > 0;
  $('count').textContent = `${num(state.filtered.length)} of ${num(state.all.length)}`;
  $('more').hidden = state.filtered.length <= state.shown;
  $('more').textContent = `Show more (${num(state.filtered.length - state.shown)} remaining)`;
}

/* ---------- filtering ---------- */

function applyFilters() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  state.filtered = state.all.filter((o) => {
    if (f.source && o.source !== f.source) return false;
    if (f.elig && o.eligibility.level !== f.elig) return false;
    if (f.priorityOnly && o.score < state.meta.worthActingOn) return false;
    if (f.triage) {
      const st = o.pursuit ? o.pursuit.state : null;
      if (f.triage === 'untriaged' ? st !== null : st !== f.triage) return false;
    }
    if (q) {
      const hay = `${o.title} ${o.agency} ${o.bureau || ''} ${o.naics || ''} ${o.description || ''} ${
        o.incumbent || ''
      }`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  state.shown = PAGE_SIZE;
  renderRows();
}

/* ---------- mutations ---------- */

async function postPursuit(fp, body) {
  const res = await fetch('/api/pursuit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint: fp, ...body }),
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  return res.json();
}

async function setTriage(fp, next) {
  const o = state.all.find((x) => x.fingerprint === fp);
  if (!o) return;
  const current = o.pursuit ? o.pursuit.state : null;
  const target = current === next ? null : next; // clicking the active state clears it
  const result = await postPursuit(fp, { state: target, title: o.title });
  o.pursuit = result.entry;
  renderMetricsFromCounts(result.counts);
  applyFilters();
}

function renderMetricsFromCounts(counts) {
  state.pursuitCounts = counts;
  renderMetrics(state.eligibilitySummary, counts);
}

/* ---------- wiring ---------- */

function wire() {
  $('rows').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const fp = tr.dataset.fp;
    const act = btn.dataset.act;

    if (act === 'toggle') {
      if (state.expanded.has(fp)) state.expanded.delete(fp);
      else state.expanded.add(fp);
      renderRows();
      return;
    }

    // A static export has no server to write to; nothing below should fire.
    if (READONLY) return;

    if (act === 'triage') {
      btn.disabled = true;
      try {
        await setTriage(fp, btn.dataset.state);
      } catch (err) {
        alert(`Could not save: ${err.message}`);
        btn.disabled = false;
      }
      return;
    }

    if (act === 'save-note') {
      const box = tr.querySelector('[data-act="note"]');
      const status = tr.querySelector('[data-role="status"]');
      const o = state.all.find((x) => x.fingerprint === fp);
      // A note implies interest: default an untriaged item to watch rather than
      // silently dropping the note on the floor.
      const nextState = o.pursuit ? o.pursuit.state : 'watch';
      status.textContent = 'Saving...';
      try {
        const result = await postPursuit(fp, { state: nextState, note: box.value, title: o.title });
        o.pursuit = result.entry;
        status.textContent = 'Saved.';
        renderMetricsFromCounts(result.counts);
      } catch (err) {
        status.textContent = `Could not save: ${err.message}`;
      }
    }
  });

  $('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    applyFilters();
  });
  $('f-source').addEventListener('change', (e) => { state.filters.source = e.target.value; applyFilters(); });
  $('f-elig').addEventListener('change', (e) => { state.filters.elig = e.target.value; applyFilters(); });
  $('f-state').addEventListener('change', (e) => { state.filters.triage = e.target.value; applyFilters(); });
  $('f-priority').addEventListener('click', (e) => {
    state.filters.priorityOnly = !state.filters.priorityOnly;
    e.currentTarget.setAttribute('aria-pressed', String(state.filters.priorityOnly));
    applyFilters();
  });
  $('f-reset').addEventListener('click', () => {
    state.filters = { q: '', source: '', elig: '', triage: '', priorityOnly: false };
    $('q').value = ''; $('f-source').value = ''; $('f-elig').value = ''; $('f-state').value = '';
    $('f-priority').setAttribute('aria-pressed', 'false');
    applyFilters();
  });
  $('more').addEventListener('click', () => { state.shown += PAGE_SIZE; renderRows(); });
}

async function init() {
  const data = STATIC || (await (await fetch('/api/data')).json());

  if (!data.ready) {
    $('head-meta').textContent = data.message;
    return;
  }

  state.all = data.opportunities.sort((a, b) => b.score - a.score);
  state.meta = data.meta;
  state.companyStatus = data.companyStatus;
  state.eligibilitySummary = data.eligibilitySummary;
  state.pursuitCounts = data.pursuitCounts;

  const sources = [...new Set(state.all.map((o) => o.source))].sort();
  $('f-source').innerHTML =
    '<option value="">All sources</option>' +
    sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

  renderHead();
  renderGate(data.eligibilitySummary);
  renderMetrics(data.eligibilitySummary, data.pursuitCounts);
  wire();
  applyFilters();
}

init().catch((err) => {
  $('head-meta').textContent = `Could not load data: ${err.message}`;
});
