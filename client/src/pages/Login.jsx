import React, { useState } from 'react';
import api, { setToken } from '../api.js';

/**
 * Login / signup.
 *
 * One card, a toggle between the two modes. Signup additionally asks for the
 * agency name, because a new account always starts a new workspace.
 */
export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isSignup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const fn = isSignup ? api.signup : api.login;
      const body = isSignup ? { email, password, agency_name: agencyName } : { email, password };
      const res = await fn(body);
      setToken(res.token);
      onAuthed?.(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page" id="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">{isSignup ? 'Create your workspace' : 'Sign in'}</h1>
        <p className="muted small login-sub">
          {isSignup
            ? 'Start a new agency workspace. You will be its administrator.'
            : 'Sign in to your billing workspace.'}
        </p>

        {error && (
          <div className="alert error" id="login-error">
            {error}
          </div>
        )}

        <label>
          Email
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            id="login-password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {isSignup && <span className="muted small">At least 8 characters.</span>}
        </label>

        {isSignup && (
          <label>
            Agency name
            <input
              id="login-agency"
              value={agencyName}
              onChange={(e) => setAgencyName(e.target.value)}
              placeholder="e.g. Northstar Home Care"
              required
            />
          </label>
        )}

        <button className="btn primary login-submit" id="login-submit" disabled={busy} type="submit">
          {busy ? 'Please wait…' : isSignup ? 'Create workspace' : 'Sign in'}
        </button>

        <button
          type="button"
          className="login-toggle"
          id="login-toggle"
          onClick={() => {
            setMode(isSignup ? 'login' : 'signup');
            setError(null);
          }}
        >
          {isSignup ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
        </button>
      </form>
    </div>
  );
}
