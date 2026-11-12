import React, { useEffect, useRef, useState } from 'react';

const IDLE_MS = 15 * 60 * 1000;
const WARN_MS = 60 * 1000;

export default function SessionTimeout({ onLogout }) {
  const [warning, setWarning] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const idleTimer = useRef(null);
  const warnTimer = useRef(null);
  const countdown = useRef(null);

  const clearAll = () => {
    clearTimeout(idleTimer.current);
    clearTimeout(warnTimer.current);
    clearInterval(countdown.current);
  };

  const reset = () => {
    clearAll();
    setWarning(false);
    setSeconds(60);
    warnTimer.current = setTimeout(() => {
      setWarning(true);
      setSeconds(60);
      countdown.current = setInterval(() => {
        setSeconds((s) => {
          if (s <= 1) {
            clearAll();
            onLogout?.();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }, IDLE_MS - WARN_MS);
    idleTimer.current = setTimeout(() => {
      clearAll();
      onLogout?.();
    }, IDLE_MS);
  };

  useEffect(() => {
    reset();
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    return () => {
      clearAll();
      for (const ev of events) window.removeEventListener(ev, reset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!warning) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" style={{ zIndex: 20000 }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2 style={{ marginTop: 0 }}>Session expiring</h2>
        <p>For PHI protection, you’ll be signed out in {seconds} seconds due to inactivity.</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onLogout}>Log out now</button>
          <button type="button" className="btn primary" onClick={reset}>Stay signed in</button>
        </div>
      </div>
    </div>
  );
}
