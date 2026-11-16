import type { Importance, Triage } from "./triage";
import type { NewEmailPayload } from "./types";
import { mailboxURL, truncate } from "./format";

/**
 * Left-hand accent bar of the embed, keyed by how much the mail asks of the
 * reader. Adding an `Importance` level breaks this map at compile time.
 */
const IMPORTANCE_COLOR = {
	high: 0xe74c3c,
	normal: 0x5865f2,
	low: 0x99aab5,
} satisfies Record<Importance, number>;

/** No triage means "unknown", which must not be styled as unimportant. */
const NEUTRAL_COLOR = IMPORTANCE_COLOR.normal;

export type DiscordEmbedField = {
	readonly name: string;
	readonly value: string;
	readonly inline?: boolean;
};

export type DiscordEmbed = {
	readonly title?: string;
	readonly description?: string;
	readonly url?: string;
	readonly color?: number;
	readonly timestamp?: string;
	readonly fields?: readonly DiscordEmbedField[];
	readonly footer?: { readonly text: string };
};

export type DiscordWebhookMessage = {
	readonly content?: string;
	readonly embeds?: readonly DiscordEmbed[];
};

/**
 * Per-field character limits from the Discord message docs. Exceeding any of
 * them fails the whole webhook POST with 400, so every user-supplied string is
 * clamped before it goes into an embed.
 * https://docs.discord.com/developers/resources/message
 */
const LIMIT = { title: 256, description: 4096, fieldValue: 1024 } as const;

/**
 * `triage` is what the AI made of the mail; the subject, sender and link are
 * always the real values, so a summary steered by a malicious sender can never
 * misrepresent who wrote in or what the mail is called.
 */
export const buildDiscordMessage = (
	payload: NewEmailPayload,
	triage: Triage | null = null,
): DiscordWebhookMessage => {
	return {
		embeds: [
			{
				title: truncate(payload.subject || "(件名なし)", LIMIT.title),
				url: mailboxURL(payload.mailboxId),
				color: triage ? IMPORTANCE_COLOR[triage.importance] : NEUTRAL_COLOR,
				description: truncate(triage?.summary ?? payload.snippet, LIMIT.description),
				timestamp: payload.receivedAt,
				fields: [
					{ name: "From", value: truncate(payload.sender, LIMIT.fieldValue), inline: true },
					{ name: "To", value: truncate(payload.mailboxId, LIMIT.fieldValue), inline: true },
				],
			},
		],
	};
};
