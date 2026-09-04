import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Hosted OAuth callback page for GymTrack's MCP integration.
 *
 * When a user approves an OAuth flow on a device that can't reach the
 * connecting app's loopback listener (e.g. a phone with no port 8789 access),
 * the consent flow redirects the browser here with the authorization code
 * (or error) on the query string. The page renders a clear success / denial
 * / empty state so the user can copy the one-time code into the connecting
 * app, which then exchanges it at the MCP server's `/oauth/token` endpoint.
 *
 * The page is intentionally stateless — it does NOT call back to any server.
 * Cross-device copy-paste is the contract; validating `state` is the
 * connecting app's responsibility. Keeping the page stateless avoids any
 * cross-site token exchange and means the page works from any device.
 */
export default function AgentOAuthCallbackPage() {
  const [params] = useSearchParams();
  const [copied, setCopied] = useState(false);

  const code = params.get('code');
  const error = params.get('error');
  const errorDescription = params.get('error_description') ?? params.get('error');
  const state = params.get('state');

  const view = useMemo(() => {
    if (error) return { kind: 'denial' };
    if (code) return { kind: 'success' };
    return { kind: 'empty' };
  }, [code, error]);

  async function handleCopy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      // Reset the "Copied!" affordance after a short delay so a second click
      // re-triggers the feedback.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall back to the legacy execCommand path for browsers without async
      // clipboard permission. The textarea + removeChild dance keeps the
      // user-visible code element intact.
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Surface a soft failure in the UI rather than throwing — the user
        // can still read the code from the <output> element and copy it
        // manually.
        setCopied(false);
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }

  return (
    <main
      className="container agent-oauth-callback-screen"
      data-testid="agent-oauth-callback-screen"
    >
      <h1>Agent connection {view.kind === 'denial' ? 'denied' : 'complete'}</h1>

      {view.kind === 'success' ? (
        <section
          className="workout-card agent-oauth-callback-card"
          data-testid="agent-oauth-callback-success"
        >
          <h2>Your authorization code</h2>
          <p className="workout-card-meta">
            Paste this one-time code into {`the connecting app`} to finish setting up your
            GymTrack connection. The code expires shortly and is bound to the requesting app.
          </p>
          <output className="agent-oauth-callback-code" data-testid="agent-oauth-callback-code">
            {code}
          </output>
          <div className="btn-row">
            <button
              type="button"
              className="btn-primary"
              onClick={handleCopy}
              data-testid="agent-oauth-callback-copy"
            >
              {copied ? 'Copied!' : 'Copy code'}
            </button>
          </div>
          {state ? (
            <p className="workout-card-meta" data-testid="agent-oauth-callback-state">
              State: <code>{state}</code>
            </p>
          ) : null}
        </section>
      ) : null}

      {view.kind === 'denial' ? (
        <section
          className="workout-card agent-oauth-callback-card"
          data-testid="agent-oauth-callback-denial"
        >
          <h2>Connection cancelled</h2>
          <div className="status show error" role="alert">
            {errorDescription || 'You cancelled the authorization request.'}
          </div>
          <p className="workout-card-meta">
            The connecting app did not receive an authorization code. Reopen it and start the
            connection again if you want to try once more.
          </p>
        </section>
      ) : null}

      {view.kind === 'empty' ? (
        <section
          className="workout-card agent-oauth-callback-card"
          data-testid="agent-oauth-callback-empty"
        >
          <h2>No authorization code was returned</h2>
          <p className="workout-card-meta">
            This page is reached after a GymTrack OAuth flow finishes. If you got here without
            a code or error, the connecting app that sent you here did not finish its part of
            the handshake. Open it again and retry the connection.
          </p>
        </section>
      ) : null}
    </main>
  );
}
