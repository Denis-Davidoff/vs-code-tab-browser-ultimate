/**
 * Whether an agent's error text is a credential failure. A leaf with no `vscode`
 * import: the host decides with it which agent needs signing in, and the chat view
 * (a separate bundle) decides with the same rule which error rows get a sign-in button.
 */
/** Only credential failures, not rate limits, network failures or filesystem permissions. */
export function isAgentAuthenticationError(text: string): boolean {
	return /(?:OAuth.{0,80}(?:expired|refresh|revoked)|(?:refresh|access|authentication|auth) token.{0,80}(?:expired|invalid|revoked|already used|could not be refreshed)|(?:failed|unable) to authenticate|authentication[ _](?:required|failed|error)|not (?:logged|signed) in|please (?:log|sign) in|invalid[ _](?:api[_ -]?key|authentication credentials|grant)|\bunauthorized\b|(?:HTTP|status(?: code)?)\s*:?\s*401\b)/i.test(text);
}
