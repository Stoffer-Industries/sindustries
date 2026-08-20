import { mcpUrl } from '../lib/mcpConfig.js';

// Claude's `modal=add-custom-connector` deep link was added in
// anthropics/claude-ai-mcp#74 (closed completed 2026-05-13). Per the
// maintainer (@localden) comment on that issue, the actual implemented
// contract is:
//   https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=<name>&connectorUrl=<url>
// i.e. the path is `/customize/connectors` (not `/settings/connectors`)
// and the query params are `connectorName` / `connectorUrl` (not the
// originally-proposed `mcpName` / `mcpServerUrl`). With these params the
// Add Custom Connector modal opens with the Name and Remote MCP server
// URL fields pre-filled; claude.ai shows a notice asking the user to
// verify the URL before proceeding. `connectorUrl` is URL-encoded so
// colons and slashes survive the query string and Claude's parser
// decodes them back to a full URL.
function buildClaudeHref(mcpEndpoint) {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'GymTrack',
    connectorUrl: mcpEndpoint
  });
  return `https://claude.ai/customize/connectors?${params.toString()}`;
}

export const AGENT_CONNECT_OPTIONS = [
  {
    id: 'claude',
    name: 'Claude',
    clientId: 'claude-desktop',
    buildHref: buildClaudeHref,
    instructions:
      'Claude will open the Add Custom Connector modal with the GymTrack MCP URL pre-filled. In Advanced settings enter OAuth client ID claude-desktop (no secret — public PKCE client), then approve GymTrack access.'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    clientId: 'chatgpt',
    // The previous `/admin/ca` path is an admin console route that 404s to
    // the ChatGPT home page for a normal/plus account. The user-level
    // custom-connector flow lives under Settings → Connectors.
    href: 'https://chatgpt.com/settings/connectors',
    instructions:
      'In ChatGPT, open Settings → Connectors → Add custom connector, paste the MCP URL above, set OAuth client ID to chatgpt (no secret), then complete the GymTrack consent prompt. Custom MCP apps require a supported plan and developer-mode access.'
  }
];

/**
 * Agent clients must create the OAuth state and PKCE challenge themselves.
 * Linking to their real connector screens lets them do that safely; GymTrack
 * cannot manufacture a valid provider authorization request in the SPA.
 */
export default function ConnectAgentCta() {
  const endpoint = mcpUrl('/mcp');

  return (
    <section className="connect-agent-cta" data-testid="connect-agent-cta">
      <p className="connect-agent-eyebrow">AI workout planning</p>
      <h2>Connect to your agent</h2>
      <p className="connect-agent-copy">
        Add GymTrack as an MCP connector. Your agent will open GymTrack’s secure
        authorization screen before it can read history or plan workouts.
      </p>

      <div className="connect-agent-endpoint">
        <span>MCP server</span>
        <code data-testid="connect-agent-mcp-url">{endpoint}</code>
      </div>

      <div className="connect-agent-options">
        {AGENT_CONNECT_OPTIONS.map((option) => {
          // Each option either declares a static `href` or a `buildHref(mcpEndpoint)`
          // builder. The Claude entry uses the builder because its deep link
          // needs the live MCP URL encoded into a query parameter; ChatGPT
          // links to a static page.
          const href = option.buildHref
            ? option.buildHref(endpoint)
            : option.href;
          return (
            <article className="connect-agent-option" key={option.id}>
              <h3>{option.name}</h3>
              <p>{option.instructions}</p>
              <p className="connect-agent-client-id">
                OAuth client ID: <code>{option.clientId}</code>
              </p>
              <a
                className="btn-primary connect-agent-link"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`connect-${option.id}`}
              >
                Connect {option.name}
              </a>
            </article>
          );
        })}
      </div>

      <p className="connect-agent-footnote">
        ChatGPT custom MCP apps currently require a supported plan and developer-mode access.
      </p>
    </section>
  );
}
