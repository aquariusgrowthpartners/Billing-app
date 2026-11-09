import React from 'react';

/** Immediate route-level placeholder used while a lazy page chunk loads. */
export default function SkeletonPage() {
  return (
    <div className="page skeleton-page" aria-busy="true" aria-label="Loading page">
      <div className="sk-page-head">
        <div className="sk-line sk-h28 sk-w40" />
        <div className="sk-line sk-w60" />
      </div>
      <div className="sk-stat-row">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="sk-stat" key={i}>
            <div className="sk-line sk-w50" />
            <div className="sk-line sk-h28 sk-w70" />
            <div className="sk-line sk-w40" />
          </div>
        ))}
      </div>
      <div className="sk-card sk-page-card">
        {Array.from({ length: 5 }, (_, i) => (
          <div className="sk-line" key={i} style={{ width: `${88 - i * 8}%` }} />
        ))}
      </div>
    </div>
  );
}
