# P91 - can this rig verify a claim like that one?

Reproduce: `npm run p91:claim-provenance`

Mode: **live (resolvers queried)** -- rules, not mood: the same input must give the same verdict either way.

## What is being verified, and what is not
Our detector is a broadband optical transit finder. A narrow infrared emission line reported by a spectrograph is not something it can see, so this study does not attempt to re-measure the phenomenon. What IS checkable is the claim's own structure: whether a primary source exists, whether it says what the post says, whether the post's timing wording survives comparison with the source's dates, whether the post is attributable at all, and whether our instrument could in principle bear on it. Every axis prints its rule beside its answer.

| axis | question | rule |
| --- | --- | --- |
| subject | does the resolved primary say what the post says | every asserted platform token must appear in the record, and at least one phenomenon CLASS must be shared |
| recency | is a freshness claim compatible with the source | freshness wording plus a lag over 7 whole days past the earliest resolved public date -> INFLATED; no wording -> the axis stays silent |
| attribution | does the post point at anything persistent | judged on identifiers the POST cited, never on identifiers we located for it |
| band | is the wavelength inside our reach | interval overlap against TESS 0.6-1.0 micron, band taken from citable text only |
| corroboration | could we say anything about it | band AND coverage both required; a photometric null would not test a line claim |

## Rows
### polymarket-jwst-void-2026-10-17  
_The post the operator asked about, quoted verbatim from the platform page_

> JUST IN: NASA's James Webb Space Telescope detects a mysterious infrared light signal emanating from a seemingly empty void in space, leaving scientists puzzled.

posted 2026-10-17T14:54:00Z (The platform renders '2:54 PM / Oct 17, 2026' without a timezone. Day-level precision is all this study claims; lag is reported in whole days.); post-cited ids: none; located by us: 10.3847/1538-4357/ae9a94, 2610.12553.

- **subject MATCH** -- every asserted platform [nasasjameswebbspacetelescope] appears in the primary record, and 1 phenomenon class(es) agree (single)
- **attribution NO-CITATION** -- the post carries no persistent identifier for the observation it announces
- **recency INFLATED (lag 26 d)** -- "just in" against a lag of 26 day(s) past the 7-day allowance
- **band DISJOINT** -- claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; source of the number: the located primary record states it; the post gives only a colour word
- **our reach NOT-IN-OUR-BAND** -- the phenomenon is stated at claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; a broadband optical photometer cannot detect or refute a line outside its band, even where the sky position is in our survey footprint (sectors: 4,31,105,106,107,108) (position is an operator-annotation)
  - [located] doi 10.3847/1538-4357/ae9a94: The Astrophysical Journal, 2026-09-22 -- A Single Line Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy
  - [located] arxiv 2610.12553: arXiv, 2026-10-08 -- A Single Line-Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multi-Object Coronagraphy for Slitless Spectroscopy
  - control expectation {"subject":"MATCH","recency":"INFLATED","attribution":"NO-CITATION","corroboration":"NOT-IN-OUR-BAND"} -> **MET**
  - why that expectation: MATCH because every mission token the post asserts (jwst/webb) appears in the located records and the phenomenon classes line/emission and single/unknown both recur in their abstracts. INFLATED because 'JUST IN' sits 26 days behind the earliest resolvable public date (the arXiv v1 posting of 2026-10-08; the journal's own registered date is 2026-09-22, so either way the lag is far past the 7-day allowance). NO-CITATION because the post links nothing. NOT-IN-OUR-BAND because the primary record states the line at 1.60 micron, outside TESS 0.6-1.0 micron -- the number comes from the record's text, not from anyone's memory of the instrument.

### control-posted-on-publication-day  
_Same facts, honestly timed: posted the day the record was published, and citing it_

> NASA's James Webb Space Telescope reports a single emission line from a region with no identified source. Our review of the published paper.

posted 2026-09-22T12:00:00Z; post-cited ids: 10.3847/1538-4357/ae9a94; located by us: none.

- **subject MATCH** -- every asserted platform [jameswebbspacetelescope] appears in the primary record, and 2 phenomenon class(es) agree (line, single)
- **attribution CITES-PRIMARY** -- at least one cited id resolves to a primary record (10.3847/1538-4357/ae9a94)
- **recency NO-TIMING-CLAIM** -- the post makes no freshness claim, so there is no timing statement to test
- **band DISJOINT** -- claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; source of the number: the located primary record states it; the post gives only a colour word
- **our reach NOT-IN-OUR-BAND** -- the phenomenon is stated at claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; a broadband optical photometer cannot detect or refute a line outside its band, even where the sky position is in our survey footprint (sectors: not checked)
  - [cited] doi 10.3847/1538-4357/ae9a94: The Astrophysical Journal, 2026-09-22 -- A Single Line Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy
  - control expectation {"subject":"MATCH","recency":"NO-TIMING-CLAIM","attribution":"CITES-PRIMARY"} -> **MET**
  - why that expectation: The guard against a verifier that only ever finds fault: a same-day, source-citing post must come back CITES-PRIMARY with no timing flag at all, and its subject must be allowed to AGREE -- the post's words (single, emission, line) are the paper's own words. When this fixture was drafted on title-only assumptions it declared PARTIAL; the live resolver turned out to expose the journal abstract too, and the grid follows the data, not the draft.

### control-wrong-platform  
_A post that names the wrong observatory for the record it points at_

> JUST IN: the Chandra X-ray Observatory detects an emission line where no source is known.

posted 2026-10-17T14:54:00Z; post-cited ids: 10.3847/1538-4357/ae9a94; located by us: none.

- **subject MISMATCH** -- the post asserts platform(s) absent from the primary record: chandraxrayobservatory
- **attribution CITES-PRIMARY** -- at least one cited id resolves to a primary record (10.3847/1538-4357/ae9a94)
- **recency INFLATED (lag 26 d)** -- "just in" against a lag of 26 day(s) past the 7-day allowance
- **band DISJOINT** -- claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; source of the number: the located primary record states it; the post gives only a colour word
- **our reach NOT-IN-OUR-BAND** -- the phenomenon is stated at claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; a broadband optical photometer cannot detect or refute a line outside its band, even where the sky position is in our survey footprint (sectors: not checked)
  - [cited] doi 10.3847/1538-4357/ae9a94: The Astrophysical Journal, 2026-09-22 -- A Single Line Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multiobject Coronagraphy for Slitless Spectroscopy
  - control expectation {"subject":"MISMATCH","attribution":"CITES-PRIMARY"} -> **MET**
  - why that expectation: Attribution can be perfect and the subject still wrong: the cited DOI resolves, but its record names no X-ray observatory, so the asserted platform is absent from it. A check that only asked 'does the link resolve' would pass this. Hubble was the first draft of this control and was dropped once the real record was read: this paper's own abstract cites its deepest HST imaging, so a Hubble claim would have matched for a reason the control must not lean on.

### control-dead-identifier  
_A post citing an identifier that does not exist at the registering body_

> JUST IN: NASA's James Webb Space Telescope detects a mysterious signal. See doi:10.0000/this-identifier-does-not-exist

posted 2026-10-17T14:54:00Z; post-cited ids: 10.0000/this-identifier-does-not-exist; located by us: none.

- **subject UNRESOLVED** -- no primary record resolved, so there is nothing to compare the post's asserted subject against
- **attribution CITATION-DOES-NOT-RESOLVE** -- the cited id(s) do not exist at the registering body (10.0000/this-identifier-does-not-exist)
- **recency UNVERIFIABLE** -- the post says "just in" but no primary record with a date could be resolved, so the lag is unknown
- **band UNSTATED** -- no wavelength range is available from the post or the located record, so whether our band could see it is unknown; source of the number: no wavelength in the post or in any resolved record
- **our reach COVERAGE-NOT-CHECKED** -- wavelength reach and survey coverage were not both established, so no statement is made
  - [cited] doi 10.0000/this-identifier-does-not-exist: did not resolve (not-found)
  - control expectation {"subject":"UNRESOLVED","attribution":"CITATION-DOES-NOT-RESOLVE","recency":"UNVERIFIABLE"} -> **MET**
  - why that expectation: The distinction that matters: 'the identifier does not exist' is evidence, while 'the request failed' is not. A transport error must never be reported as a broken citation, and a broken citation must never be reported as 'no such result exists in the literature'.

### control-no-timing-word  
_A retrospective post: old result, no freshness wording, lag irrelevant_

> Looking back at NASA's James Webb Space Telescope result on an unidentified emission line, two years after the observations.

posted 2026-10-17T14:54:00Z; post-cited ids: 2610.12553; located by us: none.

- **subject MATCH** -- every asserted platform [nasasjameswebbspacetelescope] appears in the primary record, and 2 phenomenon class(es) agree (line, single)
- **attribution CITES-PRIMARY** -- at least one cited id resolves to a primary record (2610.12553)
- **recency NO-TIMING-CLAIM** -- the post makes no freshness claim, so there is no timing statement to test
- **band DISJOINT** -- claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; source of the number: the located primary record states it; the post gives only a colour word
- **our reach NOT-IN-OUR-BAND** -- the phenomenon is stated at claimed 1.4-1.8 micron (stated by the primary record (the post gave no number)) lies entirely outside TESS 0.6-1.0 micron; a broadband optical photometer cannot detect or refute a line outside its band, even where the sky position is in our survey footprint (sectors: not checked)
  - [cited] arxiv 2610.12553: arXiv, 2026-10-08 -- A Single Line-Emitter Identified in an Unbiased Search with JWST/NIRSpec: Multi-Object Coronagraphy for Slitless Spectroscopy
  - control expectation {"recency":"NO-TIMING-CLAIM","attribution":"CITES-PRIMARY","subject":"MATCH"} -> **MET**
  - why that expectation: A large lag is only a defect when the post claims freshness. Without a timing term the recency axis must stay silent rather than file a complaint about a date nobody asserted. Subject is MATCH -- the post speaks the record's own words (emission, line, unidentified) -- which is the point: this row isolates the timing axis, and the earlier draft's silence on subject was a title-only guess the records do not support.

## Controls
5 of 5 expectation-bearing rows behaved as declared. A negative control that fails is the interesting case: it means the rule cannot tell a wrong claim from a right one.

## What this does not support
Nothing here gates, anchors, or retracts anything: `safeToGate` is false on every row by construction. Reviewing somebody else's announcement does not make their result ours, and a metadata mismatch is not evidence about the sky. Where a resolver could not be reached, the report says UNVERIFIABLE rather than inventing a finding -- the same split the upstream live-probe uses between 'drifted' and 'unreachable'.
