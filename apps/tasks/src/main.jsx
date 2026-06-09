import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import '@sindustries/ui/react/styles.css';
import './index.css';
import { App } from './App.jsx';
import { DesignSystemPage } from '@sindustries/ui/specimen';
import { getStoredTheme } from './utils/storage.js';

document.documentElement.setAttribute('data-si-theme', getStoredTheme());

function Root() {
  if (window.location.pathname === '/design-system') {
    return <DesignSystemPage backHref="/" backLabel="← Tasks" />;
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
