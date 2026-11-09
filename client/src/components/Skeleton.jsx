import React from 'react';

/**
 * Shimmering placeholder used while data loads.
 *
 * `variant="card"` mimics the shape of a list card so the layout doesn't jump
 * when the real content arrives; plain blocks are for stat tiles and text.
 */
export default function Skeleton({ variant = 'line', lines = 1, className = '', style }) {
  if (variant === 'card') {
    return (
      <div className={`sk-card ${className}`} style={style} aria-hidden="true">
        <div className="sk-line sk-w60" />
        <div className="sk-line sk-w40" />
        <div className="sk-line sk-w80" />
      </div>
    );
  }

  if (variant === 'stat') {
    return (
      <div className={`sk-stat ${className}`} style={style} aria-hidden="true">
        <div className="sk-line sk-w50" />
        <div className="sk-line sk-h28 sk-w70" />
        <div className="sk-line sk-w40" />
      </div>
    );
  }

  return (
    <div className={className} style={style} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={`sk-line ${i === lines - 1 && lines > 1 ? 'sk-w80' : ''}`}
          style={{ marginBottom: i === lines - 1 ? 0 : 8 }}
        />
      ))}
    </div>
  );
}

/** A stack of skeleton cards for list loading. */
export function SkeletonCards({ count = 3 }) {
  return (
    <div className="sk-card-stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="card" />
      ))}
    </div>
  );
}

/** Shimmering table rows for a list that is still loading. */
export function SkeletonRows({ rows = 5, cols = 6 }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr className="sk-table-row" key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <div className={`sk-line ${c === 0 ? 'sk-w70' : 'sk-w50'}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
