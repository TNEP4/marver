/**
 * The marver diagram identity (SPEC-026): the full Apple system palette (HIG),
 * every value the HIG's own light/dark pair - never inverted. Structure comes
 * from the systemGray ramp, emphasis from blue+purple, series diversity from
 * the 12-color set.
 */
export const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

/** systemGray 1..6 (index 0 = gray1). */
const GRAY_LIGHT = ['#8E8E93', '#AEAEB2', '#C7C7CC', '#D1D1D6', '#E5E5EA', '#F2F2F7']
const GRAY_DARK = ['#8E8E93', '#636366', '#48484A', '#3A3A3C', '#2C2C2E', '#1C1C1E']

/** red orange yellow green mint teal cyan blue indigo purple pink brown. */
const SERIES_LIGHT = ['#FF383C', '#FF8D28', '#FFCC00', '#34C759', '#00C8B3', '#00C3D0', '#00C0E8', '#0088FF', '#6155F5', '#CB30E0', '#FF2D55', '#AC7F5E']
const SERIES_DARK = ['#FF4245', '#FF9230', '#FFD600', '#30D158', '#00DAC3', '#00D2E0', '#3CD3FE', '#0091FF', '#6D7CFF', '#DB34F2', '#FF375F', '#B78A66']

export const ACCENT = { blue: { light: '#0088FF', dark: '#0091FF' }, purple: { light: '#CB30E0', dark: '#DB34F2' } }

/** Rides INSIDE the SVG via mermaid's themeCSS option - labels must be MEASURED
 *  with this treatment (host CSS landing after render would change text metrics
 *  without mermaid re-laying-out the boxes). Same voice as the Md typography:
 *  medium-weight labels, SF-style tightening, breathing room on wrapped lines. */
export const THEME_CSS = `
  .nodeLabel, .cluster-label, .label, text { letter-spacing: -0.01em; }
  .nodeLabel, .cluster-label { font-weight: 600; line-height: 1.4; }
  .nodeLabel p, .edgeLabel p, .label p { margin: 0; }
  .edgeLabel, .edgeLabel .label { font-weight: 500; }
`

/** Mermaid themeVariables for one mode. Base theme + these = the marver look. */
export function themeVars(dark: boolean): Record<string, string> {
  const g = dark ? GRAY_DARK : GRAY_LIGHT
  const s = dark ? SERIES_DARK : SERIES_LIGHT
  const text = dark ? '#F2F2F7' : '#1C1C1E'
  const surface = dark ? '#1C1C1E' : '#FFFFFF'
  const blue = dark ? ACCENT.blue.dark : ACCENT.blue.light
  const purple = dark ? ACCENT.purple.dark : ACCENT.purple.light
  // Nodes are ACCENTED by default - a plain flowchart only ever touches
  // primaryColor, so a gray primary meant every default diagram rendered
  // gray-on-gray (Nic's dogfood catch, 2026-08-13). Structure (lines, clusters,
  // labels) stays grayscale; the shapes carry the marver blue.
  const blueWash = dark ? '#123A5C' : '#E4F0FF'
  const purpleWash = dark ? '#3A1440' : '#F8E4FC'
  const tealWash = dark ? '#0C3B40' : '#DFF7F9'
  const vars: Record<string, string> = {
    fontFamily: FONT_STACK,
    fontSize: '15px',
    background: surface,
    mainBkg: blueWash,                // the default node: blue-washed, blue-edged
    primaryColor: blueWash,
    primaryTextColor: text,
    primaryBorderColor: blue,
    nodeBorder: blue,
    lineColor: g[0],                  // gray1 - edges read as drawing strokes
    textColor: text,
    secondaryColor: purpleWash,
    secondaryTextColor: text,
    secondaryBorderColor: purple,
    tertiaryColor: tealWash,
    tertiaryTextColor: text,
    tertiaryBorderColor: dark ? '#00D2E0' : '#00C3D0',
    clusterBkg: dark ? '#232326' : '#FAFAFC',
    clusterBorder: g[3],
    edgeLabelBackground: surface,
    titleColor: text,
    actorBkg: blueWash,
    actorBorder: blue,
    actorTextColor: text,
    signalColor: g[0],
    signalTextColor: text,
    labelBoxBkgColor: g[4],
    labelTextColor: text,
    noteBkgColor: dark ? '#2C2A20' : '#FFF9E0',
    noteTextColor: text,
    noteBorderColor: g[2],
    activationBkgColor: dark ? '#123A5C' : '#E0F0FF',
    activationBorderColor: blue,
    errorBkgColor: dark ? '#4A1D1E' : '#FFE5E5',
    errorTextColor: text,
  }
  // categorical series: pie slices, git branches, generic color scales
  s.forEach((c, i) => {
    vars[`pie${i + 1}`] = c
    vars[`cScale${i}`] = c
    if (i < 8) vars[`git${i}`] = c
  })
  vars.pieTitleTextColor = text
  vars.pieSectionTextColor = dark ? '#1C1C1E' : '#FFFFFF'
  vars.pieLegendTextColor = text
  vars.pieStrokeColor = surface
  vars.pieOuterStrokeColor = g[2]
  return vars
}
