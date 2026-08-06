import { describe, expect, it } from 'vitest';
import { mcpBaseUrl, mcpUrl, PRODUCTION_MCP_BASE_URL } from './mcpConfig.js';

describe('GymTrack MCP URL configuration', () => {
  it('uses an explicit deployment setting when provided', () => {
    expect(
      mcpBaseUrl({
        configuredBaseUrl: 'https://mcp.example.test',
        location: { hostname: 'gymtrack.example.test' }
      })
    ).toBe('https://mcp.example.test');
  });

  it('uses the local MCP service during local development', () => {
    expect(
      mcpUrl('/mcp', {
        configuredBaseUrl: '',
        location: { hostname: 'localhost' }
      })
    ).toBe('http://localhost:8787/mcp');
  });

  it('falls back to the live Fly service outside local development', () => {
    expect(
      mcpUrl('/mcp', {
        configuredBaseUrl: '',
        location: { hostname: 'gymtrack-sigma-pied.vercel.app' }
      })
    ).toBe(`${PRODUCTION_MCP_BASE_URL}/mcp`);
  });
});
