# P95 bounded unified catalogue and its joint completeness/reliability operating point

Reproduce: `npm run p95:unified-catalog -- --perCurve 3 --seed 7 --depths 300,500,1000,2000,4000`

A reproducible, bounded catalogue of **12 committed byte-exact real TESS-SPOC hosts**, each with its NASA-archive stellar parameters, its known planet periods, the pipeline's blind best BLS SNR/period, and whether a known planet is recovered. The vetting gate is chosen by the field's joint criterion sqrt((1-C)^2+(1-R_FA)^2) measured on this same sample, not by a round number.

**Known-planet recovery (real photometry):** 8/12 hosts recover a known confirmed planet blind (66.7%); 5/12 also clear the operating SNR>=15.
**Joint C/R operating point:** SNR>=15 with completeness C=98.3%, false-alarm reliability R_FA=89.4%, objective 0.107. Scrambled false alarms clearing the gate: 7/35.

| host | TIC | sectors | Teff | R* | M* | rho | known P (d) | blind best SNR | best P (d) | recovers known |
|---|---|---|---|---|---|---|---|---|---|---|
| HD 39091 | 261136679 | 1,4 | 5998 | 1.17 | 1.07 | 0.94 | 6.27 | 27.0 | 3.135 | yes |
| HR 858 | 178155732 | 3,4 | 6354 | 1.258 | 1.204 | 0.85 | 3.59, 5.97, 11.23 | 17.7 | 1.794 | yes |
| HD 63433 | 130181866 | 20 | 5688 | 0.912 | 0.99 | 1.84 | 4.21, 7.11 | 2124.6 | 13.000 | no |
| HD 25463 | 407966340 | 5,32 | 6353 | 1.4182 | 1.251 | 0.62 | 3.04, 7.05 | 14.7 | 7.048 | yes |
| AU Mic | 441420236 | 1,27 | 3540 | 0.862 | 0.635 | 1.40 | 8.46 | 42.1 | 9.041 | no |
| TOI-480 | 317548889 | 6,33 | 6174 | 1.4877 | 1.2793 | 0.55 | 6.87 | 11.0 | 6.877 | yes |
| GJ 143 | 279741379 | 1,2 | 4640 | 0.695 | 0.73 | 3.06 | 7.79 | 18.4 | 10.810 | no |
| HD 1397 | 394137592 | 1,2 | 5521 | 2.336 | 1.324 | 0.15 | 11.54 | 14.8 | 3.853 | yes |
| TOI-5739 | 328934980 | 23 | 6104.12 | 1.49138 | 1.15 | 0.49 | 8.43 | 6.8 | 6.774 | no |
| KELT-11 | 55092869 | 9 | 5375 | 2.69 | 1.44 | 0.10 | 4.74 | 28.9 | 4.699 | yes |
| HD 86226 | 22221375 | 9,35 | 5863 | 1.053 | 1.019 | 1.23 | 3.98 | 17.0 | 3.985 | yes |
| HD 207496 | 290348383 | 13,27 | 4819 | 0.769 | 0.8 | 2.48 | 6.44 | 21.3 | 6.440 | yes |

**VERDICT:** CATALOGUE-BOUNDED: a reproducible 12-host catalogue on real committed SPOC photometry recovers 8/12 (66.7%) of its hosts' own known planets blind; the joint C/R objective sqrt((1-C)^2+(1-R_FA)^2) on THIS sample is minimised at BLS SNR>=15 (C=98.3%, R_FA=89.4%), the operating gate at which 5/12 known-planet recoveries still stand. Bounded n=12 demonstration catalogue -- the SNR is read off THIS sample, not asserted survey-wide; wires nothing; discoveryClaim false.

Honest bounds: n=12 is a bounded demonstration catalogue, not an all-sky product; the operating SNR is read off THIS sample; the recovery is a detection statistic on KNOWN planets, not a new-world claim. Nothing is wired into the critic or the money path; discoveryClaim and safeToGate are false.
