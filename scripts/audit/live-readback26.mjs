// round-26 deploy read-back: what does the PUBLIC endpoint actually serve now?
// Not "did wrangler exit 0" -- that is the tool's account of itself. Each check is a byte-level fact about a response.
// Honesty standard (R26-23, applied here in R26-25): an unreachable edge is neither a pass nor a defect. The shipped
// version let an AbortSignal timeout surface as an uncaught DOMException stack trace at exit 1 -- which reads as "the
// tool broke" and is indistinguishable from "the served content is wrong." Now each request is bounded and retried once,
// and a network failure prints a clean UNREACHABLE verdict at exit 2, reserved strictly for the case where the edge did
// not answer. A 200 that then disagrees with the committed bytes is a genuine finding and still surfaces loudly.
const BASE = "https://spacedatarig.app";
const REQ_TIMEOUT_MS = 60_000;
async function get(p, as = "json") {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      const t = await r.text();
      return { ok: true, status: r.status, bytes: t.length, body: as === "json" ? JSON.parse(t) : t };
    } catch (e) {
      if (attempt === 1) return { ok: false, err: e.name === "TimeoutError" ? "timeout" : e.message };
    }
  }
}
const sayUnreachable = (p, r) => {
  console.log(`UNREACHABLE: the edge did not answer ${p} (${r.err}); this is NOT a pass and NOT a defect -- re-run when the network is steady.`);
  process.exit(2);
};
const out = {};

const health = await get("/health");
if (!health.ok) sayUnreachable("/health", health);
out.health = { status: health.status, gitSha: health.body.gitSha, deployVersion: health.body.deployVersion };

const res = await get("/research.json");
if (!res.ok) sayUnreachable("/research.json", res);
out.research = {
  status: res.status,
  generatedAt: res.body.generatedAt,
  compute: { p: res.body.compute?.exponentP, r2: res.body.compute?.r2, sampleN: res.body.compute?.sampleN },
  addressable: res.body.trueVetoAcceptance?.addressable,
  p76novel: res.body.multiSourceNoveltyP76?.novelArchive,
};

const idx = await get("/reports/index.json");
if (!idx.ok) sayUnreachable("/reports/index.json", idx);
const f = idx.body.freshness;
out.library = {
  status: idx.status, count: idx.body.count, rows: (idx.body.reports || []).length,
  freshness: { verified: f.verified, fullyVerified: f.fullyVerified, stamped: f.stamped, unattested: f.unattested, stale: f.stale },
  five: ["p34-cost-model", "p54-selection-function", "p63-soft-score", "p68-discriminator-roc", "p79-benchmark"]
    .map((id) => { const r = idx.body.reports.find((x) => x.id === id); return r ? `${id}: stamped=${r.stamped} verified=${r.verified} fresh=${r.fresh} reproducible=${r.reproducible}` : `${id}: MISSING FROM SERVED INDEX`; }),
};

// The served fragment for the drifted report: does the public page carry the NEW exponent or the old one?
const p34 = await get("/reports/p34-cost-model.html", "text");
if (!p34.ok) sayUnreachable("/reports/p34-cost-model.html", p34);

out.p34fragment = {
  status: p34.status,
  hasNewExponent: /2\.87/.test(p34.body),
  hasOldExponent: /2\.93|2\.94/.test(p34.body),
  hasOldSampleN: /\b33\b/.test(p34.body),
  provenanceBanner: /STALE|unverified/i.test(p34.body) ? "present" : "absent",
};

console.log(JSON.stringify(out, null, 1));
