import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api.js';

const TutorialContext = createContext(null);
export const useTutorial = () => useContext(TutorialContext);

export const TUTORIAL_STEPS = [
  { target: '[data-tour="home"]', title: 'Home dashboard', text: 'This is your dashboard. See your YTD paid claims and current pay period.', path: '/' },
  { target: '[data-tour="clients"]', title: 'Clients', text: 'Manage your client profiles, their alternative names, and service agreements here.', path: '/clients' },
  { target: '[data-tour="uploads-ra"]', title: 'Uploads — RA', text: 'Upload your Remittance Advice PDFs here. The AI will read them and verify against your data.', path: '/uploads?tab=ra' },
  { target: '[data-tour="uploads-claims"]', title: 'Uploads — Claim Submission', text: 'Upload claim submissions (Status 46) to track pending payments.', path: '/uploads?tab=claims' },
  { target: '[data-tour="uploads-sa"]', title: 'Uploads — Service Agreement', text: 'Upload Service Agreements to auto-create client profiles and track authorized units.', path: '/uploads?tab=sa' },
  { target: '[data-tour="pending-claims"]', title: 'Pending Claims', text: 'Track claims waiting for payment. The AI automatically moves them to Paid when the matching RA arrives.', path: '/pending-claims' },
  { target: '[data-tour="chat-input"]', title: 'Ask Dundas AI', text: 'Ask our AI to explain any discrepancies. It knows your billing data inside and out.', path: '/ask' },
  { target: '[data-tour="settings"]', title: 'Settings', text: 'Customize your agency logo, branding, and AI quick prompts here.', path: '/settings' },
];

function markComplete(isDemo) {
  if (isDemo) {
    try { sessionStorage.setItem('demoTourCompleted', 'true'); } catch {}
    return Promise.resolve({ ignored: true });
  }
  return api.completeTutorial().catch(() => {});
}

export function TutorialProvider({ user, children }) {
  const navigate = useNavigate();
  const isDemo = Number(user?.is_demo) === 1;
  const [welcome, setWelcome] = useState(false);
  const [step, setStep] = useState(-1);

  useEffect(() => {
    // Demo tours are never persisted in the database. A demo reload starts
    // the welcome modal again; real users resume from their saved flag.
    if (isDemo) {
      let completed = false;
      try { completed = sessionStorage.getItem('demoTourCompleted') === 'true'; } catch {}
      setWelcome(!completed);
    } else if (!user?.tutorial_completed) {
      setWelcome(true);
    }
  }, [isDemo, user?.tutorial_completed]);

  const go = (index) => {
    setStep(index);
    navigate(TUTORIAL_STEPS[index].path);
  };
  const start = () => {
    setWelcome(false);
    go(0);
  };
  const skip = async () => {
    setWelcome(false);
    setStep(-1);
    await markComplete(isDemo);
    // /login is not a route inside this SPA; sending a logged-in user there
    // produced a blank page. Real users skip straight to the Home dashboard.
    navigate('/', { replace: true });
  };
  const next = async () => {
    if (step >= TUTORIAL_STEPS.length - 1) {
      await markComplete(isDemo);
      setStep(-1);
      setWelcome(false);
      return;
    }
    go(step + 1);
  };
  const back = () => {
    if (step > 0) go(step - 1);
  };

  const current = TUTORIAL_STEPS[step];
  return (
    <TutorialContext.Provider value={{ start, step, next, skip }}>
      {children}
      {welcome && (
        <div className="tour-welcome-backdrop" role="dialog" aria-modal="true">
          <div className="tour-welcome">
            <h2>Welcome to Dundas Billing</h2>
            <p>Let’s take a quick tour of the entire workspace. You can click through the real app while the tour card stays with you.</p>
            <ol>
              {TUTORIAL_STEPS.map((item) => <li key={item.title}>{item.title}</li>)}
            </ol>
            <div className="tour-actions">
              {!isDemo && <button type="button" className="btn" onClick={skip}>Skip Tutorial</button>}
              <button type="button" className="btn primary" onClick={start}>Start Tour</button>
            </div>
          </div>
        </div>
      )}
      {step >= 0 && current && (
        <aside className="tour-tooltip" role="dialog" aria-label="Tutorial step" id="tour-tooltip">
          <div className="tour-tooltip-top">
            <span className="pill">Step {step + 1} of {TUTORIAL_STEPS.length}</span>
            {!isDemo && <button type="button" className="btn tiny" onClick={skip}>Skip</button>}
          </div>
          <strong>{current.title}</strong>
          <p>{current.text}</p>
          <div className="tour-actions">
            <button type="button" className="btn tiny" onClick={back} disabled={step === 0}>Back</button>
            <button type="button" className="btn primary tiny" onClick={next}>
              {step === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </aside>
      )}
    </TutorialContext.Provider>
  );
}
