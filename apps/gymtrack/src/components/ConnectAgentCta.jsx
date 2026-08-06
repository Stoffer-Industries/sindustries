import { mcpUrl } from '../lib/mcpConfig.js';

export const AGENT_CONNECT_OPTIONS = [
  {
    id: 'claude',
    name: 'Claude',
    clientId: 'claude-desktop',
    href: 'https://claude.ai/settings/connectors',
    instructions: 'Add a custom connector, then approve GymTrack access.'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    clientId: 'chatgpt',
    href: 'https://chatgpt.com/admin/ca',
    instructions: 'Create an MCP app, scan its tools, then approve GymTrack access.'
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
        {AGENT_CONNECT_OPTIONS.map((option) => (
          <article className="connect-agent-option" key={option.id}>
            <h3>{option.name}</h3>
            <p>{option.instructions}</p>
            <p className="connect-agent-client-id">
              OAuth client ID: <code>{option.clientId}</code>
            </p>
            <a
              className="btn-primary connect-agent-link"
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`connect-${option.id}`}
            >
              Connect {option.name}
            </a>
          </article>
        ))}
      </div>

      <p className="connect-agent-footnote">
        ChatGPT custom MCP apps currently require a supported plan and developer-mode access.
      </p>
    </section>
  );
}
