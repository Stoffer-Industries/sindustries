export const PRODUCTION_MCP_BASE_URL = 'https://gymtrack-mcp.fly.dev';

export function mcpBaseUrl({
  configuredBaseUrl = import.meta.env.VITE_GYMTRACK_MCP_BASE_URL,
  location = window.location
} = {}) {
  if (configuredBaseUrl) return configuredBaseUrl;

  // Keep local development zero-config while failing safe to the deployed MCP
  // service everywhere else. The production Vercel project should still set
  // VITE_GYMTRACK_MCP_BASE_URL explicitly; this fallback prevents consent POSTs
  // and CTA setup instructions from silently pointing at the SPA origin.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }

  return PRODUCTION_MCP_BASE_URL;
}

export function mcpUrl(path, options) {
  return new URL(path, mcpBaseUrl(options)).toString();
}
