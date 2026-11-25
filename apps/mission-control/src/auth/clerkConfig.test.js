import { describe, expect, it } from 'vitest';
import { clerkConfig } from './clerkConfig.js';

describe('Mission Control Clerk configuration', () => {
  it('uses the existing Clerk primary as an auto-syncing satellite', () => {
    expect(clerkConfig({
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_shared',
      VITE_CLERK_SATELLITE_DOMAIN: 'mission.example.test',
      VITE_CLERK_SIGN_IN_URL: 'https://primary.example.test/sign-in',
      PROD: true
    })).toMatchObject({
      publishableKey: 'pk_test_shared',
      domain: 'mission.example.test',
      signInUrl: 'https://primary.example.test/sign-in',
      isSatellite: true,
      satelliteAutoSync: true
    });
  });

  it('fails closed when satellite topology is incomplete', () => {
    expect(() => clerkConfig({
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_shared',
      VITE_CLERK_SIGN_IN_URL: 'https://primary.example.test/sign-in'
    })).toThrow('VITE_CLERK_SATELLITE_DOMAIN is required');
  });
});
