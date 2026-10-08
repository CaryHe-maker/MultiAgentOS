# AgentToolPool definitions

Versioned definitions loaded and validated when the runtime starts.

```text
agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

## Draft versions (v0.x): edit in place

While M1 is changing prompts and tools every day, definitions stay below `v1.0.0`. Edit the
file directly and run `pnpm run check`. A draft file has no `digest` line: the digest is
computed at every start, and each run records the digests it pinned in `pinnedDefinitions`,
so a run can still be traced to exact content (together with the git commit).

## Published versions (v1.0.0 and later): never edit

1. Create the file at a new version path without a `digest` line.
2. Run `pnpm run catalog:seal`; it writes the digest into files that lack one and never
   changes a file that already has one.
3. To change a published definition, publish a new version. Editing a sealed file fails
   startup with `DIGEST_MISMATCH`.

A published definition may only reference published versions, and its digest covers the
digests of everything it references.

`status.yaml` marks versions as DEPRECATED, QUARANTINED or REVOKED without editing them.
Design notes: `docs/M1/library/AgentToolPool.md`.
