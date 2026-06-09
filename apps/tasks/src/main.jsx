import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import '@sindustries/ui/react/styles.css';
import './index.css';
import { App } from './App.jsx';
import { DesignSystemPage } from './pages/TokensPage.jsx';

function Root() {
  if (window.location.pathname === '/design-system') {
    return <DesignSystemPage />;
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
