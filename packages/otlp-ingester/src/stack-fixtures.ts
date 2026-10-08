/**
 * Representative raw stack traces for every officially-supported runtime,
 * exactly as their OpenTelemetry SDKs put them on the `exception.stacktrace`
 * span attribute (or the browser relay's `stack` field). These drive the
 * golden fingerprint tests in fingerprint.test.ts.
 *
 * Each language provides three variants of the SAME family of errors:
 *   - `primary`  — the defect under test.
 *   - `sibling`  — a DIFFERENT defect (different top function/file) that
 *     carries the SAME error message. It must fingerprint separately: this is
 *     the regression the pipeline exists to prevent (before per-language
 *     parsing, Go/Rust frames were dropped and these collided into one issue).
 *   - `redeploy` — the primary defect after a rebuild that shifted every line
 *     number (and, for Go, pointer offsets/addresses/goroutine ids). It must
 *     fingerprint IDENTICALLY to `primary`, proving grouping is stable across
 *     re-deploys and repeated ingestion.
 */

export interface StackFixture {
	primary: string;
	sibling: string;
	redeploy: string;
	/** Golden normalised top frames for `primary` (locks the parser output). */
	primaryFrames: string[];
}

// ── Go ──────────────────────────────────────────────────────────────────────

const GO_PRIMARY = `panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x1a2b3c]

goroutine 42 [running]:
main.(*OrderService).Process(0xc0000b4000, 0xc0000d2000)
	/app/orders/service.go:128 +0x1a5
main.(*Handler).ServeHTTP(0xc0000a2000, {0x8f2a40, 0xc0000b0000})
	/app/web/handler.go:64 +0x2c8
net/http.(*conn).serve(0xc0001a4000, {0x8f2b20, 0xc0000c2000})
	/usr/local/go/src/net/http/server.go:2092 +0x1a5
created by net/http.(*Server).Serve in goroutine 1
	/usr/local/go/src/net/http/server.go:3285 +0x33e`;

const GO_SIBLING = `panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4d5e6f]

goroutine 88 [running]:
main.(*PaymentService).Charge(0xc0000f4000, 0xc000102000)
	/app/payments/service.go:212 +0x9c
main.(*Handler).ServeHTTP(0xc0000a2000, {0x8f2a40, 0xc0000b0000})
	/app/web/handler.go:64 +0x2c8
net/http.(*conn).serve(0xc0001a4000, {0x8f2b20, 0xc0000c2000})
	/usr/local/go/src/net/http/server.go:2092 +0x1a5`;

const GO_REDEPLOY = `panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x7a8b9c]

goroutine 15 [running]:
main.(*OrderService).Process(0xc000200000, 0xc000210000)
	/app/orders/service.go:140 +0x1f2
main.(*Handler).ServeHTTP(0xc000202000, {0x8f2a40, 0xc000208000})
	/app/web/handler.go:71 +0x300
net/http.(*conn).serve(0xc000300000, {0x8f2b20, 0xc000310000})
	/usr/local/go/src/net/http/server.go:2092 +0x1a5
created by net/http.(*Server).Serve in goroutine 1
	/usr/local/go/src/net/http/server.go:3285 +0x33e`;

// ── Rust ────────────────────────────────────────────────────────────────────

const RUST_PRIMARY = `thread 'actix-rt|system:0|arbiter:1' panicked at src/orders/service.rs:88:21:
called \`Result::unwrap()\` on an \`Err\` value: PoolTimedOut
stack backtrace:
   0: rust_begin_unwind
             at /rustc/abc123/library/std/src/panicking.rs:665:5
   1: core::panicking::panic_fmt
             at /rustc/abc123/library/core/src/panicking.rs:74:14
   2: core::result::unwrap_failed
             at /rustc/abc123/library/core/src/result.rs:1679:5
   3: myapp::orders::service::OrderService::process
             at ./src/orders/service.rs:88:21
   4: myapp::web::handler::handle_request
             at ./src/web/handler.rs:42:9`;

const RUST_SIBLING = `thread 'main' panicked at src/payments/service.rs:143:10:
called \`Result::unwrap()\` on an \`Err\` value: PoolTimedOut
stack backtrace:
   0: rust_begin_unwind
             at /rustc/abc123/library/std/src/panicking.rs:665:5
   1: core::panicking::panic_fmt
             at /rustc/abc123/library/core/src/panicking.rs:74:14
   2: core::result::unwrap_failed
             at /rustc/abc123/library/core/src/result.rs:1679:5
   3: myapp::payments::service::PaymentService::charge
             at ./src/payments/service.rs:143:10
   4: myapp::web::handler::handle_request
             at ./src/web/handler.rs:42:9`;

const RUST_REDEPLOY = `thread 'main' panicked at src/orders/service.rs:95:21:
called \`Result::unwrap()\` on an \`Err\` value: PoolTimedOut
stack backtrace:
   0: rust_begin_unwind
             at /rustc/abc123/library/std/src/panicking.rs:665:5
   1: core::panicking::panic_fmt
             at /rustc/abc123/library/core/src/panicking.rs:74:14
   2: core::result::unwrap_failed
             at /rustc/abc123/library/core/src/result.rs:1679:5
   3: myapp::orders::service::OrderService::process
             at ./src/orders/service.rs:95:21
   4: myapp::web::handler::handle_request
             at ./src/web/handler.rs:47:9`;

// ── Java / JVM ──────────────────────────────────────────────────────────────

const JAVA_PRIMARY = `java.lang.NullPointerException: Cannot invoke "com.example.model.Order.total()" because "order" is null
	at com.example.orders.OrderService.process(OrderService.java:88)
	at com.example.web.RequestHandler.handle(RequestHandler.java:42)
	at com.example.web.RequestHandler.doGet(RequestHandler.java:31)
	at jakarta.servlet.http.HttpServlet.service(HttpServlet.java:687)
	at java.base/java.lang.Thread.run(Thread.java:1583)
Caused by: java.lang.IllegalStateException: order not loaded
	at com.example.orders.OrderLoader.require(OrderLoader.java:55)
	... 4 more`;

const JAVA_SIBLING = `java.lang.NullPointerException: Cannot invoke "com.example.model.Order.total()" because "order" is null
	at com.example.billing.InvoiceService.render(InvoiceService.java:140)
	at com.example.web.RequestHandler.handle(RequestHandler.java:42)
	at com.example.web.RequestHandler.doGet(RequestHandler.java:31)
	at jakarta.servlet.http.HttpServlet.service(HttpServlet.java:687)
	at java.base/java.lang.Thread.run(Thread.java:1583)`;

const JAVA_REDEPLOY = `java.lang.NullPointerException: Cannot invoke "com.example.model.Order.total()" because "order" is null
	at com.example.orders.OrderService.process(OrderService.java:92)
	at com.example.web.RequestHandler.handle(RequestHandler.java:45)
	at com.example.web.RequestHandler.doGet(RequestHandler.java:33)
	at jakarta.servlet.http.HttpServlet.service(HttpServlet.java:690)
	at java.base/java.lang.Thread.run(Thread.java:1589)`;

// ── .NET ────────────────────────────────────────────────────────────────────

const DOTNET_PRIMARY = `System.NullReferenceException: Object reference not set to an instance of an object.
   at MyApp.Orders.OrderService.Process(Order order) in C:\\src\\MyApp\\Orders\\OrderService.cs:line 88
   at MyApp.Web.RequestHandler.HandleAsync(HttpContext context) in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 42
   at MyApp.Web.RequestHandler.<HandleAsync>d__4.MoveNext() in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 39
   at System.Runtime.CompilerServices.AsyncMethodBuilderCore.Start[TStateMachine](ref TStateMachine stateMachine)
   at System.Threading.Tasks.Task.ExecuteWithThreadLocal(ref Task currentTaskSlot)`;

const DOTNET_SIBLING = `System.NullReferenceException: Object reference not set to an instance of an object.
   at MyApp.Billing.InvoiceService.Render(Invoice invoice) in C:\\src\\MyApp\\Billing\\InvoiceService.cs:line 205
   at MyApp.Web.RequestHandler.HandleAsync(HttpContext context) in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 42
   at MyApp.Web.RequestHandler.<HandleAsync>d__4.MoveNext() in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 39
   at System.Runtime.CompilerServices.AsyncMethodBuilderCore.Start[TStateMachine](ref TStateMachine stateMachine)
   at System.Threading.Tasks.Task.ExecuteWithThreadLocal(ref Task currentTaskSlot)`;

const DOTNET_REDEPLOY = `System.NullReferenceException: Object reference not set to an instance of an object.
   at MyApp.Orders.OrderService.Process(Order order) in C:\\src\\MyApp\\Orders\\OrderService.cs:line 94
   at MyApp.Web.RequestHandler.HandleAsync(HttpContext context) in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 47
   at MyApp.Web.RequestHandler.<HandleAsync>d__4.MoveNext() in C:\\src\\MyApp\\Web\\RequestHandler.cs:line 44
   at System.Runtime.CompilerServices.AsyncMethodBuilderCore.Start[TStateMachine](ref TStateMachine stateMachine)
   at System.Threading.Tasks.Task.ExecuteWithThreadLocal(ref Task currentTaskSlot)`;

// ── JavaScript / Node (V8) ──────────────────────────────────────────────────

const NODE_PRIMARY = `TypeError: Cannot read properties of undefined (reading 'total')
    at OrderService.process (/app/dist/orders/service.js:128:35)
    at RequestHandler.handle (/app/dist/web/handler.js:64:20)
    at /app/dist/web/router.js:22:9
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const NODE_SIBLING = `TypeError: Cannot read properties of undefined (reading 'total')
    at PaymentService.charge (/app/dist/payments/service.js:212:18)
    at RequestHandler.handle (/app/dist/web/handler.js:64:20)
    at /app/dist/web/router.js:22:9
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const NODE_REDEPLOY = `TypeError: Cannot read properties of undefined (reading 'total')
    at OrderService.process (/app/dist/orders/service.js:131:35)
    at RequestHandler.handle (/app/dist/web/handler.js:70:20)
    at /app/dist/web/router.js:25:9
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

// ── Python ──────────────────────────────────────────────────────────────────

const PYTHON_PRIMARY = `Traceback (most recent call last):
  File "/app/web/handler.py", line 42, in handle
    return self.service.process(order)
  File "/app/orders/service.py", line 88, in process
    raise ValueError(f"order {order_id} is invalid")
ValueError: order 4821 is invalid`;

const PYTHON_SIBLING = `Traceback (most recent call last):
  File "/app/web/handler.py", line 42, in handle
    return self.service.process(order)
  File "/app/billing/invoice.py", line 205, in render
    raise ValueError(f"order {order_id} is invalid")
ValueError: order 7734 is invalid`;

export const STACK_FIXTURES: Record<string, StackFixture> = {
	go: {
		primary: GO_PRIMARY,
		sibling: GO_SIBLING,
		redeploy: GO_REDEPLOY,
		primaryFrames: [
			"main.(*OrderService).Process (/app/orders/service.go)",
			"main.(*Handler).ServeHTTP (/app/web/handler.go)",
			"net/http.(*conn).serve (/usr/local/go/src/net/http/server.go)",
			"net/http.(*Server).Serve (/usr/local/go/src/net/http/server.go)",
		],
	},
	rust: {
		primary: RUST_PRIMARY,
		sibling: RUST_SIBLING,
		redeploy: RUST_REDEPLOY,
		primaryFrames: [
			"rust_begin_unwind (/rustc/abc123/library/std/src/panicking.rs)",
			"core::panicking::panic_fmt (/rustc/abc123/library/core/src/panicking.rs)",
			"core::result::unwrap_failed (/rustc/abc123/library/core/src/result.rs)",
			"myapp::orders::service::OrderService::process (./src/orders/service.rs)",
			"myapp::web::handler::handle_request (./src/web/handler.rs)",
		],
	},
	java: {
		primary: JAVA_PRIMARY,
		sibling: JAVA_SIBLING,
		redeploy: JAVA_REDEPLOY,
		primaryFrames: [
			"com.example.orders.OrderService.process(OrderService.java)",
			"com.example.web.RequestHandler.handle(RequestHandler.java)",
			"com.example.web.RequestHandler.doGet(RequestHandler.java)",
			"jakarta.servlet.http.HttpServlet.service(HttpServlet.java)",
			"java.base/java.lang.Thread.run(Thread.java)",
		],
	},
	dotnet: {
		primary: DOTNET_PRIMARY,
		sibling: DOTNET_SIBLING,
		redeploy: DOTNET_REDEPLOY,
		primaryFrames: [
			"MyApp.Orders.OrderService.Process (C:\\src\\MyApp\\Orders\\OrderService.cs)",
			"MyApp.Web.RequestHandler.HandleAsync (C:\\src\\MyApp\\Web\\RequestHandler.cs)",
			"MyApp.Web.RequestHandler.<HandleAsync>d__4.MoveNext (C:\\src\\MyApp\\Web\\RequestHandler.cs)",
			"System.Runtime.CompilerServices.AsyncMethodBuilderCore.Start[TStateMachine]",
			"System.Threading.Tasks.Task.ExecuteWithThreadLocal",
		],
	},
	node: {
		primary: NODE_PRIMARY,
		sibling: NODE_SIBLING,
		redeploy: NODE_REDEPLOY,
		primaryFrames: [
			"at OrderService.process (/app/dist/orders/service.js",
			"at RequestHandler.handle (/app/dist/web/handler.js",
			"at /app/dist/web/router.js",
			"at processTicksAndRejections (node:internal/process/task_queues",
		],
	},
	python: {
		primary: PYTHON_PRIMARY,
		sibling: PYTHON_SIBLING,
		redeploy: PYTHON_PRIMARY,
		primaryFrames: [
			'File "/app/web/handler.py", line 42, in handle',
			'File "/app/orders/service.py", line 88, in process',
		],
	},
};
