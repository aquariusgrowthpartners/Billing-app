import React, { lazy, Suspense, useEffect, useState } from 'react';
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
import api from './api.js';

// recharts is heavy and only needed on one page, so Reports is split out.
const Reports = lazy(() => import('./pages/Reports.jsx'));

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

  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <Link className="brand" to="/">
            <span className="brand-mark">BC</span>
            <span className="brand-text">
              <strong>Billing Calendar</strong>
              <small>local-first · 127.0.0.1</small>
            </span>
          </Link>
          <nav className="topnav">
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
            <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
              Settings
              {orphanCount > 0 && (
                <span className="nav-badge" id="settings-orphan-badge" title={`${orphanCount} orphaned day entries`}>
                  {orphanCount}
                </span>
              )}
            </NavLink>
          </nav>
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
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
