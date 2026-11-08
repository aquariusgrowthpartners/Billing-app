import React, { useState } from 'react';
import api, { clearToken } from '../api.js';

/**
 * Blocking first-login password change.
 *
 * The bootstrap admin is created with a temporary password and
 * `must_change_password = 1`. This screen is rendered instead of the app, so it
 * cannot be dismissed with the browser back button or navigation.
 */
export default function ChangePassword({ user, onChanged }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (next.length < 8) {
      setError('The new password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.changePassword({
        current_password: current,
        new_password: next,
      });
      onChanged?.(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    clearToken();
    window.location.reload();
  }

  return (
    <div className="login-page" id="change-password-page">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">Choose a new password</h1>
        <p className="muted small login-sub">
          {user?.email ?? 'Your account'} was created with a temporary password. Set a new one
          before continuing.
        </p>

        {error && (
          <div className="alert error" id="change-password-error">
            {error}
          </div>
        )}

        <label>
          Current / temporary password
          <input
            id="change-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>

        <label>
          New password
          <input
            id="change-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
          />
          <span className="muted small">At least 8 characters.</span>
        </label>

        <label>
          Confirm new password
          <input
            id="change-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
          />
        </label>

        <button className="btn primary login-submit" id="change-password-submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>

        <button type="button" className="login-toggle" onClick={signOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}
