// round-26 deploy read-back: what does the PUBLIC endpoint actually serve now?
// Not "did wrangler exit 0" -- that is the tool's account of itself. Each check is a byte-level fact about a response.
const BASE = "https://spacedatarig.app";
const get = async (p, as = "json") => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(120_000) });
  const t = await r.text();
  return { status: r.status, bytes: t.length, body: as === "json" ? JSON.parse(t) : t };
};
const out = {};

const health = await get("/health");
out.health = { status: health.status, gitSha: health.body.gitSha, deployVersion: health.body.deployVersion };

const res = await get("/research.json");
out.research = {
  status: res.status,
  generatedAt: res.body.generatedAt,
  compute: { p: res.body.compute?.exponentP, r2: res.body.compute?.r2, sampleN: res.body.compute?.sampleN },
  addressable: res.body.trueVetoAcceptance?.addressable,
  p76novel: res.body.multiSourceNoveltyP76?.novelArchive,
};

const idx = await get("/reports/index.json");
const f = idx.body.freshness;
out.library = {
  status: idx.status, count: idx.body.count, rows: (idx.body.reports || []).length,
  freshness: { verified: f.verified, fullyVerified: f.fullyVerified, stamped: f.stamped, unattested: f.unattested, stale: f.stale },
  five: ["p34-cost-model", "p54-selection-function", "p63-soft-score", "p68-discriminator-roc", "p79-benchmark"]
    .map((id) => { const r = idx.body.reports.find((x) => x.id === id); return `${id}: stamped=${r.stamped} verified=${r.verified} fresh=${r.fresh} reproducible=${r.reproducible}`; }),
};

// The served fragment for the drifted report: does the public page carry the NEW exponent or the old one?
const p34 = await get("/reports/p34-cost-model.html", "text");
out.p34fragment = {
  status: p34.status,
  hasNewExponent: /2\.87/.test(p34.body),
  hasOldExponent: /2\.93|2\.94/.test(p34.body),
  hasOldSampleN: /\b33\b/.test(p34.body),
  provenanceBanner: /STALE|unverified/i.test(p34.body) ? "present" : "absent",
};

console.log(JSON.stringify(out, null, 1));
