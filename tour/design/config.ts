// marver tour - the hosted onboarding canvas (tour.marver.design).
export default {
  // Live Jam: tag @marver in a comment and the local coding agent acts.
  jam: { agent: "claude" },
  mode: "studio",
  viewports: {
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    laptop: { width: 1280, height: 800 },
    monitor: { width: 1920, height: 1080 },
  },
  themes: ["light", "dark"],
  port: 5240,
  share: { name: "marver tour" },
}
