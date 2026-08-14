import { adminClient, parseBearerToken, rejectIfWrongMethod } from '../../server/oauthAuth.js';

export default async function handler(req, res) {
  if (rejectIfWrongMethod(req, res, ['POST'])) return;

  const accessToken = parseBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_session', message: 'Missing user session.' });
  }

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const consentId = body?.consentId;
  if (!consentId) {
    return res.status(400).json({ error: 'invalid_request', message: 'consentId is required.' });
  }

  const client = adminClient();
  const { data: authData, error: authError } = await client.auth.getUser(accessToken);
  if (authError || !authData?.user) {
    return res.status(401).json({ error: 'invalid_session', message: 'User session is not valid.' });
  }

  const { data: consent, error: consentError } = await client
    .from('gymtrack_oauth_consents')
    .select('id, user_id')
    .eq('id', consentId)
    .maybeSingle();

  if (consentError) {
    return res.status(500).json({ error: 'server_error', message: consentError.message });
  }

  if (!consent || consent.user_id !== authData.user.id) {
    return res.status(404).json({ error: 'not_found', message: 'Connected agent not found.' });
  }

  const revokedAt = new Date().toISOString();
  const [consentResult, tokenResult, codeResult] = await Promise.all([
    client
      .from('gymtrack_oauth_consents')
      .update({ revoked_at: revokedAt })
      .eq('id', consentId)
      .is('revoked_at', null),
    client
      .from('gymtrack_oauth_tokens')
      .update({ revoked_at: revokedAt, revocation_reason: 'user_revoked' })
      .eq('consent_id', consentId)
      .is('revoked_at', null),
    client
      .from('gymtrack_oauth_authorization_codes')
      .update({ revoked_at: revokedAt })
      .eq('consent_id', consentId)
      .is('revoked_at', null)
  ]);

  const failed = consentResult.error ?? tokenResult.error ?? codeResult.error;
  if (failed) {
    return res.status(500).json({ error: 'server_error', message: failed.message });
  }

  return res.status(200).json({ ok: true });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
