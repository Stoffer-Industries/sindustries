/**
 * redact-output.mjs — ONE redaction implementation for operator-visible
 * Fly output.
 *
 * WHY ONE MODULE
 * --------------
 * Two operator surfaces show text that `flyctl` produced:
 *
 *   - `infra/cloud/bin/status` — shows flyctl's stderr when `flyctl
 *     status` fails, so a TLS/credential/auth failure is distinguishable
 *     from a missing app.
 *   - `infra/cloud/platform/platform-provision-secrets.mjs` — echoes the
 *     flyctl child's stderr back to the operator.
 *
 * Both outputs end up pasted into task comments on a PUBLIC repo, so a
 * credential must never ride along with a diagnostic. Each surface used
 * to carry its own rules, and the two drifted: the provisioning script
 * masked URL/DSN credentials, JSON credential fields and `NAME=value`
 * assignments, while `bin/status` masked only `fly_`-prefixed tokens and
 * a keyword rule — so a `postgres://` DSN, a `{"token":"…"}` field or an
 * `Authorization: Bearer …` header printed by `bin/status` leaked. The
 * rules live here now so the two cannot drift apart again.
 *
 * WHAT IS MASKED
 * --------------
 *   - URL/DSN credentials:  postgres://user:***@host -> postgres://[redacted]@host
 *   - JSON credential fields: {"token":"…"}        -> {"token":"[redacted]"}
 *   - Authorization headers: Bearer / Basic
 *   - Fly's own auth header: FlyV1 <token>
 *   - Environment-style assignments: NAME=value    -> NAME=[redacted]
 *   - Credential keywords: token/password/secret/credential/api_key
 *   - Fly's own token form: fly_<token>
 *
 * The redaction is deliberately FAIL-CLOSED: when a shape is ambiguous it
 * masks the value and keeps the surrounding text, because a masked
 * diagnostic is recoverable and a leaked credential is not. The keyword
 * rule therefore masks the word that follows a credential keyword even
 * when that word is not really a secret ("token invalid" -> "token
 * [redacted] invalid"). Over-masking costs the operator a word;
 * under-masking costs them a credential.
 *
 * TRAILING PUNCTUATION
 * --------------------
 * The operator reads these lines to diagnose a TLS or auth failure, so
 * the mask must not swallow the characters that end the message:
 * `Error: failed (token=fly_ABCDEFGH1234)` prints as
 * `Error: failed (token=[redacted])` — the `)` survives.
 *
 * IDEMPOTENCE
 * -----------
 * Redacting already-redacted text changes nothing: a value that is
 * already the marker is not masked a second time, so the marker cannot
 * grow a stray bracket on every pass.
 *
 * CLI
 * ---
 * `node infra/cloud/platform/redact-output.mjs` reads stdin and writes
 * the redacted text to stdout, so the shell surface (`bin/status`) and
 * the Node surface (the provisioning script) share these rules. In CLI
 * mode the output is also flattened to a single line and capped, because
 * it is operator-facing diagnostic text.
 */

import { pathToFileURL } from 'node:url';

/** The marker that stands in for a redacted value. */
export const REDACTED = '[redacted]';

/** The default cap on operator-facing diagnostic text. */
export const OPERATOR_TEXT_LIMIT = 400;

/**
 * A value ends at whitespace or at one of the delimiters that surround it
 * in a diagnostic line.
 */
const VALUE_STOP = String.raw`[^\s,;)\]}"']`;

/**
 * The same, for the LAST character of a value: a trailing `.` or `,`
 * belongs to the sentence, not to the secret, so it is kept outside the
 * mask. The first character class above still allows `.` and `,`
 * INSIDE a value, so a secret such as `sk_live.abc` is masked whole.
 */
const VALUE_LAST = String.raw`[^\s,;)\]}"'.,:;!?]`;

/**
 * A value that is already the marker must not be masked again.
 */
const NOT_ALREADY_REDACTED = '(?!\\[redacted\\])';

const URL_CREDENTIALS_RE = new RegExp(
  String.raw`([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@`,
  'gi'
);

const JSON_CREDENTIAL_FIELD_RE = new RegExp(
  String.raw`("(?:token|password|secret|dsn|value|credential|api[_-]?key)"\s*:\s*")[^"]*(")`,
  'gi'
);

const AUTHORIZATION_HEADER_RE = new RegExp(
  String.raw`(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)`
  + NOT_ALREADY_REDACTED
  + String.raw`([^\s"',;)\]}]+)([)\]}]*)`,
  'gi'
);

const FLY_V1_HEADER_RE = new RegExp(
  String.raw`(\bFlyV1\s+)`
  + NOT_ALREADY_REDACTED
  + String.raw`([^\s"',;)\]}]+)([)\]}]*)`,
  'gi'
);

const ENV_ASSIGNMENT_RE = new RegExp(
  String.raw`\b([A-Z][A-Z0-9_]{2,})=`
  + NOT_ALREADY_REDACTED
  + `(${VALUE_STOP}*${VALUE_LAST})`
  + String.raw`([.,:;!?)\]}]*)`,
  'g'
);

const CREDENTIAL_KEYWORD_RE = new RegExp(
  String.raw`\b(token|password|secret|credential|api[_-]?key)`
  + String.raw`(\s*[:=]\s*|\s+)`
  + NOT_ALREADY_REDACTED
  + `(${VALUE_STOP}*${VALUE_LAST})`
  + String.raw`([.,:;!?)\]}]*)`,
  'gi'
);

// Fly's own token form: `fly_<token>`. The rule is CASE-SENSITIVE on
// purpose: an uppercase `FLY_API_TOKEN` is an environment-variable NAME,
// not a token, and masking the name would leave the value it introduces
// exposed. The assignment rule above already masks that name/value pair
// as a whole.
const FLY_TOKEN_RE = /\bfly_[A-Za-z0-9+/_=-]{4,}/g;

/**
 * Mask credential-shaped values before output is shown to an operator.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactOutput(text) {
  if (typeof text !== 'string' || text === '') return '';
  return (
    text
      // URL credentials: postgres://user:***@host -> postgres://[redacted]@host
      .replace(URL_CREDENTIALS_RE, `$1${REDACTED}@`)
      // JSON credential fields: {"token":"…"} -> {"token":"[redacted]"}
      .replace(JSON_CREDENTIAL_FIELD_RE, `$1${REDACTED}$2`)
      // Authorization headers: "Authorization: Bearer <token>" and the
      // "Basic" form. Closing punctuation stays outside the masked value.
      .replace(AUTHORIZATION_HEADER_RE, `$1${REDACTED}$3`)
      // Fly's own authorization header form: "FlyV1 <token>".
      .replace(FLY_V1_HEADER_RE, `$1${REDACTED}$3`)
      // Environment-style assignments: NAME=value -> NAME=[redacted].
      .replace(ENV_ASSIGNMENT_RE, `$1=${REDACTED}$3`)
      // Credential keywords in both the "key=value" and the "key value"
      // forms: token=…, token …, password=…, secret …, credential …,
      // api_key=… / api-key=…
      .replace(CREDENTIAL_KEYWORD_RE, `$1$2${REDACTED}$4`)
      // Fly's token form: fly_<token>.
      .replace(FLY_TOKEN_RE, REDACTED)
  );
}

/**
 * Redact, then flatten to a single line and cap the length.
 *
 * This is the shape an operator reads in a terminal and pastes into a
 * task comment: one line, no credentials, bounded length. The cap is
 * applied AFTER redaction, so a truncation can never expose a secret
 * that was already masked.
 *
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
export function operatorText(text, maxLength = OPERATOR_TEXT_LIMIT) {
  const flattened = redactOutput(text).replace(/\s+/g, ' ').trim();
  return flattened.length > maxLength ? flattened.slice(0, maxLength) : flattened;
}

// CLI mode: stdin -> stdout, operator shape.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(operatorText(input));
}
