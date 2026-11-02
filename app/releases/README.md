# Release records

One file per release of the Mac app, `X.Y.Z.json`, written by `scripts/release.mjs` (spec 28 A5.1 #11, step 14) into
the checkout that ran it, and committed by hand (`release: app X.Y.Z`). Every run that reaches the publish writes it,
whatever the last check found, and writes it again when a resumed check settles. The release's working state is
`app/.release/X.Y.Z/` (never committed); this file is what stays.

```jsonc
{
  "v": 1,
  "version": "1.0.0",
  "status": "published",            // published | superseded | check-failed | withdrawn
  "kind": "production",             // or "candidate": a 0.9x on TNEP4/marver-app-test, which accepts the mechanism, never a release
  "repo": "TNEP4/marver-app",
  "tag": "v1.0.0",
  "reason": "...",                  // withdrawn only: why
  "source": { "sha": "<marver commit>", "branch": "main" },
  "companion": "0.29.0",            // the highest "marver X.Y.Z" the CHANGELOG section names, published on npm
  "tagTarget": "<releases repo commit>",
  "release": { "id": 123, "url": "https://github.com/TNEP4/marver-app/releases/..." },
  "assets": [                       // the three, nothing else
    { "name": "Marver-darwin-arm64-1.0.0.zip", "bytes": 0, "sha256": "..." },
    { "name": "Marver-arm64.dmg", "bytes": 0, "sha256": "..." },
    { "name": "releases.json", "bytes": 0, "sha256": "..." }
  ],
  "acceptance": { "by": "...", "at": "<ISO>", "evidence": { /* --accept's file: version, dmg, zip, mac, macos, checks, google, notes */ } },
  "notary": { "app": ["<submission id>"], "dmg": ["<submission id>"] },
  "dr": "<app/build/designated-requirement.txt>",
  "immutable": true,
  "smokeReport": "smoke-<time>.json",
  "steps": { "preflight": "<ISO>", "...": "<ISO>" },
  "check": { "status": "...", "problems": [], "latest": { "owner": "1.0.0", "agreeing": 18, "reads": 25 }, "immutable": true }
}
```

- **published**: the three versioned downloads give the recorded bytes, the release reads `immutable: true`, its tag is
  on `tagTarget`, and `latest/download/` serves its feed (18 anonymous reads in a row) and its DMG.
- **superseded**: its own artifacts check, and a newer release owns `latest`; the redirect is never claimed.
- **check-failed**: not final; `release.mjs X.Y.Z --resume` checks again, from any checkout, whatever `HEAD` is.
- **withdrawn**: marked a prerelease (`--withdraw`, or at once when it read mutable after its publish); its version stays
  in the floor, and the fix is a newer version (#12).

A record written after the state folder was lost (`--withdraw` from GitHub's identity alone) has `"unavailable"`, the
list of what it cannot say - the acceptance, the recorded hashes, the notary ids - and its assets carry GitHub's
`githubDigest` in place of recorded hashes. Nothing is made up.
