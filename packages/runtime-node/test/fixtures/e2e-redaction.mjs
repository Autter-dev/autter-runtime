// Child fixture: FULL pipeline e2e — initAutterServer against the parent's
// local collector, capture an exception full of PII, then SIGTERM. Auto-flush
// must push the redacted span out before the process dies.
import { initAutterServer } from "../../dist/index.js";

const autter = initAutterServer({
	endpoint: `http://127.0.0.1:${process.env.COLLECTOR_PORT}`,
	apiKey: "autter_rt_e2e",
	service: "e2e-redaction",
	environment: "test",
	metricIntervalMs: 3_600_000, // keep metric noise out of this test
});

setTimeout(() => {
	autter.captureException(new Error("boom: order failed"), {
		"order.id": "o-1",
		"user.email": "jane.doe@example.com",
		auth: "Bearer supersecrettoken123456",
		"context.jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM",
	});
	setTimeout(() => {
		process.kill(process.pid, "SIGTERM");
	}, 100);
}, 30);
