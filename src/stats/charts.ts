/**
 * Chart primitives for the owner dashboard — hand-rolled SVG, zero dependencies, matching how the
 * rest of this repo builds things (procedural icons, WebAudio SFX: no library where 200 lines will
 * do). Two forms cover every panel: a multi-series line chart (time) and a column chart
 * (categories), plus a shared tooltip and plain-table builders for the accessibility twins.
 *
 * ⚠️ Every data string that reaches the DOM here (labels, tooltip text) is set via textContent —
 * never innerHTML. Event names, faces, surfaces and app_version values are written by UNTRUSTED
 * game clients (0010's trust model); a dashboard that innerHTML'd them would hand any player a
 * stored-XSS run at the owner's Supabase session, which is exactly the audience this page holds.
 *
 * Marks follow the dataviz specs: 2px lines, ≥8px end markers ringed in surface, bars ≤24px with a
 * 4px rounded data-end and square baseline, hairline solid gridlines, and a hover/focus layer whose
 * hit targets are far bigger than the marks (the whole column, the whole plot width).
 */

import { linePath, niceTicks, roundedTopRect } from './model'

const SVG_NS = 'http://www.w3.org/2000/svg'

// ---------------------------------------------------------------------------- tiny DOM helpers

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/**
 * Charts render at their container's real pixel width (crisp text, 1:1 pointer math — no viewBox
 * scaling) and rebuild when that width changes. ResizeObserver fires once on observe, which is the
 * initial render.
 */
function responsive(build: (width: number) => SVGSVGElement): HTMLElement {
  const host = el('div', 'chart-host')
  let lastW = 0
  const ro = new ResizeObserver(() => {
    const w = Math.floor(host.clientWidth)
    if (w < 40 || Math.abs(w - lastW) < 4) return
    lastW = w
    host.replaceChildren(build(Math.max(280, w)))
  })
  ro.observe(host)
  return host
}

// ---------------------------------------------------------------------------- tooltip (shared singleton)

export interface TipRow {
  label: string
  value: string
  /** CSS custom-property name (e.g. '--s1') for the series line-key; omit for plain rows. */
  colorVar?: string
}

let tipEl: HTMLDivElement | null = null

function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = el('div', 'tip')
    tipEl.setAttribute('role', 'status')
    tipEl.style.display = 'none'
    document.body.appendChild(tipEl)
  }
  return tipEl
}

/** Show the tooltip near client coords. Values lead (strong), labels follow — the legend's
 *  hierarchy inverted, because here the reader has the series and wants the number. */
export function tipShow(title: string, rows: TipRow[], cx: number, cy: number): void {
  const t = tip()
  t.replaceChildren()
  if (title) t.appendChild(el('div', 'tip-title', title))
  for (const r of rows) {
    const row = el('div', 'tip-row')
    if (r.colorVar) {
      const key = el('span', 'tip-key')
      key.style.background = `var(${r.colorVar})`
      row.appendChild(key)
    }
    row.appendChild(el('span', 'tip-val', r.value))
    row.appendChild(el('span', 'tip-label', r.label))
    t.appendChild(row)
  }
  t.style.display = 'block'
  // Position after fill so the clamp measures the real size.
  const pad = 12
  const rect = t.getBoundingClientRect()
  const x = Math.min(cx + pad, window.innerWidth - rect.width - 4)
  const y = Math.min(cy + pad, window.innerHeight - rect.height - 4)
  t.style.left = `${Math.max(4, x)}px`
  t.style.top = `${Math.max(4, y)}px`
}

export function tipHide(): void {
  if (tipEl) tipEl.style.display = 'none'
}

// ---------------------------------------------------------------------------- legend

export interface LegendItem {
  label: string
  colorVar: string
  /** Mirror the mark: 'line' for line series, 'rect' for bars/areas. */
  kind: 'line' | 'rect'
}

export function legend(items: LegendItem[]): HTMLElement {
  const box = el('div', 'legend')
  for (const it of items) {
    const item = el('span', 'legend-item')
    const swatch = el('span', it.kind === 'line' ? 'legend-line' : 'legend-rect')
    swatch.style.background = `var(${it.colorVar})`
    item.appendChild(swatch)
    item.appendChild(el('span', 'legend-label', it.label))
    box.appendChild(item)
  }
  return box
}

// ---------------------------------------------------------------------------- line chart

export interface LineSeries {
  label: string
  colorVar: string
  values: number[]
}

export interface LineChartOpts {
  /** Equal-length series, zero-filled by the caller (model.fillDaily). */
  series: LineSeries[]
  /** One label per x index (tooltip title + sparse axis ticks). */
  xLabels: string[]
  /** Draw an x tick every n indices (first and last always drawn). */
  xTickEvery?: number
  height?: number
  yFmt?: (v: number) => string
}

const M = { top: 10, right: 12, bottom: 22, left: 38 }

export function lineChart(opts: LineChartOpts): HTMLElement {
  const { series, xLabels } = opts
  const height = opts.height ?? 220
  const yFmt = opts.yFmt ?? ((v: number) => v.toLocaleString('en-US'))
  const n = xLabels.length

  return responsive(width => {
    const svg = svgNode('svg', { width, height, viewBox: `0 0 ${width} ${height}` })
    svg.classList.add('chart')
    const plotW = width - M.left - M.right
    const plotH = height - M.top - M.bottom
    const maxV = Math.max(1, ...series.flatMap(s => s.values))
    const ticks = niceTicks(maxV)
    const yMax = ticks[ticks.length - 1]
    const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const y = (v: number) => M.top + plotH - (v / yMax) * plotH

    // Gridlines + y labels (hairline, recessive; the axis carries the values direct labels don't).
    for (const t of ticks) {
      const gy = y(t)
      svg.appendChild(
        svgNode('line', { x1: M.left, x2: M.left + plotW, y1: gy, y2: gy, class: t === 0 ? 'axis' : 'gridline' })
      )
      const lbl = svgNode('text', { x: M.left - 6, y: gy + 3, class: 'tick tick-y' })
      lbl.textContent = yFmt(t)
      svg.appendChild(lbl)
    }
    // Sparse x labels: first, last, and every k between — but an intermediate tick that lands
    // within k of the last one is dropped, or the two collide at the right edge.
    const k = opts.xTickEvery ?? Math.max(1, Math.ceil(n / 6))
    for (let i = 0; i < n; i++) {
      if (i !== 0 && i !== n - 1 && (i % k !== 0 || n - 1 - i < k)) continue
      const lbl = svgNode('text', {
        x: x(i),
        y: M.top + plotH + 14,
        class: 'tick',
        'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      })
      lbl.textContent = xLabels[i]
      svg.appendChild(lbl)
    }

    // Lines + ringed end markers (2px line, ≥8px marker, 2px surface ring).
    for (const s of series) {
      const path = svgNode('path', { d: linePath(s.values, x, y), class: 'line' })
      path.style.stroke = `var(${s.colorVar})`
      svg.appendChild(path)
      const last = s.values.length - 1
      if (last >= 0) {
        const dot = svgNode('circle', { cx: x(last), cy: y(s.values[last]), r: 4, class: 'dot' })
        dot.style.fill = `var(${s.colorVar})`
        svg.appendChild(dot)
      }
    }

    // Hover/focus layer: the whole plot is the hit target; a crosshair snaps to the nearest index
    // and one tooltip reads EVERY series at that x.
    const hair = svgNode('line', { y1: M.top, y2: M.top + plotH, class: 'crosshair' })
    hair.style.display = 'none'
    svg.appendChild(hair)
    const marks = series.map(s => {
      const c = svgNode('circle', { r: 4.5, class: 'dot' })
      c.style.fill = `var(${s.colorVar})`
      c.style.display = 'none'
      svg.appendChild(c)
      return c
    })
    const overlay = svgNode('rect', {
      x: M.left,
      y: M.top,
      width: Math.max(1, plotW),
      height: plotH,
      class: 'overlay',
      tabindex: 0,
      role: 'img',
    })
    const show = (i: number, cx: number, cy: number) => {
      const px = x(i)
      hair.setAttribute('x1', String(px))
      hair.setAttribute('x2', String(px))
      hair.style.display = ''
      series.forEach((s, si) => {
        marks[si].setAttribute('cx', String(px))
        marks[si].setAttribute('cy', String(y(s.values[i])))
        marks[si].style.display = ''
      })
      tipShow(
        xLabels[i],
        series.map(s => ({ label: s.label, value: yFmt(s.values[i]), colorVar: s.colorVar })),
        cx,
        cy
      )
    }
    const hide = () => {
      hair.style.display = 'none'
      for (const m of marks) m.style.display = 'none'
      tipHide()
    }
    const idxFromClientX = (clientX: number) => {
      const left = svg.getBoundingClientRect().left + M.left
      const f = plotW <= 0 ? 0 : (clientX - left) / plotW
      return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))))
    }
    let focusIdx = n - 1
    overlay.addEventListener('pointermove', e => show(idxFromClientX(e.clientX), e.clientX, e.clientY))
    overlay.addEventListener('pointerleave', hide)
    overlay.addEventListener('focus', () => {
      const r = svg.getBoundingClientRect()
      show(focusIdx, r.left + x(focusIdx), r.top + M.top + plotH / 2)
    })
    overlay.addEventListener('blur', hide)
    overlay.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      focusIdx = Math.max(0, Math.min(n - 1, focusIdx + (e.key === 'ArrowLeft' ? -1 : 1)))
      const r = svg.getBoundingClientRect()
      show(focusIdx, r.left + x(focusIdx), r.top + M.top + plotH / 2)
    })
    svg.appendChild(overlay)
    return svg
  })
}

// ---------------------------------------------------------------------------- column chart

export interface ColumnDatum {
  label: string
  value: number
  /** Per-bar override (e.g. '--critical' for a flagged wall level); defaults to the chart color. */
  colorVar?: string
  /** Extra tooltip rows beyond the value. */
  tipRows?: TipRow[]
}

export interface ColumnChartOpts {
  data: ColumnDatum[]
  colorVar: string
  height?: number
  /** Fix the y scale (e.g. 100 for percentages); otherwise ticks derive from the data max. */
  yMax?: number
  yFmt?: (v: number) => string
  xTickEvery?: number
  /** Direct-label the maximum bar (selective labeling — never every bar). */
  labelMax?: boolean
}

export function columnChart(opts: ColumnChartOpts): HTMLElement {
  const { data } = opts
  const height = opts.height ?? 180
  const yFmt = opts.yFmt ?? ((v: number) => v.toLocaleString('en-US'))
  const n = data.length
  // Extra headroom vs the line chart: a max-height bar's direct label sits ABOVE the bar cap, and
  // the default top margin would clip it at the svg edge.
  const CM = { ...M, top: opts.labelMax ? 20 : M.top }

  return responsive(width => {
    const svg = svgNode('svg', { width, height, viewBox: `0 0 ${width} ${height}` })
    svg.classList.add('chart')
    const plotW = width - CM.left - CM.right
    const plotH = height - CM.top - CM.bottom
    const ticks = opts.yMax !== undefined ? niceTicks(opts.yMax) : niceTicks(Math.max(1, ...data.map(d => d.value)))
    const yMax = ticks[ticks.length - 1]
    const step = n > 0 ? plotW / n : plotW
    const barW = Math.min(24, Math.max(2, step - 2)) // ≤24px thick, 2px surface gap between neighbours
    const xMid = (i: number) => CM.left + step * i + step / 2
    const y = (v: number) => CM.top + plotH - (v / yMax) * plotH

    for (const t of ticks) {
      const gy = y(t)
      svg.appendChild(
        svgNode('line', { x1: CM.left, x2: CM.left + plotW, y1: gy, y2: gy, class: t === 0 ? 'axis' : 'gridline' })
      )
      const lbl = svgNode('text', { x: CM.left - 6, y: gy + 3, class: 'tick tick-y' })
      lbl.textContent = yFmt(t)
      svg.appendChild(lbl)
    }
    const k = opts.xTickEvery ?? Math.max(1, Math.ceil(n / 8))
    data.forEach((d, i) => {
      if (i !== 0 && i !== n - 1 && (i % k !== 0 || n - 1 - i < k)) return
      const lbl = svgNode('text', { x: xMid(i), y: CM.top + plotH + 14, class: 'tick', 'text-anchor': 'middle' })
      lbl.textContent = d.label
      svg.appendChild(lbl)
    })

    const maxIdx = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0)
    data.forEach((d, i) => {
      if (d.value <= 0) return
      const h = Math.max(1, (d.value / yMax) * plotH)
      const bar = svgNode('path', {
        d: roundedTopRect(xMid(i) - barW / 2, y(d.value), barW, h, 4),
        class: 'bar',
      })
      bar.style.fill = `var(${d.colorVar ?? opts.colorVar})`
      svg.appendChild(bar)
    })
    if (opts.labelMax && n > 0 && data[maxIdx].value > 0) {
      const lbl = svgNode('text', {
        x: xMid(maxIdx),
        y: y(data[maxIdx].value) - 5,
        class: 'mark-label',
        'text-anchor': 'middle',
      })
      lbl.textContent = yFmt(data[maxIdx].value)
      svg.appendChild(lbl)
    }

    // Hover/focus: the full column slot (not the painted bar) is the hit target.
    data.forEach((d, i) => {
      const hit = svgNode('rect', {
        x: CM.left + step * i,
        y: CM.top,
        width: Math.max(1, step),
        height: plotH,
        class: 'hit',
        tabindex: 0,
      })
      const rows: TipRow[] = [{ label: '', value: yFmt(d.value), colorVar: d.colorVar ?? opts.colorVar }, ...(d.tipRows ?? [])]
      const show = (cx: number, cy: number) => {
        hit.classList.add('hit-on')
        tipShow(d.label, rows, cx, cy)
      }
      const hide = () => {
        hit.classList.remove('hit-on')
        tipHide()
      }
      hit.addEventListener('pointermove', e => show(e.clientX, e.clientY))
      hit.addEventListener('pointerleave', hide)
      hit.addEventListener('focus', () => {
        const r = hit.getBoundingClientRect()
        show(r.left + r.width / 2, r.top + r.height / 2)
      })
      hit.addEventListener('blur', hide)
      svg.appendChild(hit)
    })
    return svg
  })
}

// ---------------------------------------------------------------------------- table (the a11y twin)

/** Right-aligned tabular-nums for numbers, '—' for null; all content via textContent. */
export function dataTable(headers: string[], rows: (string | number | null)[][]): HTMLTableElement {
  const table = el('table', 'data-table')
  const thead = el('thead')
  const hr = el('tr')
  for (const h of headers) hr.appendChild(el('th', undefined, h))
  thead.appendChild(hr)
  table.appendChild(thead)
  const tbody = el('tbody')
  for (const row of rows) {
    const tr = el('tr')
    for (const cell of row) {
      const td = el('td', typeof cell === 'number' ? 'num' : undefined)
      td.textContent = cell === null ? '—' : typeof cell === 'number' ? cell.toLocaleString('en-US') : cell
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}
