// Node module resolve hook: redirect `agents/mcp` to the local stub.
export async function resolve(specifier, context, next) {
	if (specifier === "agents/mcp") {
		return { url: new URL("./agents-mcp-stub.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
