/**
 * Whether this process serves other people over HTTP, rather than one person on their own
 * machine over stdio. It decides what a caller may reach: `localhost` as a chain, a tracing
 * node on loopback, a browser to open. Every module that guards one of those reads it here.
 *
 * An environment variable rather than an argument, because the chain list is baked into the
 * tool schemas as they are defined — so the answer has to exist before this package is
 * imported, not when a server is started. The CLI sets MCP_HTTP_PORT; a host assembling its
 * own server sets MCP_HOSTED=1, and startHttpServer refuses to run without one of them.
 */
export const HOSTED = Boolean(process.env.MCP_HTTP_PORT || process.env.MCP_HOSTED)
