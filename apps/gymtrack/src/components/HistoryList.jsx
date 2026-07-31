import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listSetsForWorkouts, listWorkouts } from '../lib/workouts.js';
import { supabase } from '../lib/supabase.js';

/**
 * Last 30 days of workouts for the signed-in user, grouped by date. When a
 * workout is linked to a planned workout, the planned target reps/weight are
 * fetched and rendered alongside the actual results so the user can compare.
 */
export default function HistoryList() {
  const [workouts, setWorkouts] = useState(null);
  const [sets, setSets] = useState([]);
  const [targetsByPlannedSetId, setTargetsByPlannedSetId] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const { data: ws, error: wErr } = await listWorkouts();
      if (cancelled) return;
      if (wErr) {
        setError(wErr.message);
        setLoading(false);
        return;
      }
      setWorkouts(ws ?? []);
      if (ws && ws.length > 0) {
        const ids = ws.map((w) => w.id);
        const { data: ss, error: sErr } = await listSetsForWorkouts({ workout_ids: ids });
        if (cancelled) return;
        if (sErr) {
          setError(sErr.message);
          setSets([]);
        } else {
          setSets(ss ?? []);
          // Pull planned-set targets for any set linked back to a plan so the
          // history view can show target alongside actual.
          const plannedSetIds = Array.from(
            new Set((ss ?? []).map((s) => s.planned_set_id).filter(Boolean))
          );
          if (plannedSetIds.length > 0) {
            const { data: pSets, error: psErr } = await supabase
              .from('planned_workout_sets')
              .select('id, target_reps, target_weight, unit')
              .in('id', plannedSetIds);
            if (cancelled) return;
            if (!psErr && pSets) {
              const map = {};
              pSets.forEach((p) => {
                map[p.id] = {
                  target_reps: p.target_reps,
                  target_weight: Number(p.target_weight),
                  unit: p.unit
                };
              });
              setTargetsByPlannedSetId(map);
            }
          } else {
            setTargetsByPlannedSetId({});
          }
        }
      } else {
        setSets([]);
        setTargetsByPlannedSetId({});
      }
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setsByWorkout = useMemo(() => {
    const map = new Map();
    sets.forEach((s) => {
      if (!map.has(s.workout_id)) map.set(s.workout_id, []);
      map.get(s.workout_id).push(s);
    });
    return map;
  }, [sets]);

  const groupedByDate = useMemo(() => {
    if (!workouts) return [];
    const map = new Map();
    workouts.forEach((w) => {
      const dateKey = w.performed_at.slice(0, 10); // YYYY-MM-DD
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey).push(w);
    });
    return Array.from(map.entries()).sort(([a], [b]) => (a < b ? 1 : -1));
  }, [workouts]);

  return (
    <main className="container history-list">
      <header className="screen-header">
        <h1>History</h1>
        <nav className="screen-tabs">
          <Link to="/workout" className="tab" data-testid="tab-workout">
            Log
          </Link>
          <Link to="/history" className="tab active" data-testid="tab-history">
            History
          </Link>
          <Link to="/workouts" className="tab" data-testid="tab-workouts">
            Workouts
          </Link>
        </nav>
      </header>

      {loading ? <p data-testid="history-loading">Loading…</p> : null}
      {error ? (
        <div className="status show error" role="alert" data-testid="history-error">
          {error}
        </div>
      ) : null}

      {!loading && !error && (workouts?.length ?? 0) === 0 ? (
        <p className="empty-hint" data-testid="history-empty">
          No workouts in the last 30 days. Log one from the Log tab.
        </p>
      ) : null}

      <ul className="history-days" data-testid="history-days">
        {groupedByDate.map(([dateKey, dayWorkouts]) => (
          <li key={dateKey} className="history-day" data-testid={`day-${dateKey}`}>
            <h2 className="day-title">{formatDate(dateKey)}</h2>
            <ul className="history-day-list">
              {dayWorkouts.map((w) => {
                const ws = (setsByWorkout.get(w.id) ?? []).sort(
                  (a, b) => a.set_index - b.set_index
                );
                const linkedToPlan = !!w.planned_workout_id;
                return (
                  <li
                    key={w.id}
                    className={`history-workout${linkedToPlan ? ' has-plan' : ''}`}
                    data-testid={`workout-${w.id}`}
                  >
                    <div className="history-workout-meta">
                      {ws.length} set{ws.length === 1 ? '' : 's'}
                      {linkedToPlan ? (
                        <span
                          className="plan-badge"
                          data-testid={`plan-badge-${w.id}`}
                        >
                          Planned
                        </span>
                      ) : null}
                    </div>
                    <ul className="history-sets">
                      {ws.map((s) => {
                        const target = s.planned_set_id
                          ? targetsByPlannedSetId[s.planned_set_id] ?? null
                          : null;
                        return (
                          <li key={s.id} className="history-set">
                            <span className="set-exercise">{s.exercise_name}</span>
                            <span className="set-detail">
                              #{s.set_index} · {s.reps} × {s.weight} {s.unit}
                            </span>
                            {target ? (
                              <span
                                className="set-target"
                                data-testid={`set-target-${s.id}`}
                              >
                                target {target.target_reps} × {target.target_weight}{' '}
                                {target.unit}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}

function formatDate(yyyyMmDd) {
  // Render as e.g. "Sun 12 Jul 2026"
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
