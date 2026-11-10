import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatMoney } from '../calc.js';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';


/**
 * "Ask Dundas" — natural language over the billing data.
 *
 * The answer is prose; the sources below it are the audit trail. Every citation
 * links to the record it came from, because an answer you cannot check is worse
 * than no answer.
 */

/**
 * Turn the query plan into something a biller can sanity-check at a glance.
 *
 * The distinction that matters most is "paid" vs "billed": they come from
 * different columns and give different numbers, so the pill names the column.
 */
const TABLE_LABEL = {
  claims: 'claims',
  day_entries: 'day entries',
  tasks: 'tasks',
};

const COLUMN_LABEL = {
  'claims:paid': 'Paid Amount',
  'claims:dollars': 'Billed Amount',
  'claims:units': 'Units',
  'day_entries:dollars': 'Billed Dollars',
  'day_entries:units': 'Units',
  'day_entries:minutes': 'Minutes',
};

const GROUP_LABEL = {
  month: 'by month',
  client: 'by client',
  caretaker: 'by caretaker',
};

function describePlan(plan) {
  if (!plan?.table) return null;
  const table = TABLE_LABEL[plan.table] ?? plan.table;
  const parts = [table];

  if (plan.aggregate === 'count') {
    parts.push('record count');
  } else if (plan.aggregate === 'sum') {
    parts.push(COLUMN_LABEL[`${plan.table}:${plan.column}`] ?? plan.column ?? 'amount');
  } else {
    parts.push('records');
  }

  if (plan.group_by) parts.push(GROUP_LABEL[plan.group_by] ?? plan.group_by);
  return parts.join(' · ');
}


/**
 * Render the model's output blocks.
 *
 * It returns markdown tables for anything tabular, so a pipe table has to
 * become a real <table> — otherwise the monthly breakdown arrives as a wall of
 * "| 2025-11 | $582.66 | 2 |". Everything else stays a paragraph.
 */
function renderBlocks(text) {
  const blocks = String(text ?? '').split(/\n{2,}/);
  const out = [];
  blocks.forEach((block, bi) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const isTable = lines.length >= 2 && lines.every((l) => l.startsWith('|'));
    if (!isTable) {
      out.push(<p key={`p${bi}`}>{renderBold(block.replace(/^\s*#{1,6}\s*/gm, ''))}</p>);
      return;
    }
    const cells = (line) =>
      line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const hasDivider = /^[\s|:-]+$/.test(lines[1]);
    const header = cells(lines[0]);
    const bodyRows = lines.slice(hasDivider ? 2 : 1).map(cells);
    out.push(
      <div className="ask-table-wrap" key={`t${bi}`}>
        <table className="ask-table">
          <thead>
            <tr>
              {header.map((h, i) => (
                <th key={i}>{renderBold(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} className={ci > 0 ? 'ask-num' : ''}>
                    {renderBold(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
  return out;
}

const SUGGESTIONS = [
  "Summarize this week's billing",
  'Find unbilled claims',
  'Show top clients',
];

const VISION_STATUS_LABEL = {
  match: 'Match',
  mismatch: 'Mismatch',
  missing_in_db: 'Missing in DB',
};

function dbAmountText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? formatMoney(n) : String(value);
}

const BULK_POLL_MS = 3000;

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function bulkFileStatus(entry) {
  if (entry?.status === 'error') return 'missing_in_db';
  const records = Array.isArray(entry?.records) ? entry.records : [];
  if (!records.length) return 'missing_in_db';
  if (records.every((record) => record.status === 'match')) return 'match';
  if (records.some((record) => record.status === 'missing_in_db')) return 'missing_in_db';
  return 'mismatch';
}

function visionAmount(record) {
  const value = record?.amount_paid ?? record?.amountPaid;
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? formatMoney(n) : String(value);
}

function timeLabel(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function AiBubble({ message, sourcesOpen, onToggleSources, anchorRef }) {
  const plan = describePlan(message.plan);
  const sources = Array.isArray(message.sources) ? message.sources : [];
  return (
    <div
      className={`ask-msg ask-msg-ai${message.error ? ' ask-msg-error' : ''}`}
      ref={anchorRef}
    >
      <div className="ask-msg-meta">
        <span className="ask-ai-label">AI</span>
        <span className="ask-time">{timeLabel(message.at)}</span>
      </div>
      <div className="ask-bubble">
        {plan && (
          <span className="ask-context" title="What the database was asked for">
            <span className="ask-context-label">Querying</span>
            {plan}
          </span>
        )}
        <div className="ask-body">{renderBlocks(String(message.text ?? ''))}</div>

        {sources.length > 0 && (
          <div className="ask-sources">
            <button
              type="button"
              className="ask-sources-toggle"
              id={`ask-sources-toggle-${message.id}`}
              onClick={onToggleSources}
              aria-expanded={sourcesOpen}
            >
              <span>{sourcesOpen ? '▾' : '▸'}</span>
              Sources ({sources.length})
            </button>
            {sourcesOpen && (
              <ul className="ask-source-list">
                {sources.map((s) => (
                  <li key={`${s.type}-${s.id}`} className="ask-source">
                    <div className="ask-source-main">
                      <span className="ask-source-date">{s.date ?? '—'}</span>
                      <span className="ask-source-label">{s.name ?? s.label}</span>
                      {s.units != null && <span className="muted small">{s.units} units</span>}
                      {s.amount != null && (
                        <span className="ask-source-amount">${Number(s.amount).toFixed(2)}</span>
                      )}
                    </div>
                    {s.href && (
                      <Link className="link small" to={s.href}>
                        View record
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AskDundas() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState([]);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [pageTop, setPageTop] = useState(108);
  const [tab, setTab] = useState('chat');
  const [verifying, setVerifying] = useState(false);
  const [verifyFile, setVerifyFile] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const [verifyMode, setVerifyMode] = useState('single');
  const [bulkFiles, setBulkFiles] = useState([]);
  const [bulkJobId, setBulkJobId] = useState(null);
  const [bulkJob, setBulkJob] = useState(null);
  const [bulkError, setBulkError] = useState(null);
  const [bulkStarting, setBulkStarting] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [docIntelDebug, setDocIntelDebug] = useState(null);
  const [docIntelDebugLoading, setDocIntelDebugLoading] = useState(false);
  const inputRef = useRef(null);
  const pageRef = useRef(null);
  const threadRef = useRef(null);
  const latestAiRef = useRef(null);

  /*
   * iOS does not resize the layout viewport for the on-screen keyboard; it
   * only shrinks window.visualViewport. Track that difference and use it as the
   * composer's bottom margin so the input sits directly on the keyboard.
   */
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;

    const vv = window.visualViewport;
    const measureTop = () => {
      const top = Math.max(0, Math.round(page.getBoundingClientRect().top));
      setPageTop((current) => (current === top ? current : top));
    };

    const sync = () => {
      let nextKeyboard = 0;
      if (vv) {
        nextKeyboard = Math.max(0, Math.round(window.innerHeight - vv.height));
        setKeyboardHeight((current) => (current === nextKeyboard ? current : nextKeyboard));
      }
      // Do not remeasure while the keyboard is open: Safari may scroll the
      // focused input, which would make the page height jump.
      if (nextKeyboard === 0) measureTop();
    };

    // First measurement is with the keyboard closed.
    measureTop();
    sync();

    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);

    return () => {
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  /*
   * User messages should sit at the bottom immediately, but a long AI answer
   * should start at its top so the reader begins at the beginning rather than
   * being dropped at the end of a wall of text.
   */
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !messages.length) return undefined;
    const last = messages[messages.length - 1];

    if (last.role === 'ai') {
      const timer = setTimeout(() => {
        latestAiRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 60);
      return () => clearTimeout(timer);
    }

    thread.scrollTop = thread.scrollHeight;
    return undefined;
  }, [messages]);

  useEffect(() => {
    if (!asking) return;
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [asking]);

  useEffect(() => {
    if (!bulkJobId) return undefined;
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const data = await api.verifyRaBulkJob(bulkJobId);
        if (cancelled) return;
        setBulkJob(data);
        if (data.status === 'completed' || data.status === 'failed') {
          setBulkJobId(null);
          return;
        }
      } catch (err) {
        if (!cancelled) setBulkError(err.message);
      }
      if (!cancelled) timer = setTimeout(poll, BULK_POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bulkJobId]);

  useEffect(() => {
    let active = true;
    api
      .debugStatus()
      .then((data) => {
        if (active) setDebugMode(Boolean(data?.debug_mode));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const debugEnabled = debugMode || import.meta.env.DEV;
  const bulkResults = Array.isArray(bulkJob?.results) ? bulkJob.results : [];
  const bulkGroups = { match: [], mismatch: [], missing_in_db: [] };
  for (const entry of bulkResults) bulkGroups[bulkFileStatus(entry)].push(entry);
  const bulkVerified = bulkGroups.match.length;
  const bulkReview = bulkResults.length - bulkVerified;

  const latestAiId = messages.reduce(
    (id, message) => (message.role === 'ai' ? message.id : id),
    null
  );
  const visionRecords = Array.isArray(verifyResult?.records) ? verifyResult.records : [];
  const visionNeedsReview = visionRecords.filter((record) => record.status !== 'match').length;
  const verificationPassed =
    verifyResult?.status === 'success' &&
    visionRecords.length > 0 &&
    visionNeedsReview === 0;
  const visionEmpty = verifyResult?.status === 'success' && visionRecords.length === 0;
  const visionRawText =
    typeof verifyResult?.raw_text === 'string' ? verifyResult.raw_text : '';
  const coverPageOnly =
    visionEmpty && /remittance advice message/i.test(visionRawText);
  const recordWord = (n) => (n === 1 ? 'record' : 'records');

  async function copyRawText() {
    try {
      await navigator.clipboard.writeText(visionRawText);
      toast.success('Raw RA text copied.');
    } catch {
      toast.error('Could not copy the raw text.');
    }
  }

  function selectTab(next) {
    if (next === tab) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setTab(next);
  }

  async function verifyDocument(e) {
    e.preventDefault();
    if (!verifyFile || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      if (debugEnabled) {
        setDocIntelDebugLoading(true);
        setDocIntelDebug(null);
        try {
          setDocIntelDebug(await api.testDocIntel(verifyFile));
        } catch (error) {
          setDocIntelDebug({ error: error.message });
        } finally {
          setDocIntelDebugLoading(false);
        }
      }
      const data = await api.verifyRa(verifyFile);
      if (data?.status === 'error') {
        throw new Error(data.error || 'RA verification failed.');
      }
      setVerifyResult(Array.isArray(data) ? { status: 'success', records: data } : data);
    } catch (err) {
      const quota = /quota provisioning|initializ/i.test(err.message);
      setVerifyError(
        quota
          ? 'AI Vision is currently initializing. Please try again in a few minutes.'
          : err.message
      );
    } finally {
      setVerifying(false);
    }
  }

  async function ask(q) {
    const question = String(q ?? query).trim();
    if (!question || asking) return;

    setQuery('');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    const at = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: `u-${at}`, role: 'user', text: question, at },
    ]);
    setAsking(true);

    try {
      const r = await api.ask(question);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'ai',
          text: String(r.answer ?? ''),
          plan: r.plan,
          sources: Array.isArray(r.sources) ? r.sources : [],
          error: Boolean(r.error),
          at: Date.now(),
        },
      ]);
      if (r.understood === false) toast.error('That question cannot be answered from your data.');
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'ai',
          text: e.message,
          sources: [],
          error: true,
          at: Date.now(),
        },
      ]);
      toast.error(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function startBulk(e) {
    e.preventDefault();
    if (!bulkFiles.length || bulkStarting) return;
    setBulkStarting(true);
    setBulkError(null);
    setBulkJob(null);
    try {
      const started = await api.verifyRaBulk(bulkFiles);
      setBulkJob({
        status: started.status ?? 'queued',
        total_files: bulkFiles.length,
        processed_files: 0,
        results: [],
        error: null,
      });
      setBulkJobId(started.jobId);
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkStarting(false);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    ask();
  }

  function useSuggestion(text) {
    setQuery(text);
    inputRef.current?.focus();
  }

  return (
    <div
      className="page wide ask-page"
      id="ask-page"
      ref={pageRef}
      data-keyboard-open={keyboardHeight > 0 ? 'true' : 'false'}
      style={{
        '--ask-page-top': `${pageTop}px`,
        '--ask-keyboard-height': `${keyboardHeight}px`,
      }}
    >
      <header className="ask-header" id="ask-header">
        <button
          type="button"
          className="ask-back"
          aria-label="Back to dashboard"
          onClick={() => navigate('/')}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1>Ask Dundas</h1>
        <span className="ask-status">
          <span className="ask-status-dot" aria-hidden="true" />
          AI Online
        </span>
      </header>

      <div
        className="ask-tabs"
        role="tablist"
        aria-label="Ask Dundas sections"
        data-active={tab}
      >
        <span className="ask-tab-slider" aria-hidden="true" />
        <button
          type="button"
          role="tab"
          id="ask-tab-chat"
          aria-selected={tab === 'chat'}
          aria-controls="ask-thread"
          className={`ask-tab${tab === 'chat' ? ' active' : ''}`}
          onClick={() => selectTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          id="ask-tab-verify"
          aria-selected={tab === 'verify'}
          aria-controls="ask-verify-panel"
          className={`ask-tab${tab === 'verify' ? ' active' : ''}`}
          onClick={() => selectTab('verify')}
        >
          Verify RA
        </button>
      </div>

      <div className="ask-thread" id="ask-thread" ref={threadRef} hidden={tab !== 'chat'}>
        {messages.length === 0 && (
          <div className="ask-empty-state" id="ask-empty">
            <div className="ask-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
                <path
                  d="M12 3.5l1.7 4.6 4.8 1.7-4.8 1.7L12 16.1l-1.7-4.6L5.5 9.8l4.8-1.7L12 3.5z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"
                  fill="currentColor"
                  opacity=".8"
                />
              </svg>
            </div>
            <h2>How can I help you today?</h2>
            <p>Ask about billing, claims, or agency data.</p>
            <div className="ask-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  className="ask-suggestion"
                  key={suggestion}
                  onClick={() => useSuggestion(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) =>
          message.role === 'user' ? (
            <div className="ask-msg ask-msg-user" key={message.id}>
              <div className="ask-bubble">{message.text}</div>
            </div>
          ) : (
            <AiBubble
              key={message.id}
              message={message}
              sourcesOpen={sourcesOpen}
              onToggleSources={() => setSourcesOpen((v) => !v)}
              anchorRef={message.id === latestAiId ? latestAiRef : null}
            />
          )
        )}

        {asking && (
          <div className="ask-msg ask-msg-ai" id="ask-loading">
            <div className="ask-msg-meta">
              <span className="ask-ai-label">AI</span>
              <span className="ask-time">Thinking</span>
            </div>
            <div className="ask-bubble">
              <div className="ask-loading">
                <span className="ask-dot" /> <span className="ask-dot" />{' '}
                <span className="ask-dot" />
                <span className="muted">Analyzing data…</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {tab === 'verify' && (
        <div className="ask-verify-panel" id="ask-verify-panel" role="tabpanel" aria-labelledby="ask-tab-verify">
          <form
            className="ask-verify-card"
            onSubmit={verifyMode === 'single' ? verifyDocument : startBulk}
          >
            <div className="ask-verify-heading">
              <h2>Verify an RA letter</h2>
              <p>Upload the payer's Remittance Advice and check it against your records.</p>
            </div>

            <div className="ask-verify-mode" role="tablist" aria-label="RA upload mode">
              <button
                type="button"
                role="tab"
                aria-selected={verifyMode === 'single'}
                className={`ask-verify-mode-btn${verifyMode === 'single' ? ' active' : ''}`}
                onClick={() => {
                  setVerifyMode('single');
                  setBulkError(null);
                }}
              >
                Single File
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={verifyMode === 'bulk'}
                className={`ask-verify-mode-btn${verifyMode === 'bulk' ? ' active' : ''}`}
                onClick={() => {
                  setVerifyMode('bulk');
                  setVerifyError(null);
                }}
              >
                Bulk Upload
              </button>
            </div>

            {verifyMode === 'single' ? (
              <>
            <label className="ask-verify-drop" htmlFor="ask-verify-file">
              <span className="ask-verify-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
                  <path
                    d="M7 3.5h6.5L19 9v9.5a2 2 0 01-2 2H7a2 2 0 01-2-2v-13a2 2 0 012-2z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  <path d="M13.5 3.5V9H19" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                  <path d="M8.5 13h7M8.5 16.5h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </span>
              <span className="ask-verify-drop-copy">
                <strong>
                  {verifyFile ? verifyFile.name : 'Tap to upload RA Letter (PDF or Image)'}
                </strong>
                <span>{verifyFile ? 'Ready to verify' : 'PDF, PNG or JPG · up to 15 MB'}</span>
              </span>
              <input
                type="file"
                id="ask-verify-file"
                accept="application/pdf,image/*"
                onChange={(e) => {
                  setVerifyFile(e.target.files?.[0] ?? null);
                  setVerifyResult(null);
                  setVerifyError(null);
                  setDocIntelDebug(null);
                }}
              />
            </label>

            {debugEnabled && (
              <div className="ask-docintel-debug" id="ask-docintel-debug">
                <div className="ask-docintel-debug-head">
                  <strong>Doc Intel diagnostic</strong>
                  <span className="pill">DEBUG</span>
                </div>
                {docIntelDebugLoading ? (
                  <span className="muted small">Reading the document before verification…</span>
                ) : docIntelDebug?.error ? (
                  <span className="ask-docintel-debug-error">{docIntelDebug.error}</span>
                ) : docIntelDebug ? (
                  <div className="ask-docintel-debug-stats">
                    <span>
                      <strong>{docIntelDebug.length ?? 0}</strong> characters
                    </span>
                    <span>
                      <strong>{docIntelDebug.tables?.length ?? 0}</strong> tables
                    </span>
                  </div>
                ) : (
                  <span className="muted small">
                    Runs before verification when DEBUG_MODE is enabled.
                  </span>
                )}
              </div>
            )}

            {verifyError && <div className="alert error">{verifyError}</div>}

            <button
              type="submit"
              className="btn primary ask-verify-submit"
              id="ask-verify-submit"
              disabled={!verifyFile || verifying}
            >
              {verifying ? (
                <>
                  <span className="ask-verify-spinner" aria-hidden="true" />
                  Processing…
                </>
              ) : (
                'Verify Document'
              )}
            </button>

            {verifyResult && !visionEmpty && (
              <div
                className={`ask-verify-result ${verificationPassed ? 'ok' : 'failed'}`}
                role="status"
                aria-live="polite"
              >
                <span className="ask-verify-result-mark" aria-hidden="true">
                  {verificationPassed ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                      <path d="M12 8v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                      <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
                      <path d="M12 3.5L21 20H3L12 3.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <div>
                  <strong>
                    {verificationPassed
                      ? `All ${visionRecords.length} ${recordWord(visionRecords.length)} verified. No discrepancies found.`
                      : `Review Required. ${visionNeedsReview} of ${visionRecords.length} ${recordWord(
                          visionRecords.length
                        )} ${visionNeedsReview === 1 ? 'needs' : 'need'} attention.`}
                  </strong>
                  {verifyResult.file?.name && (
                    <span className="muted small">{verifyResult.file.name}</span>
                  )}
                </div>
              </div>
            )}

            {Array.isArray(verifyResult?.records) &&
              (visionRecords.length === 0 ? (
                visionRawText ? (
                  <div className="ask-ai-raw" id="ask-ai-raw">
                    <div className="ask-ai-raw-head">
                      <strong>
                        {coverPageOnly
                          ? 'No claims found in this document.'
                          : 'AI could not format this document into JSON.'}
                      </strong>
                      <button
                        type="button"
                        className="btn tiny"
                        id="copy-raw-ra-text"
                        onClick={copyRawText}
                      >
                        Copy Raw Text
                      </button>
                    </div>
                    <p className="muted small" style={{ margin: 0 }}>
                      {coverPageOnly
                        ? 'The AI may have only read the cover page. Ensure you are uploading the full multi-page PDF.'
                        : 'Here is the raw text extracted by Azure Document Intelligence:'}
                    </p>
                    <pre className="ask-ai-raw-text" tabIndex={0} aria-label="Raw extracted RA text">
                      {visionRawText}
                    </pre>
                  </div>
                ) : (
                  <div className="ask-vision-empty" id="ask-vision-empty">
                    <span className="ask-vision-empty-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
                        <path
                          d="M7 3.5h6.5L19 9v9.5a2 2 0 01-2 2H7a2 2 0 01-2-2v-13a2 2 0 012-2z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                        <path d="M13.5 3.5V9H19" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        <path d="M8.5 15.5l2.4 2.4 4.4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <h3>No records found in this document</h3>
                    <p>Try uploading a different RA letter, or check that the file is legible.</p>
                  </div>
                )
              ) : (
                <div className="ask-vision-records" id="ask-vision-records">
                  <div className="ask-vision-records-head">
                    <strong>Extracted records</strong>
                    <span className="muted small">
                      {visionRecords.length} {recordWord(visionRecords.length)}
                    </span>
                  </div>
                  <>
                    <div className="ask-vision-table-wrap hide-on-mobile">
                      <table className="ask-vision-table">
                        <thead>
                          <tr>
                            <th>Client</th>
                            <th>Date of Service</th>
                            <th className="num">RA Amount</th>
                            <th className="num">DB Amount</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visionRecords.map((record, index) => {
                            const ra = record.ra_data ?? record;
                            const db = record.db_data ?? {};
                            const status = record.status ?? 'missing_in_db';
                            return (
                              <React.Fragment key={index}>
                                <tr>
                                  <td>
                                    <strong>
                                      {ra.client_name ?? ra.clientName ?? '—'}
                                    </strong>
                                    <span className="ask-vision-sub">
                                      {ra.member_id ?? ra.memberId ?? '—'}
                                    </span>
                                  </td>
                                  <td>{ra.date_of_service ?? ra.dateOfService ?? '—'}</td>
                                  <td className="num">{visionAmount(ra)}</td>
                                  <td className="num">{dbAmountText(db.paid_amount)}</td>
                                  <td>
                                    <span className={`ask-vision-badge ${status}`}>
                                      {VISION_STATUS_LABEL[status] ?? status}
                                    </span>
                                  </td>
                                </tr>
                                {record.discrepancy && (
                                  <tr className="ask-vision-discrepancy-row">
                                    <td colSpan={5}>{record.discrepancy}</td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="ask-vision-cards show-on-mobile">
                      {visionRecords.map((record, index) => {
                        const ra = record.ra_data ?? record;
                        const db = record.db_data ?? {};
                        const status = record.status ?? 'missing_in_db';
                        return (
                          <div className="ask-vision-card" key={index}>
                            <div className="ask-vision-card-top">
                              <strong>{ra.client_name ?? ra.clientName ?? '—'}</strong>
                              <span className={`ask-vision-badge ${status}`}>
                                {VISION_STATUS_LABEL[status] ?? status}
                              </span>
                            </div>
                            <div className="ask-vision-card-meta">
                              {ra.member_id ?? ra.memberId ?? '—'} ·{' '}
                              {ra.date_of_service ?? ra.dateOfService ?? '—'}
                            </div>
                            <div className="ask-vision-card-amounts">
                              <span>RA {visionAmount(ra)}</span>
                              <span>DB {dbAmountText(db.paid_amount)}</span>
                            </div>
                            {record.discrepancy && (
                              <p className="ask-vision-card-note">{record.discrepancy}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
              </div>
            ))}
              </>
            ) : (
              <>
                <label className="ask-verify-drop ask-bulk-drop" htmlFor="ask-bulk-files">
                  <span className="ask-verify-drop-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
                      <path
                        d="M7 3.5h6.5L19 9v9.5a2 2 0 01-2 2H7a2 2 0 01-2-2v-13a2 2 0 012-2z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinejoin="round"
                      />
                      <path d="M13.5 3.5V9H19" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="M8.5 13h7M8.5 16.5h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="ask-verify-drop-copy">
                    <strong>
                      {bulkFiles.length
                        ? `${bulkFiles.length} file${bulkFiles.length === 1 ? '' : 's'} selected`
                        : 'Select RA files for bulk verification'}
                    </strong>
                    <span>Select up to 300 PDFs or images</span>
                  </span>
                  <input
                    type="file"
                    id="ask-bulk-files"
                    accept=".pdf,image/*"
                    multiple
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      setBulkError(picked.length > 300 ? 'You can select at most 300 files.' : null);
                      setBulkFiles(picked.slice(0, 300));
                      setBulkJob(null);
                      setBulkJobId(null);
                    }}
                  />
                </label>

                {bulkFiles.length > 0 && (
                  <ul className="ask-bulk-file-list" id="ask-bulk-file-list">
                    {bulkFiles.map((file, index) => (
                      <li key={`${file.name}-${index}`}>
                        <span className="ask-bulk-check" aria-hidden="true">✓</span>
                        <span className="ask-bulk-file-name">{file.name}</span>
                        <span className="ask-bulk-file-size">{formatFileSize(file.size)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {bulkError && <div className="alert error">{bulkError}</div>}

                <button
                  type="submit"
                  className="btn primary ask-verify-submit"
                  id="ask-bulk-submit"
                  disabled={!bulkFiles.length || bulkStarting}
                >
                  {bulkStarting ? (
                    <>
                      <span className="ask-verify-spinner" aria-hidden="true" />
                      Starting…
                    </>
                  ) : (
                    `Start Bulk Verification${bulkFiles.length ? ` (${bulkFiles.length})` : ''}`
                  )}
                </button>

                {bulkJob && (
                  <div className="ask-bulk-status" id="ask-bulk-status">
                    <div className="ask-bulk-progress-head">
                      <strong>
                        {bulkJob.status === 'completed'
                          ? 'Bulk verification complete'
                          : bulkJob.status === 'failed'
                            ? 'Bulk verification failed'
                            : `Processing ${bulkJob.processed_files ?? 0} of ${
                                bulkJob.total_files ?? bulkFiles.length
                              }...`}
                      </strong>
                      <span className="muted small">
                        {Math.round(
                          ((bulkJob.processed_files ?? 0) /
                            Math.max(1, bulkJob.total_files ?? bulkFiles.length)) *
                            100
                        )}
                        %
                      </span>
                    </div>
                    <div className="ask-bulk-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.round(
                            ((bulkJob.processed_files ?? 0) /
                              Math.max(1, bulkJob.total_files ?? bulkFiles.length)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>

                    {bulkJob.status === 'failed' && (
                      <div className="alert error" id="ask-bulk-error">
                        {bulkJob.error || 'Bulk verification failed.'}
                      </div>
                    )}

                    {bulkJob.status === 'completed' && (
                      <>
                        <div
                          className={`ask-verify-result ${bulkReview === 0 ? 'ok' : 'failed'}`}
                          role="status"
                          aria-live="polite"
                        >
                          <span className="ask-verify-result-mark" aria-hidden="true">
                            {bulkReview === 0 ? (
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                                <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                                <path d="M12 8v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                                <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
                                <path d="M12 3.5L21 20H3L12 3.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                              </svg>
                            )}
                          </span>
                          <div>
                            <strong>
                              {bulkReview === 0
                                ? `All ${bulkVerified} files verified. No discrepancies found.`
                                : `${bulkVerified} of ${bulkResults.length} files verified, ${bulkReview} need review.`}
                            </strong>
                          </div>
                        </div>

                        <div className="ask-bulk-groups">
                          {[
                            ['match', 'Match'],
                            ['mismatch', 'Mismatch'],
                            ['missing_in_db', 'Missing'],
                          ].map(([key, label]) =>
                            bulkGroups[key].length ? (
                              <section className="ask-bulk-group" key={key}>
                                <h3>
                                  {label} <span>{bulkGroups[key].length}</span>
                                </h3>
                                <ul>
                                  {bulkGroups[key].map((entry, index) => (
                                    <li key={`${entry.file_name}-${index}`}>
                                      <span>{entry.file_name}</span>
                                      {entry.error && <small>{entry.error}</small>}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            ) : null
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </form>
        </div>
      )}

      <form
        className="ask-composer"
        id="ask-composer"
        onSubmit={onSubmit}
        hidden={tab !== 'chat'}
        style={{ marginBottom: keyboardHeight > 0 ? `${keyboardHeight}px` : 0 }}
      >
        <div className="ask-input-row">
          <input
            ref={inputRef}
            id="ask-input"
            className="ask-input"
            name="question"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="send"
            placeholder="Ask a question about your data…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="submit"
            className="btn primary ask-send"
            id="ask-send"
            disabled={asking || !query.trim()}
          >
            {asking ? '…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The model returns light markdown: **bold**, and sometimes "## Heading".
 * Both are rendered; anything else is shown as plain text.
 */
function renderBold(text) {
  const cleaned = String(text ?? '').replace(/^\s*#{1,6}\s*/gm, '');
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : (
      p
    )
  );
}
