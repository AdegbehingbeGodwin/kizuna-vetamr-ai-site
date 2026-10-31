# VetAMR-AI data sources and methodology

Team Kizuna — Godwin Adegbehingbe — 31 October 2026

## Provenance and permitted interpretation

The included dataset is a curated demonstration assembled from Python tables in
`seed_database.py`, `seed_expanded.py`, `curator.py`, and `deep_scraper.py`.
Despite the latter filename, its main input is a bundled list of records, not
evidence of an executed web crawl. Authority names and registration identifiers
are reference leads; they do not establish that every field has been checked
against a current official document.

The catalog includes records attributed to regulators such as FDA CVM, UK VMD,
EMA, APVMA, and national authorities in Africa, Asia, and Latin America. It is
not a complete inventory of those registries. Source URLs, retrieval dates,
document hashes, per-field citations, reuse permissions, and reviewer decisions
must be collected before describing the catalog as verified regulatory evidence.
The two bundled leaflets are illustrative fixtures with unverified source provenance.

## Extraction and standardisation

Raw text or PDF text is passed through ingredient lexicon matching, regular
expressions, unit conversion, route mapping, and species mapping. No validated
OCR pipeline is included. The optional Gemini adapter is outside the default
reproducible evaluation. Scores labelled confidence are field-completeness
heuristics, not empirically calibrated correctness probabilities.

The six-field smoke evaluation is defined in `evaluation/annotations.json` and
`scripts/evaluate_submission.py`. It preserves mismatches and publishes predictions.
The sample size is two English development examples used during debugging;
it cannot support claims of independent or multilingual validation.

## Calculations

- Liquid active mass kg = packs sold × pack volume mL × strength mg/mL / 1,000,000.
- Solid active mass kg = packs sold × pack mass g × strength mg/g / 1,000,000.
- Combination mass is allocated separately by ingredient.
- Exploratory biomass kg = sum of species head counts × assumed species weight kg.
- Exploratory intensity mg/kg = active mass kg × 1,000,000 / biomass kg.

The biomass formula omits the population categories, production flows, trade
adjustments, and species-specific treatment required for a validated national
methodology. Default weights, dose values, salt factors, and IU conversions need
primary-source validation. Do not treat derived exposure tiers as clinical or
regulatory thresholds. ANIMUSE-style CSV exports are prototype mappings.

## Repository frequency and bias

The Pareto calculation counts each record under its first ingredient group and
ranks by record frequency, breaking ties by country spread. The smallest prefix
reaching 80% of records is the proposed reference-review shortlist. Combination
products' secondary ingredients do not contribute to this ranking.
This is catalog coverage, not sales, national consumption, or global prevalence.
Country coverage and manually selected products introduce selection bias.

## Deployment and registry fixtures

GitHub Pages exposes the catalog, snapshot charts, and exact sample replays.
The Python application is needed for arbitrary input processing and uploads.
Registry feeds are demonstration fixtures unless the experimental FDA network
request is explicitly enabled with `VETAMR_LIVE_SYNC=1`; the EMA feed remains
fixture-based. Neither feed maintains a validated persistent change-data ledger.

## References and validation targets

- [WOAH Challenge 8](https://data-integration-department-woah.github.io/WOAH-Datathon/challenges.html)
- [WOAH assessment criteria](https://data-integration-department-woah.github.io/WOAH-Datathon/criteria.html)
- [WOAH submission instructions](https://data-integration-department-woah.github.io/WOAH-Datathon/submission.html)

These references define the datathon context. They do not certify this project's
data, classifications, exports, or methodological assumptions.
