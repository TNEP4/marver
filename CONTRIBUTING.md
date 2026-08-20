# Contributing

Thanks for your interest in Marver.

## Setup

The repo is pnpm-managed (Node >= 22.18):

```bash
pnpm install
pnpm build        # tsdown -> dist/
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm smoke        # packs a tarball and exercises init/dev/build from a clean install
```

To try your build against a real project: `node <repo>/dist/cli.mjs dev` from any repo with a `design/` folder (or `init` first).

## Ground rules

- Keep it lean. Marver ships no AI and no hosted control plane - a `design/` folder, one command, one deploy; everything (dev server, publish, comments, accounts) runs from the package itself. Features that add external services or heavyweight dependencies need a strong case.
- Frames stay plain TSX/HTML - nothing that forces user frames to import from this package.
- Every behavior change lands with a test (`test/`) and a CHANGELOG entry under the unreleased version.
- Bug reports with a minimal `design/` folder that reproduces the issue get fixed fastest.

## Releases

Maintainer-driven: `npm version <patch|minor>` + a pushed tag triggers the trusted-publishing workflow.

By contributing you agree that your contributions are licensed under the Apache-2.0 license.
