import React from 'react';
import { createRoot } from 'react-dom/client';
import App, { AppErrorBoundary } from './App.jsx';
import './styles.css';
import { initTheme } from './theme.js';

// Apply the saved theme before the first paint so there is no light flash.
initTheme().finally(() => {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
});
