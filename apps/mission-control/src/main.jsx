import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import '@sindustries/ui/react/styles.css';
import './index.css';
import { App } from './App.jsx';
import { readStoredTheme } from './theme.js';

// Apply the persisted theme to <html data-si-theme> before React mounts
// so the first paint uses the correct palette. Mirrors the pattern the
// tasks app already uses on its own <html>.
document.documentElement.setAttribute('data-si-theme', readStoredTheme());

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
