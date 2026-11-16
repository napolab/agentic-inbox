import { test } from "node:test";
import assert from "node:assert/strict";
import { err, ok } from "neverthrow";

import { createRunner, type Plugin } from "./processor";

const handles = (prefix: string, output: string): Plugin<string, string> => ({
	run: (input) => (input.startsWith(prefix) ? ok(output) : err(input)),
});

test("createRunner returns the output of the first matching plugin", () => {
	const run = createRunner([handles("a", "A"), handles("b", "B")]);
	assert.deepEqual(run("b-1")._unsafeUnwrap(), "B");
});

test("createRunner lets an earlier plugin shadow a later one that also matches", () => {
	const run = createRunner([handles("edit.", "edit"), handles("edit.image.", "image")]);
	assert.equal(run("edit.image.crop")._unsafeUnwrap(), "edit");
});

test("createRunner returns err(input) when no plugin matches", () => {
	const run = createRunner([handles("a", "A")]);
	assert.equal(run("z")._unsafeUnwrapErr(), "z");
});

test("createRunner with no plugins returns err(input)", () => {
	const run = createRunner<string, string>([]);
	assert.equal(run("anything")._unsafeUnwrapErr(), "anything");
});
