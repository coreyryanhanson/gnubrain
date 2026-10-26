// The trackKernel trap, falsified directly: unconditional contact marking
// (the probe runs on the raw client, so the trap is exception-free),
// passthrough of non-function properties, the no-wrapper-on-wrapper
// property, and the constructor-escape caveat the doc comment names. The
// end-to-end structural-contact policy (a probe marks nothing, a real
// call resets the breaker once) stays pinned in gate.test.ts.

import { describe, expect, it } from "vitest";
import { trackKernel } from "../../kernelContact.js";

/** Prototype-shaped client stub: the same shape the layer-1 client
 * exposes (methods on the prototype, getVersion among them, plus a data
 * property), so inherited members are exercised through the trap. */
class ProbeShapeKernel {
	baseUrl = "http://kernel";
	request(_path: string, _init?: unknown): Promise<unknown> {
		return Promise.resolve({});
	}
	getVersion(): Promise<{ display_version: string }> {
		return Promise.resolve({ display_version: "3.8.8" });
	}
}

function tracked() {
	let marks = 0;
	const kernel = new ProbeShapeKernel();
	const wrapped = trackKernel(kernel, () => {
		marks += 1;
	});
	return { wrapped, kernel, marks: () => marks };
}

describe("trackKernel — structural contact trap", () => {
	it("an authenticated method call marks contact exactly once", async () => {
		const t = tracked();
		await t.wrapped.request("/api/notebook", {});
		expect(t.marks()).toBe(1);
	});

	it("every function-valued invocation marks contact exactly once — getVersion included", async () => {
		// The trap is exception-free: the version probe runs on the raw
		// client the gate hands the op alongside the tracked one, so no
		// method name is exempt here.
		const t = tracked();
		const version = await t.wrapped.getVersion();
		expect(version.display_version).toBe("3.8.8");
		expect(t.marks()).toBe(1);
	});

	it("the target-bound binding keeps an internal this.request from re-entering the trap — one invocation, one mark", async () => {
		// A method invoked through the trap runs with `this` on the raw
		// target, so its internal this.request resolves against the
		// un-proxied client instead of marking again.
		let marks = 0;
		class SelfRouting extends ProbeShapeKernel {
			override async getVersion() {
				await this.request("/api/version", {});
				return { display_version: "3.8.8" };
			}
		}
		const wrapped = trackKernel(new SelfRouting(), () => {
			marks += 1;
		});
		await wrapped.getVersion();
		expect(marks).toBe(1);
	});

	it("a getVersion running with `this` on the proxy would double-mark — the raw-target binding is what prevents it", async () => {
		// The failure mode the binding prevents, pinned by invoking such a
		// method with the proxy as receiver — exactly what an unbound
		// return would hand it: the internal request marks its own contact
		// through the trap.
		let marks = 0;
		class SelfRouting extends ProbeShapeKernel {
			override async getVersion() {
				await this.request("/api/version", {});
				return { display_version: "3.8.8" };
			}
		}
		const wrapped = trackKernel(new SelfRouting(), () => {
			marks += 1;
		});
		await SelfRouting.prototype.getVersion.apply(wrapped);
		expect(marks).toBe(1);
	});

	it("data properties pass through untouched without marking", () => {
		const t = tracked();
		expect(t.wrapped.baseUrl).toBe("http://kernel");
		expect(t.marks()).toBe(0);
	});

	it("method accesses return fresh target-bound wrappers — no wrapper-on-wrapper, `this` is the raw target", async () => {
		const t = tracked();
		const first = t.wrapped.request;
		const second = t.wrapped.request;
		expect(first).not.toBe(second);
		// Bound to the raw target: the method's receiver is the un-proxied
		// client — the method returns its own receiver, so the assertion
		// compares it against the raw instance directly.
		t.kernel.request = function (this: ProbeShapeKernel) {
			return Promise.resolve(this) as Promise<unknown>;
		};
		const receiver = await t.wrapped.request("/api/notebook", {});
		expect(receiver).toBe(t.kernel);
		expect(first).not.toBe(t.kernel.request);
	});

	it("inherited Object.prototype members wrap too — a destructure is safe, a coercion would mark", () => {
		const t = tracked();
		const { request } = t.wrapped; // destructure: safe, no call
		expect(typeof request).toBe("function");
		expect(t.marks()).toBe(0);
		const bound = (
			t.wrapped as unknown as { toString: () => string }
		).toString();
		expect(typeof bound).toBe("string");
		expect(t.marks()).toBe(1);
	});

	it("the constructor read wraps like any function-valued read — read marks nothing, and `new` through the wrapper is unusable (the documented escape-hazard)", () => {
		const t = tracked();
		const ctor = (t.wrapped as unknown as { constructor: unknown }).constructor;
		expect(typeof ctor).toBe("function");
		// Reading marks nothing; only an invocation would.
		expect(t.marks()).toBe(0);
		// The wrapper is an arrow, so a construct-through-the-trap attempt
		// fails loudly instead of silently escaping it.
		expect(() => new (ctor as unknown as new () => unknown)()).toThrow();
	});
});
