import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addSets, createWorkout } from '../lib/workouts.js';
import { fetchPlannedWorkoutForDate, markPlannedWorkoutCompleted } from '../lib/plans.js';
import { EXERCISES } from '../lib/exercises.js';
import { useAuth } from '../lib/auth.jsx';

/**
 * Mobile-first workout logger. Two modes:
 *
 * - **Plan mode** — when the selected date has a non-completed planned
 *   workout, the logger renders one row per planned set with the target
 *   reps/weight visible and an actual reps/weight input. Saving creates a
 *   workout linked to the plan and sets linked to each planned set, then
 *   marks the plan `completed`. Extra (non-planned) sets can still be added
 *   via the small freeform form below.
 * - **Freeform mode** — when no plan exists, the existing single-row form
 *   is shown for ad-hoc logging. No plan linkage is written.
 */
export default function WorkoutLogger() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [performedAt, setPerformedAt] = useState(() => toDateInputValue(new Date()));
  const [exercise, setExercise] = useState(EXERCISES[0]);
  const [customExercise, setCustomExercise] = useState('');
  const [reps, setReps] = useState(5);
  const [weight, setWeight] = useState(0);
  const [unit, setUnit] = useState('kg');
  const [pendingSets, setPendingSets] = useState([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // { kind: 'success'|'error', text: string }

  // Plan-mode state
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  // actualsByPlannedSetId: { [plannedSetId]: { reps, weight, unit } }
  const [actualsByPlannedSetId, setActualsByPlannedSetId] = useState({});

  // Load the planned workout for the selected date whenever it changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setPlanLoading(true);
      const { data, error } = await fetchPlannedWorkoutForDate({ date: performedAt });
      if (cancelled) return;
      if (error) {
        setPlan(null);
        setActualsByPlannedSetId({});
      } else {
        setPlan(data);
        const initial = {};
        (data?.sets ?? []).forEach((s) => {
          initial[s.id] = {
            reps: s.target_reps,
            weight: s.target_weight,
            unit: s.unit
          };
        });
        setActualsByPlannedSetId(initial);
      }
      setPlanLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [performedAt]);

  const effectiveExerciseName = useMemo(() => {
    if (exercise === '__custom__') return customExercise.trim();
    return exercise;
  }, [exercise, customExercise]);

  function handleAddSet(e) {
    e.preventDefault();
    if (!effectiveExerciseName) return;
    setPendingSets((prev) => [
      ...prev,
      {
        exercise_name: effectiveExerciseName,
        set_index: prev.length + 1,
        reps: Number(reps),
        weight: Number(weight),
        unit
      }
    ]);
    setStatus(null);
  }

  function handleRemovePendingSet(index) {
    setPendingSets((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, set_index: i + 1 }))
    );
  }

  function handleActualChange(plannedSetId, field, value) {
    setActualsByPlannedSetId((prev) => ({
      ...prev,
      [plannedSetId]: {
        ...(prev[plannedSetId] ?? {}),
        [field]: field === 'unit' ? value : Number(value)
      }
    }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);

    try {
      const performedAtIso = new Date(`${performedAt}T00:00:00`).toISOString();
      const { data: workout, error: wErr } = await createWorkout({
        performed_at: performedAtIso,
        planned_workout_id: plan?.id ?? null
      });
      if (wErr || !workout) {
        setStatus({ kind: 'error', text: wErr?.message ?? 'Could not save workout.' });
        return;
      }

      const plannedSetRows = (plan?.sets ?? []).map((s) => {
        const actual = actualsByPlannedSetId[s.id] ?? {
          reps: s.target_reps,
          weight: s.target_weight,
          unit: s.unit
        };
        return {
          workout_id: workout.id,
          exercise_name: s.exercise_name,
          set_index: s.set_index,
          reps: actual.reps,
          weight: actual.weight,
          unit: actual.unit,
          planned_set_id: s.id
        };
      });
      const extraRows = pendingSets.map((s) => ({ ...s, workout_id: workout.id }));

      const { error: sErr } = await addSets({
        workout_id: workout.id,
        sets: [...plannedSetRows, ...extraRows]
      });
      if (sErr) {
        setStatus({ kind: 'error', text: sErr.message });
        return;
      }

      if (plan?.id) {
        const { error: planErr } = await markPlannedWorkoutCompleted({
          plannedWorkoutId: plan.id
        });
        if (planErr) {
          // The actual workout saved; just surface the bookkeeping failure.
          setStatus({
            kind: 'error',
            text: `Workout saved, but could not mark plan completed: ${planErr.message}`
          });
          setPendingSets([]);
          return;
        }
      }

      setStatus({ kind: 'success', text: 'Workout saved.' });
      setPendingSets([]);
      setPlan(null);
      setActualsByPlannedSetId({});
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  // Group pending (freeform) sets by exercise for the live preview.
  const groupedPending = useMemo(() => {
    const out = new Map();
    pendingSets.forEach((s) => {
      if (!out.has(s.exercise_name)) out.set(s.exercise_name, []);
      out.get(s.exercise_name).push(s);
    });
    return out;
  }, [pendingSets]);

  // Group plan sets by exercise for the plan-mode preview.
  const planByExercise = useMemo(() => {
    const out = new Map();
    (plan?.sets ?? []).forEach((s) => {
      if (!out.has(s.exercise_name)) out.set(s.exercise_name, []);
      out.get(s.exercise_name).push(s);
    });
    return out;
  }, [plan]);

  const planMode = !!plan && plan.sets.length > 0;

  return (
    <main className="container workout-logger">
      <header className="screen-header">
        <h1>GymTrack</h1>
        <nav className="screen-tabs">
          <Link to="/workout" className="tab active" data-testid="tab-workout">
            Log
          </Link>
          <Link to="/history" className="tab" data-testid="tab-history">
            History
          </Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleSignOut}
            data-testid="sign-out"
          >
            Sign out
          </button>
        </nav>
      </header>

      <div className="date-row">
        <label htmlFor="performed-at">Date</label>
        <input
          id="performed-at"
          type="date"
          value={performedAt}
          onChange={(e) => setPerformedAt(e.target.value)}
          data-testid="date-input"
        />
      </div>

      {planMode ? (
        <section className="plan-mode" data-testid="plan-mode">
          <h2 className="section-title">{plan.title}</h2>
          {plan.notes ? <p className="plan-notes">{plan.notes}</p> : null}

          {Array.from(planByExercise.entries()).map(([exerciseName, sets]) => (
            <div
              key={exerciseName}
              className="plan-exercise"
              data-testid={`plan-exercise-${exerciseName}`}
            >
              <h3 className="exercise-title">{exerciseName}</h3>
              <table className="plan-sets-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Target</th>
                    <th scope="col">Reps</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {sets.map((s) => {
                    const actual = actualsByPlannedSetId[s.id] ?? {};
                    return (
                      <tr key={s.id} data-testid={`plan-set-row-${s.set_index}`}>
                        <td>{s.set_index}</td>
                        <td>
                          {s.target_reps} × {s.target_weight} {s.unit}
                        </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            value={actual.reps ?? ''}
                            onChange={(e) =>
                              handleActualChange(s.id, 'reps', e.target.value)
                            }
                            data-testid={`actual-reps-${s.set_index}`}
                            aria-label={`Actual reps for ${exerciseName} set ${s.set_index}`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={actual.weight ?? ''}
                            onChange={(e) =>
                              handleActualChange(s.id, 'weight', e.target.value)
                            }
                            data-testid={`actual-weight-${s.set_index}`}
                            aria-label={`Actual weight for ${exerciseName} set ${s.set_index}`}
                          />
                        </td>
                        <td>
                          <select
                            value={actual.unit ?? 'kg'}
                            onChange={(e) =>
                              handleActualChange(s.id, 'unit', e.target.value)
                            }
                            data-testid={`actual-unit-${s.set_index}`}
                            aria-label={`Unit for ${exerciseName} set ${s.set_index}`}
                          >
                            <option value="kg">kg</option>
                            <option value="lb">lb</option>
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ) : null}

      {!planMode && planLoading ? (
        <p data-testid="plan-loading">Checking for planned workout…</p>
      ) : null}

      <form className="set-form" onSubmit={handleAddSet} data-testid="set-form">
        <p className="form-hint">
          {planMode
            ? 'Add an extra (non-planned) set below if needed.'
            : 'Freeform logging — pick an exercise and add sets.'}
        </p>
        <label className="form-row">
          <span>Exercise</span>
          <select
            value={exercise}
            onChange={(e) => setExercise(e.target.value)}
            data-testid="exercise-select"
          >
            {EXERCISES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="__custom__">Other (type below)…</option>
          </select>
        </label>

        {exercise === '__custom__' ? (
          <label className="form-row">
            <span>Custom name</span>
            <input
              type="text"
              value={customExercise}
              onChange={(e) => setCustomExercise(e.target.value)}
              placeholder="e.g. Trap-bar Deadlift"
              data-testid="custom-exercise"
            />
          </label>
        ) : null}

        <div className="form-row form-row-inline">
          <label className="form-field">
            <span>Reps</span>
            <input
              type="number"
              min="1"
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              data-testid="reps-input"
            />
          </label>
          <label className="form-field">
            <span>Weight</span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              data-testid="weight-input"
            />
          </label>
          <label className="form-field form-field-unit">
            <span>Unit</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="unit-select">
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </label>
        </div>

        <div className="btn-row">
          <button type="submit" className="btn-secondary" data-testid="add-set">
            Add set
          </button>
        </div>
      </form>

      <section className="pending-sets" data-testid="pending-sets">
        <h2 className="section-title">Extra sets ({pendingSets.length})</h2>
        {pendingSets.length === 0 ? (
          <p className="empty-hint">No extra sets added.</p>
        ) : (
          Array.from(groupedPending.entries()).map(([exerciseName, sets]) => (
            <div
              key={exerciseName}
              className="pending-exercise"
              data-testid={`group-${exerciseName}`}
            >
              <h3 className="exercise-title">{exerciseName}</h3>
              <ol className="pending-list">
                {sets.map((s) => {
                  const globalIndex = pendingSets.indexOf(s);
                  return (
                    <li
                      key={`${s.exercise_name}-${s.set_index}-${globalIndex}`}
                      className="pending-item"
                    >
                      <span className="pending-set-index">#{s.set_index}</span>
                      <span className="pending-set-detail">
                        {s.reps} reps × {s.weight} {s.unit}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => handleRemovePendingSet(globalIndex)}
                        aria-label={`Remove set ${s.set_index}`}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
      </section>

      {status ? (
        <div
          className={`status show ${status.kind}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
          data-testid="save-status"
        >
          {status.text}
        </div>
      ) : null}

      <div className="btn-row btn-row-sticky">
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || (!planMode && pendingSets.length === 0)}
          data-testid="save-workout"
        >
          {saving ? 'Saving…' : 'Save workout'}
        </button>
      </div>
    </main>
  );
}

function toDateInputValue(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
