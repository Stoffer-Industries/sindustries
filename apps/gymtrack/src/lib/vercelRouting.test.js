import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const vercelConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')
);

describe('GymTrack production domain routing', () => {
  it('redirects the legacy Vercel hostname to the Clerk-compatible canonical domain', () => {
    expect(vercelConfig.redirects).toContainEqual({
      source: '/:path*',
      has: [
        {
          type: 'host',
          value: 'gymtrack-sigma-pied\\.vercel\\.app'
        }
      ],
      destination: 'https://gymtrack.sindustries.co.nz/:path*',
      permanent: true
    });
  });
});
