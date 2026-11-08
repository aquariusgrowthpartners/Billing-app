import React, { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link, useLocation } from 'react-router-dom';
import Home from './pages/Home.jsx';
import ClientList from './pages/ClientList.jsx';
import ClientProfile from './pages/ClientProfile.jsx';
import ClaimsDashboard from './pages/ClaimsDashboard.jsx';
import Settings from './pages/Settings.jsx';
import Caretakers from './pages/Caretakers.jsx';
import CaretakerProfile from './pages/CaretakerProfile.jsx';
import ImportRa from './pages/ImportRa.jsx';
import Spreadsheet from './pages/Spreadsheet.jsx';
import Denials from './pages/Denials.jsx';
import Tasks from './pages/Tasks.jsx';
import AskDundas from './pages/AskDundas.jsx';
import { ToastProvider } from './components/Toast.jsx';
import Login from './pages/Login.jsx';
import { getToken, clearToken } from './api.js';
import api from './api.js';

// recharts is heavy and only needed on one page, so Reports is split out.
const Reports = lazy(() => import('./pages/Reports.jsx'));

// React Router must know about the path Vite is mounted under (/billing/).
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

/**
 * Last-resort UI boundary.
 *
 * A page render error used to unmount the whole React tree and leave a blank
 * screen. This keeps the navigation and shows a readable message instead.
 * Exported so the entrypoint can also guard the App itself.
 */
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ui] page render failed:', error, info?.componentStack ?? '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="page" id="error-boundary">
        <div className="alert error" role="alert">
          <h2 style={{ marginTop: 0 }}>This page could not be displayed</h2>
          <p>
            A rendering error occurred, so only this page was stopped. The rest of the app is still
            available from the navigation.
          </p>
          <p className="muted small mono" style={{ wordBreak: 'break-word' }}>
            {this.state.error?.message ?? String(this.state.error)}
          </p>
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      </section>
    );
  }
}

/** Remount the boundary when the route changes, so one bad page never sticks. */
function RoutedPage({ children }) {
  const location = useLocation();
  return (
    <AppErrorBoundary key={`${location.pathname}${location.search}`}>{children}</AppErrorBoundary>
  );
}

export default function App() {
  // A small badge on the Settings tab when there is data to clean up.
  const [orphanCount, setOrphanCount] = useState(0);
  // and a red one on Denials for open rebill tasks
  const [openTasks, setOpenTasks] = useState(0);
  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .orphanedCount()
        .then((r) => alive && setOrphanCount(r.count ?? 0))
        .catch(() => {});
    check();
    window.addEventListener('data-updated', check);
    return () => {
      alive = false;
      window.removeEventListener('data-updated', check);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .denialSummary()
        .then((r) => alive && setOpenTasks(r.open_tasks ?? 0))
        .catch(() => {});
    check();
    window.addEventListener('data-updated', check);
    return () => {
      alive = false;
      window.removeEventListener('data-updated', check);
    };
  }, []);

  const [navOpen, setNavOpen] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [authChecked, setAuthChecked] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const bannerRef = useRef(null);

  /*
   * Measure the banner rather than hardcoding its height.
   * The text wraps on narrow screens, so a fixed padding is always a couple of
   * pixels out — and the sticky topbar then sits underneath it.
   */
  useEffect(() => {
    if (!demoMode || !bannerRef.current) {
      setBannerHeight(0);
      return undefined;
    }
    const el = bannerRef.current;
    const measure = () => setBannerHeight(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [demoMode]);

  /*
   * Decide whether a login is required.
   * Demo mode always skips it; otherwise a stored token decides.
   */
  useEffect(() => {
    api
      .mode()
      .then((d) => {
        if (d?.demo) setAuthed(true);
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  /* Demo mode is a server fact, so ask once on load. */
  useEffect(() => {
    let cancelled = false;
    api
      .mode()
      .then((d) => !cancelled && setDemoMode(Boolean(d?.demo)))
      .catch(() => !cancelled && setDemoMode(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Every drawer link closes the drawer in its own onClick, so no route
  // listener is needed here (and App sits above the Router anyway).
  useEffect(() => {
    document.body.style.overflow = navOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [navOpen]);

  return (
    <ToastProvider>
    {authChecked && !demoMode && !authed ? (
      <Login
        onAuthed={() => {
          setAuthed(true);
        }}
      />
    ) : (
    <BrowserRouter basename={BASENAME}>
      <div
        className={`app${demoMode ? ' demo-mode' : ''}`}
        style={demoMode ? { paddingTop: bannerHeight, '--demo-banner-h': `${bannerHeight}px` } : undefined}
      >
        {demoMode && (
          <div className="demo-banner" id="demo-banner" role="status" ref={bannerRef}>
            ⚠️ DEMO MODE — Synthetic Data Only
          </div>
        )}
        <header className="topbar">
          {/* Brand left out on purpose: this is a client demo, so the nav is the
              first thing on screen rather than our product name. */}
          <button
            type="button"
            className="nav-toggle show-on-mobile"
            id="nav-toggle"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="mobile-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            {navOpen ? '✕' : '☰'}
            <span className="nav-toggle-label">Menu</span>
          </button>

          <nav className="topnav hide-on-mobile">
            <NavLink to="/ask" className={({ isActive }) => (isActive ? 'active' : '')}>
              ✨ Ask Dundas
            </NavLink>
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Home
            </NavLink>
            <NavLink to="/clients" className={({ isActive }) => (isActive ? 'active' : '')}>
              Clients
            </NavLink>
            <NavLink to="/claims" className={({ isActive }) => (isActive ? 'active' : '')}>
              Claims Dashboard
            </NavLink>
            <NavLink to="/caretakers" className={({ isActive }) => (isActive ? 'active' : '')}>
              Caretakers
            </NavLink>
            <NavLink to="/import-ra" className={({ isActive }) => (isActive ? 'active' : '')}>
              Import RA
            </NavLink>
            <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
              Reports
            </NavLink>
            <NavLink to="/spreadsheet" className={({ isActive }) => (isActive ? 'active' : '')}>
              Spreadsheet
            </NavLink>
            <NavLink to="/denials" className={({ isActive }) => (isActive ? 'active' : '')}>
              Denials
              {openTasks > 0 && (
                <span className="nav-badge" id="denials-badge" title={`${openTasks} open rebill tasks`}>
                  {openTasks}
                </span>
              )}
            </NavLink>
            <NavLink to="/tasks" className={({ isActive }) => (isActive ? 'active' : '')}>
              Tasks
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
              Settings
              {orphanCount > 0 && (
                <span className="nav-badge" id="settings-orphan-badge" title={`${orphanCount} orphaned day entries`}>
                  {orphanCount}
                </span>
              )}
            </NavLink>
          </nav>

          {/* Mobile drawer: the 8 links stacked, with a tap-anywhere overlay */}
          {navOpen && (
            <div
              className="nav-overlay show-on-mobile"
              id="nav-overlay"
              onClick={() => setNavOpen(false)}
              aria-hidden="true"
            />
          )}
          {navOpen && (
            <nav className="nav-drawer show-on-mobile" id="mobile-nav">
              <NavLink to="/ask" onClick={() => setNavOpen(false)}>
                ✨ Ask Dundas
              </NavLink>
              <NavLink to="/" end onClick={() => setNavOpen(false)}>
                Home
              </NavLink>
              <NavLink to="/clients" onClick={() => setNavOpen(false)}>
                Clients
              </NavLink>
              <NavLink to="/claims" onClick={() => setNavOpen(false)}>
                Claims Dashboard
              </NavLink>
              <NavLink to="/caretakers" onClick={() => setNavOpen(false)}>
                Caretakers
              </NavLink>
              <NavLink to="/import-ra" onClick={() => setNavOpen(false)}>
                Import RA
              </NavLink>
              <NavLink to="/reports" onClick={() => setNavOpen(false)}>
                Reports
              </NavLink>
              <NavLink to="/spreadsheet" onClick={() => setNavOpen(false)}>
                Spreadsheet
              </NavLink>
              <NavLink to="/denials" onClick={() => setNavOpen(false)}>
                Denials
                {openTasks > 0 && <span className="nav-badge">{openTasks}</span>}
              </NavLink>
              <NavLink to="/tasks" onClick={() => setNavOpen(false)}>
                Tasks
              </NavLink>
              <NavLink to="/settings" onClick={() => setNavOpen(false)}>
                Settings
                {orphanCount > 0 && <span className="nav-badge">{orphanCount}</span>}
              </NavLink>
            </nav>
          )}
        </header>

        <main className="content">
          <RoutedPage>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/clients" element={<ClientList />} />
            <Route path="/clients/:id" element={<ClientProfile />} />
            <Route path="/claims" element={<ClaimsDashboard />} />
            <Route path="/caretakers" element={<Caretakers />} />
            <Route path="/caretakers/:id" element={<CaretakerProfile />} />
            <Route path="/import-ra" element={<ImportRa />} />
            <Route
              path="/reports"
              element={
                <Suspense fallback={<div className="empty" style={{ padding: 40 }}>Loading reports…</div>}>
                  <Reports />
                </Suspense>
              }
            />
            <Route path="/spreadsheet" element={<Spreadsheet />} />
            <Route path="/denials" element={<Denials />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/ask" element={<AskDundas />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </RoutedPage>
        </main>
      </div>
    </BrowserRouter>
    )}
    </ToastProvider>
  );
}
