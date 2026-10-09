import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const ChangeSetRefSchema = OpaqueRefSchema('change-set', 'integration.ChangeSetRef.v0');
export type ChangeSetRef = Static<typeof ChangeSetRefSchema>;
export const IntegrationPlanRefSchema = OpaqueRefSchema(
  'integration-plan',
  'integration.IntegrationPlanRef.v0',
);
export type IntegrationPlanRef = Static<typeof IntegrationPlanRefSchema>;
export const QualityGateResultRefSchema = OpaqueRefSchema(
  'quality-gate-result',
  'integration.QualityGateResultRef.v0',
);
export type QualityGateResultRef = Static<typeof QualityGateResultRefSchema>;
