/**
 * @autter/runtime-cli — readable stack traces for Autter Runtime.
 *
 * Programmatic API behind the `autter-runtime` bin and the bundler plugins
 * (`@autter/runtime-cli/vite`, `/webpack`, `/next`): inject content-addressed
 * debug ids into JS bundles, upload their source maps to the ingester, and
 * verify a build before deploy. (`sourcemaps setup` is CLI-only.)
 */
export {
	DEBUG_ID_REGISTRY,
	DEBUG_ID_RE,
	debugIdFor,
	debugIdSnippet,
	hasDebugIdSnippet,
	normalizeDebugId,
	readDebugIdComment,
} from "./debug-id.js";
export {
	BUNDLE_RE,
	findBundles,
	mapPathFor,
	readSourceMappingUrl,
	stripSourceMappingUrl,
	type BundleWithMap,
} from "./files.js";
export {
	injectBundle,
	injectDir,
	shiftMappings,
	snippetLine,
	SNIPPET_LINE_KEY,
	type InjectOptions,
	type InjectResult,
} from "./inject.js";
export {
	CLIENT_KEY_PREFIX,
	DEFAULT_ENDPOINT,
	FatalUploadError,
	KEY_ADVICE,
	SERVER_KEY_PREFIX,
	UPLOAD_KEY_PREFIX,
	MAX_MAP_CHARS,
	MAX_UPLOAD_BYTES,
	resolveEndpoint,
	servedFilename,
	storedMapJson,
	uploadDir,
	type UploadItem,
	type UploadOptions,
	type UploadSummary,
} from "./upload.js";
export { formatVerify, globToRegExp, verifyDir, type VerifyBundle, type VerifyOptions, type VerifyResult } from "./verify.js";
export { computeScopes, SCOPES_KEY, SCOPES_VERSION, type ScopesResult, type SourceMapScopes } from "./scopes.js";
export { gitHead, RELEASE_ENV_VARS, RELEASE_RE, resolveRelease, type ResolvedRelease } from "./release.js";
export {
	formatUploadSummary,
	processBuildOutput,
	type AutterSourceMapsOptions,
	type BuildOutputResult,
} from "./build.js";
