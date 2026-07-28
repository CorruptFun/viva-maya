/**
 * Coordinate bridge between the Phaser world and the 3D stage (§3D-1) — pure math,
 * no three.js, no DOM, so the whole contract is unit-testable in Node.
 *
 * The 3D room renders on a FULL-VIEWPORT canvas behind the (transparent) Phaser
 * canvas, so its perspective camera must be solved such that the Z=0 plane of the
 * 3D scene lands EXACTLY on Phaser's world coordinate system: a glow placed at
 * world (360, 620, z:0) must sit pixel-under the board centre that Phaser draws at
 * (360, 620). Everything in stage.ts is then positioned in familiar Phaser world
 * units and depth becomes one extra number (Z ≤ 0, "into the room").
 *
 * Geometry recap (see config.ts):
 *   - Phaser world: x ∈ [0, DESIGN_W]; the canvas shows world Y from `scrollY`
 *     (= restScrollY() = −contentOffsetY()) down to scrollY + worldH.
 *   - FIT scaling: the canvas element is CSS-fitted into #app, so CSS px per world
 *     unit = canvasCssWidth / DESIGN_W, uniform in both axes.
 *   - The viewport may EXCEED the canvas (tablet/desktop letterbox): the 3D room
 *     keeps painting there, turning dead margin into live environment. The maths
 *     just extends the same linear map beyond the canvas edges.
 *
 * Solved camera: axis-aligned (no rotation — which also makes every quad a free
 * billboard), positioned at the viewport centre expressed in world units, at the
 * unique distance where the frustum's Z=0 cross-section height equals the viewport
 * height in world units. Under that camera, screen-space alignment with Phaser is
 * exact (verified by the projection-identity test).
 */

/** Everything stage.ts needs to aim its camera + size its backdrop. */
export interface StageView {
  /** Camera centre in Phaser world coords (y is Phaser-down; stage negates it). */
  camX: number
  camY: number
  /** Camera Z distance from the Z=0 game plane (world units, always > 0). */
  dist: number
  /** Vertical field of view, degrees (echoed for consumers/tests). */
  fovDeg: number
  /** Viewport aspect (w/h) for the camera. */
  aspect: number
  /** Viewport size in world units. */
  worldW: number
  worldH: number
  /** World-space edges of the visible viewport at Z=0 (letterbox included). */
  worldLeft: number
  worldRight: number
  worldTop: number
  worldBottom: number
}

export interface StageViewInput {
  /** CSS viewport size (window.innerWidth/Height). */
  viewportW: number
  viewportH: number
  /** The Phaser canvas element's CSS rect (getBoundingClientRect). */
  canvasLeft: number
  canvasTop: number
  canvasWidth: number
  /** Phaser design width (config.DESIGN_W = 720). */
  designW: number
  /** The rest camera scroll (config.restScrollY() = −contentOffsetY()). */
  scrollY: number
  /** Vertical FOV in degrees. Default 55 — deep enough to feel the parallax. */
  fovDeg?: number
}

/** Default vertical FOV. Wider = more depth drama per unit of parallax. */
export const STAGE_FOV_DEG = 55

/**
 * Solve the stage camera for the current layout. Degenerate inputs (zero/negative
 * sizes during construction races) fall back to a sane design-box view so the
 * renderer never divides by zero — the next real resize corrects it.
 */
export function computeStageView(input: StageViewInput): StageView {
  const fovDeg = input.fovDeg ?? STAGE_FOV_DEG
  const ok =
    input.viewportW > 0 && input.viewportH > 0 && input.canvasWidth > 0 && input.designW > 0

  // CSS px per world unit (FIT is uniform in x/y). Fallback: viewport == design box.
  const scale = ok ? input.canvasWidth / input.designW : 1
  const vw = ok ? input.viewportW : input.designW
  const vh = ok ? input.viewportH : Math.round(input.designW * (16 / 9))
  const left = ok ? input.canvasLeft : 0
  const top = ok ? input.canvasTop : 0
  const scrollY = ok ? input.scrollY : 0

  // The linear viewport→world map, extended beyond the canvas into any letterbox.
  const worldLeft = (0 - left) / scale
  const worldRight = (vw - left) / scale
  const worldTop = scrollY + (0 - top) / scale
  const worldBottom = scrollY + (vh - top) / scale

  const worldW = worldRight - worldLeft
  const worldH = worldBottom - worldTop

  // Distance where the frustum height at Z=0 equals the viewport height in world
  // units: tan(fov/2) = (worldH/2) / dist.
  const dist = worldH / 2 / Math.tan((fovDeg * Math.PI) / 360)

  return {
    camX: (worldLeft + worldRight) / 2,
    camY: (worldTop + worldBottom) / 2,
    dist,
    fovDeg,
    aspect: vw / vh,
    worldW,
    worldH,
    worldLeft,
    worldRight,
    worldTop,
    worldBottom,
  }
}

/**
 * Frustum height (world units) of the view's cross-section at depth `z` (≤ 0 is
 * deeper into the room). Used to size the sky plane so it covers the whole view at
 * its depth, with margin for parallax.
 */
export function frustumHeightAt(view: StageView, z: number): number {
  return 2 * (view.dist - z) * Math.tan((view.fovDeg * Math.PI) / 360)
}

/** Frustum width at depth `z` — height at that depth times the camera aspect. */
export function frustumWidthAt(view: StageView, z: number): number {
  return frustumHeightAt(view, z) * view.aspect
}

/**
 * Where a world point at depth `z` lands in normalised device coords (−1..1, +y
 * up) under the solved camera, with an optional camera parallax offset (world
 * units, Phaser-down y). Exists chiefly so tests can prove the Z=0 alignment
 * contract and characterise parallax drift; stage.ts lets the GPU project.
 */
export function projectToNdc(
  view: StageView,
  worldX: number,
  worldY: number,
  z: number,
  camOffsetX = 0,
  camOffsetY = 0
): { x: number; y: number } {
  const depth = view.dist - z // camera is at +dist; z ≤ 0 recedes
  const halfH = depth * Math.tan((view.fovDeg * Math.PI) / 360)
  const halfW = halfH * view.aspect
  // Stage space negates world Y (Phaser +y down, GL +y up); camera offset follows.
  const dx = worldX - (view.camX + camOffsetX)
  const dy = -(worldY - (view.camY + camOffsetY))
  return { x: dx / halfW, y: dy / halfH }
}
