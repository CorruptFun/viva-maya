import Phaser from 'phaser'

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

export interface PillStyle {
  fill: number
  border?: number
  textColor: string
}

export const GOLD_PILL: PillStyle = { fill: 0xf2b234, border: 0xc9930a, textColor: '#4a3305' }
export const GHOST_PILL: PillStyle = { fill: 0xffffff, border: 0xe8dfc9, textColor: '#8a8577' }

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
    onTap()
  })
  container.add([g, text, zone])
  return container
}
