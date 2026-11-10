import type {
  AppendLogPort,
  ArtifactOwnerLine,
  ArtifactRef,
  ArtifactStorePort,
  UserInput,
} from '@multiagentos/contracts';

export type ArtifactRetention = ArtifactOwnerLine['retention'];
export type ArtifactRefusal = 'INVALID_ARTIFACT_REF' | 'ARTIFACT_EXPIRED';
export type ArtifactRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reasonCode: ArtifactRefusal };

export interface SessionArtifactsDeps {
  readonly store: ArtifactStorePort;
  readonly owners: AppendLogPort<ArtifactOwnerLine>;
  readonly expiringRetentionDays: number;
  readonly now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_INPUT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/**
 * A SESSION registration never expires; an EXPIRING or ONCE one does, whether or not its body is
 * gone, and a released one has. A released artifact reads as expired at once (Kernel/Execution 6d).
 */
export function isExpired(line: ArtifactOwnerLine, retentionDays: number, now: Date): boolean {
  if (line.releasedAt !== undefined) return true;
  if (line.retention === 'SESSION') return false;
  return now.getTime() >= new Date(line.retainedSince).getTime() + retentionDays * DAY_MS;
}

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

  /**
   * A fork owns what the copied log refers to, under the original's terms: same retention, same
   * clock (Kernel/Execution 6d). What the original never registered is returned, not taken on.
   */
  async inherit(
    refs: readonly ArtifactRef[],
    source: AppendLogPort<ArtifactOwnerLine>,
  ): Promise<readonly ArtifactRef[]> {
    const lines = new Map<string, ArtifactOwnerLine>();
    await source.repairTail();
    for await (const line of source.readAll()) lines.set(line.artifactId, line);
    const unknown: ArtifactRef[] = [];
    for (const ref of refs) {
      const line = lines.get(ref.artifactId);
      if (line === undefined) {
        unknown.push(ref);
        continue;
      }
      const inherited: ArtifactOwnerLine = {
        ...line,
        source: 'INHERITED',
        at: this.#deps.now().toISOString(),
      };
      await this.#deps.owners.append(inherited);
      this.#owners.set(ref.artifactId, inherited);
    }
    return unknown;
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
    return isExpired(line, this.#deps.expiringRetentionDays, this.#deps.now())
      ? 'ARTIFACT_EXPIRED'
      : undefined;
  }

  owns(ref: ArtifactRef): boolean {
    return this.#check(ref) === undefined;
  }

  isFullOutput(ref: ArtifactRef): boolean {
    return this.#owners.get(ref.artifactId)?.fullOutput === true;
  }

  /**
   * Keeps what a handover carries for as long as the Session lives: an output that would be
   * reclaimed after its days is registered again as SESSION, keeping its full-output mark. False,
   * and nothing changed, when one of them is not this Session's or has expired already.
   */
  async retain(refs: readonly ArtifactRef[]): Promise<boolean> {
    if (!refs.every((ref) => this.owns(ref))) return false;
    for (const ref of refs) {
      const known = this.#owners.get(ref.artifactId);
      if (known === undefined || known.retention === 'SESSION') continue;
      const at = this.#deps.now().toISOString();
      const line: ArtifactOwnerLine = { ...known, retention: 'SESSION', retainedSince: at, at };
      await this.#deps.owners.append(line);
      this.#owners.set(ref.artifactId, line);
    }
    return true;
  }

  /**
   * Releases what was registered ONCE, made for one consumer that is done with it: the
   * registration says so, it reads as expired from now on, and the next sweep reclaims the body.
   * Anything kept for longer (SESSION, or EXPIRING) is left as it is. Returns the bytes released.
   */
  async release(refs: readonly ArtifactRef[]): Promise<number> {
    let bytes = 0;
    for (const ref of refs) {
      const known = this.#owners.get(ref.artifactId);
      if (
        known?.retention !== 'ONCE' ||
        known.releasedAt !== undefined ||
        known.sha256 !== ref.sha256
      )
        continue;
      const at = this.#deps.now().toISOString();
      const line: ArtifactOwnerLine = { ...known, releasedAt: at, at };
      await this.#deps.owners.append(line);
      this.#owners.set(ref.artifactId, line);
      bytes += known.size;
    }
    return bytes;
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
