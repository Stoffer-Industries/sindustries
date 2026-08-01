import helmet from 'helmet';

/** Baseline API security headers. CORS remains configured by the app. */
export function helmetPreset() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true }
  });
}
