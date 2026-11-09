import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Minimal accessible modal. Escape and backdrop click both close it. */
export default function Modal({ title, subtitle, onClose, children, width = 560 }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && (
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button className="btn tiny ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  , document.body
  );
}
