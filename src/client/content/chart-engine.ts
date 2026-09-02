/** The lazily-loaded ECharts engine - STATIC named imports only, so the
 *  bundler tree-shakes to exactly the blessed set (whole-namespace imports
 *  drag the entire library into the chunk). chart.tsx dynamic-imports THIS
 *  file, which is what splits echarts into its own async chunk. */
import * as core from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import {
  BarChart, LineChart, PieChart, ScatterChart, RadarChart, GaugeChart, HeatmapChart,
  FunnelChart, TreemapChart, SunburstChart, SankeyChart, BoxplotChart,
} from 'echarts/charts'
import {
  DatasetComponent, GridComponent, LegendComponent, MarkLineComponent, MarkPointComponent,
  MarkAreaComponent, TitleComponent, TooltipComponent, PolarComponent, RadarComponent,
  VisualMapComponent, DataZoomComponent, TransformComponent,
} from 'echarts/components'

/** THE SUPPORTED SURFACE - docs/slides.md and the doctrine list exactly this.
 *  Series: bar, line, pie, scatter, radar, gauge, heatmap, funnel, treemap,
 *  sunburst, sankey, boxplot. Components: grid, polar, radar, tooltip, legend,
 *  title, dataset (+ transform), markLine, markPoint, markArea, visualMap,
 *  dataZoom. Anything else in an option is silently dropped by ECharts - add
 *  it HERE and to the docs together, never one without the other. */
core.use([
  SVGRenderer,
  BarChart, LineChart, ScatterChart, PieChart, RadarChart, GaugeChart, HeatmapChart,
  FunnelChart, TreemapChart, SunburstChart, SankeyChart, BoxplotChart,
  GridComponent, PolarComponent, RadarComponent, TooltipComponent, LegendComponent,
  TitleComponent, DatasetComponent, TransformComponent, MarkLineComponent,
  MarkPointComponent, MarkAreaComponent, VisualMapComponent, DataZoomComponent,
])

export const init = core.init
export type EChartsInstance = ReturnType<typeof core.init>
