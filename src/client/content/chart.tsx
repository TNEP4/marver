/**
 * Chart (v1.5) - Apache ECharts, the Diagram way: the author picks the FORM
 * (the ECharts option surface, pointed at from instructions/slides.md);
 * marver injects the house theme and strips author styling drift where it
 * breaks the deck (animation at rest, above all).
 *
 * SVG renderer ONLY - a canvas-rendered chart would pin its frame live on
 * the board (the lean-DOM serializer keeps <canvas> frames degraded). At
 * rest the chart renders its final state (animation force-disabled); in
 * slides mode (useSlidePlay) it plays its entrance once on mount.
 *
 * echarts is a real dependency loaded through a dynamic import, so it
 * splits into its own lazy chunk: canvases without charts ship zero echarts
 * bytes.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FONT_STACK } from './palette.ts'
import { useSlidePlay } from './slide.tsx'

type Engine = typeof import('./chart-engine.ts')

let enginePromise: Promise<Engine> | null = null
const loadEngine = (): Promise<Engine> => (enginePromise ??= import('./chart-engine.ts'))

/** Strip every way an option can keep moving at rest: top-level and
 *  per-series animation flags, and graphic keyframe animations. Pure and
 *  exported - the tests own it. */
export function sanitizeOption(option: Record<string, unknown>, animate: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...option, animation: animate }
  delete out.graphic                                    // free-floating animated graphics have no place on a slide
  const scrub = (s: unknown): unknown =>
    s && typeof s === 'object'
      ? {
          ...Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([k]) => !/^animation/.test(k))),
          animation: animate,
        }
      : s
  if (Array.isArray(out.series)) out.series = out.series.map(scrub)
  else if (out.series) out.series = scrub(out.series)
  return out
}

/** The chart's palette, pure so the tests own it. `inSlide` picks the slide type scale
 *  (18px labels on a 1280-wide stage) over the document/UI scale (12px). */
export function chartTheme(t: { ink: string; font: string; accent: string; ground: string; grid: string; dark: boolean; inSlide: boolean }) {
  const fs = t.inSlide ? 18 : 12
  const muted = t.dark ? 'rgba(242,242,247,.5)' : 'rgba(28,28,30,.5)'
  return {
    color: [t.accent, '#7c5cff', '#00b8a9', '#f0883e', '#d6608c', '#5b8def'],
    textStyle: { fontFamily: t.font, color: t.ink },
    axisPointer: { lineStyle: { color: muted } },
    categoryAxis: { axisLine: { lineStyle: { color: muted } }, axisLabel: { color: t.ink, fontSize: fs }, splitLine: { show: false } },
    valueAxis: { axisLabel: { color: t.ink, fontSize: fs }, splitLine: { lineStyle: { color: t.grid } } },
    legend: { textStyle: { color: t.ink, fontSize: fs } },
    title: { textStyle: { color: t.ink, fontFamily: t.font }, subtextStyle: { color: muted, fontFamily: t.font } },
    // series labels (pie/funnel/bar values): the frame's ink, no halo - echarts' default paints
    // #333 with a white 2px text border, which reads as outlined glyphs on a dark ground
    label: { color: t.ink, fontSize: fs, textBorderWidth: 0 },
    tooltip: {
      backgroundColor: t.ground, borderColor: 'rgba(127,127,127,.25)',
      textStyle: { color: t.ink, fontFamily: t.font, fontSize: fs === 18 ? 16 : 12 },
      extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);backdrop-filter:blur(8px)',
    },
  }
}

/** The house theme, read from the frame the chart sits in, at render time. Ink and font are
 *  the element's own COMPUTED color and font-family - so a chart inherits a UI screen's
 *  Tailwind text colour and typeface, a Doc's tokens, or a Slide's, with no per-context
 *  wiring. Accent and ground come from slide tokens, then Doc tokens, then the mode palette. */
function houseTheme(el: HTMLElement, dark: boolean) {
  const css = getComputedStyle(el)
  const v = (...names: string[]) => { for (const n of names) { const x = css.getPropertyValue(n).trim(); if (x) return x } return '' }
  return chartTheme({
    ink: css.color || (dark ? '#F2F2F7' : '#1C1C1E'),
    font: v('--sl-font') || css.fontFamily || FONT_STACK,
    accent: v('--sl-accent', '--mv-accent') || (dark ? '#0091FF' : '#0088FF'),
    ground: v('--sl-ground', '--mv-surface', '--mv-bg') || (dark ? '#1C1C1E' : '#FFFFFF'),
    grid: v('--sl-grid') || (dark ? 'rgba(242,242,247,.12)' : 'rgba(28,28,30,.1)'),
    dark,
    inSlide: !!el.closest('.sl-root'),
  })
}

/** The frame's visual theme (light/dark), observed the same way the play
 *  flag is - the stage flips documentElement class/data-theme on sh:set-theme
 *  and a themed chart must follow, not stay stale. */
const subscribeTheme = (cb: () => void) => {
  if (typeof document === 'undefined') return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  return () => mo.disconnect()
}
const readTheme = () => (typeof document !== 'undefined' && (document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark') ? 'dark' : 'light')
const useFrameTheme = (): string => useSyncExternalStore(subscribeTheme, readTheme, () => 'light')

export function Chart({ option, h = 420 }: { option: Record<string, unknown>; h?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const play = useSlidePlay()
  const theme = useFrameTheme()
  const [failed, setFailed] = useState(false)
  // The instance lives in a ref: init/dispose follows the THEME and the play flip (a theme
  // object per init, the entrance on play); the option rides a separate effect that calls
  // setOption on the live instance - so a parent re-render, or an HMR edit to a formatter
  // function, never disposes and re-inits the chart.
  const chartRef = useRef<import('./chart-engine.ts').EChartsInstance | null>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  const playRef = useRef(play)
  playRef.current = play
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let ro: ResizeObserver | null = null
    void loadEngine().then((engine) => {
      if (disposed || !ref.current) return
      const chart = engine.init(ref.current, houseTheme(ref.current, theme === 'dark'), { renderer: 'svg' })
      chartRef.current = chart
      chart.setOption(sanitizeOption(optionRef.current, playRef.current))
      // a slide is a fixed stage, but a UI screen or a Doc reflows (device pills, responsive
      // layouts): follow the box, or the SVG keeps its mount-time size
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => { if (!disposed) chart.resize() })
        ro.observe(ref.current)
      }
    }).catch(() => setFailed(true))
    return () => { disposed = true; ro?.disconnect(); chartRef.current?.dispose(); chartRef.current = null }
  }, [play, theme])
  // option changes (content OR a function inside it) reach the live instance; notMerge so a
  // removed series disappears rather than lingering from the previous option
  useEffect(() => { chartRef.current?.setOption(sanitizeOption(option, play), true) }, [option, play])
  if (failed) return <div className="mv-block mv-imgerr"><b>chart unavailable</b><span>echarts failed to load</span></div>
  // contain: inline-size - echarts sizes its inner box in px, which would otherwise pin the
  // author's flex/grid column at that width (min-content) and defeat the ResizeObserver above
  return <div ref={ref} className="mv-block mv-chart" style={{ width: '100%', height: h, minWidth: 0, contain: 'inline-size' }} />
}
