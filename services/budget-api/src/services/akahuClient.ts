type AkahuTokenResponse = {
  success?: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type AkahuListResponse<T> = {
  success: boolean;
  items: T[];
  cursor?: { next?: string };
  message?: string;
};

export type AkahuAccount = {
  _id: string;
  name?: string;
  status?: string;
  type?: string;
};

export type AkahuTransaction = {
  _id: string;
  _account: string;
  date: string;
  description: string;
  amount: number;
  merchant?: { name?: string } | null;
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  redirectUri?: string;
}) {
  const client_id = requiredEnv('AKAHU_CLIENT_ID');
  const client_secret = requiredEnv('AKAHU_CLIENT_SECRET');
  const redirect_uri = params.redirectUri ?? requiredEnv('AKAHU_REDIRECT_URI');

  const res = await fetch('https://oauth.akahu.nz/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri,
      client_id,
      client_secret
    })
  });

  const json = (await res.json().catch(() => null)) as AkahuTokenResponse | null;
  if (!res.ok || !json?.access_token) {
    const msg = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(`Akahu token exchange failed: ${msg}`);
  }

  return { accessToken: json.access_token, scope: json.scope ?? null };
}

export async function akahuGetAccounts(params: { accessToken: string }) {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const res = await fetch('https://api.akahu.io/v1/accounts', {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'X-Akahu-Id': appIdToken
    }
  });

  const text = await res.text();
  let json: AkahuListResponse<AkahuAccount> | null = null;
  if (text) {
    json = (JSON.parse(text) as AkahuListResponse<AkahuAccount>) ?? null;
  }

  if (!res.ok || !json || json.success !== true || !Array.isArray(json.items)) {
    const msg = (json as any)?.message ?? `HTTP ${res.status}`;
    throw new Error(`Akahu /accounts failed: ${msg}`);
  }

  return json.items;
}

export async function akahuGetTransactions(params: {
  accessToken: string;
  startMs?: number;
  endMs?: number;
}) {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const url = new URL('https://api.akahu.io/v1/transactions');
  // Akahu expects ISO 8601 date-time strings in query params.
  if (typeof params.startMs === 'number')
    url.searchParams.set('start', new Date(params.startMs).toISOString());
  if (typeof params.endMs === 'number')
    url.searchParams.set('end', new Date(params.endMs).toISOString());

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'X-Akahu-Id': appIdToken
    }
  });

  const text = await res.text();
  let json: AkahuListResponse<AkahuTransaction> | null = null;
  if (text) {
    json = (JSON.parse(text) as AkahuListResponse<AkahuTransaction>) ?? null;
  }

  if (!res.ok || !json || json.success !== true || !Array.isArray(json.items)) {
    const msg = (json as any)?.message ?? `HTTP ${res.status}`;
    throw new Error(`Akahu /transactions failed: ${msg}`);
  }

  return json.items;
}

