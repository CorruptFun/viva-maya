# Marketing assets

Shareable images. **Deliberately NOT in `public/`** — `vite-plugin-pwa` precaches everything under
`public/`, so parking 1.4 MB of PNGs there would add ~50% to the precache every player downloads on
install and again on every update. These are for humans on social, not for the app bundle.

| file | size | use |
|---|---|---|
| `install-guide-feed-1080x1350.png` | 1080×1350 (4:5) | feed posts — works almost everywhere |
| `install-guide-story-1080x1920.png` | 1080×1920 (9:16) | stories / Shorts / alongside a video |

Both are the iOS "Add to Home Screen" walkthrough: Share → Add to Home Screen → Add → done, each
panel cropped to the control being tapped so the labels stay legible at thumbnail size.

## Regenerating

Built by the `pwa-install-poster` skill (`~/.claude/skills/pwa-install-poster/`), which renders both
formats from a JSON config plus the app icon and a phone-proportioned screenshot. Re-run it if the
prize, the URL, or the app's look changes — do not hand-edit the PNGs.

⚠️ The advertised prize (**150 chips + a Jackpot Chip**) must stay in step with
`INSTALL_REWARD_CHIPS` / `INSTALL_REWARD_BOOST` in `src/core/install.ts`. If that grant is retuned
and these images are not regenerated, the poster is advertising a reward the game does not pay.

⚠️ The URL shown is `corrupt.solutions/games/viva-maya` — the canonical public URL, matching
`inviteUrl()` in `src/view/invite.ts`. The mocked Safari chrome inside the panels shows the **host**
only (`corrupt.solutions`), because that is what iOS actually displays there.
