import { test } from "node:test";
import assert from "node:assert/strict";

import { triageEmail } from "./triage";
import type { NewEmailPayload } from "./types";

const payload = (overrides: Partial<NewEmailPayload> = {}): NewEmailPayload => ({
	mailboxId: "alerts@own.example",
	emailId: "11111111-2222-3333-4444-555555555555",
	sender: "billing@example.com",
	subject: "請求書のご送付",
	snippet: "お世話になっております。今月分の請求書を添付いたします。8月25日までにお振込ください。",
	receivedAt: "2026-08-17T11:00:00.000Z",
	...overrides,
});

const aiReturning = (value: unknown) => ({
	calls: [] as { model: string; input: Record<string, unknown> }[],
	run(model: string, input: Record<string, unknown>) {
		this.calls.push({ model, input });
		if (value instanceof Error) return Promise.reject(value);
		return Promise.resolve(value);
	},
});

test("triageEmail returns the summary and importance the model produced", async () => {
	const ai = aiReturning({ response: { summary: "8/25 が期限の請求書", importance: "high" } });

	assert.deepEqual(await triageEmail(ai, payload()), {
		summary: "8/25 が期限の請求書",
		importance: "high",
	});
});

test("triageEmail accepts a response delivered as a JSON string", async () => {
	// JSON mode returns the object on some models and a serialized string on
	// others, so both shapes have to be handled.
	const ai = aiReturning({ response: '{"summary":"請求書の連絡","importance":"normal"}' });

	assert.deepEqual(await triageEmail(ai, payload()), {
		summary: "請求書の連絡",
		importance: "normal",
	});
});

test("triageEmail returns null when the model call fails", async (t) => {
	// Workers AI answers "JSON Mode couldn't be met" as an error; the
	// notification must still go out, just without the summary. The failure is
	// logged, so the log is silenced here to keep the test output clean.
	t.mock.method(console, "error", () => {});
	const ai = aiReturning(new Error("JSON Mode couldn't be met"));

	assert.equal(await triageEmail(ai, payload()), null);
});

test("triageEmail returns null when the response is not valid JSON", async () => {
	const ai = aiReturning({ response: "Sure! Here is the summary you asked for." });

	assert.equal(await triageEmail(ai, payload()), null);
});

test("triageEmail returns null when importance is outside the allowed set", async () => {
	const ai = aiReturning({ response: { summary: "なにか", importance: "URGENT!!" } });

	assert.equal(await triageEmail(ai, payload()), null);
});

test("triageEmail skips the model entirely for an empty body", async () => {
	// Attachment-only mail has no text to summarize; calling the model would
	// bill us for a hallucinated summary.
	const ai = aiReturning({ response: { summary: "x", importance: "low" } });

	assert.equal(await triageEmail(ai, payload({ snippet: "   " })), null);
	assert.equal(ai.calls.length, 0);
});

test("triageEmail asks the model about the actual email, not just the subject", async () => {
	const ai = aiReturning({ response: { summary: "s", importance: "low" } });

	await triageEmail(ai, payload());
	const serialized = JSON.stringify(ai.calls[0].input);

	assert.ok(serialized.includes("8月25日までにお振込ください"), "body was not sent");
	assert.ok(serialized.includes("請求書のご送付"), "subject was not sent");
});
