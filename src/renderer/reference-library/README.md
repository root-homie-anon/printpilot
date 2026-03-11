# Reference Library

## Purpose

This directory stores scraped visual references from top-selling Etsy printable products, organized by niche. The designer agent uses these references to match current market aesthetic expectations and produce designs that align with what buyers are actively purchasing.

## Structure

Each subdirectory corresponds to a product niche:

```
reference-library/
├── planners/       — Weekly, daily, monthly planner references
├── trackers/       — Habit, fitness, mood, reading, savings tracker references
├── journals/       — Gratitude, daily, bullet journal references
└── worksheets/     — Budget, goal-setting, meal plan, study worksheet references
```

## File Types

Each niche folder may contain:

- **Screenshots** (`*.png`, `*.jpg`) — Captured from top-selling Etsy listings (cover images, preview pages)
- **Color palette extracts** (`*-palette.json`) — Dominant colors extracted from reference designs
- **Layout analysis notes** (`*-analysis.md`) — Structural breakdown of successful designs (grid usage, whitespace, typography choices)
- **Trend snapshots** (`*-trends.json`) — Search volume, pricing data, and seasonal patterns at time of capture

## Usage

The `@researcher` agent populates this library during its daily run. The `@designer` agent reads from it when generating new product templates, using the references to:

1. Match color palettes that resonate with current buyers
2. Follow layout conventions that top sellers use
3. Incorporate trending visual elements (borders, icons, decorative patterns)
4. Ensure new designs are competitive but differentiated

## Notes

- References are refreshed regularly as market trends shift
- Old references are archived, not deleted, to track aesthetic evolution over time
- All scraped content is used strictly for internal design guidance
