export type ExperimentInput = unknown;

export type ExperimentOutput = unknown;

export class NotImplementedError extends Error {
  public constructor(component: string, operation: string) {
    super(`${component}.${operation} is not implemented`);
    this.name = 'NotImplementedError';
  }
}
