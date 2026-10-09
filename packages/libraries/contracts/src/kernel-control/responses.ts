import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import { SYSCALL_REJECTED_CODES } from '../platform-common/reason-code.js';
import { closed } from '../platform-common/schema-helpers.js';
import { CloseReasonSchema } from './run-outcome.js';

export const SyscallAckSchema = closed(
  { requestId: IdSchemas.requestId, outcome: Type.Literal('ACCEPTED') },
  'kernel.control.SyscallAck.v0',
);
export type SyscallAck = Static<typeof SyscallAckSchema>;

type SyscallRejectedCode = (typeof SYSCALL_REJECTED_CODES)[number];
const rejected = {
  requestId: IdSchemas.requestId,
  outcome: Type.Literal('REJECTED'),
  issuer: Type.Enum(['GATEWAY', 'CORE']),
};
/** `closeReason` is present exactly when the reason is RUN_BLOCKED. */
export const SyscallRejectedSchema = Type.Union(
  [
    closed({
      ...rejected,
      reasonCode: Type.Literal('RUN_BLOCKED'),
      closeReason: CloseReasonSchema,
    }),
    closed({
      ...rejected,
      reasonCode: Type.Unsafe<Exclude<SyscallRejectedCode, 'RUN_BLOCKED'>>(
        Type.Enum(SYSCALL_REJECTED_CODES.filter((code) => code !== 'RUN_BLOCKED')),
      ),
    }),
  ],
  { $id: 'kernel.control.SyscallRejected.v0' },
);
export type SyscallRejected = Static<typeof SyscallRejectedSchema>;

export const RunCreatedSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    workflowRunId: IdSchemas.workflowRunId,
  },
  'kernel.control.RunCreated.v0',
);
export type RunCreated = Static<typeof RunCreatedSchema>;

/** Every M1 artifact is UTF-8 text or JSON. */
export const ArtifactContentSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    ref: ArtifactRefSchema,
    text: Type.String(),
  },
  'kernel.control.ArtifactContent.v0',
);
export type ArtifactContent = Static<typeof ArtifactContentSchema>;
