// Tests must never run as a deferring child: when the outer session (e.g. a
// pi subagent running `npm test`) carries PI_TOOLMASKING_DEFER, masking's
// defer gate no-ops every toggle and registration and dozens of tests fail.
// One test (the deferring-child case in index.test.ts) sets and restores
// the var itself; everything else inherits this deletion.
delete process.env.PI_TOOLMASKING_DEFER;
