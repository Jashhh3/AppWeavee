# Design reference

Source: measured captures of `https://floot.com/dashboard` and the Netha Sethu Floot preview supplied in the task.

## Tokens

- Background: `#fafafa`
- Foreground: `#111827`
- Secondary text: `#495057`, `#6b7280`
- Surface/card: `#ffffff`
- Border: `#d1d5db`
- Primary orange: `#f97316`
- Primary light: `#fed7aa`
- Success: `#10b981`
- Accent blue: `#3b82f6`

## Type

Use `Switzer, Inter, system-ui, sans-serif`. Body is 16px/400. Buttons are 14px. Supporting text is 12.5px. Section headings are 15px/600 or 20px/600 depending on hierarchy.

## Components

```css
.card {
  background: #fff;
  color: #111827;
  border: .8px solid #d1d5db;
  border-radius: 20px;
  box-shadow: rgba(16,24,40,.06) 0 1px 2px, rgba(16,24,40,.06) 0 4px 14px;
}
.button-primary {
  background: #f97316;
  color: #fff;
  border-radius: 999px;
  padding: 8px 14px 8px 18px;
  font-size: 14px;
  font-weight: 600;
}
.badge-pill { background: #ecedf0; color: #4b5563; border-radius: 999px; }
```

Use 4/6/8/10/12/14/16/18/24px spacing, 8px control radii, 12px input radii, 20px card radii, and 150–300ms ease transitions. Use grid for cards and flex for navigation/toolbars. At 1024px, 768px, and 640px, collapse to a one-column responsive layout.

The reference is visual guidance only. Do not copy proprietary source code or claim unmeasured interactions.
