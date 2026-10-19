# LILO design system

The shared UI primitives and CSS tokens own visual behavior. Feature pages
compose those primitives rather than inventing status placement, spacing or
control dimensions. Use the system font stack and the user's accent palette.

## Spacing and cards

The spacing scale is 4, 8, 12, 16, 24 and 32 px. Page padding is 24 px, card
padding is 16 px and control-row padding is 12 px. Grouped settings keep their
existing hairline rhythm. Boxed callouts and tools retain their own border,
padding and separation. Every adjacent button group declares a real gap.

`CardHeader` owns the title and optional secondary description on the left,
and status followed by optional controls on the right. A card's overall state
always belongs in that header. A setting-specific state belongs beside its
own setting. `Section` accepts a status slot and composes a card header;
provider/account sections must not concatenate status into the title.

`StatusBadge` renders short localized states with neutral, positive, warning
or negative tones. Badges have a consistent single-line size, do not grow,
and do not uppercase prose. Longer guidance is normal body text below a label.
Versions, file sizes and descriptions are metadata, not operational states.

## Controls and search

Buttons retain their intrinsic height in vertical cards: use `flex: 0 0 auto`.
Equal-height cards align actions at the bottom with the shared `.card-actions`
footer, which uses an automatic top margin and never grows with the content.
Place this footer last in the card, alongside its header and content blocks.
Never stretch a button to fill the available card height. Keep standard field
padding, typography and focus appearance. Search is a labeled control; when
its label is presented as a placeholder, also provide an accessible name.
Catalog toolbars align the title/count and search and wrap at narrower widths.

## Images and responsive layouts

Plugin items with pictures use a full-width media row: a 200 px tall preview
on the left, text and actions on the right. Pictures use `object-fit: contain`
so their content stays visible. Clicking the preview opens the existing viewer;
download, copy and other owned-tool actions remain available. Narrow windows
stack preview, description and actions and use a 240 px preview.

Non-image lists keep the compact responsive card grid. Tool catalogs use equal
row heights, while execution results remain a separate expandable activity list.
Spacing and alignment must be checked in the app; repository rules prohibit
browser-based UI testing.


## Loading and navigation

Settings headings and controls render immediately. Asynchronous content uses
`ContentSkeleton` with reserved card space, a localized status label and a quiet
pulse. Reduced motion disables the pulse. An empty state appears only after a
successful empty response. Keep loaded content mounted during plugin updates;
sidebar page component identities must remain stable. Key pages by navigation
identity so switching to another plugin does not reuse its data or form state.
Do not add artificial delays or animate completed content from invisible text.
