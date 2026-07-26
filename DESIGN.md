# VoC Radar design contract

## Product principles

- VoC Radar turns public App Store reviews into evidence-backed issue reports.
- Public reports lead with the `Issues` table and link each issue to its source reviews.
- The interface covers app discovery, report reading, review evidence, and analysis requests.

## Visual direction

- Retain the `VoC Radar` name and use a text wordmark in the product header.
- Visual system: neutral white/gray surfaces, restrained cobalt action color, thin separators, compact data density, minimal shadow, no decorative gradient.

## Interaction rules

- A name, App Store URL, or numeric ID uses one search field.
- An analyzed app opens the default `overview` route in no more than two interactions.
- Public report URLs are stable: `/apps/:country/:appId/{overview|issues|reviews}`.
- Mobile keeps the product header compact, turns issue rows into separated list items, and opens issue evidence in a full-screen sheet.
- Every severity label comes from the cluster snapshot canonical value: `high`, `medium`, or `low`.
- Do not show raw AI confidence percentages. Show evidence review count and a comparison only when a valid previous snapshot exists.

## Brand assets

- Header: text-only `VoC Radar` wordmark.
- Favicon: the existing Lucide radar icon geometry, rendered in the single cobalt brand color.
