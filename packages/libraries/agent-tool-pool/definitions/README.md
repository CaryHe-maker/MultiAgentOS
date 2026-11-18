# AgentToolPool definitions

Versioned definitions loaded and validated when the runtime starts.

```text
agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

## Draft versions (v0.x): edit in place

A draft file has no `digest` line and may be edited directly (`pnpm run check` afterwards):
the digest is computed at every start, and each run records the digests it pinned, so a run
can still be traced to exact content (together with the git commit). The shipped catalog has
no drafts: M2 sealed `v1.0.0` (M2 V1.0) and `v1.1.0` (the Turn-chat tools and units of V1.1).

## Published versions (v1.0.0 and later): never edit

1. Create the file at a new version path without a `digest` line.
2. Run `pnpm run catalog:seal`; it writes the digest into files that lack one and never
   changes a file that already has one.
3. To change a published definition, publish a new version. Editing a sealed file fails
   startup with `DIGEST_MISMATCH`.

A published definition may only reference published versions, and its digest covers the
digests of everything it references.

`status.yaml` marks versions as DEPRECATED, QUARANTINED or REVOKED without editing them.
Design notes: `docs/M2/Library/AgentToolPool.md`.
