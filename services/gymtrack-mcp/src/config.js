export function loadConfig(env = process.env) {
  const issuer = env.GYMTRACK_MCP_ISSUER ?? `http://localhost:${env.GYMTRACK_MCP_PORT ?? '8787'}`;
  const appUrl = env.GYMTRACK_APP_URL ?? 'http://localhost:5173';
  const webOrigin = env.GYMTRACK_WEB_ORIGIN ?? new URL(appUrl).origin;

  return {
    port: Number(env.GYMTRACK_MCP_PORT ?? 8787),
    issuer,
    appUrl,
    webOrigin,
    accessTokenTtlSeconds: Number(env.GYMTRACK_MCP_ACCESS_TOKEN_TTL_SECONDS ?? 3600),
    refreshTokenTtlSeconds: Number(env.GYMTRACK_MCP_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 90),
    authorizationCodeTtlSeconds: Number(env.GYMTRACK_MCP_AUTH_CODE_TTL_SECONDS ?? 600),
    protectedResourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource`
  };
}
