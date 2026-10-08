/**
 * Server-side secret/PII redaction. The implementation lives in the private
 * @autter/runtime-core package (bundled into this one at build time) so the
 * edge SDK masks exactly the same keys and values; this module keeps the
 * 1.4.0 import path and public API.
 */
export {
	redactAttributes,
	redactText,
	makeRedactor,
	type RedactOptions,
	type AttributeRedactor as Redactor,
} from "@autter/runtime-core";
