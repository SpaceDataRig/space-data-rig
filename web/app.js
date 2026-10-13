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

const $ = (sel, el = document) => el.querySelector(sel);

const BADGE = {
  accepted: { label: "RECOVERED", tone: "good", word: "recovered" },
  "needs-more-data": { label: "WATCHLIST", tone: "warn", word: "watchlist" },
  rejected: { label: "NOT RECOVERED", tone: "bad", word: "not recovered" },
};
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
const codeVersionEl = $("#code-version");
const runStatusEl = $("#run-status");
const runSubmitEl = $("#run-submit");
const runBtnEl = $("#run-btn");
const autoscrollEl = $("#transcript-autoscroll");

const findingsById = new Map();
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
    const r = await fetch(`/api/anchor/${encodeURIComponent(id)}/deliberation`, { method: "POST", headers: adminHeaders(), body: "{}" });
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

function plotsHtml(id) {
  const items = [["timeseries.svg", "Light curve + transit model"], ["folded.svg", "Folded at the detected period"], ["periodogram.svg", "BLS periodogram (power vs period)"]];
  return items.map(([name, cap]) => `<figure><figcaption>${cap}</figcaption><img loading="lazy" src="/api/bundles/${encodeURIComponent(id)}/artifact/${name}" alt="${cap}" /></figure>`).join("");
}

function cardHtml(f) {
  const badge = BADGE[f.verdict] || BADGE.rejected;
  const headline = f.narration?.headline || f.verdictReason || "Finding";
  const explainer = f.narration?.explainer || "";
  const score = f.score != null ? `<span class="score">${f.score}/100</span>` : "";
  const chain = f.solanaTx
    ? `<span><b>tx</b> <a class="txlink" href="${esc(explorerUrl(f.solanaTx))}" target="_blank" rel="noopener">${esc(shortTx(f.solanaTx))}</a></span>`
    : `<span><b>on-chain</b> not anchored</span>`;
  return `<div class="card tone-${badge.tone}" data-id="${esc(f.id)}">
    <div class="card-top"><span class="card-target">${esc(f.targetId)}</span><span class="card-side">${score}<span class="badge ${badge.tone}">${badge.label}</span></span></div>
    <div class="headline">${esc(headline)}</div>
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
    <div class="plots" data-plots data-loaded="0"></div>
  </div>`;
}

// the catalog opens on a single row of the four newest findings; the More button
// reveals the older rest (newest first throughout)
const BOARD_PREVIEW = 4;
let boardExpanded = false;

function sortedFindings() {
  return [...findingsById.values()].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || (b.score ?? 0) - (a.score ?? 0));
}
function renderBoard() {
  const list = sortedFindings();
  if (!list.length) {
    boardEl.classList.remove("row-of-four");
    boardEl.innerHTML = `<p class="empty">Awaiting first light. Launch a run to watch the table deliberate.</p>`;
    findingsCountEl.textContent = "0 findings";
    boardMoreEl.hidden = true;
    return;
  }
  const shown = boardExpanded ? list : list.slice(0, BOARD_PREVIEW);
  boardEl.classList.toggle("row-of-four", !boardExpanded);
  boardEl.innerHTML = shown.map(cardHtml).join("");
  findingsCountEl.textContent = `${list.length} finding${list.length === 1 ? "" : "s"}`;
  boardMoreEl.hidden = list.length <= BOARD_PREVIEW;
  boardMoreEl.textContent = boardExpanded ? "Show less" : `More (+${list.length - BOARD_PREVIEW} older)`;
  fillProvenance();
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

// Opt-in admin token for the mutating endpoints (/api/run, /api/anchor/*). When the operator has
// gated the server with ADMIN_TOKEN, they store it once (localStorage key "sdr-admin-token") and it
// is sent as a bearer header. Anonymous visitors omit it; the endpoints stay open until the operator
// sets the secret server-side, so this is harmless on a public, ungated deployment.
function adminHeaders() {
  const h = { "Content-Type": "application/json" };
  try { const t = localStorage.getItem("sdr-admin-token"); if (t) h["Authorization"] = "Bearer " + t; } catch (e) { /* storage unavailable */ }
  return h;
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
  runSubmitEl.disabled = running;
  runBtnEl.disabled = running;
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
    const r = await fetch("/api/run", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) { setRunningUI(false, j.error || "failed to start"); return; }
    lastRunning = true;
    setRunningUI(true, `live ${j.runId}`);
  } catch (err) { setRunningUI(false, `error: ${err.message}`); }
});

runBtnEl.addEventListener("click", () => { $("#run-form").scrollIntoView({ behavior: "smooth", block: "center" }); runSubmitEl.focus(); });
boardMoreEl.addEventListener("click", () => { boardExpanded = !boardExpanded; renderBoard(); });
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
      const r = await fetch(`/api/anchor/${encodeURIComponent(id)}`, { method: "POST", headers: adminHeaders(), body: "{}" });
      const res = await r.json();
      if (res.ok && res.signature) {
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
  const s = r.survey, cv = r.crossValidation, cm = r.compute;
  const depths = s.depthsPpm || [];
  const rows = depths.map((d, i) => {
    const ts = s.completeness[i], pdm = cv.pdm.completeness[i], py = cv.python.completeness[i];
    return `<tr><td>${d} ppm</td><td>${ts ? pct(ts.rate) : "-"}</td><td>${pdm ? pct(pdm.rate) : "-"}</td><td>${py ? pct(py.rate) : "-"}</td></tr>`;
  }).join("");
  const cpu = (cm.cpuHours || []).map((row) => {
    const two = (row.bySectors || []).find((b) => b.sectors === 2);
    return `<tr><td>${row.stars.toLocaleString()} stars</td><td>${two ? two.cpuHours.toFixed(1) : "-"} CPU-h</td></tr>`;
  }).join("");
  el.innerHTML =
    `<figure class="research-figure"><img loading="lazy" src="/results-figure.svg" alt="Completeness vs depth for three independent estimators, and blind purity as true/false positive counts." /></figure>` +
    `<div class="research-grid">` +
      `<div class="research-card"><h3>Search operating point</h3>` +
        `<div class="rc-metric"><span class="k">real host stars</span><span class="v">${s.stars}</span></div>` +
        `<div class="rc-metric"><span class="k">blind purity (lower bound)</span><span class="v">${pct(s.purity)}</span></div>` +
        `<div class="rc-metric"><span class="k">TP / FP on real curves</span><span class="v">${s.nullTP} / ${s.nullFP}</span></div>` +
        `<p class="rc-note">Iterative box-fit BLS under the production gate, on real TESS-SPOC photometry (seed ${s.seed}, injected P=${s.injPeriodDays} d).</p></div>` +
      `<div class="research-card"><h3>Independent cross-checks</h3>` +
        `<div class="rc-metric"><span class="k">PDM period agreement</span><span class="v">${cv.pdm.agreement.agree}/${cv.pdm.agreement.comparable} (${pct(cv.pdm.agreement.rate)})</span></div>` +
        `<div class="rc-metric"><span class="k">Python-stack purity</span><span class="v">${pct(cv.python.purity)} (${cv.python.nullTP}/${cv.python.nullFP})</span></div>` +
        `<p class="rc-note">A different algorithm (PDM) and a different codebase (wotan + astropy BLS) re-analyze the same real data; agreement corroborates, disagreement is explained.</p></div>` +
      `<div class="research-card"><h3>Measured compute cost</h3>` +
        `<div class="rc-metric"><span class="k">scaling exponent</span><span class="v">~${cm.exponentP.toFixed(2)} (R&sup2; ${cm.r2.toFixed(2)})</span></div>` +
        `<div class="rc-metric"><span class="k">per-star detection</span><span class="v">${cm.singleStarDetectionSeconds.toFixed(1)} s</span></div>` +
        `<table class="rc-table"><thead><tr><th>survey</th><th>2 sectors</th></tr></thead><tbody>${cpu}</tbody></table></div>` +
    `</div>` +
    `<h3 class="research-sub">Completeness vs injected depth (three independent estimators)</h3>` +
    `<table class="research-table"><thead><tr><th>depth</th><th>TypeScript BLS</th><th>PDM</th><th>Python astropy BLS</th></tr></thead><tbody>${rows}</tbody></table>` +
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
