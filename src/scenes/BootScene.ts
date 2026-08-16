import Phaser from 'phaser'
import { mayPlay, returningFromCheckout } from '../core/entitlement'
import { createAllTextures, warmPieceTextures } from '../view/textures'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create(): void {
    createAllTextures(this)
    // Front-load the special-piece overlays + cascade particles the first deal-in would bake lazily,
    // so a cold PWA's opening cascade never hitches (BT2). Generate-once guarded — a few ms, no
    // visible boot change (BootScene stays hard/instant).
    warmPieceTextures(this)

    // PAID ENTRY gate. Deliberately the FIRST routing decision — ahead of every DEV shortcut below,
    // so nothing can be reached around it.
    //
    // `mayPlay()` is synchronous by design: it reads a cached verdict and the local save, never the
    // network, so boot never waits on a request that might not come back. It is safe here (and only
    // here) because main.ts awaits `bootstrapCloud()` before starting Phaser, so a returning
    // player's session is already restored by the time this runs.
    //
    // ⚠️ THE GATE IS READ ONCE, AT BOOT, AND NOWHERE ELSE. A revocation that lands mid-session takes
    // effect on the next launch. Ejecting a player from a level they are winning because a
    // background refresh came back unfavourably would be a far worse bug than a few extra minutes
    // of free play — and the honest cases (a slow webhook, a token refresh) look exactly like the
    // dishonest ones from here.
    //
    // `returningFromCheckout()` routes to the paywall even for a player who already reads as
    // entitled: they are coming back from Stripe and the scene owes them the "confirming your
    // payment" beat, the `entry_paid` event and a cleaned-up address bar. It exits to Home on its
    // own the moment the entitlement resolves.
    if (returningFromCheckout() || !mayPlay()) {
      this.scene.start('paywall')
      return
    }

    // DEV shortcuts: ?level=N jumps into a level, ?endless=1 into the weekly race, ?lightninground=1
    // into the ⚡ storm (automated checks). Lightning is tested FIRST because it also sets `endless`
    // inside GameScene.init — routing on `endless` first would drop the mode and open the race.
    const params = new URLSearchParams(location.search)
    const level = import.meta.env.DEV && params.has('level') ? Number(params.get('level')) : null
    if (import.meta.env.DEV && params.has('lightninground')) this.scene.start('game', { lightning: true })
    else if (import.meta.env.DEV && params.has('endless')) this.scene.start('game', { endless: true })
    else if (level && Number.isFinite(level)) this.scene.start('game', { level })
    else if (import.meta.env.DEV && params.get('scene')) this.scene.start(params.get('scene')!)
    else this.scene.start('home')
  }
}
