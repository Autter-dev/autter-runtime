import { withAutterSourceMaps } from "@autter/runtime-cli/next";

// AUTTER_RUNTIME_KEY / AUTTER_ENDPOINT / AUTTER_RELEASE come from the
// environment, as in CI. `next build` uses Turbopack (Next 16's default).
export default withAutterSourceMaps(
	{
		distDir: process.env.E2E_NEXT_DIST_DIR ?? ".next",
		env: { NEXT_PUBLIC_AUTTER_RELEASE: process.env.AUTTER_RELEASE ?? "" },
	},
	{ release: process.env.AUTTER_RELEASE },
);
