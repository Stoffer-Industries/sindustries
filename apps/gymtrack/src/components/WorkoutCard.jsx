import { Link } from 'react-router-dom';

/**
 * Format a `scheduled_for` (YYYY-MM-DD) string as e.g. "Sun 12 Jul 2026".
 */
function formatScheduledDate(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return yyyyMmDd;
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Compute the visual-distinction status for a planned workout date, relative
 * to today's local date.
 * - 'overdue' — strictly before today
 * - 'today'   — equals today
 * - 'upcoming' — strictly after today
 *
 * Exported so the WorkoutsTab unit test can exercise the boundary cases
 * without rendering the whole tree.
 */
export function dateBadgeStatus(scheduledFor, todayYyyyMmDd) {
  if (scheduledFor < todayYyyyMmDd) return 'overdue';
  if (scheduledFor === todayYyyyMmDd) return 'today';
  return 'upcoming';
}

/**
 * Today's date in the user's local timezone as a YYYY-MM-DD string. Centralised
 * here so the WorkoutsTab and its tests can both produce the same value.
 */
export function todayLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compact "exercise/set" summary for the WorkoutsTab card. Renders as e.g.
 * "Bench Press · 5 sets" or "Bench Press, Row · 8 sets" when more than one
 * exercise is planned.
 */
function describeSets(sets) {
  if (!sets || sets.length === 0) return 'No exercises';
  const exerciseNames = Array.from(new Set(sets.map((s) => s.exercise_name)));
  if (exerciseNames.length === 1) {
    return `${exerciseNames[0]} · ${sets.length} set${sets.length === 1 ? '' : 's'}`;
  }
  if (exerciseNames.length === 2) {
    return `${exerciseNames[0]}, ${exerciseNames[1]} · ${sets.length} sets`;
  }
  return `${exerciseNames[0]} +${exerciseNames.length - 1} more · ${sets.length} sets`;
}

/**
 * Single planned-workout card. Renders the workout title, scheduled date, an
 * exercise/set summary, and a visual-distinction badge (Today/Overdue) when
 * applicable. The whole card is a link to the log screen with the workout's
 * date pre-selected via the `?date=` query param — WorkoutLogger reads that
 * param and uses it as the initial date (see WorkoutLogger.jsx).
 */
export default function WorkoutCard({ workout, todayYyyyMmDd = todayLocalDate() }) {
  const { scheduled_for, title, notes, sets } = workout;
  const status = dateBadgeStatus(scheduled_for, todayYyyyMmDd);
  const testId = `workout-card-${workout.id}`;

  return (
    <Link
      to={`/workout?date=${encodeURIComponent(scheduled_for)}`}
      className={`workout-card status-${status}`}
      data-testid={testId}
      data-status={status}
    >
      <div className="workout-card-row">
        <h3 className="workout-card-title">{title}</h3>
        {status === 'today' ? (
          <span className="workout-badge today" data-testid={`${testId}-badge`}>
            Today
          </span>
        ) : null}
        {status === 'overdue' ? (
          <span className="workout-badge overdue" data-testid={`${testId}-badge`}>
            Overdue
          </span>
        ) : null}
      </div>
      <p className="workout-card-date">{formatScheduledDate(scheduled_for)}</p>
      <p className="workout-card-summary">{describeSets(sets)}</p>
      {notes ? <p className="workout-card-notes">{notes}</p> : null}
    </Link>
  );
}
