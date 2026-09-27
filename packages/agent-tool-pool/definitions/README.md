# AgentToolPool definitions

Immutable, versioned definitions loaded and validated when the runtime starts.

```text
agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

To publish a change, never edit a sealed file:

1. Copy the file to a new version path, for example `v0.1.0.yaml` to `v0.2.0.yaml`.
2. Change `version` and the content, and delete the `digest` line.
3. Point references (agent `unitRefs`, unit `toolRefs`, ...) at the new version, again as
   new versions of those files.
4. Run `pnpm run catalog:seal`, then `pnpm run check`.

A digest covers the digests of everything the definition references, so an edited tool
also invalidates every unit and agent above it until they are republished.
`status.yaml` is the only file that may change in place. See `docs/cc/AgentToolPoolM1.md`.
