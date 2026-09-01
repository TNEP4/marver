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
import { useEffect, useRef, useState } from 'react'
import { FONT_STACK } from './palette.ts'
import { useSlidePlay } from './slide.tsx'

type EChartsCore = typeof import('echarts/core')

let corePromise: Promise<EChartsCore> | null = null
async function loadECharts(): Promise<EChartsCore> {
  corePromise ??= (async () => {
    const [core, { SVGRenderer }, charts, components] = await Promise.all([
      import('echarts/core'),
      import('echarts/renderers'),
      import('echarts/charts'),
      import('echarts/components'),
    ])
    core.use([
      SVGRenderer,
      charts.BarChart, charts.LineChart, charts.ScatterChart, charts.PieChart,
      components.GridComponent, components.TooltipComponent, components.LegendComponent,
      components.DatasetComponent, components.TitleComponent, components.MarkLineComponent,
    ])
    return core
  })()
  return corePromise
}

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

export function Chart({ option, h = 420 }: { option: Record<string, unknown>; h?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const play = useSlidePlay()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let chart: ReturnType<EChartsCore['init']> | null = null
    void loadECharts().then((core) => {
      if (disposed || !ref.current) return
      core.registerTheme('marver', houseTheme(ref.current))
      chart = core.init(ref.current, 'marver', { renderer: 'svg' })
      chart.setOption(sanitizeOption(option, play))
    }).catch(() => setFailed(true))
    return () => { disposed = true; chart?.dispose() }
    // re-init on play flip: the entrance is the point of the flip
  }, [option, play])
  if (failed) return <div className="mv-block mv-imgerr"><b>chart unavailable</b><span>echarts failed to load</span></div>
  return <div ref={ref} className="mv-block mv-chart" style={{ width: '100%', height: h }} />
}
