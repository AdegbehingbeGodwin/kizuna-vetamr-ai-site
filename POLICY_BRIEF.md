# A supervised pilot for veterinary antibiotic reference data

**Prepared by Team Kizuna**
**Godwin Adegbehingbe, team leader and sole member**
**WOAH Datathon 2026, Challenge 8 — 31 October 2026**

## Proposal

Pilot an auditable workflow that helps reporting teams translate veterinary
antibiotic package sales into ingredient quantities. VetAMR-AI demonstrates
extraction, standardisation, catalog lookup, and mass calculations; it needs
independent validation before use in official reporting.

## What this prototype shows

The curated demonstration catalog contains 329 records and 62 primary ingredient
groups. Reviewing the top 26 groups would cover at least 80% of those catalog
records. This is a practical way to prioritise review within this dataset.
It does not establish national consumption coverage, global market share, or
80% confidence in an AMU submission. The two-example extraction evaluation is
a development smoke check, not evidence of deployment readiness.

## Recommended pilot

1. Select a small set of participating authorities and obtain licensed source
   records. Capture source URLs, retrieval dates, registration status, packaging,
   and field-level evidence for each product.
2. Have veterinary specialists annotate a multilingual holdout set, evaluate
   each extracted field, and review ambiguous concentrations, salts, combinations,
   species, and routes. Track correction time as well as accuracy.
3. Compare calculated quantities with independently checked reporting examples
   and reconcile exports with WOAH's current reporting schema before integration.

## Decisions that remain with experts

Registration counts cannot substitute for consumption data. Rule-based alerts
need jurisdiction-specific interpretation. Biomass and dose assumptions need
methodological review. A document checksum supports integrity checking but does
not establish authenticity or regulatory approval.

Team Kizuna proposes this prototype as a starting point for collaborative
validation. It is an independent datathon entry, not an official WOAH service.
