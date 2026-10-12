// Structural kernel-contact tracking: the tracked-client proxy the gate
// wraps every op's client in. Contact alone drives the breaker's
// reset-on-success — two load-bearing assumptions live here (every public
// client method except getVersion is an authenticated route, and an op
// reaches the kernel only through the client the gate passed it), so the
// trap is unit-falsified directly in kernelContact.test.ts beside the
// end-to-end pins in gate.test.ts.

/**
 * Marks kernel contact on any method invocation except the version probe:
 * the breaker's reset-on-success contract counts only authenticated calls,
 * and getVersion is unauthenticated — gateWriteAttempt probes with this
 * same tracked client on the retry path. Every other method an op can
 * reach is an authenticated route, so invocation = contact; an op-internal
 * refusal that invokes no method (shape, missing docId, drift) stays
 * unmarked. Property reads (baseUrl) pass through untouched, and every
 * method access returns a fresh target-bound wrapper — never a
 * wrapper-on-wrapper. The trap wraps any function-valued property read,
 * inherited Object.prototype members included — a destructure is safe
 * (the wrapper is already target-bound), but no op coerces the client
 * (a `toString` read would mark without a kernel call) or constructs
 * through client.constructor (escaping the trap entirely); one that
 * ever did would need the wrapping restricted to the client's own and
 * prototype methods.
 * Per-op by construction: runKbCall builds one tracked client per gated
 * call, so concurrent ops share no flag.
 */
export function trackKernel<K extends object>(kernel: K, mark: () => void): K {
	return new Proxy(kernel, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") {
				return value;
			}
			// getVersion is the probe: it must run bound to the raw target but
			// mark nothing. Returning it unwrapped would hand it `this = proxy`,
			// and its own internal `this.request` would re-enter this trap and
			// mark contact for an unauthenticated route.
			return (...args: unknown[]) => {
				if (prop !== "getVersion") mark();
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}
