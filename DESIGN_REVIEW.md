# Meeting Notes Design Review

## Issues addressed

- Cloud account, data, and installation controls crowded the meeting library.
- The same navigation pattern was used on phones, tablets, and desktops.
- The dark teal styling resembled a common AI dashboard and weakened the product identity.
- Important actions competed visually with secondary utilities.
- Mobile users could not easily reopen the full meeting library.

## Design decisions

- Moved cloud sync, account access, backup, restore, installation, privacy, and appearance into a dedicated Settings panel.
- Used a persistent library sidebar on desktop, a narrower working rail on tablet, and bottom navigation plus a library drawer on phone.
- Adopted a warm neutral palette with one restrained violet accent.
- Replaced decorative gradients and heavy shadows with calm surfaces, fine borders, and selective depth.
- Used native system typography, compact hierarchy, 44 pixel minimum controls, visible focus states, and safe-area-aware mobile navigation.
- Added System, Light, and Dark appearance choices stored per device.

## Core tokens

| Token | Light | Dark |
| --- | --- | --- |
| Background | `#f4f2f8` | `#15131a` |
| Surface | `#ffffff` | `#211e27` |
| Text | `#201d27` | `#f5f2f8` |
| Muted | `#6f6978` | `#aaa3b2` |
| Accent | `#6650a4` | `#b7a0ff` |
| Corner radius | 12 to 22 px | 12 to 22 px |

## Responsive and accessibility checks

- Desktop: persistent library and roomy two-column meeting content.
- Tablet: compact rail, reduced page gutters, and single-column content where needed.
- Phone: sticky app bar, library drawer, bottom navigation, full-screen Settings, and recording controls above the safe area.
- Keyboard: Escape closes Settings and focus returns to the opener.
- Controls: minimum 44 pixel targets and visible focus rings.
- Themes: semantic colors support System, Light, and Dark modes.
