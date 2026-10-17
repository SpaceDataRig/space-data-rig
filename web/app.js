// Space Data Rig dashboard logic.
//
// Boots the 3D round-table room (space.js / three.js), then drives it and the text
// deliberation log from a single live SSE connection:
//   - each seat event lights that avatar, floats a speech bubble over its head, and
//     appends a row to the deliberation log below
//   - the Chair (Mission Director) moderates: an intro on load, a call at each verdict,
//     and a summary when a round closes -- all from real run/finding data, never invented
//   - every clock is UTC
//   - findings render as holographic cards: open plots, verify the bundle, anchor on mainnet
// window/ESM: MissionRoom and SEAT_META come from /space.js.

import { MissionRoom, SEAT_META } from "/space.js";
import { connectLive } from "/live.js";
import { headlineRelabelNote } from "/relabel.js";

const $ = (sel, el = document) => el.querySelector(sel);

const BADGE = {
  accepted: { label: "RECOVERED", tone: "good", word: "recovered" },
  "needs-more-data": { label: "WATCHLIST", tone: "warn", word: "watchlist" },
  rejected: { label: "NOT RECOVERED", tone: "bad", word: "not recovered" },
};
// audit-5 origin pills: every catalog row is now honestly labeled as either a KNOWN-planet re-validation or
// an UNCONFIRMED blind-TOI candidate, so the growing rotating survey can never read as "new discoveries".
const ORIGIN_PILL = {
  "blind-toi": { label: "BLIND CANDIDATE - UNCONFIRMED", cls: "blind" },
  revalidation: { label: "Known-planet re-validation", cls: "known" },
};
function originOf(f) { return f && f.origin === "blind-toi" ? "blind-toi" : "revalidation"; }
const colorOf = (s) => (SEAT_META[s] && SEAT_META[s].color) || "#3ae0ff";
const glyphOf = (s) => (SEAT_META[s] && SEAT_META[s].glyph) || "AI";
const labelOf = (s) => (SEAT_META[s] && SEAT_META[s].label) || s;

// ---- helpers ---------------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function utc(iso) { if (!iso) return "--:--:--"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19); }
function shortHash(h) { return h ? `${h.slice(0, 10)}...${h.slice(-4)}` : "-"; }
function shortTx(t) { return t ? `${t.slice(0, 8)}...${t.slice(-6)}` : "-"; }
function explorerUrl(sig) { return `https://explorer.solana.com/tx/${sig}?cluster=mainnet`; }
function toneForLevel(level) { return level === "error" ? "error" : level === "warn" ? "hedge" : level === "result" ? "verdict" : "speak"; }

// ---- DOM refs --------------------------------------------------------------
const transcriptEl = $("#transcript");
const boardEl = $("#board");
const provBarEl = $("#prov-bar");
const ledgerEl = $("#ledger");
const connDot = $("#conn-dot");
const connLabel = $("#conn-label");
const modeBadge = $("#mode-badge");
const modeLabel = $("#mode-label");
const targetHud = $("#target-hud");
const speakerHud = $("#speaker-hud");
const findingsCountEl = $("#findings-count");
const boardMoreEl = $("#board-more");
const boardFilterEl = $("#board-filter");
const surveyStatsEl = $("#survey-stats");
const codeVersionEl = $("#code-version");
const runStatusEl = $("#run-status");
const runSubmitEl = $("#run-submit");
const runBtnEl = $("#run-btn");
const autoscrollEl = $("#transcript-autoscroll");

const findingsById = new Map();
let ledgerCache = [];
let lastRunning = false;
let speakerTimer = 0;

// ---- mission clock (UTC) ---------------------------------------------------
function tickClock() {
  const now = new Date();
  $("#utc-clock").textContent = now.toISOString().slice(11, 19);
  $("#utc-date").textContent = now.toISOString().slice(0, 10) + "  UTC";
}
setInterval(tickClock, 1000);
tickClock();

// ---- connection + mode -----------------------------------------------------
function setConn(state) {
  connDot.className = "dot" + (state === "live" ? " live" : state === "down" ? " down" : "");
  connLabel.textContent = state === "live" ? "live" : state === "down" ? "link down" : "connecting";
}
function setMode(mode, provider) {
  const live = mode === "live-llm";
  modeBadge.classList.toggle("live", live);
  modeLabel.textContent = live ? "LIVE AI" : "GROUNDED";
  modeBadge.title = live ? `Live chat model: ${provider}` : "The table speaks from the numbers each seat computed (no model key set). Add a DeepSeek/OpenAI key to go live.";
}

// ---- deliberation log ------------------------------------------------------
function addRow({ seat, ts, tone, text, model }) {
  const row = document.createElement("div");
  row.className = `trow ${esc(tone || "speak")}`;
  row.style.setProperty("--sc", colorOf(seat));
  const who = esc(labelOf(seat)) + (model ? ` <span class="t-model">&middot; ${esc(model)}</span>` : "");
  row.innerHTML =
    `<span class="t-av">${esc(glyphOf(seat))}</span>` +
    `<div class="t-main"><div class="t-top"><span class="t-seat">${who}</span>` +
    `<span class="t-time">${utc(ts)} UTC</span></div><div class="t-text">${esc(text)}</div></div>`;
  transcriptEl.appendChild(row);
  while (transcriptEl.childElementCount > 240) transcriptEl.removeChild(transcriptEl.firstElementChild);
  if (autoscrollEl.checked) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderThread(turns) {
  transcriptEl.innerHTML = "";
  (turns || []).forEach((t) => addRow({ seat: t.seat, ts: t.ts, tone: t.tone, text: t.text, model: t.model }));
}

// Show the tamper-evident deliberation receipt for the thread on screen. This seals the
// AI commentary only (integrity, not reproducible science) -- deliberately distinct from
// the bundle hash on each finding card. Rendered after the thread so it sits at the bottom.
function renderDeliberationReceipt(findingId, hash, models) {
  const old = transcriptEl.querySelector(".t-receipt");
  if (old) old.remove();
  if (!hash) return;
  const row = document.createElement("div");
  row.className = "trow verdict t-receipt";
  row.style.setProperty("--sc", colorOf("reporter"));
  const who = models && models.length ? `sealed by ${models.map(esc).join(" + ")}` : "sealed";
  row.innerHTML =
    `<span class="t-av">${esc(glyphOf("reporter"))}</span>` +
    `<div class="t-main"><div class="t-top"><span class="t-seat">Deliberation receipt</span></div>` +
    `<div class="t-text">The AI cross-examination above is ${esc(who)} and hash-sealed for integrity ` +
    `(<span class="t-model">${esc(hash.slice(0, 16))}&hellip;</span>). This seals the commentary only -- ` +
    `it is not reproducible science, and is separate from the finding's bundle hash.</div>` +
    `<div class="card-actions"><button class="btn tiny ghost" data-verify-delib="${esc(findingId)}">Verify receipt</button>` +
    `<button class="btn tiny" data-anchor-delib="${esc(findingId)}">Anchor on-chain</button>` +
    `<span class="verify-out" data-delib-status></span>` +
    `<div class="verify-out" data-delib-anchor></div></div></div>`;
  transcriptEl.appendChild(row);
  loadDelibAnchor(findingId);
}

// Fetch any existing on-chain deliberation anchor and show it under the receipt chip.
async function loadDelibAnchor(findingId) {
  const out = transcriptEl.querySelector(".t-receipt [data-delib-anchor]");
  if (!out) return;
  try {
    const a = await fetchJSON(`/api/discussion/${encodeURIComponent(findingId)}/anchor`);
    if (a && a.anchored) renderDelibAnchor(out, a);
  } catch { /* no anchor yet: stay silent */ }
}

// Render the on-chain deliberation anchor state (separate sdr:delib memo from the bundle).
function renderDelibAnchor(out, a) {
  if (!out) return;
  const url = a.explorerUrl || (a.signature ? `https://explorer.solana.com/tx/${a.signature}?cluster=mainnet` : null);
  const tx = a.signature ? `${String(a.signature).slice(0, 16)}...` : "";
  out.className = "verify-out ok";
  out.innerHTML = url
    ? `deliberation anchored on mainnet (slot ${esc(String(a.slot ?? "?"))}) - <a href="${esc(url)}" target="_blank" rel="noopener">${esc(tx)}</a>`
    : `deliberation anchored on mainnet`;
}

transcriptEl.addEventListener("click", async (e) => {
  const abtn = e.target.closest?.("[data-anchor-delib]");
  if (abtn) { await handleAnchorDelib(abtn); return; }
  const btn = e.target.closest?.("[data-verify-delib]");
  if (!btn) return;
  const id = btn.getAttribute("data-verify-delib");
  const status = btn.parentElement.querySelector("[data-delib-status]");
  btn.disabled = true;
  if (status) { status.className = "verify-out"; status.textContent = "recomputing hash..."; }
  try {
    const v = await fetchJSON(`/api/discussion/${encodeURIComponent(id)}/receipt/verify`);
    if (status) {
      status.className = "verify-out " + (v.ok ? "ok" : "bad");
      status.textContent = v.ok
        ? `hash matches (${v.turns} lines, ${v.models.join(" + ")})`
        : `verify failed: ${v.error || "hash mismatch"}`;
    }
  } catch (err) {
    if (status) { status.className = "verify-out bad"; status.textContent = `verify error: ${err.message}`; }
  } finally {
    btn.disabled = false;
  }
});

// Anchor the sealed deliberation receipt on Solana mainnet (separate sdr:delib memo).
// Spends real SOL, so make it a deliberate act; repeat anchors of the same hash are free.
async function handleAnchorDelib(btn) {
  const id = btn.getAttribute("data-anchor-delib");
  const out = transcriptEl.querySelector(".t-receipt [data-delib-anchor]");
  if (!window.confirm("Anchor writes a real Solana MAINNET memo of this deliberation receipt and spends project SOL. Repeat anchors of the same receipt are free. Continue?")) return;
  btn.disabled = true;
  if (out) { out.className = "verify-out"; out.textContent = "submitting memo to mainnet..."; }
  try {
    const r = await adminFetch(`/api/anchor/${encodeURIComponent(id)}/deliberation`, { method: "POST", body: "{}" });
    const res = await r.json();
    if (res.ok && res.signature) {
      renderDelibAnchor(out, { anchored: true, signature: res.signature, slot: res.slot, explorerUrl: res.explorerUrl });
    } else if (out) {
      out.className = "verify-out bad";
      out.textContent = `anchor failed: ${res.error || "unknown"}`;
    }
  } catch (err) {
    if (out) { out.className = "verify-out bad"; out.textContent = `anchor error: ${err.message}`; }
  } finally {
    btn.disabled = false;
  }
}

// make a seat the live speaker in the 3D room + HUD, auto-clear the floor
function takeFloor(seat, text) {
  MissionRoom.say(seat, text);
  speakerHud.textContent = labelOf(seat) + " is speaking";
  clearTimeout(speakerTimer);
  speakerTimer = setTimeout(() => {
    MissionRoom.setSpeaker(null);
    speakerHud.textContent = "floor open";
  }, 7000);
}

// the Chair speaks a moderation line (grounded in real data)
function chairSays(text) {
  addRow({ seat: "chair", ts: new Date().toISOString(), tone: "speak", text });
  takeFloor("chair", text);
}

// ---- stats + findings ------------------------------------------------------
function renderStats(stats) {
  if (!stats) return;
  $("#stat-confirmed").textContent = stats.findingsAccepted ?? 0;
  $("#stat-watch").textContent = stats.findingsReview ?? 0;
  $("#stat-rejected").textContent = stats.findingsRejected ?? 0;
  $("#stat-anchored").textContent = stats.bundlesAnchored ?? 0;
  $("#stat-done").textContent = stats.tasksDone ?? 0;
  if (surveyStatsEl) surveyStatsEl.textContent = `survey pass ${stats.surveyPass ?? 0} - ${stats.distinctHosts ?? 0} distinct targets - ${stats.blindCandidates ?? 0} blind candidates (unconfirmed)`;
  renderFeedTicker(researchData, stats);
}

function metricsHtml(f) {
  const c = f.candidate || {};
  const depthPpm = f.depthPpm ?? Math.round((c.depthFrac ?? 0) * 1e6);
  const conf = f.recoveryConfidence != null ? `${Math.round(f.recoveryConfidence * 100)}%` : "n/a";
  const match = f.crossmatch?.matchedKnownPlanet ? esc(f.crossmatch.knownPlanetName || "yes") : "none";
  const cells = [
    ["Period", `${(c.periodDays ?? 0).toFixed(3)} d`],
    ["Depth", `${depthPpm} ppm`],
    ["SNR", (c.snr ?? 0).toFixed(1)],
    ["Duration", `${(c.durationHours ?? 0).toFixed(2)} h`],
    ["Confidence", conf],
    ["Known match", match],
  ];
  return cells.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

// ---- finding "Details" panel: next-transit countdown, NASA cross-match, recovery trials, on-chain proof ----
// Read-only presentation of fields the finding ALREADY carries (src/core/types.ts Finding) -- no new call,
// no worker change. The stored ephemeris is a linear model (t0Bjd, periodDays); its nextTransitsBjd starts
// AT t0 (a past TESS epoch), so the next FUTURE transit is projected forward from that same model. That is
// honest extrapolation of the published ephemeris, and it is labeled barycentric/approximate-UTC so it can
// never read as a precise observing ephemeris. Everything degrades to "" when a field is absent.
const BJD_UNIX_OFFSET = 2440587.5; // Julian Date of the Unix epoch (1970-01-01T00:00:00Z)
const MS_PER_DAY = 86400000;
function bjdToMs(bjd) { return (bjd - BJD_UNIX_OFFSET) * MS_PER_DAY; }
function fmtCountdown(targetMs) {
  let s = Math.round((targetMs - Date.now()) / 1000);
  if (s <= 0) return "transit window reached";
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `in ~${d}d ${h}h ${m}m`;
  if (h > 0) return `in ~${h}h ${m}m`;
  return `in ~${m}m`;
}
function nextTransit(eph) {
  if (!eph || !Number.isFinite(eph.t0Bjd) || !(eph.periodDays > 0)) return null;
  const t0 = bjdToMs(eph.t0Bjd);
  const period = eph.periodDays * MS_PER_DAY;
  const k = Math.max(0, Math.ceil((Date.now() - t0) / period));
  return { nextMs: t0 + k * period, nextBjd: eph.t0Bjd + k * eph.periodDays };
}
function detailsHtml(f) {
  const rows = [];
  const nt = nextTransit(f.ephemeris);
  if (nt) {
    const utc = new Date(nt.nextMs).toISOString().slice(0, 16).replace("T", " ");
    rows.push(`<div class="det-row"><span class="det-k">Next transit</span><span class="det-v"><b data-countdown="${nt.nextMs}">${fmtCountdown(nt.nextMs)}</b> &middot; BJD ${nt.nextBjd.toFixed(3)} &middot; ~${utc} UTC</span></div>`);
    rows.push(`<div class="det-row"><span class="det-k">Ephemeris</span><span class="det-v">t0 = BJD ${f.ephemeris.t0Bjd.toFixed(3)}, P = ${f.ephemeris.periodDays.toFixed(5)} d &mdash; linear, barycentric, so the UTC instant is approximate to a few minutes</span></div>`);
  }
  const x = f.crossmatch;
  if (x && x.matchedKnownPlanet) {
    const name = x.knownPlanetName || "a catalogued planet";
    const per = x.knownPeriodDays != null ? ` &middot; catalog P = ${x.knownPeriodDays.toFixed(4)} d` : "";
    const delta = x.periodDeltaPct != null ? ` &middot; our period differs by ${Math.abs(x.periodDeltaPct).toFixed(3)}%` : "";
    const link = x.knownPlanetName ? ` &middot; <a href="https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(x.knownPlanetName)}" target="_blank" rel="noopener">NASA archive row &rarr;</a>` : "";
    rows.push(`<div class="det-row"><span class="det-k">NASA cross-match</span><span class="det-v">matched <b>${esc(name)}</b>${per}${delta}${link}</span></div>`);
  } else if (x) {
    rows.push(`<div class="det-row"><span class="det-k">NASA cross-match</span><span class="det-v">no catalogued planet matched this signal</span></div>`);
  }
  if (f.recoveryConfidence != null) {
    const pct = `${Math.round(f.recoveryConfidence * 100)}%`;
    const trials = f.recoveryTrials ? ` (${f.recoveryTrials.nRecovered}/${f.recoveryTrials.nTrials} fresh-noise replays recovered it)` : " of fresh-noise replays recovered it";
    rows.push(`<div class="det-row"><span class="det-k">Injection recovery</span><span class="det-v">${pct}${trials}</span></div>`);
  }
  rows.push(`<div class="det-row"><span class="det-k">Bundle hash</span><span class="det-v"><code class="det-hash">${esc(f.bundleHash || "not sealed")}</code></span></div>`);
  rows.push(f.solanaTx
    ? `<div class="det-row"><span class="det-k">On-chain proof</span><span class="det-v"><a class="txlink det-hash" href="${esc(explorerUrl(f.solanaTx))}" target="_blank" rel="noopener">${esc(f.solanaTx)}</a></span></div>`
    : `<div class="det-row"><span class="det-k">On-chain proof</span><span class="det-v">not anchored yet &mdash; Anchor seals this bundle hash in a Solana mainnet memo</span></div>`);
  rows.push(`<div class="det-note">Verify recomputes this hash from the stored cold artifacts and checks every file; the on-chain memo carries the same hash, so the two must agree.</div>`);
  return rows.join("");
}
// One shared ticker refreshes every rendered next-transit countdown; it re-queries the DOM each tick so
// re-rendered cards are picked up automatically. Minute granularity is ample for a transit hours/days out.
function tickCountdowns() {
  for (const el of document.querySelectorAll("[data-countdown]")) {
    const t = Number(el.getAttribute("data-countdown"));
    if (Number.isFinite(t)) el.textContent = fmtCountdown(t);
  }
}

function plotsHtml(id) {
  const items = [["timeseries.svg", "Light curve + transit model"], ["folded.svg", "Folded at the detected period"], ["periodogram.svg", "BLS periodogram (power vs period)"]];
  return items.map(([name, cap]) => `<figure><figcaption>${cap}</figcaption><img loading="lazy" src="/api/bundles/${encodeURIComponent(id)}/artifact/${name}" alt="${cap}" /></figure>`).join("");
}

// Bundles are immutable (a design goal), so records sealed before the 2026-10 honesty pass still carry their
// stored "Confirmed: ..." headline even though that word has been retired for new cards (audit-3 defect B:
// older cards would otherwise look MORE overclaiming over time). The display layer re-labels those legacy
// headlines honestly as injection-recovery. The predicate itself lives in /relabel.js so it is ONE source of
// truth shared with tests/live-data-regression.test.ts -- audit-4 caught that the inline version's strict `<`
// boundary matched ZERO live cards (all four legacy cards were created ON the policy date) and a string-match
// test could not see it. Only fires for a pre-policy card whose stored text still says "confirm".

function cardHtml(f) {
  const badge = BADGE[f.verdict] || BADGE.rejected;
  const pill = ORIGIN_PILL[originOf(f)];
  const headline = f.narration?.headline || f.verdictReason || "Finding";
  const relabel = headlineRelabelNote(f);
  const explainer = f.narration?.explainer || "";
  const score = f.score != null ? `<span class="score">${f.score}/100</span>` : "";
  const chain = f.solanaTx
    ? `<span><b>tx</b> <a class="txlink" href="${esc(explorerUrl(f.solanaTx))}" target="_blank" rel="noopener">${esc(shortTx(f.solanaTx))}</a></span>`
    : `<span><b>on-chain</b> not anchored</span>`;
  return `<div class="card tone-${badge.tone}" data-id="${esc(f.id)}">
    <div class="card-top"><span class="card-target">${esc(f.targetId)}</span><span class="card-side">${score}<span class="origin-pill ${pill.cls}">${pill.label}</span><span class="badge ${badge.tone}">${badge.label}</span></span></div>
    <div class="headline">${esc(headline)}</div>
    ${relabel ? `<div class="relabel-note">${esc(relabel)}</div>` : ""}
    <div class="metrics">${metricsHtml(f)}</div>
    ${explainer ? `<div class="explainer-text">${esc(explainer)}</div>` : ""}
    <div class="prov"><span><b>bundle</b> ${esc(shortHash(f.bundleHash))}</span>${chain}</div>
    <div class="prov-line" data-prov><span class="hint">provenance&hellip;</span></div>
    <div class="card-actions">
      <button class="btn tiny ghost" data-action="plots">Plots</button>
      <button class="btn tiny ghost" data-action="verify">Verify</button>
      <button class="btn tiny" data-action="anchor">${f.solanaTx ? "Re-anchor" : "Anchor"}</button>
      <span class="verify-out" data-status></span>
    </div>
    <details class="card-details">
      <summary>Details</summary>
      <div class="det-body">${detailsHtml(f)}</div>
    </details>
    <div class="plots" data-plots data-loaded="0"></div>
  </div>`;
}

// the catalog opens on a single row of the four newest findings; the More button
// reveals the older rest (newest first throughout)
const BOARD_PREVIEW = 4;
let boardExpanded = false;
let boardFilter = "all"; // all | revalidation | blind-toi

function sortedFindings() {
  return [...findingsById.values()].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || (b.score ?? 0) - (a.score ?? 0));
}
function renderBoard() {
  const all = sortedFindings();
  const list = all.filter((f) => boardFilter === "all" || originOf(f) === boardFilter);
  if (!all.length) {
    boardEl.classList.remove("row-of-four");
    boardEl.innerHTML = `<p class="empty">Awaiting first light. Launch a run to watch the table deliberate.</p>`;
    findingsCountEl.textContent = "0 findings";
    boardMoreEl.hidden = true;
  } else {
    const shown = boardExpanded ? list : list.slice(0, BOARD_PREVIEW);
    boardEl.classList.toggle("row-of-four", !boardExpanded);
    boardEl.innerHTML = shown.length ? shown.map(cardHtml).join("") : `<p class="empty">No findings in this view.</p>`;
    findingsCountEl.textContent = boardFilter === "all"
      ? `${all.length} finding${all.length === 1 ? "" : "s"}`
      : `${list.length} of ${all.length} findings`;
    boardMoreEl.hidden = list.length <= BOARD_PREVIEW;
    boardMoreEl.textContent = boardExpanded ? "Show less" : `More (+${list.length - BOARD_PREVIEW} older)`;
    fillProvenance();
  }
  if (boardFilterEl) for (const chip of boardFilterEl.querySelectorAll("[data-filter]")) chip.classList.toggle("active", chip.dataset.filter === boardFilter);
}
function upsertFinding(f) { findingsById.set(f.id, f); renderBoard(); }

// ---- provenance: show the data's origin on the run bar and on every card ----
const NASA_TABLE_URL = "https://exoplanetarchive.ipac.caltech.edu/cgi-bin/TblView/nph-tblView?config=pscomppars";
const manifestCache = new Map();

function renderProvBar(sum) {
  const src = sum && sum.catalogSource;
  if (!src || src === "unavailable") { provBarEl.hidden = true; return; }
  provBarEl.hidden = false;
  const live = src === "nasa-tap";
  provBarEl.innerHTML = live
    ? `<span class="prov-tag live">CATALOG: LIVE NASA</span>` +
      `<span>Target parameters queried this run from the <a href="${NASA_TABLE_URL}" target="_blank" rel="noopener">NASA Exoplanet Archive</a> (TAP <code>pscomppars</code>). ` +
      `Light curves are real MAST TESS photometry where a target is in the curated registry, otherwise seeded ` +
      `reproducible stand-ins built from those real parameters -- each card labels which tier produced its photons. ` +
      `Every bundle stamps its source and data hash.</span>`
    : `<span class="prov-tag offline">CATALOG: OFFLINE SNAPSHOT</span>` +
      `<span>This run used the bundled copy of real archive values (no network). Light curves are seeded, reproducible stand-ins.</span>`;
}

async function fillProvenance() {
  const cards = [...boardEl.querySelectorAll(".card")];
  await Promise.all(cards.map(async (card) => {
    const id = card.dataset.id;
    const slot = card.querySelector("[data-prov]");
    if (!id || !slot) return;
    let m = manifestCache.get(id);
    if (m === undefined) {
      try { m = await fetchJSON(`/api/bundles/${encodeURIComponent(id)}/manifest`); }
      catch { m = null; }
      manifestCache.set(id, m);
    }
    const dp = (m && m.dataProvenance) || {};
    const live = dp.catalogSource === "nasa-tap";
    // link the exact planet row when the cross-match identified one, else the host star page
    const nasaName = (m && (m.crossmatch?.knownPlanetName || m.targetId)) || "";
    const nasaRow = nasaName
      ? `<a class="prov-link" href="https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(nasaName)}" target="_blank" rel="noopener">NASA archive row &rarr;</a>`
      : "";
    const lcSrc = String(dp.lightCurveSource || "");
    const isRealLC = /real photometry/i.test(lcSrc);
    const lc = dp.lightCurveHash
      ? (isRealLC
        ? `<span class="prov-tag real" title="${esc(lcSrc)}">REAL TESS PHOTOMETRY</span>` +
          `<span class="hint">lc hash ${esc(shortHash(dp.lightCurveHash))}</span>`
        : `<span class="hint" title="${esc(lcSrc)}">lc hash ${esc(shortHash(dp.lightCurveHash))} &middot; seeded stand-in</span>`)
      : "";
    slot.innerHTML =
      `<span class="prov-tag ${live ? "live" : "offline"}">${live ? "NASA LIVE TAP" : esc(String(dp.catalogSource || "offline"))}</span>` +
      nasaRow + lc;
  }));
}

function setTarget(name) {
  const n = (name || "SYSTEM").toUpperCase();
  targetHud.textContent = n;
  MissionRoom.setHologram(n);
}

function renderLedger(entries) {
  ledgerCache = entries || [];
  if (!entries || !entries.length) { ledgerEl.innerHTML = `<p class="empty">Nothing anchored yet.</p>`; return; }
  ledgerEl.innerHTML = entries.map((e) => {
    const tx = e.signature
      ? `<a class="txlink" href="${esc(e.explorerUrl || explorerUrl(e.signature))}" target="_blank" rel="noopener">${shortTx(e.signature)}</a>`
      : `<span class="hint">${esc(e.status)}</span>`;
    return `<div class="ledger-row"><span class="pill ${esc(e.status)}">${esc(e.status)}</span>` +
      `<span class="ledger-id" title="${esc(e.findingId)}">${esc(e.findingId)}</span>${tx}</div>`;
  }).join("");
}

// ---- data loading ----------------------------------------------------------
async function fetchJSON(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); }

// Admin bearer token for the mutating endpoints (/api/run, /api/anchor/*). Since audit-10 #7 the
// server is DENY-BY-DEFAULT: with no ADMIN_TOKEN set -- or a request that does not carry the right
// bearer -- those endpoints return 401. The operator stores the token once (localStorage key
// "sdr-admin-token") and it is sent as a bearer header. Read-only views never need it.
function adminHeaders() {
  const h = { "Content-Type": "application/json" };
  try { const t = localStorage.getItem("sdr-admin-token"); if (t) h["Authorization"] = "Bearer " + t; } catch (e) { /* storage unavailable */ }
  return h;
}

// A mutating fetch that handles the deny-by-default gate gracefully: on a 401 it prompts the
// operator to enter the admin token (so there IS an input path, not just a silent failure),
// remembers it in this browser, and retries the call once. Anonymous visitors who dismiss the
// prompt simply see the original 401. All three mutation call sites route through here.
async function adminFetch(path, opts) {
  let r = await fetch(path, { ...opts, headers: adminHeaders() });
  if (r.status === 401) {
    const t = window.prompt("Admin access token required for this action. Enter it to unlock (stored only in this browser):");
    if (t && t.trim()) {
      try { localStorage.setItem("sdr-admin-token", t.trim()); } catch (e) { /* storage unavailable */ }
      r = await fetch(path, { ...opts, headers: adminHeaders() });
    }
  }
  return r;
}

function applyState(s) {
  renderStats(s.stats);
  (s.findings || []).forEach((f) => findingsById.set(f.id, f));
  renderBoard();
  if (s.findings && s.findings[0]) setTarget(s.findings[0].targetId);
  if (s.codeVersion) codeVersionEl.textContent = s.codeVersion;
  applyRunState(s.activeRun);
  renderProvBar(s.activeRun?.summary);
}

async function loadAll() {
  try {
    const s = await fetchJSON("/api/state");
    applyState(s);
    if (s.ai) setMode(s.ai.mode, s.ai.provider);
    MissionRoom.setAgents(s.seats);
    const d = await fetchJSON("/api/discussion");
    if (d.threads && d.threads.length) {
      renderThread(d.threads[0].turns);
      // Seed grounded instantly, then swap in the live two-model cross-examination for the
      // thread actually on screen -- without blocking boot or the connection indicator.
      enrichThread(d.threads[0].findingId);
    } else {
      transcriptEl.innerHTML = `<p class="empty">The deliberation log fills up the moment you launch a run.</p>`;
    }
    chairSays("The round table is seated. Five specialists plus the chair, awaiting a target.");
    await loadLedger();
  } catch (e) {
    setConn("down");
    addRow({ seat: "reporter", ts: new Date().toISOString(), tone: "error", text: `Could not reach the rig: ${e.message}` });
  }
}

async function loadLedger() { try { const r = await fetchJSON("/api/ledger"); renderLedger(r.ledger); } catch { /* best effort */ } }

// ---- candidate board (opt-in, research only) -------------------------------
// Lazy-loads web/candidates.json (a static snapshot the offline p22 pipeline publishes) ONLY when a
// visitor expands the section. Kept strictly separate from the verified findings above: every row is a
// CANDIDATE with discoveryClaim structurally false, most are expected false positives, and nothing here is
// anchored or fed to the money path. It is a read-only static asset -- no worker/DO code is involved.
const candDetailsEl = $("#candidates-details");
const candBoardEl = $("#cand-board");
const candDisclaimerEl = $("#cand-disclaimer");
const candMetaEl = $("#cand-meta");
const candTallyEl = $("#cand-tally");
let candidatesLoaded = false;

function candCardHtml(c) {
  const flags = [];
  if (c.suspectedCommonSystematic) flags.push(`<span class="cand-flag bad">shared ephemeris &times;${c.distinctHostsSharingEphemeris} hosts &rarr; likely one systematic, not ${c.distinctHostsSharingEphemeris} planets</span>`);
  if (c.corroboratedSectors >= 2) flags.push(`<span class="cand-flag good">recurs in ${c.corroboratedSectors} sectors</span>`);
  if (c.depthRegime === "deep-suspect") flags.push(`<span class="cand-flag warn">depth in the EB / blend band</span>`);
  const next = c.nextTransitBjd != null ? `${c.nextTransitBjd.toFixed(3)} BJD${c.daysUntilNext != null ? ` (in ${c.daysUntilNext.toFixed(1)} d)` : ""}` : "unpredictable";
  const place = c.altitudeDeg != null ? `${c.altitudeDeg.toFixed(1)}&deg; at mid-transit &middot; ${c.observable ? "well placed" : "below 20&deg;"} from ${esc(c.siteName)}` : "position unavailable";
  const cells = [
    ["Period", `${c.periodDays.toFixed(3)} d`],
    ["Depth", `${Math.round(c.depthPpm)} ppm`],
    ["SNR", c.snr != null ? c.snr.toFixed(1) : "n/a"],
    ["Tmag", c.tmag != null ? c.tmag.toFixed(2) : "n/a"],
    ["Priority", `${esc(c.priorityBand)} (${c.priorityScore.toFixed(2)})`],
    ["Next transit", next],
  ];
  return `<div class="card tone-cand">
    <div class="card-top"><span class="card-target">TIC ${esc(String(c.tic))}</span><span class="card-side"><span class="badge cand">CANDIDATE</span></span></div>
    <div class="metrics">${cells.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
    <div class="cand-place">${place}</div>
    ${flags.length ? `<div class="cand-flags">${flags.join("")}</div>` : ""}
    <div class="prov"><span><b>tier</b> ${esc(c.tier)} &middot; ${esc(c.depthRegime)}</span><span><b>RA/Dec</b> ${c.ra.toFixed(3)}, ${c.dec.toFixed(3)}</span></div>
  </div>`;
}

function renderCandidates(s) {
  if (candDisclaimerEl) candDisclaimerEl.textContent = s.disclaimer || "";
  const sum = s.summary || {};
  const list = s.candidates || [];
  // Anti-misread tally: state the honest bottom line up front so a visitor cannot mistake a tentative
  // candidate for a confirmed planet, even without reading each card's tier/flags.
  if (candTallyEl) {
    const nSys = list.filter((c) => c.suspectedCommonSystematic).length;
    const nDeep = list.filter((c) => c.depthRegime === "deep-suspect").length;
    const nCor = list.filter((c) => (c.corroboratedSectors ?? 0) >= 2).length;
    const l3 = sum.l3Applied === true;
    const nCollapsed = typeof sum.systematicCollapsed === "number" ? sum.systematicCollapsed : nSys;
    if (list.length) {
      candTallyEl.hidden = false;
      const parts = [`none of these ${list.length} signals is a confirmed planet -- every one is an <b>unconfirmed candidate</b>.`];
      if (l3 && nCollapsed > 0) parts.push(`${nCollapsed} shared-ephemeris group(s) were collapsed as instrumental systematics (one artifact seen on several stars) and are not listed here.`);
      else if (nSys > 0) parts.push(`${nSys} look like a shared instrumental systematic (one artifact seen on several stars).`);
      parts.push(`${nDeep} sit in the eclipsing-binary / blend depth band, and ${nCor} recur across independent sectors.`);
      parts.push(`A high follow-up priority means "worth pointing a telescope at", <b>not</b> "likely a planet."`);
      candTallyEl.innerHTML = `<b>Read this first:</b> ${parts.join(" ")}`;
    } else {
      candTallyEl.hidden = true;
      candTallyEl.textContent = "";
    }
  }
  if (candMetaEl) candMetaEl.innerHTML = `Snapshot ${esc(s.generatedAt || "")} from TESS sector(s) ${esc((s.sectors || []).join(", "))} &middot; ${sum.rawDetections ?? 0} raw detections &rarr; ${sum.planetPlausible ?? 0} planet-plausible &rarr; ${sum.independentEphemerides ?? 0} independent ephemerides (${sum.multiHostSystematicGroups ?? 0} shared-host systematics, ${sum.corroboratedHosts ?? 0} corroborated across sectors) &middot; L3 ${sum.l3Applied === true ? "applied" : "off"}: ${sum.emittedCandidates ?? (s.candidates || []).length} candidate(s) emitted.`;
  candidatesRaw = list;
  applyCandidateView();
}

// ---- candidate catalog: search / sort / filter (item 3) --------------------
let candidatesRaw = [];
function candSortVal(c, key) {
  switch (key) {
    case "period": return c.periodDays;
    case "depth": return c.depthPpm;
    case "snr": return c.snr ?? 0;
    case "soon": return c.daysUntilNext ?? 1e9;
    default: return c.priorityScore ?? 0;
  }
}
function applyCandidateView() {
  const toolbar = $("#cand-toolbar");
  if (toolbar) toolbar.hidden = false;
  const q = ($("#cand-search")?.value || "").trim().toLowerCase();
  const sortby = $("#cand-sortby")?.value || "priority";
  const hideSys = $("#cand-hide-sys")?.checked ?? true;
  const onlyObs = $("#cand-only-obs")?.checked ?? false;
  let list = candidatesRaw.slice();
  if (hideSys) list = list.filter((c) => !c.suspectedCommonSystematic);
  if (onlyObs) list = list.filter((c) => c.observable);
  if (q) list = list.filter((c) => (`tic ${c.tic} ${c.priorityBand} ${c.periodDays.toFixed(3)} ${Math.round(c.depthPpm)}`).toLowerCase().includes(q));
  const dir = sortby === "soon" ? 1 : -1;
  list.sort((a, b) => (candSortVal(a, sortby) - candSortVal(b, sortby)) * dir);
  const cnt = $("#cand-count");
  if (cnt) cnt.textContent = `${list.length} of ${candidatesRaw.length} shown`;
  if (!list.length) { candBoardEl.innerHTML = `<p class="empty">No candidates match the current filter.</p>`; return; }
  candBoardEl.classList.remove("row-of-four");
  candBoardEl.innerHTML = list.map(candCardHtml).join("");
}
["cand-search", "cand-sortby", "cand-hide-sys", "cand-only-obs"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === "cand-search" ? "input" : "change", () => applyCandidateView());
});

async function loadCandidates() {
  if (candidatesLoaded) return;
  candBoardEl.innerHTML = `<p class="empty">Loading the latest candidate snapshot&hellip;</p>`;
  try {
    const s = await fetchJSON("/candidates.json");
    renderCandidates(s);
    candidatesLoaded = true;
  } catch (e) {
    candBoardEl.innerHTML = `<p class="empty">Candidate snapshot unavailable (${esc(e.message)}).</p>`;
  }
}

if (candDetailsEl) candDetailsEl.addEventListener("toggle", () => { if (candDetailsEl.open) loadCandidates(); });
// The board ships expanded by default, so the toggle never fires on first paint -- load it up front. If a
// visitor collapses and re-expands, loadCandidates() is guarded by candidatesLoaded and will not refetch.
if (candDetailsEl && candDetailsEl.open) loadCandidates();

// ---- name an observation (real, server-computed commissioning preview) -----
// The Run button calls /api/observe, which fetches REAL TESS-SPOC photometry for the chosen star, runs the
// SAME blind deterministic pipeline used for every target, and returns the sealed observation record + the
// sdr:observe:1 memo that WOULD anchor. No payment is taken and nothing is anchored client-side -- that is a
// separate, gated step. The client sanitizer only gives instant feedback; the server re-enforces the policy.
const OBSERVE_MAX = 160;

function observeSanitize(raw) {
  const value = String(raw ?? "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/[\x00-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const problems = [];
  if (!value) problems.push("the dedication is empty");
  if (/[<>]/.test(value)) problems.push("no angle brackets");
  if (/(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|io|app|xyz|dev|co|me|link|sol)\b)/i.test(value)) problems.push("no links or domains");
  if (Array.from(value).length > OBSERVE_MAX) problems.push(`keep it to ${OBSERVE_MAX} characters or fewer`);
  return { ok: problems.length === 0, value, problems };
}

function observeHint(msg, bad) {
  const h = $("#observe-hint");
  if (!h) return;
  h.textContent = msg || "";
  h.classList.toggle("bad", !!bad);
}

function renderObserveResult(o) {
  const out = $("#observe-out");
  if (!out) return;
  const s = o.science;
  const r = o.record;
  const verdictTxt = s.verdict === "no-transit"
    ? "No transit was detected \u2014 an honest zero, sealed exactly like a discovery would be."
    : "A blind-search signal passed the gate \u2014 still an unconfirmed candidate, not a discovery.";
  out.hidden = false;
  out.innerHTML =
    `<div class="observe-record">` +
      `<div class="observe-row"><span class="k">Target</span><span class="v">TIC ${esc(String(r.tic))}${r.sector != null ? ` \u00b7 sector ${esc(String(r.sector))}` : ""}</span></div>` +
      `<div class="observe-row"><span class="k">Dedication</span><span class="v">&ldquo;${esc(r.dedication)}&rdquo;</span></div>` +
      `<div class="observe-row"><span class="k">Result</span><span class="v">${verdictTxt}</span></div>` +
      `<div class="observe-grid">` +
        `<div><span class="k">SNR</span><span class="v">${s.snr.toFixed(1)}</span></div>` +
        `<div><span class="k">Period</span><span class="v">${s.periodDays.toFixed(3)} d</span></div>` +
        `<div><span class="k">Depth</span><span class="v">${Math.round(s.depthPpm)} ppm</span></div>` +
        `<div><span class="k">Baseline</span><span class="v">${s.spanDays.toFixed(1)} d / ${s.points} pts</span></div>` +
      `</div>` +
      `<div class="observe-src">${esc(s.lightCurveSource)}</div>` +
      `<div class="observe-row"><span class="k">Discovery claim</span><span class="v">false \u2014 structurally, always</span></div>` +
      `<div class="observe-memo"><div class="k">Memo that would anchor on-chain (sdr:observe:1)</div><code>${esc(o.memo)}</code></div>` +
      `<div class="observe-note">Computed live from public photometry just now. Not yet anchored \u2014 commissioning (burn 10,000 $SDR, then write the record on-chain) is a separate step. The verdict is the same the rig emits for this star for anyone else.</div>` +
    `</div>`;
}

async function runObservation() {
  const out = $("#observe-out");
  const tic = ($("#obs-tic")?.value || "").trim();
  const sector = ($("#obs-sector")?.value || "").trim();
  const dedication = $("#obs-dedication")?.value || "";
  if (!/^\d+$/.test(tic) || parseInt(tic, 10) <= 0) { observeHint("Enter a numeric TIC.", true); return; }
  const ded = observeSanitize(dedication);
  if (!ded.ok) { observeHint("Dedication: " + ded.problems.join("; "), true); return; }
  observeHint("Running the blind search on real TESS photometry...", false);
  const btn = $("#obs-run");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tic: parseInt(tic, 10), sector: sector ? parseInt(sector, 10) : null, dedication: ded.value }) });
    const o = await res.json();
    if (!res.ok || o.error) {
      observeHint((o.error || "request failed") + (o.errors && o.errors.length ? ` (${o.errors.join("; ")})` : ""), true);
      if (out) { out.hidden = true; out.innerHTML = ""; }
      return;
    }
    observeHint("", false);
    renderObserveResult(o);
  } catch (e) {
    observeHint("Network error: " + (e && e.message ? e.message : String(e)), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const obsDedEl = $("#obs-dedication");
const obsRunEl = $("#obs-run");
if (obsDedEl) obsDedEl.addEventListener("input", () => { const d = observeSanitize(obsDedEl.value); observeHint(d.ok ? "" : "Dedication: " + d.problems.join("; "), !d.ok); });
if (obsRunEl) obsRunEl.addEventListener("click", runObservation);

// Populate the "pick a verified star" dropdown from the static observe-stars.json (one-click targets that are
// confirmed to have downloadable SPOC). Selecting one fills the TIC + sector inputs. Manual entry always works
// regardless; if this fetch fails the dropdown simply stays empty.
async function loadObserveStars() {
  const sel = $("#obs-pick");
  if (!sel) return;
  try {
    const j = await fetchJSON("/observe-stars.json");
    (j.stars || []).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = `${s.tic}:${s.sector}`;
      opt.textContent = `TIC ${s.tic} (sector ${s.sector}) \u2014 ${s.name}`;
      sel.appendChild(opt);
    });
  } catch { /* optional convenience list */ }
}
if ($("#obs-pick")) $("#obs-pick").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!v) return;
  const [tic, sector] = v.split(":");
  if ($("#obs-tic")) $("#obs-tic").value = tic;
  if ($("#obs-sector")) $("#obs-sector").value = sector;
});
loadObserveStars();

// ---- commission a named observation (the paid, on-chain path) ----
// Flow, deliberately ordered so NOTHING irreversible happens on bad input: (1) sanitize client-side, (2) run the
// FREE compute first -- the server re-sanitizes + confirms usable photometry -- and abort before any burn if it
// fails, (3) only then ask the wallet to burn 10,000 $SDR, (4) hand the burn SIGNATURE to /api/observe/commission
// as an x402 X-PAYMENT; the edge re-reads the burn from the chain (never trusting us) and anchors under the
// OBSERVE_ANCHOR gate. The burn is the user's $SDR; the rig pays the one-time SOL chain fee. Verdict never changes.
// The burn helper reads the chain through OUR read-only RPC proxy, not api.mainnet-beta directly: public
// endpoints 403 browser requests carrying an unknown Origin, which web3.js v3 surfaces as the opaque
// SolanaError #8100002. The proxy forwards allowlisted reads server-side (no Origin) and never sees keys.
const OBSERVE_RPC = window.location.origin + "/api/rpc";

function b64PaymentEnvelope(sig) {
  return btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana-mainnet", payload: { signature: sig } }));
}

function renderObserveEvidence(o) {
  const el = $("#observe-evidence");
  if (!el) return;
  const status = o.anchored
    ? "ANCHORED on Solana mainnet"
    : o.dryRun
      ? "sealed (anchor previewed only - the operator gate is in dry mode)"
      : o.capReached
        ? "sealed (on-chain write deferred: the daily anchor budget was reached)"
        : "sealed (on-chain anchoring is currently paused by the operator)";
  const txLine = (o.anchored || o.alreadyAnchored) && o.signature
    ? `<a href="${esc(o.explorerUrl)}" target="_blank" rel="noopener">tx ${esc(String(o.signature).slice(0, 20))}... &middot; slot ${esc(String(o.slot ?? "?"))}</a>`
    : "(not yet on-chain)";
  el.hidden = false;
  el.innerHTML =
    `<div class="observe-ev">` +
      `<div class="observe-ev-head">${o.anchored ? "On-chain memorial" : "Record sealed"}</div>` +
      `<div class="observe-row"><span class="k">Status</span><span class="v">${esc(status)}</span></div>` +
      `<div class="observe-row"><span class="k">Memo</span><span class="v"><code>${esc(o.memo)}</code></span></div>` +
      `<div class="observe-row"><span class="k">Envelope hash</span><span class="v"><code>${esc(o.envelopeHash)}</code></span></div>` +
      `<div class="observe-row"><span class="k">Transaction</span><span class="v">${txLine}</span></div>` +
      `<div class="observe-row"><span class="k">Discovery claim</span><span class="v">false \u2014 structurally, always</span></div>` +
      `<div class="observe-ev-note">This can be re-verified from the chain without trusting us: paste the memo hash or the transaction signature into the evidence checker, or run the verifier CLI.</div>` +
    `</div>`;
}

async function commissionObservation() {
  const btn = $("#obs-commission");
  const tic = ($("#obs-tic")?.value || "").trim();
  const sector = ($("#obs-sector")?.value || "").trim();
  const dedication = $("#obs-dedication")?.value || "";
  if (!/^\d+$/.test(tic) || parseInt(tic, 10) <= 0) { observeHint("Enter a numeric TIC first.", true); return; }
  const ded = observeSanitize(dedication);
  if (!ded.ok) { observeHint("Dedication: " + ded.problems.join("; "), true); return; }

  // Gate content BEFORE any burn: a free server-side compute validates the dedication + confirms the star.
  observeHint("Validating your dedication and photometry before any burn...", false);
  let pre;
  try {
    const pres = await fetch("/api/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tic: parseInt(tic, 10), sector: sector ? parseInt(sector, 10) : null, dedication: ded.value }) });
    pre = await pres.json();
    if (!pres.ok || pre.error) { observeHint("Nothing burned. " + (pre.error || "compute failed") + (pre.errors && pre.errors.length ? ` (${pre.errors.join("; ")})` : ""), true); return; }
    renderObserveResult(pre);
  } catch (e) { observeHint("Network error before burn (nothing charged): " + ((e && e.message) ? e.message : String(e)), true); return; }

  if (btn) btn.disabled = true;
  let sig;
  try {
    observeHint("Opening your wallet to burn 10,000 $SDR...", false);
    const mod = await import("/vendor/solana-burn.js");
    const res = await mod.burnForObservation(OBSERVE_RPC);
    sig = res.signature;
    observeHint("Burn is on-chain (" + sig.slice(0, 16) + "...). Sealing your record...", false);
  } catch (e) {
    observeHint("No burn happened: " + ((e && e.message) ? e.message : String(e)), true);
    if (btn) btn.disabled = false;
    return;
  }

  try {
    const cres = await fetch("/api/observe/commission", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": b64PaymentEnvelope(sig) }, body: JSON.stringify({ tic: parseInt(tic, 10), sector: sector ? parseInt(sector, 10) : null, dedication: ded.value }) });
    const o = await cres.json();
    if (!cres.ok || o.error) {
      observeHint("Your burn is on-chain but sealing was rejected: " + (o.error || "server error") + ". Keep this tx for follow-up: " + sig.slice(0, 16) + "...", true);
      return;
    }
    observeHint(o.anchored ? "Sealed and anchored on Solana mainnet." : "Sealed; the on-chain write is gated by the operator.", !o.anchored);
    renderObserveResult(o);
    renderObserveEvidence(o);
  } catch (e) {
    observeHint("Sealing request failed after your burn (tx " + sig.slice(0, 16) + "...): " + ((e && e.message) ? e.message : String(e)), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
if ($("#obs-commission")) $("#obs-commission").addEventListener("click", commissionObservation);

// Verify a sealed observation INDEPENDENTLY: the route re-derives the envelope hash from the stored dedication +
// bundle hash (tamper-evidence) and checks the sdr:observe:1 anchor straight from the chain. A 64-hex input is
// treated as an envelope hash; anything else as a burn transaction signature.
async function verifyObservationEvidence() {
  const el = $("#observe-verify-out");
  if (!el) return;
  const q = ($("#obs-verify")?.value || "").trim();
  if (!q) { el.hidden = false; el.innerHTML = `<div class="observe-ev-bad">Enter an envelope hash or a transaction signature.</div>`; return; }
  const isHash = /^[0-9a-f]{64}$/i.test(q);
  const url = `/api/observe/evidence?${isHash ? "hash" : "sig"}=${encodeURIComponent(q)}`;
  el.hidden = false;
  el.innerHTML = `<div class="observe-ev-muted">Reading the record and checking the chain...</div>`;
  let ev;
  try {
    const res = await fetch(url);
    ev = await res.json();
    if (!res.ok) { el.innerHTML = `<div class="observe-ev-bad">${esc((ev && ev.reason) ? ev.reason : "not found")}</div>`; return; }
  } catch (e) { el.innerHTML = `<div class="observe-ev-bad">Network error: ${esc((e && e.message) ? e.message : String(e))}</div>`; return; }
  const rec = ev.record || {};
  const sci = rec.science || {};
  const v = ev.verify;
  const chainLine = !v
    ? "not anchored on-chain (sealed off-chain only)"
    : v.ok
      ? "VERIFIED on-chain - the memo hash matches"
      : v.found
        ? "found on-chain but the memo does NOT match this record"
        : "anchor transaction not found on any RPC yet";
  const integ = ev.integrityMatches
    ? "integrity OK - recomputed envelope hash matches"
    : "INTEGRITY FAIL - recomputed hash differs, do not trust this record";
  const explink = ev.explorerUrl ? ` <a href="${esc(ev.explorerUrl)}" target="_blank" rel="noopener">view transaction</a>` : "";
  const claim = rec.discoveryClaim === false ? "false" : "unexpected";
  el.innerHTML =
    `<div class="observe-ev">` +
      `<div class="observe-ev-head">Evidence - ${ev.ok ? "authentic" : "check carefully"}</div>` +
      `<div class="observe-row"><span class="k">Dedication</span><span class="v">&ldquo;${esc(String(rec.dedication ?? ""))}&rdquo;</span></div>` +
      `<div class="observe-row"><span class="k">Verdict</span><span class="v">${esc(String(sci.verdict ?? "?"))} &middot; discovery claim: ${esc(claim)}</span></div>` +
      `<div class="observe-row"><span class="k">Envelope hash</span><span class="v"><code>${esc(ev.envelopeHash ?? "")}</code></span></div>` +
      `<div class="observe-row"><span class="k">Integrity</span><span class="v">${esc(integ)}</span></div>` +
      `<div class="observe-row"><span class="k">On-chain</span><span class="v">${esc(chainLine)}${explink}</span></div>` +
    `</div>`;
}
if ($("#obs-verify-btn")) $("#obs-verify-btn").addEventListener("click", verifyObservationEvidence);

// Pull the on-demand thread (with the live DeepSeek/Grok cross-examination) for one finding
// and re-render the transcript with it. Best-effort: if the model is slow or absent, the
// grounded seed already shown simply stays. Never throws into the boot path.
async function enrichThread(findingId) {
  if (!findingId) return;
  try {
    const t = await fetchJSON(`/api/discussion/${encodeURIComponent(findingId)}`);
    if (t && Array.isArray(t.turns) && t.turns.length) renderThread(t.turns);
    // Seal the debate and surface the integrity receipt (no-op when the thread is grounded).
    renderDeliberationReceipt(findingId, t.deliberationHash, (t.models || []).length ? t.models : deriveModels(t.turns));
  } catch { /* keep the grounded seed */ }
}

// The response has no top-level models array; derive the reviewer names from the turns.
function deriveModels(turns) {
  const out = [];
  for (const t of turns || []) if (t.model && !out.includes(t.model)) out.push(t.model);
  return out;
}

function setRunningUI(running, msg) {
  // Only the SUBMIT button reflects run state. The top-right "Launch run" (#run-btn) is a pure
  // NAVIGATION control -- it just reveals the Findings view + form -- so it must NEVER be disabled,
  // otherwise an active OR zombie (stuck running=true) run greys it out and it looks dead. Actual
  // double-run safety stays server-side: /api/run returns 409 while a run is active (30-min stale takeover).
  runSubmitEl.disabled = running;
  runSubmitEl.textContent = running ? "Deliberating..." : "Run pipeline";
  if (msg != null) runStatusEl.textContent = msg;
}

function applyRunState(activeRun) {
  const running = Boolean(activeRun?.running);
  if (running) {
    setRunningUI(true, `live ${activeRun.runId}`);
  } else if (lastRunning && !running) {
    const sum = activeRun?.summary;
    const msg = activeRun?.error ? `failed: ${activeRun.error}` : sum ? `done: ${sum.accepted} confirmed, ${sum.review} watch, ${sum.rejected} rejected` : "idle";
    setRunningUI(false, msg);
    if (sum) chairSays(`Round closed: ${sum.accepted} confirmed, ${sum.review} watchlist, ${sum.rejected} rejected, ${sum.bundles} bundles ready to anchor.`);
    else if (activeRun?.error) chairSays(`The round was interrupted: ${activeRun.error}`);
    fetchJSON("/api/state").then((s) => { applyState(s); MissionRoom.setAgents(s.seats); }).catch(() => {});
    loadLedger();
  } else if (!running) {
    setRunningUI(false, activeRun?.error ? "last run failed" : "idle");
  }
  lastRunning = running;
}

// ---- live events -----------------------------------------------------------
function openSSE() {
  // connectLive exposes the same addEventListener/onerror surface as EventSource, so
  // the feed logic below is transport-agnostic (SSE on Node, WebSocket on the edge).
  const es = connectLive("/api/events");
  es.addEventListener("hello", () => setConn("live"));
  es.addEventListener("ping", () => setConn("live"));
  es.addEventListener("log", (e) => {
    setConn("live");
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (!ev.seat) return;
    addRow({ seat: ev.seat, ts: ev.ts, tone: toneForLevel(ev.level), text: ev.message });
    takeFloor(ev.seat, ev.message);
    if (ev.level === "result" || ev.level === "error" || (ev.seat === "reporter" && /anchor|seal|complete/i.test(ev.message || ""))) {
      addFeedItem({ key: "live-" + ev.ts, ts: ev.ts, kind: ev.level === "error" ? "bad" : "run", text: ev.message });
    }
    if (ev.seat === "reporter" && ev.level === "result" && ev.data?.findingId) {
      fetchJSON(`/api/findings/${encodeURIComponent(ev.data.findingId)}`)
        .then((f) => {
          if (!f) return;
          upsertFinding(f);
          setTarget(f.targetId);
          const word = (BADGE[f.verdict] || BADGE.rejected).word;
          chairSays(`Verdict recorded for ${f.targetId}: ${word.toUpperCase()}.`);
        })
        .catch(() => {});
    }
  });
  es.addEventListener("state", (e) => {
    let s;
    try { s = JSON.parse(e.data); } catch { return; }
    renderStats(s.stats);
    if (s.seats) MissionRoom.setAgents(s.seats);
    applyRunState(s.activeRun);
    renderProvBar(s.activeRun?.summary);
    if (currentView() === "survey") renderSurveyTimeline();
    else if (currentView() === "gallery") renderGalleryPlots();
  });
  es.onerror = () => setConn("down");
}

// ---- interactions ----------------------------------------------------------
$("#run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    targets: Number($("#in-targets").value) || 4,
    delay: Number($("#in-delay").value) || 0,
    confidence: Number($("#in-confidence").value) || 8,
    offline: $("#in-offline").checked,
    resume: $("#in-resume").checked,
  };
  setRunningUI(true, "starting...");
  try {
    const r = await adminFetch("/api/run", { method: "POST", body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) { setRunningUI(false, j.error || "failed to start"); return; }
    lastRunning = true;
    setRunningUI(true, `live ${j.runId}`);
  } catch (err) { setRunningUI(false, `error: ${err.message}`); }
});

// The MISSION CONTROL form (#run-form) lives in the Findings view, which is display:none on the default
// landing view -- so an earlier handler that only did scrollIntoView/focus on the hidden form was a no-op
// and the top-right "Launch run" looked dead. Navigate to #/findings first (letting the router reveal it),
// then bring the form into view + focus submit AFTER the router's showView has run (it scrolls to top).
runBtnEl.addEventListener("click", () => {
  const focusForm = () => { const f = $("#run-form"); if (f) f.scrollIntoView({ behavior: "smooth", block: "center" }); if (runSubmitEl) runSubmitEl.focus(); };
  if (currentView() === "findings") { focusForm(); return; }
  location.hash = "#/findings"; // fires the hashchange router -> showView("findings")
  setTimeout(focusForm, 80);     // run after showView so its window.scrollTo(0,0) does not cancel the scroll
});
boardMoreEl.addEventListener("click", () => { boardExpanded = !boardExpanded; renderBoard(); });
if (boardFilterEl) for (const chip of boardFilterEl.querySelectorAll("[data-filter]")) {
  chip.addEventListener("click", () => { boardFilter = chip.dataset.filter; boardExpanded = false; renderBoard(); });
}
$("#ledger-refresh").addEventListener("click", loadLedger);

boardEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card?.dataset.id;
  if (!id) return;
  const status = card.querySelector("[data-status]");
  const action = btn.dataset.action;

  if (action === "plots") {
    const plots = card.querySelector("[data-plots]");
    const willOpen = !plots.classList.contains("open");
    plots.classList.toggle("open", willOpen);
    if (willOpen && !plots.dataset.loaded) {
      plots.innerHTML = plotsHtml(id);
      plots.dataset.loaded = "1";
    }
    return;
  }

  if (action === "verify") {
    status.className = "verify-out"; status.textContent = "verifying...";
    try {
      const v = await fetchJSON(`/api/bundles/${encodeURIComponent(id)}/verify`);
      if (v.ok) { status.className = "verify-out ok"; status.textContent = "hash matches, artifacts intact"; }
      else {
        status.className = "verify-out bad";
        const why = v.error || (v.hashMatches ? "" : "hash mismatch ") || (v.missing?.length ? `missing ${v.missing.join(",")}` : "") || (v.mismatched?.length ? `changed ${v.mismatched.join(",")}` : "failed");
        status.textContent = `verify failed: ${why}`;
      }
    } catch (err) { status.className = "verify-out bad"; status.textContent = `verify error: ${err.message}`; }
    return;
  }

  if (action === "anchor") {
    // Mainnet anchoring spends real SOL from the project wallet; make it a deliberate act.
    // (Repeat anchors of the same bundle hash are idempotent and free, handled server-side.)
    if (!window.confirm("Anchor writes a real Solana MAINNET memo transaction and spends project SOL. Continue?")) return;
    btn.disabled = true; status.className = "verify-out"; status.textContent = "anchoring on mainnet...";
    try {
      const r = await adminFetch(`/api/anchor/${encodeURIComponent(id)}`, { method: "POST", body: "{}" });
      const res = await r.json();
      if (res.ok && res.deduplicated) {
        // audit-4: identical science was already anchored under another finding, so the rig correctly spent
        // NOTHING. That is a SUCCESS (a fee saved), not a failure -- the old code fell through to "anchor
        // failed" because a dedup response carries no signature of its own. We deliberately do NOT stamp the
        // foreign tx onto THIS card (its memo commits a different bundleHash, so stamping it would present an
        // unverifiable proof); we only point at the existing anchor and say why no new tx was made.
        const of = res.dedupOf || {};
        status.className = "verify-out ok";
        status.innerHTML =
          `no new tx &mdash; identical science already anchored as <b>${esc(of.findingId || "another finding")}</b>` +
          (of.signature ? ` (<a class="txlink" href="${esc(explorerUrl(of.signature))}" target="_blank" rel="noopener">${esc(shortTx(of.signature))}</a>)` : "");
        btn.textContent = "Deduplicated";
        await loadLedger();
      } else if (res.ok && res.signature) {
        status.className = "verify-out ok";
        status.innerHTML = `${res.alreadyAnchored ? "already anchored (receipt) " : "anchored "}<a class="txlink" href="${esc(explorerUrl(res.signature))}" target="_blank" rel="noopener">${esc(shortTx(res.signature))}</a>`;
        if (!res.alreadyAnchored) btn.textContent = "Re-anchor";
        const chain = card.querySelector(".prov")?.children[1];
        if (chain) chain.innerHTML = `<b>tx</b> <a class="txlink" href="${esc(explorerUrl(res.signature))}" target="_blank" rel="noopener">${esc(shortTx(res.signature))}</a>`;
        await loadLedger();
        fetchJSON("/api/state").then((s) => renderStats(s.stats)).catch(() => {});
      } else {
        status.className = "verify-out bad";
        status.textContent = res.error ? `failed: ${res.error.slice(0, 120)}` : "anchor failed";
      }
    } catch (err) { status.className = "verify-out bad"; status.textContent = `error: ${err.message}`; }
    finally { btn.disabled = false; }
  }
});

// ---- live science output feed (item 1) -------------------------------------
const feedListEl = $("#feed-list");
const feedTickerEl = $("#feed-ticker");
const feedStatusEl = $("#feed-status-text");
const feedSeen = new Set();

function fmtAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function addFeedItem({ key, ts, kind, text, href }) {
  if (!feedListEl) return;
  const id = key || (ts + "|" + text);
  if (feedSeen.has(id)) return;
  feedSeen.add(id);
  const row = document.createElement("div");
  row.className = "feed-row feed-" + (kind || "info");
  const time = ts ? `<span class="feed-time">${esc(fmtAgo(ts))}</span>` : "";
  const body = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
  row.innerHTML = `<span class="feed-dot"></span>${time}<span class="feed-text">${body}</span>`;
  feedListEl.prepend(row);
  while (feedListEl.childElementCount > 60) feedListEl.removeChild(feedListEl.lastElementChild);
}
function renderFeedTicker(research, stats) {
  if (!feedTickerEl) return;
  const chips = [];
  if (research && research.survey) {
    const s = research.survey;
    chips.push(["real stars surveyed", s.stars]);
    if (s.purity != null) chips.push(["blind purity", Math.round(s.purity * 100) + "%"]);
    const c = s.completeness || [];
    const at4000 = c.find((x) => x.depthPpm === 4000) || c[c.length - 1];
    if (at4000) chips.push(["completeness @4000ppm", Math.round(at4000.rate * 100) + "%"]);
  }
  if (research && research.crossValidation) {
    const cv = research.crossValidation;
    if (cv.pdm && cv.pdm.agreement.rate != null) chips.push(["PDM agreement", Math.round(cv.pdm.agreement.rate * 100) + "%"]);
    if (cv.python && cv.python.purity != null) chips.push(["independent-stack purity", Math.round(cv.python.purity * 100) + "%"]);
  }
  if (stats) {
    chips.push(["targets analyzed", stats.tasksDone ?? 0]);
    chips.push(["results sealed on-chain", stats.bundlesAnchored ?? 0]);
  }
  feedTickerEl.innerHTML = chips.map(([k, v]) => `<span class="ticker-chip"><b>${esc(String(v))}</b> ${esc(k)}</span>`).join("");
}

// next autonomous survey boundary: the edge cron runs every 15 minutes
function nextSurveyIn() {
  const now = new Date();
  const secInto = (now.getMinutes() % 15) * 60 + now.getSeconds();
  return Math.max(1, Math.ceil((15 * 60 - secInto) / 60));
}
function startFeedPulse() {
  const tick = () => {
    const m = nextSurveyIn();
    if (feedStatusEl) feedStatusEl.textContent = m <= 0 ? "autonomous survey starting now" : `autonomous survey: next run in ~${m}m`;
  };
  tick();
  setInterval(tick, 30000);
}

// ---- research results dashboard (item 4) -----------------------------------
let researchData = null;
function pct(x) { return x == null ? "n/a" : (x * 100).toFixed(1) + "%"; }
async function loadResearch() {
  try {
    const r = await fetchJSON("/research.json");
    researchData = r;
    renderResearch(r);
    renderFeedTicker(r, null);
    seedResearchFeed(r);
  } catch { const b = $("#research-body"); if (b) b.innerHTML = `<p class="empty">Research bundle unavailable.</p>`; }
}
function renderResearch(r) {
  const el = $("#research-body");
  if (!el) return;
  const s = r.survey, cv = r.crossValidation, cm = r.compute, fpc = r.falsePositiveControl, bt = r.blindTest, fu = r.followupStudiesP67P71;
  const depths = s.depthsPpm || [];
  const rows = depths.map((d, i) => {
    const ts = s.completeness[i], pdm = cv.pdm.completeness[i], py = cv.python.completeness[i];
    return `<tr><td>${d} ppm</td><td>${ts ? pct(ts.rate) : "-"}</td><td>${pdm ? pct(pdm.rate) : "-"}</td><td>${py ? pct(py.rate) : "-"}</td></tr>`;
  }).join("");
  const cpu = (cm.cpuHours || []).map((row) => {
    const two = (row.bySectors || []).find((b) => b.sectors === 2);
    return `<tr><td>${row.stars.toLocaleString()} stars</td><td>${two ? two.cpuHours.toFixed(1) : "-"} CPU-h</td></tr>`;
  }).join("");
  const de = r.detectionEfficiency;
  const deRows = de ? (de.thresholdDepth50 || []).map((t) => {
    const pMid = ((t.periodLo + t.periodHi) / 2).toFixed(1);
    return `<tr><td>${pMid} d</td><td>${t.depthPpm == null ? "not reached" : t.depthPpm + " ppm"}</td></tr>`;
  }).join("") : "";
  el.innerHTML =
    `<figure class="research-figure"><img loading="lazy" src="/results-figure.svg" alt="Completeness vs depth for three independent estimators, and blind purity as true/false positive counts." /></figure>` +
    `<div class="research-grid">` +
      `<div class="research-card"><h3>Search operating point</h3>` +
        `<div class="rc-metric"><span class="k">real host stars</span><span class="v">${s.stars}</span></div>` +
        `<div class="rc-metric"><span class="k">blind purity (lower bound)</span><span class="v">${pct(s.purity)}</span></div>` +
        `<div class="rc-metric"><span class="k">TP / FP on real curves</span><span class="v">${s.nullTP} / ${s.nullFP}</span></div>` +
        (bt ? `<div class="rc-metric"><span class="k">sealed-key blind test</span><span class="v">recall ${pct(bt.recall)} &middot; precision ${pct(bt.precision)} &middot; false-accepts ${bt.falseAcceptsUnderBar}</span></div>` : ``) +
        `<p class="rc-note">Iterative box-fit BLS under the production gate, on real TESS-SPOC photometry (seed ${s.seed}, injected P=${s.injPeriodDays} d).</p></div>` +
      `<div class="research-card"><h3>Independent cross-checks</h3>` +
        `<div class="rc-metric"><span class="k">PDM period agreement</span><span class="v">${cv.pdm.agreement.agree}/${cv.pdm.agreement.comparable} (${pct(cv.pdm.agreement.rate)})</span></div>` +
        `<div class="rc-metric"><span class="k">Python-stack purity</span><span class="v">${pct(cv.python.purity)} (${cv.python.nullTP}/${cv.python.nullFP})</span></div>` +
        (r.replayDeterminism ? `<div class="rc-metric"><span class="k">deterministic replay</span><span class="v">${r.replayDeterminism.allDeterministic ? "reproducible" : "not reproducible"} &middot; hash ${esc(String(r.replayDeterminism.replayHash).slice(0, 12))}...</span></div>` : ``) +
        (r.blendVetoAcceptance ? `<div class="rc-metric"><span class="k">crowded-field veto check</span><span class="v">${r.blendVetoAcceptance.nCrowded}/${r.blendVetoAcceptance.nTotal} crowded &middot; ${r.blendVetoAcceptance.falseKills} false-kills &middot; not a gate</span></div>` : ``) +
        (r.negativeClassFeasibility ? `<div class="rc-metric"><span class="k">true-veto negative class</span><span class="v">${r.negativeClassFeasibility.usableNegatives} real blends from public data &middot; ${r.negativeClassFeasibility.constructible ? "buildable" : "blocked on access"}</span></div>` : ``) +
        `<p class="rc-note">A different algorithm (PDM) and a different codebase (wotan + astropy BLS) re-analyze the same real data; agreement corroborates, disagreement is explained.</p></div>` +
      `<div class="research-card"><h3>Measured compute cost</h3>` +
        `<div class="rc-metric"><span class="k">scaling exponent</span><span class="v">~${cm.exponentP.toFixed(2)} (R&sup2; ${cm.r2.toFixed(2)})</span></div>` +
        `<div class="rc-metric"><span class="k">per-star detection</span><span class="v">${cm.singleStarDetectionSeconds.toFixed(1)} s</span></div>` +
        `<table class="rc-table"><thead><tr><th>survey</th><th>2 sectors</th></tr></thead><tbody>${cpu}</tbody></table></div>` +
      (fpc && fpc.coherentNull ? `<div class="research-card"><h3>False-positive control</h3>` +
        `<div class="rc-metric"><span class="k">coherent-null FP (raw)</span><span class="v">${pct(fpc.coherentNull.rawFpRateByGate.snr)} &rarr; ${pct(fpc.coherentNull.rawFpRateByGate.sysFap)}</span></div>` +
        `<div class="rc-metric"><span class="k">measure-before-gate safety</span><span class="v">${fpc.safetyCert.declined}/${fpc.safetyCert.detected} declined (${esc(fpc.safetyCert.verdict)})</span></div>` +
        `<div class="rc-metric"><span class="k">multi-sector AUC (noise / sys)</span><span class="v">${fpc.scaleMultiSector.aucNoise.toFixed(2)} / ${fpc.scaleMultiSector.aucSys.toFixed(2)}</span></div>` +
        `<div class="rc-metric"><span class="k">1 c/d window power (median)</span><span class="v">${fpc.windowAlias.dailyWindowMedian}</span></div>` +
                (fpc.pixelVetting ? `<div class="rc-metric"><span class="k">pixel veto (difference imaging)</span><span class="v">${fpc.pixelVetting.diffImageOffsetMedianArcsec.toFixed(1)}" median &middot; ${fpc.pixelVetting.safeToGate ? "safe to gate" : "not safe to gate"}</span></div>` : ``) +
        (fpc.blendProbability ? `<div class="rc-metric"><span class="k">blended-EB P(FP) on real planets</span><span class="v">median ${fpc.blendProbability.pfpMedian.toFixed(2)} &middot; ${fpc.blendProbability.realPlanetsAboveHalf}/${fpc.blendProbability.confirmedPlanets} flagged &middot; ranks, not gates</span></div>` : ``) +
        (fpc.coherenceSelector ? `<div class="rc-metric"><span class="k">O-C coherence period selector</span><span class="v">${fpc.coherenceSelector.coherenceRankMatchCount}/${fpc.coherenceSelector.hosts} vs raw ${fpc.coherenceSelector.rawMatchCount}/${fpc.coherenceSelector.hosts} &middot; no selection gain</span></div>` : ``) +
        (fpc.psfDoubleDifference ? `<div class="rc-metric"><span class="k">PSF double-difference veto</span><span class="v">${fpc.psfDoubleDifference.psfFalseKillsAt2Arcsec}/${fpc.psfDoubleDifference.confirmedPlanets} false-kills (naive ${fpc.psfDoubleDifference.naiveFalseKillsAt2Arcsec}) &middot; ${fpc.psfDoubleDifference.safeToGate ? "safe to gate" : "much safer than naive, not a gate yet"}</span></div>` : ``) +
        (r.trueVetoAcceptance ? `<div class="rc-metric"><span class="k">true-veto 2x2 (labelled blends)</span><span class="v">PSF false-killed ${r.trueVetoAcceptance.psfVeto.cm.falseVeto}/${r.trueVetoAcceptance.usablePositives} known planet; caught ${r.trueVetoAcceptance.addressable.caught}/${r.trueVetoAcceptance.addressable.negatives} catchable blends (AUC ${r.trueVetoAcceptance.addressable.auc.toFixed(2)}) &middot; not a gate</span></div>` : ``) +
                (r.llmHypothesisLoop ? `<div class="rc-metric"><span class="k">LLM hypothesis loop (2x2)</span><span class="v">${r.llmHypothesisLoop.tests.length} model-chosen tests on ${r.llmHypothesisLoop.nPositives} planets + ${r.llmHypothesisLoop.nNegatives} labelled blends &middot; gateable via loop: ${r.llmHypothesisLoop.gateableViaLoop ? "yes" : "none"} &middot; not a gate</span></div>` : ``) +
        (r.jointPhaseAlignmentP62 ? `<div class="rc-metric"><span class="k">phase-aligned joint fold (P62)</span><span class="v">single ${r.jointPhaseAlignmentP62.single} / naive ${r.jointPhaseAlignmentP62.naive} / refined ${r.jointPhaseAlignmentP62.refined} / oracle ${r.jointPhaseAlignmentP62.oracle} of ${r.jointPhaseAlignmentP62.n} &middot; bottleneck ${r.jointPhaseAlignmentP62.bottleneck} &middot; joint is no free lunch</span></div>` : ``) +
        (r.softBlendScoreP63 ? `<div class="rc-metric"><span class="k">soft blend score (advisory)</span><span class="v">at ${(r.softBlendScoreP63.atThreshold * 100).toFixed(0)} flags ${pct(r.softBlendScoreP63.falseVetoRate)} of known planets, catches ${pct(r.softBlendScoreP63.blendCatchRate)} of blends &middot; a score, not a gate</span></div>` : ``) +
        (r.fetchTelemetryP64 ? `<div class="rc-metric"><span class="k">multi-sector fetch cache (P64)</span><span class="v">warm hit ${pct(r.fetchTelemetryP64.warmHitRate)} (${r.fetchTelemetryP64.warmWallMs}ms vs ${r.fetchTelemetryP64.coldWallMs}ms cold) &middot; download is the bottleneck</span></div>` : ``) +
        (r.externalAuditP65 ? `<div class="rc-metric"><span class="k">external audit entry (P65)</span><span class="v">${r.externalAuditP65.passes}/${r.externalAuditP65.nClaims} third-party claims pass the accepted-only gate &middot; research mode, not anchored</span></div>` : ``) +
        (fu ? `<div class="rc-metric"><span class="k">review follow-ups (P67-P71)</span><span class="v">seed naive ${fu.seedP67.naivePeak}/iter ${fu.seedP67.iterTopK} of ${fu.seedP67.n} &middot; best veto AUC ${fu.rocP68.bestAuc ? fu.rocP68.bestAuc.toFixed(2) : "?"} (${fu.rocP68.anyGateable ? "gate?" : "no gate"}) &middot; AR(1) null permissive ${fu.redNoiseP69.flipsNoise}/${fu.redNoiseP69.noiseLike} &middot; LLM changed ${fu.llmP70.decisionsChangedByLLM} decisions &middot; accept path reachable ${fu.acceptPathP71.blindAccepted}->${fu.acceptPathP71.corroborationAccepted}/${fu.acceptPathP71.n}</span></div>` : ``) +
        `<p class="rc-note">A coherent-systematics null cuts raw FP ${pct(fpc.coherentNull.rawFpRateByGate.snr)}&rarr;${pct(fpc.coherentNull.rawFpRateByGate.sysFap)}; after common-mode subtraction it stays a zero-cost safety net (AUC gain ~0, ${esc(fpc.scaleMultiSector.injectedKeptCount)} planets kept). Window aliasing is closed on TESS (median ${fpc.windowAlias.dailyWindowMedian}). A naive difference-image centroid mislocalizes confirmed planets (median ${fpc.pixelVetting ? fpc.pixelVetting.diffImageOffsetMedianArcsec.toFixed(0) : "?}"}, ${fpc.pixelVetting ? fpc.pixelVetting.falseKillsAt2Arcsec : "?"} false-kills) so it is not safe to gate; the full-aperture centroid shift (<= ${fpc.pixelVetting ? fpc.pixelVetting.centroidShiftMaxArcsec.toFixed(1) : "0.6"}") remains the robust pixel veto.</p></div>` : ``) +
      (r.borrowedRoundP73P76 ? `<div class="research-card"><h3>Borrowed from a real survey (P73-P76)</h3>` +
        `<div class="rc-metric"><span class="k">sibling masking re-find</span><span class="v">${r.borrowedRoundP73P76.maskedRecoveryP73.naiveJoint}&rarr;${r.borrowedRoundP73P76.maskedRecoveryP73.maskJoint}/${r.borrowedRoundP73P76.maskedRecoveryP73.n} (oracle ${r.borrowedRoundP73P76.maskedRecoveryP73.oracle}) &middot; ${esc(r.borrowedRoundP73P76.maskedRecoveryP73.verdict)}</span></div>` +
                `<div class="rc-metric"><span class="k">centroid coherence (our variant)</span><span class="v">known-planet false-kills ${r.borrowedRoundP73P76.centroidCoherenceP74.singleFalseKills}&rarr;${r.borrowedRoundP73P76.centroidCoherenceP74.multiFalseKills}, blend power ${pct(r.borrowedRoundP73P76.centroidCoherenceP74.singlePower)}&rarr;${pct(r.borrowedRoundP73P76.centroidCoherenceP74.multiPower)} &middot; not their F-test, not a gate</span></div>` +
        `<div class="rc-metric"><span class="k">inverted-curve FP null</span><span class="v">AR(1) flags ${r.borrowedRoundP73P76.invertedFapP75.ar1Fp}/${r.borrowedRoundP73P76.invertedFapP75.n} noise vs model-free ${r.borrowedRoundP73P76.invertedFapP75.blockFp}/${r.borrowedRoundP73P76.invertedFapP75.n} &middot; ${esc(r.borrowedRoundP73P76.invertedFapP75.verdict)}</span></div>` +
        `<div class="rc-metric"><span class="k">multi-source novelty (+ExoFOP)</span><span class="v">novel ${r.borrowedRoundP73P76.multiSourceNoveltyP76.novelArchive}&rarr;${r.borrowedRoundP73P76.multiSourceNoveltyP76.novelUnion}/${r.borrowedRoundP73P76.multiSourceNoveltyP76.n} after CTOIs (shrink ${r.borrowedRoundP73P76.multiSourceNoveltyP76.shrink})</span></div>` +
        `<p class="rc-note">Four levers from the public eumemic/exoplanets TESS pipeline, re-measured on our chain with positive controls (P74 is our directional-coherence variant, not their per-contaminant F-test -- a faithful re-port is follow-up work). None clears a gate; all stay advisory. discoveryClaim false.</p></div>` : ``) +
      (r.audit9P78P81 ? `<div class="research-card"><h3>Audit-9: benchmark, blind test, external validation (P78-P81)</h3>` +
        `<div class="rc-metric"><span class="k">TCE / DAVE / TPM benchmark</span><span class="v">completeness when TCE accepts ${pct(r.audit9P78P81.benchmarkP79.tceAcceptCompleteness)} vs rejects ${pct(r.audit9P78P81.benchmarkP79.tceRejectCompleteness)} &middot; we track the BLS/TCE limit</span></div>` +
        `<div class="rc-metric"><span class="k">real multi-sector blind test</span><span class="v">${r.audit9P78P81.blindP78.hosts} real hosts &middot; 2-sector bar: recall ${r.audit9P78P81.blindP78.acceptedRecallUnderBar}/${r.audit9P78P81.blindP78.injected}, ${r.audit9P78P81.blindP78.falseAcceptsUnderBar} false-accepts, precision ${pct(r.audit9P78P81.blindP78.acceptedPrecisionUnderBar)}</span></div>` +
        `<div class="rc-metric"><span class="k">independent external validation</span><span class="v">ExoFOP claims matched by a blind (ephemeris never fed) detection: KP controls ${r.audit9P78P81.externalValidationP80.kpValidated}/${r.audit9P78P81.externalValidationP80.kpTested}, CP uncertain candidates ${r.audit9P78P81.externalValidationP80.cpValidated}/${r.audit9P78P81.externalValidationP80.cpTested} &middot; 0/2 moved off zero</span></div>` +
        `<div class="rc-metric"><span class="k">TRICERATOPS-grade check</span><span class="v">Gaia blend FPP + harmonic alias + multi-sector centroid F-test: strict bar met by ${r.audit9P78P81.triceratopsLiteP81.kpTricGrade}/${r.audit9P78P81.triceratopsLiteP81.kpValidated} known planets vs ${r.audit9P78P81.triceratopsLiteP81.cpTricGrade}/${r.audit9P78P81.triceratopsLiteP81.cpValidated} unconfirmed candidates &middot; ${r.audit9P78P81.triceratopsLiteP81.cpLowOrModerate}/${r.audit9P78P81.triceratopsLiteP81.cpValidated} CP low/moderate alias</span></div>` +
        `<p class="rc-note">The three things an external audit said were missing for scientific meaning, now measured on real data. These are first-order checks and positive controls, not discoveries; nothing gated or claimed. discoveryClaim false, safeToGate false.</p></div>` : ``) +
    `</div>` +
    `<h3 class="research-sub">Completeness vs injected depth (three independent estimators)</h3>` +
    `<table class="research-table"><thead><tr><th>depth</th><th>TypeScript BLS</th><th>PDM</th><th>Python astropy BLS</th></tr></thead><tbody>${rows}</tbody></table>` +
    (de ? `<h3 class="research-sub">Detection efficiency: 50%-completeness depth vs period (2-D grid, real curves)</h3>` +
      `<table class="research-table"><thead><tr><th>period</th><th>depth for 50% recovery</th></tr></thead><tbody>${deRows}</tbody></table>` +
      `<p class="rc-note">${de.totalInjections} injected transits across ${de.nHosts} real TESS-SPOC light curves; each grid cell carries a Wilson 95% interval. Hosts are bright and planet-bearing, so this is detector efficiency on real photometry, not an unbiased survey selection. Longer periods need deeper transits; ${de.periodBinsReaching50}/${(de.thresholdDepth50 || []).length} period bins reach 50% within a single-sector baseline.</p>` : ``) +
    `<p class="research-note">${esc(r.note)}</p>`;
}
function seedResearchFeed(r) {
  const s = r.survey;
  addFeedItem({ key: "res-purity", kind: "research", text: `Blind purity measured at ${pct(s.purity)} (${s.nullTP} true / ${s.nullFP} false) on ${s.stars} real stars - a lower bound.` });
  const at4000 = (s.completeness || []).find((x) => x.depthPpm === 4000);
  if (at4000) addFeedItem({ key: "res-comp", kind: "research", text: `Completeness ${pct(at4000.rate)} at 4000 ppm injected on real TESS noise.` });
  const cv = r.crossValidation;
  addFeedItem({ key: "res-pdm", kind: "research", text: `Independent PDM agrees with the detector on ${cv.pdm.agreement.agree}/${cv.pdm.agreement.comparable} real curves.` });
  addFeedItem({ key: "res-py", kind: "research", text: `A separate Python stack (wotan + astropy BLS) reproduces purity ${pct(cv.python.purity)} on ${cv.python.curves} shared curves.` });
  const fpc = r.falsePositiveControl;
  if (fpc && fpc.coherentNull) addFeedItem({ key: "res-fp", kind: "research", text: `A coherent-systematics null cuts raw false positives ${pct(fpc.coherentNull.rawFpRateByGate.snr)} to ${pct(fpc.coherentNull.rawFpRateByGate.sysFap)} on ${fpc.coherentNull.curves} real curves, and is certified to decline ${fpc.safetyCert.declined} of ${fpc.safetyCert.detected} real planets.` });
}

// ---- build the initial feed from persisted state (so the page is never empty) ----
async function buildInitialFeed() {
  try {
    const s = await fetchJSON("/api/state");
    renderFeedTicker(researchData, s.stats);
    const events = (s.events || []).slice(-40).reverse();
    for (const ev of events) {
      if (ev.level === "result" || ev.level === "error" || (ev.seat === "reporter" && /anchor|run|seal/i.test(ev.message || ""))) {
        addFeedItem({ key: "ev-" + ev.ts + "-" + ev.message, ts: ev.ts, kind: ev.level === "error" ? "bad" : "run", text: ev.message });
      }
    }
    const led = await fetchJSON("/api/ledger").catch(() => ({ ledger: [] }));
    for (const e of (led.ledger || []).slice(0, 20)) {
      if (e.signature) addFeedItem({ key: "led-" + e.signature, ts: e.anchoredAt, kind: "chain", text: `Sealed on-chain: ${e.findingId}`, href: e.explorerUrl || explorerUrl(e.signature) });
    }
  } catch { /* the live feed still fills from SSE/WS events */ }
}
function wireLiveExtras() {
  loadResearch();
  buildInitialFeed();
  startFeedPulse();
}

// ---- research report library (view: reports) --------------------------------
// Lazy-loads web/reports/index.json (built by scripts/p86-report-library.ts from the committed
// reports/*.md), then fetches ONE rendered fragment per click. Static assets only -- no worker/DO
// code and no new API route. The fragments are generated by our own build script and HTML-escaped
// there (see scripts/report-md.ts), so injecting them into the detail pane is safe.
const reportsListEl = $("#reports-list");
const reportsDetailEl = $("#reports-detail");
let reportsIndex = null;
let reportsLoading = false;
async function ensureReports() {
  if (reportsIndex || reportsLoading) return;
  reportsLoading = true;
  try {
    const idx = await fetchJSON("/reports/index.json");
    reportsIndex = idx;
    renderReportsList(idx.reports || []);
  } catch {
    if (reportsListEl) reportsListEl.innerHTML = `<p class="empty">Report index unavailable.</p>`;
  } finally {
    reportsLoading = false;
  }
}
function renderReportsList(reports) {
  if (!reportsListEl) return;
  if (!reports.length) { reportsListEl.innerHTML = `<p class="empty">No reports yet.</p>`; return; }
  reportsListEl.innerHTML = reports.map((r) =>
    `<button class="report-item" type="button" data-slug="${esc(r.slug)}">` +
      `<span class="ri-title">${esc(r.title)}</span>` +
      (r.fresh === false ? `<span class="ri-stale" title="numbers may predate a change to their inputs; re-run before quoting">possibly out of date</span>` : "") +
      (r.summary ? `<span class="ri-sum">${esc(r.summary)}</span>` : "") +
    `</button>`).join("");
}
async function openReport(slug) {
  if (!reportsDetailEl || !slug) return;
  reportsDetailEl.innerHTML = `<p class="empty">Loading&hellip;</p>`;
  try {
    const r = await fetch(`/reports/${encodeURIComponent(slug)}.html`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    reportsDetailEl.innerHTML = `<div class="report-body md">${await r.text()}</div>`;
    reportsDetailEl.scrollTop = 0;
  } catch (e) {
    reportsDetailEl.innerHTML = `<p class="empty">Could not load that report (${esc(e.message)}).</p>`;
  }
}
if (reportsListEl) reportsListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".report-item");
  if (!btn) return;
  for (const el of reportsListEl.querySelectorAll(".report-item")) el.classList.toggle("active", el === btn);
  openReport(btn.dataset.slug);
});

// ---- figure gallery (view: gallery) -----------------------------------------
// Lazy-loads web/figures.json (built by scripts/p87-figures-manifest.ts from the committed web/*.svg)
// and adds a strip of the newest findings' own three plots (served from R2 via /api/bundles/:id/artifact).
const galleryGridEl = $("#gallery-grid");
const galleryPlotsEl = $("#gallery-plots");
let galleryLoaded = false;
async function ensureGallery() {
  if (!galleryLoaded) {
    galleryLoaded = true;
    try {
      const fig = await fetchJSON("/figures.json");
      renderGallery(fig.figures || []);
    } catch {
      if (galleryGridEl) galleryGridEl.innerHTML = `<p class="empty">Figure manifest unavailable.</p>`;
    }
  }
  renderGalleryPlots();
}
function renderGallery(figures) {
  if (!galleryGridEl) return;
  if (!figures.length) { galleryGridEl.innerHTML = `<p class="empty">No figures yet.</p>`; return; }
  galleryGridEl.innerHTML = figures.map((f) =>
    `<figure class="figure-card">` +
      `<a href="/${esc(f.src)}" target="_blank" rel="noopener"><img loading="lazy" src="/${esc(f.src)}" alt="${esc(f.title)}" /></a>` +
      `<figcaption><b>${esc(f.title)}</b>${f.caption ? `<span>${esc(f.caption)}</span>` : ""}</figcaption>` +
    `</figure>`).join("");
}
function renderGalleryPlots() {
  if (!galleryPlotsEl) return;
  const latest = sortedFindings().slice(0, 3);
  if (!latest.length) { galleryPlotsEl.innerHTML = `<p class="empty">No findings yet.</p>`; return; }
  galleryPlotsEl.innerHTML = latest.map((f) => {
    const pill = ORIGIN_PILL[originOf(f)];
    return `<div class="gallery-finding"><div class="gf-head">${esc(f.targetId)} <span class="origin-pill ${pill.cls}">${pill.label}</span></div><div class="gf-plots">${plotsHtml(f.id)}</div></div>`;
  }).join("");
}

// ---- autonomous survey timeline (view: survey) ------------------------------
// Pure frontend: reconstructs each ~15-minute autonomous pass from data the page already has
// (/api/state findings + /api/ledger), bucketing rows by their timestamp. No new endpoint, no worker
// change. Every row keeps the honest origin label (known-planet re-validation vs UNCONFIRMED blind).
const surveyTimelineEl = $("#survey-timeline");
const surveyHeadStatsEl = $("#survey-head-stats");
const surveyStatusTextEl = $("#survey-status-text");
function bucketKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15);
  return d.toISOString();
}
function fmtBucket(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
async function renderSurveyTimeline() {
  if (!surveyTimelineEl) return;
  if (surveyStatusTextEl) surveyStatusTextEl.textContent = `autonomous survey: next pass in ~${nextSurveyIn()}m`;
  let state = null;
  let ledger = ledgerCache;
  try { state = await fetchJSON("/api/state"); } catch { /* keep last findings */ }
  try { ledger = (await fetchJSON("/api/ledger")).ledger || []; } catch { /* keep cache */ }
  ledgerCache = ledger;
  const findings = state && Array.isArray(state.findings) ? state.findings : [...findingsById.values()];
  if (state && state.stats && surveyHeadStatsEl) {
    const st = state.stats;
    surveyHeadStatsEl.textContent = `survey pass ${st.surveyPass ?? 0} - ${st.distinctHosts ?? 0} distinct targets - ${st.blindCandidates ?? 0} blind candidates (unconfirmed)`;
  }
  const buckets = new Map();
  const ensure = (k) => { if (!buckets.has(k)) buckets.set(k, { findings: [], anchored: [] }); return buckets.get(k); };
  for (const f of findings) { const k = bucketKey(f.createdAt); if (k) ensure(k).findings.push(f); }
  for (const e of ledger) { const k = e.anchoredAt ? bucketKey(e.anchoredAt) : null; if (k) ensure(k).anchored.push(e); }
  const keys = [...buckets.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 40);
  if (!keys.length) { surveyTimelineEl.innerHTML = `<p class="empty">No survey passes recorded yet. The autonomous cron runs every 15 minutes.</p>`; return; }
  surveyTimelineEl.innerHTML = keys.map((k) => {
    const b = buckets.get(k);
    const rows = b.findings.map((f) => {
      const badge = BADGE[f.verdict] || BADGE.rejected;
      const pill = ORIGIN_PILL[originOf(f)];
      return `<div class="tl-target"><span class="tl-tic">${esc(f.targetId)}</span><span class="origin-pill ${pill.cls}">${pill.label}</span><span class="badge ${badge.tone}">${badge.label}</span></div>`;
    }).join("");
    const chain = b.anchored.length
      ? `<div class="tl-chain">sealed on-chain: ${b.anchored.map((e) => e.signature ? `<a class="txlink" href="${esc(e.explorerUrl || explorerUrl(e.signature))}" target="_blank" rel="noopener">${esc(shortTx(e.signature))}</a>` : esc(e.findingId)).join(" &middot; ")}</div>`
      : "";
    return `<div class="tl-round"><div class="tl-when"><span class="tl-dot"></span>${fmtBucket(k)}<span class="tl-count">${b.findings.length} target${b.findings.length === 1 ? "" : "s"}</span></div><div class="tl-body">${rows || `<span class="hint">no targets recorded this pass</span>`}${chain}</div></div>`;
  }).join("");
}

// ---- boot ------------------------------------------------------------------
setConn("connecting");
const roomOk = MissionRoom.init($("#room"));
if (roomOk) {
  MissionRoom.attachOverlay($("#room-overlay"));
  const stage = $(".room-stage");
  stage.addEventListener("mousemove", (e) => {
    const r = stage.getBoundingClientRect();
    MissionRoom.pointer(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
  });
  stage.addEventListener("mouseleave", () => MissionRoom.pointer(0, 0));
} else {
  $("#room-fallback").hidden = false;
}
// Open the live link immediately (independent of the data loads below) so the connection
// indicator reflects the WebSocket/SSE state within ~0.5s instead of waiting on /api/discussion.
openSSE();
loadAll();
wireLiveExtras();
setInterval(tickCountdowns, 30000); // refresh every finding's next-transit countdown (minute granularity)

// ---- view router: show one navigable section at a time (so the page stops piling up) ----
// The stacked sections are grouped into 6 views in index.html; this toggles which is visible
// and deep-links via location.hash. Every element id is preserved, so all renderers above keep
// working whether or not their view is on screen. Layout only -- no data or pipeline change.
const VIEWS = ["mission", "candidates", "research", "reports", "gallery", "survey", "observe", "findings", "method"];
const viewEls = Array.from(document.querySelectorAll(".view"));
const navLinks = Array.from(document.querySelectorAll(".viewnav-link"));
function currentView() {
  const m = (location.hash || "").match(/^#\/(\w+)/);
  return m && VIEWS.includes(m[1]) ? m[1] : "mission";
}
function showView(name) {
  for (const el of viewEls) el.classList.toggle("is-active", el.dataset.view === name);
  for (const a of navLinks) {
    const on = a.dataset.goto === name;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  if (name === "mission" && roomOk) MissionRoom.resize(); // canvas was zero-width while hidden
  if (name === "reports") ensureReports();
  if (name === "gallery") ensureGallery();
  if (name === "survey") renderSurveyTimeline();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => showView(currentView()));
showView(currentView());
