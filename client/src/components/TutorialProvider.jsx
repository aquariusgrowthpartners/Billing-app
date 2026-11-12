import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api.js';
import { SAMPLE_CLIENT, loadSampleFile, dispatchSampleFile } from '../demoSamples.js';

const TutorialContext = createContext(null);
export const useTutorial = () => useContext(TutorialContext);

export const TUTORIAL_STEPS = [
  { target: '[data-tour="uploads-sa"]', title: 'Service Agreements', sample: 'sa', path: '/uploads?tab=sa',
    text: 'A Service Agreement (SA) is the authorization that defines what care a client is approved for. Load the sample SA, review the Pre-Check, then Save.' },
  { target: '[data-tour="uploads-claims"]', title: 'Claim Submissions', sample: 'claim', path: '/uploads?tab=claims',
    text: 'A Status 46 claim means the payer accepted it and payment is pending. Load the sample claim, review, then Save it as Pending.' },
  { target: '[data-tour="uploads-ra"]', title: 'Remittance Advice', sample: 'ra', path: '/uploads?tab=ra',
    text: 'An RA is the payer’s record of what was paid. Load the sample RA and verify it — the pending claim moves to Paid automatically.' },
  { target: '[data-tour="settings"]', title: 'AI Setup', path: '/settings#brand-logo',
    text: 'Give Dundas AI a few quick questions your team asks most. Tap the button, keep the pre-filled prompts, then Save.' },
  { target: '[data-tour="chat-input"]', title: 'Use the AI', path: '/ask',
    text: 'Ask a quick question. Dundas answers using your real billing data — reference the Example Client to watch it work.' },
  { target: '[data-tour="home"]', title: 'You’re all set', path: '/',
    text: 'That’s the full workflow. Finish the tour and explore the app on your own.' },
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
  const [exampleOpen, setExampleOpen] = useState(true);
  const [sampleBusy, setSampleBusy] = useState(false);

  useEffect(() => {
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
  const start = () => { setWelcome(false); go(0); };
  const skip = async () => {
    setWelcome(false);
    setStep(-1);
    await markComplete(isDemo);
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
  const back = () => { if (step > 0) go(step - 1); };
  const loadSample = async (kind) => {
    setSampleBusy(true);
    try {
      const file = await loadSampleFile(kind);
      dispatchSampleFile(kind, file);
    } finally {
      setSampleBusy(false);
    }
  };

  const current = TUTORIAL_STEPS[step];
  return (
    <TutorialContext.Provider value={{ start, step, next, skip }}>
      {children}
      {welcome && (
        <div className="tour-welcome-backdrop" role="dialog" aria-modal="true">
          <div className="tour-welcome">
            <h2>Welcome to Dundas Billing</h2>
            <p>Let’s walk through a full billing cycle using sample data. You can click the real app the whole time.</p>
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
        <>
          {exampleOpen && (
            <aside className="tutorial-example-card" id="tutorial-example-card">
              <div className="tutorial-example-head">
                <strong>Example Client Profile</strong>
                <button type="button" className="btn tiny" onClick={() => setExampleOpen(false)}>Hide</button>
              </div>
              <div className="tutorial-example-body">
                <span><strong>Name:</strong> {SAMPLE_CLIENT.name}</span>
                <span><strong>Client ID:</strong> {SAMPLE_CLIENT.id}</span>
                <span><strong>DOB:</strong> {SAMPLE_CLIENT.dob}</span>
                <span><strong>MA #:</strong> {SAMPLE_CLIENT.ma_number}</span>
                <button
                  type="button"
                  className="btn primary tutorial-sample-btn"
                  onClick={() => current.sample ? loadSample(current.sample) : navigate(current.path)}
                  disabled={sampleBusy}
                >
                  {current.sample ? (sampleBusy ? 'Loading sample…' : `Load Sample ${current.sample.toUpperCase()}`) : 'Open'}
                </button>
              </div>
            </aside>
          )}
          {!exampleOpen && (
            <button type="button" className="onboarding-toggle tutorial-example-toggle" onClick={() => setExampleOpen(true)}>
              Show Example Client
            </button>
          )}
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
        </>
      )}
    </TutorialContext.Provider>
  );
}
