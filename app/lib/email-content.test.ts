import { test } from "node:test";
import assert from "node:assert/strict";

import { plainTextToHtml } from "./email-content";

test("plainTextToHtml: preserves newlines via pre-wrap wrapper", () => {
	const html = plainTextToHtml("line one\nline two");
	assert.ok(html.includes("white-space:pre-wrap"));
	assert.ok(html.includes("line one\nline two"));
});

test("plainTextToHtml: escapes angle-bracket content so it is not eaten as tags", () => {
	const html = plainTextToHtml("Contact John <john@example.com>");
	assert.ok(html.includes("&lt;john@example.com&gt;"));
	assert.ok(!html.includes("<john@example.com>"));
});

test("plainTextToHtml: turns bare URLs into safe anchor tags", () => {
	const html = plainTextToHtml("Visit https://example.com/download now");
	assert.ok(
		html.includes(
			'<a href="https://example.com/download" target="_blank" rel="noopener noreferrer">https://example.com/download</a>',
		),
	);
});

test("plainTextToHtml: linkifies URL inside angle brackets, keeping brackets as text", () => {
	const html = plainTextToHtml("Download: <https://example.com/dl>");
	assert.ok(html.includes("&lt;<a href=\"https://example.com/dl\""));
	assert.ok(html.includes("</a>&gt;"));
});

test("plainTextToHtml: excludes trailing punctuation from the link", () => {
	const html = plainTextToHtml("See https://example.com/page. Thanks");
	assert.ok(html.includes('href="https://example.com/page"'));
	assert.ok(html.includes("</a>. Thanks"));
});

test("plainTextToHtml: keeps balanced parentheses inside the link", () => {
	const html = plainTextToHtml(
		"See https://en.wikipedia.org/wiki/Foo_(bar) for details",
	);
	assert.ok(html.includes('href="https://en.wikipedia.org/wiki/Foo_(bar)"'));
	assert.ok(html.includes(">https://en.wikipedia.org/wiki/Foo_(bar)</a>"));
});

test("plainTextToHtml: trims an unbalanced closing paren and trailing period", () => {
	const html = plainTextToHtml("See https://example.com/page). Thanks");
	assert.ok(html.includes('href="https://example.com/page"'));
	assert.ok(html.includes("</a>). Thanks"));
});

test("plainTextToHtml: does not absorb surrounding quote characters", () => {
	const html = plainTextToHtml('Run curl "https://api.example.com/data" now');
	assert.ok(html.includes('href="https://api.example.com/data"'));
	assert.ok(html.includes("</a>&quot; now"));
});

test("plainTextToHtml: does not absorb surrounding single quotes", () => {
	const html = plainTextToHtml("Run curl 'https://api.example.com/data' now");
	assert.ok(html.includes('href="https://api.example.com/data"'));
	assert.ok(html.includes("</a>&#39; now"));
});

test("plainTextToHtml: does not linkify non-http schemes", () => {
	const html = plainTextToHtml("run javascript:alert(1) and ftp://host/file");
	assert.ok(!html.includes("<a "));
});

test("plainTextToHtml: escapes ampersands and quotes", () => {
	const html = plainTextToHtml(`Tom & Jerry say "hi" & 'bye'`);
	assert.ok(html.includes("Tom &amp; Jerry"));
	assert.ok(html.includes("&quot;hi&quot;"));
	assert.ok(html.includes("&#39;bye&#39;"));
});
