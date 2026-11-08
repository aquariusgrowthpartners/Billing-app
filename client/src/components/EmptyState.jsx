import React from 'react';

/** Centered, friendly placeholder for a page whose list is empty. */
export default function EmptyState({ icon = '•', title, children, id }) {
  return (
    <div className="empty-state" id={id}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty-state-title">{title}</p>
      {children ? <div className="muted small empty-state-sub">{children}</div> : null}
    </div>
  );
}
