import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * App-wide toasts.
 *
 * A tiny event bus rather than prop drilling: any component can call
 * `toast.success(...)` without being wired to the provider. Toasts sit at the
 * top on mobile (clear of the thumb) and bottom-right on desktop.
 */
const ToastContext = createContext(null);

let pushExternal = null;
export const toast = {
  success: (msg) => pushExternal?.({ kind: 'success', message: msg }),
  error: (msg) => pushExternal?.({ kind: 'error', message: msg }),
  info: (msg) => pushExternal?.({ kind: 'info', message: msg }),
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);

  const push = useCallback(({ kind = 'info', message, ttl = 3000 }) => {
    if (!message) return;
    const id = ++seq.current;
    setItems((list) => [...list, { id, kind, message }]);
    setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  useEffect(() => {
    pushExternal = push;
    return () => {
      pushExternal = null;
    };
  }, [push]);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host" id="toast-host" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} data-kind={t.kind}>
            <span className="toast-icon" aria-hidden="true">
              {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}
            </span>
            <span className="toast-msg">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ?? { push: () => {} };
}

export default ToastProvider;
