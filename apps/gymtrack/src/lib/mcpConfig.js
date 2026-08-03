export function mcpBaseUrl() {
  return import.meta.env.VITE_GYMTRACK_MCP_BASE_URL ?? window.location.origin;
}

export function mcpUrl(path) {
  return new URL(path, mcpBaseUrl()).toString();
}
