import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

function firstName(userName) {
  const raw = String(userName ?? '').trim();
  if (!raw) return 'there';
  const part = raw.includes('@') ? raw.split('@')[0] : raw.split(/\s+/)[0];
  return part
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * A small contextual nudge at the top of the dashboard. It is deliberately
 * optional: if a page has no meaningful count, pass `detail` instead.
 */
export default function InsightBar({
  userName,
  awaiting,
  hasData = true,
  loading = false,
  detail = null,
}) {
  const name = firstName(userName);
  let message;
  if (loading) {
    message = 'Getting your workspace ready…';
  } else if (!hasData) {
    message = 'Your workspace is ready. Import an RA to get started.';
  } else if (awaiting !== undefined && awaiting !== null) {
    const count = Number(awaiting) || 0;
    message = count
      ? `${greeting()}, ${name}. You have ${count} claim${count === 1 ? '' : 's'} awaiting payment.`
      : `${greeting()}, ${name}. No claims are waiting on payment.`;
  } else if (detail) {
    message = `${greeting()}, ${name}. ${detail}`;
  } else {
    message = `${greeting()}, ${name}. Your workspace is up to date.`;
  }

  return (
    <motion.div
      className="insight-bar"
      id="insight-bar"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
      aria-live="polite"
    >
      <span className="insight-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path
            d="M12 3.5l1.7 4.6 4.8 1.7-4.8 1.7L12 16.1l-1.7-4.6L5.5 9.8l4.8-1.7L12 3.5z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="currentColor" opacity=".8" />
        </svg>
      </span>
      <div className="insight-copy">
        <strong>Insights</strong>
        <p>{message}</p>
      </div>
      {!loading && !hasData && (
        <Link className="insight-cta" to="/import-ra">
          Import RA
        </Link>
      )}
    </motion.div>
  );
}
