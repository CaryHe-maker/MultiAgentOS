import { Type, type TProperties } from 'typebox';

/** Object schema that rejects undeclared properties (M1Interface 1.2 rule 3). */
export const closed = <P extends TProperties>(properties: P, $id?: string) =>
  Type.Object(properties, { additionalProperties: false, ...($id === undefined ? {} : { $id }) });

export const text = (maxLength: number, minLength = 1) => Type.String({ minLength, maxLength });
export const count = (minimum = 0) => Type.Integer({ minimum });
export const Sha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const TimestampSchema = Type.String({ format: 'date-time' });
