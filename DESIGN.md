# VoC Radar design contract

Status: provisional implementation contract for the public self-service rebuild.

## Product posture

- The product is a public App Store review intelligence utility, not a portfolio case-study surface.
- Public reports lead with an evidence-backed `Issues` table. Explanatory project narrative stays outside the product.
- No invented organization, owner, SLA, workspace, comments, or team-management concepts.

## Approved direction

- User-selected reference: `C:\Users\mau55\.codex\generated_images\019f742f-df85-7820-a303-879d5080465a\exec-59c75bf5-d227-4ef2-8027-7a5b2ce7b941.png`.
- Retain the `VoC Radar` name and use a text wordmark in the product header.
- Visual system: neutral white/gray surfaces, restrained cobalt action color, thin separators, compact data density, minimal shadow, no decorative gradient.

## Interaction rules

- A name, App Store URL, or numeric ID uses one search field.
- An analyzed app opens the default `issues` route in no more than two interactions.
- Public report URLs are stable: `/apps/:country/:appId/{overview|issues|reviews}`.
- Mobile keeps the product header compact, turns issue rows into separated list items, and opens issue evidence in a full-screen sheet.
- Every severity label comes from the cluster snapshot canonical value: `high`, `medium`, or `low`.
- Do not show raw AI confidence percentages. Show evidence review count and a comparison only when a valid previous snapshot exists.

## Brand assets

- Header: text-only `VoC Radar` wordmark.
- Favicon: the existing Lucide radar icon geometry, rendered in the single cobalt brand color.
