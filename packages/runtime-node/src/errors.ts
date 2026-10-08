/**
 * Structured, coded errors (shared with @autter/runtime-edge through the
 * bundled runtime-core). See docs/REQUESTS-AND-ERRORS.md.
 */
export {
	CODE_PATTERN,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	toClientError,
	errorAttributes,
	type RuntimeErrorDefinition,
	type RuntimeErrorExtras,
	type RuntimeErrorOptions,
	type RuntimeErrorLike,
	type RuntimeErrorFactory,
	type RuntimeErrorCatalog,
	type ClientErrorBody,
	type RuntimeCarrier,
} from "@autter/runtime-core";
