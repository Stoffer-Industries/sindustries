const DESTINATION_KEY = 'gymtrack:clerk-sso-destination';

function safeInternalDestination(value) {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '/workout';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/workout';
  }
}

export function rememberClerkSsoDestination(destination) {
  window.sessionStorage.setItem(DESTINATION_KEY, safeInternalDestination(destination));
}

export function clearClerkSsoDestination() {
  window.sessionStorage.removeItem(DESTINATION_KEY);
}

export function consumeClerkSsoDestination() {
  const destination = window.sessionStorage.getItem(DESTINATION_KEY) ?? '/workout';
  clearClerkSsoDestination();
  return safeInternalDestination(destination);
}
