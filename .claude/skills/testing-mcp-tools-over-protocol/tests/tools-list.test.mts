// Smoke test: every tool registers and exposes a JSON Schema over tools/list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../harness/setup.mts";

const EXPECTED_TOOLS = [
	"list_mailboxes", "list_emails", "get_email", "get_thread", "search_emails",
	"draft_reply", "create_draft", "update_draft", "delete_email",
	"send_reply", "send_email", "mark_email_read", "move_email",
];

test("tools/list exposes every EmailMCP tool with an object input schema", async () => {
	const { client } = await setup();
	const { tools } = await client.listTools();
	const names = tools.map((t: any) => t.name);
	for (const name of EXPECTED_TOOLS) assert.ok(names.includes(name), `missing tool: ${name}`);
	for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
});

test("tools reject an unknown mailbox with a hint to list_mailboxes", async () => {
	const { call } = await setup();
	const res = await call("list_emails", { mailboxId: "nobody@example.com" });
	assert.equal(res.isError, true);
	assert.match(res.text, /list_mailboxes/);
});
