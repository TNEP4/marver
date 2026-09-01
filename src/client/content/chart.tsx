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

/** The house theme, from the slide tokens at render time (computed style so
 *  host overrides and dark scheme are both honored). */
function houseTheme(el: HTMLElement) {
  const css = getComputedStyle(el)
  const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb
  const ink = v('--sl-ink', '#18181b')
  const muted = v('--sl-muted', 'rgba(24,24,27,.55)')
  const accent = v('--sl-accent', '#0088ff')
  return {
    color: [accent, '#7c5cff', '#00b8a9', '#f0883e', '#d6608c', '#5b8def'],
    textStyle: { fontFamily: FONT_STACK, color: ink },
    axisPointer: { lineStyle: { color: muted } },
    categoryAxis: { axisLine: { lineStyle: { color: muted } }, axisLabel: { color: ink, fontSize: 18 }, splitLine: { show: false } },
    valueAxis: { axisLabel: { color: ink, fontSize: 18 }, splitLine: { lineStyle: { color: v('--sl-grid', 'rgba(127,127,127,.15)') } } },
    legend: { textStyle: { color: ink, fontSize: 18 } },
    tooltip: {
      backgroundColor: v('--sl-ground', '#fff'), borderColor: 'rgba(127,127,127,.25)',
      textStyle: { color: ink, fontFamily: FONT_STACK },
      extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);backdrop-filter:blur(8px)',
    },
  }
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
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let chart: import('./chart-engine.ts').EChartsInstance | null = null
    void loadEngine().then((engine) => {
      if (disposed || !ref.current) return
      // a theme OBJECT per init - never a stale global registration
      chart = engine.init(ref.current, houseTheme(ref.current), { renderer: 'svg' })
      chart.setOption(sanitizeOption(option, play))
    }).catch(() => setFailed(true))
    return () => { disposed = true; chart?.dispose() }
    // re-init on play flip (the entrance) and on theme flip (fresh tokens)
  }, [option, play, theme])
  if (failed) return <div className="mv-block mv-imgerr"><b>chart unavailable</b><span>echarts failed to load</span></div>
  return <div ref={ref} className="mv-block mv-chart" style={{ width: '100%', height: h }} />
}
