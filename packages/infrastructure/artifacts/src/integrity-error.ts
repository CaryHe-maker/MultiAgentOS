/** Stored content does not match its reference, or a write could not be verified. */
export class ArtifactIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactIntegrityError';
  }
}
