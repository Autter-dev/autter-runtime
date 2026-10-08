/**
 * Structural copy of OpenTelemetry's `Attributes` so runtime-core stays
 * dependency-free (it is bundled into the zero-dependency edge package).
 * Assignable both ways with `@opentelemetry/api`'s type.
 */
export type AttributeValue =
	| string
	| number
	| boolean
	| Array<null | undefined | string>
	| Array<null | undefined | number>
	| Array<null | undefined | boolean>;
export type Attributes = Record<string, AttributeValue | undefined>;
