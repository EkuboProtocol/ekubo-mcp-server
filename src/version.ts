export const MCP_SERVER_VERSION = "0.21.0";

// Change this whenever public MCP tool schemas or response contracts change.
// It is exposed in HTTP discovery and each MCP tool's metadata so clients and
// smoke tests can detect a cached catalog independently of the application
// version.
export const MCP_TOOL_CATALOG_REVISION =
  "2026-08-03.strict-quotes-batched-withdrawals";
