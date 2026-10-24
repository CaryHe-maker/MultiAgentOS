/** A message could not be routed. Schema violations throw ContractValidationError instead. */
export class FabricError extends Error {
  public constructor(
    public readonly code:
      | 'NO_HANDLER'
      | 'NO_SUBSCRIBER'
      | 'ALREADY_REGISTERED'
      | 'INVALID_REGISTRATION'
      | 'NOT_RUNNING'
      | 'REQUEST_TIMEOUT',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'FabricError';
  }
}
