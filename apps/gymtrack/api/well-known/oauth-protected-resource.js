// apps/gymtrack/api/well-known/oauth-protected-resource.js
//
// Vercel serverless handler for GET /.well-known/oauth-protected-resource.
//
// Implements RFC 9728 OAuth 2.0 Protected Resource Metadata. MCP clients
// fetch this document to learn which authorization server protects the
// MCP server, what scopes are required, and what bearer-token scheme is
// accepted on the resource endpoint.
//
// Per MCP spec §"Authorization" (2025-06-18), the resource is the MCP
// server (POST /api/mcp). The auth server is identified by the
// authorization_servers array, which must match the issuer in the
// authorization-server metadata document.
//
// The bearer_methods_supported field documents that we accept RFC 6750
// bearer tokens in the Authorization header. We do not support
// request-body or query-string tokens because they leak into access logs.

export default function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const proto = (req.headers['x-forwarded-proto'] ?? 'https').toString().split(',')[0];
  const host = req.headers.host ?? 'gymtrack.local';
  const issuer = `${proto}://${host}`;

  const metadata = {
    resource: `${issuer}/api/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [
      'workouts:read',
      'workouts:write',
      'exercises:read'
    ]
  };

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json(metadata);
}
