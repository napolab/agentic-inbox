import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Claude Code reads skills from .claude/skills, Codex from .agents/skills.
// A skill published to Codex is a copy of the Claude Code one; this keeps the
// two from drifting. Edit the .claude/skills copy, then copy it over.
const CLAUDE_SKILLS = ".claude/skills";
const CODEX_SKILLS = ".agents/skills";

const readSkill = (root: string, name: string): string =>
	readFileSync(join(root, name, "SKILL.md"), "utf8").replaceAll("\r\n", "\n");

const codexSkillNames = (): string[] =>
	readdirSync(CODEX_SKILLS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

test("Codex publishes at least one skill", () => {
	assert.ok(codexSkillNames().length > 0, `${CODEX_SKILLS} has no skills`);
});

test("every Codex skill is an exact copy of its Claude Code counterpart", () => {
	for (const name of codexSkillNames()) {
		assert.equal(
			readSkill(CODEX_SKILLS, name),
			readSkill(CLAUDE_SKILLS, name),
			`${CODEX_SKILLS}/${name}/SKILL.md differs from ${CLAUDE_SKILLS}/${name}/SKILL.md`,
		);
	}
});
