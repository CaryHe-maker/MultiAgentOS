import type {
  AppendLogPort,
  ArtifactOwnerLine,
  ArtifactRef,
  ArtifactStorePortV1,
  UserInput,
} from '@multiagentos/contracts';

export type ArtifactRetention = ArtifactOwnerLine['retention'];
export type ArtifactRefusal = 'INVALID_ARTIFACT_REF' | 'ARTIFACT_EXPIRED';
export type ArtifactRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reasonCode: ArtifactRefusal };

export interface SessionArtifactsDeps {
  readonly store: ArtifactStorePortV1;
  readonly owners: AppendLogPort<ArtifactOwnerLine>;
  readonly expiringRetentionDays: number;
  readonly now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_INPUT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/**
 * Which artifacts belong to this Session (Kernel/Execution 3). The owner line is appended before
 * a reference is handed out, so a sweep never removes a body somebody already holds, and the
 * answer to a reference outside the index does not say whether it exists at all.
 */
export class SessionArtifacts {
  readonly #deps: SessionArtifactsDeps;
  readonly #owners = new Map<string, ArtifactOwnerLine>();
  readonly #inputs = new Map<string, ArtifactRef>();

  public constructor(deps: SessionArtifactsDeps) {
    this.#deps = deps;
  }

  /** Reads the owner index of a Session that is being opened. */
  async load(): Promise<void> {
    await this.#deps.owners.repairTail();
    for await (const line of this.#deps.owners.readAll()) this.#owners.set(line.artifactId, line);
  }

  /** The strongest registration wins: SESSION is never given up, and `fullOutput` stays set. */
  async put(
    text: string,
    mediaType: string,
    retention: ArtifactRetention,
    options: { readonly fullOutput?: boolean } = {},
  ): Promise<ArtifactRef> {
    const ref = await this.#deps.store.put(Buffer.from(text, 'utf8'), mediaType);
    const known = this.#owners.get(ref.artifactId);
    const fullOutput = options.fullOutput === true || known?.fullOutput === true;
    const kept = known?.retention === 'SESSION' ? 'SESSION' : retention;
    if (known?.retention === 'SESSION' && fullOutput === (known.fullOutput === true)) return ref;
    const at = this.#deps.now().toISOString();
    const line: ArtifactOwnerLine = {
      artifactId: ref.artifactId,
      mediaType: ref.mediaType,
      sha256: ref.sha256,
      size: ref.size,
      retention: kept,
      source: known?.source ?? 'PRODUCED',
      ...(fullOutput ? { fullOutput: true as const } : {}),
      retainedSince: at,
      at,
    };
    await this.#deps.owners.append(line);
    this.#owners.set(ref.artifactId, line);
    return ref;
  }

  /** The same `inputId` gives the same reference. */
  async storeUserInput(input: UserInput): Promise<ArtifactRef> {
    const known = this.#inputs.get(input.inputId);
    if (known !== undefined) return known;
    const ref = await this.put(input.text, USER_INPUT_MEDIA_TYPE, 'SESSION');
    this.#inputs.set(input.inputId, ref);
    return ref;
  }

  #check(ref: ArtifactRef): ArtifactRefusal | undefined {
    const line = this.#owners.get(ref.artifactId);
    if (line?.sha256 !== ref.sha256 || line.size !== ref.size) return 'INVALID_ARTIFACT_REF';
    if (line.retention === 'SESSION') return undefined;
    const expiresAt =
      new Date(line.retainedSince).getTime() + this.#deps.expiringRetentionDays * DAY_MS;
    return this.#deps.now().getTime() >= expiresAt ? 'ARTIFACT_EXPIRED' : undefined;
  }

  owns(ref: ArtifactRef): boolean {
    return this.#check(ref) === undefined;
  }

  /** A body missing from the store counts as expired, whatever the registration says. */
  async read(ref: ArtifactRef): Promise<ArtifactRead> {
    const refusal = this.#check(ref);
    if (refusal !== undefined) return { ok: false, reasonCode: refusal };
    try {
      return { ok: true, text: Buffer.from(await this.#deps.store.get(ref)).toString('utf8') };
    } catch {
      return { ok: false, reasonCode: 'ARTIFACT_EXPIRED' };
    }
  }
}
