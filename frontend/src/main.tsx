import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { applyTheme, readStoredTheme } from './lib/theme';
import './index.css';

// A stored light/dark choice is stamped before the first paint; "system" needs no
// stamp because the tokens follow prefers-color-scheme on their own.
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
