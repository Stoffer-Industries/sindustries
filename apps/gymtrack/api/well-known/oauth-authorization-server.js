// apps/gymtrack/api/well-known/oauth-authorization-server.js
//
// Vercel serverless handler for GET /.well-known/oauth-authorization-server.
//
// Implements RFC 8414 OAuth 2.0 Authorization Server Metadata. MCP clients
// (Claude, ChatGPT, and any compliant implementation) fetch this document
// at discovery time to learn the authorization-endpoint, token-endpoint,
// supported grant_types, supported PKCE methods, scopes, etc.
//
// Per MCP spec §"Authorization" (2025-06-18), the discovery URL must be at
// the path /.well-known/oauth-authorization-server. Per RFC 8414 §3, the
// document is application/json.
//
// All endpoints listed here are scoped to the MCP surface. The legacy
// /api/agent/* REST endpoints are intentionally excluded — they use a
// different auth model (static API keys) and are not discoverable through
// OAuth metadata.

const MCP_SCOPES = [
  'workouts:read',
  'workouts:write',
  'exercises:read'
];

export default function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Build the issuer from the request host so the same code works in
  // preview deployments, staging, and production without rebuilding.
  const proto = (req.headers['x-forwarded-proto'] ?? 'https').toString().split(',')[0];
  const host = req.headers.host ?? 'gymtrack.local';
  const issuer = `${proto}://${host}`;

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    // signin_endpoint is non-standard; we expose it so the /agent-consent
    // React page can locate it without hardcoding the path.
    signin_endpoint: `${issuer}/api/oauth/signin`,

    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients only; PKCE does the auth.

    scopes_supported: MCP_SCOPES,

    // Per MCP spec §"Authorization", the protected resource is the MCP
    // server itself. We expose the resource metadata URL so clients can
    // fetch /.well-known/oauth-protected-resource if they need to.
    protected_resource_metadata_url: `${issuer}/.well-known/oauth-protected-resource`
  };

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json(metadata);
}
