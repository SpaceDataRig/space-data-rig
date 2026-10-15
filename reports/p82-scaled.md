# P82 scaled validation (audit follow-up: grow the sample ~100-1000x)
Reproduce: `npm run p82:scaled -- --probe all --limit 500 --concurrency 6` then `npm run p82:scaled -- --probe report`
Same three audit-9 probes, run over a MUCH larger real target pool via one resumable, concurrent, byte-cached
engine (out/scaled/*.jsonl checkpoints). Every number is measured on real public TESS-SPOC / Gaia / ExoFOP data.
## Blind test (scaled P78)
- curves 425 (181 injected / 244 null); recall 86.2% CI [80,90]; precision 14.4% CI [12,17]
- >=2-sector bar: accepted 329, accepted-recall 139/181, FALSE-ACCEPTS 190, accepted precision 42.2%
## External independent validation (scaled P80+P81)
- KP controls: validated 182/234; blendFPP<1e-3 & no harmonic alias 1/234
- CP uncertain candidates: validated 104/179; strict grade 5/179
## Centroid per-contaminant F-test (scaled P77 point 4)
- known planets testable 53: FALSE-REJECT 1 (1.9%) -- eumemic reference 0/565
- labelled blends testable 56: CAUGHT 0 (0.0%) -- eumemic reference 73% (38% within 15")
First-order checks and positive controls on real data; not discoveries, not full TRICERATOPS/eumemic-grade
validation. discoveryClaim false, safeToGate false.