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
