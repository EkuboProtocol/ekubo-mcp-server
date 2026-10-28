export const MCP_SERVER_VERSION = "0.54.0";

// Change this whenever public MCP tool schemas or response contracts change.
// It is exposed in HTTP discovery and in the server instructions so clients
// and smoke tests can detect a cached catalog independently of the
// application version.
export const MCP_TOOL_CATALOG_REVISION = "2026-10-28.exact-output-loss-budget";
