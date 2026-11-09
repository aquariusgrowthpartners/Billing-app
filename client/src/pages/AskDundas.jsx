import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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

export default function AskDundas() {
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState(null);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [pageTop, setPageTop] = useState(108);
  const inputRef = useRef(null);
  const pageRef = useRef(null);

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

  async function ask(q) {
    const question = String(q ?? query).trim();
    // Empty submits are a no-op: no fetch, and nothing to clear.
    if (!question || asking) return;
    // Clear optimistically so the next question can be typed while this one is
    // still in flight. The submitted text lives on `result.question`, so it is
    // not lost from the transcript.
    setQuery('');
    // Dismiss the iOS keyboard before the answer lands so the response is
    // readable immediately rather than hidden behind the keyboard.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setAsking(true);
    setResult(null);
    try {
      const r = await api.ask(question);
      setResult({ question, ...r });
      if (r.understood === false) toast.error('That question cannot be answered from your data.');
    } catch (e) {
      setResult({ question, answer: e.message, sources: [], understood: false, error: true });
      toast.error(e.message);
    } finally {
      setAsking(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  }

  return (
    <div
      className="page wide ask-page"
      id="ask-page"
      ref={pageRef}
      style={{
        '--ask-page-top': `${pageTop}px`,
        '--ask-keyboard-height': `${keyboardHeight}px`,
      }}
    >
      <div className="page-head">
        <div>
          <h1>
            Ask Dundas <span className="ask-spark">✨</span>
          </h1>
          <p className="muted">Ask a question about your billing data in plain English.</p>
        </div>
      </div>

      <div className="ask-thread" id="ask-thread">
        {!result && !asking && (
          <div className="ask-welcome" id="ask-welcome">
            <div className="empty-state-icon" aria-hidden="true">🤖</div>
            <p className="empty-state-title">What would you like to know?</p>
            <p className="muted small">
              Answers include the math and a list of the records used, so you can check them.
            </p>
          </div>
        )}

        {asking && (
          <div className="ask-card" id="ask-loading">
            <div className="ask-loading">
              <span className="ask-dot" /> <span className="ask-dot" /> <span className="ask-dot" />
              <span className="muted">Analyzing data…</span>
            </div>
          </div>
        )}

        {result && (
          <div className="ask-card" id="ask-answer">
            <p className="ask-question">{result.question}</p>
            {describePlan(result.plan) && (
              <span className="ask-context" id="ask-context" title="What the database was asked for">
                <span className="ask-context-label">Querying</span>
                {describePlan(result.plan)}
              </span>
            )}
            <div className="ask-body" id="ask-text">
              {renderBlocks(String(result.answer ?? ''))}
            </div>

            {result.sources?.length > 0 && (
              <div className="ask-sources" id="ask-sources">
                <button
                  className="ask-sources-toggle"
                  id="ask-sources-toggle"
                  onClick={() => setSourcesOpen((v) => !v)}
                  aria-expanded={sourcesOpen}
                >
                  <span>{sourcesOpen ? '▾' : '▸'}</span>
                  Sources ({result.sources.length})
                </button>
                {sourcesOpen && (
                  <ul className="ask-source-list">
                    {result.sources.map((s) => (
                      <li key={`${s.type}-${s.id}`} className="ask-source" id={`ask-source-${s.id}`}>
                        <div className="ask-source-main">
                          <span className="ask-source-date">{s.date ?? '—'}</span>
                          <span className="ask-source-label">{s.name ?? s.label}</span>
                          {s.units != null && (
                            <span className="muted small">{s.units} units</span>
                          )}
                          {s.amount != null && (
                            <span className="ask-source-amount">
                              ${Number(s.amount).toFixed(2)}
                            </span>
                          )}
                        </div>
                        {s.href && (
                          <Link className="link small" to={s.href} id={`ask-view-${s.id}`}>
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
        )}
      </div>

      <div
        className="ask-composer"
        id="ask-composer"
        style={{
          marginBottom: keyboardHeight > 0 ? `${keyboardHeight}px` : 0,
          paddingBottom:
            keyboardHeight > 0
              ? '12px'
              : 'calc(12px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="ask-input-row">
          <input
            ref={inputRef}
            id="ask-input"
            className="ask-input"
            placeholder="Ask a question about your data…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="btn primary ask-send"
            id="ask-send"
            disabled={asking || !query.trim()}
            onClick={() => ask()}
          >
            {asking ? '…' : 'Send'}
          </button>
        </div>
      </div>
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
