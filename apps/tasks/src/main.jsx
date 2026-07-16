import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import '@sindustries/ui/react/styles.css';
import './index.css';
import { App } from './App.jsx';
import { getStoredTheme, getStoredPulseTheme, setStoredPulseTheme, setStoredTheme } from './utils/storage.js';

const PULSE_THEME_MESSAGE = 'pulse:theme';
// `VITE_SHELL_ORIGIN` is set by the Tiltfile for this app. The fallback
// matches the dev default port for mission-control — Tilt in prodlike
// mode overrides it via MISSION_CONTROL_PORT (see infra/tilt/Tiltfile).
const SHELL_ORIGIN = (import.meta.env?.VITE_SHELL_ORIGIN) || 'http://localhost:5176';
const TASKS_APP_ORIGIN = (import.meta.env?.VITE_TASKS_APP_URL) || 'http://localhost:5173';

// One-time migration: prefer the canonical pulse-theme key, fall back
// to the legacy tasks-app-theme key, and finally to 'dark'. When the
// legacy key holds the value, write it through to the canonical key
// and update the legacy key to match so downstream code sees a single
// source of truth.
const initialTheme = getStoredPulseTheme() ?? getStoredTheme();
document.documentElement.setAttribute('data-si-theme', initialTheme);
if (initialTheme !== getStoredTheme()) setStoredTheme(initialTheme);
if (getStoredPulseTheme() !== initialTheme) setStoredPulseTheme(initialTheme);

// Cross-origin theme sync: the Mission Control shell broadcasts
// `pulse:theme` to its iframe children. Listen for it and apply the
// value to our own <html> + localStorage mirror so a standalone reload
// of the tasks app keeps the shell's choice.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (!event || event.origin !== SHELL_ORIGIN) return;
    const data = event.data;
    if (!data || data.type !== PULSE_THEME_MESSAGE) return;
    if (data.theme !== 'dark' && data.theme !== 'light') return;
    document.documentElement.setAttribute('data-si-theme', data.theme);
    setStoredPulseTheme(data.theme);
    setStoredTheme(data.theme);
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Exposed for tests that need to assert the boot path ran in
// isolation. Not used in app code.
export { SHELL_ORIGIN, TASKS_APP_ORIGIN, PULSE_THEME_MESSAGE };
