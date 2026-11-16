import { err, type Result } from "neverthrow";

/** A plugin handles an input it recognises and returns `err(input)` otherwise. */
export type Plugin<I, O> = {
	run(input: I): Result<O, I>;
};

const runFirstMatch = <I, O>(input: I, plugins: readonly Plugin<I, O>[]): Result<O, I> => {
	const [head, ...tail] = plugins;
	if (head === undefined) return err(input);
	const result = head.run(input);
	if (result.isOk()) return result;
	return runFirstMatch(input, tail);
};

/** First match wins, so register the most specific plugin first. */
export const createRunner =
	<I, O>(plugins: readonly Plugin<I, O>[]) =>
	(input: I): Result<O, I> =>
		runFirstMatch(input, plugins);
