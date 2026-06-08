# Pulse - Mowgli Spec (v12)

## User Journeys

### 1. Task Capture and Backlog Management

#### 1.1. Landing and Default View

- 1.1.1. User opens Pulse web application in browser (desktop-optimized)
- 1.1.2. System loads Backlog List view by default (all non-archived tasks)
- 1.1.3. List displays tasks sorted by priority (urgent → high → medium → low)
- 1.1.4. User sees filter controls for status, priority, due date window, assignee, and tag
- 1.1.5. User sees search input field (searches title and description only)
- 1.1.6. User sees toggle/filter to include archived tasks (hidden by default)

#### 1.2. Quick Task Creation

- 1.2.1. User clicks "New Task" action in Backlog view
- 1.2.2. System presents task creation form with required title field
- 1.2.3. User enters title and optionally expands to add:
  - Description (rich text or plain text)
  - Priority level (low/medium/high/urgent)
  - Due date
  - Assignee (free-text with autocomplete suggestions from previously used assignees)
  - Tags (ad-hoc creation via typing; instant creation without pre-definition)
- 1.2.4. User saves task
- 1.2.5. Task appears immediately in Backlog list at appropriate priority position
- 1.2.6. System provides minimal confirmation (toast or inline feedback)

#### 1.3. Backlog List Operations

- 1.3.1. User filters list by selecting status, priority, assignee, tag, or due date range
- 1.3.2. User performs text search across task titles and descriptions
- 1.3.3. List updates dynamically or on explicit filter application (implementation flexible)
- 1.3.4. User clicks on task card to expand inline (accordion style) within the list
- 1.3.5. Expanded view shows full task details and edit controls
- 1.3.6. User may alternatively navigate to full-screen dedicated page for the task via explicit action
- 1.3.7. User edits task fields inline or on full screen; changes persist on save
- 1.3.8. User archives task using delete/bin terminology; task disappears from main views immediately

#### 1.4. Archive Access

- 1.4.1. User toggles "Show Archived" filter in Backlog view
- 1.4.2. System displays archived tasks alongside or in separate filtered view (implementation flexible)
- 1.4.3. Archived tasks are visually distinct (grayed out or marked)
- 1.4.4. User can un-archive tasks to restore them to active workflow

### 2. Kanban Board Workflow

#### 2.1. Board View Navigation

- 2.1.1. User switches from Backlog to Kanban Board view via navigation
- 2.1.2. Board displays three columns: Todo, Doing, Done
- 2.1.3. Each column displays tasks sorted first by Priority (urgent → high → medium → low), then by time-in-status (oldest at top within priority groups)
- 2.1.4. Columns display time-in-status context (e.g., "3 days" or timestamp) for sorting clarity

#### 2.2. Drag-and-Drop Status Management

- 2.2.1. User drags task card from Todo column to Doing column
- 2.2.2. System updates task status to "doing" and records statusChangedAt timestamp
- 2.2.3. Task repositions within Doing column based on priority/time-in-status sort
- 2.2.4. User drags task from Todo directly to Done (flexible flow allowed)
- 2.2.5. System updates status to "done", records statusChangedAt and completedAt timestamps
- 2.2.6. System provides immediate visual feedback on successful drop
- 2.2.7. User can drag tasks in reverse (Done → Doing, etc.) to correct mistakes

#### 2.3. Task Details in Board Context

- 2.3.1. User clicks task card in any column to expand inline (accordion) within that column
- 2.3.2. Expanded view shows edit controls without navigating away from board
- 2.3.3. User can open full-screen detail view via explicit action if inline is too constrained
- 2.3.4. User archives task from detail view; task disappears from board immediately

### 3. Task Lifecycle and Metadata Management

#### 3.1. Assignee Management

- 3.1.1. User types assignee name into free-text field
- 3.1.2. System suggests previously used assignee names (case-insensitive) to prevent duplicates like "Tom" vs "tom"
- 3.1.3. User selects suggestion or commits new name
- 3.1.4. Assignee information persists as plain text without user account linkage

#### 3.2. Tag Management

- 3.2.1. User types in tag field during task creation or edit
- 3.2.2. System creates new tag ad-hoc if text doesn't match existing tag
- 3.2.3. System displays existing tags for selection if matching
- 3.2.4. No tag management interface required beyond task-level assignment

#### 3.3. Status and Priority Updates

- 3.3.1. User changes priority level in task detail view
- 3.3.2. Task repositions in Backlog list according to new priority
- 3.3.3. Task repositions in Kanban column according to new priority (primary sort) while maintaining time-in-status (secondary sort)
- 3.3.4. User changes status via dropdown in detail view or via drag-and-drop on board
- 3.3.5. System validates status transitions (no blocked states in V1; flexible movement between todo/doing/done)

## Data Model

### Task

Represents a work item or action to be completed.

**Fields:**

* `id`: UUID primary key
* `title`: String, required, non-empty
* `description`: Text, nullable
* `status`: Enum [`todo`, `doing`, `done`], required
* `statusChangedAt`: Timestamp, required (used for board column sorting)
* `priority`: Enum [`low`, `medium`, `high`, `urgent`], required
* `dueAt`: Timestamp, nullable
* `completedAt`: Timestamp, nullable (populated when status becomes `done`)
* `assignee`: String, nullable (free-text)
* `createdAt`: Timestamp, required
* `updatedAt`: Timestamp, required
* `archivedAt`: Timestamp, nullable (soft delete semantics)

**Indexes:**
* `(archivedAt, priority)` - for backlog list queries
* `(status, statusChangedAt)` - for kanban board ordering
* `(dueAt)` - for due date filtering
* Full-text index strategy on title/description deferred or basic B-tree for V1

**Relationships:**
* Has many `TaskTag` (join records)
* Has many `Tag` (via TaskTag)

### Tag

Represents a categorical label for tasks.

**Fields:**

* `id`: UUID primary key
* `name`: String, required, unique in scope (case-handling policy: stored as-entered, comparisons case-insensitive for uniqueness)
* `createdAt`: Timestamp, required

**Relationships:**
* Has many `TaskTag` (join records)
* Has many `Task` (via TaskTag)

### TaskTag

Join table for many-to-many relationship between Task and Tag.

**Fields:**

* `taskId`: UUID, foreign key to Task
* `tagId`: UUID, foreign key to Tag
* Composite primary key: `(taskId, tagId)`

**Relationships:**
* Belongs to `Task`
* Belongs to `Tag`

**Behavior:**
* Cascade delete appropriate for archival model (no hard delete path in V1; archived tasks maintain their tag associations)

## Design

The frontend should feature a skateboard aesthetic similar to World Industries. (interpret freely)

## Backend API Specification (V1)

*Base path: `/api/v1`*

### Endpoints

#### Tasks

* `POST /tasks` — Create task
  - Body: title (required), description, status, priority, dueAt, assignee, tags (array of strings, ad-hoc creation)
  - Response: Task object with expanded tags

* `GET /tasks` — List tasks
  - Query params: status, priority, assignee, tag, q (search title/description), dueBefore, dueAfter, limit, cursor, sort, includeArchived (boolean)
  - Response: Paginated list of tasks

* `GET /tasks/:id` — Get task detail
  - Response: Full task object with tags and timestamps

* `PATCH /tasks/:id` — Update task
  - Body: partial updates supported for all mutable fields
  - Special handling: status updates trigger statusChangedAt timestamp; transition to "done" sets completedAt; transition away from "done" clears completedAt

* `DELETE /tasks/:id` — Archive task (soft delete)
  - Sets archivedAt timestamp
  - Task excluded from default queries thereafter

#### Tags

* `GET /tags` — List all tags with usage counts
* `POST /tags` — Create tag (also happens implicitly via task creation/update)

### Validation Rules

* Title: required, non-empty string, max length enforced
* Status: must be one of [`todo`, `doing`, `done`]
* Priority: must be one of [`low`, `medium`, `high`, `urgent`]. Defaults to `medium` if not provided in request body.
* Due dates: valid ISO timestamps, not enforced against creation date in V1
* Assignee: free text, max length enforced
* Tags: created ad-hoc, unique by name (case-insensitive comparison)

### Error Handling

* Consistent error format: `{ error: { code, message, details } }`
* 400 for validation failures with field-level detail
* 404 for missing resources
* 500 for server errors (sanitized, no stack traces)

## Frontend

#### Navigation Elements

    **Desktop Layout:**
    *   **Left Sidebar:**
      *   App Branding ("Pulse" - bold stencil font).
      *   Navigation Items: "Backlog" (List), "Kanban" (Board).
      *   "New Task" button (prominent, full width).
    *   **Top Header (Contextual):**
      *   Dynamic title based on view.
      *   Breadcrumbs (e.g., Backlog  Task Details).
      *   User Profile/Settings (placeholder).

    **Mobile Layout:**
    *   **Top Header (Sticky):**
      *   App Branding ("Pulse").
      *   Search Input (expands when tapped).
      *   Filter/Sort Toggle (icon).
    *   **Bottom Tab Bar (Fixed):**
      *   Left: Backlog Icon.
      *   Right: Kanban Icon.
      *   Center: Floating "New Task" Button (FAB) - bold circle or deck-shape.
    *   **Navigation Logic:**
      *   **Main Views:** Toggling tabs switches views without unmounting (preserves scroll state).
      *   **Sub-Screens (Detail, New Task):** Slide over from right (iOS style) or fade in. Bottom Tab Bar is hidden on sub-screens. Top Header shows a " Back" chevron.

    ### Layout Structure

    *   **Responsive Container:** A flexible grid/flex layout that collapses the sidebar into the bottom header on mobile.
    *   **Content Density:**
      *   Desktop: Multi-column grids, visible metadata on cards.
      *   Mobile: Single column lists, compact cards with metadata hidden behind expand/collapse actions.
    *   **State Persistence:** Filter state (status, priority, etc.) is maintained via URL query parameters to ensure shareable links and state restoration on refresh.

    ### Feedback Systems

    *   **Toasts:** Slide in from top on Desktop, bottom (above nav bar) on Mobile.
    *   **Undo:** For Archive actions, a toast appears with an "Undo" button (valid for 5 seconds).
    *   **Loading:** Skeleton screens on mobile (shimmer effects) rather than simple spinners, to maintain layout structure perception.

    ### Design Aesthetic (Skateboard/World Industries)

    *   **Typography:** Bold, angular fonts (e.g., Impact-like or stencil) for headers; clean sans-serif for body text.
    *   **Color Palette:** High contrast. Deep blacks, bold flame reds, deck greens, and graphic whites.
    *   **Shapes:** Slightly rounded corners on desktop, sharper edges on mobile to fit the "deck" feel. Buttons might resemble griptape textures.

### BacklogListViewScreen

Summary: The default landing screen displaying a prioritized list of tasks. Supports filtering, searching, and inline task management.

Preview size: 1920x1080

#### Preview states

State | Name | Description
------|------|--------------------------------
ID: default | Default | The standard view. On Desktop: Sidebar visible, filter bar static. On Mobile: Bottom Nav visible, top search bar static. List displays task cards.
ID: filteringActive | Filtering Active | Desktop: Filter bar shows applied states. Mobile: Horizontal scroll area shows active filter chips (e.g., "Urgent" with an 'x' to remove). The list is filtered.
ID: searchActive | Search Active | Desktop: Search input has focus. Mobile: Search input is expanded and keyboard is up. List shows search results.
ID: archivedView | Archived View | Toggle active. Tasks appear grayed out or with a strikethrough style. "Un-archive" button is visible in the expanded card action area.
ID: inlineExpanded | Task Expanded (Inline Detail) | Task card is expanded. Desktop: Shows full details in place. Mobile: Expands to fill roughly 60% of screen height or full height if content is long, with a "Close" handle at the top.
ID: inlineEditing | Task Expanded (Editing) | The expanded card is in edit mode. Inputs are active. On mobile, the keyboard may push the content up; ensure the save button remains accessible (sticky bottom of the card).

#### Contents

Primary list view for all non-archived tasks, default landing screen.

**Content Hierarchy:**

*   **Header:**
  *   *Desktop:* View Title ("Backlog") and "New Task" button.
  *   *Mobile:* Search bar (prominent), Filter Icon (triggers bottom sheet).
*   **Filter Bar:**
  *   *Desktop:* Persistent horizontal bar with chips/inputs for Status, Priority, Due Date, Assignee, Tag. Archive toggle at end.
  *   *Mobile:* Condensed into a horizontal scrolling list of active filter chips (e.g., "High Priority", "Todo") with an "Add Filter" (+) button. Tapping opens a full-screen filter modal or bottom sheet.
*   **Task List:**
  *   Displays tasks sorted by priority (urgent → high → medium → low).
  *   *Desktop:* Multi-row grid or wide list cards showing metadata inline.
  *   *Mobile:* Single-column stack.
*   **Task Card:**
  *   *Desktop:* Shows Title, Priority (colored border), Status, Due Date, Assignee avatar, Tag chips. Expand arrow on right.
  *   *Mobile:* Large touch target. Title and Priority badge are primary. Due date and Assignee are secondary/smaller. Tags hidden (show count).
  *   *Common:* Expand/collapse control for inline detail view.
*   **Empty State:** Graphic illustration (skateboard themed) when no tasks match filters.

**Interactions:**

*   **Mobile Search:** Tapping search bar expands it to cover the header area.
*   **Inline Expansion:**
  *   *Desktop:* Accordion expands downwards, pushing other content.
  *   *Mobile:* Accordion expands smoothly. If description is long, it scroll within the card height or expands to full screen overlay if too complex. (Prefers inline accordion per spec).
*   **Archive Action:**
  *   *Desktop:* Button in expanded footer.
  *   *Mobile:* Swipe-to-delete gesture (optional enhancement) or Delete button in expanded view.

### KanbanBoardViewScreen

Summary: A drag-and-drop interface for managing tasks across Todo, Doing, and Done columns.

Preview size: 1920x1080

#### Preview states

State | Name | Description
------|------|--------------------------------
ID: default | Default | Standard board view. Desktop: 3 columns visible. Mobile: One column visible (e.g., Todo) with horizontal scroll indicators or a segmented control at the top to jump columns.
ID: dragging | Dragging Task | Desktop state only. A card is floating over the board. Target column highlights green. Mobile does not use this state.
ID: inlineExpanded | Task Expanded (Inline Detail) | Desktop: Accordion within column. Mobile: Bottom sheet or modal sliding up from bottom, displaying task details. Background is dimmed.
ID: inlineEditing | Task Expanded (Editing) | The task is being edited. Desktop: Inputs in card. Mobile: Inputs in the bottom sheet/modal. Save/Cancel actions are sticky at the bottom of the mobile sheet for thumb reachability.

#### Contents

Drag-and-drop board view organized by status columns.

**Content Hierarchy:**

*   **Header:** View Title ("Kanban").
*   **Columns (Todo, Doing, Done):**
  *   *Desktop:* Three equal-width columns displayed side-by-side horizontally.
  *   *Mobile:* Full-width columns arranged horizontally. User swipes left/right to switch columns (snap scrolling). Column headers stick to the top of the viewport.
*   **Column Header:** Status Name and Task Count.
*   **Task Card:** Sorted by Priority then Time-in-status.
  *   *Mobile:* Cards are more compact to fit vertical scrolling within a single column view.
*   **Visual Cues:** Time-in-status shown as "2d ago" or a colored aging bar.

**Interactions:**

*   **Navigation:**
  *   *Desktop:* Drag and drop between columns.
  *   *Mobile:* Drag and drop is **disabled**. Users must tap a card to expand it, then use the "Status" dropdown to move it. Visual swipe gestures navigate between columns (Todo - Doing - Done).
*   **Inline Expansion:**
  *   *Mobile:* Expanding a card opens a modal/bottom-sheet overlaying the column, as the column space is too narrow for inline expansion. This overlay allows editing status/priority without leaving the board context.

### TaskDetailFullScreen

Summary: A dedicated page for viewing and editing a single task with full context and audit history.

Preview size: 1920x1080

#### Preview states

State | Name | Description
------|------|--------------------------------
ID: default | Default | Read-only view. On Mobile: Back button visible in top left. Audit trail at the bottom.
ID: editing | Editing | Form fields are active. On Mobile: Virtual keyboard may cover content. The input in focus should scroll into view automatically. Sticky "Save" button appears at bottom.

#### Contents

Dedicated full-page view for detailed task examination.

**Route:** `/tasks/:id`

**Content Hierarchy:**

*   **Navigation Header:**
  *   *Desktop:* Breadcrumbs (Backlog  Task Name) or "Close" button.
  *   *Mobile:* " Back" chevron (top left). "Save" or "More" icon (top right).
*   **Content Body:**
  *   Title input (large text).
  *   Metadata grid (Status, Priority, Due Date, Assignee).
  *   Tags section (pills).
  *   Description area.
*   **Footer/Action Area:**
  *   *Desktop:* Archive button (bottom of form).
  *   *Mobile:* Sticky bottom bar containing "Archive" (red text) and "Save Changes" (primary button). This ensures actions are always accessible when scrolling.

**Interactions:**

*   *Mobile:* Tapping "Back" while editing prompts "Discard changes?" toast/dialog.
*   Archive action triggers a confirmation dialog on mobile to prevent accidental deletion.

### NewTaskFormScreen

Summary: A focused form for quickly capturing new tasks, supporting optional metadata expansion.

Preview size: 1920x1080

#### Preview states

State | Name | Description
------|------|--------------------------------
ID: default | Default | Form initialized. Title focused. On Mobile: Full screen, keyboard likely up. Optional fields collapsed.
ID: expanded | Optional Fields Expanded | The section for extra metadata is open. On Mobile: This pushes the "Create" button down or keeps it sticky over the scrollable content.

#### Contents

Creation interface for rapid task capture.

**Context:**
*   *Desktop:* Modal dialog centered on screen.
*   *Mobile:* Full-screen page transition (slides up from bottom). Hides Bottom Tab Bar.

**Content Hierarchy:**

*   **Header:**
  *   *Desktop:* "New Task" title, "X" to close.
  *   *Mobile:* "Cancel" button (top left), "New Task" title (top center).
*   **Form:**
  *   Title Input (auto-focused).
  *   Expandable section for Details, Priority, Due Date, Assignee, Tags.
  *   *Mobile:* The expansion should be an accordion style to keep the initial view clean.
*   **Actions:**
  *   *Desktop:* "Create Task" button at bottom of modal.
  *   *Mobile:* Sticky "Create Task" button at the bottom of the screen (above keyboard area) for easy thumb access.

**Interactions:**

*   *Mobile:* Tapping "Create" validates and closes the full-screen page, returning to the previous view (Backlog or Board) with a success toast.