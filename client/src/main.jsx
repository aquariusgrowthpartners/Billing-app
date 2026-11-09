import React from 'react';
import { createRoot } from 'react-dom/client';
import App, { AppErrorBoundary } from './App.jsx';
import './styles.css';
import { initTheme } from './theme.js';

/**
 * Debug-mode fatal overlay.
 *
 * iOS Safari has been leaving a blank content area even when React should have
 * caught the error. This plain-DOM layer does not depend on React, so the
 * message is visible even if the tree is already dead.
 */
function showFatalOverlay(kind, detail) {
  try {
    let el = document.getElementById('fatal-error-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fatal-error-overlay';
      el.setAttribute(
        'style',
        [
          'position:fixed',
          'inset:0',
          'z-index:2147483647',
          'background:#fff5f5',
          'color:#8b0000',
          'border-top:6px solid #b00020',
          'padding:18px',
          'overflow:auto',
          '-webkit-overflow-scrolling:touch',
          'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
          'font-size:15px',
          'line-height:1.45',
        ].join(';')
      );
      document.body.appendChild(el);
    }
    el.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'APP ERROR — ' + kind;
    title.setAttribute('style', 'font-size:22px;font-weight:800;margin-bottom:10px;');
    const hint = document.createElement('div');
    hint.textContent = 'Please screenshot or copy this text and send it back.';
    hint.setAttribute('style', 'font-weight:700;margin-bottom:14px;');
    const pre = document.createElement('pre');
    pre.textContent = String(detail ?? 'Unknown error');
    pre.setAttribute(
      'style',
      'white-space:pre-wrap;word-break:break-word;background:#fee2e2;border-radius:8px;padding:12px;font-size:12px;color:#7f1d1d;'
    );
    el.appendChild(title);
    el.appendChild(hint);
    el.appendChild(pre);
  } catch {
    /* nothing else we can do */
  }
}

window.addEventListener('error', (event) => {
  const detail = event?.error?.stack || event?.message || 'Unknown window error';
  console.error('[fatal] window.error:', detail);
  showFatalOverlay('window.error', detail);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const detail = reason?.stack || reason?.message || String(reason ?? 'Unknown promise rejection');
  console.error('[fatal] unhandledrejection:', detail);
  showFatalOverlay('unhandledrejection', detail);
});

// Apply the saved theme before the first paint so there is no light flash.
initTheme().finally(() => {
  const root = createRoot(document.getElementById('root'), {
    onUncaughtError: (error, errorInfo) => {
      const detail = [error?.stack || error?.message || String(error), errorInfo?.componentStack]
        .filter(Boolean)
        .join('\n\n--- component stack ---\n');
      console.error('[fatal] React uncaught:', detail);
      showFatalOverlay('React uncaught', detail);
    },
    onRecoverableError: (error) => {
      console.warn('[fatal] React recoverable:', error);
    },
  });
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
});

// PWA: installable standalone app on iOS/Android. Register only in production
// so Vite dev reloads are never intercepted by a stale shell cache.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[pwa] service worker registration failed:', err));
  });
}
