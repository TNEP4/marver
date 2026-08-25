/** Automatic attribution for the powered-by links: every canvas tags its marver.design
 *  link so site analytics can see WHICH canvas sent a visitor - zero user setup.
 *  Conventional UTM semantics (stable groupings first, the variable last):
 *    utm_source   = the surface class ('published-canvas' | 'dev-canvas')
 *    utm_medium   = the link unit ('powered-by')
 *    utm_campaign = THIS canvas's name, slugged ("Marver tour" -> "marver-tour")
 *    utm_content  = the placement ('gate' badge | 'shell' wordmark | 'sign-in' finish page |
 *                   'authorize-device' approval page)
 */
export function poweredByUrl(
  canvasName: string | undefined,
  source: 'published-canvas' | 'dev-canvas',
  content: 'gate' | 'shell' | 'sign-in' | 'authorize-device',
): string {
  const slug = (canvasName ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const q = new URLSearchParams({
    utm_source: source,
    utm_medium: 'powered-by',
    ...(slug ? { utm_campaign: slug } : {}),
    utm_content: content,
  })
  return `https://marver.design/?${q.toString()}`
}
