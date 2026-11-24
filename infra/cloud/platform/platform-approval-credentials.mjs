/**
 * platform-approval-credentials.mjs — the merge semantics for the
 * platform's approval credentials (task 3c004590).
 *
 * WHY THIS EXISTS
 * ---------------
 * The platform provisioner used to build ONE approval credential per
 * service — the platform's own validation actor — and write it to Fly
 * with `flyctl secrets set`, which REPLACES the live secret outright.
 * Because the platform deploy workflow runs on every merge to `main`,
 * every routine merge silently reset the live credential set to a single
 * actor, and every agent write on production then failed with
 * `401 AUTH_REQUIRED`. Reads kept working (they are unauthenticated by
 * design), so the break was invisible until an agent tried to write.
 *
 * The fix is a MERGE, and a merge needs a contract: which actors MUST be
 * present, which approval types each of them may carry, and where the
 * token values come from. That contract lives in
 * `platform-environments.mjs` (`approvalCredentials`); this module owns
 * the mechanics that apply it:
 *
 *   - `parseApprovalCredentialArray()` — parse and shape-check an
 *     operator credential array;
 *   - `assertApprovalCredentialContract()` — structural checks on the
 *     manifest contract itself (a programming error, caught when the
 *     manifest is loaded);
 *   - `buildMergedApprovalCredentials()` — the merge: platform actor plus
 *     the exact operator set, validated, in manifest order.
 *
 * THE RULES, AND WHY EACH ONE
 * ----------------------------
 *   - The operator set must be EXACTLY the manifest's set. A missing
 *     actor is the drift this task exists to catch; an EXTRA actor is an
 *     undeclared writer, which is worse than a missing one, because it
 *     grants access nobody reviewed.
 *   - Each actor's `approvalTypes` must EQUAL the manifest's declared
 *     types. The merge never unions grants: an operator array that
 *     widens `Quinn` to `qa_agent` would otherwise be accepted silently.
 *   - Tokens are unique across the merged array, including against the
 *     platform token. One token shared by two actors would make the
 *     actor attribution — and the audit trail behind it — meaningless.
 *   - The output is serialized in MANIFEST order with a fixed key order,
 *     so applying the same inputs twice produces byte-identical bytes.
 *     That is what makes a repeated deployment idempotent.
 *
 * Every failure is a loud one, thrown BEFORE any Fly mutation: the
 * provisioner calls this module during payload construction, so a bad
 * input never reaches `flyctl secrets set`.
 *
 * NO VALUE EVER APPEARS IN A MESSAGE. These errors name the source, the
 * actor and the count — never a token, and never the raw array.
 */

/**
 * The shortest token the services accept.
 *
 * Both services reject a credential whose token is shorter than this at
 * boot (`token.length < 16`), so a shorter value would register fine and
 * crash the service on the next deploy. The provisioner refuses it here
 * instead, where the failure is still attached to the input.
 */
export const APPROVAL_CREDENTIAL_MIN_TOKEN_LENGTH = 16;

/**
 * The approval types a Tasks API credential may declare.
 *
 * `services/tasks-api/src/middleware/approvalAuth.ts` parses the
 * credential array at module load and refuses any entry whose
 * `approvalTypes` fall outside this set — an entry outside it does not
 * degrade, it CRASHES the service at boot. The manifest contract is
 * checked against this set so a typo in the contract cannot become a
 * boot-loop.
 */
export const TASKS_APPROVAL_TYPES = Object.freeze([
  'spec',
  'tech_design',
  'qa_agent',
  'accepted',
]);

/**
 * Parse an operator credential array into its entries.
 *
 * The shape is the shape the services parse: `[{token, actor,
 * approvalTypes}]`. This function checks the SHAPE only — that the value
 * is a non-empty JSON array whose entries carry a usable token, a
 * non-empty actor name and an array of approval-type strings. Whether
 * the actors are the RIGHT ones is decided by
 * `buildMergedApprovalCredentials()`, which knows the contract.
 *
 * @param {string} raw  the raw source value
 * @param {{source?: string}} [options]
 * @returns {{token: string, actor: string, approvalTypes: string[]}[]}
 */
export function parseApprovalCredentialArray(raw, options = {}) {
  const source = options.source ?? 'the approval credential source';
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `${source} is empty. The complete operator credential array is required — ` +
        'an empty array would register a credential set with no operator actors.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON array of {token, actor, approvalTypes} entries`);
  }
  if (parsed.length === 0) {
    throw new Error(
      `${source} is an empty array. The complete operator credential array is required — ` +
        'an empty array would register a credential set with no operator actors.',
    );
  }
  return parsed.map((entry, index) => {
    const item = entry ?? {};
    if (
      typeof item.token !== 'string' ||
      item.token.length < APPROVAL_CREDENTIAL_MIN_TOKEN_LENGTH
    ) {
      throw new Error(
        `${source}[${index}] has no usable token (at least ${APPROVAL_CREDENTIAL_MIN_TOKEN_LENGTH} characters are required)`,
      );
    }
    if (typeof item.actor !== 'string' || item.actor.trim() === '') {
      throw new Error(`${source}[${index}] has no actor name`);
    }
    if (
      !Array.isArray(item.approvalTypes) ||
      item.approvalTypes.some((type) => typeof type !== 'string' || type.trim() === '')
    ) {
      throw new Error(`${source}[${index}] has no approvalTypes array of non-empty strings`);
    }
    return {
      token: item.token,
      actor: item.actor,
      approvalTypes: [...item.approvalTypes],
    };
  });
}

/**
 * Structural checks on an `approvalCredentials` contract.
 *
 * These are programming errors, not runtime data errors: they catch a
 * manifest that was edited into a shape the provisioner cannot honour
 * (a duplicate actor, an empty operator list, one source used for two
 * different values). They are checked when the manifest is loaded, so a
 * bad contract fails before anything is deployed.
 *
 * @param {object} contract
 * @param {{label?: string, allowedApprovalTypes?: string[]}} [options]
 * @returns {object} the contract, unchanged
 */
export function assertApprovalCredentialContract(contract, options = {}) {
  const label = options.label ?? 'the approval credential contract';
  const allowedApprovalTypes = options.allowedApprovalTypes ?? null;
  const operatorRequired = contract.operatorCredentialsRequired !== false;

  if (!contract || typeof contract !== 'object') {
    throw new Error(`${label} is missing`);
  }
  for (const key of [
    'targetSecret',
    'apiBaseUrlKey',
    'platformTokenSource',
    'operatorCredentialsSource',
    'platformActor',
  ]) {
    if (typeof contract[key] !== 'string' || contract[key].trim() === '') {
      throw new Error(`${label} has no ${key}`);
    }
  }
  if (
    !Array.isArray(contract.platformApprovalTypes) ||
    contract.platformApprovalTypes.some((type) => typeof type !== 'string' || type.trim() === '')
  ) {
    throw new Error(`${label} has no platformApprovalTypes array of non-empty strings`);
  }
  if (!Array.isArray(contract.operatorActors) || contract.operatorActors.length === 0) {
    if (operatorRequired) {
      throw new Error(
        `${label} declares no operator actors. A service with no operator actors has no ` +
          'agent writers, which is the state this task exists to prevent.',
      );
    }
    // An environment with no operator writers may declare an empty
    // operator set — but only when it also says the operator source is
    // NOT required, so an empty set can never hide a missing array.
  }
  if (contract.platformTokenSource === contract.operatorCredentialsSource) {
    throw new Error(
      `${label} uses "${contract.platformTokenSource}" for both the platform token and the ` +
        'operator credential array — they are different values and need different sources',
    );
  }
  if (contract.targetSecret === contract.platformTokenSource) {
    throw new Error(
      `${label} registers its platform token directly into the target secret "${contract.targetSecret}"`,
    );
  }

  const seen = new Set();
  for (const entry of contract.operatorActors) {
    if (!entry || typeof entry.actor !== 'string' || entry.actor.trim() === '') {
      throw new Error(`${label} has an operator actor without an actor name`);
    }
    if (
      !Array.isArray(entry.approvalTypes) ||
      entry.approvalTypes.some((type) => typeof type !== 'string' || type.trim() === '')
    ) {
      throw new Error(
        `${label} actor "${entry.actor}" has no approvalTypes array of non-empty strings`,
      );
    }
    if (seen.has(entry.actor)) {
      throw new Error(`${label} declares the actor "${entry.actor}" more than once`);
    }
    if (entry.actor === contract.platformActor) {
      throw new Error(
        `${label} lists the platform actor "${contract.platformActor}" as an operator actor`,
      );
    }
    if (allowedApprovalTypes) {
      const unknown = entry.approvalTypes.filter((type) => !allowedApprovalTypes.includes(type));
      if (unknown.length > 0) {
        throw new Error(
          `${label} actor "${entry.actor}" declares approval type(s) the service does not ` +
            `accept: ${unknown.join(', ')} (accepted: ${allowedApprovalTypes.join(', ')})`,
        );
      }
    }
    seen.add(entry.actor);
  }
  return contract;
}

/**
 * The approval types a contract's actors may carry, for a service that
 * restricts them.
 *
 * @param {object} contract
 * @returns {string[]}
 */
export function contractApprovalTypes(contract) {
  return [
    ...(contract.platformApprovalTypes ?? []),
    ...(contract.operatorActors ?? []).flatMap((entry) => entry.approvalTypes ?? []),
  ];
}

/**
 * Merge the platform's own credential with the operator credential set.
 *
 * The result is the JSON array the service parses: the platform actor
 * first, then every operator actor in MANIFEST order, each with its
 * manifest-declared approval types. Applying the same inputs twice
 * returns the same bytes.
 *
 * @param {object} options
 * @param {object} options.contract  the manifest's `approvalCredentials` entry
 * @param {string} options.platformToken  the platform actor's token
 * @param {string} options.operatorRaw  the raw operator credential array
 * @param {string} [options.serviceLabel]  a human label for the service
 * @param {string[]} [options.allowedApprovalTypes]  the service's accepted types
 * @returns {{value: string, actors: string[], entries: object[]}}
 */
export function buildMergedApprovalCredentials(options) {
  const { contract, platformToken, operatorRaw } = options;
  const serviceLabel = options.serviceLabel ?? 'service';
  const contractLabel = `the ${serviceLabel} approval credential contract`;
  const operatorRequired = contract?.operatorCredentialsRequired !== false;

  assertApprovalCredentialContract(contract, {
    label: contractLabel,
    allowedApprovalTypes: options.allowedApprovalTypes ?? null,
  });

  if (
    typeof platformToken !== 'string' ||
    platformToken.trim().length < APPROVAL_CREDENTIAL_MIN_TOKEN_LENGTH
  ) {
    throw new Error(
      `the ${serviceLabel} platform token source "${contract.platformTokenSource}" is missing ` +
        `or shorter than ${APPROVAL_CREDENTIAL_MIN_TOKEN_LENGTH} characters`,
    );
  }

  const operatorSource = `${contract.operatorCredentialsSource} (${serviceLabel} operator credentials)`;
  const operatorAbsent =
    typeof operatorRaw !== 'string' || operatorRaw.trim() === '';
  if (operatorAbsent && !operatorRequired) {
    // This environment declares no operator writers, so the merged array
    // is the platform actor alone. The operator source is not required
    // here, and nothing is registered on its behalf.
    const platformOnly = [
      {
        token: platformToken.trim(),
        actor: contract.platformActor,
        approvalTypes: [...contract.platformApprovalTypes],
      },
    ];
    return {
      value: JSON.stringify(platformOnly),
      actors: platformOnly.map((entry) => entry.actor),
      entries: platformOnly,
    };
  }
  const operators = parseApprovalCredentialArray(operatorRaw, { source: operatorSource });

  const expected = new Map(
    (contract.operatorActors ?? []).map((entry) => [entry.actor, [...entry.approvalTypes]]),
  );
  const provided = new Map();
  for (const entry of operators) {
    if (provided.has(entry.actor)) {
      throw new Error(
        `${operatorSource} declares the actor "${entry.actor}" more than once`,
      );
    }
    provided.set(entry.actor, entry.approvalTypes);
  }

  const missing = [...expected.keys()].filter((actor) => !provided.has(actor));
  if (missing.length > 0) {
    throw new Error(
      `${operatorSource} is missing the expected actor(s): ${missing.join(', ')}. ` +
        'The credential set would be registered without them.',
    );
  }
  const unknown = [...provided.keys()].filter((actor) => !expected.has(actor));
  if (unknown.length > 0) {
    throw new Error(
      `${operatorSource} carries actor(s) the manifest does not declare: ${unknown.join(', ')}. ` +
        'An undeclared actor is an unreviewed writer, so the deploy is refused.',
    );
  }

  for (const [actor, declared] of expected) {
    const got = [...provided.get(actor)].sort();
    const want = [...declared].sort();
    if (got.join('|') !== want.join('|')) {
      throw new Error(
        `${operatorSource} actor "${actor}" declares approval type(s) [${got.join(', ')}] but ` +
          `the manifest declares [${want.join(', ')}]. The merge never unions grants.`,
      );
    }
  }

  const entries = [
    {
      token: platformToken.trim(),
      actor: contract.platformActor,
      approvalTypes: [...contract.platformApprovalTypes],
    },
    ...contract.operatorActors.map((declared) => {
      const entry = operators.find((candidate) => candidate.actor === declared.actor);
      return {
        token: entry.token,
        actor: declared.actor,
        approvalTypes: [...declared.approvalTypes],
      };
    }),
  ];

  const tokens = new Set();
  for (const entry of entries) {
    if (tokens.has(entry.token)) {
      throw new Error(
        `${operatorSource} shares one token between actors. Every actor needs its own token, ` +
          'or the actor attribution behind an audit event would be meaningless.',
      );
    }
    tokens.add(entry.token);
  }

  return {
    value: JSON.stringify(entries),
    actors: entries.map((entry) => entry.actor),
    entries,
  };
}
