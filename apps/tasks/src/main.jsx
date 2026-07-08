import React from 'react';
import { createRoot } from 'react-dom/client';
import '@sindustries/design-tokens/styles.css';
import '@sindustries/ui/react/styles.css';
import './index.css';
import { App } from './App.jsx';
import { getStoredTheme } from './utils/storage.js';

document.documentElement.setAttribute('data-si-theme', getStoredTheme());

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
