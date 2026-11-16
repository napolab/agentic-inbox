import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyDraft } from "./ai";

/** Fake Workers AI binding whose verifier model answers with `response`. */
const fakeAI = (response: string) =>
	({ run: async () => ({ response }) }) as unknown as Ai;

const REPLY = "Hey Alice!\nFriday afternoon works for me.\nWhat time were you thinking?";
const QUOTED =
	'<br><blockquote style="border-left: 2px solid #ccc">On Tue, alice@example.com wrote:<br>Coffee on Friday?</blockquote>';

test("verifyDraft keeps the original when the verifier prepends its own commentary", async () => {
	// Observed on 2026-09-29: Llama answered "No system artifacts found…" and
	// that sentence was saved as the first line of the auto-draft.
	const out = await verifyDraft(fakeAI(`No system artifacts found in the email.\n\n${REPLY}`), REPLY);
	assert.equal(out, REPLY);
});

test("verifyDraft keeps the original HTML body when the verifier adds text", async () => {
	const body = `<div style="white-space:pre-wrap">${REPLY.replaceAll("\n", "<br>")}</div>${QUOTED}`;
	const out = await verifyDraft(fakeAI(`Here is the cleaned version:\n${REPLY}`), body);
	assert.equal(out, body);
});

test("verifyDraft keeps the original when the verifier rewrites a line", async () => {
	const rewritten = REPLY.replace("Friday afternoon works for me.", "Friday afternoon is perfect.");
	assert.equal(await verifyDraft(fakeAI(rewritten), REPLY), REPLY);
});

test("verifyDraft applies a pure removal of an artifact line", async () => {
	const withArtifact = `${REPLY}\nDraft saved. The operator can review and send from the UI.`;
	assert.equal(await verifyDraft(fakeAI(REPLY), withArtifact), REPLY);
});

test("verifyDraft tolerates whitespace-only differences in kept lines", async () => {
	const withArtifact = `[Auto-triggered]\n${REPLY}`;
	const answer = REPLY.split("\n").map((line) => `  ${line}  `).join("\n\n");
	assert.equal(await verifyDraft(fakeAI(answer), withArtifact), answer.trim());
});
