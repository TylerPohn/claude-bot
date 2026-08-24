# Claude Code Bots — Implementation Specification v1.0

**Target:** Electron desktop app (macOS arm64/x64, Windows x64/arm64). Messenger-shaped multi-agent client. Visual language emulates Grok Bot (xAI, Aug 2026): near-black surfaces, translucent borders, no hard strokes, iMessage-style bubbles, flat blob avatars with white eyes, compact 13/14/15/16 type scale.

**Vocabulary (use these exact nouns in code and UI):** *Bot* = one persistent named agent. *Conversation* = a 1:1 Bot thread or a group. *Group* = 2–6 Bots + you. *Section* = a named sidebar group. *Routine* = scheduled workflow owned by one Bot. *Skill* = reusable instruction set. *Card* = an inline transcript element (file, link, tool result, approval, connect).

Annotations in this document: `[G]` = verbatim value from shipped grok.com/x.ai CSS or measured from official screenshots. `[L]` = verbatim from Linear's shipped CSS (reference-grade desktop polish). `[C]` = chosen by this spec to match the aesthetic; no public source exists.

---

## 1. DESIGN TOKENS

Dark is the default theme. Light is a complete mirror. Ship both; `Follow System` is the default preference.

Ground rules that the tokens encode — do not violate them:
1. **Surfaces separate by lightness, never by a solid border.** Every divider is translucent white (dark) or black (light) at 8% / 14% / 20%.
2. **`--white` is `#FCFCFC`, not `#FFFFFF`.** [G] This 99% white is why every Grok surface reads soft.
3. **Emphasis weight is 550, not 600 or 700.** [G]
4. **Body size is 15px.** [G][L] No 16px body anywhere in chrome.

### 1.1 `tokens.css` — ready to paste

```css
/* ============================================================
   Claude Code Bots — design tokens
   Import once, before Tailwind's @theme layer.
   ============================================================ */

:root {
  /* ---- Raw ramps: pure neutral (hue-free) ---------------- [G] */
  --n-50:   #F7F7F7;
  --n-100:  #F2F2F2;
  --n-150:  #E8E8E8;
  --n-200:  #DEDEDE;
  --n-250:  #C7C7C7;
  --n-300:  #9E9E9E;
  --n-400:  #858585;
  --n-500:  #636363;
  --n-600:  #474747;
  --n-700:  #363636;
  --n-800:  #292929;
  --n-900:  #212121;
  --n-950:  #141414;
  --n-1000: #050505;

  /* ---- Raw ramps: blue-tinted gray (228deg) --------------- [G] */
  --g-50:   #F4F5FB;
  --g-100:  #EEF0F6;
  --g-200:  #DEDEDE;
  --g-300:  #9B9CA1;
  --g-400:  #828387;
  --g-500:  #616265;
  --g-600:  #48494B;
  --g-700:  #343537;
  --g-800:  #222325;
  --g-900:  #1B1B1D;
  --g-950:  #101113;
  --g-1000: #040406;

  --white:  #FCFCFC;   /* [G] 99% white, NOT #FFF */
  --black:  #050505;   /* [G] */

  /* ---- Brand ---------------------------------------------- */
  --brand-hero:      #80BDFC;  /* [G] Grok Bot cornflower field */
  --brand-hero-lift: #E9F3FD;  /* [G] highlight bloom */
  --brand-hero-deep: #6FB5FD;  /* [G] falloff */
  --solar:           #FF640A;  /* [G] Grok orange; used ONLY for needs-attention */

  /* ---- Avatar palette (the Bot blob fills) ---------------- [G]
     Sampled from shipped Grok Bot avatars; == Tailwind *-500. */
  --av-violet:  #8B5CF6;
  --av-blue:    #2E90FA;
  --av-green:   #22C55E;
  --av-teal:    #14B8A6;
  --av-brown:   #92603F;
  --av-orange:  #F97316;
  --av-red:     #F5254C;
  --av-pink:    #EC4899;
  --av-indigo:  #6366F1;
  --av-mint:    #34D399;
  --av-eye:     #FFFFFF;   /* eyes are PURE white, unlike every other surface [G] */

  /* ---- Typography ----------------------------------------- */
  /* Universal Sans is commercially licensed. Inter Variable is the
     substitute: it has the 550 axis value Grok's face relies on. [C] */
  --font-ui: "Inter Variable", "Inter", "SF Pro Text", -apple-system,
             BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
             Roboto, "Helvetica Neue", sans-serif;
  --font-display: "Inter Variable", "Inter", "SF Pro Display",
             -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: "Berkeley Mono", "IBM Plex Mono", ui-monospace,
             "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --font-emoji: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji";

  --font-features: "cv01", "cv02", "ss03";  /* [L] de-Helvetica-izes Inter */
  --font-variations: "opsz" auto;

  --fw-regular:  400;   /* [G] */
  --fw-medium:   510;   /* [L] sidebar rows, section headings */
  --fw-emphasis: 550;   /* [G] THE emphasis weight — names, titles, buttons */
  --fw-strong:   590;   /* [L] unread titles, badges only */

  /* Size / line-height / tracking. Tracking goes MORE negative as size
     drops — screen convention, opposite of print. [L] */
  --fs-meta:    13px;  --lh-meta:    18px;  --ls-meta:    -0.010em; /* [G] timestamps, secondary */
  --fs-chrome:  14px;  --lh-chrome:  20px;  --ls-chrome:  -0.011em; /* [G] menus, tabs */
  --fs-ui:      15px;  --lh-ui:      22px;  --ls-ui:      -0.011em; /* [G] BODY + bubbles */
  --fs-label:   15px;  --lh-label:   20px;  --ls-label:   -0.011em; /* [G] */
  --fs-title:   16px;  --lh-title:   22px;  --ls-title:   -0.013em; /* [G] bot/convo names */
  --fs-micro:   12px;  --lh-micro:   16px;  --ls-micro:   -0.013em; /* [C] section heads, badges */
  --fs-nano:    10px;  --lh-nano:    14px;  --ls-nano:    -0.015em; /* [L] kbd chips */
  --fs-h1:      20px;  --lh-h1:      26px;  --ls-h1:      -0.018em; /* [C] dialog titles */
  --fs-hero:    28px;  --lh-hero:    34px;  --ls-hero:    -0.022em; /* [C] onboarding */
  --fs-code:    13px;  --lh-code:    20px;                          /* [C] */

  /* ---- Spacing: 4px base grid ------------------------ [G] --- */
  --sp-0:  0px;    --sp-1:  2px;   --sp-2:  4px;   --sp-3:  6px;
  --sp-4:  8px;    --sp-5:  10px;  --sp-6:  12px;  --sp-7:  14px;
  --sp-8:  16px;   --sp-9:  20px;  --sp-10: 24px;  --sp-11: 32px;
  --sp-12: 40px;   --sp-13: 48px;  --sp-14: 64px;  --sp-15: 80px;

  --gutter: 24px;              /* [G] --content-gutter */
  --content-max: 704px;        /* [G] 44rem */
  --content-max-narrow: 608px; /* [G] 38rem, used <1100px window */

  /* ---- Radii ------------------------------------------ [G] --- */
  --r-2:  4px;
  --r-3:  6px;
  --r-4:  8px;     /* --radius */
  --r-5:  12px;    /* --radius-xl */
  --r-6:  16px;    /* --radius-2xl */
  --r-7:  24px;    /* --radius-3xl */
  --r-8:  32px;    /* --radius-4xl */
  --r-full: 9999px;

  /* Semantic radii — use these, not the raw scale */
  --r-bubble:      18px;  /* [G] measured 16–18 on shipped bubbles */
  --r-card:        20px;  /* [G] outer tool/approval card */
  --r-card-inner:  14px;  /* [G] nested white artifact panel */
  --r-button:      14px;  /* [G] approval action buttons */
  --r-row:         8px;   /* [C] sidebar row */
  --r-input:       22px;  /* composer pill = height/2 */
  --r-popover:     12px;  /* [L] */
  --r-chip:        999px;

  /* ---- Motion ------------------------------------------------ */
  --dur-instant: 0ms;     /* [L] highlight fade-IN is zero */
  --dur-fast:    100ms;   /* [L] hover, reveal, background */
  --dur-base:    175ms;   /* [L] dialog scaleIn/Out */
  --dur-slow:    250ms;   /* [L] panel slide, theme swap */
  --dur-exit:    150ms;   /* [L] highlight fade-out */
  --dur-shimmer: 2000ms;  /* working-indicator sweep */

  --ease-out-quad:  cubic-bezier(.25,.46,.45,.94);  /* [L] default UI */
  --ease-out-cubic: cubic-bezier(.215,.61,.355,1);  /* [L] */
  --ease-out-quart: cubic-bezier(.165,.84,.44,1);   /* [L] panels */
  --ease-out-quint: cubic-bezier(.23,1,.32,1);      /* [L] overlays */
  --ease-out-expo:  cubic-bezier(.19,1,.22,1);      /* [L] big travel */
  --ease-in-out-cubic: cubic-bezier(.645,.045,.355,1); /* [L] */

  /* Spring constants for the transcript auto-scroll (JS, not CSS) */
  --spring-damping:   0.7;    /* [L/OSS] use-stick-to-bottom defaults */
  --spring-stiffness: 0.05;
  --spring-mass:      1.25;

  /* ---- Z-index ladder --------------------------------- [L] --- */
  --z-base: 1;        --z-sticky: 50;     --z-scrollbar: 75;
  --z-header: 100;    --z-overlay: 500;   --z-popover: 600;
  --z-palette: 650;   --z-dialog-scrim: 699; --z-dialog: 700;
  --z-toast: 800;     --z-tooltip: 1100;  --z-contextmenu: 1200;
  --z-max: 10000;

  /* ---- Scrollbar --------------------------------- [G][L] ----- */
  --sb-size: 6px;          /* [G] --scroll-size:6px on x.ai */
  --sb-size-active: 10px;  /* [L] grows on hover */
  --sb-gap: 4px;
}

/* ============================================================
   DARK THEME — the default. Everything below is a semantic alias.
   ============================================================ */
:root,
:root[data-theme="dark"] {
  color-scheme: dark;

  --bg-app:            var(--g-950);   /* #101113 [G] window ground */
  --bg-app-alt:        #18191B;        /* [G] --background-secondary */
  --surface-0:         var(--n-1000);  /* #050505 [G] transcript ground */
  --surface-1:         var(--n-950);   /* #141414 [G] sidebar, side panel */
  --surface-2:         var(--n-900);   /* #212121 [G] raised row, agent bubble */
  --surface-3:         var(--n-700);   /* #363636 [G] popover, elevated, menu */
  --surface-hover:     rgba(255,255,255,.06);
  --surface-active:    rgba(255,255,255,.10);

  --input-bg:          #313234;        /* [G] */
  --input-bg-hover:    #36383A;        /* [G] */
  --input-border:      #444446;        /* [G] */
  --input-border-hover:#707172;        /* [G] */

  --fg-primary:        var(--white);   /* #FCFCFC [G] */
  --fg-secondary:      var(--n-300);   /* #9E9E9E [G] */
  --fg-tertiary:       var(--n-400);   /* #858585 [G] */
  --fg-quaternary:     var(--n-500);   /* #636363 [G] */
  --fg-on-accent:      var(--n-1000);

  --border-1:          rgba(255,255,255,.08);  /* [G] hairlines */
  --border-2:          rgba(255,255,255,.14);  /* [G] inputs, cards */
  --border-3:          rgba(255,255,255,.20);  /* [G] focus-adjacent */

  --card-bg:           rgba(222,222,222,.08);  /* [G] */
  --card-bg-hover:     rgba(222,222,222,.06);  /* [G] */
  --card-border:       rgba(222,222,222,.04);  /* [G] */
  --chip-bg:           rgba(222,222,222,.05);  /* [G] */

  --btn-filled-bg:     var(--white);   /* [G] */
  --btn-filled-fg:     var(--n-1000);
  --btn-filled-hover:  var(--n-200);   /* [G] #DEDEDE */
  --btn-secondary-bg:  rgba(255,255,255,.08); /* [G] */
  --btn-ghost-hover:   rgba(255,255,255,.08); /* [G] */

  --overlay:           rgba(0,0,0,.50); /* [G] */
  --ring:              var(--n-600);    /* [G] */

  /* Bubbles — dark is the inversion of the shipped light values */
  --bubble-agent-bg:   var(--n-900);    /* #212121 [C] (light source: #F1F2F1) */
  --bubble-agent-fg:   var(--fg-primary);
  --bubble-user-bg:    var(--white);    /* [C] mirrors --button-filled */
  --bubble-user-fg:    var(--n-1000);
  --bubble-nested-bg:  var(--n-800);    /* #292929 [C] white panel inverted */

  /* Accents */
  --accent:            #427EFF;  /* [G] --fg-electric-blue dark */
  --accent-soft:       rgba(66,126,255,.10); /* [G] --bg-electric-blue */
  --link:              #89A1F5;  /* [G] blue-300 */
  --fg-success:        #8CE38F;  /* [G] green-300 */
  --fg-danger:         #F2787E;  /* [G] red-300 */
  --fg-warning:        #FDD73F;  /* [G] yellow-300 */
  --fg-positive:       #28C8C8;  /* [G] teal-300 */
  --attention:         var(--solar); /* #FF640A — needs-attention only */

  /* Elevation. Dark shadows are BIGGER blur + MUCH higher alpha. [L] */
  --shadow-low:    0px 2px 4px rgba(0,0,0,.10);
  --shadow-medium: 0px 4px 24px rgba(0,0,0,.20);
  --shadow-high:   0px 7px 32px rgba(0,0,0,.35);
  --shadow-dialog: 0 4px 40px rgba(0,0,0,.10), 0 3px 20px rgba(0,0,0,.13),
                   0 3px 12px rgba(0,0,0,.13), 0 2px 8px rgba(0,0,0,.13),
                   0 1px 1px rgba(0,0,0,.13);           /* [L] 5-layer */
  --shadow-none:   0px 0px 0px transparent;             /* [L] for clean interpolation */

  --sb-thumb:        rgba(255,255,255,.10);  /* [L] */
  --sb-thumb-hover:  rgba(255,255,255,.20);
  --sb-thumb-active: rgba(255,255,255,.40);

  --focus-ring-color: var(--accent);
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
}

/* ============================================================
   LIGHT THEME — complete mirror. Same translucent-border principle.
   ============================================================ */
:root[data-theme="light"] {
  color-scheme: light;

  --bg-app:            var(--n-50);    /* #F7F7F7 [G] */
  --bg-app-alt:        #FDFDFC;        /* [G] */
  --surface-0:         var(--white);   /* #FCFCFC [G] */
  --surface-1:         var(--n-50);    /* #F7F7F7 [G] */
  --surface-2:         var(--n-100);   /* #F2F2F2 [G] */
  --surface-3:         var(--n-150);   /* #E8E8E8 [G] */
  --surface-hover:     rgba(0,0,0,.04);
  --surface-active:    rgba(0,0,0,.07);

  --input-bg:          #FFFFFF;        /* [G] */
  --input-bg-hover:    var(--n-50);
  --input-border:      #E3E3E3;        /* [G] */
  --input-border-hover:var(--n-250);

  /* One step darker than the shipped light ramp (n-500/400/300). A mid grey has
     much less contrast on a near-white ground than on a near-black one, so
     reusing dark's greys made light a structural mirror with ~1.5x less
     contrast — quaternary measured 2.50:1 on --surface-1, under even AA-Large.
     Shifted: 8.7 / 5.6 / 3.4:1 in light against dark's 7.6 / 5.5 / 3.4:1. Move
     all three or none; there is no free neutral between n-500 and n-400. */
  --fg-primary:        var(--n-1000);  /* #050505 [G] */
  --fg-secondary:      var(--n-600);   /* #474747 */
  --fg-tertiary:       var(--n-500);   /* #636363 */
  --fg-quaternary:     var(--n-400);   /* #858585 */
  --fg-on-accent:      var(--white);

  --border-1:          rgba(0,0,0,.06); /* [G] */
  --border-2:          rgba(0,0,0,.10); /* [G] */
  --border-3:          rgba(0,0,0,.15); /* [G] */

  --card-bg:           rgba(0,0,0,.03);
  --card-bg-hover:     rgba(0,0,0,.05);
  --card-border:       rgba(0,0,0,.04);
  --chip-bg:           rgba(0,0,0,.04);

  --btn-filled-bg:     var(--n-1000);  /* [G] */
  --btn-filled-fg:     var(--white);
  --btn-filled-hover:  var(--n-800);
  --btn-secondary-bg:  var(--n-150);   /* #E8E8E8 [G] secondary approval btn */
  --btn-ghost-hover:   rgba(0,0,0,.04); /* [G] */

  --overlay:           rgba(0,0,0,.20); /* [G] */
  --ring:              var(--n-250);

  --bubble-agent-bg:   #F1F2F1;        /* [G] measured */
  --bubble-agent-fg:   var(--n-1000);
  --bubble-user-bg:    #0B0B0B;        /* [G] measured */
  --bubble-user-fg:    var(--white);
  --bubble-nested-bg:  var(--white);   /* [G] #FCFCFC nested panel */

  --accent:            #1A5EFF;  /* [G] */
  --accent-soft:       rgba(26,94,255,.10);
  --link:              #3857C7;  /* [G] blue-500 */
  --fg-success:        #009427;  /* [G] */
  --fg-danger:         #B72A35;  /* [G] */
  --fg-warning:        #946F00;  /* [G] */
  --fg-positive:       #017474;  /* [G] */
  --attention:         var(--solar);

  --shadow-low:    0px 1px 4px -1px rgba(0,0,0,.09);   /* [L] */
  --shadow-medium: 0px 3px 12px rgba(0,0,0,.09);
  --shadow-high:   0px 7px 24px rgba(0,0,0,.06);
  --shadow-dialog: 0 4px 40px rgba(0,0,0,.06), 0 3px 20px rgba(0,0,0,.06),
                   0 3px 12px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.06),
                   0 1px 1px rgba(0,0,0,.09);

  --sb-thumb:        rgba(0,0,0,.10);
  --sb-thumb-hover:  rgba(0,0,0,.20);
  --sb-thumb-active: rgba(0,0,0,.30);
}

/* System-preference default when the user has not chosen [data-theme] */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) { /* re-declare the light block here, or
    set data-theme from the main process on boot — preferred, see §5.9 */ }
}

/* ============================================================
   Base
   ============================================================ */
html, body, #root { height: 100%; }
body {
  background: var(--bg-app);
  color: var(--fg-primary);
  font-family: var(--font-ui);
  font-size: var(--fs-ui);
  line-height: var(--lh-ui);
  letter-spacing: var(--ls-ui);
  font-weight: var(--fw-regular);
  font-feature-settings: var(--font-features);
  font-variation-settings: var(--font-variations);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overscroll-behavior: none;
  user-select: none;                 /* opt IN to selection per element */
}
.selectable, .transcript, input, textarea { user-select: text; }

:focus:not(:focus-visible) { outline: none; }          /* [L] */
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}

::-webkit-scrollbar { width: var(--sb-size); height: var(--sb-size); }
::-webkit-scrollbar-thumb {
  background: var(--sb-thumb); border-radius: var(--r-full);
}
*:hover::-webkit-scrollbar-thumb { background: var(--sb-thumb-hover); }
::-webkit-scrollbar-thumb:active { background: var(--sb-thumb-active); }
::-webkit-scrollbar-track { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 1.2 Tailwind v4 bridge

Tailwind v4 is CSS-first. Put this in `src/renderer/src/main.css` after importing tokens:

```css
@import "tailwindcss";
@import "./tokens.css";
@source "../../shared";     /* REQUIRED — see §5.6 */

@theme inline {
  --color-app: var(--bg-app);
  --color-s0: var(--surface-0);
  --color-s1: var(--surface-1);
  --color-s2: var(--surface-2);
  --color-s3: var(--surface-3);
  --color-fg: var(--fg-primary);
  --color-fg-2: var(--fg-secondary);
  --color-fg-3: var(--fg-tertiary);
  --color-accent: var(--accent);
  --color-attention: var(--attention);
  --radius-bubble: var(--r-bubble);
  --radius-card: var(--r-card);
  --font-ui: var(--font-ui);
  --font-mono: var(--font-mono);
  --text-meta: var(--fs-meta);
  --text-ui: var(--fs-ui);
  --text-title: var(--fs-title);
}
```

---

## 2. LAYOUT SPEC

All values in CSS px at 1× unless noted. No value is a suggestion.

### 2.1 Window

| Property | Value |
|---|---|
| Default size | 1180 × 780 |
| Minimum size | 880 × 600 |
| Sidebar collapses to rail automatically below | 1000 width |
| Details panel auto-hides below | 1180 width |
| `titleBarStyle` (darwin) | `hiddenInset` |
| `titleBarStyle` (win32/linux) | `hidden` + `titleBarOverlay` |
| `trafficLightPosition` | `{ x: 20, y: 21 }` — y = (56 − 14) / 2 |
| `backgroundColor` | `#101113` (dark) / `#F7F7F7` (light) — set at construction to kill white flash |
| `roundedCorners` | `true` (default for frameless) |
| Vibrancy | **none.** Flat opaque surfaces. Vibrancy costs a compositor pass every scroll frame and forces text-contrast compromises. |

Three-zone grid:

```
┌──────────────┬──────────────────────────────────┬───────────────┐
│ Sidebar 248  │ Chat column (flex, min 480)      │ Details 320   │
│ surface-1    │ surface-0                        │ surface-1     │
└──────────────┴──────────────────────────────────┴───────────────┘
   1px border-1 between zones (translucent, not a solid stroke)
```

### 2.2 Sidebar

| Element | Value |
|---|---|
| Width | **248px** (`15.5rem`) [G]; user-resizable 200–360, persisted |
| Collapsed rail width | 56px |
| Background | `--surface-1` `#141414` |
| Right divider | `1px solid var(--border-1)` |
| Top bar height | **56px** [G] `--header-height` |
| Top bar padding (darwin) | `0 8px 0 80px` — reserves the traffic lights (3 × 14px + 20px origin) |
| Top bar padding (win/linux) | `0 8px 0 12px` |
| Top bar `-webkit-app-region` | `drag`; every child button `no-drag` |
| Inner horizontal padding (list) | 8px |
| Scroll area | `overflow-y:auto; overscroll-behavior:contain` |

**Pinned strip** (top of list, horizontal, only when ≥1 pinned Bot):

| Element | Value |
|---|---|
| Strip height | 92px |
| Padding | `8px 8px 12px` |
| Avatar | 56 × 56 |
| Gap between items | 12px |
| Item width | 64px (name wraps to 1 line, `text-overflow: ellipsis`) |
| Name | 12px / 16px, `--fw-medium` 510, `--fg-secondary`, centered, 4px below avatar |
| Bottom divider | `1px solid var(--border-1)`, inset 8px each side |

**Section header:**

| Element | Value |
|---|---|
| Height | 28px |
| Padding-inline | 12px |
| Type | 12px / 16px, weight 510, `--fg-tertiary`, sentence case |
| Disclosure chevron | 12px, 8px gap, rotates 90° over `--dur-fast` |
| Margin-top (between sections) | 12px |

**Bot row (the primary object):**

| Element | Value |
|---|---|
| Height | **60px** (fixed — do not let preview text change it) |
| Margin-inline | 8px (so the row pill inset reads) |
| Padding | `10px 8px` |
| Radius | 8px |
| Gap avatar→text | 10px |
| Avatar | **40 × 40** |
| Line 1 — name | 15px / 20px, weight 550, `--fg-primary`, 1 line ellipsis |
| Line 1 — timestamp | 12px / 16px, weight 400, `--fg-tertiary`, right-aligned, `flex-shrink:0`, 8px left margin |
| Line 2 — preview | 13px / 18px, weight 400, `--fg-secondary`, 1 line ellipsis, 2px gap below line 1 |
| Hover background | `--surface-hover`, transition `background var(--dur-fast) var(--ease-out-quad)` |
| Selected | `::after { content:''; position:absolute; inset:2px 0; border-radius:8px; background:var(--surface-2); z-index:-1 }` + name/preview promoted one step lighter [L] |
| Status indicator | 8px dot, `flex-shrink:0`, trailing edge, 8px right of timestamp column baseline; see §3.4 |
| Row separators | **none.** Whitespace only. [G] |

**Sidebar footer:** 40px tall, `Show hidden chats` row, 13px, `--fg-tertiary`, only rendered when ≥1 hidden Bot exists.

### 2.3 Chat header

Not a bordered bar — a floating row over the transcript ground. `background: var(--surface-0)`; no bottom border; instead a 24px `linear-gradient(var(--surface-0), transparent)` scrim below it so scrolled content fades out.

| Element | Value |
|---|---|
| Height | **56px** [G] |
| Horizontal padding | 12px |
| `-webkit-app-region` | `drag` on the bar, `no-drag` on all controls |
| Identity pill | height 36, padding `4px 12px 4px 4px`, radius 999, background `--surface-2`, gap 8 |
| Pill avatar | 24 × 24 |
| Pill name | 16px / 22px, weight 550, `--fg-primary`. **Sentence case** in the header (`Chief of staff`) even though the roster uses title case (`Chief of Staff`) [G] |
| Pill subtitle (group only) | 12px, `--fg-tertiary`, e.g. `3 Bots` |
| Circular icon buttons | **32 × 32**, radius 999, background transparent → `--btn-ghost-hover` on hover |
| Icon | 18px glyph, 1.75px stroke, rounded caps/joins [G] |
| Button gap | 4px |
| Right-side buttons (1:1) | `Agent Computer` (monitor glyph), `Conversation details` (info glyph), `Bot actions` (⋯) |
| Right-side buttons (group) | `Members` (people glyph), `Conversation details`, `⋯` |

### 2.4 Transcript

| Element | Value |
|---|---|
| Scroll container | `overflow-y:auto; overscroll-behavior:contain` |
| Content column | `max-width: 704px` [G]; centered; `padding-inline: 24px` [G] |
| Narrow window (<1100px) | `max-width: 608px` |
| Top padding | 16px (below header scrim) |
| Bottom padding | 24px above the composer dock |
| Date separator | centered, 13px / 18px, `--fg-tertiary`, weight 400, block margin `20px 0 12px`. Format verbatim: `Today 7:58 AM`, `Yesterday 4:12 PM`, `Tuesday 9:03 AM`, `Mar 4 9:03 AM` [G] |
| Bubble max-width | `min(640px, 80%)` [G] |
| Bubble padding | `8px 14px` |
| Bubble radius | 18px, all corners equal [G] |
| Bubble type | 15px / 22px [G] |
| Gap, same sender consecutive | 4px |
| Gap, sender change | 12px |
| Gap, across a tool card | 12px |
| Agent alignment | left, `margin-right:auto` |
| User alignment | right, `margin-left:auto` |
| **Per-message avatar** | **none in 1:1** [G]. Group chats only: 20px avatar, `margin-right:8px`, aligned to the bubble's bottom edge, shown once per run |
| **Per-message timestamp** | **none.** [G] Time lives in the date separator and in a hover tooltip only |
| Group sender name | 12px, weight 550, colored `--fg-secondary`, 2px above the first bubble of a run, indented 28px |

**Status bubble** (terse agent acknowledgement — `Pulled and added`, `Sent`, `Done`): identical fill and radius, `padding: 6px 12px`, sized to content, no max-width.

**File / link card:** styled as an agent bubble. `width: 320px`, `padding: 12px`, `radius: 18px`, horizontal flex, `gap: 12px`. Favicon/product glyph **40 × 40**, `radius: 8px`. Title 15px / 20px weight 550 `--fg-primary`, 1 line ellipsis. Subtitle (domain or filesize) 13px `--fg-secondary`.

**Tool / approval card** — the signature surface, nested-panel pattern:

```
┌─ outer card ──────────────────────────────┐  bg: --bubble-agent-bg
│  New email                     ← label    │  radius: 20px, padding: 16px
│ ┌─ inner panel ───────────────────────┐   │  label: 15px/550, 12px bottom gap
│ │ To: board@example.com               │   │  inner bg: --bubble-nested-bg
│ │                                     │   │  inner radius: 14px, padding: 14px
│ │ Attaching the v5 deck ahead of...   │   │  inner type: 15px/22px
│ │                                     │   │  paragraph gap: 12px
│ └─────────────────────────────────────┘   │
│  [ Allow once ]  [ Deny ]  [ Always allow ]│  12px above buttons
└───────────────────────────────────────────┘  card max-width: 640px
```

Action buttons: height **32px**, padding `0 14px`, radius **14px**, 14px / weight 550. Primary = `--btn-filled-bg` / `--btn-filled-fg`. Secondary = `--btn-secondary-bg` / `--fg-primary`. Destructive (`Deny`) = `--btn-secondary-bg` / `--fg-danger`. Gap 8px.

**Reaction chip:** overlaps the **bottom-left** corner of the reacted bubble [G]. `height: 22px`, `padding: 0 6px`, `radius: 999px`, `background: var(--surface-2)`, `box-shadow: 0 0 0 2px var(--surface-0)` (the ring separates it from the bubble beneath), `transform: translate(8px, 8px)`, emoji 13px, count 11px weight 550 with 4px gap.

### 2.5 Composer dock

Pinned to the bottom of the chat column. `background: var(--surface-0)`, top scrim `linear-gradient(transparent, var(--surface-0) 16px)`.

| Element | Value |
|---|---|
| Dock padding | `8px 24px 16px` |
| Dock content width | the SAME column as the transcript (704px / 608px below 1100px) with the same 24px gutter — see `components/chat/contentColumn.ts`. The pill's outer edges must land on the bubble column; two different grids read as a misregistration on the app's most-looked-at vertical edges. |
| Notifications area | stacked directly above the pill, 8px gap; see §3.9 |
| Attachment tray | above the pill when ≥1 attachment: 64px tall, 8px gap, horizontal scroll |
| `+` button | **36 × 36** circle, sits **outside** the pill to its left [G], 8px gap, background `--surface-2`, glyph 18px |
| Pill | height **44px** min, radius **22px** (= height/2), background `--input-bg`, border `1px solid var(--border-2)` |
| Pill padding | `11px 8px 11px 16px` |
| Input type | 15px / 22px, `--fg-primary` |
| Placeholder | `--fg-tertiary`, copy: **`Ask {Bot name}`** (1:1) / **`Message {Group name}`** (group) [G] |
| Growth | auto-grow to 8 lines = `max-height: 198px`, then internal scroll; pill radius stays 22px |
| Trailing button | **32 × 32** circle, inset 6px from the pill's right edge |
| Trailing button — empty input | microphone glyph, background transparent, glyph `--fg-secondary` |
| Trailing button — has text | send glyph (arrow-up), background `--btn-filled-bg`, glyph `--btn-filled-fg` |
| Trailing button — Bot working | square "stop" glyph, background `--surface-3`; see §4.4 |
| Transition | `background var(--dur-fast) var(--ease-out-quad)` |

### 2.6 Conversation details panel

| Element | Value |
|---|---|
| Width | **320px**, fixed |
| Background | `--surface-1` |
| Left divider | `1px solid var(--border-1)` |
| Header | 56px, title 16/550, close button 32px circular |
| Section padding | `16px` |
| Section heading | 12px weight 510, `--fg-tertiary`, `margin-bottom: 8px` |
| Field row | 40px, label 13px `--fg-secondary` left, value 13px `--fg-primary` right |
| Slide-in | `transform: translateX(320px) → 0` over `var(--dur-slow) var(--ease-out-quart)` |

### 2.7 Agent Computer view

Replaces the transcript in the chat column. Background **`#000000`** — pure black, darker than the app theme [G]. The header chrome inverts: identity pill becomes `#1A1A1A` with `--white` text; circular buttons become `rgba(255,255,255,.08)` fills.

| Element | Value |
|---|---|
| Ground | `#000000` |
| Screen viewport | 16:10, `max-width: 100%`, centered vertically, letterboxed with black bars |
| Viewport radius | 8px |
| Viewport border | `1px solid rgba(255,255,255,.10)` |
| Status strip | 32px, below the viewport, 13px `--fg-tertiary`, centered |
| Right header buttons | `Take control` (keyboard glyph), `⋯` overflow [G] |
| Take-control banner | 44px, full width, `background: var(--accent)`, `--fg-on-accent`, 14px weight 550 |

### 2.8 Avatar geometry (the single most distinctive element)

Bot avatars are **flat solid-color abstract blobs with two pure-white rounded-rect eyes**. No photos, no letters, no gradients, no borders, no rings. [G]

| Context | Size |
|---|---|
| Pinned strip | 56 |
| Sidebar row | 40 |
| Header pill | 24 |
| Group transcript run | 20 |
| Mention chip | 16 |
| Avatar picker swatch | 48 |
| Onboarding hero | 96 |

Render as inline SVG on a **24 × 24 viewBox**, scaled. Ship these 10 shapes as `<path>` data: `circle`, `teardrop`, `rounded-triangle`, `egg`, `squircle`, `hexagon`, `capsule`, `arch`, `cloud` (4-lobe), `flat-top-square`. [G]

Eyes: two vertical capsules, `width: 2.4`, `height: 5.2`, `rx: 1.2` on the 24-grid. Centers at `(9.2, 9.6)` and `(14.8, 9.4)` — the 0.2 vertical offset produces the slight asymmetric tilt seen in shipped avatars. Fill `#FFFFFF`, no stroke.

---

## 3. COMPONENT SPEC

Copy in **bold** is verbatim from the shipped product or its docs. Copy in *italics* is chosen by this spec because no source exists.

### 3.1 Welcome / first run

**Screen: Welcome**
- Hero: 96px app blob avatar in `--brand-hero`, centered, 32px above the headline.
- Headline: 28px / 34px weight 550: **"Your team of always-on agents that finish the work"**
- Subhead: 15px `--fg-secondary`, max 440px: *"Bots have their own computer, work inside your tools, and keep going while you're away."*
- Primary button: **"Get started"** — height 44, radius 22, `--btn-filled-bg`, 15px weight 550, min-width 200.
- States: `idle`, `pressed` (`scale(.98)`, 100ms).

**Screen: Sign in**
- Button: **"Sign in →"** — near-black pill (dark theme: `--btn-filled-bg` white pill), trailing arrow glyph, height 44, radius 22.
- Secondary line: 13px `--fg-tertiary`, *"You'll be returned here automatically."*
- States: `idle`, `waiting` (label swaps to *"Waiting for your browser…"*, spinner 16px replaces the arrow, button disabled at 60% opacity), `error` (inline 13px `--fg-danger`: *"Sign-in didn't complete."* + text button *"Try again"*).

**Screen: Tour** — three panels, dot pager 6px dots / 8px gap, `--fg-quaternary` inactive, `--fg-primary` active.
1. **"Message it like a teammate"**
2. **"A computer of its own"**
3. **"Work with many Bots at once"**

**Screen: Which tools do you use?** — grid of 72px tiles, 3 columns, 12px gap, radius 12, `--surface-2`, selected = 2px `--accent` inset ring. Footer note 13px `--fg-tertiary`: *"This only shapes suggestions. Nothing is connected yet."*

**Screen: Meet a future teammate**
- Title: **"Meet a future teammate"** — 20px weight 550.
- 4–6 suggestion cards: 96px tall, radius 16, `--surface-2`, 48px avatar left, name 15/550, one-line job 13px `--fg-secondary`.
- Trailing card / text button: **"Create your own"**
- Background task strip at the bottom, 32px: **"Starting your computer"** with a 3px progress bar in `--accent`, indeterminate.

### 3.2 Sidebar

**Top bar** (left→right): user avatar 28px circle → flexible drag space → search button 32px → new button 32px (`+`).

**`+` menu** (popover, 200px wide, radius 12, `--surface-3`, `--shadow-medium`, item height 32, 14px):
- **"New Agent"**
- **"New Group Chat"**
- divider (`1px solid var(--border-1)`, inset 8px)
- *"New Section"*

**Row states** (exclusive, in priority order):

| State | Rendering |
|---|---|
| `default` | name `--fg-primary` weight 550, preview `--fg-secondary` |
| `hover` | + `--surface-hover` background |
| `selected` | + `::after` pill at `--surface-2`; persists across hover |
| `unread` | 8px dot, `background: var(--fg-primary)`; name stays 550; preview promoted to `--fg-primary` |
| `needs-attention` | 8px dot, `background: var(--attention)` `#FF640A`, `box-shadow: 0 0 0 2px var(--surface-1)`; preview text replaced with the reason: *"Needs your approval"* / *"Asked a question"* / *"Handed off to {Bot}"* |
| `working` | avatar gets a 2px `--accent` ring pulsing opacity 0.35→1 over 1.6s `ease-in-out` infinite; preview replaced with shimmer text (§6) showing the live phase |
| `hidden` | not rendered in the list |
| `dragging` | opacity .5, source row keeps a 60px placeholder at `--surface-hover` |

Preview truncation: single line, `text-overflow: ellipsis`. Verbatim sample previews for seed/demo data [G]: **"Outreach drafts queued for approval."**, **"Shortlist of 6 candidates ready."**, **"A/B copy variants ready to review."**, **"12 tickets resolved, 2 escalated."**, **"Receipts coded — one needs a look."**, **"Pulled 9 invoices from vendor portals."**, **"3 new listings match your filters."**, **"8am routine done. Inbox triaged, 3 unread left."**

Seed Bot names [G]: **Chief of Staff, EA, Inbox Manager, Sales Outbound, Talent Scout, Growth Marketer, Customer Support, Expense Manager, Invoice Collector, Apartment Hunter**.

**Row context menu** (right-click, and the `⋯` that appears on hover at the trailing edge):
- **"Pin"** / *"Unpin"*
- **"Hide from sidebar"**
- **"Move to"** ▸ submenu of Sections + **"New Section"**
- *"Mark as read"* / *"Mark as unread"*
- *"Duplicate"*
- **"Edit Profile"**
- divider
- *"Delete"* (destructive, `--fg-danger`)

**Section context menu:** *"Rename Section"*, *"Collapse all"*, **"Remove"** (destructive; on confirm, member Bots move to a section literally labeled **"Unassigned"** — Bots are never deleted). [G]

**Sidebar footer:** **"Show hidden chats"** → expands an inline list; each hidden row's menu offers **"Unhide"**. [G]

**Sidebar empty state:** 48px blob outline glyph at `--fg-quaternary`, 15px `--fg-secondary` *"No Bots yet."*, text button *"Create your first teammate"*.

### 3.3 Chat header

States: `default`, `working` (a 6px `--accent` dot pulses to the right of the pill name), `offline` (pill dims to 60%, subtitle becomes *"Computer unavailable"* in `--fg-danger`).

Clicking the pill opens **Bot actions** (popover anchored below-left, 220px):
- **"Edit Profile"**
- **"View conversation details"**
- **"Agent Computer"**
- divider
- *"Mark as unread"*, **"Pin"**, **"Hide from sidebar"**
- divider
- *"Duplicate"*, *"Delete"*

### 3.4 Attention indicator (the three-state model)

Exactly three states, named verbatim in the product [G]:

| State | Trigger | Sidebar | Dock badge | OS notification |
|---|---|---|---|---|
| **Needs attention** | a question, an approval request, or an inbound handoff | `#FF640A` dot + 2px row-colored ring | counted | yes, if Bot notifications on and app unfocused |
| **Unread activity** | a new result | solid `--fg-primary` dot | counted | yes |
| **Working / typing** | task in flight | pulsing `--accent` avatar ring + shimmer phase text | not counted | no |

`Needs attention` outranks `Unread activity` on the same row. Opening a conversation clears both.

### 3.5 Transcript elements

| Element | States |
|---|---|
| Agent bubble | `streaming` (last block renders with a 2px × 15px caret at `--fg-primary`, blinking 1s step-end), `complete`, `failed` (bubble border `1px solid var(--fg-danger)`, footer row with *"Retry"* text button) |
| User bubble | `sending` (opacity .6), `sent`, `failed` (trailing 14px `!` in `--fg-danger`, click → *"Retry"* / *"Delete"*) |
| Status bubble | `complete` only. Verbatim examples: **"Pulled and added"**, **"Sent"**, **"Done"** |
| File card | `ready`, `loading` (title replaced by a 120 × 12 skeleton bar), `error` (glyph tinted `--fg-danger`, subtitle *"Couldn't open this file"*) |
| Approval card | `pending`, `approved` (buttons replaced by a 32px row: check glyph + *"Allowed once"* in `--fg-success` 13px), `denied` (*"Denied"* in `--fg-danger`), `always-allowed` (*"Always allowed"* + text button *"Manage rule"*), `stale` (buttons disabled 40%, footer 13px `--fg-tertiary`: *"This request is no longer actionable."* + text button *"Ask for a new one"*) |
| Connect card | label *"Connect {Service}"*, body 15px *"{Bot} needs access to {Service} to continue."*, primary button *"Connect"*; `waiting` state → button label becomes **"Waiting for authorization"** with a 14px spinner, plus a secondary text button **"Reopen"** |
| Secure secret request | label *"Enter {field}"*, single masked input (44px, radius 12, `--input-bg`), footer 13px `--fg-tertiary`: *"Masked, excluded from the transcript, and never shown to the model."*, buttons *"Submit"* / *"Cancel"* |
| Handoff message | full-width centered row, no bubble. 20px avatar of sender → 13px `--fg-tertiary` text: *"{Sender} handed off to {Receiver}"* → 20px avatar of receiver. 12px vertical margin |
| Thread stub | attached under the parent card: 28px row, `padding-left: 14px`, 13px `--accent`: *"3 replies"* + last-reply relative time |
| Computer-use step | 28px inline row, 16px monitor glyph `--fg-tertiary`, 13px `--fg-secondary` monospaced-ish label, e.g. *"Opened docs.google.com"*. Collapsed into a *"Show 12 steps"* disclosure when a run emits more than 3 |

**Message hover actions:** absolutely positioned, overlapping the bubble's top-right (top-left for user bubbles), `transform: translateY(-50%)`. Always in the DOM; only `opacity` toggles. Height 28, radius 8, `--surface-3`, `--shadow-low`, 4px padding, buttons 24 × 24.
Buttons: *React*, *Reply*, *Reply in thread*, *Copy*, *⋯*.

```css
.msg .actions { opacity: 0; transition: opacity var(--dur-fast) var(--ease-out-quad); }
.msg:hover .actions,
.msg:focus-within .actions,
.actions:focus-within { opacity: 1; }
@media (hover: none) { .msg .actions { opacity: 1; } }
```

**Transcript empty state (new 1:1):** centered at 40% height. 64px avatar, 20px weight 550 name, 15px `--fg-secondary` job title, then a 3-item suggestion list of 40px pill buttons (radius 20, `--surface-2`, 14px) derived from the Bot's description. Footer hint 13px `--fg-tertiary`: *"Describe the outcome you want."*

**Transcript empty state (new group):** 20px weight 550: *"{n} Bots in this group"*, avatar row, then 15px `--fg-secondary`: *"Describe the shared outcome and who owns the next step."*

### 3.6 Composer

| Sub-element | Spec |
|---|---|
| `+` menu | *"Attach files…"*, *"Attach from Agent Computer…"*, divider, *"Reference a skill"* (inserts `/`), *"Mention"* (inserts `@`) |
| Attachment chip | 56 × 56 thumbnail (or 56 × 56 file-type tile), radius 8, 16px `×` remove button at top-right offset (−6, −6), filename tooltip |
| Attachment counter | when 6 reached, `+` button dims to 40% with tooltip: **"Up to six attachments at a time"** |
| Over-size error | inline notice above the pill: *"{filename} is {n} MB. Limit is 25 MB (200 MB for video)."* |
| Drag-over state | the whole transcript column gets a 2px dashed `--accent` inset ring at 8px inset + centered 15px `--fg-primary` overlay *"Drop to attach"* on a `--overlay` scrim |
| Draft persistence | on conversation change, persist the raw text + attachment ids keyed by conversation |
| Paste | text/links inline; images become attachments |

**Mention picker (`@`)** — popover anchored to the caret, opens **upward**, 320px wide, `max-height: 280px`, radius 12, `--surface-3`, `--shadow-medium`, `--z-popover`.

- Item height 40, padding `0 10px`, gap 10, avatar 24, name 14px weight 550, job 12px `--fg-tertiary` right-aligned.
- Grouped headers (28px, 12px/510, `--fg-tertiary`): *Bots*, *Groups*, *Routines*, *Connectors*.
- `@everyone` is the first item in a group conversation, rendered with a 24px generic multi-avatar glyph.
- Empty: 40px row, 13px `--fg-tertiary`, *"No matches"*.
- Keys: type to filter, ↑/↓, Enter/Tab to insert, Esc to dismiss (Esc does not clear the typed `@`).

**Skill picker (`/`)** — same chrome. Header *Skills*. Item = 16px sparkle glyph + name + 12px `--fg-tertiary` description. Empty state copy (verbatim doctrine): *"No skills enabled for this Bot. Enable one in Settings → Plugins → Yours."*

**Inserted mention chip** (rendering is undocumented; this spec fixes it): inline-flex, height 20, `padding: 0 6px 0 3px`, radius 999, `background: var(--accent-soft)`, `color: var(--accent)`, 14px weight 550, 14px avatar leading with 4px gap. Atomic — Backspace deletes the whole chip.

### 3.7 Command palette / search

Single combined surface. `⌘/Ctrl+K`.

| Element | Value |
|---|---|
| Dialog | `max-width: min(720px, 100vw - 32px)`, `max-height: min(73vh, 500px)`, `top: 13vh`, `left:50%`, `transform: translateX(-50%)`, radius 12, `background: var(--surface-3)`, `border: 1px solid var(--border-2)`, `--shadow-dialog` [L] |
| Scrim | `background: var(--overlay)`, `animation: fadeIn 175ms var(--ease-out-quad)` |
| Open animation | `scaleIn 175ms var(--ease-out-quad)`; `from { opacity:0; transform: translateX(-50%) scale(.96) }` [L] |
| Invalid action | `dialogBounce 150ms` — `50% { transform: translateX(-50%) scale(.98) }` [L]. Never shake |
| Input | height 46, padding `0 18px`, 15px, no border, `caret-color: var(--accent)`, `:focus-visible { outline: none }` |
| List | `padding: 6px`, `scroll-padding-block: 6px` |
| Item | `min-height: 46px`, padding `8px 12px`, 13px / 1.2, gap 12, icon cell 16 × 16 |
| Item selected | `[aria-selected=true]::after { inset:2px 0; border-radius:8px; background:var(--surface-2); z-index:-1 }` + text promoted to `--fg-primary` [L] |
| Group heading | height 30, 12px weight 510, `--fg-tertiary`, `padding-inline: 12px` |
| Trailing hint | right-aligned kbd chips, see §3.11 |

Result groups, in order: *Bots & Groups*, *Messages*, *Files & Links*, *Routines*, *Settings*, *Actions*.
Selecting a Message result opens the conversation and scroll-jumps to that message with a 600ms highlight: `background: var(--accent-soft)` fading out over `var(--dur-slow)` (fade-**in** is 0ms). [L]
Empty state, verbatim doctrine when cross-conversation search is unavailable: *"Cross-conversation search isn't available yet. Open a Bot to search its history."*

### 3.8 Settings dialog

Title: **"Claude Code Bots settings"**. Two-pane: 200px nav left (`--surface-1`), content right (`--surface-3`). Dialog 880 × 620, radius 12, `--shadow-dialog`. Nav item 32px, 14px, radius 6, selected pill as in §2.2.

Full tree [G, adapted]:

- **General** → **Account**, **Appearance**, **Agent**
  - Appearance: segmented control, 3 options, verbatim **"Follow System"**, **"Light"**, **"Dark"**. Height 32, radius 8, `--surface-2`, thumb `--surface-3` sliding over `var(--dur-fast) var(--ease-out-quad)`.
  - Agent: **Timezone** (combobox), **Execution on Local Computer** (radio group: **"Ask every time"** *(default)*, *"Always allowed"*, **"Never allowed"**), **Auto-review** (rule list).
  - **Do not ship a model picker.** Model choice is fully managed by the product.
- **Plugins** → **Marketplace**, **Yours**, **+ Add Connector**, **MCP Configuration**, **Disable All MCP Commands Globally** (toggle, destructive-adjacent, `--fg-warning` helper text)
- **Usage & Billing** → **Weekly usage**
- **Team Setup** → **Admin setup**
- **Beta** → **Check for Updates**, **Restart to Update**, **Update Agent Computer**, **Recover Agent Computer**, **Reset Agent Computer**

Helper copy under Reset (verbatim semantics): *"Recover and Update preserve durable files and logins. Reset restores the last saved snapshot and can lose recent or unsynced work."*

**Auto-review rule row:** 48px, radius 8, `--surface-2`. Left: a 20px pill badge — **"Require Approval"** (`--fg-warning` on `rgba(253,215,63,.12)`) or **"Always Allow"** (`--fg-success` tint). Middle: rule text 14px. Right: `⋯`. Footer note: *"If both kinds of rule match, Require Approval wins."*

### 3.9 In-app Notifications area

Anchored **above the composer**, inside the 704px column. Not a toast stack — a persistent tray. [G]

| Element | Value |
|---|---|
| Notice | `padding: 10px 12px`, radius 12, `background: var(--surface-2)`, `border: 1px solid var(--border-1)`, 8px gap between notices |
| Leading glyph | 16px, colored by severity (`--fg-danger` / `--fg-warning` / `--fg-secondary`) |
| Text | 14px / 20px `--fg-primary`, wraps to 3 lines max |
| Actions | text buttons 13px weight 550 `--accent`, 12px gap: **"Retry"**, **"Recover computer"**, **"Copy request ID"** |
| Dismiss | 20px `×` at trailing edge, `--fg-tertiary` |
| Clear all | when ≥2 notices, a 24px row above the stack: 12px `--fg-tertiary` *"Clear all"* |
| Enter | `opacity 0→1` + `translateY(4px→0)` over `var(--dur-base) var(--ease-out-quad)` |

Footnote copy: *"Clearing a notice removes the notification, not the underlying action."*

### 3.10 Bot profile editor

Modal, 480 × 620, radius 12.
Title: **"Edit Profile"**. Exactly four fields — **name, title, description, avatar**.

| Field | Control |
|---|---|
| Avatar | 96px live preview, then a shape row (10 × 40px shape buttons, horizontal scroll) and a color row (11 × 28px circular swatches from `--av-*`). Selected = 2px `--fg-primary` ring at 2px offset |
| **Name** | 44px input, radius 12, placeholder *"Short name"*, max 32 chars, counter appears at 24 |
| **Title** | 44px input, placeholder *"One primary job"*, helper 13px `--fg-tertiary`: *"Good jobs: Talent Scout, Expense Manager, Bug Reproduction. 'General Helper' gives the Bot less to work with."* |
| **Description** | textarea, min 120px, radius 12, placeholder verbatim-style: *"Investigate product-performance questions using our observability tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short summary with the highest-impact issue first. Never change production settings."* Helper: *"Use the description for rules that should stay true. Use the conversation for one-off instructions."* |
| **Notifications** | toggle, 44px row, label *"Notify me when this Bot finishes or needs input"* |

Buttons: *"Cancel"* (secondary), *"Save"* (primary). Both 36px, radius 10.

### 3.11 Keyboard shortcut chips (kbd)

`inline-flex`, transparent root, no border on the root. Each key: weight 550, radius 4, `key + key { margin-left: 4px }`. [L]
- Small (in list rows): 10px, `min-width: 16px`, `min-height: 16px`.
- Normal (in menus): 13px, `min-width: 20px`, `min-height: 20px`.
- Style: `color: var(--fg-secondary); background: var(--surface-2); border: 1px solid var(--border-1)`.
- In a shortcut *list*, modifier keys (⇧ ⌘ ⌃ ⌥) get `min-width: 48px; text-align: left` so columns align.

### 3.12 New Group Chat modal

480 × 560. Title *"New Group Chat"*. Search input 44px at top. Selectable list of Bots (row 48, checkbox 18px trailing). Selected Bots render as removable 28px chips in a wrap row under the input. Footer: counter 13px `--fg-tertiary` *"{n} of 6 selected"*; primary button *"Create"* disabled below 2. Over 6: counter turns `--fg-danger`, further checkboxes disable.

### 3.13 Destructive confirmations

Modal 400 × auto, radius 12.
- Delete Bot — title *"Delete {name}?"*, body: *"This removes its profile, conversation, and routines. Files and sign-ins on the shared computer are not removed. If you may need the work later, hide the Bot instead."* Buttons: *"Cancel"*, *"Hide instead"* (secondary), *"Delete"* (`background: var(--fg-danger)`, `color: #fff`).
- Delete routine — *"Delete this routine? Deleting a routine is immediate and has no undo."*
- Remove section — *"Remove '{name}'? Its Bots move to Unassigned."*

---

## 4. INTERACTION SPEC

### 4.1 Hard limits (enforce in the data layer AND surface in UI)

| Limit | Value | UI behavior at the ceiling |
|---|---|---|
| Bots + group chats per account | **50 combined** | `+` menu items disable; tooltip *"You've reached 50 Bots and groups."* |
| Bots per group | **2–6** | see §3.12 |
| Routines per Bot | **50** | *"Add routine"* disables |
| Run records kept per routine | **20** | oldest evicted silently |
| Attachments per message | **6** | see §3.6 |
| File size | **25 MB**; video **200 MB** | pre-flight reject with the size in the message |
| Teach-a-task recording | **10 minutes** | countdown appears at 9:00, red at 9:30, auto-stops |
| Concurrent computer-use tasks per Bot | **1** | new computer-use request queues; transcript shows *"Waiting for the current task on {Bot}'s screen"* |

### 4.2 Mentions and slash

- **`/` references a saved skill. Nothing else.**
- **`@` addresses four entity types: Bots, groups, routines, connectors.** Plus the literal token `@everyone`.
- Both pickers are scoped to what is enabled for the current Bot. If a skill is missing, the empty state names the fix path (Settings → Plugins → Yours).
- Trigger rule: `@` or `/` fires the picker only at a word boundary (start of input, or preceded by whitespace). Typing inside a word does not.
- A committed mention becomes an atomic chip carrying an entity id, not a text substring. Serialize to the model as `@Name` but persist the id.

**Group addressing — the four tiers, in this exact priority:**
1. No mention → participating Bots negotiate who responds (implicit routing). This is the default and must work.
2. One `@Bot` → that Bot owns the request.
3. Multiple `@Bot` mentions → each named Bot takes its clause.
4. `@everyone` → group-wide. Show a 13px `--fg-tertiary` inline hint under the composer on insert: *"Use sparingly."*

Reference multi-assignment message (ship as an onboarding example in a new group's empty state):
> `@Researcher` gather the source material and link every claim. `@Writer` turn the findings into a launch draft. `@Reviewer` check the draft against the sources and list only blocking issues. Do not publish anything.

**Attachment asymmetry — enforce it:** human→group messages may carry attachments. Bot→group handoff messages are **text-only**. Bot→Bot direct messages may carry attachments. If a Bot tries to attach in a group, drop the attachment and render an inline step: *"Sent the file to {Bot} directly."*

### 4.3 Handoffs

Model: **wake → handle → reply later.** Asynchronous, never blocking.

- Rendered inline as a centered handoff row (§3.5), never as a bubble.
- The receiving Bot's sidebar row flips to `needs-attention` with preview *"Handed off from {Sender}"*.
- Ownership is first-class: store `current_owner_bot_id` on the conversation; the header pill in a group shows a 12px `--fg-tertiary` suffix *"· {Owner} is on it"*.
- Guardrail: if more than 2 handoffs fire within one turn, surface a one-time inline hint at 13px `--fg-tertiary`: *"Multiple Bots picked this up. Ask for a single owner at each stage."*

### 4.4 Stop, redirect, retry

There is **no dedicated stop API** in the emulated product — interruption is conversational. Emulate both layers:

1. **The composer stays live during a run.** Never disable it.
2. **A direct message from the user outranks background work** and can redirect the current turn.
3. **Trailing button becomes a stop control while working.** Clicking it sends the literal message **`Stop now`** as a user turn (visible in the transcript — do not hide it). Keyboard: `⌘/Ctrl+⇧+K`.
4. **Under the stop button, and after any stop, show:** *"This doesn't undo actions already completed."* 13px `--fg-tertiary`, dismissible, once per conversation per session.
5. **Local process termination** (for anything the app itself spawned): spawn detached, kill the whole process group — see §5.7. A partial kill leaves orphans burning CPU after the user hits Stop, which is the single most damaging polish failure in an agent app.

**Retry surfaces:**
- Failed user message → inline `!` → *"Retry"* / *"Delete"*.
- Failed agent turn → bubble footer *"Retry"*, which resends the last user turn unchanged.
- Failed tool/computer action → Notifications tray notice with **"Retry"** and, for computer failures, **"Recover computer"**.
- Stale approval card → *"Ask for a new one"*, which sends a system-authored user turn requesting regeneration with corrected scope.

### 4.5 Approvals

Desktop button set, verbatim and in this order: **"Allow once"** · **"Deny"** · **"Always allow"**.

- Card must show the proposed operation, its target, and its inputs. For local commands, show the exact command in `--font-mono` at 13px inside the nested panel.
- **"Always allow"** opens a 320px popover to confirm the rule scope before saving; the saved rule appears under Settings → General → Auto-review.
- Reactions must never be wired to approve/deny. Acknowledgement only.
- After resolution the card is immutable and shows its outcome state (§3.5). Never remove a resolved card from the transcript.
- Copy pinned under the first approval card a user ever sees: *"An approval controls the proposed action. It does not reverse work already completed."*
- Rule precedence, enforced in code: `Require Approval` beats `Always Allow` on any match.

**Credentials never route through approvals.** Two separate paths:
- *Takeover:* Open Agent Computer → Take control → complete the step → Return control → tell the Bot to continue. The banner during takeover reads *"You have control. Return control when you're done."* with a `Return control` button.
- *Secure secret request:* masked input card (§3.5), value excluded from the transcript and never sent to the model.

### 4.6 Notifications

| Rule | Behavior |
|---|---|
| Scope | **Per-Bot** toggle. Group chats have **no** per-Bot notification switch |
| Triggers | exactly two: the Bot **finishes**, or the Bot **needs input** |
| Suppression | suppressed while the app is focused; sidebar dot and dock badge still update |
| Dock badge | count of `needs-attention` + `unread` conversations; `app.setBadgeCount(n)` on macOS, `win.setOverlayIcon` on Windows |
| Read state | opening a conversation marks its current activity read; manual mark read/unread lives in the Bot menu |
| OS notification title | `{Bot name}` |
| OS notification body | needs-input: *"Needs your approval: {short action}"* · finished: first 140 chars of the final message, whitespace-collapsed |
| Click | focus window, open that conversation, scroll to the triggering message |
| Grouping | at most 1 notification per Bot per 30s; a second one replaces the first (`tag = botId`) |

### 4.7 Search

One combined search + command palette. Capabilities, exhaustively:
- Switch between Bots and groups
- Find prior messages
- Find files, links, and routines
- Open settings and common actions
- Jump back to the matching place in a conversation

Implementation: SQLite FTS5 over messages (§5.5). Query on a 120ms debounce, `LIMIT 8` per group, `bm25(10.0, 1.0)` ranking weighting title over body. Highlight matched terms in results with `background: var(--accent-soft); color: var(--accent)` — no `<mark>` default styling.
Fallback path (must exist): if cross-conversation search is unavailable, the palette shows Bots and actions only, plus the empty-state copy in §3.7, and per-conversation `⌘F` still works.

### 4.8 Keyboard shortcuts

This table is the SHIPPED set — every row is a binding that exists, and `Help → Keyboard Shortcuts` renders it with kbd chips (§3.11). Add a shortcut and add it to both in the same change; the sheet's whole value is that it can be trusted.

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + N` | New Bot (opens the create sheet) |
| `⌘/Ctrl + ⇧ + N` | New Group Chat |
| `⌘/Ctrl + K` | Command palette |
| `⌘/Ctrl + F` | Search every message |
| `⌘/Ctrl + ,` | Settings |
| `⌘/Ctrl + /` | Keyboard Shortcuts |
| `⌘/Ctrl + B` | Show / hide sidebar |
| `⌘/Ctrl + I` | Toggle conversation details |
| `⌘/Ctrl + 1…9` | Jump to sidebar position n |
| `Ctrl + Tab` / `Ctrl + ⇧ + Tab` | Next / previous conversation |
| `⌘/Ctrl + ⇧ + U` | Mark this conversation read |
| `⌘/Ctrl + ⇧ + E` | Export transcript as Markdown |
| `⌘/Ctrl + .` | Stop this conversation |
| `⌘/Ctrl + ⇧ + K` | Send `Stop now` |
| `⌘/Ctrl + R` | Reload the window (Electron's `reload` role) |
| `Enter` | Send (`⌘/Ctrl + Enter` if the user picked that in Settings) |
| `⇧ + Enter` | Newline |
| `↑` in an empty composer | Load your last message for editing |
| `@` / `/` | Open the mention / skill picker |
| `Esc` (picker open) | Dismiss picker, keep text |
| `Esc` (picker closed) | Close overlay → blur composer → clear reply-to |
| `↑` / `↓` (message focused) | Move between messages |
| `→` (message focused) | Enter that message's action bar |
| `←` (in the action bar) | Back to the message |

Register app-level accelerators via `Menu` roles, not `globalShortcut` — global shortcuts steal keys from other apps.

**Deliberately not bound** (this list used to sit in the table above as if it shipped):

- `⌘/Ctrl + ⇧ + C` copy focused message and `J` / `K` list navigation. The transcript's arrow-key model covers the same ground; if J/K are added they belong in `MessageList.onRowKeyDown` beside the existing `ArrowDown`/`ArrowUp` branch, NOT in a global hotkey map — `useHotkeys` only suppresses bare keys inside form fields, so a global `j` would also fire while the sidebar, the details panel or a palette result list holds focus.
- `⌘/Ctrl + R` retry. `⌘R` is Electron's `reload` role and reloading is what every desktop user expects from it; re-running a Bot turn (and spending a Claude turn) on that key is a footgun. Retry stays a visible per-message action.
- `⌘/Ctrl + Enter` / `⌘/Ctrl + ⇧ + ⌫` on an approval card, and `⌘/Ctrl + D` for the Agent Computer (§2.7): those surfaces are not built.

---

## 5. STACK DECISIONS

Every version below is pinned exactly. Ranges are how a working build silently drifts into a broken one.

### 5.1 `package.json`

```jsonc
{
  "name": "claude-code-bots",
  "version": "0.1.0",
  "main": "out/main/index.js",
  // DO NOT add "type": "module". See §5.3.
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "pack:mac": "npm run build && electron-builder --mac --dir",
    "dist:mac": "npm run build && electron-builder --mac"
  },
  "dependencies": {
    "better-sqlite3": "13.0.3",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "electron": "43.4.1",
    "electron-vite": "5.0.0",
    "vite": "7.3.6",
    "electron-builder": "26.15.3",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "@vitejs/plugin-react": "5.1.1",
    "tailwindcss": "4.3.3",
    "@tailwindcss/vite": "4.3.3",
    "react-markdown": "10.1.0",
    "remark-gfm": "4.0.1",
    "shiki": "4.4.3",
    "@shikijs/langs": "4.4.3",
    "@shikijs/themes": "4.4.3",
    "@shikijs/rehype": "4.4.3",
    "typescript": "5.9.3"
  }
}
```

**Failure modes each pin prevents:**

| Pin | Prevents |
|---|---|
| `vite` **7.3.6**, not 8.x | `electron-vite@5.0.0` declares `peerDependencies.vite: "^5 \|\| ^6 \|\| ^7"`. `npm i vite` installs 8.2.2 and yields an unsupported combination. Vite 8 requires `electron-vite@6.0.0-beta`. |
| `better-sqlite3` in **dependencies** | electron-builder packages `dependencies` only. In devDependencies you get `Cannot find module 'better-sqlite3'` **only in the packaged app**, never in `npm run dev` — the classic late-stage failure. |
| `react`, `tailwind`, `shiki` in **devDependencies** | They get bundled into the renderer chunk. Leaving them in `dependencies` ships duplicate copies inside the asar. |
| `better-sqlite3` **13.0.3** exactly | v13 is N-API (`NAPI_VERSION=10`), so the same prebuilt binary loads in Node 22 (ABI 127) and Electron 43 (ABI 148) with **zero rebuild**. Drifting back to 12.x via a caret range silently reintroduces the `NODE_MODULE_VERSION` mismatch and forces `@electron/rebuild`. |
| No `electron-rebuild` / `@electron/rebuild` postinstall | better-sqlite3's own troubleshooting doc still tells you to add one. That advice predates the N-API switch. Adding it is a no-op that only imports node-gyp/Python/Xcode failure surface onto every contributor machine. |
| `typescript` **5.9.3**, not 7.x | TS 7 is a major rewrite; pick it deliberately, not implicitly. |

### 5.2 `electron.vite.config.ts`

```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Native .node addons cannot be bundled. Belt-and-braces on top of
        // build.externalizeDeps (on by default in electron-vite 5).
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        // CRITICAL. See §5.3.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],   // Tailwind belongs ONLY here
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  }
})
```

Notes: `externalizeDepsPlugin` and `bytecodePlugin` are **deprecated in electron-vite 5** — do not import them; use the `build.externalizeDeps` / `build.bytecode` options. The nested `main`/`preload`/`renderer` fields must be **static objects** in v5; function-based config for those fields no longer works (you may still export a top-level function for command/mode branching).

### 5.3 The ESM-preload trap (highest-severity silent failure)

Verified matrix on Electron 43.4.1:

| `sandbox` | Preload format | Result |
|---|---|---|
| `true` (**default since Electron 20**) | ESM `.mjs` | ❌ `Cannot use import statement outside a module`; `window.api === undefined`; window loads normally, **no build error** |
| `false` | ESM `.mjs` | ✅ |
| `true` | CJS `.cjs` | ✅ |
| `false` | CJS `.cjs` | ✅ |

Adding `"type": "module"` to `package.json` is exactly what makes electron-vite emit `out/preload/index.mjs`. The failure presents as "my IPC bridge is undefined," not as a build failure, and costs hours.

**Two rules:**
1. Omit `"type": "module"` entirely. Main and preload both emit CJS and the trap cannot occur.
2. Even so, keep the `output.format: 'cjs'` override in §5.2 so a future `"type": "module"` cannot reintroduce it.

Second trap in the same area: with `"type": "module"`, main emits as `out/main/index.js` (ESM), **not** `.mjs`. Setting `"main": "out/main/index.mjs"` makes Electron find no entry and produce **no output and no error**.

Window construction:

```ts
const win = new BrowserWindow({
  width: 1180, height: 780, minWidth: 880, minHeight: 600,
  show: false,
  backgroundColor: '#101113',
  titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
  trafficLightPosition: { x: 20, y: 21 },
  webPreferences: {
    preload: join(__dirname, '../preload/index.cjs'),  // .cjs, not .js/.mjs
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
})
win.once('ready-to-show', () => win.show())   // kills the white flash
```

### 5.4 Preload bridge + typing

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listBots:   ():             Promise<Bot[]>     => ipcRenderer.invoke('bots:list'),
  search:     (q: string):    Promise<Hit[]>     => ipcRenderer.invoke('search:query', q),
  sendMessage:(p: SendInput): Promise<Message>   => ipcRenderer.invoke('msg:send', p),
  stopRun:    (id: string):   Promise<void>      => ipcRenderer.invoke('run:stop', id),
  onEvent:    (cb: (e: AppEvent) => void) => {
    const h = (_: unknown, e: AppEvent) => cb(e)
    ipcRenderer.on('app:event', h)
    return () => ipcRenderer.off('app:event', h)
  }
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```

```ts
// src/renderer/src/env.d.ts
import type { Api } from '../../preload'
declare global { interface Window { api: Api } }
export {}
```

**Never expose `ipcRenderer` itself.** It hands the renderer an unfiltered channel. Expose one narrow function per channel and validate every payload in main with Zod before it reaches SQLite:

```ts
const SendInput = z.object({
  conversationId: z.string().uuid(),
  text: z.string().max(32_000),
  attachmentIds: z.array(z.string().uuid()).max(6)   // enforces the 6-attachment limit
})
ipcMain.handle('msg:send', (_e, raw) => insertMessage(SendInput.parse(raw)))
```

### 5.5 SQLite + FTS5

better-sqlite3 13.0.3 ships prebuilt binaries for all 8 platforms **inside the npm tarball** (`"gypfile": false`); node-gyp never runs, there is no `build/` directory, and there is no download step.

**Non-stock SQLite compile flags that will bite you** (bundled SQLite 3.53.4):

| Flag | Consequence |
|---|---|
| `SQLITE_DQS=0` | Double-quoted string literals are **disabled**. `WHERE name = "foo"` raises `no such column: foo`. Single quotes always. |
| `SQLITE_DEFAULT_FOREIGN_KEYS=1` | Foreign keys are **ON by default**, unlike stock SQLite. Data that passes elsewhere fails here. |
| `SQLITE_USE_URI=0` | `file:x.db?mode=ro` URI filenames are off. |
| `SQLITE_DEFAULT_CACHE_SIZE=-16000` | 16 MB page cache. |
| Enabled | FTS5 (verified at runtime), JSON1, RTREE, MATH_FUNCTIONS, STAT4, DBSTAT_VTAB, DESERIALIZE. |

Boot sequence:

```ts
import Database from 'better-sqlite3'
const db = new Database(join(app.getPath('userData'), 'bots.db'))
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')      // already default here; be explicit
db.pragma('busy_timeout = 5000')
```

**FTS5 external-content index — the exact schema and all three triggers:**

```sql
CREATE TABLE message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  bot_id          TEXT REFERENCES bot(id) ON DELETE SET NULL,
  author          TEXT NOT NULL CHECK (author IN ('user','bot','system')),
  kind            TEXT NOT NULL DEFAULT 'text'
                    CHECK (kind IN ('text','status','file','link','tool','approval',
                                    'connect','secret','handoff','computer_step')),
  body            TEXT NOT NULL DEFAULT '',
  payload_json    TEXT,
  reply_to_id     TEXT REFERENCES message(id) ON DELETE SET NULL,
  thread_root_id  TEXT REFERENCES message(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  rowid_alias     INTEGER
);
CREATE INDEX idx_message_convo_time ON message(conversation_id, created_at DESC);

CREATE VIRTUAL TABLE message_fts USING fts5(
  body, author_name,
  content='message', content_rowid='rowid'
);

CREATE TRIGGER message_ai AFTER INSERT ON message BEGIN
  INSERT INTO message_fts(rowid, body, author_name)
  VALUES (new.rowid, new.body, new.author);
END;

CREATE TRIGGER message_ad AFTER DELETE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, body, author_name)
  VALUES ('delete', old.rowid, old.body, old.author);
END;

CREATE TRIGGER message_au AFTER UPDATE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, body, author_name)
  VALUES ('delete', old.rowid, old.body, old.author);
  INSERT INTO message_fts(rowid, body, author_name)
  VALUES (new.rowid, new.body, new.author);
END;
```

**The corruption failure mode:** the `'delete'` command row must carry the **old** column values **exactly as currently stored**. Passing `NULL`, a subset of columns, or already-updated values (e.g. writing the delete as `BEFORE UPDATE`, or referencing `new.*`) leaves orphaned index entries. FTS5 does not error — it silently corrupts, and queries later return phantom rowids pointing at rows that no longer exist. Always mirror **all** indexed columns from `old.*`.

Maintenance commands to wire into a hidden dev menu:
```sql
INSERT INTO message_fts(message_fts) VALUES('rebuild');          -- after backfilling existing rows
INSERT INTO message_fts(message_fts) VALUES('integrity-check');  -- detects the corruption above
INSERT INTO message_fts(message_fts, rank) VALUES('rank','bm25(10.0, 1.0)');
```

Creating triggers does **not** index pre-existing rows. Run `'rebuild'` after any migration that adds the index, or MATCH returns nothing while the content table is full — which reads exactly like "search is broken."

Use external content (`content='message'`), not contentless: contentless tables cannot `'rebuild'` and cannot be repaired.

**Bundler note:** better-sqlite3 v13 has an `exports` map. Deep imports like `require('better-sqlite3/lib/binding.js')` now throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. If you ever bundle main instead of externalizing, use the static per-platform subpath: `require('better-sqlite3/darwin-arm64')`.

### 5.6 Tailwind v4 wiring and its silent failure

Tailwind v4 is CSS-first: **no `tailwind.config.js`, no `postcss.config.js`, no autoprefixer**. Any 2026 tutorial creating those files is v3-era.

**The failure:** Tailwind v4's automatic source detection is rooted at the **CSS file's own directory** and does not walk arbitrarily upward. A component at `src/shared/BotAvatar.tsx` using `bg-emerald-600` imported into the renderer produces **byte-identical CSS** — the class is silently dropped, no warning. It presents as "Tailwind randomly doesn't style some components."

**The fix**, in `src/renderer/src/main.css`:
```css
@import "tailwindcss";
@source "../../shared";
@source "../../main/ui";   /* any other root outside src/renderer */
```

Second variant of the same failure: auto-detection **respects `.gitignore`**. A generated or vendored component directory that is gitignored is skipped identically. `@source` overrides the ignore.

### 5.7 Child processes: killing the whole tree

**Verified failure:** `spawn('sh', ['-c', 'cmd'])` + `child.kill('SIGTERM')` kills the direct child; **grandchildren survive as orphans** and keep burning CPU after the user hits Stop.

**Verified fix — process groups:**

```ts
const child = spawn(bin, args, {
  detached: true,          // setsid → child becomes a process-group leader
  stdio: 'pipe',
  env: { ...process.env, PATH: resolvedPath }
})
// DO NOT call child.unref() — you want to keep the handle.

function killTree(child: ChildProcess) {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* ESRCH */ }
  const t = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch {}
  }, 4000)
  child.once('exit', () => clearTimeout(t))
}

// detached:true means the child is NOT killed when Electron exits.
app.on('will-quit', () => activeChildren.forEach(killTree))
```

Note the **negative pid** — that is what signals the group. `tree-kill` exists but shells out to `pgrep`/`ps` per node; the group approach is faster and dependency-free on macOS. On Windows use `taskkill /pid <pid> /t /f`.

### 5.8 macOS GUI PATH

**Verified:** an Electron `.app` launched from Finder/Dock receives exactly `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew, nvm node, `~/.local/bin`, cargo — all absent. Spawning `node`, `git`, `rg` fails with `ENOENT` **only for users who launch from Finder**, never for you running `npm run dev`.

**Testing trap:** `open -W YourApp.app` from a terminal **inherits your shell environment** and shows a full PATH — a false negative. Reproduce the real condition with:
```bash
env -i HOME="$HOME" TMPDIR="$TMPDIR" /usr/bin/open -W dist/mac-arm64/ClaudeCodeBots.app
```

**Fix — resolve the login shell's PATH once, asynchronously, at startup:**

```ts
const shell = process.env.SHELL || '/bin/zsh'
const { stdout } = await execFile(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'],
                                  { timeout: 5000 })
const m = stdout.match(/__P__([\s\S]*)__P__/)
process.env.PATH = [m?.[1] ?? '', process.env.PATH].filter(Boolean).join(':')
```

Markers are required because rc files print banners. The explicit `timeout` is required — an rc file that prompts would otherwise wedge launch forever. Measured cost ≈ 640 ms: run it **once**, cache it, and never block `app.whenReady()` on it.

**Prefer absolute paths over PATH mutation.** PATH repair is heuristic (fish/nu syntax differs; rc files may be guarded by interactive checks). For any CLI you depend on: resolve it once to an absolute path at startup (search the repaired PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`), cache it, and if it isn't found surface *"CLI not found — set its path in Settings"* with a file picker override. Then spawn the absolute path and pass the repaired PATH in `env` for the child's own subprocesses.

### 5.9 electron-builder (v26 — **not** v27)

**Config trap:** `electron.build` currently documents **v27 (alpha)**, where all macOS signing options moved into a nested `mac.sign` object and native-module options moved under `nativeModules`. Stable **26.15.3** keeps those keys **flat** (`mac.identity`). Copying a v27 snippet into a v26 project produces config that is **silently ignored** — you get an unexpectedly signed or unsigned build with no error.

```jsonc
"build": {
  "appId": "com.claudecodebots.app",
  "productName": "Claude Code Bots",
  "directories": { "output": "dist" },
  "files": [
    "out/**/*",
    "package.json",
    "!node_modules/better-sqlite3/prebuilds/*",
    "node_modules/better-sqlite3/prebuilds/${platform}-${arch}.node",
    "!node_modules/better-sqlite3/deps${/*}",
    "!node_modules/better-sqlite3/src${/*}"
  ],
  "mac": {
    "identity": null,
    "target": ["dir"],
    "category": "public.app-category.productivity"
  },
  "win": { "target": ["nsis"] }
}
```

| Setting | Failure mode it prevents |
|---|---|
| The four `prebuilds`/`deps`/`src` file rules | electron-builder auto-unpacks native modules and shipped **all eight** platform prebuilds (16 MB) plus 9.8 MB of unused SQLite C source into a macOS arm64 build that needs one 1.9 MB `.node`. Verified: this filter drops ~24 MB of dead weight. `${arch}`/`${platform}` are electron-builder macros, so universal/x64 builds still resolve. |
| `"identity": null` | **Unset is the dangerous value.** Unset means electron-builder searches the keychain; a developer who happens to hold a Developer ID gets a signed build while everyone else gets unsigned — "works on my machine" codesign ambiguity. `null` = skip signing entirely, deterministic for every developer. `"-"` = explicit ad-hoc. |
| `"target": ["dir"]` for local iteration | Skips DMG creation entirely. Switch to `["dmg","zip"]` only when producing a distributable. |
| No `npmRebuild:false` needed | electron-builder still invokes `@electron/rebuild` during packaging; with the N-API prebuild present it completes instantly as a no-op. |

If you choose ad-hoc (`"identity": "-"`) instead of `null`, you must also set `"hardenedRuntime": false` **or** add `com.apple.security.cs.disable-library-validation` to entitlements — hardened runtime defaults to true and its library validation rejects the pre-signed Electron framework's different Team ID, and the app will not launch.

Distributing an unsigned build to a colleague: a locally-built app runs fine, but the same app zipped and downloaded picks up `com.apple.quarantine` and macOS reports *"damaged and can't be opened"* (misleading — it means unsigned + quarantined). Recipient fix: `xattr -dr com.apple.quarantine /Applications/"Claude Code Bots.app"`. For CI, `CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --dir` suppresses keychain discovery without touching config.

### 5.10 Markdown rendering

`react-markdown@10.1.0` is **safe by default** — verified: `<img src=x onerror="alert(1)">` and `<script>alert(2)</script>` come through fully escaped as text, with no `dangerouslySetInnerHTML` anywhere in the render path. `defaultUrlTransform` already restricts to `http/https/irc/ircs/mailto/xmpp`, blocking `javascript:` and `data:`.

**To keep that guarantee:**
- **Do not add `rehype-raw`.** It re-enables raw HTML and adds ~60 kB.
- **Do not override `urlTransform`.**
- Add defense in depth: `disallowedElements={['script','iframe','object','embed','form','input']}` with `unwrapDisallowed`. (`allowedElements` and `disallowedElements` are mutually exclusive — passing both throws.)
- Route links through a `components.a` handler that calls `shell.openExternal` for http/https and refuses everything else. Never let the renderer navigate away from your bundle.

### 5.11 Syntax highlighting

**Critical:** react-markdown runs its unified pipeline **synchronously** inside render, so any async rehype plugin fails. The default `@shikijs/rehype` export creates its highlighter internally and **is async — it does not work here.**

```ts
// Module level, once. Never per render.
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export const highlighterPromise = createHighlighterCore({
  themes: [import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light')],
  langs: [
    import('@shikijs/langs/typescript'), import('@shikijs/langs/javascript'),
    import('@shikijs/langs/python'),     import('@shikijs/langs/bash'),
    import('@shikijs/langs/json'),       import('@shikijs/langs/sql')
  ],
  engine: createJavaScriptRegexEngine()   // no Oniguruma WASM at all
})
```

Measured: **5 ms init**. Bare `shiki` or `shiki/bundle/full` is ~6.4 MB minified because it carries every grammar and theme — never import it.

**API-shape trap:** `rehypeShikiFromHighlighter` is a unified **attacher** taking `(highlighter, options)`. Pre-calling it —
`rehypePlugins={[rehypeShikiFromHighlighter(hl, opts)]}` — throws `TypeError: Cannot use 'in' operator to search for 'children' in undefined` from deep inside unist internals, with a stack that names nothing at your call site. The correct form is the multi-argument tuple:

```tsx
rehypePlugins={[[rehypeShikiFromHighlighter, hl, { themes: { light: 'github-light', dark: 'github-dark' } }]]}
```

Lazily `highlighter.loadLanguage(import('@shikijs/langs/rust'))` for the long tail and re-render on resolve. Call `dispose()` on teardown.

### 5.12 Build order — do this first

Every failure that costs real time appears **only in a packaged app**. Before writing any UI, stand up this vertical slice:

1. `electron-vite build`
2. `electron-builder --mac --dir`
3. Launch the `.app` from Finder
4. Open the SQLite db and run one FTS5 `MATCH`
5. `env -i HOME="$HOME" /usr/bin/open -W …` to prove PATH handling
6. Spawn a child, kill the group, assert zero survivors

The sandbox/preload trap, the PATH trap, asar unpacking, and prebuild bloat all surface here. **None of them surface in `npm run dev`.**

---

## 6. POLISH CHECKLIST

Each item is a specific technique with a specific value. Tick them off.

**Window chrome**
- [ ] `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: {x:20, y:21}` for a 56px header. Recompute `y = (headerHeight − 14) / 2` if the header changes; reposition at runtime with `win.setWindowButtonPosition()` rather than recreating the window.
- [ ] Every interactive child inside a drag region gets `-webkit-app-region: no-drag`. **Drag regions swallow all pointer events** — a button overlapping one emits no clicks and no enter/leave.
- [ ] `user-select: none` on drag regions.
- [ ] **Never** attach a custom context menu to a drag region — some platforms show the system menu instead. This means sidebar rows must not sit inside the drag strip.
- [ ] `backgroundColor` set at construction + `show: false` until `ready-to-show`. No white flash, ever.
- [ ] Accept that double-click-to-zoom on the titlebar does not work with `app-region: drag` and cannot be correctly polyfilled (the user's zoom-vs-minimize preference is not exposed). Document it; do not chase it.
- [ ] No vibrancy. Flat opaque surfaces. Electron supports one vibrancy material per window anyway, so a `sidebar`-material sidebar plus `under-window` content is impossible without a native module.

**Scrolling and streaming**
- [ ] Spring-driven stick-to-bottom: `damping 0.7`, `stiffness 0.05`, `mass 1.25`. Per tick: `velocity = (damping*velocity + stiffness*scrollDifference) / mass; accumulated += velocity * tickDelta` with `tickDelta` normalized to `1000/60`. A proportional controller with inertia converges smoothly when content height jumps mid-stream; fixed-duration easing cannot.
- [ ] `isAtBottom` threshold: **70px**. Programmatic-scroll retention window: **350ms**.
- [ ] Track `isAtBottom`, `isNearBottom`, and `escapedFromLock` as **separate** flags. The escape flag is what stops the app fighting a user who scrolled up.
- [ ] Distinguish user scroll from programmatic scroll with a global `mousedown`/`wheel`/`touchstart` flag plus the 350ms window plus comparing observed vs expected `scrollTop`. **Never debounce** — debouncing drops events.
- [ ] Drive scroll from a **ResizeObserver on the inner content element**, not from the token stream and not from scroll events. Streaming text changes height without firing any scroll event.
- [ ] `overflow-anchor: none` on each message + a zero-height trailing anchor with `overflow-anchor: auto` as a cheap safety net for non-streaming inserts. You are always on Chromium; the "Safari doesn't support it" objection is irrelevant.
- [ ] `overscroll-behavior: contain` on the scroller — stops scroll chaining and rubber-band jank.
- [ ] **Do NOT use `content-visibility: auto` on the streaming message list.** It substitutes estimated sizes for offscreen elements, mutating `scrollHeight` — exactly the value stick-to-bottom depends on. Safe on the sidebar list and collapsed older panes only.
- [ ] Do not sprinkle `will-change: transform` on a long list; it costs memory without helping.
- [ ] **Do not** use `flex-direction: column-reverse`. It inverts DOM/reading order, breaks sticky date separators, breaks scroll-to-message math, and makes selection and find-in-page behave oddly.
- [ ] Beyond a few thousand messages, add real virtualization (react-virtuoso has first-class reverse/stick-to-bottom), not `content-visibility`.

**Streaming markdown**
- [ ] Split into blocks with `Lexer.lex(text, { gfm: true })`, accumulate `token.raw`, and `React.memo` each block. Only the last block changes as tokens arrive; every earlier block's `raw` is byte-identical, so memo hits. O(n²) → O(n).
- [ ] **Merge tokens while inside an unclosed HTML block.** Track a stack of open tag names, counting opens vs closes per token and skipping self-closing `/>`; while the stack is non-empty, append into the *previous* block instead of starting a new one.
- [ ] **Merge while `$$` count in the previous block is odd** (unclosed block math). Without both merges, one unclosed `<div>` shifts every subsequent block boundary and destroys all downstream memoization.
- [ ] Memo comparator checks `content`, `index`, `isIncomplete`, `dir`, then shallow-compares the `components` map by key count and per-key identity, then `remarkPlugins`/`rehypePlugins` **by reference**.
- [ ] Pass `components`, `remarkPlugins`, `rehypePlugins` as **module-level constants**. Inline object/array literals are new references every render and silently defeat the entire memoization strategy.
- [ ] Repair unterminated markdown before parsing: close `**`, `*`, `_`, `` ` ``, `~~`, `***`, `$$`; complete incomplete links with a placeholder href (or render text-only); **remove** incomplete images entirely rather than showing a broken placeholder. Without this, text visibly flickers between raw `**foo` and bold as the closing marker lands.
- [ ] Highlight only **closed** code fences. Render an in-progress fence as pre-formatted plain text with the right font and background, then swap once the closing ``` arrives. Highlighters re-tokenize the whole fence on every keystroke otherwise.
- [ ] Use `isIncomplete` on the last block to render the streaming caret without touching closed blocks.

**Type and color**
- [ ] Body is **15px**, not 16px. Chrome is 13/14/15/16 with no large step between body and title.
- [ ] Negative tracking that **increases as size decreases**: `-0.011em` at 15px, `-0.015em` at 10px. Screen convention, opposite of print.
- [ ] Emphasis weight **550**, not 600. If using Inter Variable, also take 510 for sidebar rows and 590 for unread titles/badges — non-standard axis values are a large part of why premium apps look different from apps using stock 500/600.
- [ ] `font-feature-settings: "cv01","cv02","ss03"` on Inter to de-Helvetica-ize it. `font-variation-settings: "opsz" auto`.
- [ ] Foreground primary is **`#FCFCFC`**, never `#FFFFFF`. The only pure white in the app is the avatar eyes.
- [ ] Elevation steps are **4–5 points of lightness** (`#050505` → `#141414` → `#212121` → `#363636`), paired with a translucent 1px border — never big jumps or heavy shadows.
- [ ] **Every divider is translucent white/black at 8% / 14% / 20%.** No solid gray strokes anywhere.
- [ ] Dark shadows are **bigger blur and much higher alpha** than light (35% vs 6%). They are not "light shadows, darker."
- [ ] Keep a `--shadow-none: 0px 0px 0px transparent` token so shadow transitions interpolate cleanly.

**Motion**
- [ ] Hover/reveal transitions at **100ms**; anything over ~150ms reads as lag.
- [ ] Highlight fade-**in** is **0ms**; only the fade-out is animated (150ms). Feedback appears instantly.
- [ ] Use `ease-out` variants almost exclusively for UI. `cubic-bezier(.25,.46,.45,.94)` is the default.
- [ ] Dialog open/close: **175ms**, `opacity 0→1` + `scale(.96)→1`.
- [ ] Invalid action = a **150ms scale(.98) squish**, never a shake.
- [ ] Global `prefers-reduced-motion` reset, then deliberately re-add only meaningful motion.
- [ ] **Also read it in JS** — `window.matchMedia('(prefers-reduced-motion: reduce)')` with a change listener — and make the scroll spring fall back to instant jumps. A JS-driven springing scroll is exactly the vestibular trigger the setting exists for, and CSS cannot reach it.

**Interaction detail**
- [ ] Selected/active rows use a `::after` pseudo-element with `inset: 2px 0; border-radius: 8px; z-index: -1`, not `background-color` on the row. The vertical inset keeps consecutive selected rows from touching, the radius applies to the pill not the row box, and `z-index:-1` keeps text crisp above it.
- [ ] Hover action bars stay in the DOM and toggle **`opacity` only** — never `display: none`. Reveal on `:hover`, `:focus-within` on the message, **and** `:focus-within` on the bar itself. Add `@media (hover: none) { opacity: 1 }`.
- [ ] Position hover actions absolutely so they can never reflow the message.
- [ ] Focus rings use `outline` + `outline-offset`, not `box-shadow` — the ring then follows `border-radius` automatically and never affects layout. `:focus:not(:focus-visible) { outline: none }` first.
- [ ] Focus ring is ≥2px with ≥3:1 contrast against **both** the component and the adjacent background, and must not be obscured by the sticky header (WCAG 2.2 SC 2.4.11 / 2.4.13). In a dark app one color rarely clears 3:1 everywhere — use a double ring (outline plus a contrasting box-shadow).
- [ ] Style `:focus-visible` on the message-list container itself so keyboard users can tell the list has focus before arrowing.
- [ ] Scrollbars: **6px, growing to 10px** on hover/drag, thumb at 10% / 20% / 40% white. Transparent track.
- [ ] Command palette at `top: 13vh` — not vertically centered.
- [ ] Palette shadow is **five stacked low-alpha layers** at different radii, not one big blur. That layering is what reads as expensive.
- [ ] Focus the palette input on open so typing works immediately; ↑/↓ navigate, Enter selects, Esc closes; `aria-selected` on the active option is what your `::after` styles hook.
- [ ] Native context menus are built and popped in the **main process**; the renderer only detects `contextmenu`, calls `preventDefault()`, and sends IPC. Rebuild the template per popup so enabled/checked state is never stale. Use built-in `role` values (`copy`, `cut`, `paste`, `selectAll`) for free labels, shortcuts, and localization. `menu.popup()` defaults to the mouse position — pass x/y only for keyboard-invoked menus.

**Loading and status**
- [ ] The "working" indicator is a gradient sweeping **through the label text** via `background-clip: text`, `background-size: 200% 100%`, 2s linear infinite — not a spinner beside it.
- [ ] The label is driven by **real agent events** (*"Reading files…"*, *"Opening docs.google.com"*, *"Drafting reply"*), never a timer cycling fake phrases. Information, not motion, is what reads as premium.
- [ ] **One** motion element per indicator — shimmer text OR bouncing dots, never both.
- [ ] Reserve the indicator row's height from the start so the message doesn't jump when real text replaces it.
- [ ] After ~5s, show elapsed time and a step count. Concrete numbers read as competence; motion alone reads as stalling.
- [ ] Gate offscreen shimmer on viewport visibility so it doesn't animate in a scrolled-away conversation.
- [ ] Skeletons only for **container-based** content — the sidebar list, conversation history. **Not** for "agent is thinking" (use the working indicator) and **not** for "message sending" (optimistic render at 60% opacity).
- [ ] Skeleton structure must match the final layout exactly. Three placeholder cards followed by twelve real rows destroys the trust the skeleton was meant to build.
- [ ] Delay skeletons by 200–300ms so fast loads never flash one; cap them at ~5s, then fall back to an explicit message or error.
- [ ] Stagger skeleton `animation-delay` by 80–120ms down the list so the group reads as a wave, not a single blinking block. Keep the sweep highlight only a few points lighter than the fill — high-contrast shimmer in dark mode looks cheap.

**Agent-app specific**
- [ ] Three visually distinct row states, never collapsed into one dot: **needs-attention** (`#FF640A` + 2px row-colored ring), **unread** (`--fg-primary` dot + preview promoted to primary), **working** (pulsing `--accent` avatar ring + live shimmer phase). Legibility of "which Bot needs me right now" at a glance is the whole product.
- [ ] Unread does more than a dot: promote the row title to weight 590 and `--fg-primary`. The weight/color shift carries more signal than the dot alone.
- [ ] Notifications suppressed while focused; sidebar and dock badge still update.
- [ ] Stop is always available and always visible during a run, and always accompanied by *"This doesn't undo actions already completed."*
- [ ] Killing a run kills the **process group**. An agent app that leaves orphans after Stop is not shippable.
- [ ] Resolved approval cards stay in the transcript with their outcome. Never remove decision history.
- [ ] Drafts persist per conversation on navigation away.