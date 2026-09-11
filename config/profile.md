# Capability profile (SAMPLE, replace with your own)

> **This is a worked example, not a real company.** "Northwind Civic Software" is
> fictional. It ships so the LLM relevance pass has something coherent to judge
> against out of the box, and so you can see the level of specificity that
> actually produces good scores. Replace every section below with your own
> facts before you trust a single LLM score.

This file is the *only* description of the vendor the LLM relevance pass sees. It is
sent as a cached system prompt on every scoring call, so its accuracy directly
determines the quality of every LLM score. Edit it freely: no code change needed.

Write it to be literally true. When a fact changes (a certification is earned, a
SAM.gov registration completes, a subcontract is won), update it here first.
Nothing else feeds the model.

---

## What the company is

Northwind Civic Software, Inc. sells a government financial transparency platform to
**municipal** government: towns, cities, and counties. The product consolidates
financial data out of a municipality's existing systems of record and republishes it
so that finance staff, auditors, elected officials, and residents can all read the
same numbers.

There are two surfaces: a staff console (budget vs actual, spend and vendor analytics,
ledger explorer, anomaly review) and an optional public portal, a resident-facing view
of published financial data that is switched on per customer at go-live.

Delivery is web-based SaaS, cloud or on-premise, with US data residency. Data arrives
by API, SFTP, or CSV/Excel upload, and integrates with the common municipal ERP and
banking systems through published connectors.

## Who actually buys it (this drives every scale judgment)

The buyer is a municipal finance office: a finance director, treasurer, town manager,
or clerk. The canonical customer is a town with a budget in the low tens of millions,
not a federal agency running a Treasury-scale general ledger. Deals are small and
delivery is a small team.

This matters for every item on the list, because **the bot scans federal forecasts
while the product is municipal.** A federal opportunity is a real fit mainly when it is
one of these:

- small enough in scope and dollar value for a tiny vendor to deliver,
- about the transparency, reporting, or oversight of money that flows *to* state and
  local government (grants, pass-through funds, recipient reporting), or
- an early RFI or sources-sought where a small vendor can shape a requirement before
  anyone bids.

Federal enterprise financial-system work at agency scale is not this company, however
well the vocabulary matches.

## Capabilities to match against

- Consolidating financial data from disparate municipal systems into a single view.
- Publishing budget, expenditure, revenue, and vendor payment data in structured,
  accessible form, including to the public.
- Budget-vs-actual tracking and departmental spend analytics.
- Transparency and financial reporting artifacts for governing bodies, media, auditors,
  and residents.
- Procurement and contract spend visibility: awards, obligations, encumbrances.
- Payment and disbursement visibility through to the vendor.
- Anomaly surfacing over transaction data, with a severity triage queue.

Do not score these as if they ship:

- **Being the system of record.** The product mirrors and publishes from the financial
  system; it is not the authoritative ledger.

> Keep a list like this honest. The single biggest quality win in this file is naming
> the things that *look* like a match in the marketing copy but are not delivered yet.
> An opportunity whose core requirement is an undelivered capability is adjacent, not
> a bullseye, and saying so here is what stops the model from chasing it.

## What we are NOT

Most of the federal forecast is IT work that is not us:

- Not IT staffing, help desk, or infrastructure O&M.
- Not a network, cybersecurity, cloud-hosting, or data-center provider.
- Not a hardware, software-license, or COTS reseller.
- Not a systems integrator bidding to run someone else's ERP at scale.
- Not a replacement for a core financial system of record. We publish and analyze from
  those systems; we do not replace a general ledger.
- Not a payments processor, bank, or financial institution.

## Federal readiness: the hard gates

These are structural, not preferences, and they cap what is realistically winnable.
**Fill these in accurately for your own company.** They are the highest-leverage facts
in the file, because they decide whether an opportunity is reachable at all rather
than merely appealing. Keep them consistent with `companyStatus` in
`config/company.json`, which drives the deterministic eligibility badges from the
same facts.

The sample company below is early stage and deliberately unregistered, because that is
the harder case to model and it exercises every branch of the eligibility logic:

- **SAM.gov registration and UEI.** Not registered. Without an active SAM.gov
  registration a federal award cannot be received at all, so treat a direct federal
  prime award as out of reach and score accordingly.
- **Socioeconomic certifications.** None held: not 8(a), SDVOSB, WOSB, HUBZone, MBE,
  WBE, or DBE. Set-asides requiring a certification the company does not hold are
  inaccessible. The company is small enough to meet the SBA size standard for its
  NAICS codes, but size alone is not a certification.
- **Security certifications.** None completed. Controls are aligned to the Trust
  Services Criteria and a readiness program exists, but no audit has been completed,
  and the company is not FedRAMP authorized. Anything requiring an existing ATO,
  FedRAMP authorization, or a completed audit report at time of award is out of reach:
  say so in the rationale rather than scoring it highly.
- **Federal past performance.** None. What past performance exists is municipal. A
  prime bid on a federal recompete is not credible. The realistic paths are
  subcontracting or teaming under a prime, RFI and sources-sought responses that shape
  a requirement early, and small set-aside work once registration and certifications
  are in place.

## How to weigh an opportunity

Score high when the work is genuinely about making government money traceable,
auditable, or publicly visible, **and** the scale and entry path are plausible for a
very small, early-stage municipal software vendor.

Score low when it is generic IT modernization, staffing, infrastructure, or a large
prime-only vehicle, even when the NAICS code matches. The NAICS codes on file (518210,
541511, 541512, 541519) are broad IT codes: a match is what got the item onto this list
and tells you nothing about fit. Judge the requirement itself.

Treat an incumbent to displace, an early acquisition phase, a small-business set-aside,
and a named point of contact as things that make a genuine fit *more actionable*, not
as reasons to raise the score of something that was not a fit in the first place.
