/** The lazily-loaded ECharts engine - STATIC named imports only, so the
 *  bundler tree-shakes to exactly the blessed set (whole-namespace imports
 *  drag the entire library into the chunk). chart.tsx dynamic-imports THIS
 *  file, which is what splits echarts into its own async chunk. */
import * as core from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DatasetComponent, GridComponent, LegendComponent, MarkLineComponent,
  TitleComponent, TooltipComponent,
} from 'echarts/components'

core.use([
  SVGRenderer,
  BarChart, LineChart, ScatterChart, PieChart,
  GridComponent, TooltipComponent, LegendComponent,
  DatasetComponent, TitleComponent, MarkLineComponent,
])

export const init = core.init
export type EChartsInstance = ReturnType<typeof core.init>
