# Veterinary antibiotic reference data for supervised AMU verification

**Prepared by Team Kizuna**
**Godwin Adegbehingbe — Team leader and sole member**
**WOAH Datathon 2026 — Challenge 8 — 31 October 2026**

## Recommendation

Evaluate VetAMR-AI in a supervised pilot that compares extracted product information
and calculated ingredient quantities with independently reviewed reporting examples.
The immediate objective is to establish whether the workflow reduces correction
effort while preserving traceable evidence for every accepted product record.

## Contribution of the submission

VetAMR-AI combines product extraction, unit harmonisation, reference lookup, and
package-to-ingredient mass calculations. Reviewers can inspect records and proposed
matches rather than receiving an unexplained aggregate. Unsupported inputs are
flagged for review instead of being assigned an assumed strength.

The included catalog contains 329 records in 62 primary ingredient groups. Its
26 most frequent groups cover at least 80% of catalog records. That shortlist can
guide review of this dataset; it does not establish national consumption coverage
or global market share. Extraction checks on two development leaflets demonstrate
reproducibility on those examples and do not establish operational accuracy.

## Pilot design

Participating authorities would select source records with clear reuse permissions
and preserve registration status, packaging, concentration, source URLs, retrieval
dates, and supporting documents. Veterinary specialists would annotate a separate
multilingual evaluation set and review ambiguous salts, strengths, combinations,
species, and routes.

The pilot would then compare extracted fields and ingredient quantities with
independent manual checks. Evaluation should report errors by field, language,
and source, as well as review time, unmatched records, and excluded mass. Export
fields should be reconciled with current WOAH reporting requirements before any
official reporting integration.

## Conditions for operational use

Source evidence, conversion rules, classifications, and reporting mappings require
specialist validation. Catalog frequency cannot substitute for consumption data.
Screening flags need jurisdiction-specific interpretation, and checksums provide
integrity checks rather than proof of regulatory authenticity.

This submission provides an inspectable starting point for that validation.
VetAMR-AI is an independent entry and is not an official WOAH service.
