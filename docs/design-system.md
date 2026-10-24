# AI Browser design system

One design system for every surface this repository draws:

| Surface | Stylesheets | Colour source |
|---|---|---|
| **Chat** (VS Code webview; the same renderer in the Chrome side panel and on the Exchange website) | `media/chat.css`, `preview-src/chat.ts` | `--vscode-*` only |
| **Legacy panel** | `media/main.css` | `--vscode-*` only |
| **Shells** (Chrome side panel chrome, website chat shell) | `chrome-extension/sidepanel.css`, `exchange-server/chat-assets/web-chat.css` | the shell's own faked `--vscode-*` root, then `--ds-*` |
| **Website** | `exchange-server/apps/web/app/style.css`, `chat-theme.css`, `*.tsx` | `chat-theme.css` aliases (`--fg`, `--bad`, …), then `--ds-*` |

It extends the control standard (`--ctl-*`, already applied; unchanged here). New tokens are named `--ds-*`. Every surface defines the same `--ds-*` names on its own root, mapped to the variables it already has; shared rules read only `--ds-*` and `--ctl-*`.

Rules that hold everywhere:

- **No colour literal outside a token definition.** In the chat and the legacy panel a token resolves to a `--vscode-*` variable (with a literal fallback only inside `var()`), so light, dark and both high-contrast themes keep working.
- **Class names and ids that scripts use are not renamed.** Changes are CSS properties, new modifier classes, and ARIA attributes.
- **Sizes in the chat stay relative where they are relative today** (`em`), because the chat follows the editor font size. The px values below are the reference at a 13px base; the chat uses the `em` column.

---

## 1. Tokens

### 1.1 Spacing

| Token | Value | Use |
|---|---|---|
| `--ds-space-1` | 4px | icon-to-text inside dense rows, chip gaps, popup inner padding |
| `--ds-space-2` | 6px | gap between controls (`= --ctl-gap`), notice vertical padding |
| `--ds-space-3` | 8px | menu item horizontal padding, notice gap, header gap |
| `--ds-space-4` | 12px | notice horizontal padding, bar padding, card gap |
| `--ds-space-5` | 16px | panel/dialog padding, section gap |
| `--ds-space-6` | 24px | card padding (website), empty-state padding, page sections |

No other spacing values in new rules. Existing odd values (14px, 26px, 28px, 47px, 30px) move to the nearest step when touched (see the change lists).

### 1.2 Radius

| Token | Value | Use |
|---|---|---|
| `--ds-radius-sm` | 4px | tooltip, checkbox (`= --ctl-radius-sm`), inline code, close button in a notice |
| `--ds-radius` | 6px | controls (`= --ctl-radius`), notices, alerts, menu items, chips-as-squares, code blocks |
| `--ds-radius-md` | 8px | popups, menus, dialogs on the shells, cards in the chat |
| `--ds-radius-lg` | 12px | website cards, website popovers and dialogs |
| `--ds-radius-pill` | 999px | chips, badges, pills, status dots (`50%` stays valid for circles) |

`--radius` (chat 8px) and `--radius-lg` (12px) keep existing; they now alias `--ds-radius-md` and `--ds-radius-lg`. Values 3px, 5px, 7px, 10px and 16px are retired.

### 1.3 Type

| Token | px (ref.) | chat (`em`) | Weight | Line height | Use |
|---|---|---|---|---|---|
| `--ds-text-xs` | 11px | 0.85em | 400 | 1.4 | badges, tags, shortcut hints, header status; **floor** — nothing smaller |
| `--ds-text-sm` | 12px | 0.92em | 400 | 1.45 | notices, alerts, menu descriptions, field errors, muted text, controls (`= --ctl-font`) |
| `--ds-text-body` | 13px | 1em | 400 | 1.55 (`--line`) | body text, chat prose |
| `--ds-text-h4` | 13px | 1.05em | 600 | 1.35 | panel titles, menu headings when not uppercase, card titles in the chat |
| `--ds-text-h3` | 15px | 1.12em | 600 | 1.3 | empty-state titles, dialog titles |
| `--ds-text-h2` | 18px | 1.2em | 600 | 1.25 | website card titles, pairing title |
| `--ds-text-h1` | 22px | 1.3em | 600 | 1.2 | website page titles only |

- `--ds-weight-regular: 400`, `--ds-weight-medium: 500`, `--ds-weight-strong: 600`. 700 is reserved for chat Markdown headings and bold text inside prose (they render model output and keep their own scale, see §4).
- `--ds-leading-tight: 1.25`, `--ds-leading: 1.45`, `--ds-leading-prose: 1.55`.
- `--ds-tracking-label: .06em` — the one letter-spacing for uppercase labels (`.panel-tag`, `.panel-label`, `.menu-heading` when uppercase). Headings use `0` (the website's `-0.4px` on 18px stays as `--ds-tracking-heading: -0.02em`, applied only to h1/h2).
- Retired sizes: 8px, 9px, 10px (raised to `--ds-text-xs`), 0.8em, 0.88em, 0.9em, 0.95em (mapped to the nearest token), 17px (→ h2 18px).
- Mono: `--mono` stays; mono size is `--mono-size` in the chat, `--ds-text-sm` elsewhere.

### 1.4 Shadows

| Token | Value | Use |
|---|---|---|
| `--ds-shadow-tip` | `0 2px 8px var(--ds-shadow-color)` | tooltip, floating error inside a viewport |
| `--ds-shadow-popup` | `0 8px 24px var(--ds-shadow-color)` | popup, menu, popover, toast |
| `--ds-shadow-modal` | `0 16px 48px var(--ds-shadow-color)` | dialog, modal panel |
| `--ds-shadow-color` | chat/panel: `var(--vscode-widget-shadow, rgba(0,0,0,.36))`; shells: `var(--vscode-widget-shadow)`; website: `var(--vscode-widget-shadow, #00000066)` |
| `--ds-backdrop` | `color-mix(in srgb, var(--ds-shadow-color) 60%, transparent)` | `dialog::backdrop`, scrim |

In high-contrast themes (`body.vscode-high-contrast*`) shadows are `none` and the border carries the edge (`--vscode-contrastBorder`).

### 1.5 Z-index layers

| Token | Value | Layer |
|---|---|---|
| `--ds-z-sticky` | 10 | sticky prompts, sticky headers |
| `--ds-z-popup` | 30 | popup, menu, popover (website account popover) |
| `--ds-z-panel` | 40 | full-view panels (History, Agents, settings) |
| `--ds-z-popup-over-panel` | 45 | a menu opened from inside a panel |
| `--ds-z-palette` | 50 | palette over the skill editor |
| `--ds-z-toast` | 55 | toasts |
| `--ds-z-tooltip` | 60 | tooltips (always on top) |

Native `<dialog>` uses the top layer and needs no z-index. The order is the existing one, now named.

### 1.6 Semantic colours

Each tone has a foreground (text, icon, border) and a soft background. Soft backgrounds are always the tone at **10%** over transparent; borders of a toned surface at **35%**.

| Token | Chat / legacy panel (`--vscode-*`) | Shells (faked root) | Website (`chat-theme.css`) |
|---|---|---|---|
| `--ds-accent` | `var(--vscode-focusBorder)` (= `--accent`) | `var(--vscode-focusBorder)` | `var(--accent)` |
| `--ds-danger` | `var(--vscode-errorForeground, #f85149)` (= `--bad`) | `var(--vscode-errorForeground)` | `var(--bad)` |
| `--ds-warning` | `var(--vscode-editorWarning-foreground, #cca700)` (= `--warn`) | `var(--vscode-editorWarning-foreground, #cca700)` — **add** to the faked root | `var(--warn)` — **add** `--warn` to `chat-theme.css` as `var(--vscode-editorWarning-foreground, #cca700)` |
| `--ds-success` | `var(--vscode-charts-green, #89d185)` (= `--ok`) | `var(--vscode-charts-green, #3fb950)` — **add** | `var(--ok)` |
| `--ds-info` | `var(--vscode-editorInfo-foreground, #3794ff)` | `var(--vscode-editorInfo-foreground, #3794ff)` — **add** | `var(--info)` — **add** as `var(--vscode-editorInfo-foreground, #3794ff)` |
| `--ds-muted` | `var(--vscode-descriptionForeground)` (= `--fg-3`) | `var(--vscode-descriptionForeground)` | `var(--fg-3)` |
| `--ds-<tone>-soft` | `color-mix(in srgb, var(--ds-<tone>) 10%, transparent)` | same | same |
| `--ds-<tone>-line` | `color-mix(in srgb, var(--ds-<tone>) 35%, transparent)` | same | same |
| `--ds-surface-raised` | `var(--elevated)` | `var(--vscode-editorWidget-background)` | `var(--elevated)` |
| `--ds-divider` | `var(--border)` | `var(--border)` | `var(--border)` |

Muted text has **one** token, `--ds-muted`. `--fg-2` (65%) stays for de-emphasised but still primary text (approval heads, chip labels); `--fg-faint` (40%) is for **decoration only** (icons, empty-state glyphs, dividers), never for text a user must read.

In high-contrast themes every toned surface also gets `border: 1px solid var(--vscode-contrastBorder)`; a soft background alone is invisible there.

### 1.7 Motion

`--ds-duration-fast: .12s`, `--ds-duration: .18s`, `--ds-duration-slow: .3s`, easing `--ease` (chat) / `cubic-bezier(.2,.8,.2,1)` elsewhere as `--ds-ease`. Under `@media (prefers-reduced-motion: reduce)` every `--ds-duration-*` is `0s`, entrance animations (fade, pop-in, slide) are removed, and only state changes remain. Continuous indicators (spinners, the liquid loader, blinking dots) follow their own reduced-motion rules, which already exist and stay.

---

## 2. Per-surface root blocks

Each surface defines the tokens once. Example for the chat (`media/chat.css`, after the `--ctl-*` block):

```css
:root {
  --ds-space-1: 4px; --ds-space-2: 6px; --ds-space-3: 8px;
  --ds-space-4: 12px; --ds-space-5: 16px; --ds-space-6: 24px;
  --ds-radius-sm: 4px; --ds-radius: 6px; --ds-radius-md: 8px;
  --ds-radius-lg: 12px; --ds-radius-pill: 999px;
  --ds-text-xs: .85em; --ds-text-sm: .92em; --ds-text-body: 1em;
  --ds-text-h4: 1.05em; --ds-text-h3: 1.12em; --ds-text-h2: 1.2em; --ds-text-h1: 1.3em;
  --ds-weight-regular: 400; --ds-weight-medium: 500; --ds-weight-strong: 600;
  --ds-leading-tight: 1.25; --ds-leading: 1.45; --ds-leading-prose: var(--line);
  --ds-tracking-label: .06em;
  --ds-shadow-color: var(--vscode-widget-shadow, rgba(0,0,0,.36));
  --ds-shadow-tip: 0 2px 8px var(--ds-shadow-color);
  --ds-shadow-popup: 0 8px 24px var(--ds-shadow-color);
  --ds-shadow-modal: 0 16px 48px var(--ds-shadow-color);
  --ds-backdrop: color-mix(in srgb, var(--ds-shadow-color) 60%, transparent);
  --ds-z-sticky: 10; --ds-z-popup: 30; --ds-z-panel: 40; --ds-z-popup-over-panel: 45;
  --ds-z-palette: 50; --ds-z-toast: 55; --ds-z-tooltip: 60;
  --ds-accent: var(--accent); --ds-danger: var(--bad); --ds-warning: var(--warn);
  --ds-success: var(--ok); --ds-info: var(--vscode-editorInfo-foreground, #3794ff);
  --ds-muted: var(--fg-3);
  --ds-accent-soft:  color-mix(in srgb, var(--ds-accent) 10%, transparent);
  --ds-danger-soft:  color-mix(in srgb, var(--ds-danger) 10%, transparent);
  --ds-warning-soft: color-mix(in srgb, var(--ds-warning) 10%, transparent);
  --ds-success-soft: color-mix(in srgb, var(--ds-success) 10%, transparent);
  --ds-info-soft:    color-mix(in srgb, var(--ds-info) 10%, transparent);
  --ds-danger-line:  color-mix(in srgb, var(--ds-danger) 35%, transparent);
  --ds-warning-line: color-mix(in srgb, var(--ds-warning) 35%, transparent);
  --ds-success-line: color-mix(in srgb, var(--ds-success) 35%, transparent);
  --ds-info-line:    color-mix(in srgb, var(--ds-info) 35%, transparent);
  --ds-surface-raised: var(--elevated); --ds-divider: var(--border);
  --ds-duration-fast: .12s; --ds-duration: .18s; --ds-duration-slow: .3s;
  --radius: var(--ds-radius-md); --radius-lg: var(--ds-radius-lg);
}
@media (prefers-reduced-motion: reduce) {
  :root { --ds-duration-fast: 0s; --ds-duration: 0s; --ds-duration-slow: 0s; }
}
body.vscode-high-contrast, body.vscode-high-contrast-light {
  --ds-shadow-tip: none; --ds-shadow-popup: none; --ds-shadow-modal: none;
}
```

The website and shells use the px column for `--ds-text-*` and their own colour sources (§1.6). The legacy panel needs only spacing, radius, `--ds-text-xs` and the colour tones it uses.

---

## 3. Components

Metrics are exact. "Tone" means one of `danger`, `warning`, `success`, `info` (plus `neutral` where stated), each reading `--ds-<tone>`, `--ds-<tone>-soft`, `--ds-<tone>-line`.

### 3.1 Alert / banner

Full-width or block message about state of the whole view or form.

- Box: `display: flex; gap: var(--ds-space-3); align-items: flex-start; padding: var(--ds-space-2) var(--ds-space-4)` (6px 12px); `border: 1px solid var(--ds-<tone>-line); border-radius: var(--ds-radius); background: var(--ds-<tone>-soft); color: var(--ctl-fg); font-size: var(--ds-text-sm); line-height: var(--ds-leading)`.
- Edge-to-edge bar variant (`.ds-banner--bar`, under a header): `border-radius: 0; border-width: 0 0 1px`; padding `var(--ds-space-3) var(--ds-space-4)` (8px 12px).
- Icon: codicon 16px (`error`, `warning`, `pass`, `info`) in `color: var(--ds-<tone>)`, `margin-top: 1px`, `flex: none`, `aria-hidden="true"`.
- Content: optional title (`font-weight: var(--ds-weight-strong)`, same size), body (`color: var(--ctl-fg)`; the tone colour is **not** used for body text, only for icon and border, so contrast holds on every theme).
- Actions: row of `--ctl-h-sm` buttons, `gap: var(--ds-space-2)`, `margin-top: var(--ds-space-1)`.
- Close: icon button `--ctl-h-sm` (24×24), `margin: -3px -6px 0 auto`, ghost, codicon `close` 14px, `aria-label="Dismiss <what>"` (e.g. "Dismiss browser error"); focus ring per `--ctl-ring`. Never a text glyph `×`/`✕`.
- Roles: `danger` → `role="alert"`; other tones → `role="status"` (implicit polite). Never set `aria-live` additionally. A banner that explains a mode and is opened on demand uses `role="note"` and its toggle gets `aria-controls` + `aria-expanded`.
- Neutral tone: `background: var(--soft); border-color: var(--ds-divider)`.

### 3.2 Field error

- Invalid control (`input`, `select`, `textarea` with `aria-invalid="true"`): `border-color: var(--ds-danger)`; on `:focus-visible` `outline: 1px solid var(--ds-danger); outline-offset: var(--ctl-ring-offset)` (replaces the accent ring, same thickness); no background change.
- Message: element directly after the control (or its wrapper), `display: flex; gap: var(--ds-space-1); margin-top: var(--ds-space-1); font-size: var(--ds-text-sm); line-height: var(--ds-leading); color: var(--ds-danger)`; codicon `error` 14px optional. Empty → `display: none` (`:empty`).
- Wiring: message has a stable `id`; control gets `aria-invalid="true"` and `aria-describedby="<id>"` (appended to any existing hint id). The message itself has **no** `role` — announcement comes from the summary (§3.3) on submit, or from focus moving to the field. Exception: a single-field form with no summary uses `role="alert"` on its message.
- One red: `--ds-danger` everywhere. `--vscode-inputValidation-error*` is not used.

### 3.3 Form error summary

Shown when a submit fails with more than one invalid field, or with an error not tied to a field (server answer).

- Alert §3.1, tone `danger`, at the top of the form, `margin-bottom: var(--ds-space-4)`, `role="alert"`, `tabindex="-1"`.
- Title: "Fix N fields" or the server message. Body: a list (`margin: var(--ds-space-1) 0 0; padding-left: var(--ds-space-5)`) of buttons styled as links (`color: var(--ds-accent)`; underline on hover) naming each field; activating one focuses that field.
- Errors not tied to a field appear here only.

### 3.4 Toast

Transient confirmation. Allowed in the website and the shells. **In the chat and anything near the VS Code browser, a confirmation goes to the status bar (`confirm()`), never a toast** — see CLAUDE.md "A notification pauses the built-in browser".

- Position: `position: fixed; bottom: var(--ds-space-5); left: 50%; transform: translateX(-50%); z-index: var(--ds-z-toast); max-width: min(420px, calc(100vw - 32px))`.
- Box: `padding: var(--ds-space-3) var(--ds-space-4); border-radius: var(--ds-radius-md); background: var(--ds-surface-raised); border: 1px solid var(--border-strong); box-shadow: var(--ds-shadow-popup); font-size: var(--ds-text-sm)`; icon 16px in the tone colour.
- `role="status"`; auto-hides after 4s (6s with an action); hover or focus inside pauses the timer; Escape closes. Error toasts are not allowed — errors are alerts.
- Enter: opacity + 4px rise over `--ds-duration`; none under reduced motion.
- Small inline copy feedback ("Copied") is not a toast: §3.5.

### 3.5 Inline notice / status line

One line of feedback next to what caused it (copy feedback, "Saved", paste status, commit notice).

- `font-size: var(--ds-text-sm); line-height: var(--ds-leading); color: var(--ds-muted)`; tone modifiers `.is-success` (`--ds-success`), `.is-warning` (`--ds-warning`), `.is-danger` (`--ds-danger`). Optional leading codicon 14px.
- Boxed variant (`.ds-notice`, e.g. `.control-refusal`, `.voice-error`): alert §3.1 metrics with `margin: var(--ds-space-2) var(--ds-space-4) 0`, plus a close button. **Click-anywhere-to-dismiss is removed**; the box is not interactive.
- Role: `role="status"` for neutral/success/warning; danger tone → `role="alert"`.
- Thread rows in the chat (`.row.notice`, `.row.error`) keep their timeline layout; only size (`--ds-text-sm`) and roles (`.row.error` → `role="alert"` on insertion, `.row.notice` none) change.

### 3.6 Confirm card / popover

A question that needs an answer before something destructive.

- Container: `display: flex; flex-wrap: wrap; align-items: center; gap: var(--ds-space-2); padding: var(--ds-space-2) var(--ds-space-3); border: 1px solid var(--ds-divider); border-radius: var(--ds-radius); background: var(--soft); font-size: var(--ds-text-sm)`. As a popover: §3.8 metrics.
- Text first, then buttons right-aligned (`margin-left: auto` on the first button).
- Buttons: `--ctl-h-sm`; **default is the safe answer**: Cancel/No is the focused button and receives focus when the card opens. Danger button: secondary metrics with `color: var(--ds-danger); border-color: var(--ds-danger-line)`; hover `background: var(--ds-danger-soft)`. (New `--ctl` danger variant, see §3.20.)
- `role="alertdialog"`, `aria-labelledby` → the question text, `aria-describedby` → detail text if any. Escape answers Cancel and returns focus to the trigger.

### 3.7 Menu

- Container: popup §3.8, `role="menu"`, width 260px (chat) / 250px (website), `max-height: 60vh; overflow-y: auto`.
- Item: `min-height: var(--ctl-h); padding: 0 var(--ds-space-3); gap: var(--ds-space-3); border-radius: var(--ds-radius-sm); font-size: var(--ds-text-sm)`; icon column 16px; hover/focus `background: var(--vscode-list-hoverBackground)` (website: `--soft-2`); disabled `opacity: var(--ctl-disabled-opacity)` with `aria-disabled="true"`. `role="menuitem"`, or `menuitemradio`/`menuitemcheckbox` with `aria-checked` when a check icon shows state.
- Description: `font-size: var(--ds-text-xs); color: var(--ds-muted)`. Shortcut: `margin-left: auto; font-size: var(--ds-text-xs); color: var(--ds-muted)`.
- Heading: `padding: var(--ds-space-1) var(--ds-space-3); font-size: var(--ds-text-xs); color: var(--ds-muted); letter-spacing: var(--ds-tracking-label)`; group with `role="group"` + `aria-labelledby`.
- Note: `padding: 2px var(--ds-space-3) var(--ds-space-2); font-size: var(--ds-text-xs); max-width: 100%`.
- Separator: `height: 1px; margin: var(--ds-space-1) 0; background: var(--ds-divider); role="separator"`.
- Keys: ↑/↓ move, Home/End, Enter/Space activate, Escape closes and returns focus to the trigger. Opening from the keyboard focuses the first enabled item.

### 3.8 Popup / popover

- `position: absolute; z-index: var(--ds-z-popup); padding: var(--ds-space-1); border-radius: var(--ds-radius-md); background: var(--ds-surface-raised); color: var(--vscode-menu-foreground, var(--ctl-fg)); border: 1px solid var(--vscode-menu-border, var(--border-strong)); box-shadow: var(--ds-shadow-popup)`. Website popovers: radius `--ds-radius-lg`, padding `var(--ds-space-4)`.
- Enter: pop-in (opacity + scale .98) over `--ds-duration`; none under reduced motion.
- Dismiss: Escape, click outside, choosing an item. Focus returns to the trigger. Trigger has `aria-haspopup` (`menu`, `dialog` or `listbox`) and `aria-expanded`.
- A `<details>` disclosure used as a popover (website account) must add Escape and outside-click close in script, and `aria-haspopup` on its `summary`.

### 3.9 Tooltip

- `z-index: var(--ds-z-tooltip); max-width: min(320px, calc(100% - 8px)); padding: var(--ds-space-1) var(--ds-space-3); border-radius: var(--ds-radius-sm); background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: var(--ds-shadow-tip); font-size: var(--ds-text-sm); line-height: var(--ds-leading); white-space: pre-line`.
- Delay 450ms on hover, immediate on keyboard focus; hidden on Escape, press, scroll, pointer leave.
- `role="tooltip"` with an `id`; the anchor gets `aria-describedby` while shown. A tooltip never carries the only accessible name: icon buttons still need `aria-label`.
- One system per surface: in the chat, the drawn tooltip (`hoverTip`/`data-tip`). Native `title` only where a drawn one cannot run (shell selects, website controls) and never on an element that also has `data-tip`.

### 3.10 Panel / modal

- Full-view panel (chat History, Agents, settings): `position: absolute; inset: 0; z-index: var(--ds-z-panel); background: var(--bg)`; head `min-height: var(--ctl-h-lg); padding: 0 var(--ds-space-3); gap: var(--ds-space-2); border-bottom: 1px solid var(--ds-divider)`; title `font-size: var(--ds-text-h4); font-weight: var(--ds-weight-strong)`; back and close are ghost icon buttons `--ctl-h` with `aria-label`.
- Dialog (`<dialog>`, shells and website): `width: min(560px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); padding: var(--ds-space-5); border-radius: var(--ds-radius-lg)` (shells: `--ds-radius-md`); `background: var(--bg); border: 1px solid var(--border-strong); box-shadow: var(--ds-shadow-modal)`; `::backdrop { background: var(--ds-backdrop) }`. Wide content (attachment preview) `width: min(720px, 85vw)`.
- Head: title as a real heading (`h2`, `--ds-text-h3`), close icon button top-right; body; footer buttons right-aligned, `gap: var(--ds-space-2)`, primary last.
- ARIA: `role="dialog"` (implicit for `<dialog>`), `aria-modal="true"` for modal ones, `aria-labelledby` → title id. Focus moves to the first focusable element (or the dialog itself when only text) on open, is trapped while modal, and returns to the trigger on close. Escape closes.

### 3.11 Card

- Chat (approval, switch card, question dock): `padding: var(--ds-space-3) var(--ds-space-4); border: 1px solid var(--ds-divider); border-radius: var(--ds-radius-md); background: var(--soft)`.
- Website (`.card`, `.point-card`, `.create-card`): `padding: var(--ds-space-6); border: 1px solid var(--border-strong); border-radius: var(--ds-radius-lg); background: var(--vscode-editor-background)`; hover `border-color: color-mix(in srgb, var(--fg) 20%, transparent)`; `:focus-within` adds the `--ctl-ring` outline. Title `--ds-text-h2`/`--ds-weight-strong`/`--ds-tracking-heading`; meta row `gap: var(--ds-space-3)`.
- A card's state is never colour-only: its heading or a badge says it (Pending, Allowed, Denied).
- **Each selector is defined once.** Duplicated blocks are merged (change lists).

### 3.12 Tabs

- Strip: `display: flex; gap: 2px; border-bottom: 1px solid var(--ds-divider)`; `role="tablist"` with `aria-label`.
- Tab: `min-height: var(--ctl-h); padding: 0 var(--ds-space-3); border-radius: var(--ds-radius) var(--ds-radius) 0 0; color: var(--ds-muted); border-bottom: 2px solid transparent`; selected `color: var(--ctl-fg); border-bottom-color: var(--ds-accent)`. `role="tab"`, `aria-selected`, `aria-controls`; roving `tabindex` (←/→, Home/End).
- Navigation that changes the page (website mobile workspace tabs) is **not** a tablist: keep `aria-current="page"` on links/buttons in a `nav` with `aria-label`. Pick one per instance; do not mix.
- Close button on a tab: ghost icon button 16×16 visual inside a 20×20 hit area, `aria-label="Close <tab title>"`. Status marks inside a tab are `aria-hidden` and the status is part of the tab's `aria-label` ("Fix login — working").

### 3.13 Badge / counter

- `.ds-badge`: `display: inline-flex; align-items: center; gap: var(--ds-space-1); height: 18px; min-width: 18px; padding: 0 var(--ds-space-2); border-radius: var(--ds-radius-pill); font-size: var(--ds-text-xs); font-weight: var(--ds-weight-medium); line-height: 1; background: var(--soft-2); color: var(--ds-muted); border: 1px solid var(--ds-divider)`.
- Tones: `color: var(--ds-<tone>); background: var(--ds-<tone>-soft); border-color: var(--ds-<tone>-line)`.
- Status pill (website `.status`, Chrome `#mode`): same, `height: var(--ctl-h-sm)`, with a 6px dot (§3.15) before the text.
- Counter on an icon (tab corner, agents button): `height: 14px; min-width: 14px; padding: 0 3px; font-size: 9px` is **forbidden** — use `height: 16px; min-width: 16px; padding: 0 4px; font-size: var(--ds-text-xs)`, cap at `99+`. The count goes into the owner's `aria-label`; the badge is `aria-hidden`.
- A badge whose value changes and matters (online/offline) sits inside a `role="status"` region or the change is announced by its container.

### 3.14 Chip

- `height: var(--ctl-h-sm); padding: 0 var(--ds-space-2) 0 var(--ds-space-1); gap: var(--ds-space-1); border-radius: var(--ds-radius-pill); background: var(--soft-2); border: 1px solid var(--ds-divider); font-size: var(--ds-text-sm)`. Small: `height: 20px; font-size: var(--ds-text-xs)`. Suggested: `border-style: dashed; background: transparent`.
- Icon 14px. Label `max-width: 160px` with ellipsis.
- Remove/add button: visual 16px, hit area 24px (`padding` + negative margin), `aria-label="Remove <label>"` / `"Attach <label>"`; the long prose stays in `data-tip`.

### 3.15 Status dot

- `width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ds-<tone>)`; neutral `var(--ds-muted)`. Inside a badge, `margin-right: 2px`.
- Running/working: accent with the existing blink, still under reduced motion.
- Meaning is never colour-only: the dot is `aria-hidden` and text or an `aria-label` next to it says the state.
- **Failed is `--ds-danger` everywhere** (tab marks included); orange (`--ds-warning`) means waiting/needs attention; green unread/done.

### 3.16 Empty state

- `.ds-empty`: `display: grid; justify-items: center; gap: var(--ds-space-2); padding: var(--ds-space-6) var(--ds-space-4); text-align: center; color: var(--ds-muted)`.
- Icon 32px in `--fg-faint` (`aria-hidden`); title `--ds-text-h3` / `--ds-weight-strong` / `color: var(--ctl-fg)`; text `--ds-text-sm` / `--ds-leading-prose`, `max-width: 300px`; action buttons `margin-top: var(--ds-space-2)`.
- Website variant with a frame: `border: 1px dashed var(--border-strong); border-radius: var(--ds-radius-lg)`.
- Short "nothing here" lines inside lists (history empty, palette "Nothing matches"): `padding: var(--ds-space-3); font-size: var(--ds-text-sm); color: var(--ds-muted)` — one class, `.ds-empty-line`.
- A waiting state that can fail must change its text when it does (e.g. "Waiting…" → "Could not reach the workspace").

### 3.17 Headings

| Level | Token | Use |
|---|---|---|
| h1 | `--ds-text-h1` | website page title |
| h2 | `--ds-text-h2` | website card titles, Chrome pairing title |
| h3 | `--ds-text-h3` | dialog titles, empty-state titles, welcome title |
| h4 | `--ds-text-h4` | panel titles, section titles inside panels/settings |

All `--ds-weight-strong`, `margin: 0`; spacing comes from the container (`gap`). Visual titles are real headings or have `role="heading"` + `aria-level`. Chat Markdown headings keep their own 700-weight colour ramp (§4).

### 3.18 Muted / small text

- Secondary text: `color: var(--ds-muted)`; size `--ds-text-sm`; never below `--ds-text-xs` (11px / .85em).
- Uppercase labels: `font-size: var(--ds-text-xs); letter-spacing: var(--ds-tracking-label); text-transform: uppercase; color: var(--ds-muted)`.
- An informational line is never link-coloured unless it is a link.

### 3.19 Code

- Inline code: `font-family: var(--mono); font-size: .92em; padding: 1px var(--ds-space-1); border-radius: var(--ds-radius-sm); background: var(--code-bg)` (shells: `var(--vscode-textCodeBlock-background)`).
- Block: `padding: var(--ds-space-3) var(--ds-space-4); border: 1px solid var(--ds-divider); border-radius: var(--ds-radius); background: var(--code-bg); font-size: var(--mono-size, var(--ds-text-sm)); line-height: var(--ds-leading)`; margins `var(--ds-space-4) 0`.
- Copyable secret/value block (website `.secret > code`, Chrome `#extension-id`): block metrics, `color: var(--ctl-fg)` (not link colour), `user-select: all; overflow-wrap: anywhere`, monospaced.
- Chat `--io-bg`: mixed towards the theme's foreground-opposite rather than black: `color-mix(in srgb, var(--code-bg) 78%, var(--vscode-editor-background))` — darker on dark, unchanged-to-lighter on light.

### 3.20 Danger button (addition to the control standard)

`--ctl` secondary metrics, `color: var(--ds-danger); border-color: var(--ds-danger-line)`; hover `background: var(--ds-danger-soft); border-color: var(--ds-danger)`. Primary danger (only for the final confirm in a modal): `background: var(--vscode-inputValidation-errorBorder, var(--ds-danger)); color: var(--vscode-button-foreground)`. Class `.ctl-danger`; existing `.confirm-danger`, `.point-confirm-yes` adopt it.

---

## 4. Exceptions — do not change

These stay exactly as they are; no token may be applied to them.

1. **The chat's plan-limit line** (`.usage-alert`, `.usage-alert-text`, `.u-mark`): fixed `#ffd43b` with black text in every theme, asked for. Only the close button's missing focus indicator is fixed (an outline in `#000`, which reads on that yellow) and it gets an `aria-label`. The Chrome `#mode-details[data-mode=limited]` copy of this yellow (`#ffd43b` / `#000` / `#e0b400`) is the same exception and is named in a local custom property (`--plan-limit-bg`, `--plan-limit-fg`, `--plan-limit-line`) defined next to it, values unchanged.
2. **The crosshair icons** (`media/icons/crosshair-*.svg` and the grid `check-manifest` enforces): their dot and ring colours are fixed per kind and destination.
3. **The liquid loader** (`media/liquid-loader.css`, generated by `scripts/build-liquid-loader.mjs`): shape, colours, size defaults and reduced-motion behaviour.
4. **The effort slider colours** (silver-grey / sky-blue / pale-violet, yellow for Max, peach-orange for Ultra/Super/Extreme) and the Ultracode ✦ yellow.
5. Also unchanged: the chat Markdown heading ramp (700, yellow to white, `--heading-yellow`), code-header language yellow, list bullet yellow, the share glyphs 🔗/🤖, the Exchange tab border colours, the custom icon font.

---

## 5. Behaviour

### 5.1 When errors show and clear

- **Field errors show on submit**, and on `blur` of a field the user has edited only after a first failed submit (or for a format check whose answer the user needs before submitting, such as a connection code). Never while typing a first value.
- **They clear on the next valid `input`** of that field (re-validate on input once the field is in error), not on focus.
- **Server/form errors** (summary, alert) clear on the next submit attempt and when the user changes the field the error names; a stale error is never left visible after the condition is gone. A status element that switches to an error state (`data-state="error"`) is reset on every non-error update.
- **One message per cause**: a field error is not repeated as a separate alert; the summary links to it.

### 5.2 Focus

- Failed submit: with one invalid field, focus it; with several, focus the summary (`tabindex="-1"`) — its links reach each field. A server error not tied to a field focuses the summary.
- Opening a dialog, confirm card or menu moves focus inside (§3.6–3.10); closing returns it to the trigger. If the trigger is gone, focus the nearest stable container (the composer in the chat).
- Never steal focus from the chat composer for a notice (notices are announced, not focused).

### 5.3 Dismissal

- Every dismissible message has an explicit close button with an `aria-label`. Clicking the message body does not dismiss it.
- Escape dismisses the innermost transient layer (tooltip → menu → popover → confirm → panel), one per press, and does not reach the next layer.
- Persistent alerts (connection lost, form errors) are not dismissible; they clear when the condition clears.
- A dismissed message stays dismissed until its content changes.

### 5.4 Announcements

- `role="alert"` only for errors and for questions that block work (pending approvals announce once on arrival via a polite `role="status"` region "Approval needed: …", not alert, to avoid interrupting streaming).
- Do not combine `role="status"` with `aria-live`; do not put `role="status"` on static text that never changes.
- Status visible only by colour (dots, marks) always has a text equivalent in an accessible name.

### 5.5 Reduced motion

`prefers-reduced-motion: reduce` sets every `--ds-duration-*` to `0s`; fades, pop-ins, the send flight, tab width transitions and shimmer stop. Spinners and the liquid loader use their existing still frames. Nothing conveys state through motion alone.

---

## 6. Change lists

Surgical: no class or id renames, no markup restructuring beyond attributes and a close button where one is missing.

### 6.1 Website (`exchange-server/apps/web/app`)

| File | Selector / place | Change |
|---|---|---|
| `chat-theme.css` | `:root` | add `--warn: var(--vscode-editorWarning-foreground, #cca700)` and `--info: var(--vscode-editorInfo-foreground, #3794ff)` |
| `style.css` | `:root` (after `--ctl-*`) | add the full `--ds-*` block (§2, px type column, website colour column, `--ds-shadow-color: var(--vscode-widget-shadow, #00000066)`) |
| `style.css` | `.error` (555) | padding `var(--ds-space-2) var(--ds-space-4)`; `background: var(--ds-danger-soft)`; `border-color: var(--ds-danger-line)`; `border-radius: var(--ds-radius)`; `font-size: var(--ds-text-sm)`; `margin-bottom: var(--ds-space-4)`; `color: var(--ctl-fg)` for body; add `display:flex; gap: var(--ds-space-3)`; no icon (no icon markup today) |
| `style.css` | new `.notice`, `.notice.is-success/.is-warning/.is-info` | alert §3.1 per tone; used by account dialog and copy feedback |
| `style.css` | `.chat .error` (1093), `.inline > .error` (1986) | remove ad hoc margins; inherit `.error`; only `margin: 0` where inline |
| `style.css` | `input[aria-invalid=true]` (1989, 1993) | merge into one rule covering `input, select, textarea`; `border-color: var(--ds-danger)`; `:focus-visible { outline-color: var(--ds-danger) }`; drop `--vscode-inputValidation-*` and `#e56565/#351e24` |
| `style.css` | `.field-error` (1996) | `color: var(--ds-danger)`; `font-size: var(--ds-text-sm)`; `margin-top: var(--ds-space-1)`; `:empty { display:none }` |
| `components/form.tsx` | field error span (124) | remove `role="alert"`; keep id + `aria-describedby` + `aria-invalid`; on failed submit focus first invalid field or the summary |
| `components/form.tsx` | form error (96) | add `tabindex={-1}`; focus it when the error is not field-bound or there are several invalid fields |
| `style.css` | `.remote-browser-error` (1555, 1935, 1956) | merge into one block: keep absolute placement, `padding: var(--ds-space-2) var(--ds-space-4)`, `font-size: var(--ds-text-sm)`, `border: 1px solid var(--ds-danger-line)`, `background: var(--ds-surface-raised)` with `box-shadow: var(--ds-shadow-tip)`, `border-radius: var(--ds-radius)`, `max-height: 96px` |
| `workspace/[id]/remote-browser.tsx` | error element (811) | `role="alert"`; close button uses the shared `Icon` close, `aria-label="Dismiss browser error"` (keep) |
| `components/account-menu.tsx` | `<p role="status">` (87) | add `className="notice is-success"` (or `is-info` per message) |
| `components/connection-credentials.tsx` | `.copy-feedback` (96) | add class `status-line is-success`; style `.status-line` per §3.5 |
| `style.css` | `form .liquid-loader` (via form.tsx:93) | add visible text next to the loader ("Submitting…", `--ds-text-sm`, `--ds-muted`) or keep aria-label and add `.sr-only` duplicate — no visual change required |
| `style.css` | `.point-confirm` (2076), `.point-confirm-yes` (2090) | container per §3.6 (padding, border, `background: var(--soft)`, `border-radius: var(--ds-radius)`, `font-size: var(--ds-text-sm)`); `.point-confirm-yes` adopts `.ctl-danger` rules |
| `page.tsx` | `.point-confirm` (484) | `role="alertdialog"`, `aria-labelledby` the question; focus the Cancel button on open; Escape cancels |
| `style.css` | `.account-popover` (1749); duplicate small rule (1762, 1767) | `z-index: var(--ds-z-popup)`; `box-shadow: var(--ds-shadow-popup)`; `border-radius: var(--ds-radius-lg)`; `padding: var(--ds-space-4)`; merge the two duplicated rules |
| `components/account-menu.tsx` | `<details>/<summary>` | `aria-haspopup="menu"` (or `dialog`) on summary; close on Escape and outside click; return focus to summary |
| `style.css` | `.account-dialog` (1784), backdrop (1794) | `border-radius: var(--ds-radius-lg)`; `padding: var(--ds-space-6)`; `box-shadow: var(--ds-shadow-modal)`; backdrop `var(--ds-backdrop)`; h2 (1807) `font-size: var(--ds-text-h3); font-weight: var(--ds-weight-strong); margin: 0` |
| `components/account-menu.tsx` | `<dialog>` | `aria-labelledby` → h2 id |
| `style.css` | `.card` (449), `.point-card` (741, 1654, 1890, 2008, 2013, 2017), `.create-card` (655, 1648), h2 (777, 1666, 2046) | merge each selector into one block (keep the last cascade winner's values unless they conflict with §3.11); padding `var(--ds-space-6)`; radius `var(--ds-radius-lg)`; h2 `--ds-text-h2`/600/`--ds-tracking-heading` |
| `style.css` | `.status` (761, 1837, 1908) | radius `var(--ds-radius-pill)`; height `var(--ctl-h-sm)`; `font-size: var(--ds-text-xs)`; tints via `--ds-success-soft/-line`; add `.status.is-offline` (neutral) and `.status.is-warning` |
| `page.tsx` | status badge container | wrap status in `role="status"` region only where it updates live |
| `style.css` | `.status-dot` (305), `.online` (627), `.accent-dot` | 6×6; `.online` `var(--ds-success)`; `.accent-dot` `var(--ds-accent)`; dots `aria-hidden` with text label beside |
| `style.css` | `.panel-tag`, `.panel-label`, `.composer-hint` (950…) | `font-size: var(--ds-text-xs)`; one `letter-spacing: var(--ds-tracking-label)` for the uppercase ones; `.panel-label` `margin-bottom: var(--ds-space-6)` |
| `style.css` | `.empty-state` (715), `.chat-empty` | padding `var(--ds-space-6) var(--ds-space-4)`; icon 32px `--fg-faint`; title `--ds-text-h3`/600; text `--ds-text-sm`, `margin-top: var(--ds-space-2)`, `max-width: 300px` — same numbers for both |
| `style.css` | `code` (219), `.secret > code`, `.connection-details code` (801), (1855), `.recovery-codes code` (2112) | inline code background `var(--code-bg)` + radius-sm + padding; `.secret > code` `color: var(--fg)`, margin `var(--ds-space-4) 0`, padding `var(--ds-space-3) var(--ds-space-4)` |
| `style.css` | h2 variants (940, 1807) | map to the heading table (§3.17) |
| `style.css` | `.mobile-workspace-tabs` (1403, 1418, 1425, 1433, 1603, 1606) | merge duplicated media rules; selected style per §3.12; keep `aria-current="page"` and wrap in `nav aria-label="Workspace sections"` (it is navigation) |
| `workspace/[id]/page.tsx` | splitter `role="separator"` (248) | add `aria-orientation`, `aria-valuenow/min/max`, `tabindex="0"`, ←/→ resize by 16px |
| `style.css` | all `--fg-2/--fg-3/--fg-faint` text uses (1762…) | secondary text → `var(--ds-muted)`; `--fg-faint` only on icons/dividers |
| `style.css` | literal shadows, z-indexes, radii 5/16, sizes 9/11px across the file | replace with tokens when the rule is touched |

### 6.2 Chat (`media/chat.css`, `preview-src/chat.ts`)

| File | Selector / place | Change |
|---|---|---|
| `media/chat.css` | `:root` (after line 96) | add the `--ds-*` block of §2; `--radius` and `--radius-lg` alias `--ds-radius-md` / `--ds-radius-lg` (values unchanged: 8 / 12) |
| `media/chat.css` | `--io-bg` (853) | `color-mix(in srgb, var(--code-bg) 78%, var(--vscode-editor-background))` |
| `media/chat.css` | `.chrome-connection-banner` (99) | info tone §3.1: `margin: var(--ds-space-3) var(--ds-space-4)`; `padding: var(--ds-space-2) var(--ds-space-4)`; `border: 1px solid var(--ds-info-line)`; `border-radius: var(--ds-radius)`; `background: var(--ds-info-soft)`; `font-size: var(--ds-text-sm)` |
| `preview-src/chat.ts` | banner element (185) | `role="status"` instead of `alert` (it is a connection notice; set `role="alert"` only when its state is an error) |
| `media/chat.css` | `.usage-alert-close:focus-visible` (~1860) | **exception rule**: replace `outline: none` with `outline: 1px solid #000; outline-offset: -2px`; nothing else in `.usage-alert*` changes |
| `preview-src/chat.ts` | usage alert close (405, 8029) | add `aria-label="Close plan-limit notice"`; the clickable text span gets `role="button"` + `tabindex="0"` + Enter/Space handler |
| `media/chat.css` | `.voice-error` (4702) | danger tone §3.5 boxed: `margin: var(--ds-space-2) var(--ds-space-4) 0`; `padding: var(--ds-space-2) var(--ds-space-4)`; `background: var(--ds-danger-soft)`; `border: 1px solid var(--ds-danger-line)`; `border-radius: var(--ds-radius)`; `font-size: var(--ds-text-sm)`; `line-height: var(--ds-leading)`; `cursor: default`; flex for close button |
| `media/chat.css` | `.control-refusal` (5328) | same metrics as `.voice-error`, neutral tone (`background: var(--soft-2)`, `border: 1px solid var(--ds-divider)`, `color: var(--ds-muted)`); rewrite as multi-line declarations |
| `preview-src/chat.ts` | voice error (315), control refusal (416) | stop dismissing on body click; append a ghost icon close button (`aria-label="Dismiss"` + what) that calls the existing dismiss path; keep the 8s auto-hide for the refusal |
| `media/chat.css` | `.form-error` (4299) | `font-size: var(--ds-text-sm)`; `color: var(--ds-danger)`; `padding: var(--ds-space-1) 0 0` |
| `preview-src/chat.ts` | form errors (6627, 7362, 7715) | give each an `id`; on `toolbarError`/`githubAnswer` errors set `role="alert"` on the summary error (single error line per form) and `aria-invalid="true"` + `aria-describedby` on the named field; focus that field; clear `aria-invalid` on next input |
| `media/chat.css` | invalid controls | add `:is(input, select, textarea)[aria-invalid=true] { border-color: var(--ds-danger) }` and the danger focus outline |
| `media/chat.css` | `.row.notice`, `.row.error` (351) | `font-size: var(--ds-text-sm)` |
| `preview-src/chat.ts` | row error rendering (2824-2827) | add `role="alert"` to newly inserted `.row.error` only (not on re-render or history open) |
| `preview-src/chat.ts` | gitPopupError, branchError (440, 696) | `role="alert"` and danger style (`.status-line.is-danger`); remove redundant `aria-live` on commitNotice (385) |
| `media/chat.css` | `.paste-status` (1072) and other status lines | `font-size: var(--ds-text-sm)`; `color: var(--ds-muted)`; add `.is-danger/.is-success/.is-warning` modifiers |
| `media/chat.css` | `.popup` (2130) | `z-index: var(--ds-z-popup)`; `border-radius: var(--ds-radius-md)`; `box-shadow: var(--ds-shadow-popup)`; `padding: var(--ds-space-1)`; animation duration `var(--ds-duration)` |
| `media/chat.css` | `.menu-*` (2155) | item `min-height: var(--ctl-h)`, `padding: 0 var(--ds-space-3)`, `border-radius: var(--ds-radius-sm)`; heading/description/shortcut `font-size: var(--ds-text-xs)`; note `max-width: 100%` |
| `preview-src/chat.ts` | `openMenu` | `role="menu"` on container, `role="menuitem"`/`menuitemradio` + `aria-checked` on items, `role="separator"`, heading `id` + `role="group"` `aria-labelledby`; ↑/↓/Home/End handling if absent |
| `media/chat.css` | `.hover-tip` (4486) | `z-index: var(--ds-z-tooltip)`; `box-shadow: var(--ds-shadow-tip)`; `font-size: var(--ds-text-sm)`; `border-radius: var(--ds-radius-sm)` |
| `preview-src/chat.ts` | `hoverTip` (7089) | give the tip an id; set/remove `aria-describedby` on the anchor while shown; show immediately on `focus-visible` |
| `media/chat.css` | `.history-panel` (2329) | `z-index: var(--ds-z-panel)`; head per §3.10 |
| `preview-src/chat.ts` | History, Agents, Agent apps panels | `role="dialog"`, `aria-labelledby` title id; focus first control on open; restore focus to trigger on close |
| `media/chat.css` | `.tab-confirm`, `.confirm-danger`, `.confirm-cancel`, `.switch-cancel` (2826) | `height: var(--ctl-h-sm)`; secondary ctl metrics; `.confirm-danger` = `.ctl-danger` |
| `preview-src/chat.ts` | close-confirm row, switch card | `role="alertdialog"` + `aria-labelledby`; focus Cancel on open |
| `preview-src/chat.ts` | pending approval (3108 region) | announce arrival through one polite `role="status"` region ("Approval needed: <title>"); add the state word to the card head's accessible text |
| `media/chat.css` | `.chip-remove` (1655 region) | 24px hit area with 16px visual; icon 14px |
| `preview-src/chat.ts` | chip add/remove (4242, 4290), tab close (1753) | `aria-label` ("Remove <label>", "Attach <label>", "Close <title>") |
| `preview-src/chat.ts` | tab `aria-label` | append the status word (working, waiting, failed, unread) |
| `media/chat.css` | tab corner badge, agents count | min 16px / `--ds-text-xs`; `aria-hidden` on the badge |
| `media/chat.css` | `.tab-mark.failed` | `--ds-danger` instead of orange (orange stays for `waiting`) |
| `media/chat.css` | `.status-dot` (628) | delete (dead: `display:none`, unused) after `grep` confirms no script reference |
| `media/chat.css` | Markdown headings (1132-1134) | h2 `1.2em` (matches CLAUDE.md); weights untouched (exception) |
| `media/chat.css` | `.welcome-title` | `font-size: var(--ds-text-h3)`; `.welcome-icon` 28px → keep size, remove `!important` by raising specificity (`.welcome .welcome-icon.codicon`) |
| `media/chat.css` | history "nothing yet", palette "Nothing matches" | shared `.ds-empty-line` metrics |
| `media/chat.css` | small-text sizes 0.8/0.88/0.9/0.95em, fixed 9-12px | map to `--ds-text-xs` / `--ds-text-sm`; `--fg-faint` text → `--ds-muted` |
| `media/chat.css` | z-index literals 30/40/45/50/60 | tokens §1.5 |

### 6.3 Shells (`chrome-extension/sidepanel.*`, `exchange-server/chat-assets/web-chat.css`, `media/main.css`)

| File | Selector / place | Change |
|---|---|---|
| `chrome-extension/sidepanel.css` | `:root` faked theme | add `--vscode-editorWarning-foreground: #cca700`, `--vscode-editorInfo-foreground: #3794ff`, `--vscode-charts-green: #89d185`, `--vscode-charts-yellow: #cca700`, `--vscode-contrastBorder` unset; then the `--ds-*` block (px column, shell colours) |
| `exchange-server/chat-assets/web-chat.css` | `:root` | nothing new: inherits `--ds-*` from `sidepanel.css` (loaded first); add only light-theme overrides if a `--ds-*` value differs |
| `chrome-extension/sidepanel.html` | header title span (13) | wrap text in `<h1 class="shell-title">` (no id change); style `font-size: var(--ds-text-sm); font-weight: var(--ds-weight-strong); margin: 0` |
| `chrome-extension/sidepanel.css` | `header.chrome-shell` (42) | `padding: var(--ds-space-2) var(--ds-space-4)`; `gap: var(--ds-space-3)`; `min-height: var(--ctl-h-lg)` |
| `exchange-server/chat-assets/web-chat.css` | `.remote-shell` header | same padding/gap/min-height as Chrome; `font-size: var(--ds-text-xs)` stays for status |
| `chrome-extension/sidepanel.css` | `#pairing h2` (47) | `font-size: var(--ds-text-h2)`; `font-weight: var(--ds-weight-strong)`; `margin: 0 0 var(--ds-space-3)` |
| `chrome-extension/sidepanel.css` | `#pairing p`, `#pairing label` (40) | `margin: 0 0 var(--ds-space-3)`; label `margin-top: var(--ds-space-5)`; body `font-size: var(--ds-text-sm)` |
| `chrome-extension/sidepanel.css` | `#status[data-state=error]` (43) | keep colour `var(--ds-danger)`; script prefixes the text with "Error: " (no codicon font in the shell); `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` + `title` set to full message |
| `chrome-extension/sidepanel.ts` | status updates (695, 779, 908, 918, 934) | delete `data-state` on every non-error update; for errors also render the message in a field error (below) or an alert under the header, `role="alert"` |
| `exchange-server/chat-assets/web-chat.css` | `.remote-shell #status` | `font-size: var(--ds-text-xs)`; keep visible below 420px as a dot-only indicator with the text in `title` and kept in the live region (`clip` visually-hidden text instead of `display:none`); add `[data-state=error] { color: var(--ds-danger) }` |
| `chrome-extension/sidepanel.css` | `#mode-details` (66–72) | merge duplicate `display:flex` and `p` margins; padding `var(--ds-space-3) var(--ds-space-4)`; gap `var(--ds-space-3)`; `line-height: var(--ds-leading)`; remove redundant `[hidden]` rule; `[data-mode=limited]` reads `--plan-limit-bg/-fg/-line` defined locally with the same hex values (exception §4) |
| `chrome-extension/sidepanel.html` | `#mode-close`, `#mode` | close: codicon-like inline SVG or `codicon-close` glyph 14px, 24×24 hit area, `aria-label="Close mode details"`; `#mode` gets `aria-controls="mode-details"` |
| `chrome-extension/sidepanel.css` | `#mode` (62) | badge §3.13 status pill: `font-size: var(--ds-text-xs)`; dot 6px; colours `var(--ds-success)` / `var(--ds-warning)` |
| `chrome-extension/sidepanel.html` / `.ts` | `#element-picker-status` | `role="status"` on the status span |
| `chrome-extension/sidepanel.css` | `#element-picker-controls` (56) | `border-bottom: 1px solid var(--ds-divider)`; `background: var(--ds-info-soft)` (banner bar, info tone) |
| `chrome-extension/sidepanel.css` | `dialog.chrome-element-preview` (59) | `padding: var(--ds-space-5)`; `border-radius: var(--ds-radius-md)`; `box-shadow: var(--ds-shadow-modal)`; `::backdrop { background: var(--ds-backdrop) }` |
| `chrome-extension/sidepanel.ts` | preview dialog (515) | add a title `h2` with id + `aria-labelledby`; Close button gets the shared secondary button class and focus ring |
| `exchange-server/chat-assets/web-chat.css` | `dialog` (4) | scope to `body > dialog` (shell-created only); `width: min(720px, 85vw)`; `border-radius: var(--ds-radius-md)`; padding `var(--ds-space-5)`; shadow and backdrop as above |
| `exchange-server/chat-assets/web-chat.css` | `#waiting` (6) | `padding: var(--ds-space-6)`; `gap: var(--ds-space-5)`; `line-height: var(--ds-leading-prose)`; script swaps the text to an offline/error message when busy ends without a connection |
| `chrome-extension/sidepanel.ts` / `.css` | `#connection` textarea + pairing errors (934) | add `<p id="connection-error" class="field-error">` after it; on invalid code set `aria-invalid="true"` + `aria-describedby="connection-error"` and focus the textarea; clear on input; `.field-error` per §3.2 |
| `chrome-extension/sidepanel.css` | `#editor-sources button` (785) | secondary ctl button, full width, left-aligned text; disabled host: `cursor: not-allowed`, reason in a `.status-line.is-warning` below linked by `aria-describedby` |
| `chrome-extension/sidepanel.css` | `#extension-id` (48) | code block §3.19: `font-family: var(--mono)`; `border: 1px solid var(--ds-divider)`; `border-radius: var(--ds-radius)`; `background: var(--vscode-textCodeBlock-background)`; padding `var(--ds-space-3)` |
| `chrome-extension/sidepanel.css` | `#manual-pairing > summary` (54) | `min-height: var(--ctl-h); display: flex; align-items: center` |
| `chrome-extension/sidepanel.html` | `#conversation` | add `aria-label="Conversation"` (match web) |
| `exchange-server/chat-assets/web-chat.css` | `#legacy` (8), `#legacy > p` | body `font-size: var(--ds-text-sm)`, `line-height: var(--ds-leading)`, `padding: var(--ds-space-4)`; notice `color: var(--ds-muted)`, `font-size: var(--ds-text-xs)`, `role="note"` in markup |
| `chrome-extension/sidepanel.css`, `web-chat.css` | `.connection-spinner` (77 / 11–12) | set explicit size `16px` in both headers |
| `media/main.css` | `.iframe-focused-alert` (121) | `font-size: 11px`; `padding: 2px var(--ds-space-2, 6px)`; `border-radius: 4px` unchanged; add `aria-hidden="true"` to its markup in `aiBrowserView.ts` |
| `media/main.css` | `--container-paddding` (7), base `button` radius 5px | leave (minimal-change surface; unused/unreached) |
