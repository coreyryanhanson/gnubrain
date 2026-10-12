// Structural kernel-contact tracking: the tracked-client proxy the gate
// wraps every op's client in. Contact alone drives the breaker's
// reset-on-success — two load-bearing assumptions live here (every public
// client method is an authenticated route — comment-pinned, not
// suite-pinned: the version probe runs on the raw client the gate hands
// the op alongside the tracked one, so it never appears in this trap —
// and an op reaches the kernel only through the clients the gate passed
// it); the trap is unit-falsified directly, beside the gate suite's
// end-to-end pins.

/**
 * Marks kernel contact on any method invocation, without exception: the
 * breaker's reset-on-success contract counts only authenticated calls,
 * and the version probe never rides this proxy — the gate hands ops the
 * raw client as the probe handle (declared as the narrow probe type, so
 * a real call through it fails typecheck), making the trap
 * exception-free by construction. An op-internal refusal that invokes
 * no method (shape, missing docId, drift) stays unmarked. Property reads
 * (baseUrl) pass through untouched, and every method access returns a
 * fresh target-bound wrapper — never a wrapper-on-wrapper. The binding
 * also keeps each invocation at exactly one mark: a method's internal
 * `this.request` resolves against the raw target, not back through this
 * trap. The trap wraps any function-valued property read, inherited
 * Object.prototype members included — a destructure is safe (the wrapper
 * is already target-bound), but no op coerces the client (a `toString`
 * read would mark without a kernel call) or constructs through
 * client.constructor (escaping the trap entirely); one that ever did
 * would need the wrapping restricted to the client's own and prototype
 * methods.
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
			return (...args: unknown[]) => {
				mark();
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}
