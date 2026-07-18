import Phaser from 'phaser'
import { sfx } from '../audio/sfx'

export const FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif'

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
