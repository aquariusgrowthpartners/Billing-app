import React, { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link } from 'react-router-dom';
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
import api from './api.js';

// recharts is heavy and only needed on one page, so Reports is split out.
const Reports = lazy(() => import('./pages/Reports.jsx'));

// React Router must know about the path Vite is mounted under (/billing/).
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

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
        </main>
      </div>
    </BrowserRouter>
    </ToastProvider>
  );
}
