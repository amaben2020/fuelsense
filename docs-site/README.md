# FuelSense engineering docs

Docusaurus site covering the architecture, the measurement/modelling rules and
the operational runbook. Docs-only — the blog and marketing landing page are
turned off, because the product pitch lives on the app's own landing page.

```bash
npm install
npm start      # dev server on :3100, hot reloads
npm run build  # static output in build/
npm run serve  # serve that build on :3100
```

Both `start` and `serve` pin port **3100** rather than Docusaurus's default
3000, which the Next.js frontend dev server already occupies — the two would
otherwise refuse to run at the same time, and reading the docs while working on
the app is the normal case.

## What goes here

This site is the home for anything that explains **why a number is what it is** —
especially the distinction between measured, derived and modelled quantities.
That reasoning is invisible from the code and is the most common source of
support questions.

The HTTP API is documented separately as OpenAPI, from
`backend/src/docs/openapi.ts`, and served at `/api/docs` by the API itself.
Keep the two in step: an endpoint's *shape* belongs in the OpenAPI document, an
endpoint's *meaning* belongs here.

## Diagrams

Mermaid is enabled. Use fenced ```mermaid blocks; they render client-side.

## Conventions

- Never describe a modelled quantity as measured
- When documenting a fix, record the symptom it produced — a bug that once put
  Tuesday's mileage under a "Today" heading is far easier to recognise again
  from the symptom than from the cause
- Link to the page that answers the question rather than restating it
