# Entity Relationship Renderer

Render `diagram_type: "erd"` JSON files into the standard Archify HTML
template using crow's-foot notation: entities are table cards with typed
attribute rows, and every relationship end carries a cardinality symbol.

```bash
node archify/renderers/erd/render-erd.mjs input.erd.json output.html
```

The renderer validates input against `archify/schemas/erd.schema.json`
with the bundled standalone validator. No dependency installation is required.

If `output.html` is omitted, the renderer uses `meta.output` from the JSON file
or falls back to `erd.html` in the current working directory.

## Input

Entity-relationship JSON files must set:

```json
{
  "schema_version": 1,
  "diagram_type": "erd",
  "meta": {
    "title": "Subscription Commerce Data Model",
    "viewBox": [1010, 620]
  },
  "entities": [],
  "relationships": [],
  "cards": []
}
```

A complete worked example lives at
`archify/examples/subscription-commerce.erd.json`.

The schema lives at:

```text
archify/schemas/erd.schema.json
```

### Cardinality

Both ends of every relationship must state cardinality. Each enum maps to one
crow's-foot symbol and to the matching Mermaid `erDiagram` operator:

| Value | Symbol | Mermaid |
|---|---|---|
| `exactly-one` | two ticks | `||` |
| `zero-or-one` | tick + ring | `o|` |
| `one-or-many` | tick + foot | `}|` |
| `zero-or-many` | ring + foot | `}o` |

## Legend

The default visual legend derives kinds from the document: entity kinds from
`entities[].kind`, relation variants from `relationships[].variant`, and both
cardinality symbols of every relationship. Supported `meta.legend.entries`
keys, in stable order, are `core`, `reference`, `junction`, `external`,
`emphasis`, `security`, `dashed`, `default`, `exactly-one`, `zero-or-one`,
`one-or-many`, and `zero-or-many`. Cardinality rows draw the actual symbol as
their swatch. All entries are visual-only in this slice.

## Layout budget

| Constant | Value |
|----------|-------|
| viewBox | default `[1120, 860]`; schema minimum `[360, 360]` |
| Column centers | x = 130 + column×250, column 0–3 |
| Row tops | y = 48 + Σ(prior rows' tallest card + 54), row 0–3 |
| Default card | width 150 (minimum 96); height 34 + 14×attributes |
| Entity area | x within `[24, width − 24]`; bottom above the legend band |
| Entity spacing | ≥10px between any two cards |
| Relationship length | ≥40px between endpoints (markers occupy ~20px per end) |
| Legend row | baseline y = height − 36; wraps upward on narrow canvases |

Route presets for relationships: `straight`, `orthogonal-h`, `orthogonal-v`,
explicit `via` points, or the default `auto` (side-honoring elbow that avoids
unrelated entities). `fromField`/`toField` anchor a left/right port to the
attribute row carrying the key.

## Design Rules

- Place entities by column and row; keep the main reading path across one row.
- State cardinality on both ends; the notation is the fact, labels are extra.
- Model many-to-many with a `junction` entity whose composite PK repeats the
  `pk` key badge across rows; do not also draw an implied dashed edge.
- Use `reference` for lookup tables and `external` for tables owned by
  another system.
- Keep relationship labels as short verbs; omit them when both endpoints and
  the FK already imply the relation.
- Anchor relationship ends to FK rows with `toField` when it clarifies which
  key realizes the relation.

Schema violations exit non-zero with path-prefixed messages annotated with
the element's id or name. The renderer additionally fails when it can detect
layout problems, including missing or duplicate entities, cards outside the
readable diagram area, card overlap, entity names wider than their card,
attribute rows wider than their card, unknown relationship endpoints or
`fromField`/`toField` names, attribute anchors combined with top/bottom ports,
unreadably short relationships, diagonal `via` segments, or routes crossing
unrelated entities (2px Clean Flow clearance). Text width is estimated
CJK-aware: fullwidth glyphs count as two units.

Set `meta.quality_profile` to `showcase` for polished delivery. Unrelated
proper-X crossings then fail with `composition/proper-crossing`, and so do
ambiguous shared corridors, sub-8px segments, sub-16px interior turns, and
labels without 4px route clearance; default `standard` keeps those as
artifact-receipt warnings.
