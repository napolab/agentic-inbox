import { test } from "node:test";
import assert from "node:assert/strict";

import { isAutoDraftEnabled } from "./mailbox";

test("isAutoDraftEnabled is true only for autoDraft.enabled === true", () => {
	assert.equal(isAutoDraftEnabled({ autoDraft: { enabled: true } }), true);
});

test("isAutoDraftEnabled is false when absent, false, or malformed", () => {
	assert.equal(isAutoDraftEnabled(undefined), false);
	assert.equal(isAutoDraftEnabled(null), false);
	assert.equal(isAutoDraftEnabled("x"), false);
	assert.equal(isAutoDraftEnabled({}), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: null }), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: "on" }), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: {} }), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: { enabled: false } }), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: { enabled: "true" } }), false);
	assert.equal(isAutoDraftEnabled({ autoDraft: { enabled: 1 } }), false);
});
