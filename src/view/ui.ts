import Phaser from 'phaser'
import { SWAP_SOUNDS, SWAP_SOUND_LABELS, sfx } from '../audio/sfx'
import { LIVES_MAX } from '../config'
import { formatCountdown } from '../core/lives'
import type { LivesState } from '../core/lives'

export const FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif'

export interface LivesHud {
  container: Phaser.GameObjects.Container
  /** Repaint hearts + countdown from a fresh LivesState (call on a per-second timer). */
  update: (state: LivesState) => void
}

/**
 * Row of ❤️ hearts (filled = available, faded = spent) with a "next life mm:ss"
 * countdown underneath. The energy pool for the lose-only lives system.
 */
export function addLivesHud(
  scene: Phaser.Scene,
  centerX: number,
  y: number,
  opts: { size?: number; gap?: number; showTimer?: boolean; timerColor?: string } = {}
): LivesHud {
  const size = opts.size ?? 34
  const gap = opts.gap ?? 10
  const showTimer = opts.showTimer ?? true
  const container = scene.add.container(centerX, y)
  const totalW = LIVES_MAX * size + (LIVES_MAX - 1) * gap
  const hearts: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < LIVES_MAX; i++) {
    const heart = scene.add
      .image(-totalW / 2 + size / 2 + i * (size + gap), 0, 'heart')
      .setDisplaySize(size, size)
    hearts.push(heart)
    container.add(heart)
  }
  let timer: Phaser.GameObjects.Text | undefined
  if (showTimer) {
    timer = scene.add
      .text(0, size / 2 + 14, '', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: opts.timerColor ?? '#9a927e' })
      .setOrigin(0.5)
    container.add(timer)
  }
  const update = (state: LivesState): void => {
    hearts.forEach((heart, i) => {
      const filled = i < state.lives
      heart.setAlpha(filled ? 1 : 0.24)
      if (filled) heart.clearTint()
      else heart.setTint(0x7a7266)
    })
    if (timer) timer.setText(state.full ? '' : `next life  ${formatCountdown(state.nextInMs)}`)
  }
  return { container, update }
}

/** Two-tone marquee title with a heart flourish, centered. */
export function addMarquee(scene: Phaser.Scene, centerX: number, y: number): void {
  const viva = scene.add
    .text(0, y, 'VIVA', { fontFamily: FONT, fontSize: '58px', fontStyle: '900', color: '#ffffff' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(4)
    .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
  viva.setTint(0xffd75e, 0xffd75e, 0xc9930a, 0xc9930a)
  const maya = scene.add
    .text(0, y, 'MAYA', { fontFamily: FONT, fontSize: '58px', fontStyle: '900', color: '#ffffff' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(4)
    .setShadow(0, 3, 'rgba(90,20,15,0.25)', 6, false, true)
  maya.setTint(0xff7a85, 0xff7a85, 0xd3304f, 0xd3304f)
  const gap = 18
  const heartW = 34
  const total = viva.width + gap + maya.width + 12 + heartW
  viva.setX(centerX - total / 2)
  maya.setX(viva.x + viva.width + gap)
  const heart = scene.add.image(maya.x + maya.width + 12 + heartW / 2, y - 14, 'heart')
  heart.setDisplaySize(heartW, heartW)
  scene.tweens.add({
    targets: heart,
    scale: heart.scaleX * 1.18,
    duration: 700,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  })
}

/**
 * Warm flame pill announcing the daily-spin streak — a return hook shown on the
 * home screen when streak > 0. The 🔥 lives in its own text object (no letterSpacing)
 * because letterSpacing splits emoji surrogate pairs in Phaser's glyph renderer.
 * Returns null when there's no streak to show.
 */
export function addStreakBadge(
  scene: Phaser.Scene,
  centerX: number,
  y: number,
  streak: number
): Phaser.GameObjects.Container | null {
  if (streak <= 0) return null
  const container = scene.add.container(centerX, y)
  const flame = scene.add.text(0, 0, '🔥', { fontFamily: 'sans-serif', fontSize: '32px' }).setOrigin(0.5)
  const label = scene.add
    .text(0, 0, `${streak} DAY STREAK`, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(2)
  const gap = 8
  const padX = 26
  const h = 54
  const w = flame.width + gap + label.width + padX * 2
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.16)
  g.fillRoundedRect(-w / 2 + 2, -h / 2 + 4, w, h, h / 2)
  g.fillStyle(0xfff3d6, 1)
  g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
  g.lineStyle(2, 0xf2c14e, 1)
  g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
  flame.setPosition(-w / 2 + padX + flame.width / 2, 0)
  label.setPosition(flame.x + flame.width / 2 + gap, 0)
  container.add([g, flame, label])
  // A little flame flicker so it reads as "alive" / on fire.
  scene.tweens.add({
    targets: flame,
    scaleX: 1.16,
    scaleY: 1.12,
    duration: 480,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  })
  return container
}

export interface PillStyle {
  fill: number
  border?: number
  textColor: string
}

export const GOLD_PILL: PillStyle = { fill: 0xf2b234, border: 0xc9930a, textColor: '#4a3305' }
export const GHOST_PILL: PillStyle = { fill: 0xffffff, border: 0xe8dfc9, textColor: '#8a8577' }
/** Rose "special mode" pill — sets the endless weekly race apart from the gold progression buttons. */
export const ROSE_PILL: PillStyle = { fill: 0xd3304f, border: 0xa8213c, textColor: '#ffffff' }

/** Rounded tappable button with press feedback. Returns the container. */
export function addPillButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  style: PillStyle,
  onTap: () => void
): Phaser.GameObjects.Container {
  const container = scene.add.container(x, y)
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.18)
  g.fillRoundedRect(-width / 2 + 2, -height / 2 + 4, width, height, height / 2)
  g.fillStyle(style.fill, 1)
  g.fillRoundedRect(-width / 2, -height / 2, width, height, height / 2)
  if (style.border !== undefined) {
    g.lineStyle(3, style.border, 1)
    g.strokeRoundedRect(-width / 2, -height / 2, width, height, height / 2)
  }
  const text = scene.add
    .text(0, 0, label, { fontFamily: FONT, fontSize: `${Math.round(height * 0.42)}px`, fontStyle: '900', color: style.textColor })
    .setOrigin(0.5)
    .setLetterSpacing(2)
  const zone = scene.add.rectangle(0, 0, width, height, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  zone.on('pointerdown', () => container.setScale(0.94))
  zone.on('pointerout', () => container.setScale(1))
  zone.on('pointerup', () => {
    container.setScale(1)
    sfx.uiTap()
    onTap()
  })
  container.add([g, text, zone])
  return container
}

/**
 * Round mute-toggle chip (🔊 / 🔇) styled like GHOST_PILL. Toggles + persists the
 * sfx mute flag; plays a tap only when re-enabling sound. Returns the container.
 */
export function addMuteChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const r = size / 2
  const container = scene.add.container(x, y).setDepth(50)
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.18)
  g.fillCircle(2, 3, r)
  g.fillStyle(GHOST_PILL.fill, 1)
  g.fillCircle(0, 0, r)
  g.lineStyle(2, GHOST_PILL.border ?? 0xe8dfc9, 1)
  g.strokeCircle(0, 0, r)
  const icon = scene.add
    .text(0, 1, sfx.muted ? '🔇' : '🔊', { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.5)}px` })
    .setOrigin(0.5)
  const zone = scene.add.rectangle(0, 0, size, size, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  zone.on('pointerdown', () => container.setScale(0.9))
  zone.on('pointerout', () => container.setScale(1))
  zone.on('pointerup', () => {
    container.setScale(1)
    const muted = sfx.toggleMuted()
    icon.setText(muted ? '🔇' : '🔊')
    if (!muted) sfx.uiTap()
  })
  container.add([g, icon, zone])
  return container
}

/** Round "?" help chip styled like GHOST_PILL — opens the how-to-play panel. */
export function addHelpChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const r = size / 2
  const container = scene.add.container(x, y).setDepth(50)
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.18)
  g.fillCircle(2, 3, r)
  g.fillStyle(GHOST_PILL.fill, 1)
  g.fillCircle(0, 0, r)
  g.lineStyle(2, GHOST_PILL.border ?? 0xe8dfc9, 1)
  g.strokeCircle(0, 0, r)
  const icon = scene.add
    .text(0, 1, '?', { fontFamily: FONT, fontSize: `${Math.round(size * 0.56)}px`, fontStyle: '900', color: '#8a8577' })
    .setOrigin(0.5)
  const zone = scene.add.rectangle(0, 0, size, size, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  zone.on('pointerdown', () => container.setScale(0.9))
  zone.on('pointerout', () => container.setScale(1))
  zone.on('pointerup', () => {
    container.setScale(1)
    sfx.uiTap()
    openHelpPanel(scene)
  })
  container.add([g, icon, zone])
  return container
}

interface HelpSection {
  icon: string
  title: string
  body: string
}

const HELP_SECTIONS: HelpSection[] = [
  { icon: 'clover', title: 'THE GOAL', body: 'Match 3+ of the same symbol in a row. Collect the goal symbols up top before your moves run out.' },
  { icon: 'diamond', title: 'MAKE A MOVE', body: 'Swipe a symbol into a neighbour, or tap two that touch, to swap. A swap only sticks if it makes a match.' },
  { icon: 'jackpot', title: 'POWER-UPS', body: 'Match 4 → Wild Reel (clears a line). L or T → Dice Bomb (3×3). Match 5 → Jackpot Chip (clears a colour).' },
  { icon: 'heart', title: 'LIVES', body: 'Losing a level costs a heart — winning is free. Out of hearts? One returns every 8 minutes.' },
  { icon: 'chip', title: 'DAILY BONUS', body: 'Spin once a day for a free boost. Come back daily to grow your streak.' },
  { icon: 'star', title: 'STARS', body: 'Finish with moves to spare for up to 3 stars. Every 10th level is a milestone.' },
  { icon: 'card', title: 'ENDLESS', body: 'After Level 30, race the weekly board — same for everyone. Beat your best score!' },
]

/**
 * How-to-play / FAQ overlay: a scrim + tall card of sections (icon + title + blurb), a GOT IT
 * button, and tap-outside-to-close. A transparent blocker over the card stops panel taps from
 * closing it. Everything lives in one container destroyed on close.
 */
export function openHelpPanel(scene: Phaser.Scene): void {
  const W = 720
  const H = 1280
  const layer = scene.add.container(0, 0).setDepth(60)

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => layer.destroy())

  const px = 40
  const pw = W - 80
  const pyTop = 118
  const ph = 1046
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.3)
  g.fillRoundedRect(px + 4, pyTop + 8, pw, ph, 30)
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'HOW TO PLAY', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  layer.add([scrim, g, block, title])

  const textX = px + 116
  const wrap = pw - (textX - px) - 34
  let y = pyTop + 116
  const rowH = 118
  for (const s of HELP_SECTIONS) {
    layer.add(scene.add.image(px + 66, y + 32, s.icon).setDisplaySize(52, 52))
    layer.add(
      scene.add
        .text(textX, y, s.title, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: '#2a2732' })
        .setOrigin(0, 0)
        .setLetterSpacing(1)
    )
    layer.add(
      scene.add
        .text(textX, y + 34, s.body, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '20px',
          color: '#6a6459',
          wordWrap: { width: wrap },
          lineSpacing: 4,
        })
        .setOrigin(0, 0)
    )
    y += rowH
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'GOT IT', GOLD_PILL, () => layer.destroy()))
  layer.add(
    scene.add
      .text(W / 2, pyTop + ph - 26, '© 2026 CorruptFun LLC · All rights reserved', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
        color: '#b3ab97',
      })
      .setOrigin(0.5)
  )
}

/** Round "♪" sound chip styled like GHOST_PILL — opens the move-sound picker. */
export function addSoundChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const r = size / 2
  const container = scene.add.container(x, y).setDepth(50)
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.18)
  g.fillCircle(2, 3, r)
  g.fillStyle(GHOST_PILL.fill, 1)
  g.fillCircle(0, 0, r)
  g.lineStyle(2, GHOST_PILL.border ?? 0xe8dfc9, 1)
  g.strokeCircle(0, 0, r)
  const icon = scene.add
    .text(0, 1, '♪', { fontFamily: FONT, fontSize: `${Math.round(size * 0.56)}px`, fontStyle: '900', color: '#8a8577' })
    .setOrigin(0.5)
  const zone = scene.add.rectangle(0, 0, size, size, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  zone.on('pointerdown', () => container.setScale(0.9))
  zone.on('pointerout', () => container.setScale(1))
  zone.on('pointerup', () => {
    container.setScale(1)
    sfx.uiTap()
    openSoundPanel(scene)
  })
  container.add([g, icon, zone])
  return container
}

/**
 * Move-sound picker overlay: a scrim + cream card titled "MOVE SOUND" with one
 * full-width pill per selectable swap sound. Tapping a row auditions it and
 * persists the choice, re-rendering so the gold highlight follows the selection.
 * A transparent blocker over the card stops panel taps from closing it, and a
 * DONE button (or a tap on the scrim) dismisses. Everything lives in one
 * container rebuilt on each pick and destroyed on close — mirrors openHelpPanel.
 */
export function openSoundPanel(scene: Phaser.Scene): void {
  const W = 720
  const H = 1280
  const layer = scene.add.container(0, 0).setDepth(60)

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => layer.destroy())

  const px = 40
  const pw = W - 80
  const ph = 640
  const pyTop = (H - ph) / 2
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.3)
  g.fillRoundedRect(px + 4, pyTop + 8, pw, ph, 30)
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'MOVE SOUND', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  const subtitle = scene.add
    .text(W / 2, pyTop + 104, 'Tap to hear — pick your favourite.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '22px',
      color: '#6a6459',
    })
    .setOrigin(0.5)
  layer.add([scrim, g, block, title, subtitle])

  let y = pyTop + 176
  const rowH = 96
  for (const s of SWAP_SOUNDS) {
    const selected = s === sfx.swapSound
    layer.add(
      addPillButton(scene, W / 2, y, pw - 80, 72, SWAP_SOUND_LABELS[s], selected ? GOLD_PILL : GHOST_PILL, () => {
        sfx.previewSwap(s) // audition
        sfx.setSwapSound(s) // persist
        // Rebuild so the gold highlight moves to the tapped row.
        layer.destroy()
        openSoundPanel(scene)
      })
    )
    y += rowH
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'DONE', GOLD_PILL, () => layer.destroy()))
}
