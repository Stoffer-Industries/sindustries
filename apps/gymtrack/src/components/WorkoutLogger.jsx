import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addSets, createWorkout } from '../lib/workouts.js';
import { EXERCISES } from '../lib/exercises.js';
import { useAuth } from '../lib/auth.jsx';

/**
 * Mobile-first workout logger. Local state holds the in-progress sets until
 * Save is tapped; on Save we createWorkout + addSets in sequence.
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

  function handleRemoveSet(index) {
    setPendingSets((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, set_index: i + 1 }))
    );
  }

  async function handleSave() {
    if (pendingSets.length === 0) {
      setStatus({ kind: 'error', text: 'Add at least one set before saving.' });
      return;
    }
    setSaving(true);
    setStatus(null);

    const performedAtIso = new Date(`${performedAt}T00:00:00`).toISOString();
    const { data: workout, error: wErr } = await createWorkout({ performed_at: performedAtIso });
    if (wErr || !workout) {
      setSaving(false);
      setStatus({ kind: 'error', text: wErr?.message ?? 'Could not save workout.' });
      return;
    }

    const { error: sErr } = await addSets({ workout_id: workout.id, sets: pendingSets });
    setSaving(false);
    if (sErr) {
      setStatus({ kind: 'error', text: sErr.message });
      return;
    }

    setStatus({ kind: 'success', text: 'Workout saved.' });
    setPendingSets([]);
  }

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  // Group pending sets by exercise for the live preview.
  const grouped = useMemo(() => {
    const out = new Map();
    pendingSets.forEach((s) => {
      if (!out.has(s.exercise_name)) out.set(s.exercise_name, []);
      out.get(s.exercise_name).push(s);
    });
    return out;
  }, [pendingSets]);

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

      <form className="set-form" onSubmit={handleAddSet} data-testid="set-form">
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
        <h2 className="section-title">In this workout ({pendingSets.length})</h2>
        {pendingSets.length === 0 ? (
          <p className="empty-hint">No sets yet — fill the form above and tap Add set.</p>
        ) : (
          Array.from(grouped.entries()).map(([exerciseName, sets]) => (
            <div key={exerciseName} className="pending-exercise" data-testid={`group-${exerciseName}`}>
              <h3 className="exercise-title">{exerciseName}</h3>
              <ol className="pending-list">
                {sets.map((s) => {
                  const globalIndex = pendingSets.indexOf(s);
                  return (
                    <li key={`${s.exercise_name}-${s.set_index}-${globalIndex}`} className="pending-item">
                      <span className="pending-set-index">#{s.set_index}</span>
                      <span className="pending-set-detail">
                        {s.reps} reps × {s.weight} {s.unit}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => handleRemoveSet(globalIndex)}
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
          disabled={saving || pendingSets.length === 0}
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