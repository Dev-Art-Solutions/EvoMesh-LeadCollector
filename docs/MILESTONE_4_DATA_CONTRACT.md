# Milestone 4 data contract

Milestone 3 produces version 1 lead documents. `schema_version` appears in
health, paginated results and artifacts. Jobs preserve the original request
and its timestamps. Leads have internal UUIDs with provider-specific listing
identifiers, store opaque provider IDs as strings, and retain URL-based
provenance. Keep those IDs stable if future evidence types are added.
Extend the SQLite schema through new numbered migrations. Readers should
tolerate additional fields and preserve missing values as unknown.
Version changed meanings with an explicit migration or export schema bump.

| Future input | Version 1 evidence |
| --- | --- |
| Business identity and location | Name, categories, street, address, municipality, city, postal code, region, country, coordinates, domain and website URL when observed |
| Google business listing and other provider attributes | Provider ID, listing and review URLs, hours, labels, services, claimed marker and category evidence when provided by the existing extractor |
| Analytics, tag manager and pixel observations | Reserved `website_technology` source kind, with observation time, URL, quality and extensible evidence fields. A later collector can attach observed script URLs or signatures |
| Directory NAP comparisons | Reserved `directory_nap` source kind. Store each directory's observed name, address and phone with its source and timestamp so later rules can compare them |
| Reviews and owner replies | Aggregate rating, count and review URL when present. Reserved `review` source kind for individual public review observations and response state where permitted |
| Evidence-backed recommendations | Reserved `audit_observation` kind. A later rules layer can cite source records and record uncertainties and missing inputs |

Every source has a kind, platform, observed time, source URL when
available, quality and availability. Source values can differ across
providers or collection dates. A source's `observed` quality records an
observation. Verification requires an independent check and its own
timestamp. Job snapshots include per-lead evidence and contacts. Old jobs
may expire while normalized leads and source observations persist.

A future report may assess gaps with transparent rules. A tracking tag
observation alone cannot establish whether ads are running. Milestone 3
stores no audit scores, campaign judgments, inferred contact data, or PDF
reports. Collect only public business information in scope and observe
applicable provider terms and privacy requirements.
