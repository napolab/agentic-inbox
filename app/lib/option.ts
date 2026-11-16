/**
 * Minimal Option type — the discriminated-union stand-in for
 * neverthrow's Option, which this repo does not depend on.
 */
export type Option<T> = { type: "some"; value: T } | { type: "nothing" };

export function fromNullable<T>(value: T | null | undefined): Option<T> {
	if (value === null || value === undefined) return { type: "nothing" };
	return { type: "some", value };
}
