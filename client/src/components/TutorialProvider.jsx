import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api.js';

const TutorialContext = createContext(null);
export const useTutorial = () => useContext(TutorialContext);

const STEPS = [
  { target: '[data-tour="uploads"]', title: 'Upload your first RA', text: 'Start in Uploads. Drop a Remittance Advice PDF to import paid claims.', nextPath: '/uploads' },
  { target: '[data-tour="verify"]', title: 'Match your data', text: 'Use Verify RA to compare the state payment against your billing records.', nextPath: '/ask' },
  { target: '[data-tour="chat-input"]', title: 'Ask questions about your billing', text: 'Ask Dundas can explain discrepancies, reversals, and missed payments.', nextPath: '/ask' },
];

function markComplete() {
  return api.completeTutorial().catch(() => {});
}

export function TutorialProvider({ user, children }) {
  const navigate = useNavigate();
  const [welcome, setWelcome] = useState(false);
  const [step, setStep] = useState(-1);
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (user?.is_demo && !user?.tutorial_completed) setWelcome(true);
  }, [user?.is_demo, user?.tutorial_completed]);

  useEffect(() => {
    if (step < 0) return undefined;
    const update = () => {
      const el = document.querySelector(STEPS[step]?.target);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else setRect(null);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const timer = setTimeout(update, 250);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step]);

  const start = () => {
    setWelcome(false);
    setStep(0);
    navigate(STEPS[0].nextPath);
  };
  const skip = async () => {
    await markComplete();
    window.location.assign('/login?mode=signup');
  };
  const next = async () => {
    if (step >= STEPS.length - 1) {
      await markComplete();
      setStep(-1);
      return;
    }
    const nextStep = step + 1;
    setStep(nextStep);
    navigate(STEPS[nextStep].nextPath);
  };

  const current = STEPS[step];
  const tooltipStyle = rect
    ? {
        position: 'fixed',
        left: Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - 336)),
        top: Math.min(rect.bottom + 12, window.innerHeight - 190),
        width: 'min(320px, calc(100vw - 32px))',
        zIndex: 10001,
      }
    : { position: 'fixed', left: 16, right: 16, bottom: 20, zIndex: 10001 };

  return (
    <TutorialContext.Provider value={{ start, step, next, skip }}>
      {children}
      {welcome && (
        <div className="tour-welcome-backdrop" role="dialog" aria-modal="true">
          <div className="tour-welcome">
            <h2>Welcome to Dundas Billing</h2>
            <p>Let’s take a quick tour of the three things new teams do first.</p>
            <ol>
              <li>Upload a Remittance Advice</li>
              <li>Verify it against your billing data</li>
              <li>Ask Dundas AI about anything unclear</li>
            </ol>
            <div className="tour-actions">
              <button type="button" className="btn" onClick={skip}>Skip Tutorial</button>
              <button type="button" className="btn primary" onClick={start}>Start Tour</button>
            </div>
          </div>
        </div>
      )}
      {step >= 0 && current && (
        <>
          {rect ? (
            <div className="tour-spotlight" style={{ position: 'fixed', top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12, zIndex: 10000 }} />
          ) : <div className="tour-dim" />}
          <div className="tour-tooltip" style={tooltipStyle}>
            <strong>{current.title}</strong>
            <p>{current.text}</p>
            <div className="tour-actions">
              <button type="button" className="btn tiny" onClick={skip}>Skip Tour</button>
              <button type="button" className="btn primary tiny" onClick={next}>{step === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
            </div>
          </div>
        </>
      )}
    </TutorialContext.Provider>
  );
}
