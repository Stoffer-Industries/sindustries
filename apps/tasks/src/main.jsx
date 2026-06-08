import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import './index.css';
import './App.css';
import { App } from './App.jsx';
import { TokensPage } from './pages/TokensPage.jsx';

function Root() {
  if (window.location.pathname === '/tokens') {
    return <TokensPage />;
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
