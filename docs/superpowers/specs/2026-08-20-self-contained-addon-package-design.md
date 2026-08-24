# Self-Contained Home Assistant Add-on Package Design

## Status

Approved by the user's standing instruction to use the recommended option. This design repairs the Phase 1 installation path only. It does not open Phase 2 or add Home Assistant entities or SmartThings control.

## Problem

The current installation guide says to copy `addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge`. Home Assistant Supervisor builds a local add-on with that directory as the Docker build context. The current add-on Dockerfile tries to copy root-level `package.json`, `package-lock.json`, TypeScript configuration, and `bridge`, which do not exist inside that context. A real Supervisor build would therefore fail before starting Chromium.

## Selected approach

Generate a self-contained, ignored distribution directory from the monorepo:

```text
dist-addon/smartthings_web_bridge/
├── config.yaml
├── Dockerfile
├── apparmor.txt
├── DOCS.md
├── README.md
├── CHANGELOG.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
├── bridge/src/**
├── rootfs/**
└── addon-package-manifest.json
```

The monorepo remains the only committed source of truth. `dist-addon/` is regenerated, ignored by Git, and is the only directory users copy into `/addons/smartthings_web_bridge`.

## Alternatives rejected

1. Commit a second copy of `bridge` under `addon/smartthings_web_bridge`. This would drift and violate the monorepo source-of-truth requirement.
2. Make the Dockerfile clone the private GitHub repository. Supervisor builds would need credentials and network access and would no longer be reproducible.
3. Publish only a prebuilt registry image. This would require a separate registry publication and authentication design before the private local-install path works.

## Packaging boundary

`tools/package-addon.ts` owns packaging. Its library function accepts explicit repository and output paths so tests can use temporary directories. The CLI defaults to the repository root and `dist-addon/smartthings_web_bridge`.

The packager:

1. validates every required source path before deleting the previous generated destination;
2. resolves and verifies that the destination remains inside the selected output root;
3. copies only the approved runtime/build inputs;
4. rejects symlinks and reparse points instead of following them;
5. writes a deterministic manifest containing schema version and sorted SHA-256 hashes for every packaged file except the manifest itself;
6. never copies `.git`, `node_modules`, tests, fixtures, browser profiles, captures, secrets, or generated runtime data.

## Docker build context

The add-on Dockerfile becomes context-local:

- `COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./`
- `COPY bridge ./bridge`
- `COPY rootfs /`

It does not reference `addon/smartthings_web_bridge` or any parent directory. The standalone `docker/Dockerfile` remains rooted at the monorepo and is not used by Supervisor.

`npm run package:addon` generates the distribution. The verification command builds exactly that directory as the Docker context with `BUILD_ARCH=amd64`. This matches the live HAOS architecture observed on 2026-08-20.

## Installation contract

The private-repository instructions become:

1. run `npm ci` and `npm run package:addon` on the development machine;
2. copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge` using the authenticated HA Filebrowser/Samba/SSH path;
3. run **Check for updates** under **Settings → Apps → Install app**;
4. inspect the local app before installation.

Uploading or installing into the live HAOS host remains a separate production mutation and requires an explicit live-install handoff.

## Tests

Tests must prove:

- the generated directory contains every required build/runtime file;
- its Dockerfile has no parent/repository-root `COPY` dependency;
- forbidden source trees and secrets are absent;
- the manifest is deterministic and matches every packaged file;
- packaging twice replaces stale generated files without changing hashes;
- a missing source fails before the previous output is removed;
- documentation points to the generated directory;
- Docker can build the generated directory as its sole context.

## Completion criteria

This repair is complete when automated tests pass and a fresh Docker build from only `dist-addon/smartthings_web_bridge` reaches `LOGIN_REQUIRED` with no host ports and the existing Ingress/security checks still passing.
