import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const DateWheelContext = createContext(null);
export const useDateWheel = () => useContext(DateWheelContext);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (year, month) => new Date(year, month, 0).getDate();
const todayParts = () => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
};
const parseValue = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return todayParts();
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

function WheelColumn({ label, items, value, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    const selected = ref.current?.querySelector('[data-selected="true"]');
    if (selected) selected.scrollIntoView({ block: 'center' });
  }, [value]);
  return (
    <div className="date-wheel-column">
      <span className="date-wheel-label">{label}</span>
      <div className="date-wheel-scroll" ref={ref} role="listbox" aria-label={label}>
        {items.map((item) => (
          <button
            type="button"
            role="option"
            aria-selected={item.value === value}
            data-selected={item.value === value}
            key={item.value}
            className={`date-wheel-option${item.value === value ? ' selected' : ''}`}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DateWheelProvider({ children }) {
  const [state, setState] = useState(null);

  const lastOpen = useRef({ input: null, at: 0 });

  useEffect(() => {
    const open = (input) => {
      const now = Date.now();
      if (lastOpen.current.input === input && now - lastOpen.current.at < 300) return;
      lastOpen.current = { input, at: now };
      const parts = parseValue(input.value);
      setState({ input, ...parts });
    };
    const onClick = (e) => {
      const input = e.target.closest?.('input[type="date"]');
      if (!input || input.disabled || input.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      open(input);
    };
    const onKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const input = e.target.closest?.('input[type="date"]');
      if (!input || input.disabled || input.readOnly) return;
      e.preventDefault();
      open(input);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const close = () => setState(null);
  const setPart = (key, value) => setState((s) => {
    if (!s) return s;
    const next = { ...s, [key]: value };
    next.day = Math.min(next.day, daysInMonth(next.year, next.month));
    return next;
  });
  const apply = () => {
    if (!state?.input) return;
    const value = `${state.year}-${pad(state.month)}-${pad(state.day)}`;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(state.input, value);
    else state.input.value = value;
    state.input.dispatchEvent(new Event('input', { bubbles: true }));
    state.input.dispatchEvent(new Event('change', { bubbles: true }));
    setState(null);
  };
  const chooseToday = () => setState((s) => (s ? { ...s, ...todayParts() } : s));

  const maxDay = state ? daysInMonth(state.year, state.month) : 31;
  const yearNow = new Date().getFullYear();
  const years = Array.from({ length: 91 }, (_, i) => yearNow + 10 - i);
  const dateLabel = state
    ? new Date(state.year, state.month - 1, state.day).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : '';

  return (
    <DateWheelContext.Provider value={{ openFor: (input) => setState({ input, ...parseValue(input.value) }) }}>
      {children}
      {state && (
        <div className="date-wheel-layer" onMouseDown={close}>
          <div className="date-wheel" role="dialog" aria-modal="true" aria-label="Choose date" onMouseDown={(e) => e.stopPropagation()}>
            <div className="date-wheel-head">
              <strong>Choose a date</strong>
              <span>{dateLabel}</span>
            </div>
            <div className="date-wheel-grid">
              <WheelColumn
                label="Month"
                value={state.month}
                items={MONTHS.map((name, i) => ({ value: i + 1, label: name }))}
                onChange={(v) => setPart('month', v)}
              />
              <WheelColumn
                label="Day"
                value={state.day}
                items={Array.from({ length: maxDay }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
                onChange={(v) => setPart('day', v)}
              />
              <WheelColumn
                label="Year"
                value={state.year}
                items={years.map((y) => ({ value: y, label: String(y) }))}
                onChange={(v) => setPart('year', v)}
              />
            </div>
            <div className="date-wheel-actions">
              <button type="button" className="btn" onClick={chooseToday}>Today</button>
              <span className="date-wheel-spacer" />
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button type="button" className="btn primary" onClick={apply} id="date-wheel-apply">Apply</button>
            </div>
          </div>
        </div>
      )}
    </DateWheelContext.Provider>
  );
}
