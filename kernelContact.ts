/**
 * The tracked-client proxy the gate wraps every op's client in. Any
 * method invocation marks kernel contact, and contact alone drives the
 * breaker's reset-on-success — which counts only authenticated calls.
 * Load-bearing assumptions: every public client method is an
 * authenticated route (pinned by the layer-1 surface census — a new
 * method needs a conscious auth-posture check), and an op reaches the
 * kernel only through the clients the gate passed it — an op-internal
 * refusal that invokes no method (shape, missing docId, drift) stays
 * unmarked. The probe runs on the raw client the gate hands the op
 * alongside the tracked one, declared as the narrow probe type, so a
 * real call through it fails typecheck.
 * Property reads (baseUrl) pass through; every method access returns a
 * fresh target-bound wrapper — never a wrapper-on-wrapper — whose
 * internal `this.request` resolves against the raw target, keeping each
 * invocation at exactly one mark. Any function-valued property read is
 * wrapped, inherited Object.prototype members included: a destructure is
 * safe (the wrapper is already target-bound), but no op coerces the
 * client (a `toString` read would mark without a kernel call) or
 * constructs through client.constructor (escaping the trap entirely).
 * One tracked client per gated call, so concurrent ops share no flag.
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
