---
name: measured-design-reference
description: Use the supplied Floot measurements when building or reviewing AppWeave interfaces. Preserve measured colors, typography, radii, spacing, shadows, and interaction patterns; do not invent missing states.
---

# Measured Floot design reference

Use this reference for AppWeave dashboard and project-preview UI work. It is a measured visual reference, not a source-code copy. Keep AppWeave behavior and accessibility intact.

## Core tokens

```css
:root {
  --background: #fafafa;
  --foreground: #111827;
  --foreground-subtitle: #6b7280;
  --surface: #ffffff;
  --primary: #f97316;
  --primary-light: #fed7aa;
  --primary-400: #fb923c;
  --secondary: #10b981;
  --secondary-200: #bbf7d0;
  --secondary-400: #34d399;
  --secondary-light: #ccfbf1;
  --blue: #3b82f6;
  --color-accent-blue-light: #dbeafe;
  --color-accent-blue-lighter: #eff6ff;
  --color-hover-blue: #bfdbfe;
  --teal: #14b8a6;
  --color-hover-teal: #99f6e4;
  --border: #d1d5db;
  --text-secondary: #495057;
  --sidebar: hsl(70, 10%, 88%);
  --card: #ffffff;
}
```

Use Switzer, Inter, system-ui, sans-serif. Body is 16px/normal/400. Use 14px buttons, 15px/600 section labels, 20px/600 section headings, and 12.5px supporting text.

## Component rules

- Primary actions: orange `#f97316`, white text, 14px/600, pill radius `999px`; use 18px left and 14px right padding.
- Secondary actions: transparent, `#495057`, radius `8px`, 14–15px text.
- Cards: white surface, `0.8px solid #d1d5db`, radius `20px`, shadow `rgba(16,24,40,.06) 0 1px 2px, rgba(16,24,40,.06) 0 4px 14px`.
- Inputs: white background, `#d1d5db` border, 12px radius, 14px text, 6px vertical padding, 32px horizontal padding when an icon is present.
- Pills: `#ecedf0` background, `#4b5563` text, `999px` radius.
- Use 4/6/8/10/12/14/16/18/24px spacing. Prefer 8px and 12px radii for controls and 20px for cards.
- Use 150–300ms ease transitions and honor `prefers-reduced-motion`.

## Layout guidance

- Light page background `#fafafa`; avoid the previous dark dashboard palette.
- Use a 200px navigation rail only when it improves desktop scanning; content should be centered with a max width around 1336–1700px and about 76.8px side padding at wide widths.
- Use flexbox for navigation/toolbars and CSS grid for cards and project sections.
- Responsive breakpoints: 1024px, 768px, 640px. Collapse navigation and use one-column cards on small screens.
- Keep project preview pages as real rendered HTML/React pages. Never display patch syntax, Markdown diff markers, or implementation notes as the user-facing preview.

## Quality checks

Before finishing a UI change:

1. Check light/dark contrast and keyboard focus states.
2. Verify the dashboard at desktop and mobile widths.
3. Verify the project preview has a real form/page, not a generic shell or raw patch.
4. Run the existing frontend tests and production build.
5. Do not claim an endpoint or database is working unless a response is persisted and read back.

Source references supplied by the user: measured captures from `floot.com/dashboard` and the NethaSethu Floot preview. The measurements are retained in the project conversation and should be followed where applicable; do not copy proprietary source code or assets.
