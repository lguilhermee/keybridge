---
name: frontend
description: Implement and review the Cursor BYOK React/Tauri desktop frontend. Use for changes under apps/desktop involving routing, page layout, window chrome, settings UI, scrolling, virtualization, charts, themes, or frontend component architecture.
---

# Cursor BYOK Frontend

Build on the components and theme system already present in `apps/desktop`. Preserve the Tauri HTTP boundary; frontend management features call `/__byok-api__/api` and never add IPC business APIs.

## Desktop HTTP communication

- Treat the Rust management server as the single HTTP origin for the desktop UI. The main WebView and browser-opened detail pages must use `http://127.0.0.1:<dynamic-port>/__byok-api__/`; do not load the main UI from `tauri://localhost` or expose a second frontend origin.
- Make every frontend management request relative to `/__byok-api__/api`. Do not discover, inject, persist, or pass an `apiOrigin`, and do not construct management URLs from a fixed port.
- Keep the `/__byok-api__/` namespace reserved for this boundary:
  - `/__byok-api__/api/*` is handled locally by the Rust management API.
  - Other `/__byok-api__/*` paths are frontend documents, assets, modules, and development resources.
- In production, serve the frontend embedded by Tauri's `frontendDist` through the Rust server. Reuse Tauri's asset resolver rather than bundling or copying a second set of frontend resources.
- In development, let the Rust server reverse-proxy non-API `/__byok-api__/*` requests to Vite. Preserve the request path and query string. Do not configure Vite to proxy management API requests back to Rust.
- Configure Vite's base path as `/__byok-api__/` so generated assets, module imports, and development client URLs stay under the reserved namespace.
- Bind the development Vite server to an explicit loopback address compatible with the Rust proxy target; do not rely on `localhost` resolving to the same IP family.
- Open external detail pages with their normal loopback HTTP URL and hash route. Because the page and API are same-origin, do not add Tauri URL workarounds, API-origin query parameters, or CORS-dependent browser flows.
- Use Tauri commands only for native desktop capabilities such as opening Terminal, tray integration, or operating-system actions. Do not create IPC mirrors for HTTP business APIs.

## Component boundaries

- Keep Provider, Model, Call, Usage, and persisted settings state outside presentation components.
- Let components receive business snapshots and dispatch actions. Local React state is allowed for transient UI behavior such as focus, open state, drag state, and input drafts.
- Split pages, layouts, charts, forms, and reusable controls into focused components. Do not collect an entire feature set in `App.tsx`.
- Keep `App.tsx` as the route composition root.

## Design tokens

- Theme styles must reference the Graphite `--oa-*` tokens from `src/styles/_themes.scss`; never reintroduce `--vscode-*` variables or hardcode greys that a theme cannot override.
- Surfaces: `--oa-surface` (app base), `--oa-surface-sunken` (insets), `--oa-surface-raised` (cards/tables), `--oa-surface-overlay` (menus, tooltips, dialogs), `--oa-surface-input`, `--oa-surface-code`. Text: `--oa-text`, `--oa-text-secondary`, `--oa-text-muted`, `--oa-text-on-accent`. State: `--oa-hover`, `--oa-active`, `--oa-border`. Status: `--oa-accent`, `--oa-accent-hover`, `--oa-success`, `--oa-warning`, `--oa-danger`.
- Use exactly one accent color: `--oa-accent` is the only blue; focus outlines, links, primary buttons, and active states all derive from it.
- Corner radii come from `--oa-radius-sm/md/lg`, `--oa-card-radius`, and `--oa-overlay-radius`; borders stay at 1px.
- Numbers for tokens, cost, ports, and timings use the mono number font (`--oa-number-font`) or tabular digits, which are already enabled app-wide via `font-variant-numeric: tabular-nums`.

## Page layout

- Build every full-height page with `shell/layout/PageLayout.tsx`; do not hand-roll page shells with grid rows.
- The app shell is `shell/IconRail.tsx` + `shell/PageFrame.tsx` inside `shell/AppLayout.tsx`. The icon rail owns primary navigation; do not add a second menu, sidebar card, or tab bar for page switching.
- The fixed top bar owns the page title, the page-action regions, the refresh control, and the proxy status indicator. Put page-level commands (create, import, export, filtering, sorting, view options) in `PageActions` so they portal into the top bar; keep only item-level operations (edit, delete) inside the item's row. Do not add duplicate action bars or panel-header controls inside page content.
- Declare the page title through `PageContent`'s `title` prop; it portals into the top bar through `PageTitle`. Do not render a competing in-content page title.
- Never render a title region above a data table or flat data list. Use the page title for context, keep column labels in the table header, place page-level controls in `PageActions`, and wrap the table in a titleless `Card`. A hierarchy label that identifies parent data in a grouped parent-child view is not a table title.
- Keep the main scroll viewport below the fixed top bar (`margin-top: var(--app-content-top)` on the content region); reserve space with layout margins, never by shortening or offsetting the scroll viewport itself.
- Keep the icon rail fixed and reserve it with the content area's `margin-left: var(--app-rail-width)`; do not place rail, top bar, and content in a flow grid.
- Do not use child or section padding to create external spacing. Use flex/grid gaps between siblings and margins or fixed offsets at container boundaries.
- Use a vertical flex layout with these invariants:
  - Header: `flex: 0 0 auto`.
  - Footer: `flex: 0 0 auto`.
  - Content: `flex: 1 1 auto`, `min-height: 0`, and `overflow: hidden`.
- Keep Header and Footer outside the scroll viewport. They must never grow or shrink with content.
- Apply window-corner safe-area variables (`--window-corner-safe-bottom`) only to edge chrome that can enter native rounded corners, such as the bottom of the icon rail.
- Keep macOS traffic-light space and the top fixed drag strip free of interactive controls. The top bar is a `data-tauri-drag-region`; interactive children inside it must opt out with `-webkit-app-region: no-drag`.
- Avoid decorative brand text and explanatory copy when it does not help the user perform an action or interpret state.

## Typography

- Write component styles in SCSS and source every `font-size` from `src/styles/_typography.scss`; never hardcode a font size in SCSS, React styles, or chart options.
- Use `base` for normal UI text and ordinary titles, including title bars, panels, cards, and section headings. Do not increase a font merely because its element is `h1` or `h2`.
- Use `xs` only for secondary information. Reserve `lg` for an explicitly oversized display title; do not use it for routine headings.
- Audit all typography-token usages after changing the scale, not only raw numeric font sizes.

## Scrolling and virtualization

- Use `shell/layout/VirtualPage.tsx` for vertically scrolling page content.
- Use `shared/virtual/VirtualList.tsx` for data collections and menus that can grow.
- Treat `ScrollArea` as the low-level primitive owned by the virtual scrolling implementation. Do not import `ScrollArea` directly in pages or layouts.
- Use the global `scroll-shadow-top` and `scroll-shadow-bottom` masks for scroll-edge shadows. When a scroll content inset reserves an absolute overlay, source the top shadow distance from the same CSS variable as its `padding-top`.
- Model non-list pages as a short sequence of measurable top-level virtual sections.
- Do not use document scrolling, native page `overflow: auto`, or nested vertical scroll containers.
- Ensure every flex/grid ancestor of a virtual viewport has `min-height: 0` and the viewport has an explicit bounded height.

## Routing and pages

- Use `HashRouter` for Tauri compatibility.
- Top-level routes: `/` (Overview), `/calls`, `/providers`, `/cursor`, `/settings/:section`; `/settings` redirects to the default section. `/calls/:callId` stays outside `AppFrame` for the external detail window.
- Expose every primary page through `shell/IconRail.tsx`; Settings stays pinned at the bottom of the rail.
- Add every kept-alive route to the `keptAlivePages` list in `shell/AppLayout.tsx`; normalize the `activeCacheKey` for parameterized routes (settings sections share one cached page).
- Keep route content independent of the window Header and Footer.

## Command palette

- `shell/CommandPalette.tsx` opens on Ctrl+K/Cmd+K and the rail search button. It covers pages, providers, models, and settings sections; keep its item sources in sync when routes or settings sections change.

## Charts

- Use ECharts through `features/home/charts/EChart.tsx`.
- Register only required ECharts Core charts, components, and renderers.
- Keep chart components declarative: accept domain data and construct an option without fetching or persisting data.
- Let `ResizeObserver` resize the chart with its layout container and dispose the instance on unmount.

## Validation

Run from `apps/desktop`:

```bash
npm run check
npm run tauri:build -- --debug --no-bundle
```

Verify that the top bar and icon rail remain fixed, only the virtual content viewport scrolls, settings sections remain reachable at minimum window size, and macOS controls stay outside rounded-corner and traffic-light unsafe regions.
