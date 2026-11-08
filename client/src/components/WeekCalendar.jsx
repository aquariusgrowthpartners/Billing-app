import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';
import Modal from './Modal.jsx';
import {
  computeEntry,
  weekStart,
  addDays,
  todayISO,
  formatMoney,
  formatMinutes,
  formatLongDate,
} from '../calc.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** 90 -> { hours: 1, minutes: 30 } */
function toHM(totalMinutes) {
  const t = Math.max(0, Math.trunc(Number(totalMinutes) || 0));
  return { hours: Math.floor(t / 60), minutes: t % 60 };
}

/** { hours: 1, minutes: 30 } -> 90 */
function toTotal(hours, minutes) {
  const h = Math.max(0, Math.trunc(Number(hours) || 0));
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  return h * 60 + m;
}

/** A saved row -> editable draft. */
function draftFromEntry(entry) {
  const { hours, minutes } = toHM(entry?.minutes_worked ?? 0);
  return {
    start_time: entry?.start_time ?? '',
    hours,
    minutes,
    notes: entry?.notes ?? '',
    caretaker_id: entry?.caretaker_id != null ? String(entry.caretaker_id) : '',
  };
}

/** Display name for an entry's caretaker, or null when none was recorded. */
function caretakerNameOf(entry) {
  const name = `${entry?.caretaker_first_name ?? ''} ${entry?.caretaker_last_name ?? ''}`.trim();
  return name || null;
}

const EMPTY_DRAFT = { start_time: '', hours: 0, minutes: 0, notes: '', caretaker_id: '' };

/**
 * Mon–Sun week of day entries for one client. Terms (minutes per unit, rate,
 * daily max) always come from the selected agreement, never from local state.
 */
export default function WeekCalendar({
  denialMarkers = {},
  // Part 3/4 — the Schedule tab's view switch, rendered in this header so it
  // shares the row with the week navigation.
  scheduleView = 'calendar',
  onChooseView = () => {},
  rebillCount = 0,
  rebillSlot = null,
  weekLabel = null,
  onWeekChange = null,
  clientId,
  agreements = [],
  agreementId,
  onSelectAgreement,
  onRequestNewAgreement,
  initialWeek,
}) {
  const [start, setStart] = useState(() => weekStart(initialWeek || todayISO()));
  // the parent needs the visible week to scope the badge and the rebill list
  useEffect(() => {
    onWeekChange?.(start, addDays(start, 6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  const [entries, setEntries] = useState({});
  const [drafts, setDrafts] = useState({});
  const [savingDates, setSavingDates] = useState([]);
  const [savedFlash, setSavedFlash] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notesOpen, setNotesOpen] = useState({});
  const [clipboard, setClipboard] = useState(null); // { hours, minutes, caretaker_id }
  const [caretakers, setCaretakers] = useState([])
  const [selected, setSelected] = useState(() => new Set());
  // Submitted/Paid claims overlapping the visible week: edits inside them are
  // allowed but warned about, because the claim's totals go stale.
  const [lockedClaims, setLockedClaims] = useState([]);
  // Bulk edit bar. Empty strings mean "leave this field alone" so a caretaker-
  // only bulk edit can never wipe somebody's hours.
  const [bulk, setBulk] = useState({ hours: '', minutes: '', caretaker_id: '' });
  const [confirmBulk, setConfirmBulk] = useState(null); // { mode, ...stats }
  const [bulkToast, setBulkToast] = useState(null);
  const selectAllRef = useRef(null);
  const toastTimer = useRef(null);
  const flashTimer = useRef(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const today = todayISO();

  // Active caretakers for the pickers. Anyone already recorded on a visible day
  // is added back in further down, so retired staff still display correctly.
  useEffect(() => {
    let cancelled = false;
    api
      .caretakers()
      .then((d) => !cancelled && setCaretakers(d.caretakers))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const agreement = agreements.find((a) => Number(a.id) === Number(agreementId)) ?? null;

  /* ---------------------------------------------------------------- loading */

  const loadWeek = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    api
      .getWeekEntries(clientId, start)
      .then((d) => {
        const map = {};
        for (const e of d.entries) map[e.work_date] = e;
        setEntries(map);
        setLockedClaims(d.locked_claims ?? []);
        setDrafts(Object.fromEntries(d.entries.map((e) => [e.work_date, draftFromEntry(e)])));
        setSelected(new Set());
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clientId, start]);

  useEffect(loadWeek, [loadWeek]);

  // If the week was logged under a different agreement than the selected one,
  // follow the week's agreement so displayed rates match what was saved.
  useEffect(() => {
    if (!onSelectAgreement) return;
    const ids = Object.values(entries)
      .map((e) => e.agreement_id)
      .filter(Boolean);
    if (!ids.length) return;
    const latest = ids[ids.length - 1];
    if (!agreementId || !ids.includes(Number(agreementId))) onSelectAgreement(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  /* ------------------------------------------------------------ draft state */

  const draftFor = useCallback(
    (date) => drafts[date] ?? draftFromEntry(entries[date]),
    [drafts, entries]
  );

  const minutesFor = useCallback((date) => {
    const d = draftFor(date);
    return toTotal(d.hours, d.minutes);
  }, [draftFor]);

  function isDirty(date) {
    const draft = drafts[date];
    if (!draft) return false;
    const saved = entries[date];
    const savedCaretaker = saved?.caretaker_id != null ? String(saved.caretaker_id) : '';
    return (
      toTotal(draft.hours, draft.minutes) !== (saved?.minutes_worked ?? 0) ||
      (draft.notes ?? '') !== (saved?.notes ?? '') ||
      // Changing only the caretaker must still count as an edit, or the change
      // would never be offered for saving.
      String(draft.caretaker_id ?? '') !== savedCaretaker ||
      // Start time is part of the visit window, so it counts as an edit too.
      (draft.start_time ?? '') !== (saved?.start_time ?? '')
    );
  }

  const computedFor = useCallback(
    (date) => {
      // A saved, untouched day keeps the terms it was actually logged at.
      const entryAgreementId = entries[date]?.agreement_id;
      const terms =
        entryAgreementId && !isDirty(date)
          ? agreements.find((a) => Number(a.id) === Number(entryAgreementId)) ?? agreement
          : agreement;

      const c = computeEntry({
        minutes_worked: minutesFor(date),
        minutes_per_unit: terms?.minutes_per_unit,
        rate_per_unit: terms?.rate_per_unit,
        max_units_per_day: terms?.max_units_per_day,
      });
      return { ...c, terms };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minutesFor, agreement, agreements, entries, drafts]
  );

  const dirtyDates = days.filter(isDirty);

  /** The locked (Submitted/Paid) claim whose period covers this date, if any. */
  function lockedClaimFor(date) {
    return (
      lockedClaims.find(
        (c) => c.period_start && c.period_end && date >= c.period_start && date <= c.period_end
      ) ?? null
    );
  }

  /** Active caretakers plus anyone already recorded on a visible day. */
  function caretakerOptionsFor(currentId) {
    const list = [...caretakers];
    const seen = new Set(list.map((t) => String(t.id)));
    for (const entry of Object.values(entries)) {
      if (entry?.caretaker_id == null) continue;
      const id = String(entry.caretaker_id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id: entry.caretaker_id,
        first_name: entry.caretaker_first_name ?? '',
        last_name: entry.caretaker_last_name ?? '',
      });
    }
    if (currentId && !seen.has(String(currentId))) {
      // A value with no matching row (shouldn't happen) still renders.
      list.push({ id: currentId, first_name: '(unknown)', last_name: '' });
    }
    return list.sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
    );
  }

  function caretakerLabel(id) {
    if (!id) return 'Unassigned';
    const found = caretakerOptionsFor(id).find((t) => String(t.id) === String(id));
    return found ? `${found.first_name} ${found.last_name}`.trim() : 'Unassigned';
  }

  function setDraft(date, patch) {
    setDrafts((prev) => ({
      ...prev,
      [date]: { ...(prev[date] ?? draftFromEntry(entries[date])), ...patch },
    }));
  }

  /* ----------------------------------------------------------------- saving */

  const save = useCallback(
    async (dates, draftsOverride) => {
      if (!clientId || !dates.length || !agreement) return;
      const draftOf = (date) => draftsOverride?.[date] ?? draftFor(date);

      setSavingDates(dates);
      setError(null);
      try {
        const payload = dates.map((date) => {
          const d = draftOf(date);
          return {
            client_id: clientId,
            agreement_id: agreement.id,
            work_date: date,
            // The server combines these into minutes_worked.
            hours: Number(d.hours) || 0,
            minutes: Number(d.minutes) || 0,
            caretaker_id: d.caretaker_id === '' ? null : Number(d.caretaker_id),
            start_time: d.start_time || null,
            notes: d.notes || null,
          };
        });
        const res = await api.saveWeek(payload);

        const failed = res.results.filter((r) => r.error);
        if (failed.length) {
          setError(failed.map((f) => `${f.work_date}: ${f.error}`).join('; '));
        }

        setEntries((prev) => {
          const next = { ...prev };
          for (const r of res.results) {
            if (r.entry) next[r.work_date] = r.entry;
            else if (!r.error) delete next[r.work_date];
          }
          return next;
        });
        setDrafts((prev) => {
          const next = { ...prev };
          for (const date of dates) {
            const r = res.results.find((x) => x.work_date === date);
            if (r?.error) continue;
            next[date] = r?.entry ? draftFromEntry(r.entry) : { ...EMPTY_DRAFT };
          }
          return next;
        });
        if (!failed.length) {
          setSavedFlash(`${dates.length} day${dates.length > 1 ? 's' : ''} saved`);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => {
            flashTimer.current = null;
            setSavedFlash(null);
          }, 2500);
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setSavingDates([]);
      }
    },
    [clientId, agreement, draftFor]
  );

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyDates.length) save(dirtyDates);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirtyDates, save]);

  /* -------------------------------------------------------- copy and paste */

  function copyDay(date) {
    const d = draftFor(date);
    // The caretaker travels with the hours, so pasting a whole week keeps the
    // same person on every day without re-picking them.
    setClipboard({
      hours: Number(d.hours) || 0,
      minutes: Number(d.minutes) || 0,
      caretaker_id: d.caretaker_id ?? '',
      start_time: d.start_time ?? '',
    });
    setSelected(new Set());
  }

  /** Apply the clipboard to one or more days, then persist them straight away. */
  const paste = useCallback(
    async (dates) => {
      if (!clipboard || !dates.length) return;
      const patch = {
        hours: clipboard.hours,
        minutes: clipboard.minutes,
        caretaker_id: clipboard.caretaker_id ?? '',
        start_time: clipboard.start_time ?? '',
      };

      setDrafts((prev) => {
        const next = { ...prev };
        for (const date of dates) {
          next[date] = { ...(next[date] ?? draftFromEntry(entries[date])), ...patch };
        }
        return next;
      });
      setSelected(new Set());

      if (!agreement) {
        setError('Add an agreement first — units and dollars cannot be calculated without one.');
        return;
      }

      // Persist immediately so Paste really is one click.
      const override = {};
      for (const date of dates) {
        override[date] = { ...draftFromEntry(entries[date]), ...patch };
      }
      await save(dates, override);
    },
    [clipboard, agreement, entries, save]
  );

  function toggleSelected(date) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  const selectedDates = days.filter((d) => selected.has(d));
  const allSelected = days.length > 0 && selectedDates.length === days.length;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(days));
  }

  function clearSelected() {
    setSelected(new Set());
  }

  function toast(message) {
    // Cancel any pending hide from an earlier toast. Without this an old timer
    // wipes the new message the instant it appears.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setBulkToast(message);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setBulkToast(null);
    }, 3000);
  }

  /** What the selected days currently hold, used for the confirmations. */
  const bulkStats = useMemo(() => {
    let withData = 0;
    let claimed = 0;
    let lockedClaimed = 0;
    let existing = 0;
    for (const date of selectedDates) {
      const e = entries[date];
      if (!e) continue;
      existing += 1;
      if ((e.minutes_worked ?? 0) > 0 || e.notes) withData += 1;
      if (e.claim_id != null) {
        claimed += 1;
        // Submitted/Paid claims are the ones that cannot be regenerated in place.
        if (e.claim_status === 'Submitted' || e.claim_status === 'Paid') lockedClaimed += 1;
      }
    }
    return { dates: selectedDates, withData, claimed, lockedClaimed, existing };
  }, [selectedDates, entries]);

  // Indeterminate is not a JSX attribute, so it has to be set on the node.
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedDates.length > 0 && !allSelected;
    }
  }, [selectedDates.length, allSelected]);

  // Escape clears the selection (unless a confirmation is open, which Escape
  // should dismiss instead).
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape' || confirmBulk) return;
      setSelected((prev) => (prev.size ? new Set() : prev));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmBulk]);

  /** Row click toggles selection, but never when the click is on a control. */
  function onRowClick(e, date) {
    if (e.target.closest('input, select, button, textarea, a, label')) return;
    if (window.getSelection?.()?.toString()) return; // don't fight text selection
    toggleSelected(date);
  }

  function onRowKeyDown(e, date) {
    if (e.target.closest('input, select, textarea, button')) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleSelected(date);
    }
  }

  /* ------------------------------------------------------- bulk editing */

  /** Which fields the bulk bar would actually change. */
  function bulkPatch() {
    const patch = {};
    if (bulk.hours !== '') patch.hours = Math.max(0, Math.trunc(Number(bulk.hours) || 0));
    if (bulk.minutes !== '') patch.minutes = Math.max(0, Math.min(59, Math.trunc(Number(bulk.minutes) || 0)));
    if (bulk.caretaker_id !== '') {
      patch.caretaker_id = bulk.caretaker_id === 'none' ? '' : bulk.caretaker_id;
    }
    return patch;
  }

  function beginBulkApply() {
    const patch = bulkPatch();
    if (!Object.keys(patch).length) {
      toast('Set Hours, Minutes or Caretaker first — blank fields are left unchanged.');
      return;
    }
    if (bulkStats.withData > 0) {
      setConfirmBulk({ mode: 'apply', patch, ...bulkStats });
      return;
    }
    applyBulk(patch, bulkStats.dates);
  }

  async function applyBulk(patch, dates) {
    if (!agreement) {
      setError('Add an agreement first — units and dollars cannot be calculated without one.');
      setConfirmBulk(null);
      return;
    }
    const override = {};
    for (const date of dates) {
      override[date] = { ...draftFromEntry(entries[date]), ...patch };
    }
    setDrafts((prev) => {
      const next = { ...prev };
      for (const date of dates) next[date] = override[date];
      return next;
    });

    await save(dates, override);
    setConfirmBulk(null);
    setBulk({ hours: '', minutes: '', caretaker_id: '' });
    clearSelected();
    toast(`Applied to ${dates.length} day${dates.length === 1 ? '' : 's'}`);
  }

  function beginBulkDelete() {
    const withEntries = bulkStats.dates.filter((d) => entries[d]);
    if (!withEntries.length) {
      toast('Nothing to delete — those days are already empty.');
      return;
    }
    setConfirmBulk({ mode: 'delete', dates: withEntries, ...bulkStats });
  }

  async function deleteBulk(dates) {
    try {
      const res = await api.bulkDeleteDayEntries({ client_id: clientId, dates });
      setConfirmBulk(null);
      clearSelected();
      await loadWeek();
      toast(`Deleted ${res.deleted} entr${res.deleted === 1 ? 'y' : 'ies'}`);
    } catch (e) {
      setError(e.message);
      setConfirmBulk(null);
    }
  }

  /* ----------------------------------------------------------------- totals */

  const totals = useMemo(() => {
    let minutes = 0;
    let units = 0;
    let dollars = 0;
    let overMaxDays = 0;
    for (const day of days) {
      const c = computedFor(day);
      minutes += c.minutes_worked;
      units += c.units;
      dollars += c.dollars;
      if (c.over_max_units_per_day) overMaxDays += 1;
    }
    return { minutes, units, dollars: Math.round(dollars * 100) / 100, overMaxDays };
  }, [days, computedFor]);

  /* ----------------------------------------------------------------- render */

  const noAgreement = agreements.length === 0;

  return (
    <section className="card" id="week-calendar">
      <div className="card-head">
        <div>
          <h2>Week calendar</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {formatLongDate(start)} – {formatLongDate(addDays(start, 6))}
            {totals.overMaxDays > 0 && (
              <span className="pill overdue tiny">
                {totals.overMaxDays} day{totals.overMaxDays > 1 ? 's' : ''} over daily max
              </span>
            )}
          </p>
        </div>
        <div className="week-nav">
          {/* Part 3 — segmented view toggle + the shared rebill badge */}
          <div className="segmented" id="schedule-view-toggle" role="tablist">
            <button
              role="tab"
              aria-selected={scheduleView === 'calendar'}
              className={`seg-btn ${scheduleView === 'calendar' ? 'active' : ''}`}
              id="view-calendar"
              onClick={() => onChooseView('calendar')}
            >
              Calendar
            </button>
            <button
              role="tab"
              aria-selected={scheduleView === 'rebill'}
              className={`seg-btn ${scheduleView === 'rebill' ? 'active' : ''}`}
              id="view-rebill"
              onClick={() => onChooseView('rebill')}
            >
              Rebill List
            </button>
          </div>
          <span
            className={`ds-badge ${rebillCount > 0 ? 'ds-badge-red' : 'ds-badge-gray'}`}
            id="rebill-badge"
          >
            {rebillCount} day{rebillCount === 1 ? '' : 's'} need rebill this week
          </span>
          <button className="btn" onClick={() => setStart(addDays(start, -7))}>
            ← Prev
          </button>
          <button className="btn" onClick={() => setStart(weekStart(today))}>
            This week
          </button>
          <button className="btn" onClick={() => setStart(addDays(start, 7))}>
            Next →
          </button>
          <label className="inline-label jump-to-week">
            Jump to
            <input
              type="date"
              name="jump-to-week"
              aria-label="Jump to a week"
              value={start}
              onChange={(e) => e.target.value && setStart(weekStart(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="calendar-bar">
        <label className="inline-label">
          Agreement
          <select
            value={agreementId ?? ''}
            onChange={(e) => onSelectAgreement?.(e.target.value ? Number(e.target.value) : null)}
            disabled={noAgreement}
          >
            {noAgreement && <option value="">— none yet —</option>}
            {agreements.map((a) => (
              <option key={a.id} value={a.id}>
                {a.agreement_number ?? `#${a.id}`} · {a.minutes_per_unit}min/unit ·{' '}
                {formatMoney(a.rate_per_unit)}/unit
                {a.end_date ? ` · ends ${a.end_date}` : ''}
              </option>
            ))}
          </select>
        </label>

        {agreement ? (
          <div className="terms">
            <span>
              <strong>{formatMoney(agreement.rate_per_unit)}</strong>/unit
            </span>
            <span className="dot">·</span>
            <span>
              <strong>{agreement.minutes_per_unit}</strong> min/unit
            </span>
            <span className="dot">·</span>
            <span>
              max <strong>{agreement.max_units_per_day ?? '—'}</strong>/day
            </span>
          </div>
        ) : (
          <div className="terms muted">No agreement terms loaded</div>
        )}

        <div className="spacer" />

        {clipboard && (
          <div className="clipboard">
            <span>
              Copied <strong>{formatMinutes(toTotal(clipboard.hours, clipboard.minutes))}</strong>
              {' · '}
              {clipboard.caretaker_id ? caretakerLabel(clipboard.caretaker_id) : 'Unassigned'}
            </span>
            {selectedDates.length > 0 && (
              <button className="btn tiny primary" onClick={() => paste(selectedDates)}>
                Paste to {selectedDates.length} day{selectedDates.length > 1 ? 's' : ''}
              </button>
            )}
            <button
              className="btn tiny ghost"
              onClick={() => {
                setClipboard(null);
                setSelected(new Set());
              }}
              title="Clear copied time"
            >
              ×
            </button>
          </div>
        )}

        {savedFlash && <span className="pill ok">{savedFlash}</span>}
        <button
          className="btn primary"
          disabled={!dirtyDates.length || savingDates.length > 0 || !agreement}
          onClick={() => save(dirtyDates)}
        >
          {savingDates.length
            ? 'Saving…'
            : `Save ${dirtyDates.length || ''} day${dirtyDates.length === 1 ? '' : 's'}`.trim()}
        </button>
      </div>

      {noAgreement && (
        <div className="alert warn banner-action">
          <div>
            <strong>This client has no agreement yet.</strong> Units and dollars come from the
            agreement's minutes-per-unit and rate, so there is nothing to calculate from.
          </div>
          {onRequestNewAgreement && (
            <button className="btn primary" onClick={onRequestNewAgreement}>
              + Add agreement
            </button>
          )}
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {lockedClaims.length > 0 && (
        <div className="alert warn locked-warning" id="locked-claim-warning">
          <strong>This week includes a locked claim.</strong>{' '}
          {lockedClaims.map((c) => c.claim_name).join(', ')}{' '}
          {lockedClaims.length === 1 ? 'is' : 'are'} already{' '}
          {lockedClaims[0].status.toLowerCase()}. This day belongs to a locked claim. Revert the
          claim to Draft to edit. You can still make changes — the claim totals will not update
          until you regenerate the claim.
        </div>
      )}

      {scheduleView === 'rebill' ? (
        rebillSlot
      ) : (
      <div className="table-scroll hide-on-mobile">
        <table className="table week-table">
          <thead>
            <tr>
              <th className="select-col">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="day-check"
                  id="select-all-days"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all days in this week"
                  title="Select all days"
                />
              </th>
              <th className="day-col">Day</th>
              <th>Date</th>
              <th className="start-col">Start</th>
              <th className="hm-col">Hours</th>
              <th className="hm-col">Minutes</th>
              <th className="caretaker-col">Caretaker</th>
              <th className="num">Units</th>
              <th className="num">Rate</th>
              <th className="num">Dollars</th>
              <th className="notes-col">Notes</th>
              <th className="tools-col"></th>
              <th className="status-col"></th>
            </tr>
          </thead>
          <tbody>
            {days.map((date, i) => {
              const c = computedFor(date);
              const draft = draftFor(date);
              const dirty = isDirty(date);
              const saving = savingDates.includes(date);
              const isFuture = date > today;
              const isToday = date === today;
              const hasAgreement = Boolean(c.terms);
              const showNotes = notesOpen[date] || Boolean(draft.notes);
              const total = minutesFor(date);
              const isEmpty = total === 0;
              // A day on an ARCHIVED claim is not "on claim" any more: the
              // claim has been retired, so it must not lock the day or warn.
              const onClaim = Boolean(entries[date]?.claim_id) && !entries[date]?.claim_archived;

              return (
                <tr
                  key={date}
                  tabIndex={0}
                  onClick={(e) => onRowClick(e, date)}
                  onKeyDown={(e) => onRowKeyDown(e, date)}
                  className={[
                    dirty ? 'row-dirty' : '',
                    c.over_max_units_per_day ? 'row-over' : '',
                    isToday ? 'row-today' : '',
                    isFuture ? 'row-future' : '',
                    selected.has(date) ? 'row-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td className="select-col">
                    <input
                      type="checkbox"
                      className="day-check"
                      name={`select-${date}`}
                      checked={selected.has(date)}
                      onChange={() => toggleSelected(date)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${WEEKDAYS[i]} ${date}`}
                    />
                  </td>
                  <td className="day-col">
                    <strong>{WEEKDAYS[i]}</strong>
                  </td>
                  <td className="nowrap muted day-cell">
                    {formatLongDate(date)}
                    {/* B2 — 14px markers, top-right, clear of the row content */}
                    {denialMarkers[date]?.state === 'unrecovered' && (
                      <span
                        className="day-marker day-marker-red"
                        id={`day-flag-${date}`}
                        title={`Original claim denied. Rebill needed. ${denialMarkers[date].days_open} days open.`}
                      >
                        ⚑
                      </span>
                    )}
                    {denialMarkers[date]?.state === 'recovered' && (
                      <span
                        className="day-marker day-marker-green"
                        id={`day-check-${date}`}
                        title={`Previously denied, recovered via rebill on ${denialMarkers[date].recovered_dos}.`}
                      >
                        ✓
                      </span>
                    )}
                  </td>
                  <td className="start-col">
                    <input
                      type="time"
                      className="start-input"
                      name={`start-${date}`}
                      aria-label={`Start time for ${date}`}
                      value={draft.start_time ?? ''}
                      onChange={(e) => setDraft(date, { start_time: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty) save([date]);
                      }}
                    />
                    {!draft.start_time && <span className="sub muted">08:00</span>}
                  </td>
                  <td className="hm-col">
                    <input
                      className="hm-input"
                      name={`hours-${date}`}
                      type="number"
                      min="0"
                      max="23"
                      step="1"
                      inputMode="numeric"
                      placeholder="0"
                      aria-label={`Hours worked on ${date}`}
                      value={draft.hours || ''}
                      onChange={(e) => setDraft(date, { hours: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty) save([date]);
                      }}
                    />
                  </td>
                  <td className="hm-col">
                    <input
                      className="hm-input"
                      name={`minutes-${date}`}
                      type="number"
                      min="0"
                      max="59"
                      step="5"
                      inputMode="numeric"
                      placeholder="0"
                      aria-label={`Minutes worked on ${date}`}
                      value={draft.minutes || ''}
                      onChange={(e) => setDraft(date, { minutes: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty) save([date]);
                      }}
                    />
                    {total > 0 && <span className="sub hm-hint">{formatMinutes(total)}</span>}
                  </td>
                  <td className="caretaker-col">
                    <select
                      className="caretaker-select"
                      name={`caretaker-${date}`}
                      aria-label={`Caretaker for ${date}`}
                      value={draft.caretaker_id ?? ''}
                      onChange={(e) => setDraft(date, { caretaker_id: e.target.value })}
                    >
                      <option value="">Unassigned</option>
                      {caretakerOptionsFor(draft.caretaker_id).map((t) => (
                        <option key={t.id} value={String(t.id)}>
                          {t.last_name}, {t.first_name}
                        </option>
                      ))}
                    </select>
                    {draft.caretaker_id === '' ? (
                      <span className="sub muted">nobody recorded</span>
                    ) : (
                      <span className="sub caretaker-name">{caretakerLabel(draft.caretaker_id)}</span>
                    )}
                  </td>
                  <td className="num">
                    {hasAgreement ? (
                      <>
                        <strong>{c.units}</strong>
                        {c.remainder_minutes > 0 && (
                          <div className="sub" title="Minutes that round down and are not billable">
                            +{c.remainder_minutes}m dropped
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num muted">{hasAgreement ? formatMoney(c.rate_per_unit) : '—'}</td>
                  <td className="num dollars">{hasAgreement ? formatMoney(c.dollars) : '—'}</td>
                  <td className="notes-col">
                    {showNotes ? (
                      <input
                        className="notes-input"
                        name={`notes-${date}`}
                        type="text"
                        placeholder="—"
                        aria-label={`Notes for ${date}`}
                        value={draft.notes}
                        onChange={(e) => setDraft(date, { notes: e.target.value })}
                      />
                    ) : (
                      <button
                        className="btn tiny ghost"
                        onClick={() => setNotesOpen((p) => ({ ...p, [date]: true }))}
                      >
                        + note
                      </button>
                    )}
                  </td>
                  <td className="tools-col">
                    {!isEmpty && (
                      <button
                        className="btn tiny ghost"
                        title={`Copy ${formatMinutes(total)}`}
                        aria-label={`Copy ${WEEKDAYS[i]}`}
                        onClick={() => copyDay(date)}
                      >
                        Copy
                      </button>
                    )}
                    {isEmpty && clipboard && (
                      <>
                        <button
                          className="btn tiny primary"
                          title={`Paste ${formatMinutes(
                            toTotal(clipboard.hours, clipboard.minutes)
                          )}`}
                          aria-label={`Paste into ${WEEKDAYS[i]}`}
                          onClick={() => paste([date])}
                        >
                          Paste
                        </button>
                      </>
                    )}
                  </td>
                  <td className="status-col">
                    {saving ? (
                      <span className="muted small">saving…</span>
                    ) : dirty ? (
                      // Save is offered even when the day sits on a claim, so an
                      // edit can always be committed.
                      <>
                        <button className="btn tiny primary" onClick={() => save([date])}>
                          Save
                        </button>
                        {onClaim && <span className="pill draft tiny">on claim</span>}
                      </>
                    ) : onClaim ? (
                      <span className="pill draft tiny">on claim</span>
                    ) : c.over_max_units_per_day ? (
                      <span className="pill overdue tiny" title={c.reason ?? ''}>
                        over max{c.max_units_per_day ? ` (${c.max_units_per_day})` : ''}
                      </span>
                    ) : entries[date] ? (
                      <span className="pill ok tiny">saved</span>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="select-col"></td>
              <td colSpan={2}>
                <strong>Week total</strong>
              </td>
              <td className="start-col"></td>
              <td colSpan={2} className="hm-col">
                <strong>{formatMinutes(totals.minutes)}</strong>
              </td>
              <td></td>
              <td className="num">
                <strong>{agreement ? totals.units : '—'}</strong>
              </td>
              <td></td>
              <td className="num dollars">
                <strong>{agreement ? formatMoney(totals.dollars) : '—'}</strong>
              </td>
              <td colSpan={3}>
                <span className="muted small">
                  {clipboard
                    ? 'Tick empty days, then paste to all of them at once.'
                    : 'Use Copy on a filled day, then Paste onto the empty ones.'}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      )}

      {scheduleView !== 'rebill' && (
        <div className="show-on-mobile week-cards" id="week-cards">
          {days.map((date, i) => {
            const c = computedFor(date);
            const draft = draftFor(date);
            const dirty = isDirty(date);
            const saving = savingDates.includes(date);
            const isFuture = date > today;
            const isToday = date === today;
            const hasAgreement = Boolean(c.terms);
            const total = minutesFor(date);
            const isEmpty = total === 0;
            const onClaim = Boolean(entries[date]?.claim_id) && !entries[date]?.claim_archived;

            return (
              <div
                key={date}
                className={[
                  'week-card',
                  isToday ? 'week-card-today' : '',
                  selected.has(date) ? 'week-card-selected' : '',
                  dirty ? 'week-card-dirty' : '',
                  onClaim ? 'week-card-locked' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                id={`week-card-${date}`}
              >
                <div className="week-card-head">
                  <input
                    type="checkbox"
                    className="day-check"
                    id={`week-card-check-${date}`}
                    checked={selected.has(date)}
                    onChange={() => toggleSelected(date)}
                    aria-label={`Select ${WEEKDAYS[i]} ${date}`}
                  />
                  <span className="week-card-day">
                    {WEEKDAYS[i]} <span className="muted">{formatLongDate(date)}</span>
                  </span>
                  {denialMarkers[date]?.state === 'unrecovered' && (
                    <span
                      className="day-marker unrecovered"
                      id={`day-flag-card-${date}`}
                      title={`Original claim denied. Rebill needed. ${denialMarkers[date].days_open} days open.`}
                    >
                      !
                    </span>
                  )}
                  {denialMarkers[date]?.state === 'recovered' && (
                    <span
                      className="day-marker recovered"
                      id={`day-check-card-${date}`}
                      title={`Previously denied, recovered via rebill on ${denialMarkers[date].recovered_dos}.`}
                    >
                      ✓
                    </span>
                  )}
                </div>

                <label className="week-card-field">
                  <span>Start</span>
                  <input
                    type="time"
                    name={`start-card-${date}`}
                    value={draft.start_time ?? ''}
                    onChange={(e) => setDraft(date, { start_time: e.target.value })}
                    aria-label={`Start time for ${date}`}
                  />
                </label>

                <div className="week-card-hm">
                  <label className="week-card-field">
                    <span>Hours</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      name={`hours-card-${date}`}
                      placeholder="0"
                      value={draft.hours ?? ''}
                      onChange={(e) => setDraft(date, { hours: e.target.value })}
                      aria-label={`Hours worked on ${date}`}
                    />
                  </label>
                  <label className="week-card-field">
                    <span>Minutes</span>
                    <input
                      type="number"
                      min="0"
                      max="59"
                      step="5"
                      inputMode="numeric"
                      name={`minutes-card-${date}`}
                      placeholder="0"
                      value={draft.minutes ?? ''}
                      onChange={(e) => setDraft(date, { minutes: e.target.value })}
                      aria-label={`Minutes worked on ${date}`}
                    />
                  </label>
                </div>

                <label className="week-card-field">
                  <span>Caretaker</span>
                  <select
                    name={`caretaker-card-${date}`}
                    value={draft.caretaker_id ?? ''}
                    onChange={(e) => setDraft(date, { caretaker_id: e.target.value })}
                    aria-label={`Caretaker for ${date}`}
                  >
                    <option value="">Unassigned</option>
                    {caretakerOptionsFor(draft.caretaker_id).map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.last_name}, {t.first_name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="week-card-foot">
                  <span className="muted small">
                    {isEmpty ? 'no hours' : `${formatMinutes(total)} · ${c.units ?? 0} units`}
                    {hasAgreement && c.dollars ? ` · ${formatMoney(c.dollars)}` : ''}
                  </span>
                  {dirty && (
                    <button
                      className="btn tiny primary"
                      id={`week-card-save-${date}`}
                      disabled={saving}
                      onClick={() => save([date])}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loading && <div className="empty">Loading week…</div>}

      <p className="muted small" style={{ padding: '0 16px 14px' }}>
        Enter hours and minutes separately, and pick who worked — the server adds the minutes up
        before calculating units.
        Historical days keep the rate they were logged at, even if the agreement rate changes later.
        Tick days (or click a row) to bulk edit; Space toggles a focused row, Escape clears.
        ⌘S / Ctrl+S saves the week.
      </p>

      {selectedDates.length > 0 && (
        <div className="bulk-bar" id="bulk-action-bar">
          <div className="bulk-inner">
            <span className="bulk-count" id="bulk-count">
              {selectedDates.length} day{selectedDates.length === 1 ? '' : 's'} selected
            </span>
            <label className="inline-label">
              Hours
              <input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                name="bulk-hours"
                placeholder="—"
                value={bulk.hours}
                onChange={(e) => setBulk((b) => ({ ...b, hours: e.target.value }))}
              />
            </label>
            <label className="inline-label">
              Minutes
              <input
                type="number"
                min="0"
                max="59"
                step="5"
                inputMode="numeric"
                name="bulk-minutes"
                placeholder="—"
                value={bulk.minutes}
                onChange={(e) => setBulk((b) => ({ ...b, minutes: e.target.value }))}
              />
            </label>
            <label className="inline-label">
              Caretaker
              <select
                name="bulk-caretaker"
                value={bulk.caretaker_id}
                onChange={(e) => setBulk((b) => ({ ...b, caretaker_id: e.target.value }))}
              >
                <option value="">— keep —</option>
                <option value="none">Unassigned</option>
                {caretakers.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.last_name}, {t.first_name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" id="bulk-apply" onClick={beginBulkApply}>
              Apply to Selected
            </button>
            <button className="btn" id="bulk-clear" onClick={clearSelected}>
              Clear Selected
            </button>
            <button className="btn danger" id="bulk-delete" onClick={beginBulkDelete}>
              Delete Selected Entries
            </button>
          </div>
          <p className="bulk-hint">Blank Hours/Minutes/Caretaker fields are left unchanged.</p>
        </div>
      )}

      {bulkToast && (
        <div className="toast" id="bulk-toast" role="status">
          {bulkToast}
        </div>
      )}

      {confirmBulk && (
        <Modal
          title={confirmBulk.mode === 'apply' ? 'Overwrite selected days?' : 'Delete entries?'}
          onClose={() => setConfirmBulk(null)}
          width={540}
        >
          {confirmBulk.mode === 'apply' ? (
            <p id="bulk-confirm-message">
              <strong>
                {confirmBulk.withData} of these days already have data. Overwrite them?
              </strong>{' '}
              Applying to {confirmBulk.dates.length} selected day
              {confirmBulk.dates.length === 1 ? '' : 's'}.
            </p>
          ) : (
            <p id="bulk-confirm-message">
              <strong>
                Delete entries for {confirmBulk.dates.length} day
                {confirmBulk.dates.length === 1 ? '' : 's'}? This cannot be undone.
              </strong>
            </p>
          )}

          {confirmBulk.claimed > 0 && (
            <div className="alert warn" id="bulk-claim-warning">
              {confirmBulk.lockedClaimed > 0 ? (
                <>
                  {confirmBulk.lockedClaimed} of these days are on a submitted claim.{' '}
                  {confirmBulk.mode === 'apply'
                    ? "Editing won't update the claim until you regenerate it."
                    : "Deleting them leaves that claim's totals stale until you regenerate it."}
                </>
              ) : (
                <>
                  {confirmBulk.claimed} of these days are on a draft claim.{' '}
                  {confirmBulk.mode === 'apply'
                    ? 'Regenerate the claim afterwards to update its totals.'
                    : "Deleting them leaves that claim's totals stale until you regenerate it."}
                </>
              )}
            </div>
          )}

          <div className="form-actions">
            <button className="btn" onClick={() => setConfirmBulk(null)}>
              Cancel
            </button>
            {confirmBulk.mode === 'apply' ? (
              <button
                className="btn primary"
                id="bulk-confirm-apply"
                onClick={() => applyBulk(confirmBulk.patch, confirmBulk.dates)}
              >
                Overwrite
              </button>
            ) : (
              <button
                className="btn danger"
                id="bulk-confirm-delete"
                onClick={() => deleteBulk(confirmBulk.dates)}
              >
                Delete
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
