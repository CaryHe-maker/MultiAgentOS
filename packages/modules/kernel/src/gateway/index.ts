/**
 * Kernel.Gateway (docs/M1/Kernel/Gateway.md): the only entry of external syscalls. Checks the
 * caller, the request Schema and the admission cache, then forwards a `GatewayForward` to the
 * Kernel core over Fabric. A separate communication subject: it imports no Kernel core code.
 */
import type { FabricPort, LifecyclePort } from '@multiagentos/contracts';

export interface GatewayDeps {
  /** The Fabric client whose producer is `gateway`. */
  readonly fabric: FabricPort;
  readonly now?: () => Date;
}

export function createGateway(deps: GatewayDeps): LifecyclePort {
  void deps;
  throw new Error('NOT_IMPLEMENTED: Kernel.Gateway');
}
