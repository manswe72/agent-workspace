// agent-workspace dashboard — renders worktree status from /api/status.
// Auto-refreshes every 5 minutes (and on Refresh button click).
//
// Server contract (agent_workspace.py):
//   GET /api/status     → full state JSON used for refreshes.
//
// The server is read-only and does not run Claude.

(() => {
  'use strict';

  const REFRESH_MS = 5 * 60 * 1000;  // auto-refresh every 5 min

  // ── Server-unreachable banner ────────────────────────────────────────
  // Tied to the /api/status heartbeat: refreshAll flips this on its
  // success/failure path. The banner lives in the static HTML
  // (#server-status-banner), styled in dashboard.css. Other fetches keep
  // surfacing their own errors — this is a global liveness signal only.
  const serverStatus = {
    down: false,
    el() { return document.getElementById('server-status-banner'); },
    detailNode() { return this.el()?.querySelector('.ssb-detail') ?? null; },
    show(err) {
      const el = this.el(); if (!el) return;
      this.down = true;
      const d = this.detailNode();
      if (d) {
        const msg = err && err.message ? err.message : (err ? String(err) : '');
        d.textContent = msg ? `— ${msg}` : '';
      }
      el.hidden = false;
      console.log('[server-status] show', err);
    },
    hide() {
      const el = this.el(); if (!el) return;
      const wasDown = this.down;
      this.down = false;
      el.hidden = true;
      if (wasDown) console.log('[server-status] hide');
    },
  };
  // Wire the Retry button via event delegation on document, so it
  // works regardless of when dashboard.js is injected and whether
  // the banner element exists at that moment.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('#server-status-banner .ssb-retry');
    if (!btn) return;
    e.preventDefault();
    console.log('[server-status] retry clicked');
    btn.disabled = true;
    refreshAll(true).finally(() => { btn.disabled = false; });
  });

  // ── Synced preferences ─────────────────────────────────────────────
  // Thin wrapper around localStorage that *also* persists certain keys
  // to the server (POST /api/preferences, debounced). The server then
  // exports them via data/<user-slug>/preferences.json so other machines
  // pick them up on the next sync. Hydration runs synchronously before
  // any other code reads localStorage so the user's choices appear from
  // the very first paint, even on a freshly-cloned machine.
  const prefs = (() => {
    const SYNCED = new Set([
      'sync-ui-on', 'notify-kinds', 'week-exclude-agent',
      'worklog-grouped', 'toolbar-filters-open',
      'show-agent-info', 'show-timer', 'show-activity',
      'theme', 'lang', 'expected-repos',
      'console-inline-default',
      'general-agent-enabled',
      'general-agent-model',
      'mcp-enabled',
      'mailbox-auto-poll',
      'auto-update-check',
      'quick-messages',
    ]);
    // Hydrate localStorage from the inlined initial-state preferences
    // BEFORE any of the let-decls below read localStorage. The script tag
    // is inlined above this <script> so #initial-state is already in DOM.
    try {
      const raw = document.getElementById('initial-state')?.textContent;
      const initial = (raw ? JSON.parse(raw).preferences : null) || {};
      for (const [k, v] of Object.entries(initial)) {
        let stored;
        if (typeof v === 'boolean')      stored = v ? '1' : '0';
        else if (typeof v === 'string')  stored = v;
        else if (v == null)              continue;
        else                             stored = JSON.stringify(v);
        try { localStorage.setItem(k, stored); } catch (_) {}
      }
    } catch (_) { /* fall back to whatever's already in localStorage */ }

    // Debounced server flush — coalesces rapid toggles into one POST.
    let timer = null;
    const pending = {};
    function flush() {
      timer = null;
      const keys = Object.keys(pending);
      if (!keys.length) return;
      const payload = {};
      for (const k of keys) { payload[k] = pending[k]; delete pending[k]; }
      fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: payload }),
      }).catch(() => { /* offline / network — localStorage still holds it */ });
    }
    function schedule() {
      if (timer) return;
      timer = setTimeout(flush, 400);
    }
    function asJsonValue(raw) {
      // localStorage is string-only, but the server stores typed JSON.
      // Round-trip booleans encoded as '1'/'0'; pass strings through.
      if (raw === '1') return true;
      if (raw === '0') return false;
      if (raw == null) return null;
      return raw;
    }
    return {
      setItem(key, value) {
        try { localStorage.setItem(key, value); } catch (_) {}
        if (SYNCED.has(key)) {
          pending[key] = asJsonValue(value);
          schedule();
        }
      },
      removeItem(key) {
        try { localStorage.removeItem(key); } catch (_) {}
        if (SYNCED.has(key)) {
          pending[key] = null;
          schedule();
        }
      },
      getItem(key) { return localStorage.getItem(key); },
    };
  })();

  // ── Theme support ─────────────────────────────────────────────────
  // Stored as the synced pref `theme` (auto / light / dark / warm).
  // 'auto' = no `data-theme` attribute, so the dashboard falls through
  // to the @media (prefers-color-scheme: dark) rule in the CSS.
  // Applied as early as possible to avoid a one-frame "wrong theme"
  // flash on initial paint.
  const THEMES = ['auto', 'light', 'dark', 'warm'];
  function applyTheme(name) {
    if (name === 'auto' || !THEMES.includes(name)) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', name);
    }
  }
  function currentTheme() {
    const stored = (localStorage.getItem('theme') || '').trim();
    // Default = warm. The user can flip to 'auto' to follow the
    // OS preference, or pick light / dark explicitly.
    return THEMES.includes(stored) ? stored : 'warm';
  }
  applyTheme(currentTheme());

  // ── i18n ──────────────────────────────────────────────────────────
  // Synced pref `lang` ∈ { 'auto' | 'en' | 'sv' }. Auto follows
  // navigator.language. Strings are looked up by key in TRANSLATIONS
  // and fall back through (chosen lang) → en → key. Adding a new
  // language: extend LANGS and TRANSLATIONS. Adding a new string:
  // pick a key, add `t('the-key')` at the call site, fill in the en
  // (and ideally sv) entries below.
  const LANGS = ['auto', 'en', 'sv'];
  const LANG_LABELS = {
    'auto': 'Auto (system)', 'en': 'English', 'sv': 'Svenska',
  };
  const TRANSLATIONS = {
    en: {
      // Toolbar
      'toolbar.refresh-now':    'Refresh now',
      'toolbar.sync-now':       '⇅ Sync now',
      'toolbar.week-summary':   '📅 Week summary',
      'toolbar.github':         '🐙 GitHub',
      'tip.github':             'Open issues / PRs assigned to you in the configured GitHub repositories',
      'github.title':           '🐙 GitHub · open issues + PRs',
      'github.refresh':         '↻ Refresh',
      'github.close':           '✕ Close',
      'github.loading':         'loading…',
      'github.empty-issues':    'No open issues assigned to you.',
      'github.empty-prs':       'No open PRs you authored.',
      'github.not-configured':  'No GitHub repos configured. Set the `github-repos` preference to a list of "owner/repo" strings.',
      'github.section.issues':  'Issues assigned to you',
      'github.section.prs':     'Open PRs you authored',
      'github.col.repo':        'Repo',
      'github.col.number':      '#',
      'github.col.title':       'Title',
      'github.col.state':       'State',
      'github.col.workspace':   'Workspace',
      'github.col.agent':       'Agent',
      'github.col.model':       'Model',
      'github.col.actions':     'Actions',
      'github.agent.use-default': 'Use default',
      'github.has-workspace':   '✓ exists',
      'github.no-workspace':    '—',
      'github.set-name':        'Set display name',
      'github.clear-name':      'Clear display name',
      'github.name-prompt':     'Friendly name for {workspace} (used in MCP `send_message(to=...)`)',
      'github.action.add':      '+ Add',
      'github.action.add-tip':  'Create a worktree {name} from this issue',
      'github.action.remove':   '🗑 Remove',
      'github.action.remove-tip':'Remove the worktree {name}',
      'github.model.inherit':   'Use default',
      'toolbar.agent-events':   '🔔 Agent events',
      'toolbar.add-issue':      '+ Add issue',
      'toolbar.pinned-only':    '📌 Pinned only',
      'toolbar.pinned-only.on': '📍 Pinned only',
      'tip.pinned-only':        'Hide every tab whose issue isn\'t pinned. Click the 📌 next to the 🗑 in any issue head to pin/unpin it.',
      'toolbar.compact':        '🗜 Compact',
      'tip.compact':            'Quick on/off for compact mode. Mirrors the Profile → Dashboard → Compact checkbox.',
      'tip.pin':                'Pin {issue} — keep its tab leftmost regardless of the active sort.',
      'tip.unpin':              'Unpin {issue} — return it to normal sort order.',
      'tip.expand-all':         'Expand all',
      'tip.collapse-all':       'Collapse all',
      'tip.expand-all-popover': 'Expand or collapse every section (repo cards + Agent information) in this tab.',
      // ISSUES card hover popover columns
      'stat.issues.summary':    'Summary',
      'stat.issues.agent':      'Agent',
      'stat.issues.repos':      '#repos',
      'stat.issues.empty':      'No issues yet.',
      'notes.error.no-issues':  'No issues to add a note to',
      'notes.change-status':    'Change status',
      'notes.change-priority':  'Change priority',
      'notes.filter-by-tag':    'Filter by #{tag}',
      'notes.clear-tag':        '✕ clear tag',
      'notes.delete-tip':       'Delete',
      'notes.add-note-title.issue': '+ Add note — {issue}',
      'notes.add-note-title.pick':  '+ Add note — pick an issue',
      'notes.add.placeholder':  'Type your note…',
      'notes.add.warn.pick-issue': 'Pick an issue',
      'notes.add-success':      '✓ Note added',
      'notes.error.add-failed': 'add failed',
      'notes.error.save-failed':'save failed',
      'notes.error.delete-failed': 'delete failed',
      'notes.label.issue':      'Issue',
      'notes.label.status':     'Status',
      'notes.label.priority':   'Priority',
      'notes.label.due':        'Due',
      'notes.label.assignee':   'Assignee',
      'notes.label.tags':       'Tags',
      'notes.label.note':       'Note',
      'notes.btn.cancel':       'Cancel',
      'notes.btn.save':         'Save',
      'notes.btn.close':        'Close',
      'notes.bulk.deleted':     '✓ {n} deleted',
      'notes.bulk.updated':     '✓ {n} updated',
      'notes.bulk.delete-failed': '{n} delete(s) failed',
      'notes.bulk.update-failed': '{n} update(s) failed',
      'notes.notes-switch-to':  'Switch to {issue}-only view',
      'toolbar.filters':        '☰ Filters',
      'toolbar.enable-notifications': '🔔 Enable notifications',
      'issue.open-console':     '🤖 Agent',
      'issue.open-worktree':    '↗ Open',
      'toolbar.help':           '? Help',
      'tip.help':               'Open the help overlay (also: press ?)',
      'help.title':             '? Help · keyboard shortcuts and features',
      'help.section.shortcuts': 'Keyboard shortcuts',
      'help.section.features':  'Main features',
      'help.section.docs':      'Documentation',
      'help.tab.quick':         'Quick info',
      'help.tab.workspace':     'Agentic workspace',
      'help.tab.api':           'API',
      'help.shortcut.refresh':  'Refresh dashboard now',
      'help.shortcut.new-issue':'Open the + Add issue dialog',
      'help.shortcut.search':   'Focus the tab filter / search',
      'help.shortcut.help':     'Open this help overlay',
      'help.shortcut.dismiss':  'Close the topmost overlay (modals, toasts, popovers)',
      'help.shortcut.term-search': 'Search terminal output (when terminal is focused)',
      'help.feat.tabs':         'Tabs across the top: one per {root}/<issue>/. The ⓘ icon shows a per-repo ↓↑ table on hover.',
      'help.feat.bell':         '🔔 Agent events: per-tab badge counts unread events. Click the badge for a per-issue modal; the toolbar 🔔 button shows everything.',
      'help.feat.notes':        '📝 Notes per issue: lightweight todo / done / not-done. Inline-editable, sortable, status-flippable.',
      'help.feat.console':      '🤖 Agent opens the issue in a new gnome-terminal tab with `claude --continue`. ↗ Open opens the issue dir in the editor.',
      'help.feat.git-ops':      'Per-repo Fetch / Pull --ff-only / Push buttons; disabled state explains why when divergence would block it.',
      'help.feat.themes':       'Profile popover (avatar top-right): switch theme, language, notification kinds, toggle dashboard sections.',
      'help.docs-blurb':        'Agent information:',
      'tab.starting':           'Start here…',
      'tab.generic-agent':      'Agent 007',
      'tab.engineering-agent':  'Agent Engineering',
      'tab.messages':           'Messages',
      'empty.dashboard.title':  'No worktrees yet',
      'empty.dashboard.body':   'The dashboard shows one tab per {path}/<issue>/ directory. That root is empty right now — click + Add issue to create your first worktree, or read the docs first.',
      'time.ago':               'ago',
      'time.now':               'just now',
      // Status pills
      'pill.clean':             'clean',
      'pill.dirty':             '{n} change',
      'pill.dirty-plural':      '{n} changes',
      'pill.unpushed':          '{n} unpushed',
      'pill.not-started':       'not started',
      'pill.ahead':             '+{n} ahead',
      'pill.behind':            '−{n} behind',
      'pill.behindbad':         '⚠ {n} behind',
      'pill.missing':           '🚫 missing',
      'pill.removed':           'removed {date}',
      'repo.not-in-worktree':   'Not in this worktree',
      // Notes modal
      'notes.title':            '📝 Notes — {issue}',
      'notes.title.all':        '📝 Notes — all issues',
      'notes.meta':             '· {count} note{plural} · {todo} todo',
      'notes.add-button':       '+ Add note',
      'notes.close-button':     '✕ Close',
      'notes.all-button':       'All issues',
      'notes.this-button':      'This issue only',
      'notes.empty':            'No notes yet — use + Add note to create the first one.',
      'notes.empty-filtered':   'No notes match the current filters.',
      'notes.search.placeholder': 'Search notes — content, tags, assignee, issue…',
      'notes.col.issue':        'Issue',
      'notes.col.created':      'Created',
      'notes.col.status':       'Status',
      'notes.col.priority':     'Priority',
      'notes.col.due':          'Due',
      'notes.col.assignee':     'Assignee',
      'notes.col.tags':         'Tags',
      'notes.col.note':         'Note',
      'notes.status.todo':      'Todo',
      'notes.status.done':      'Done',
      'notes.status.not_done':  'Not done',
      'notes.priority.low':     'Low',
      'notes.priority.normal':  'Normal',
      'notes.priority.high':    'High',
      'notes.delete-confirm':   'Delete this note?',
      'notes.bulk-delete-confirm': 'Delete {count} note{plural}?',
      'notes.empty-warn':       'Note cannot be empty',
      'notes.click-to-edit':    'Click to edit · Esc to revert',
      'notes.bulk.selected':    '{count} selected',
      'notes.bulk.delete':      'Delete selected',
      'notes.bulk.status':      'Set status',
      'notes.bulk.priority':    'Set priority',
      'notes.bulk.clear':       'Clear selection',
      'notes.sort.manual':      'Manual',
      'notes.assignee.placeholder': 'unassigned',
      'notes.tags.placeholder': 'comma-separated tags',
      'notes.due.cleared':      '—',
      'notes.due.overdue':      'overdue',
      'notes.due.today':        'today',
      'notes.due.tomorrow':     'tomorrow',
      // Add-issue dialog
      'addIssue.title':         '+ Add issue',
      'addIssue.label.issue':   'Issue',
      'addIssue.label.base':    'Branch from',
      'addIssue.label.repos':   'Repos',
      'addIssue.help.issue':    'BSS-key or any branch-safe name. If origin/<issue> already exists, the new worktree tracks it.',
      'addIssue.help.base':     'Used only when origin/<issue> does NOT exist. Resolves to a local ref first, then origin/<base>.',
      'addIssue.button.create': 'Create',
      'addIssue.button.cancel': 'Cancel',
      'addIssue.button.creating':'Creating…',
      'addIssue.button.done':   'Done',
      'addIssue.warn.empty':    'Issue key is required',
      'addIssue.warn.invalid':  'Invalid issue name',
      'addIssue.warn.no-repos': 'Pick at least one repo',
      'addIssue.col.repo':      'Repo',
      'addIssue.col.result':    'Result',
      'addIssue.col.detail':    'Detail',
      'toolbar.next-refresh':   'next refresh in {time}',
      'toolbar.refreshing':     'refreshing…',
      'toolbar.auto-refresh-off': 'Auto-refresh is off — click to refresh now',
      // Tooltips
      'tip.refresh-now':        'Run one sync of the agent-workspace repo now',
      // <th> column.
      'tip.kv.status':          'Status',
      'tip.kv.summary':         'Summary',
      'tip.kv.assignee':        'Assignee',
      'tip.kv.open':            'Open',
      'tip.kv.issue':           'Issue',
      'tip.kv.no-live-issues':  'No live issues to inspect.',
      // Common column labels reused by the summary-card hover popovers
      // (Repos / Dirty / Behind) and inside repo-card popovers.
      'col.repo':               'Repo',
      'col.repos':              'Repos',
      'col.branch':             'Branch',
      'col.dirty':              'Dirty',
      'col.behind':             'Behind',
      'col.upstream':           'Upstream',
      'col.working-tree':       'Working tree',
      'col.last-subject':       'Latest subject',
      'col.last-claude':        'Last Claude',
      'col.last-prompt':        'Last prompt',
      'col.detail':             'Detail',
      'empty.no-repos':         'No repos checked out.',
      'empty.no-dirty':         'No dirty trees.',
      // Common button labels reused across dialogs / modals.
      'btn.cancel':             'Cancel',
      'btn.add':                'Add',
      'btn.save':                'Save',
      'btn.close':              'Close',
      'btn.sync-now':           'Sync now',
      // Common toast messages.
      'toast.pick-issue':       'Pick an issue first',
      'toast.issue-required':   'issue is required',
      'toast.minutes-positive': 'minutes must be > 0',
      'toast.pick-editor':      'Pick an editor in the toolbar first',
      'toast.start-failed':     'start failed: {err}',
      'toast.stop-failed':      'stop failed: {err}',
      'toast.add-failed':       'add failed: {err}',
      'toast.delete-failed':    'delete failed: {err}',
      'toast.delete-failed-short': 'delete failed',
      'toast.open-failed':      'Open failed: {err}',
      'toast.create-failed':    'Create failed: {err}',
      'toast.mark-read-failed': 'Mark-read failed: {err}',
      'toast.week-summary-failed': 'Week summary fetch failed: {err}',
      'toast.notify.unsupported': 'Notifications not supported in this browser',
      'toast.notify.blocked':   'Notifications blocked — enable in browser settings',
      'toast.notify.not-enabled': 'Notifications not enabled',
      'toast.toggle-failed':    'Toggle failed: {err}',
      'toast.sync-request-failed': 'Sync request failed: {err}',
      // Confirm prompt when removing a worktree whose Claude agent is
      // still running. Long form so the user understands the risk
      // before clicking OK.
      'remove.confirm-agent':   "A Claude agent is still running for {issue}.\n\nRemoving the worktree now may leave the agent's open files in a half-saved state. The safe option is to exit the agent first (Ctrl-D in its terminal tab).\n\nRemove anyway?",
      // Agent-events modal column headers.
      'evt.col.time':           'Time',
      'evt.col.kind':           'Kind',
      'evt.col.issue':          'Issue',
      'evt.col.message':        'Message',
      // Misc per-tab popover / inline table headers.
      'col.range':              'Range',
      'col.comments':           'Comments',
      'col.latest-subject':     'Latest subject',
      // Profile / dashboard stat labels.
      'profile.stat.generated': 'Generated',
      'profile.stat.sync':      'Sync',
      'profile.stat.path':      'Path',
      'profile.stat.version':   'Version',
      'profile.stat.uptime':    'Uptime',
      'profile.stat.requests':  'Requests',
      'profile.stat.logs':      'Logs',
      'profile.stat.pid':       'PID',
      'profile.stat.last-run':  'Last run',
      'profile.path.browse':    '📂 Browse',
      'profile.path.browse-tip': 'Show the worktrees-root directory tree (issues + on-disk repos) in a dialog.',
      'profile.path.reset':     '🗑',
      'profile.path.reset-tip': 'DANGER: wipe all worktrees and the activity DB for this dashboard instance.',
      'reset.modal.title':      '⚠ Reset this workspace?',
      'reset.modal.body':       'This will permanently delete EVERYTHING for this dashboard instance:\n· every worktree under {path}\n· every primary repo clone in the same primaries root\n· every row in the activity DB (notes, agent events, preferences, week summaries, backup history)\nNext startup will surface the "Missing primary repos" banner — you\'ll need to re-clone.',
      'reset.modal.confirm':    'Continue',
      'reset.modal.cancel':     'Cancel',
      'reset.modal.final.title': '⚠ Final confirmation',
      'reset.modal.final.body': 'There is no undo. Press "Yes, reset" to wipe {path} and the activity DB now.',
      'reset.modal.final.confirm': 'Yes, reset',
      'toast.reset.ok':         '✓ Workspace reset · {n} worktree(s) and {p} primary repo(s) removed',
      'toast.reset.failed':     'Reset failed: {err}',
      'profile.path.tree-title': '📂 Worktrees directory tree',
      'profile.path.tree-empty': '(empty — no issues yet)',
      'profile.path.tree-ghost': '(removed)',
      'profile.path.tree-missing': '(not in this worktree)',
      // Generic UI strings.
      'ui.loading':             'Loading…',
      'ui.load-failed':         'Failed to load: {err}',
      'ui.activity':            'Activity',
      'ui.messages':            'Messages',
      'ui.filter.show-only':    'Show only:',
      'ui.issue-label':         'Issue:',
      'ui.loading-healthz':     'Loading /healthz…',
      'ui.loading-description': 'Loading description…',
      'ui.loading-readme':      'Loading README…',
      'ui.removing-worktrees':  'Removing worktrees…',
      'ui.branch-age':          'Branch age: ',
      'ui.last-claude':         'Last Claude: ',
      'ui.last-build':          'Last build: ',
      'ui.last-commit':         'Last commit: ',
      'ui.worktree-disk':       'Worktree disk usage',
      'ui.labels-prefix':       'Labels: ',
      'ui.by-day':              'By day',
      'ui.by-issue':            'By issue',
      'tip.week-summary':       "Show this week's commit + token summary",
      'tip.agent-events':       'All recent events posted by Claude Code hooks',
      'issue.open-issue':       '↗ Open',
      'tip.open-issue':         'Open the issue\'s worktree directory ({root}/<issue>/) so all repos sit side-by-side.',
      'toolbar.notes':          '📝 Notes',
      'tip.notes':              'All notes across all issues, with filters',
      'tip.add-issue':          'Create a new worktree under {root}/<issue>/ for one or more repos',
      'tip.add-issue.cloning':  'Wait for primary repos to finish cloning: {repos}',
      'issue.subtab.branches':  'Branches',
      'issue.subtab.agent':     'Agent',
      'issue.subtab.messages':  'Messages',
      'issue.subtab.stashes':   'Stashes',
      'stashes.empty':          'No stashes',
      'stashes.title':          'Stashes',
      'stashes.view':           'Files',
      'stashes.drop':           'Drop',
      'stashes.confirm-drop':   'Drop stash {ref} from {repo}? This cannot be undone.',
      'stashes.added':          '+{n}',
      'stashes.removed':        '−{n}',
      'stashes.binary':         'binary',
      // Auto-update banner / overlay
      'update.banner.title':       '🔔 Dashboard update available',
      'update.banner.subtitle':    '{n} commit{plural} behind on {branch}',
      'update.banner.update-btn':  'Update now',
      'update.banner.dismiss-btn': 'Later',
      'update.confirm.no-agents':  'Pull origin/{branch} and restart the dashboard? The current tab will reload.',
      'update.confirm.with-agents': 'Pull origin/{branch} and restart the dashboard?\n\n{n} agent terminal(s) will be stopped gracefully: {agents}.\n\nclaude --continue will resume them after the restart.',
      'update.restarting':         'Restarting dashboard… reconnecting…',
      'update.pull-failed':        'Pull failed: {error}',
      'restart.btn':               '🔄 Restart server',
      'restart.btn-tip':           'Stop every running agent and respawn the dashboard server. Use this when MCP config changes need to take effect or something is stuck.',
      'restart.confirm.no-agents': 'Restart the dashboard server? The current tab will reload.',
      'restart.confirm.with-agents': 'Restart the dashboard server?\n\n{n} agent terminal(s) will be stopped gracefully: {agents}.\n\nclaude --continue will resume them after the restart.',
      'restart.failed':            'Restart failed: {error}',
      'profile.section.dismissed':   'Dismissed warnings',
      'profile.dismissed.help':      'You can hide individual rows in the "branches >N behind upstream" banner by clicking the ✕ next to each one. The row stays hidden until that branch falls further behind. Reset to bring every hidden row back.',
      'profile.dismissed.count-label': 'Currently hidden',
      'profile.dismissed.count.none': 'none',
      'profile.dismissed.count.some': '{n} row(s)',
      'profile.dismissed.reset':     '↺ Reset dismissed warnings',
      'profile.dismissed.reset-tip': 'Bring back every banner row you previously dismissed with ✕.',
      'agent.controls.start':   '▶ Start',
      'agent.controls.stop':    '⏹ Stop',
      'agent.quick.placeholder': '— Quick Message —',
      'agent.quick.send':        'Send',
      'agent.quick.add':         '➕',
      'agent.quick.remove':      '🗑',
      'agent.quick.add-tip':     'Save a new quick message (shared across every agent).',
      'agent.quick.remove-tip':  'Remove the selected quick message.',
      'agent.quick.send-tip':    'Send the selected message as keystrokes to this agent.',
      'agent.quick.prompt':      'New quick message — typed into every agent terminal when picked + Send.',
      'agent.quick.confirm-remove': 'Remove this quick message?\n\n{text}',
      'agent.quick.no-ws':       'Agent terminal isn\'t attached yet. Click Start or Reconnect first.',
      'agent.quick.builtin-locked': 'Built-in quick messages can\'t be removed — they\'re part of the dashboard.',
      'agent.quick.manage-title':   'Quick messages — manage your saved entries',
      'agent.quick.manage-empty':   'No user-added quick messages yet. Built-ins are locked and don\'t appear here.',
      'agent.quick.remove-one':     'Remove this entry',
      'agent.quick.delete-selected':   'Delete selected',
      'agent.quick.manage-delete-tip': 'Delete the checked messages',
      'agent.controls.search':     '🔍',
      'agent.controls.search-tip': 'Search terminal output (Ctrl+F)',
      'agent.search.placeholder':  'Search…',
      'agent.search.no-results':   'No results',
      'agent.controls.paste-image-tip':      'Paste image from clipboard (e.g. a screenshot) — uploads it and inserts an @path',
      'agent.drop.hint':                    'Drop files from file manager to paste @paths',
      'agent.drop.toast.use-file-manager':  'Drag from your file manager to insert an @path — browser drags have no host path.',
      'agent.drop.toast.image-pasted':      'Screenshot uploaded — @path inserted',
      'agent.drop.toast.failed':            'Upload failed: {error}',
      'agent.controls.disconnect': '⊘ Disconnect',
      'agent.controls.disconnect-tip': 'Close the WebSocket and leave the agent process running on the server. Reconnect from any tab.',
      'agent.controls.reconnect': '↻ Reconnect',
      'agent.controls.reconnect-tip': 'Reattach to the running agent process on the server.',
      'agent.controls.external': '↗ External',
      'agent.controls.external-tip': 'Open this agent in an external terminal window instead of inline',
      'agent.controls.info':    'Info',
      'agent.controls.info-tip': 'Open the Agent information pane (Activity + Messages) in a modal',
      'agent.controls.fullscreen': '⤢ Fullscreen',
      'agent.controls.fullscreen-exit': '⤡ Exit fullscreen',
      'agent.controls.fullscreen-tip': 'Expand the inline terminal to fill the viewport (click again to restore)',
      'agent.nav.prev-tip':     'Previous issue (stays on the Agent tab; keeps fullscreen if on)',
      'agent.nav.next-tip':     'Next issue (stays on the Agent tab; keeps fullscreen if on)',
      'agent.info.modal-title': 'Agent information · {issue}',
      'agent.info.empty':       'No agent activity yet for this issue.',
      'agent.info.general-not-tracked': 'Agent information isn\'t tracked for the General Agent yet — it runs in $HOME and its Claude session directory isn\'t under <worktrees_root>/<issue>/. Coming as a follow-up.',
      'agent.status.running':   '🟢 {age}',
      'agent.status.running-tip': 'Agent running · pid {pid} · started {age} ago',
      'agent.status.not-running': '⚫',
      'agent.status.not-running-tip': 'Agent not running',
      'agent.terminal.placeholder': 'Click ▶ Start to launch the agent in this issue\'s worktree.',
      'agent.terminal.disconnected': 'disconnected — close and reopen the Agent tab to re-attach',
      'agent.terminal.ws-error': 'WebSocket error — check the server log',
      'toast.agent.stopped':    '⏹ stopped agent for {issue}',
      'profile.console.inline-default': 'Inline agent console',
      'profile.console.inline-default.label': 'Inline agent console (vs external terminal)',
      'profile.help.console.inline-default': 'When on, each issue tab gets two sub-tabs: Branches (the repo cards you see today) and Agent (an in-browser xterm running `claude --continue`). Off restores today\'s single-pane layout where the 💻 button spawns an external terminal.',
      'tip.filters':            'Show / hide filter and sort controls',
      'tip.enable-notifications': 'Allow desktop notifications for the EOD sync reminder',
      'notif.modal.title':      '🔔 Enable desktop notifications?',
      'notif.modal.body':       'Get a desktop notification when Claude finishes a task or needs your input. You can change this any time in your browser site settings.',
      'notif.modal.enable':     'Enable',
      'notif.modal.dismiss':    'Not now',
      'tip.open-console':       'Open this issue in a new terminal tab with `claude --continue`',
      // Stat cards
      'stat.issues':            'Issues',
      'stat.agents':            'Agents',
      'stat.idle-suffix':       '({n} idle)',
      'stat.repo-checkouts':    'Repo checkouts',
      'stat.dirty-trees':       'Dirty trees',
      'stat.unpushed':          'Unpushed commits',
      'stat.behind':            'Branches >{n} behind',
      // Profile popover
      'profile.tab.dashboard':  'Dashboard',
      'profile.tab.agent':      'Agent CLI',
      'profile.agent.intro':    'Which coding-agent CLI the 🤖 Agent button launches. The provider must be installed on PATH — disabled rows have no binary detected.',
      'profile.agent.installed':'installed',
      'profile.agent.missing':  'not installed',
      'profile.agent.mcp':      'MCP',
      'profile.agent.hooks':    'hooks',
      'profile.tab.model':      'Model',
      'profile.help.model':     'Model passed via `--model …` when the 🤖 Agent button opens a terminal for the currently-selected provider. Default = let the CLI pick.',
      'profile.label.model':    'Model',
      'profile.label.general-agent-model.generic': 'General Agent model',
      'profile.help.general-agent-model.generic': 'Override the model for the pinned General Agent tab. Inherits the default above unless you pick one here.',
      'profile.tab.claude-model': 'Claude model',
      'profile.tab.theme':      'Theme',
      'profile.tab.language':   'Language',
      'profile.tab.notify':     'Notify Me',
      'profile.tab.server':     'Server',
      'profile.tab.backup':     '💾 Backup',
      // ─ Backup tab + history modal ─
      'backup.section.schedule': 'Schedule',
      'backup.section.actions':  'Actions',
      'backup.section.history':  'History',
      'backup.label.enabled':    'Run scheduled backups automatically',
      'backup.label.every':      'Every',
      'backup.label.days':       'days',
      'backup.label.retention':  'Keep last',
      'backup.label.backups':    'backups',
      'backup.label.directory':  'Directory',
      'backup.placeholder.default': '(default)',
      'backup.meta.last':        'Last',
      'backup.meta.next':        'Next',
      'backup.meta.no-backups':  'No backups yet',
      'backup.action.run-now':   'Run backup now',
      'backup.action.download':  'Download DB snapshot',
      'backup.action.restore':   'Restore from file…',
      'backup.action.running':   '… running',
      'backup.action.delete':    'Delete',
      'backup.tip.run-now':      'Run a backup now',
      'backup.tip.download':     'Download a one-shot snapshot of just the SQLite cache',
      'backup.tip.restore':      'Replace the SQLite cache from a previous backup file',
      'backup.tip.delete':       'Delete this backup directory from disk',
      'backup.confirm.delete':   'Delete the backup at {path}? This removes the directory from disk.',
      'backup.history.empty':    'No backups recorded yet.',
      'backup.history.col.when':    'When',
      'backup.history.col.path':    'Path',
      'backup.history.col.size':    'Size',
      'backup.history.col.bundles': 'Bundles',
      'backup.history.col.status':  'Status',
      'backup.history.col.actions': '',
      'backup.history.view-all': 'View all backups ({count})',
      'backup.history.modal-title': '💾 Backup history',
      'backup.history.entries':  '· {count} entries',
      'backup.history.entries-one': '· 1 entry',
      'backup.loading':          'loading…',
      'backup.error.settings':   '(error loading settings)',
      'backup.error.history':    '(error loading history)',
      'backup.toast.ok':         '✓ backup → {path} ({size})',
      'backup.toast.failed':     'backup failed: {error}',
      'backup.toast.deleted':    '✓ backup deleted',
      'backup.toast.delete-failed': 'delete failed: {error}',
      'profile.label.editor':   'Editor',
      'profile.label.claude-model': 'Claude model',
      'profile.label.sync':     'Sync',
      'profile.label.auto-refresh': 'Auto-refresh',
      'profile.label.activity': 'Activity',
      'profile.label.timer':    'Timer',
      'profile.label.compact':  'Compact',
      'profile.label.agent-info': 'Agent info',
      'profile.label.missing-repos': 'Missing repos',
      'profile.label.show-sync-controls': ' Show sync controls',
      'profile.label.show-auto-refresh':  ' Refresh the dashboard every 5 minutes',
      'profile.label.show-activity':      ' Show activity heatmap',
      'profile.label.show-timer':         ' Show timer + work-log card',
      'profile.label.show-compact':       ' Compact dashboard (default on)',
      'profile.label.show-agent-info':    ' Show "Agent information" section per issue',
      'profile.label.show-missing-repos': ' Show "Not in this worktree" placeholder rows',
      'profile.subtab.general':    'General',
      'profile.subtab.advanced':   'Advanced',
      'profile.subtab.visibility': 'Visibility',
      'profile.subtab.agents':     'Agents',
      'profile.general-agent':       'Default Agent tab',
      'profile.general-agent.label': 'Show the pinned "Agent" tab on the left',
      'profile.help.general-agent':  'A permanent leftmost tab that runs an issue-less Claude agent in your $HOME, so you can chat without spawning a worktree first. Off hides the tab entirely.',
      'profile.mcp-enabled':         'Agent-to-agent messaging',
      'profile.mcp-enabled.label':   'Let agents send each other messages (MCP)',
      'profile.help.mcp-enabled':    'Exposes send_message / read_messages / request_review MCP tools to each agent and surfaces unread mail as a 📬 badge on the tab. Off launches agents without the tools registered.',
      'profile.mailbox-auto-poll':       'Mailbox auto-poll',
      'profile.mailbox-auto-poll.label': 'Nudge idle agents about unread mail',
      'profile.help.mailbox-auto-poll':  'Once a minute, if an attached agent has unread messages and the user has been idle in its terminal for at least 30s, the dashboard writes a synthetic prompt asking the agent to call read_messages and reply. Throttled per agent so a slow read does not get repeatedly poked. On by default — turn off if the synthetic prompts feel intrusive.',
      'profile.auto-update-check':       'Dashboard auto-update check',
      'profile.auto-update-check.label': 'Watch this repo for new commits on origin',
      'profile.help.auto-update-check':  'Every 10 minutes the server runs `git fetch origin` against the dashboard repo and shows a banner when there are new commits. Off hides the banner; the server stays on the version you launched. The actual pull + restart is always opt-in via the Update now button.',
      'mcp.unread':                  'Unread messages',
      'mcp.send':                    'Send',
      'mcp.broadcast-option':        'Broadcast (all live issue agents)',
      'mcp.broadcast-confirm':       'Broadcast this message to {n} live agent(s): {agents}?',
      'mcp.broadcast-empty':         'No live issue agents to broadcast to. Start at least one issue agent first.',
      'mcp.delete.thread-title':     'This message is part of a thread.',
      'mcp.delete.thread-help':      'What would you like to delete?',
      'mcp.delete.btn.cancel':       'Cancel',
      'mcp.delete.btn.one':          'Delete',
      'mcp.delete.btn.thread':       'Delete Conversation ({n})',
      'mcp.compose':                 'Compose…',
      'mcp.empty':                   'No messages',
      'mcp.search.placeholder':      'Search…',
      'mcp.tab.thread':              'Thread',
      'mcp.tab.inbox':               'Received',
      'mcp.tab.outbox':              'Sent',
      'mcp.kind.message':            'message',
      'mcp.kind.review_request':     'review request',
      'mcp.kind.review_response':    'review response',
      'profile.label.github-repos':  'GitHub repos',
      'profile.help.github-repos':   'Repositories the dashboard tracks. Each entry is "owner/repo". Drives the issue/PR list, the per-workspace pill, and the default repo set when adding a new workspace.',
      'github.repos.add':            '+ Add repo',
      'github.repos.empty':          'No repos configured yet. Add at least one "owner/repo" entry.',
      'github.repos.bad-format':     'Repo must be "owner/repo".',
      'github.repos.remove-tip':     'Stop tracking {slug}',
      'github.pick-repos':           'Clone which repos for #{number}?',
      'github.create-with':          'Create with {n} repo(s)',
      'profile.help.editor':    'Used when you click a file path in a Working tree list.',
      'profile.help.claude-model': 'Model passed as `claude --model …` when the 🤖 Agent button opens a terminal. Default = let claude pick.',
      'profile.label.general-agent-model':   'General Agent model',
      'profile.help.general-agent-model':    'Override the model for the pinned General Agent tab. Inherits the default above unless you pick one here. Takes effect on the next time the General Agent terminal starts (Stop + Start to apply).',
      'profile.help.compact':   'Hide the repo card subtitle, worktree path, size and the Branch age · Last Claude · Last build footer. Pills, sync buttons and tooltips still work as before. On by default.',
      'profile.help.sync':      'Reveals the Sync now / Auto-sync buttons and the end-of-day reminder. Off by default.',
      'profile.help.auto-refresh': 'Periodically re-fetches /api/status so live state stays current without you clicking Refresh now. The button still works manually when this is off. On by default.',
      'profile.help.activity':  'GitHub-style heatmap of your commits in the last 365 days. On by default.',
      'profile.help.timer':     'Manual time-tracking card with Start / Stop and the recent work-log entries. On by default.',
      'profile.help.agent-info': 'Adds the per-issue Claude session rollup (token totals, tool use breakdown, recent messages) under each tab. On by default.',
      'profile.label.term-search': 'Terminal search bar',
      'profile.help.term-search':  'Always show the search bar in the top-right corner of the agent terminal. Ctrl+F focuses it. On by default.',
      'profile.help.missing-repos': 'Each issue tab normally renders a placeholder card for every expected repo (core / bssweb / doc / …) that isn’t materialised yet — handy when you want to know what you still need to add. Turn this off to hide those rows and only see the repos you actually have on disk. On by default.',
      'profile.section.theme':  'Theme',
      'profile.section.language': 'Language',
      'profile.section.notify': 'Notify me about',
      'profile.section.server': 'Server',
      'profile.section.dashboard': 'Dashboard',
      'profile.section.diagnostics': 'Diagnostics',
      'profile.theme.help':     'Override the dashboard colour scheme. Synced to your data/<user>/preferences.json so other machines pick up the same theme on next sync.',
      'profile.lang.help':      'Switch the dashboard UI language. Auto follows your browser preference.',
      'profile.notify.help-all':  'All kinds count toward the per-tab 🔔 bell. Uncheck a kind to silence it.',
      'profile.notify.help-some': 'Bell counts {chosen} of {total} kinds.',
      'profile.theme.auto':         'Follow system',
      'profile.theme.auto-help':    'Match the OS dark/light setting (Warm on light, Dark on dark).',
      'profile.theme.light':        'Light',
      'profile.theme.light-help':   'GitHub-style light theme.',
      'profile.theme.dark':         'Dark',
      'profile.theme.dark-help':    'GitHub-style dark theme.',
      'profile.theme.warm':     'Warm',
      'profile.theme.warm-help':'Bright white cards with a warm orange accent.',
      'profile.server.view-logs':   '🪵 View server logs',
      'profile.dashboard-stats':    'Dashboard',
      'profile.stat.generated':     'Generated',
      'profile.stat.sync':          'Sync',
      'profile.stat.path':          'Path',
    },
    sv: {
      'toolbar.refresh-now':    'Uppdatera nu',
      'toolbar.sync-now':       '⇅ Synka nu',
      'toolbar.week-summary':   '📅 Veckosammanfattning',
      'toolbar.agent-events':   '🔔 Agent-händelser',
      'toolbar.add-issue':      '+ Lägg till issue',
      'toolbar.pinned-only':    '📌 Endast fästa',
      'toolbar.pinned-only.on': '📍 Endast fästa',
      'tip.pinned-only':        'Dölj alla flikar vars issue inte är fäst. Klicka 📌 bredvid 🗑 i en issue-rubrik för att fästa/lossa.',
      'toolbar.compact':        '🗜 Kompakt',
      'tip.compact':            'Snabb på/av för kompakt läge. Speglar Profil → Dashboard → Kompakt-kryssrutan.',
      'tip.pin':                'Fäst {issue} — håll fliken längst till vänster oavsett aktiv sortering.',
      'tip.unpin':              'Lossa {issue} — återgå till normal sorteringsordning.',
      'tip.expand-all':         'Expandera alla',
      'tip.collapse-all':       'Fäll ihop alla',
      'tip.expand-all-popover': 'Expandera eller fäll ihop alla sektioner (repo-kort + Agentinformation) i denna flik.',
      'stat.issues.summary':    'Sammanfattning',
      'stat.issues.agent':      'Agent',
      'stat.issues.repos':      '#repon',
      'stat.issues.empty':      'Inga issues än.',
      'notes.error.no-issues':  'Inga issues att lägga till en anteckning på',
      'notes.change-status':    'Ändra status',
      'notes.change-priority':  'Ändra prioritet',
      'notes.filter-by-tag':    'Filtrera på #{tag}',
      'notes.clear-tag':        '✕ rensa tagg',
      'notes.delete-tip':       'Ta bort',
      'notes.add-note-title.issue': '+ Lägg till anteckning — {issue}',
      'notes.add-note-title.pick':  '+ Lägg till anteckning — välj issue',
      'notes.add.placeholder':  'Skriv din anteckning…',
      'notes.add.warn.pick-issue': 'Välj en issue',
      'notes.add-success':      '✓ Anteckning tillagd',
      'notes.error.add-failed': 'tillägg misslyckades',
      'notes.error.save-failed':'sparning misslyckades',
      'notes.error.delete-failed': 'borttagning misslyckades',
      'notes.label.issue':      'Issue',
      'notes.label.status':     'Status',
      'notes.label.priority':   'Prioritet',
      'notes.label.due':        'Förfaller',
      'notes.label.assignee':   'Tilldelad',
      'notes.label.tags':       'Taggar',
      'notes.label.note':       'Anteckning',
      'notes.btn.cancel':       'Avbryt',
      'notes.btn.save':         'Spara',
      'notes.btn.close':        'Stäng',
      'notes.bulk.deleted':     '✓ {n} borttagna',
      'notes.bulk.updated':     '✓ {n} uppdaterade',
      'notes.bulk.delete-failed': '{n} borttagning(ar) misslyckades',
      'notes.bulk.update-failed': '{n} uppdatering(ar) misslyckades',
      'notes.notes-switch-to':  'Växla till vy med endast {issue}',
      'toolbar.filters':        '☰ Filter',
      'toolbar.enable-notifications': '🔔 Aktivera notiser',
      'issue.open-console':     '🤖 Agent',
      'issue.open-worktree':    '↗ Öppna',
      'toolbar.help':           '? Hjälp',
      'tip.help':               'Öppna hjälpfönstret (genväg: ?)',
      'help.title':             '? Hjälp · tangentbordsgenvägar och funktioner',
      'help.section.shortcuts': 'Tangentbordsgenvägar',
      'help.section.features':  'Huvudfunktioner',
      'help.section.docs':      'Dokumentation',
      'help.tab.quick':         'Snabbinfo',
      'help.tab.workspace':     'Agentic workspace',
      'help.tab.api':           'API',
      'help.shortcut.refresh':  'Uppdatera dashboard nu',
      'help.shortcut.new-issue':'Öppna dialogrutan + Lägg till issue',
      'help.shortcut.search':   'Fokusera flikfiltret / sökfältet',
      'help.shortcut.help':     'Öppna detta hjälpfönster',
      'help.shortcut.dismiss':  'Stäng översta överlägget (modaler, toaster, popovers)',
      'help.shortcut.term-search': 'Sök i terminalutdata (när terminalen är fokuserad)',
      'help.feat.tabs':         'Flikar längst upp: en per {root}/<issue>/. ⓘ-ikonen visar en per-repo ↓↑-tabell vid hover.',
      'help.feat.bell':         '🔔 Agent-händelser: per-flik-räknare för olästa händelser. Klicka på märket för en per-issue-modal; verktygsfältets 🔔-knapp visar allt.',
      'help.feat.notes':        '📝 Anteckningar per issue: lätta todo / klar / inte klar. Redigerbara inline, sorterbara, flippbar status.',
      'help.feat.console':      '🤖 Agent öppnar issuen i ny gnome-terminal-flik med `claude --continue`. ↗ Öppna öppnar issue-katalogen i editorn.',
      'help.feat.git-ops':      'Per-repo Fetch / Pull --ff-only / Push-knappar; inaktiverade tillstånd förklarar varför när divergens skulle blockera dem.',
      'help.feat.themes':       'Profil-popover (avatar uppe till höger): byt tema, språk, notistyper, växla dashboard-sektioner.',
      'help.docs-blurb':        'Agentinformation:',
      'tab.starting':           'Börja här…',
      'tab.generic-agent':      'Agent 007',
      'tab.engineering-agent':  'Agent Engineering',
      'tab.messages':           'Meddelanden',
      'empty.dashboard.title':  'Inga worktrees ännu',
      'empty.dashboard.body':   'Dashboarden visar en flik per {path}/<issue>/-katalog. Den katalogen är tom just nu — klicka + Lägg till issue för att skapa din första worktree, eller läs dokumentationen först.',
      'time.ago':               'sedan',
      'time.now':               'just nu',
      'pill.clean':             'rent',
      'pill.dirty':             '{n} ändring',
      'pill.dirty-plural':      '{n} ändringar',
      'pill.unpushed':          '{n} opushade',
      'pill.not-started':       'ej startad',
      'pill.ahead':             '+{n} före',
      'pill.behind':            '−{n} efter',
      'pill.behindbad':         '⚠ {n} efter',
      'pill.missing':           '🚫 saknas',
      'pill.removed':           'borttagen {date}',
      'repo.not-in-worktree':   'Saknas i denna worktree',
      'notes.title':            '📝 Anteckningar — {issue}',
      'notes.title.all':        '📝 Anteckningar — alla issues',
      'notes.meta':             '· {count} anteckning{plural} · {todo} todo',
      'notes.add-button':       '+ Lägg till',
      'notes.close-button':     '✕ Stäng',
      'notes.all-button':       'Alla issues',
      'notes.this-button':      'Endast denna issue',
      'notes.empty':            'Inga anteckningar än — klicka + Lägg till för att skapa den första.',
      'notes.empty-filtered':   'Inga anteckningar matchar de aktuella filtren.',
      'notes.search.placeholder': 'Sök anteckningar — innehåll, taggar, tilldelad, issue…',
      'notes.col.issue':        'Issue',
      'notes.col.created':      'Skapad',
      'notes.col.status':       'Status',
      'notes.col.priority':     'Prioritet',
      'notes.col.due':          'Förfaller',
      'notes.col.assignee':     'Tilldelad',
      'notes.col.tags':         'Taggar',
      'notes.col.note':         'Anteckning',
      'notes.status.todo':      'Att göra',
      'notes.status.done':      'Klar',
      'notes.status.not_done':  'Avslagen',
      'notes.priority.low':     'Låg',
      'notes.priority.normal':  'Normal',
      'notes.priority.high':    'Hög',
      'notes.delete-confirm':   'Ta bort denna anteckning?',
      'notes.bulk-delete-confirm': 'Ta bort {count} anteckning{plural}?',
      'notes.empty-warn':       'Anteckningen får inte vara tom',
      'notes.click-to-edit':    'Klicka för att redigera · Esc för att ångra',
      'notes.bulk.selected':    '{count} markerade',
      'notes.bulk.delete':      'Ta bort markerade',
      'notes.bulk.status':      'Sätt status',
      'notes.bulk.priority':    'Sätt prioritet',
      'notes.bulk.clear':       'Avmarkera',
      'notes.sort.manual':      'Manuell',
      'notes.assignee.placeholder': 'ej tilldelad',
      'notes.tags.placeholder': 'kommaseparerade taggar',
      'notes.due.cleared':      '—',
      'notes.due.overdue':      'försenad',
      'notes.due.today':        'idag',
      'notes.due.tomorrow':     'imorgon',
      'addIssue.title':         '+ Lägg till issue',
      'addIssue.label.issue':   'Issue',
      'addIssue.label.base':    'Branch från',
      'addIssue.label.repos':   'Repon',
      'addIssue.help.issue':    'BSS-nyckel eller annat branch-säkert namn. Om origin/<issue> redan finns spårar den nya worktreen den.',
      'addIssue.help.base':     'Används endast när origin/<issue> INTE finns. Slår upp lokal ref först, sedan origin/<base>.',
      'addIssue.button.create': 'Skapa',
      'addIssue.button.cancel': 'Avbryt',
      'addIssue.button.creating':'Skapar…',
      'addIssue.button.done':   'Klar',
      'addIssue.warn.empty':    'Issue-nyckel krävs',
      'addIssue.warn.invalid':  'Ogiltigt issue-namn',
      'addIssue.warn.no-repos': 'Välj minst ett repo',
      'addIssue.col.repo':      'Repo',
      'addIssue.col.result':    'Resultat',
      'addIssue.col.detail':    'Detalj',
      'toolbar.next-refresh':   'nästa uppdatering om {time}',
      'toolbar.refreshing':     'uppdaterar…',
      'toolbar.auto-refresh-off': 'Autouppdatering är av — klicka för att uppdatera nu',
      'tip.refresh-now':        'Kör en synk av agent-workspace-repot nu',
      'tip.kv.status':          'Status',
      'tip.kv.summary':         'Sammanfattning',
      'tip.kv.assignee':        'Tilldelad',
      'tip.kv.open':            'Öppna',
      'tip.kv.issue':           'Ärende',
      'tip.kv.no-live-issues':  'Inga aktiva ärenden att inspektera.',
      // Vanliga kolumnetiketter återanvända i sammanfattnings­kortens
      // hover-popovers (Repos / Ändrade / Efter) och inuti repo-korten.
      'col.repo':               'Repo',
      'col.repos':              'Repos',
      'col.branch':             'Branch',
      'col.dirty':              'Ändrade',
      'col.behind':             'Efter',
      'col.upstream':           'Uppström',
      'col.working-tree':       'Arbetsträd',
      'col.last-subject':       'Senaste meddelande',
      'col.last-claude':        'Senaste Claude',
      'col.last-prompt':        'Senaste prompt',
      'col.detail':             'Detaljer',
      'empty.no-repos':         'Inga repos utcheckade.',
      'empty.no-dirty':         'Inga ändrade träd.',
      // Vanliga knappetiketter som återanvänds i dialoger.
      'btn.cancel':             'Avbryt',
      'btn.add':                'Lägg till',
      'btn.save':                'Spara',
      'btn.close':              'Stäng',
      'btn.sync-now':           'Synka nu',
      // Vanliga toast-meddelanden.
      'toast.pick-issue':       'Välj ett ärende först',
      'toast.issue-required':   'ärende krävs',
      'toast.minutes-positive': 'minuter måste vara > 0',
      'toast.pick-editor':      'Välj en editor i verktygsraden först',
      'toast.start-failed':     'start misslyckades: {err}',
      'toast.stop-failed':      'stopp misslyckades: {err}',
      'toast.add-failed':       'tillägg misslyckades: {err}',
      'toast.delete-failed':    'radering misslyckades: {err}',
      'toast.delete-failed-short': 'radering misslyckades',
      'toast.open-failed':      'Öppning misslyckades: {err}',
      'toast.create-failed':    'Skapande misslyckades: {err}',
      'toast.mark-read-failed': 'Markera-som-läst misslyckades: {err}',
      'toast.week-summary-failed': 'Hämtning av veckosammanfattning misslyckades: {err}',
      'toast.notify.unsupported': 'Notiser stöds inte i denna webbläsare',
      'toast.notify.blocked':   'Notiser blockerade — aktivera i webbläsarinställningarna',
      'toast.notify.not-enabled': 'Notiser ej aktiverade',
      'toast.toggle-failed':    'Växling misslyckades: {err}',
      'toast.sync-request-failed': 'Synk-begäran misslyckades: {err}',
      'remove.confirm-agent':   "En Claude-agent körs fortfarande för {issue}.\n\nAtt ta bort worktree:n nu kan lämna agentens öppna filer i ett halvsparat tillstånd. Det säkra är att avsluta agenten först (Ctrl-D i dess terminalflik).\n\nTa bort ändå?",
      // Kolumnrubriker i agenthändelse-modalen.
      'evt.col.time':           'Tid',
      'evt.col.kind':           'Typ',
      'evt.col.issue':          'Ärende',
      'evt.col.message':        'Meddelande',
      // Övriga kolumnrubriker i popovers och inline-tabeller.
      'col.range':              'Intervall',
      'col.comments':           'Kommentar',
      'col.latest-subject':     'Senaste meddelande',
      // Profil-/dashboard-statetiketter.
      'profile.stat.generated': 'Genererad',
      'profile.stat.sync':      'Synk',
      'profile.stat.path':      'Sökväg',
      'profile.stat.version':   'Version',
      'profile.stat.uptime':    'Drifttid',
      'profile.stat.requests':  'Förfrågningar',
      'profile.stat.logs':      'Loggar',
      'profile.stat.pid':       'PID',
      'profile.stat.last-run':  'Senast kört',
      // Generiska UI-strängar.
      'ui.loading':             'Laddar…',
      'ui.load-failed':         'Misslyckades att läsa in: {err}',
      'ui.activity':            'Aktivitet',
      'ui.messages':            'Meddelanden',
      'ui.filter.show-only':    'Visa endast:',
      'ui.issue-label':         'Ärende:',
      'ui.loading-healthz':     'Läser in /healthz…',
      'ui.loading-description': 'Läser in beskrivning…',
      'ui.loading-readme':      'Läser in README…',
      'ui.removing-worktrees':  'Tar bort worktrees…',
      'ui.branch-age':          'Branchålder: ',
      'ui.last-claude':         'Senaste Claude: ',
      'ui.last-build':          'Senaste bygge: ',
      'ui.last-commit':         'Senaste commit: ',
      'ui.worktree-disk':       'Diskanvändning per worktree',
      'ui.labels-prefix':       'Etiketter: ',
      'ui.by-day':              'Per dag',
      'ui.by-issue':            'Per ärende',
      'tip.week-summary':       'Visa denna veckas commit- och token-sammanfattning',
      'tip.agent-events':       'Alla senaste händelser från Claude Code-hookar',
      'issue.open-issue':       '↗ Öppna',
      'tip.open-issue':         'Öppna issuens worktree-katalog ({root}/<issue>/) så att alla repon syns sida-vid-sida.',
      'toolbar.notes':          '📝 Anteckningar',
      'tip.notes':              'Alla anteckningar över alla issues, med filter',
      'tip.add-issue':          'Skapa en ny worktree under {root}/<issue>/ för ett eller flera repon',
      'tip.add-issue.cloning':  'Vänta tills primärrepon är färdigklonade: {repos}',
      'issue.subtab.branches':  'Brancher',
      'issue.subtab.agent':     'Agent',
      'issue.subtab.messages':  'Meddelanden',
      'issue.subtab.stashes':   'Stashar',
      'stashes.empty':          'Inga stashar',
      'stashes.title':          'Stashar',
      'stashes.view':           'Filer',
      'stashes.drop':           'Ta bort',
      'stashes.confirm-drop':   'Ta bort stash {ref} från {repo}? Detta går inte att ångra.',
      'stashes.added':          '+{n}',
      'stashes.removed':        '−{n}',
      'stashes.binary':         'binär',
      'update.banner.title':       '🔔 Uppdatering tillgänglig',
      'update.banner.subtitle':    '{n} commit{plural} efter på {branch}',
      'update.banner.update-btn':  'Uppdatera nu',
      'update.banner.dismiss-btn': 'Senare',
      'update.confirm.no-agents':  'Hämta origin/{branch} och starta om dashboarden? Den här fliken laddas om.',
      'update.confirm.with-agents': 'Hämta origin/{branch} och starta om dashboarden?\n\n{n} agentterminal(er) kommer att stoppas mjukt: {agents}.\n\nclaude --continue återupptar dem efter omstarten.',
      'update.restarting':         'Startar om dashboarden… återansluter…',
      'update.pull-failed':        'Pull misslyckades: {error}',
      'restart.btn':               '🔄 Starta om server',
      'restart.btn-tip':           'Stoppar varje agentterminal som körs och startar om dashboard-servern. Använd när MCP-konfiguration har ändrats eller om något har fastnat.',
      'restart.confirm.no-agents': 'Starta om dashboard-servern? Den här fliken laddas om.',
      'restart.confirm.with-agents': 'Starta om dashboard-servern?\n\n{n} agentterminal(er) kommer att stoppas mjukt: {agents}.\n\nclaude --continue återupptar dem efter omstarten.',
      'restart.failed':            'Omstart misslyckades: {error}',
      'profile.section.dismissed':   'Dolda varningar',
      'profile.dismissed.help':      'Du kan dölja enskilda rader i bannern "branscher >N commits efter upstream" genom att klicka på ✕ bredvid varje rad. Raden förblir dold tills branchen halkar längre efter. Återställ för att ta tillbaka alla dolda rader.',
      'profile.dismissed.count-label': 'Dolda nu',
      'profile.dismissed.count.none': 'inga',
      'profile.dismissed.count.some': '{n} rad(er)',
      'profile.dismissed.reset':     '↺ Återställ dolda varningar',
      'profile.dismissed.reset-tip': 'Ta tillbaka alla bannerrader du tidigare dolt med ✕.',
      'agent.controls.start':   '▶ Starta',
      'agent.controls.stop':    '⏹ Stoppa',
      'agent.quick.placeholder': '— Snabbmeddelande —',
      'agent.quick.send':        'Skicka',
      'agent.quick.add':         '➕',
      'agent.quick.remove':      '🗑',
      'agent.quick.add-tip':     'Spara ett nytt snabbmeddelande (delat mellan alla agenter).',
      'agent.quick.remove-tip':  'Ta bort valt snabbmeddelande.',
      'agent.quick.send-tip':    'Skicka valt meddelande som tangenttryckningar till denna agent.',
      'agent.quick.prompt':      'Nytt snabbmeddelande — skrivs in i agentterminalen när du väljer + Skicka.',
      'agent.quick.confirm-remove': 'Ta bort detta snabbmeddelande?\n\n{text}',
      'agent.quick.no-ws':       'Agentterminalen är inte ansluten. Klicka Start eller Återanslut först.',
      'agent.quick.builtin-locked': 'Inbyggda snabbmeddelanden kan inte tas bort — de är en del av dashboarden.',
      'agent.quick.manage-title':   'Snabbmeddelanden — hantera dina sparade',
      'agent.quick.manage-empty':   'Inga egna snabbmeddelanden ännu. Inbyggda är låsta och visas inte här.',
      'agent.quick.remove-one':     'Ta bort detta',
      'agent.quick.delete-selected':   'Ta bort valda',
      'agent.quick.manage-delete-tip': 'Ta bort de markerade meddelandena',
      'agent.controls.search':     '🔍',
      'agent.controls.search-tip': 'Sök i terminalutdata (Ctrl+F)',
      'agent.search.placeholder':  'Sök…',
      'agent.search.no-results':   'Inga resultat',
      'agent.controls.paste-image-tip':      'Klistra in bild från urklipp (t.ex. skärmbild) — laddar upp och infogar @sökväg',
      'agent.drop.hint':                    'Dra filer från filhanteraren för att klistra in @sökväg',
      'agent.drop.toast.use-file-manager':  'Dra från filhanteraren för att infoga en @sökväg — webbläsardrag har ingen värdsökväg.',
      'agent.drop.toast.image-pasted':      'Skärmbild uppladdad — @sökväg infogad',
      'agent.drop.toast.failed':            'Uppladdning misslyckades: {error}',
      'agent.controls.disconnect': '⊘ Koppla från',
      'agent.controls.disconnect-tip': 'Stäng WebSocket och låt agentprocessen fortsätta köra på servern. Återanslut från valfri flik.',
      'agent.controls.reconnect': '↻ Återanslut',
      'agent.controls.reconnect-tip': 'Återanslut till den körande agentprocessen på servern.',
      'agent.controls.external': '↗ Externt',
      'agent.controls.external-tip': 'Öppna denna agent i ett externt terminalfönster istället för inline',
      'agent.controls.info':    'Info',
      'agent.controls.info-tip': 'Öppna Agentinformation (Aktivitet + Meddelanden) i en dialog',
      'agent.controls.fullscreen': '⤢ Helskärm',
      'agent.controls.fullscreen-exit': '⤡ Avsluta helskärm',
      'agent.controls.fullscreen-tip': 'Förstora den inline-terminalen så att den fyller fönstret (klicka igen för att återställa)',
      'agent.nav.prev-tip':     'Föregående issue (stannar på Agent-fliken; behåller helskärm)',
      'agent.nav.next-tip':     'Nästa issue (stannar på Agent-fliken; behåller helskärm)',
      'agent.info.modal-title': '🤖 Agentinformation · {issue}',
      'agent.info.empty':       'Ingen agentaktivitet ännu för denna issue.',
      'agent.info.general-not-tracked': 'Agentinformation spåras inte än för Allmän agent — den körs i $HOME och dess Claude-sessionskatalog ligger inte under <worktrees_root>/<issue>/. Kommer som uppföljning.',
      'agent.status.running':   '🟢 {age}',
      'agent.status.running-tip': 'Agent körs · pid {pid} · startad {age} sedan',
      'agent.status.not-running': '⚫',
      'agent.status.not-running-tip': 'Agent körs inte',
      'agent.terminal.placeholder': 'Klicka ▶ Starta för att starta agenten i issuens worktree.',
      'agent.terminal.disconnected': 'frånkopplad — stäng och öppna Agent-fliken för att återansluta',
      'agent.terminal.ws-error': 'WebSocket-fel — kolla serverloggen',
      'toast.agent.stopped':    '⏹ stoppade agenten för {issue}',
      'profile.console.inline-default': 'Inline agentkonsol',
      'profile.console.inline-default.label': 'Inline agentkonsol (istället för extern terminal)',
      'profile.help.console.inline-default': 'När på får varje issue-flik två underflikar: Brancher (kortvyn du ser idag) och Agent (en xterm i webbläsaren som kör `claude --continue`). Av återgår till dagens vy där 💻-knappen startar en extern terminal.',
      'profile.path.browse':    '📂 Bläddra',
      'profile.path.browse-tip': 'Visa worktree-rotens katalogträd (issues + repon på disk) i en dialog.',
      'profile.path.reset':     '🗑',
      'profile.path.reset-tip': 'FARA: ta bort alla worktrees och rensa databasen för denna dashboard-instans.',
      'reset.modal.title':      '⚠ Återställ denna workspace?',
      'reset.modal.body':       'Detta tar permanent bort ALLT för denna dashboard-instans:\n· alla worktrees under {path}\n· alla primärrepo-kloner i samma primaries-rot\n· alla rader i aktivitetsdatabasen (anteckningar, agent-händelser, inställningar, veckosammanfattningar, backup-historik)\nVid nästa start visas "Missing primary repos"-bannern — du behöver klona om.',
      'reset.modal.confirm':    'Fortsätt',
      'reset.modal.cancel':     'Avbryt',
      'reset.modal.final.title': '⚠ Slutgiltig bekräftelse',
      'reset.modal.final.body': 'Det finns ingen ångrafunktion. Klicka "Ja, återställ" för att radera {path} och aktivitetsdatabasen nu.',
      'reset.modal.final.confirm': 'Ja, återställ',
      'toast.reset.ok':         '✓ Workspace återställd · {n} worktree(s) och {p} primärrepo(n) borttagna',
      'toast.reset.failed':     'Återställning misslyckades: {err}',
      'tip.filters':            'Visa / dölj filter- och sortkontroller',
      'tip.enable-notifications': 'Tillåt skrivbordsnotiser för dagsslutpåminnelsen',
      'notif.modal.title':      '🔔 Aktivera skrivbordsnotiser?',
      'notif.modal.body':       'Få en skrivbordsnotis när Claude blir klar med en uppgift eller behöver din input. Du kan ändra detta när som helst i webbläsarens platsinställningar.',
      'notif.modal.enable':     'Aktivera',
      'notif.modal.dismiss':    'Inte nu',
      'tip.open-console':       'Öppna denna issue i en ny terminalflik med `claude --continue`',
      'stat.issues':            'Issues',
      'stat.agents':            'Agenter',
      'stat.idle-suffix':       '({n} inaktiva)',
      'stat.repo-checkouts':    'Utcheckade repos',
      'stat.dirty-trees':       'Ändrade repos',
      'stat.unpushed':          'Opushade commits',
      'stat.behind':            'Brancher >{n} efter',
      'profile.tab.dashboard':  'Dashboard',
      'profile.tab.agent':      'Agent-CLI',
      'profile.agent.intro':    'Vilket coding-agent-CLI som 🤖 Agent-knappen startar. Verktyget måste finnas på PATH — gråa rader saknar binär.',
      'profile.agent.installed':'installerad',
      'profile.agent.missing':  'saknas',
      'profile.agent.mcp':      'MCP',
      'profile.agent.hooks':    'hooks',
      'profile.tab.model':      'Modell',
      'profile.help.model':     'Modell som skickas via `--model …` när 🤖 Agent-knappen startar en terminal för aktuell provider. Tom = låt CLI:t välja.',
      'profile.label.model':    'Modell',
      'profile.label.general-agent-model.generic': 'Modell för General Agent',
      'profile.help.general-agent-model.generic': 'Sätt en egen modell för den fasta General Agent-fliken. Ärver standardvärdet ovan om du inte väljer här.',
      'profile.tab.claude-model': 'Claude-modell',
      'profile.tab.theme':      'Tema',
      'profile.tab.language':   'Språk',
      'profile.tab.notify':     'Notiser',
      'profile.tab.server':     'Server',
      'profile.tab.backup':     '💾 Backup',
      // ─ Backup-fliken + historik-modal ─
      'backup.section.schedule': 'Schema',
      'backup.section.actions':  'Åtgärder',
      'backup.section.history':  'Historik',
      'backup.label.enabled':    'Kör schemalagda säkerhetskopior automatiskt',
      'backup.label.every':      'Var',
      'backup.label.days':       'dag',
      'backup.label.retention':  'Behåll senaste',
      'backup.label.backups':    'kopior',
      'backup.label.directory':  'Katalog',
      'backup.placeholder.default': '(standard)',
      'backup.meta.last':        'Senast',
      'backup.meta.next':        'Nästa',
      'backup.meta.no-backups':  'Inga säkerhetskopior ännu',
      'backup.action.run-now':   'Kör säkerhetskopia nu',
      'backup.action.download':  'Ladda ner DB-ögonblicksbild',
      'backup.action.restore':   'Återställ från fil…',
      'backup.action.running':   '… kör',
      'backup.action.delete':    'Radera',
      'backup.tip.run-now':      'Kör en säkerhetskopia nu',
      'backup.tip.download':     'Ladda ner en konsekvent kopia av enbart SQLite-cachen',
      'backup.tip.restore':      'Ersätt SQLite-cachen med en tidigare säkerhetskopia',
      'backup.tip.delete':       'Radera denna säkerhetskopia från disken',
      'backup.confirm.delete':   'Radera säkerhetskopian på {path}? Detta tar bort katalogen från disken.',
      'backup.history.empty':    'Inga säkerhetskopior registrerade ännu.',
      'backup.history.col.when':    'När',
      'backup.history.col.path':    'Sökväg',
      'backup.history.col.size':    'Storlek',
      'backup.history.col.bundles': 'Paket',
      'backup.history.col.status':  'Status',
      'backup.history.col.actions': '',
      'backup.history.view-all': 'Visa alla säkerhetskopior ({count})',
      'backup.history.modal-title': '💾 Säkerhetskopia-historik',
      'backup.history.entries':  '· {count} poster',
      'backup.history.entries-one': '· 1 post',
      'backup.loading':          'laddar…',
      'backup.error.settings':   '(fel vid hämtning av inställningar)',
      'backup.error.history':    '(fel vid hämtning av historik)',
      'backup.toast.ok':         '✓ kopia → {path} ({size})',
      'backup.toast.failed':     'säkerhetskopia misslyckades: {error}',
      'backup.toast.deleted':    '✓ säkerhetskopia raderad',
      'backup.toast.delete-failed': 'radering misslyckades: {error}',
      'profile.label.editor':   'Editor',
      'profile.label.claude-model': 'Claude-modell',
      'profile.label.general-agent-model': 'Modell för Allmän agent',
      'profile.help.general-agent-model':  'Åsidosätt modellen för den fasta Allmän agent-fliken. Ärver standarden ovan om inget val görs här. Verkställs nästa gång terminalen för Allmän agent startas (Stopp + Start för att applicera).',
      'profile.label.sync':     'Synk',
      'profile.label.auto-refresh': 'Autouppdatera',
      'profile.label.activity': 'Aktivitet',
      'profile.label.timer':    'Timer',
      'profile.label.compact':  'Kompakt',
      'profile.label.agent-info': 'Agentinfo',
      'profile.label.missing-repos': 'Saknade repos',
      'profile.label.show-sync-controls': ' Visa synk-knappar',
      'profile.label.show-auto-refresh':  ' Uppdatera dashboarden var 5:e minut',
      'profile.label.show-activity':      ' Visa aktivitetsdiagram',
      'profile.label.show-timer':         ' Visa timer- och tidslogg-kort',
      'profile.label.show-compact':       ' Kompakt vy (standard på)',
      'profile.label.show-agent-info':    ' Visa "Agentinformation"-sektion per issue',
      'profile.label.show-missing-repos': ' Visa "Inte i denna worktree"-platshållarrader',
      'profile.subtab.general':    'Allmänt',
      'profile.subtab.advanced':   'Avancerat',
      'profile.subtab.visibility': 'Visning',
      'profile.subtab.agents':     'Agenter',
      'profile.general-agent':       'Standard-agentflik',
      'profile.general-agent.label': 'Visa den fasta "Agent"-fliken till vänster',
      'profile.help.general-agent':  'En permanent flik längst till vänster som kör en issue-fri Claude-agent i ditt $HOME, så du kan chatta utan att skapa en worktree först. Avstängd döljer fliken helt.',
      'profile.mcp-enabled':         'Meddelanden mellan agenter',
      'profile.mcp-enabled.label':   'Låt agenter skicka meddelanden till varandra (MCP)',
      'profile.help.mcp-enabled':    'Exponerar verktygen send_message / read_messages / request_review till varje agent och visar olästa meddelanden som en 📬-symbol på fliken. Av startar agenter utan verktygen registrerade.',
      'profile.mailbox-auto-poll':       'Automatisk inkorgskoll',
      'profile.mailbox-auto-poll.label': 'Puffa inaktiva agenter om olästa meddelanden',
      'profile.help.mailbox-auto-poll':  'En gång per minut: om en ansluten agent har olästa meddelanden och användaren har varit inaktiv i terminalen i minst 30 s skriver dashboarden in en syntetisk prompt som ber agenten anropa read_messages och svara. Strypt per agent så en långsam läsning inte puffas om och om igen. På som standard — slå av om de syntetiska prompterna känns påträngande.',
      'profile.auto-update-check':       'Uppdateringskontroll',
      'profile.auto-update-check.label': 'Bevaka repot för nya commits på origin',
      'profile.help.auto-update-check':  'Var tionde minut kör servern `git fetch origin` mot dashboard-repot och visar en banner när det finns nya commits. Av döljer bannern; servern stannar kvar på den version du startade. Själva pull + omstart sker alltid via Uppdatera nu-knappen.',
      'mcp.unread':                  'Olästa meddelanden',
      'mcp.send':                    'Skicka',
      'mcp.broadcast-option':        'Broadcast (alla aktiva issue-agenter)',
      'mcp.broadcast-confirm':       'Skicka detta meddelande som broadcast till {n} aktiv(a) agent(er): {agents}?',
      'mcp.broadcast-empty':         'Inga aktiva issue-agenter att skicka till. Starta minst en först.',
      'mcp.delete.thread-title':     'Detta meddelande är en del av en tråd.',
      'mcp.delete.thread-help':      'Vad vill du ta bort?',
      'mcp.delete.btn.cancel':       'Avbryt',
      'mcp.delete.btn.one':          'Ta bort',
      'mcp.delete.btn.thread':       'Ta bort konversation ({n})',
      'mcp.compose':                 'Skriv…',
      'mcp.empty':                   'Inga meddelanden',
      'mcp.search.placeholder':      'Sök…',
      'mcp.tab.thread':              'Tråd',
      'mcp.tab.inbox':               'Mottaget',
      'mcp.tab.outbox':              'Skickat',
      'mcp.kind.message':            'meddelande',
      'mcp.kind.review_request':     'granskningsförfrågan',
      'mcp.kind.review_response':    'granskningssvar',
      'profile.label.github-repos':  'GitHub-repon',
      'profile.help.github-repos':   'Repositorier dashboarden följer. Varje rad är "owner/repo". Styr issue/PR-listan, per-workspace-pillet och repo-urvalet när en ny workspace skapas.',
      'github.repos.add':            '+ Lägg till repo',
      'github.repos.empty':          'Inga repon konfigurerade än. Lägg till minst en "owner/repo".',
      'github.repos.bad-format':     'Repo måste skrivas som "owner/repo".',
      'github.repos.remove-tip':     'Sluta följa {slug}',
      'github.pick-repos':           'Klona vilka repon för #{number}?',
      'github.create-with':          'Skapa med {n} repon',
      'profile.help.editor':    'Används när du klickar på en filsökväg i en arbetsträd-lista.',
      'profile.help.compact':   'Döljer repo-kortens underrad, worktree-sökväg, storleksetikett samt Branchålder · Senaste Claude · Senaste bygge-foten. Etiketter, synkknappar och tooltips fungerar som vanligt. På som standard.',
      'profile.help.sync':      'Visar Synka nu- och Auto-synk-knappar samt dagsslutpåminnelsen. Av som standard.',
      'profile.help.auto-refresh': 'Hämtar /api/status periodiskt så att livedata förblir aktuell. Knappen Uppdatera nu fungerar fortfarande manuellt när detta är av. På som standard.',
      'profile.help.activity':  'GitHub-liknande diagram över dina commits senaste 365 dagarna. På som standard.',
      'profile.help.timer':     'Manuell tidsspårning med Start / Stopp och senaste tidslogg-poster. På som standard.',
      'profile.help.agent-info': 'Lägger till per-issue Claude-sessions sammanställning (token-totaler, verktygsanvändning, senaste meddelanden) i varje flik. På som standard.',
      'profile.label.term-search': 'Terminalsökfält',
      'profile.help.term-search':  'Visa alltid sökfältet i övre högra hörnet av agentterminalen. Ctrl+F fokuserar det. På som standard.',
      'profile.help.missing-repos': 'Varje issue-flik renderar normalt ett platshållarkort för varje förväntat repo (core / bssweb / doc / …) som inte är utcheckat ännu — användbart när du vill se vad du saknar. Stäng av för att dölja raderna och bara se de repos du faktiskt har på disk. På som standard.',
      'profile.section.theme':  'Tema',
      'profile.section.language': 'Språk',
      'profile.section.notify': 'Notifiera mig om',
      'profile.section.server': 'Server',
      'profile.section.dashboard': 'Dashboard',
      'profile.section.diagnostics': 'Diagnostik',
      'profile.theme.help':     'Välj färgschema för instrumentpanelen. Synkas till din data/<user>/preferences.json så att andra maskiner får samma tema vid nästa synk.',
      'profile.lang.help':      'Byt UI-språk. Auto följer din webbläsares inställning.',
      'profile.notify.help-all':  'Alla typer räknas i 🔔-klockan per flik. Avmarkera en typ för att tysta den.',
      'profile.notify.help-some': 'Klockan räknar {chosen} av {total} typer.',
      'profile.theme.auto':         'Följ systemet',
      'profile.theme.auto-help':    'Använd OS:ets ljus-/mörkerinställning (Warm i ljust, Dark i mörkt).',
      'profile.theme.light':        'Ljust',
      'profile.theme.light-help':   'GitHub-liknande ljust tema.',
      'profile.theme.dark':         'Mörkt',
      'profile.theme.dark-help':    'GitHub-liknande mörkt tema.',
      'profile.theme.warm':     'Warm',
      'profile.theme.warm-help':'Ljus bakgrund med en varm orange accentfärg.',
      'profile.server.view-logs':   '🪵 Visa serverloggar',
      'profile.dashboard-stats':    'Dashboard',
      'profile.stat.generated':     'Genererad',
      'profile.stat.sync':          'Synk',
      'profile.stat.path':          'Sökväg',
    },
  };
  function detectBrowserLang() {
    return (navigator.language || 'en').toLowerCase().startsWith('sv')
      ? 'sv' : 'en';
  }
  function currentLang() {
    const stored = (localStorage.getItem('lang') || '').trim();
    if (stored === 'en' || stored === 'sv') return stored;
    return detectBrowserLang();
  }
  function t(key, vars) {
    const lang = currentLang();
    let s = (TRANSLATIONS[lang] || {})[key]
         || (TRANSLATIONS.en || {})[key]
         || key;
    // Always-available `{root}` placeholder = the worktrees root the
    // server is actually serving. Lets tooltips / help text show the
    // real path (e.g. `~/github/worktrees`) instead of a hardcoded
    // default. Falls back to a sensible literal when state hasn't
    // landed yet (first render).
    const merged = Object.assign(
      { root: (window.__lastState?.worktrees_root || '~/git/worktrees') },
      vars || {},
    );
    for (const [k, v] of Object.entries(merged)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return s;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    // Hover-tooltip popovers are position:fixed and visually detached
    // from their host element; they often hang over unrelated buttons
    // below the host. With pointer-events:auto on hover, a click on
    // the popover area would bubble up to the .hover-popover-host
    // ancestor and fire its onclick — e.g. clicking what looks like
    // the Fullscreen button below the Notes button would open the
    // Notes modal because the Notes tooltip happened to cover it.
    // Stop the bubble here so the host's onclick can't run.
    // (Interactive children inside the popover, like .hover-popover-row,
    // still receive their own click first — bubble-phase stops AFTER
    // the target handlers have run.)
    if (typeof attrs.class === 'string'
        && attrs.class.split(/\s+/).includes('hover-popover')) {
      el.addEventListener('click', (e) => e.stopPropagation());
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  };

  // ── Click-to-sort table helpers ─────────────────────────────────
  // Generic state: per-table {key, dir} persisted in localStorage so
  // the choice survives reloads and re-renders.
  const TABLE_SORT_DEFAULTS = {
    'by-issue':  { key: 'issue',     dir: 'asc'  },
    'worklog':   { key: 'date_local', dir: 'desc' },
    'worklog-grouped': { key: 'date_local', dir: 'desc' },
    'week-list': { key: 'week_id',   dir: 'desc' },
    'notes':     { key: 'created_at', dir: 'desc' },
    'agent-msgs': { key: 'created_at', dir: 'desc' },
  };
  function loadTableSort(tableId) {
    try {
      const raw = localStorage.getItem(`table-sort-${tableId}`);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.key && (v.dir === 'asc' || v.dir === 'desc')) return v;
      }
    } catch (_) {}
    return { ...(TABLE_SORT_DEFAULTS[tableId] || { key: '', dir: 'asc' }) };
  }
  function saveTableSort(tableId, state) {
    try { localStorage.setItem(`table-sort-${tableId}`,
      JSON.stringify(state)); } catch (_) {}
  }
  // Build a click-to-sort <th>. `accessors[key]` returns the comparable
  // value for a row when key is selected. `tableClasses` are applied
  // alongside the active-sort marker.
  function sortableTh(label, key, sortState, onResort, opts) {
    opts = opts || {};
    const isActive = sortState.key === key;
    const arrow = isActive ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: ((opts.class || '') + ' sortable'
              + (isActive ? ' sorted' : '')).trim(),
      title: opts.title || null,
      onclick: () => {
        const newDir = (isActive && sortState.dir === 'asc') ? 'desc' : 'asc';
        onResort({ key, dir: newDir });
      },
    }, label + arrow);
  }
  // Sort a row array by sortState using accessors[key]. Stable; numeric
  // values use numeric compare, everything else uses localeCompare on
  // the string form.
  function sortRowsBy(rows, sortState, accessors) {
    const { key, dir } = sortState;
    const acc = accessors[key];
    if (!acc) return rows;
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = acc(a), bv = acc(b);
      if (typeof av === 'number' && typeof bv === 'number') {
        return sign * (av - bv);
      }
      return sign * String(av ?? '').localeCompare(String(bv ?? ''));
    });
  }

  // ── Render helpers ──────────────────────────────────────────────
  function pillsFor(repo, behindLimit) {
    const out = [];
    const notStarted = repo.ahead === 0;
    if (notStarted) {
      out.push(h('span', {
        class: 'pill not-started',
        title: 'No commits on this branch yet',
      }, t('pill.not-started')));
    } else if (repo.n_dirty === 0) {
      out.push(h('span', { class: 'pill clean' }, t('pill.clean')));
    }
    if (repo.n_dirty > 0) {
      out.push(h('span', { class: 'pill dirty' },
        t(repo.n_dirty === 1 ? 'pill.dirty' : 'pill.dirty-plural',
          { n: repo.n_dirty })));
    }
    if (repo.n_unpushed > 0) {
      out.push(h('span', { class: 'pill unpushed' },
        t('pill.unpushed', { n: repo.n_unpushed })));
    }
    if (repo.ahead > 0) {
      out.push(h('span', { class: 'pill ahead' },
        t('pill.ahead', { n: repo.ahead })));
    }
    if (repo.behind > 0) {
      const tooFar = repo.behind > behindLimit;
      out.push(h('span', { class: tooFar ? 'pill behindbad' : 'pill behind' },
        t(tooFar ? 'pill.behindbad' : 'pill.behind', { n: repo.behind })));
    }
    return out;
  }

  // Build a commit URL for a given repo's SHA. Priority:
  //   1. GitHub remote — auto-detected from the remote URL. Emits
  //      https://github.com/<owner>/<repo>/commit/<sha>. Works
  //      without any user config.
  //   2. Other gitweb host — falls back to the user pref
  //      `gitweb-base-url` (e.g. "https://git.example.com/git/").
  //      Uses the standard gitweb URL shape
  //      <base>?p=<remote-path>.git;a=commit;h=<full-sha>.
  //   3. Nothing — returns null, the SHA renders as plain text.
  function gitwebBaseUrl() {
    const raw = (prefs.getItem('gitweb-base-url') || '').trim();
    if (!raw) return null;
    return raw.endsWith('/') ? raw : raw + '/';
  }
  function _isGithubRemote(remoteUrl) {
    if (!remoteUrl) return false;
    return /(^|[/@.])github\.com[:/]/.test(remoteUrl);
  }
  function gitwebCommitUrl(remotePath, fullSha, remoteUrl) {
    if (!remotePath || !fullSha) return null;
    if (_isGithubRemote(remoteUrl)) {
      return `https://github.com/${remotePath}/commit/${fullSha}`;
    }
    const base = gitwebBaseUrl();
    if (!base) return null;
    return `${base}?p=${remotePath}.git;a=commit;h=${fullSha}`;
  }
  function gitwebBranchUrlForHost(remotePath, branch, remoteUrl) {
    if (!remotePath || !branch) return null;
    if (_isGithubRemote(remoteUrl)) {
      return `https://github.com/${remotePath}/tree/${branch}`;
    }
    const base = gitwebBaseUrl();
    if (!base) return null;
    return `${base}?p=${remotePath}.git;a=shortlog;h=refs/heads/${branch}`;
  }

  // Render an array of {sha,date,author,subject} commits as a structured
  // <ol>. The sha column is a clickable link to gitweb when repoName is
  // provided. Empty array → emptyText. The row whose sha equals
  // mergeBaseSha is marked so users can see "this is where the branch
  // was forked from".
  function commitListOf(commits, emptyText, remotePath, mergeBaseSha, remoteUrl) {
    const ol = h('ol', { class: 'commit-list' });
    if (!commits || !commits.length) {
      ol.append(h('li', { class: 'empty' }, emptyText || '(none)'));
      return ol;
    }
    for (const c of commits) {
      const fullSha = c.sha || '';
      const shortSha = fullSha.slice(0, 10);
      const isBase = mergeBaseSha && fullSha === mergeBaseSha;
      const url = gitwebCommitUrl(remotePath, fullSha, remoteUrl);
      const shaCell = url
        ? h('a', { class: 'sha', href: url, target: '_blank',
                   rel: 'noopener noreferrer', title: 'Open commit' }, shortSha)
        : h('code', { class: 'sha' }, shortSha);
      ol.append(h('li', {
        class: isBase ? 'is-merge-base' : null,
        title: isBase ? 'Branch fork point — last commit shared with upstream' : null,
      },
        shaCell,
        h('span', { class: 'date' }, c.date),
        h('span', { class: 'author' }, c.author || ''),
        h('span', { class: 'subject' }, c.subject),
      ));
    }
    return ol;
  }

  // Friendly-name a porcelain status code on hover. First char is the
  // index (staged), second is the working-tree (unstaged) state.
  function porcelainTooltip(code) {
    const map = {
      ' M': 'modified (unstaged)',
      'M ': 'modified (staged)',
      'MM': 'modified — staged + unstaged',
      ' D': 'deleted (unstaged)',
      'D ': 'deleted (staged)',
      'A ': 'added (staged)',
      'R ': 'renamed (staged)',
      'C ': 'copied (staged)',
      '??': 'untracked',
      '!!': 'ignored',
      'UU': 'both modified — merge conflict',
    };
    return map[code] || `index='${code[0]}', working='${code[1]}'`;
  }

  // Build the <option> list for the editor selector. Side-effect: snaps
  // editorPref to a sensible default the first time (the first editor the
  // server reports as available, falling back to the first allowlist entry
  // so the dropdown is never empty).
  function editorOptions(editors) {
    if (!editorPref || !editors.some(e => e.id === editorPref)) {
      const firstAvail = editors.find(e => e.available);
      editorPref = firstAvail ? firstAvail.id : (editors[0]?.id || '');
      if (editorPref) localStorage.setItem('editor-pref', editorPref);
    }
    return editors.map(ed => h('option', {
      value: ed.id,
      disabled: !ed.available ? '' : null,
      selected: editorPref === ed.id ? '' : null,
    }, ed.label + (ed.available ? '' : ' (not installed)')));
  }

  // Stable HSL hue derived from a string — used to colour the avatar so
  // each user gets a consistent (but not configurable) accent.
  function hueFor(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  // Profile section: one checkbox per known notification kind, controlling
  // which kinds drive the per-tab 🔔 bell badge. notifyKinds === null means
  // "every kind counts"; the first time the user unchecks one we snapshot
  // the known set into an explicit Set so the user's choice is concrete.
  function buildNotifyKindsSection() {
    const enabled = notifyKinds === null
      ? new Set(KNOWN_NOTIFY_KINDS)
      : notifyKinds;
    const helpText = notifyKinds === null
      ? 'All kinds count toward the per-tab 🔔 bell. Uncheck a kind to silence it.'
      : `Bell counts ${enabled.size} of ${KNOWN_NOTIFY_KINDS.length} kinds.`;
    return h('div', { class: 'profile-section' },
      h('div', { class: 'profile-group' },
        h('div', { class: 'profile-section-title' }, 'Notify me about'),
        h('div', { class: 'profile-help', id: 'notify-kinds-help' }, helpText),
        h('div', { class: 'notify-kinds-grid' },
          ...KNOWN_NOTIFY_KINDS.map(kind => h('label', {
            class: 'notify-kind-row',
          },
            h('input', {
              type: 'checkbox',
              checked: enabled.has(kind) ? '' : null,
              onchange: (ev) => {
                // First user interaction: snapshot the implicit "all kinds"
                // default into an explicit Set so subsequent toggles persist.
                if (notifyKinds === null) {
                  notifyKinds = new Set(KNOWN_NOTIFY_KINDS);
                }
                if (ev.target.checked) notifyKinds.add(kind);
                else notifyKinds.delete(kind);
                saveNotifyKinds(notifyKinds);
                refreshAll(true);
              },
            }),
            h('span', {}, kind),
          )),
        ),
      ),
    );
  }

  // Tab panels for the profile popover. Each returns a node to live
  // inside .profile-tabpanel. Pulled out so profileButton stays readable.
  function buildProfileDashboardPanel(meta, editors) {
    // The Dashboard tab has grown enough toggles that we split them
    // into two sub-panels: "General" (everyday switches like Editor,
    // Auto-refresh, Compact) and "Advanced" (less common — sync
    // controls, activity heatmap). The active sub is remembered in
    // localStorage so the user always lands where they left off.
    let dashSubActive = localStorage.getItem('dashboard-sub-tab') || 'general';
    if (!['general', 'visibility', 'agents'].includes(dashSubActive)) {
      dashSubActive = 'general';
    }
    return h('div', { class: 'profile-tab-content' },
      meta.generated || meta.worktreesRoot || meta.syncMeta
        ? h('div', { class: 'profile-section' },
            h('div', { class: 'profile-group' },
              h('div', { class: 'profile-section-title' },
                t('profile.section.dashboard')),
              meta.generated ? h('div', { class: 'profile-stat-row' },
                h('span', { class: 'profile-stat-label' }, t('profile.stat.generated')),
                h('span', {}, meta.generated),
              ) : null,
              meta.syncMeta ? h('div', { class: 'profile-stat-row' },
                h('span', { class: 'profile-stat-label' }, t('profile.stat.sync')),
                h('span', { class: meta.syncStale ? 'sync-stale' : null,
                  title: meta.syncEnabled
                    ? 'Last successful auto-sync of agent-workspace data/'
                    : 'Auto-sync is off (--no-sync or --sync-interval=0)' },
                  meta.syncMeta),
              ) : null,
              meta.worktreesRoot ? h('div', { class: 'profile-stat-row' },
                h('span', { class: 'profile-stat-label' }, t('profile.stat.path')),
                h('code', { class: 'profile-path' }, meta.worktreesRoot),
                h('button', {
                  class: 'btn btn-inline profile-path-browse',
                  type: 'button',
                  title: t('profile.path.browse-tip'),
                  onclick: () => openWorktreesTreeDialog(),
                }, t('profile.path.browse')),
                h('button', {
                  class: 'btn btn-inline profile-path-reset',
                  type: 'button',
                  title: t('profile.path.reset-tip'),
                  onclick: () => openResetWorkspaceModal(meta.worktreesRoot),
                }, t('profile.path.reset')),
              ) : null,
            ),
          )
        : null,
      // Sub-tab bar — three sub-panels: General (everyday UI prefs),
      // Visibility (what's shown on the dashboard) and Agents (agent
      // + worktree-config knobs). Active choice lives in
      // localStorage so the user lands where they left off.
      (() => {
        const SUBS = ['general', 'visibility', 'agents'];
        const bar = h('div', {
          class: 'profile-subtabbar', role: 'tablist',
        });
        const mkBtn = (id, label) => h('button', {
          class: 'profile-subtab' + (dashSubActive === id ? ' active' : ''),
          type: 'button', role: 'tab',
          'data-dash-sub': id,
          onclick: () => {
            dashSubActive = id;
            localStorage.setItem('dashboard-sub-tab', id);
            bar.querySelectorAll('.profile-subtab').forEach(b =>
              b.classList.toggle('active', b.dataset.dashSub === id));
            for (const sub of SUBS) {
              const el = document.getElementById(`dash-sub-${sub}`);
              if (el) el.style.display = sub === id ? '' : 'none';
            }
          },
        }, label);
        bar.append(
          mkBtn('general',    t('profile.subtab.general')),
          mkBtn('visibility', t('profile.subtab.visibility')),
          mkBtn('agents',     t('profile.subtab.agents')),
        );
        return bar;
      })(),
      // ── General (everyday UI prefs) ─────────────────────────
      h('div', {
        class: 'profile-section profile-subsection',
        id: 'dash-sub-general',
        style: dashSubActive === 'general' ? null : { display: 'none' },
      },
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.editor')),
            h('select', {
              id: 'editor-pick',
              onchange: (e) => {
                editorPref = e.target.value;
                localStorage.setItem('editor-pref', editorPref);
              },
            }, ...editorOptions(editors)),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.editor')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.label.auto-refresh')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'auto-refresh-toggle',
                checked: autoRefreshEnabled ? '' : null,
                onchange: (e) => {
                  autoRefreshEnabled = e.target.checked;
                  localStorage.setItem('auto-refresh-enabled',
                                        autoRefreshEnabled ? '1' : '0');
                  scheduleNextRefresh();
                },
              }),
              t('profile.label.show-auto-refresh'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.auto-refresh')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.compact')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'compact-toggle',
                checked: compactMode ? '' : null,
                onchange: (e) => applyCompactMode(e.target.checked),
              }),
              t('profile.label.show-compact'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.compact')),
        ),
      ),
      // ── Visibility (what gets shown on the dashboard) ─────────
      h('div', {
        class: 'profile-section profile-subsection',
        id: 'dash-sub-visibility',
        style: dashSubActive === 'visibility' ? null : { display: 'none' },
      },
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.label.missing-repos')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'show-missing-repos-toggle',
                checked: showMissingRepos ? '' : null,
                onchange: (e) => {
                  showMissingRepos = e.target.checked;
                  prefs.setItem('show-missing-repos',
                                showMissingRepos ? '1' : '0');
                  if (window.__lastState) {
                    snapshotOpenState();
                    renderApp(window.__lastState);
                    applyFilters();
                  }
                },
              }),
              t('profile.label.show-missing-repos'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.missing-repos')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.sync')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'sync-ui-toggle',
                checked: syncUiOn ? '' : null,
                onchange: (e) => {
                  syncUiOn = e.target.checked;
                  prefs.setItem('sync-ui-on', syncUiOn ? '1' : '0');
                  refreshAll(true);
                },
              }),
              t('profile.label.show-sync-controls'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.sync')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.activity')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'show-activity-toggle',
                checked: showActivity ? '' : null,
                onchange: (e) => {
                  showActivity = e.target.checked;
                  prefs.setItem('show-activity',
                                showActivity ? '1' : '0');
                  refreshAll(true);
                },
              }),
              t('profile.label.show-activity'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.activity')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.timer')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'show-timer-toggle',
                checked: showTimer ? '' : null,
                onchange: (e) => {
                  showTimer = e.target.checked;
                  prefs.setItem('show-timer',
                                showTimer ? '1' : '0');
                  refreshAll(true);
                },
              }),
              t('profile.label.show-timer'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.timer')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.agent-info')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'show-agent-info-toggle',
                checked: showAgentInfo ? '' : null,
                onchange: (e) => {
                  showAgentInfo = e.target.checked;
                  prefs.setItem('show-agent-info',
                                showAgentInfo ? '1' : '0');
                  refreshAll(true);
                },
              }),
              t('profile.label.show-agent-info'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.agent-info')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' }, t('profile.label.term-search')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'show-term-search-toggle',
                checked: showTermSearch ? '' : null,
                onchange: (e) => {
                  showTermSearch = e.target.checked;
                  localStorage.setItem('show-term-search',
                                       showTermSearch ? '1' : '0');
                  document.querySelectorAll('.agent-search-bar').forEach((bar) => {
                    bar.style.display = showTermSearch ? '' : 'none';
                  });
                },
              }),
              t('profile.label.term-search'),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.term-search')),
        ),
      ),
      // ── Agents (agent + worktree config) ─────────────────────
      h('div', {
        class: 'profile-section profile-subsection',
        id: 'dash-sub-agents',
        style: dashSubActive === 'agents' ? null : { display: 'none' },
      },
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.console.inline-default')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'inline-console-toggle',
                checked: inlineConsoleOn() ? '' : null,
                onchange: (e) => {
                  prefs.setItem('console-inline-default',
                                e.target.checked ? '1' : '0');
                  if (window.__lastState) {
                    snapshotOpenState();
                    renderApp(window.__lastState);
                    applyFilters();
                  }
                },
              }),
              t('profile.console.inline-default.label'),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.console.inline-default')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.general-agent')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'general-agent-toggle',
                checked: generalAgentOn() ? '' : null,
                onchange: (e) => {
                  prefs.setItem('general-agent-enabled',
                                e.target.checked ? '1' : '0');
                  if (window.__lastState) {
                    snapshotOpenState();
                    renderApp(window.__lastState);
                    applyFilters();
                  }
                },
              }),
              t('profile.general-agent.label'),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.general-agent')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.mcp-enabled')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'mcp-enabled-toggle',
                checked: mcpEnabledOn() ? '' : null,
                onchange: (e) => {
                  prefs.setItem('mcp-enabled',
                                e.target.checked ? '1' : '0');
                  if (window.__lastState) {
                    snapshotOpenState();
                    renderApp(window.__lastState);
                    applyFilters();
                  }
                },
              }),
              t('profile.mcp-enabled.label'),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.mcp-enabled')),
        ),
        h('div', { class: 'profile-group' },
          h('label', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.mailbox-auto-poll')),
            h('span', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'mailbox-auto-poll-toggle',
                checked: mailboxAutoPollOn() ? '' : null,
                onchange: (e) => {
                  prefs.setItem('mailbox-auto-poll',
                                e.target.checked ? '1' : '0');
                },
              }),
              t('profile.mailbox-auto-poll.label'),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.mailbox-auto-poll')),
        ),
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-row' },
            h('span', { class: 'profile-row-label' },
              t('profile.label.github-repos')),
            h('div', { class: 'github-repos-editor', id: 'github-repos-editor' },
              h('span', { class: 'muted' }, t('github.loading'))),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.github-repos')),
        ),
      ),
    );
  }

  // GitHub repos editor — list-based UI for the `github-repos`
  // preference. Each row shows "owner/repo" with a remove button; an
  // input + Add button appends new entries. Persists via
  // /api/preferences so the server-side github module picks up the
  // change without a restart.
  async function renderGithubReposEditor() {
    const host = document.getElementById('github-repos-editor');
    if (!host) return;
    let repos = [];
    try {
      const r = await fetch('/api/github/config', { cache: 'no-store' });
      const d = await r.json();
      repos = Array.isArray(d.repos) ? d.repos.slice() : [];
    } catch (_) {}

    function save(nextList) {
      return fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: { 'github-repos': nextList },
        }),
      }).then(() => refreshAll(true));
    }

    const rowsHost = h('div', { class: 'github-repos-list' });
    function paintRows() {
      const rows = repos.map((slug, i) => h('div', { class: 'github-repos-row' },
        h('span', { class: 'github-repos-slug' }, slug),
        h('button', {
          class: 'btn btn-inline btn-danger',
          title: t('github.repos.remove-tip', { slug }),
          onclick: async () => {
            repos.splice(i, 1);
            await save(repos);
            paintRows();
          },
        }, '🗑'),
      ));
      if (!rows.length) {
        rowsHost.replaceChildren(h('div', { class: 'muted' },
          t('github.repos.empty')));
      } else {
        rowsHost.replaceChildren(...rows);
      }
    }
    paintRows();

    const input = h('input', {
      type: 'text', class: 'github-repos-input',
      placeholder: 'owner/repo',
    });
    const addBtn = h('button', {
      class: 'btn btn-inline btn-primary',
      onclick: async () => {
        const v = (input.value || '').trim();
        if (!v) return;
        if (!/^[^\s/]+\/[^\s/]+$/.test(v)) {
          showToast('error', t('github.repos.bad-format'));
          return;
        }
        if (repos.includes(v)) {
          showToast('warn', `already added: ${v}`);
          return;
        }
        repos.push(v);
        input.value = '';
        await save(repos);
        paintRows();
      },
    }, t('github.repos.add'));

    host.replaceChildren(rowsHost,
      h('div', { class: 'github-repos-add' }, input, addBtn));
  }

  // Agent-CLI provider picker. Reads /api/providers for the installed
  // status and lets the user pick which CLI the 🤖 Agent button
  // launches. Writes to the `default-provider` preference.
  function buildProfileAgentPanel() {
    const panel = h('div', { class: 'profile-panel-section' },
      h('p', { class: 'profile-help' }, t('profile.agent.intro')),
      h('div', { class: 'agent-provider-list', id: 'agent-provider-list' },
        h('span', { class: 'muted' }, 'loading…')),
    );
    fetch('/api/providers', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        // Cache for the tabs-visibility check below.
        window.__providersCache = d.providers || [];
        renderAgentProviderList(d.providers || []);
      })
      .catch(() => {
        const host = panel.querySelector('#agent-provider-list');
        if (host) host.replaceChildren(
          h('span', { class: 'muted' }, 'failed to load providers'));
      });
    return panel;
  }

  // Kick off a providers fetch on page load so the Model tab's
  // visibility is correct on the FIRST popover open, not just after
  // the user visits the Agent tab. Idempotent — re-fetches every
  // page load (cheap; no auth, single endpoint).
  fetch('/api/providers', { cache: 'no-store' })
    .then(r => r.json())
    .then(d => { window.__providersCache = d.providers || []; })
    .catch(() => {});

  function renderAgentProviderList(providers) {
    const host = document.getElementById('agent-provider-list');
    if (!host) return;
    const current = (prefs.getItem('default-provider') || 'claude').trim();
    const rows = providers.map(p => {
      const row = h('label', {
        class: 'agent-provider-row'
                + (p.installed ? '' : ' disabled')
                + (p.id === current ? ' active' : ''),
        title: p.installed
          ? `binary: ${p.binary}`
          : `binary "${p.binary}" not found on PATH`,
      },
        h('input', {
          type: 'radio', name: 'agent-provider',
          value: p.id,
          checked: (p.id === current) ? '' : null,
          disabled: p.installed ? null : '',
          onchange: () => setDefaultProvider(p.id),
        }),
        h('div', { class: 'agent-provider-body' },
          h('div', { class: 'agent-provider-head' },
            h('strong', {}, p.display_name),
            h('span', { class: 'muted' }, ' · ', p.binary),
            p.installed
              ? h('span', { class: 'pill clean' }, t('profile.agent.installed'))
              : h('span', { class: 'pill behind' }, t('profile.agent.missing')),
            p.supports_mcp
              ? h('span', { class: 'pill' }, t('profile.agent.mcp'))
              : null,
            p.supports_hooks
              ? h('span', { class: 'pill' }, t('profile.agent.hooks'))
              : null,
          ),
        ),
      );
      return row;
    });
    host.replaceChildren(...rows);
  }

  async function setDefaultProvider(id) {
    prefs.setItem('default-provider', id);
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { 'default-provider': id } }),
      });
      showToast('ok', `default agent: ${id}`);
    } catch (err) {
      showToast('error', `failed to save: ${err}`);
    }
    // Re-render to flip the .active class.
    fetch('/api/providers', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => renderAgentProviderList(d.providers || []))
      .catch(() => {});
  }

  // Provider-aware Model panel. For Claude Code we still use the
  // hand-curated CLAUDE_MODEL_CHOICES (nice multi-line labels with
  // recommended-flag); for every other provider we render the bare
  // list from `/api/providers`. Each provider gets its own pref key
  // (`agent-model.<provider-id>`) so switching the active CLI
  // restores that CLI's last-chosen model independently.
  function buildProfileModelPanel(provider) {
    if (!provider) {
      return h('div', { class: 'profile-tab-content profile-help' },
        'No model picker — the active provider exposes no priced model list.');
    }
    if (provider.id === 'claude') {
      return buildProfileClaudeModelPanel();
    }
    const prefKey = `agent-model.${provider.id}`;
    const current = (prefs.getItem(prefKey) || '').trim();
    const choices = [
      { id: '', short: 'Use default',
        summary: 'No --model flag', tagline: provider.default_model
          ? `CLI default: ${provider.default_model}` : '' },
      ...provider.models.map(m => ({
        id: m, short: m.split(':').slice(-1)[0],
        summary: m, tagline: '',
      })),
    ];
    function mkRow(c) {
      return h('label', { class: 'claude-model-option' },
        h('input', {
          type: 'radio', name: 'agent-model',
          value: c.id,
          checked: (c.id === current) ? '' : null,
          onchange: async (e) => {
            if (!e.target.checked) return;
            const v = c.id;
            if (v) prefs.setItem(prefKey, v);
            else prefs.removeItem(prefKey);
            try {
              await fetch('/api/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  preferences: { [prefKey]: v || null },
                }),
              });
            } catch (_) {}
          },
        }),
        h('div', { class: 'claude-model-option-body' },
          h('div', { class: 'claude-model-option-head' },
            h('strong', {}, c.short),
            c.summary
              ? h('span', { class: 'claude-model-summary' },
                  ' · ' + c.summary)
              : null,
          ),
          c.tagline
            ? h('div', { class: 'claude-model-tagline' }, c.tagline)
            : null,
        ),
      );
    }
    return h('div', { class: 'profile-tab-content' },
      h('div', { class: 'profile-section' },
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            `${provider.display_name} · ${t('profile.label.model')}`),
          h('div', { class: 'profile-row profile-row-stacked' },
            h('div', { class: 'claude-model-options' },
              ...choices.map(mkRow)),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.model')),
        ),
      ),
    );
  }

  // Claude-model picker — kept as its own builder because the
  // hand-curated radio list with recommended flags is worth more
  // than the bare-keys list other providers fall back to.
  function buildProfileClaudeModelPanel() {
    // General Agent override: choices = CLAUDE_MODEL_CHOICES + a
    // synthetic "Inherit default" row that maps to the empty pref.
    const gaCurrent = prefs.getItem('general-agent-model') || '';
    const gaChoices = [
      { id: '', short: 'Inherit default',
        summary: `Uses the default above (${claudeModelLabel(claudeModelPref)})`,
        tagline: 'No --model flag from the General Agent specifically' },
      ...CLAUDE_MODEL_CHOICES,
    ];
    const mkRadioRow = (name, choice, checked, onSelect) => {
      const radio = h('input', {
        type: 'radio', name, value: choice.id,
        checked: checked ? '' : null,
        onchange: (e) => { if (e.target.checked) onSelect(choice.id); },
      });
      return h('label', { class: 'claude-model-option' },
        radio,
        h('div', { class: 'claude-model-option-body' },
          h('div', { class: 'claude-model-option-head' },
            h('strong', {}, choice.short),
            choice.recommended
              ? h('span', { class: 'claude-model-rec' }, ' (recommended)')
              : null,
            h('span', { class: 'claude-model-summary' },
              ' · ' + choice.summary),
          ),
          h('div', { class: 'claude-model-tagline' }, choice.tagline),
        ),
      );
    };
    return h('div', { class: 'profile-tab-content' },
      h('div', { class: 'profile-section' },
        // Global default — applied to every per-issue Agent unless
        // a per-issue override is set.
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            t('profile.label.claude-model')),
          h('div', { class: 'profile-row profile-row-stacked' },
            h('div', { class: 'claude-model-options' },
              ...CLAUDE_MODEL_CHOICES.map(c =>
                mkRadioRow('claude-model-pref', c,
                            claudeModelPref === c.id, (id) => {
                  claudeModelPref = id;
                  localStorage.setItem('claude-model-pref', id);
                })),
            ),
          ),
          h('div', { class: 'profile-help' }, t('profile.help.claude-model')),
        ),
        // General Agent override — separate from the per-issue
        // overrides because the General Agent has no issue picker.
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            t('profile.label.general-agent-model')),
          h('div', { class: 'profile-row profile-row-stacked' },
            h('div', { class: 'claude-model-options' },
              ...gaChoices.map(c =>
                mkRadioRow('general-agent-model', c,
                            gaCurrent === c.id, (id) => {
                  if (id) prefs.setItem('general-agent-model', id);
                  else prefs.removeItem('general-agent-model');
                })),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.general-agent-model')),
        ),
      ),
    );
  }

  function buildProfileNotifyPanel() {
    return h('div', { class: 'profile-tab-content' },
      buildNotifyKindsSection(),
    );
  }

  // Profile Theme tab — four cards (Auto / Light / Dark / Warm).
  // Each card carries a small swatch row so the user can preview the
  // palette before clicking. Click → applyTheme + persist.
  function buildProfileThemePanel() {
    const choices = [
      { id: 'auto',
        label: t('profile.theme.auto'),
        help: t('profile.theme.auto-help'),
        swatches: ['#f7f8fa', '#0d1117', '#ee5e35'] },
      { id: 'light',
        label: t('profile.theme.light'),
        help: t('profile.theme.light-help'),
        swatches: ['#ffffff', '#f6f8fa', '#0969da'] },
      { id: 'dark',
        label: t('profile.theme.dark'),
        help: t('profile.theme.dark-help'),
        swatches: ['#0d1117', '#161b22', '#58a6ff'] },
      { id: 'warm',
        label: t('profile.theme.warm'),
        help: t('profile.theme.warm-help'),
        swatches: ['#f7f8fa', '#ffffff', '#ee5e35'] },
    ];
    const active = currentTheme();
    const grid = h('div', { class: 'theme-grid' });
    for (const c of choices) {
      const card = h('button', {
        type: 'button',
        class: 'theme-card' + (c.id === active ? ' active' : ''),
        'data-theme-id': c.id,
        onclick: () => {
          applyTheme(c.id);
          prefs.setItem('theme', c.id);
          // Repaint the active marker on the cards without rebuilding.
          grid.querySelectorAll('.theme-card').forEach(el =>
            el.classList.toggle('active',
              el.dataset.themeId === c.id));
        },
      },
        h('div', { class: 'theme-card-swatches' },
          ...c.swatches.map(col => h('span', {
            class: 'theme-card-swatch',
            style: { background: col },
          }))),
        h('div', { class: 'theme-card-label' }, c.label),
        h('div', { class: 'theme-card-help' }, c.help),
      );
      grid.append(card);
    }
    return h('div', { class: 'profile-tab-content' },
      h('div', { class: 'profile-section' },
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' }, t('profile.section.theme')),
          h('div', { class: 'profile-help',
                      style: { marginBottom: '0.6rem' } },
            t('profile.theme.help')),
          grid,
        ),
      ),
    );
  }

  // Profile Language tab — three cards (Auto / English / Svenska).
  // Same shape as the theme picker so they read consistently. Picking
  // a language re-renders the dashboard so labels switch immediately.
  function buildProfileLanguagePanel() {
    const choices = [
      { id: 'auto', label: LANG_LABELS.auto,
        help: 'Match navigator.language. Currently → ' + detectBrowserLang() },
      { id: 'en', label: LANG_LABELS.en, help: 'English' },
      { id: 'sv', label: LANG_LABELS.sv, help: 'Svenska' },
    ];
    const active = (localStorage.getItem('lang') || 'auto').trim();
    const current = LANGS.includes(active) ? active : 'auto';
    const grid = h('div', { class: 'theme-grid' });
    for (const c of choices) {
      const card = h('button', {
        type: 'button',
        class: 'theme-card' + (c.id === current ? ' active' : ''),
        'data-lang-id': c.id,
        onclick: () => {
          if (c.id === 'auto') prefs.removeItem('lang');
          else prefs.setItem('lang', c.id);
          // Re-render so all t()-wrapped labels update.
          refreshAll(true);
        },
      },
        h('div', { class: 'theme-card-label' }, c.label),
        h('div', { class: 'theme-card-help' }, c.help),
      );
      grid.append(card);
    }
    return h('div', { class: 'profile-tab-content' },
      h('div', { class: 'profile-section' },
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' }, t('profile.section.language')),
          h('div', { class: 'profile-help',
                      style: { marginBottom: '0.6rem' } },
            t('profile.lang.help')),
          grid,
        ),
      ),
    );
  }

  function buildProfileServerPanel() {
    return h('div', { class: 'profile-tab-content' },
      h('div', { class: 'profile-section' },
        // Dashboard auto-update — server-level config: should we
        // periodically `git fetch origin` against the dashboard
        // repo and show a banner when there are new commits? The
        // actual pull + restart is still opt-in via the banner.
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            t('profile.auto-update-check')),
          h('div', { class: 'profile-row' },
            h('label', { class: 'profile-row-control' },
              h('input', {
                type: 'checkbox', id: 'auto-update-check-toggle',
                checked: autoUpdateCheckOn() ? '' : null,
                onchange: (e) => {
                  prefs.setItem('auto-update-check',
                                e.target.checked ? '1' : '0');
                },
              }),
              t('profile.auto-update-check.label'),
            ),
          ),
          h('div', { class: 'profile-help' },
            t('profile.help.auto-update-check')),
          // Manual restart — sibling to the auto-update toggle since
          // both control the dashboard's lifecycle. Kills every live
          // agent and respawns the server via
          // bin/agent-worktrees-restart (the same helper the update
          // banner uses), without pulling new code.
          h('div', { class: 'profile-actions-row' },
            h('button', {
              class: 'btn btn-inline profile-action-btn btn-danger',
              type: 'button',
              title: t('restart.btn-tip'),
              onclick: () => restartDashboard(),
            },
              h('span', { class: 'btn-label' }, t('restart.btn')),
            ),
          ),
        ),
        // Diagnostics card: stats + read-only action buttons.
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            t('profile.section.diagnostics')),
          h('div', { class: 'profile-stats', id: 'profile-stats' },
            h('span', { class: 'muted' }, 'loading…')),
          h('div', { class: 'profile-actions-row' },
            h('button', {
              class: 'btn btn-inline profile-action-btn', type: 'button',
              // Keep the profile popover open behind the modal — when
              // the user dismisses the logs / health dialog they land
              // back on the Server tab they came from, the same way
              // "View all backups" already works.
              onclick: () => openLogsModal(),
            },
              h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '🪵'),
              h('span', { class: 'btn-label' }, 'View server logs'),
            ),
            h('button', {
              class: 'btn btn-inline profile-action-btn', type: 'button',
              title: 'Show /healthz output in a modal',
              onclick: () => openHealthModal(),
            },
              h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '🩺'),
              h('span', { class: 'btn-label' }, 'Health'),
            ),
          ),
        ),
        // Old-data cleanup card — periodic prune of commits / agent
        // events / token-heatmap days older than the retention window.
        // Backed by /api/cleanup-config + /api/cleanup-now. Backup
        // actions moved to the dedicated "Backup" tab.
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' }, 'Old-data cleanup'),
          h('div', { class: 'profile-row' },
            h('label', { class: 'profile-row-control' },
              h('input', { type: 'checkbox', id: 'cleanup-enabled-toggle',
                onchange: (e) => updateCleanupConfig({ enabled: e.target.checked }) }),
              'Enable weekly cleanup',
            ),
          ),
          h('div', { class: 'profile-row' },
            h('label', { class: 'profile-row-label', for: 'cleanup-months-input' }, 'Retain'),
            h('input', { type: 'number', id: 'cleanup-months-input',
              min: '1', max: '120', step: '1', class: 'cleanup-months-input',
              onchange: (e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) return;
                updateCleanupConfig({ retain_months: v });
              } }),
            h('span', { class: 'muted' }, 'months'),
          ),
          h('div', { class: 'profile-stat-row' },
            h('span', { class: 'profile-stat-label' }, t('profile.stat.last-run')),
            h('span', { id: 'cleanup-last-run' }, '—'),
          ),
          h('div', { class: 'profile-help' },
            'Runs once a week. Deletes commits, agent events, ',
            'token-heatmap days and ghost worktrees older than the retention ',
            'window. Timesheet entries, week summaries and notes are kept.'),
          h('div', { class: 'profile-actions-row' },
            h('button', {
              class: 'btn btn-inline profile-action-btn', type: 'button',
              id: 'cleanup-run-now-btn',
              title: 'Run a cleanup tick now using the current retention setting',
              onclick: () => runCleanupNow(),
            },
              h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '🧹'),
              h('span', { class: 'btn-label' }, 'Run cleanup now'),
            ),
          ),
        ),
        // Dismissed warnings card — currently just the per-row
        // dismissals from the "branches >N behind upstream" banner.
        // Stored in localStorage['behindAcks'], which is a map of
        // {<issue>/<repo>: <acked behind count>}; resetting it brings
        // every previously hidden row back the next time renderApp
        // runs. Count + button label are rebuilt by
        // refreshDismissedWarningsCard().
        h('div', { class: 'profile-group' },
          h('div', { class: 'profile-section-title' },
            t('profile.section.dismissed')),
          h('div', { class: 'profile-help' },
            t('profile.dismissed.help')),
          h('div', { class: 'profile-stat-row' },
            h('span', { class: 'profile-stat-label' },
              t('profile.dismissed.count-label')),
            h('span', { id: 'dismissed-warnings-count' }, '—'),
          ),
          h('div', { class: 'profile-actions-row' },
            h('button', {
              class: 'btn btn-inline profile-action-btn', type: 'button',
              id: 'dismissed-warnings-reset-btn',
              title: t('profile.dismissed.reset-tip'),
              onclick: () => resetDismissedWarnings(),
            },
              h('span', { class: 'btn-label' },
                t('profile.dismissed.reset')),
            ),
          ),
        ),
      ),
    );
  }

  // Count the entries currently dismissed (just behindAcks for now).
  // Returns 0 on missing / unparseable storage.
  function countDismissedWarnings() {
    try {
      const a = JSON.parse(localStorage.getItem('behindAcks') || '{}');
      return Object.keys(a).length;
    } catch (_) { return 0; }
  }

  // Update the count line + reset-button disabled state. Called from
  // the Server tab's onShow hook and after resetDismissedWarnings().
  function refreshDismissedWarningsCard() {
    const n = countDismissedWarnings();
    const countEl = document.getElementById('dismissed-warnings-count');
    if (countEl) {
      countEl.textContent = n === 0
        ? t('profile.dismissed.count.none')
        : t('profile.dismissed.count.some', { n });
    }
    const btn = document.getElementById('dismissed-warnings-reset-btn');
    if (btn) btn.disabled = (n === 0);
  }

  function resetDismissedWarnings() {
    localStorage.removeItem('behindAcks');
    refreshDismissedWarningsCard();
    if (window.__lastState) renderApp(window.__lastState);
  }

  // Last fetched cleanup state — used to render "last run X ago" without
  // re-fetching, and to seed the inputs when the Server tab is re-opened.
  let cleanupConfigState = null;

  function fmtCleanupLastRun(ts, summary) {
    if (!ts) return 'never ran';
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    let when;
    if (ageSec < 60) when = `${ageSec}s ago`;
    else if (ageSec < 3600) when = `${Math.floor(ageSec/60)}m ago`;
    else if (ageSec < 86400) when = `${Math.floor(ageSec/3600)}h ago`;
    else when = `${Math.floor(ageSec/86400)}d ago`;
    const total = summary?.deleted
      ? Object.values(summary.deleted).reduce((a, b) => a + (b || 0), 0)
      : null;
    return total != null ? `${when} (${total} rows)` : when;
  }

  function applyCleanupConfigToUI(cfg) {
    cleanupConfigState = cfg;
    const toggle = document.getElementById('cleanup-enabled-toggle');
    const months = document.getElementById('cleanup-months-input');
    const lastRun = document.getElementById('cleanup-last-run');
    if (toggle) toggle.checked = !!cfg.enabled;
    if (months) months.value = String(cfg.retain_months);
    if (lastRun) lastRun.textContent =
      fmtCleanupLastRun(cfg.last_cleanup_at_ts, cfg.last_summary);
  }

  async function fetchCleanupConfig() {
    try {
      const r = await fetch('/api/cleanup-config', { cache: 'no-store' });
      const cfg = await r.json();
      applyCleanupConfigToUI(cfg);
    } catch (ex) {
      const lastRun = document.getElementById('cleanup-last-run');
      if (lastRun) lastRun.textContent = '(error loading)';
    }
  }

  async function updateCleanupConfig(patch) {
    try {
      const r = await fetch('/api/cleanup-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const cfg = await r.json();
      applyCleanupConfigToUI({ ...cleanupConfigState, ...cfg });
    } catch (ex) {
      // Revert UI to last known state on failure.
      if (cleanupConfigState) applyCleanupConfigToUI(cleanupConfigState);
    }
  }

  async function runCleanupNow() {
    const btn = document.getElementById('cleanup-run-now-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/cleanup-now', { method: 'POST' });
      const summary = await r.json();
      if (!summary.error) {
        applyCleanupConfigToUI({
          ...(cleanupConfigState || {}),
          last_cleanup_at_ts: Date.now() / 1000,
          last_summary: summary,
        });
      }
    } catch (ex) {
      // Surface failures via the Last run line.
      const lastRun = document.getElementById('cleanup-last-run');
      if (lastRun) lastRun.textContent = '(error)';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Backup tab ───────────────────────────────────────────────────
  // Scheduled SQLite + per-worktree git-bundle backups. Settings live
  // in /api/backup/settings (preferences-backed); history is in
  // /api/backup/history. "Run backup now" is synchronous via
  // /api/backup/run-now.
  let backupSettingsState = null;

  function fmtBackupTs(unix) {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  }

  function fmtBackupBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
  }

  function buildProfileBackupPanel() {
    return h('div', { class: 'profile-section' },
      // Schedule card.
      h('div', { class: 'profile-group' },
        h('div', { class: 'profile-section-title' }, t('backup.section.schedule')),
        h('div', { class: 'profile-row' },
          h('label', { class: 'profile-row-control' },
            h('input', { type: 'checkbox', id: 'backup-enabled-toggle',
              onchange: (e) => saveBackupSettings({
                enabled: e.target.checked }) }),
            t('backup.label.enabled'),
          ),
        ),
        h('div', { class: 'profile-row' },
          h('label', { class: 'profile-row-label',
                        for: 'backup-interval-input' },
            t('backup.label.every')),
          h('input', { type: 'number', id: 'backup-interval-input',
            min: '1', max: '365', step: '1',
            class: 'backup-num-input',
            onchange: (e) => saveBackupSettings({
              interval_days: parseInt(e.target.value, 10) || 7 }) }),
          h('span', { class: 'muted' }, t('backup.label.days')),
        ),
        h('div', { class: 'profile-row' },
          h('label', { class: 'profile-row-label',
                        for: 'backup-retention-input' },
            t('backup.label.retention')),
          h('input', { type: 'number', id: 'backup-retention-input',
            min: '1', max: '100', step: '1',
            class: 'backup-num-input',
            onchange: (e) => saveBackupSettings({
              retention: parseInt(e.target.value, 10) || 8 }) }),
          h('span', { class: 'muted' }, t('backup.label.backups')),
        ),
        h('div', { class: 'profile-row backup-dir-row' },
          h('label', { class: 'profile-row-label',
                        for: 'backup-dir-input' },
            t('backup.label.directory')),
          h('input', { type: 'text', id: 'backup-dir-input',
            class: 'backup-dir-input',
            placeholder: t('backup.placeholder.default'),
            onchange: (e) => saveBackupSettings({
              dir: e.target.value }) }),
        ),
        // The meta line sits in its own row, indented past the label
        // column so it lines up with the Directory input value above.
        h('div', { class: 'profile-row backup-meta-row' },
          h('span', { class: 'muted backup-meta', id: 'backup-meta' }, ''),
        ),
      ),
      // Actions card.
      h('div', { class: 'profile-group' },
        h('div', { class: 'profile-section-title' }, t('backup.section.actions')),
        h('div', { class: 'profile-actions-row' },
          h('button', {
            class: 'btn btn-inline profile-action-btn',
            id: 'backup-run-now-btn', type: 'button',
            title: t('backup.tip.run-now'),
            onclick: () => runBackupNow(),
          },
            h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '▶'),
            h('span', { class: 'btn-label' }, t('backup.action.run-now'))),
          h('a', {
            class: 'btn btn-inline profile-action-btn',
            href: '/api/backup/sqlite', download: '',
            title: t('backup.tip.download'),
            onclick: () => { closeProfilePopover(); },
          },
            h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '💾'),
            h('span', { class: 'btn-label' }, t('backup.action.download'))),
          h('button', {
            class: 'btn btn-inline profile-action-btn', type: 'button',
            title: t('backup.tip.restore'),
            onclick: () => { closeProfilePopover(); openRestoreDialog(); },
          },
            h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '⏮'),
            h('span', { class: 'btn-label' }, t('backup.action.restore'))),
        ),
      ),
      // History card.
      h('div', { class: 'profile-group' },
        h('div', { class: 'profile-section-title' }, t('backup.section.history')),
        h('div', { id: 'backup-history', class: 'backup-history' },
          h('span', { class: 'muted' }, t('backup.loading'))),
      ),
    );
  }

  function applyBackupSettingsToUI(d) {
    const s = d.settings || {};
    const en = document.getElementById('backup-enabled-toggle');
    if (en) en.checked = !!s.enabled;
    const iv = document.getElementById('backup-interval-input');
    if (iv) iv.value = String(s.interval_days || 7);
    const re = document.getElementById('backup-retention-input');
    if (re) re.value = String(s.retention || 8);
    const dir = document.getElementById('backup-dir-input');
    if (dir) {
      dir.value = s.dir || '';
      if (d.default_dir) dir.placeholder = d.default_dir;
    }
    const meta = document.getElementById('backup-meta');
    if (meta) {
      meta.replaceChildren();
      if (d.last_backup_at) {
        meta.append(
          h('span', { class: 'backup-meta-label' }, t('backup.meta.last')),
          ' ', fmtBackupTs(d.last_backup_at),
        );
      } else {
        meta.append(
          h('span', { class: 'backup-meta-label' },
            t('backup.meta.no-backups')),
        );
      }
      if (d.next_backup_at) {
        meta.append(
          '  ·  ',
          h('span', { class: 'backup-meta-label' }, t('backup.meta.next')),
          ' ', fmtBackupTs(d.next_backup_at),
        );
      }
    }
  }

  async function fetchBackupSettings() {
    try {
      const r = await fetch('/api/backup/settings', { cache: 'no-store' });
      const d = await r.json();
      backupSettingsState = d;
      applyBackupSettingsToUI(d);
    } catch (_) {
      const meta = document.getElementById('backup-meta');
      if (meta) meta.textContent = t('backup.error.settings');
    }
  }

  async function saveBackupSettings(patch) {
    try {
      const r = await fetch('/api/backup/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: patch }),
      });
      const d = await r.json();
      backupSettingsState = d;
      applyBackupSettingsToUI(d);
    } catch (_) {
      if (backupSettingsState) applyBackupSettingsToUI(backupSettingsState);
    }
  }

  function buildBackupHistoryRow(e, { withDelete = false } = {}) {
    const cells = [
      h('td', {}, fmtBackupTs(e.created_at)),
      h('td', { class: 'backup-path-cell', title: e.path }, e.path),
      h('td', { class: 'num' }, fmtBackupBytes(e.total_size_bytes)),
      h('td', { class: 'num' }, String(e.bundle_count || 0)),
      h('td', {}, e.ok ? '✓' : ('✗ ' + (e.error || 'failed'))),
    ];
    if (withDelete) {
      cells.push(h('td', { class: 'backup-history-action-cell' },
        h('button', {
          class: 'btn btn-inline btn-danger backup-history-delete-btn',
          type: 'button',
          title: t('backup.tip.delete'),
          onclick: (ev) => {
            ev.stopPropagation();
            deleteBackupEntry(e);
          },
        }, '🗑'),
      ));
    }
    return h('tr', { class: e.ok ? '' : 'backup-row-failed' }, ...cells);
  }

  function buildBackupHistoryTable(entries, { withDelete = false } = {}) {
    const head = h('tr', {},
      h('th', {}, t('backup.history.col.when')),
      h('th', {}, t('backup.history.col.path')),
      h('th', { class: 'num' }, t('backup.history.col.size')),
      h('th', { class: 'num' }, t('backup.history.col.bundles')),
      h('th', {}, t('backup.history.col.status')),
    );
    if (withDelete) {
      head.append(h('th', { class: 'backup-history-action-cell' },
        t('backup.history.col.actions')));
    }
    return h('table', { class: 'backup-history-table' },
      h('thead', {}, head),
      h('tbody', {}, ...entries.map(
        e => buildBackupHistoryRow(e, { withDelete }))),
    );
  }

  function renderBackupHistory(entries) {
    const box = document.getElementById('backup-history');
    if (!box) return;
    if (!entries.length) {
      box.replaceChildren(h('span', { class: 'muted' },
        t('backup.history.empty')));
      return;
    }
    // Keep the inline panel small: only the most recent row, plus a
    // "View all" button that opens the full history in a modal (like
    // the server logs are surfaced from the Server tab). Delete only
    // surfaces in the modal — the inline view is a one-line preview.
    const total = entries.length;
    const children = [buildBackupHistoryTable(entries.slice(0, 1))];
    if (total > 1) {
      children.push(h('div', { class: 'backup-history-more' },
        h('button', {
          class: 'btn btn-inline', type: 'button',
          onclick: () => openBackupHistoryModal(),
        }, t('backup.history.view-all', { count: total })),
      ));
    }
    box.replaceChildren(...children);
  }

  async function fetchBackupHistory() {
    const box = document.getElementById('backup-history');
    if (!box) return;
    try {
      // Fetch enough entries that the "View all" count reflects the
      // long-tail history without paginating; the modal re-fetches a
      // larger window when opened.
      const r = await fetch('/api/backup/history?limit=50',
        { cache: 'no-store' });
      const d = await r.json();
      renderBackupHistory(d.entries || []);
    } catch (_) {
      box.replaceChildren(h('span', { class: 'muted' },
        t('backup.error.history')));
    }
  }

  // ── Backup history modal ─────────────────────────────────────────
  // Full list, opened from the "View all backups" button in the
  // Backup tab. Same row format as the inline preview.
  let backupHistoryModalOpen = false;
  function openBackupHistoryModal() {
    if (backupHistoryModalOpen) return;
    backupHistoryModalOpen = true;
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'backup-history-modal',
    },
      h('div', { class: 'logs-modal week-modal', role: 'dialog',
                  'aria-labelledby': 'backup-history-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'backup-history-modal-title' },
            t('backup.history.modal-title')),
          h('span', { class: 'muted', id: 'backup-history-modal-meta' }, ''),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline',
                        onclick: closeBackupHistoryModal }, '✕'),
        ),
        h('div', { class: 'week-body backup-history-modal-body',
                    id: 'backup-history-modal-body' },
          h('span', { class: 'muted' }, t('backup.loading'))),
      ),
    );
    modal.addEventListener('click', closeBackupHistoryModal);
    document.body.append(modal);
    document.addEventListener('keydown', backupHistoryKeyHandler);
    fetchBackupHistoryModal();
  }
  async function fetchBackupHistoryModal() {
    try {
      const r = await fetch('/api/backup/history?limit=200',
        { cache: 'no-store' });
      const d = await r.json();
      const body = document.getElementById('backup-history-modal-body');
      const meta = document.getElementById('backup-history-modal-meta');
      if (!body) return;
      const entries = d.entries || [];
      if (meta) {
        meta.textContent = entries.length === 1
          ? t('backup.history.entries-one')
          : t('backup.history.entries', { count: entries.length });
      }
      if (!entries.length) {
        body.replaceChildren(h('span', { class: 'muted' },
          t('backup.history.empty')));
        return;
      }
      body.replaceChildren(
        buildBackupHistoryTable(entries, { withDelete: true }));
    } catch (_) {
      const body = document.getElementById('backup-history-modal-body');
      if (body) body.replaceChildren(h('span', { class: 'muted' },
        t('backup.error.history')));
    }
  }
  function closeBackupHistoryModal() {
    if (!backupHistoryModalOpen) return;
    backupHistoryModalOpen = false;
    document.getElementById('backup-history-modal')?.remove();
    document.removeEventListener('keydown', backupHistoryKeyHandler);
  }
  function backupHistoryKeyHandler(e) {
    if (e.key === 'Escape') closeBackupHistoryModal();
  }

  async function deleteBackupEntry(entry) {
    if (!entry || !entry.id) return;
    if (!window.confirm(
        t('backup.confirm.delete', { path: entry.path }))) return;
    try {
      const r = await fetch(`/api/backup/history/${entry.id}`,
        { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        showToast('error', t('backup.toast.delete-failed',
          { error: d.error || `HTTP ${r.status}` }));
        return;
      }
      showToast('ok', t('backup.toast.deleted'));
      // Refresh the inline panel + the modal listing so the row
      // disappears immediately on both surfaces.
      fetchBackupSettings();
      fetchBackupHistory();
      if (backupHistoryModalOpen) fetchBackupHistoryModal();
    } catch (err) {
      showToast('error', t('backup.toast.delete-failed',
        { error: String(err) }));
    }
  }

  async function runBackupNow() {
    const btn = document.getElementById('backup-run-now-btn');
    if (btn) {
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'btn-label' },
        t('backup.action.running')));
    }
    try {
      const r = await fetch('/api/backup/run-now', { method: 'POST' });
      const result = await r.json();
      if (result.ok) {
        showToast('ok', t('backup.toast.ok', {
          path: result.path,
          size: fmtBackupBytes(result.total_size_bytes),
        }));
      } else {
        showToast('error', t('backup.toast.failed',
          { error: result.error || 'unknown' }));
      }
      fetchBackupSettings();
      fetchBackupHistory();
      if (backupHistoryModalOpen) fetchBackupHistoryModal();
    } catch (err) {
      showToast('error', t('backup.toast.failed', { error: String(err) }));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.replaceChildren(
          h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '▶'),
          h('span', { class: 'btn-label' }, t('backup.action.run-now')));
      }
    }
  }

  // Which profile tab was last open. Cheap UI-state — keep in
  // localStorage (not synced); each device can land back where it left.
  let profileActiveTab = localStorage.getItem('profile-tab') || 'dashboard';
  // Persisted across renderApp() re-renders so toggles like the
  // notify-kinds checkboxes (which refreshAll) don't close the popover.
  let profilePopoverOpen = false;

  // Top-right profile button + popover. Houses the editor preference and
  // any future per-user settings. Closes on outside click or Escape.
  function profileButton(user, editors, dashboardMeta) {
    const u = user || {};
    const initials = u.initials || '?';
    const label = u.name || u.slug || 'User';
    const email = u.email || '';
    const hue = hueFor(email || label);
    const avatarStyle = { background: `hsl(${hue}, 55%, 45%)` };
    const meta = dashboardMeta || {};

    // Active provider drives whether the Model tab appears at all,
    // and which model list it renders. Cached on window so the tab
    // bar re-renders synchronously with the current value. Defaults
    // to claude until /api/providers responds.
    const activeProviderId = (prefs.getItem('default-provider') || 'claude').trim();
    const activeProvider = (window.__providersCache || []).find(p => p.id === activeProviderId);
    const showModelTab = (activeProvider?.models?.length || 0) > 0;
    const tabs = [
      { id: 'dashboard',    label: t('profile.tab.dashboard'),
        build: () => buildProfileDashboardPanel(meta, editors),
        onShow: () => renderGithubReposEditor() },
      { id: 'agent',        label: t('profile.tab.agent'),
        build: () => buildProfileAgentPanel() },
      ...(showModelTab ? [
        { id: 'model', label: t('profile.tab.model'),
          build: () => buildProfileModelPanel(activeProvider) },
      ] : []),
      { id: 'theme',        label: t('profile.tab.theme'),
        build: () => buildProfileThemePanel() },
      { id: 'language',     label: t('profile.tab.language'),
        build: () => buildProfileLanguagePanel() },
      { id: 'notify',       label: t('profile.tab.notify'),
        build: () => buildProfileNotifyPanel() },
      { id: 'server',       label: t('profile.tab.server'),
        build: () => buildProfileServerPanel(),
        onShow: () => { fetchProfileStats(); fetchCleanupConfig();
                        refreshDismissedWarningsCard(); } },
      { id: 'backup',       label: t('profile.tab.backup'),
        build: () => buildProfileBackupPanel(),
        onShow: () => { fetchBackupSettings(); fetchBackupHistory(); } },
    ];
    if (!tabs.some(t => t.id === profileActiveTab)) profileActiveTab = 'dashboard';

    const tabPanel = h('div', { class: 'profile-tabpanel',
                                  id: 'profile-tabpanel' });
    const renderActiveTab = () => {
      const t = tabs.find(x => x.id === profileActiveTab) || tabs[0];
      tabPanel.replaceChildren(t.build());
      if (t.onShow) t.onShow();
    };

    const tabBar = h('div', { class: 'profile-tabbar', role: 'tablist' },
      ...tabs.map(t => h('button', {
        class: 'profile-tab' + (profileActiveTab === t.id ? ' active' : ''),
        type: 'button', role: 'tab',
        'data-profile-tab': t.id,
        onclick: () => {
          profileActiveTab = t.id;
          localStorage.setItem('profile-tab', t.id);
          // Update active class on each button without a full re-render.
          tabBar.querySelectorAll('.profile-tab').forEach(b =>
            b.classList.toggle('active', b.dataset.profileTab === t.id));
          renderActiveTab();
        },
      }, t.label)),
    );

    const popover = h('div', {
      class: 'profile-popover' + (profilePopoverOpen ? ' open' : ''),
      id: 'profile-popover', role: 'menu',
      onclick: (e) => e.stopPropagation(),  // clicks inside don't close
    },
      h('div', { class: 'profile-header' },
        h('div', { class: 'profile-avatar profile-avatar-lg', style: avatarStyle, 'aria-hidden': 'true' }, initials),
        h('div', { class: 'profile-meta' },
          h('div', { class: 'profile-name' }, label),
          email ? h('div', { class: 'profile-email' }, email) : null,
        ),
      ),
      tabBar,
      tabPanel,
    );
    renderActiveTab();

    return h('div', { class: 'profile' },
      h('button', {
        class: 'profile-avatar', id: 'profile-btn', type: 'button',
        title: `${label}${email ? ' · ' + email : ''} — settings`,
        'aria-label': `${label} — settings`,
        'aria-haspopup': 'menu',
        style: avatarStyle,
        onclick: (e) => { e.stopPropagation(); toggleProfilePopover(); },
      }, initials),
      popover,
    );
  }

  function toggleProfilePopover() {
    const p = document.getElementById('profile-popover');
    if (!p) return;
    const willOpen = !p.classList.contains('open');
    p.classList.toggle('open', willOpen);
    profilePopoverOpen = willOpen;
    if (willOpen) {
      // Server-stats fetch happens via the Server tab's onShow hook —
      // no need to fire it on every open if the user is on Dashboard.
      // renderActiveTab() fired the original onShow during popover
      // construction, but at that point the popover wasn't yet in the
      // document so any getElementById() inside the fetches missed.
      // Re-fire here for the tabs that hit the DOM during onShow.
      if (profileActiveTab === 'server') {
        fetchProfileStats();
        fetchCleanupConfig();
        refreshDismissedWarningsCard();
      } else if (profileActiveTab === 'backup') {
        fetchBackupSettings();
        fetchBackupHistory();
      }
      // Resolve the popover fresh on every event so the closer survives
      // a renderApp() re-render (the original popover element is
      // replaced; capturing it would strand the listener).
      const closer = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        const cur = document.getElementById('profile-popover');
        if (!cur) return;
        if (e.type === 'click'
            && (cur.contains(e.target)
                || e.target.id === 'profile-btn'
                || e.target.closest?.('#profile-btn'))) return;
        cur.classList.remove('open');
        profilePopoverOpen = false;
        document.removeEventListener('click', closer);
        document.removeEventListener('keydown', closer);
      };
      // Defer attaching so the click that opened the popover doesn't close it.
      setTimeout(() => {
        document.addEventListener('click', closer);
        document.addEventListener('keydown', closer);
      }, 0);
    }
  }

  function closeProfilePopover() {
    document.getElementById('profile-popover')?.classList.remove('open');
    profilePopoverOpen = false;
  }

  function fmtUptime(sec) {
    if (sec == null) return '—';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
    if (sec < 86400) return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    return `${Math.floor(sec/86400)}d ${Math.floor((sec%86400)/3600)}h`;
  }

  async function fetchProfileStats() {
    const slot = document.getElementById('profile-stats');
    if (!slot) return;
    try {
      const r = await fetch('/api/stats', { cache: 'no-store' });
      const s = await r.json();
      slot.replaceChildren(
        // Version of the dashboard the user is running. Sourced
        // from the committed VERSION file at the repo root, plus
        // the short HEAD sha as a "is this exactly what you
        // pushed?" reference. Both surface together so a bug
        // report can quote "1.0.0 · commit abc1234".
        h('div', { class: 'profile-stat-row' },
          h('span', { class: 'profile-stat-label' },
            t('profile.stat.version')),
          h('span', {}, s.version || '?',
            s.commit_sha ? h('span', { class: 'muted',
              style: { marginLeft: '0.4rem', fontSize: '11px' } },
              '· ' + s.commit_sha) : null),
        ),
        h('div', { class: 'profile-stat-row' },
          h('span', { class: 'profile-stat-label' }, t('profile.stat.uptime')),
          h('span', {}, fmtUptime(s.uptime_seconds)),
        ),
        h('div', { class: 'profile-stat-row' },
          h('span', { class: 'profile-stat-label' }, t('profile.stat.requests')),
          h('span', {},
            `${s.requests_total} `,
            s.requests_errors > 0
              ? h('span', { class: 'pill behindbad', style: { fontSize: '10px' } },
                  `${s.requests_errors} err`)
              : h('span', { class: 'muted', style: { fontSize: '11px' } }, '(no errors)')),
        ),
        h('div', { class: 'profile-stat-row' },
          h('span', { class: 'profile-stat-label' }, t('profile.stat.logs')),
          h('span', {},
            `${s.log_buffer_size} / ${s.log_buffer_capacity}`,
            (s.log_levels?.error > 0)
              ? h('span', { class: 'pill behindbad', style: { fontSize: '10px', marginLeft: '0.4rem' } },
                  `${s.log_levels.error} err`)
              : null,
            (s.log_levels?.warn > 0)
              ? h('span', { class: 'pill behind', style: { fontSize: '10px', marginLeft: '0.4rem' } },
                  `${s.log_levels.warn} warn`)
              : null),
        ),
        h('div', { class: 'profile-stat-row muted' },
          h('span', { class: 'profile-stat-label' }, t('profile.stat.pid')),
          h('span', {}, `${s.pid} · python ${s.python_version}`),
        ),
      );
    } catch (err) {
      slot.replaceChildren(h('span', { class: 'muted' }, 'stats unavailable'));
    }
  }

  // ── Working-tree directory dialog ─────────────────────────────────
  // Opened from the "📂 Browse" button next to the Path stat row in
  // the Dashboard profile tab. Renders a single textual tree rooted
  // at the *primaries* directory (so primary checkouts and the
  // worktrees/ subdir appear side-by-side, matching the production
  // ~/git layout). Falls back to just the worktrees root when
  // primaries-status hasn't loaded yet or the worktrees root isn't
  // a child of the primaries root. No fetch — pulls everything from
  // window.__lastState + primariesStatus.
  // Reset-workspace flow — two stacked confirmation modals. The
  // first describes what will be deleted; the second is a
  // "no undo" final gate. Only the second modal triggers the POST.
  // The server validates that the body's `confirm` field equals
  // worktrees_root, so a stray POST without the right path won't fire.
  function openResetWorkspaceModal(worktreesRoot) {
    document.getElementById('reset-workspace-modal')?.remove();
    const close = () =>
      document.getElementById('reset-workspace-modal')?.remove();
    const proceed = () => { close(); openResetWorkspaceFinalModal(worktreesRoot); };
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'reset-workspace-modal',
      onclick: close,
    },
      h('div', { class: 'logs-modal reset-modal',
                  role: 'dialog', 'aria-labelledby': 'reset-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head reset-modal-head' },
          h('strong', { id: 'reset-modal-title' }, t('reset.modal.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕')),
        h('div', { class: 'reset-modal-body' },
          h('p', {}, t('reset.modal.body', { path: worktreesRoot }))),
        h('div', { class: 'reset-modal-foot' },
          h('button', { class: 'btn', onclick: close },
            t('reset.modal.cancel')),
          h('button', { class: 'btn btn-danger', onclick: proceed },
            t('reset.modal.confirm'))),
      ),
    );
    document.body.append(modal);
  }
  function openResetWorkspaceFinalModal(worktreesRoot) {
    document.getElementById('reset-workspace-final-modal')?.remove();
    const close = () =>
      document.getElementById('reset-workspace-final-modal')?.remove();
    const fire = async () => {
      close();
      try {
        const r = await fetch('/api/admin/reset-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: worktreesRoot }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) {
          const err = (d.error || d.errors?.[0]?.error
            || `HTTP ${r.status}`);
          showToast('error', t('toast.reset.failed', { err }));
        } else {
          const n = (d.removed_worktrees || []).length;
          const p = (d.removed_primaries || []).length;
          showToast('ok', t('toast.reset.ok', { n, p }));
        }
      } catch (err) {
        showToast('error', t('toast.reset.failed', { err }));
      }
      // Force the missing-primaries banner to re-evaluate after the
      // wipe — fetchPrimariesStatus is cached, so refreshAll alone
      // wouldn't notice the primaries are gone.
      await fetchPrimariesStatus();
      refreshAll(true);
    };
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'reset-workspace-final-modal',
      onclick: close,
    },
      h('div', { class: 'logs-modal reset-modal reset-modal-final',
                  role: 'dialog', 'aria-labelledby': 'reset-final-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head reset-modal-head' },
          h('strong', { id: 'reset-final-title' },
            t('reset.modal.final.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕')),
        h('div', { class: 'reset-modal-body' },
          h('p', {}, t('reset.modal.final.body', { path: worktreesRoot }))),
        h('div', { class: 'reset-modal-foot' },
          h('button', { class: 'btn', onclick: close },
            t('reset.modal.cancel')),
          h('button', { class: 'btn btn-danger', onclick: fire },
            t('reset.modal.final.confirm'))),
      ),
    );
    document.body.append(modal);
  }

  function openWorktreesTreeDialog() {
    document.getElementById('worktrees-tree-dialog')?.remove();
    const close = () =>
      document.getElementById('worktrees-tree-dialog')?.remove();
    const state = window.__lastState || {};
    const wtRoot = state.worktrees_root || '?';
    const pRoot = (primariesStatus && primariesStatus.primaries_root) || '';
    const presentPrim = (primariesStatus && primariesStatus.present) || [];
    const missingPrim = (primariesStatus && primariesStatus.missing) || [];
    const inFlightPrim = (primariesStatus && primariesStatus.in_flight) || {};
    const issues = state.issues || [];

    // The dialog tree shows primaries_root as the root when the
    // worktrees root is its direct child (the common
    // ~/git + ~/git/worktrees layout). Otherwise show the
    // worktrees root directly.
    const wtRelative = (pRoot && wtRoot.startsWith(pRoot + '/'))
      ? wtRoot.slice(pRoot.length + 1) : null;
    const displayRoot = wtRelative ? pRoot : wtRoot;
    const showPrimaries = !!wtRelative;

    const lines = [`${displayRoot}/`];

    // Helper: append children with proper └── / ├── prefixes.
    const renderChildren = (entries, prefix) => {
      entries.forEach((e, idx) => {
        const last = idx === entries.length - 1;
        const branch = last ? '└── ' : '├── ';
        const tagText = e.tag ? `   ${e.tag}` : '';
        lines.push(`${prefix}${branch}${e.name}/${tagText}`);
        if (e.children && e.children.length) {
          const childPrefix = prefix + (last ? '    ' : '│   ');
          renderChildren(e.children, childPrefix);
        }
      });
    };

    // Build the top-level entries under displayRoot.
    const topEntries = [];
    if (showPrimaries) {
      // Combine present + missing + in-flight primaries into a sorted
      // list with status markers.
      const primaryNames = new Set([
        ...presentPrim, ...missingPrim,
        ...Object.keys(inFlightPrim || {}),
      ]);
      const primaries = [...primaryNames].sort().map(name => ({
        name,
        tag: inFlightPrim[name]
          ? `(cloning ${(inFlightPrim[name].progress || {}).pct || 0}%)`
          : missingPrim.includes(name)
            ? t('profile.path.tree-missing')
            : '',
        children: [],
      }));
      topEntries.push(...primaries);
      // The worktrees/ subdir entry — gets the per-issue nested tree.
      const wtChildren = issues.map(iss => ({
        name: iss.issue,
        tag: '',
        children: (iss.repos || []).map(r => ({
          name: r.repo,
          tag: r.ghost ? t('profile.path.tree-ghost')
              : r.missing ? t('profile.path.tree-missing')
              : '',
          children: [],
        })),
      }));
      if (!wtChildren.length) {
        wtChildren.push({
          name: t('profile.path.tree-empty'),
          tag: '',
          children: [],
        });
      }
      topEntries.push({ name: wtRelative, tag: '', children: wtChildren });
    } else {
      // Worktrees-only fallback — no primaries status available.
      if (!issues.length) {
        topEntries.push({
          name: t('profile.path.tree-empty'),
          tag: '',
          children: [],
        });
      } else {
        issues.forEach(iss => topEntries.push({
          name: iss.issue,
          tag: '',
          children: (iss.repos || []).map(r => ({
            name: r.repo,
            tag: r.ghost ? t('profile.path.tree-ghost')
                : r.missing ? t('profile.path.tree-missing')
                : '',
            children: [],
          })),
        }));
      }
    }
    renderChildren(topEntries, '');

    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'worktrees-tree-dialog',
    },
      h('div', { class: 'logs-modal week-modal',
                  role: 'dialog',
                  'aria-labelledby': 'worktrees-tree-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'worktrees-tree-title' },
            t('profile.path.tree-title')),
          h('span', { class: 'muted' },
            ` · ${issues.length} issue${issues.length !== 1 ? 's' : ''}`),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕'),
        ),
        h('pre', { class: 'worktrees-tree' }, lines.join('\n')),
      ),
    );
    modal.addEventListener('click', close);
    document.body.append(modal);
    const onkey = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onkey);
      }
    };
    document.addEventListener('keydown', onkey);
  }

  // ── Health (/healthz) modal ────────────────────────────────────────────
  // One-shot fetch of the /healthz JSON, shown pretty-printed inside an
  // app-level modal. Avoids the awkward target="_blank" path that
  // standalone PWAs render as a half-popup.
  let _healthModalOpen = false;
  function openHealthModal() {
    if (_healthModalOpen) return;
    _healthModalOpen = true;
    const close = closeHealthModal;
    const body = h('pre', { class: 'health-body' },
      h('span', { class: 'muted' }, t('ui.loading-healthz')));
    const statusPill = h('span', { class: 'health-status muted' }, '· loading…');
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'health-modal' },
      h('div', { class: 'logs-modal health-modal',
                  role: 'dialog', 'aria-labelledby': 'health-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'health-modal-title' }, '🩺 /healthz'),
          statusPill,
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline',
                        onclick: () => loadHealth(body, statusPill),
                        title: 'Re-fetch /healthz' }, '↻ Refresh'),
          h('button', { class: 'btn btn-inline',
                        onclick: close,
                        'aria-label': 'Close', title: 'Close' }, '✕ Close'),
        ),
        body,
      ),
    );
    modal.addEventListener('click', close);
    document.body.append(modal);
    document.addEventListener('keydown', healthKeyHandler);
    loadHealth(body, statusPill);
  }
  function closeHealthModal() {
    if (!_healthModalOpen) return;
    _healthModalOpen = false;
    document.getElementById('health-modal')?.remove();
    document.removeEventListener('keydown', healthKeyHandler);
  }
  function healthKeyHandler(e) {
    if (e.key === 'Escape') closeHealthModal();
  }
  async function loadHealth(bodyEl, pillEl) {
    bodyEl.replaceChildren(h('span', { class: 'muted' }, t('ui.loading')));
    if (pillEl) pillEl.textContent = '· loading…';
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      const txt = await r.text();
      let pretty = txt;
      try { pretty = JSON.stringify(JSON.parse(txt), null, 2); }
      catch (_) { /* not JSON, fall back to raw text */ }
      bodyEl.textContent = pretty;
      if (pillEl) {
        let ok = null;
        try { ok = JSON.parse(txt).ok; } catch (_) { /* leave null */ }
        pillEl.textContent = `· HTTP ${r.status}`
          + (ok === true ? ' · ok' : ok === false ? ' · NOT OK' : '');
        pillEl.className = 'health-status '
          + (r.ok && ok !== false ? 'ok' : 'err');
      }
    } catch (err) {
      bodyEl.textContent = 'Failed to load /healthz: ' + err;
      if (pillEl) {
        pillEl.textContent = '· error';
        pillEl.className = 'health-status err';
      }
    }
  }

  // ── Restore SQLite backup dialog ───────────────────────────────────────
  // File picker → POST /api/restore/sqlite → server validates, swaps,
  // self-restarts. The dialog shows live status + counts and reloads
  // the page after the server comes back up.
  function openRestoreDialog() {
    document.getElementById('restore-dialog')?.remove();
    const fileInput = h('input', { type: 'file', accept: '.sqlite,.db' });
    const status = h('div', { class: 'restore-status muted' },
      'Pick a .sqlite file backed up via the 💾 Download button above.');
    let inflight = false;
    const close = () => {
      if (inflight) return;
      document.getElementById('restore-dialog')?.remove();
    };
    const submit = async () => {
      if (inflight) return;
      const f = fileInput.files?.[0];
      if (!f) {
        status.textContent = 'Please pick a file first.';
        status.className = 'restore-status err';
        return;
      }
      if (!confirm(
            `Replace the current activity DB with ${f.name} (${(f.size/1024).toFixed(1)} KB)?\n\n`
            + 'A safety copy of the current DB will be saved first.\n'
            + 'The server will restart automatically; the dashboard will reload after.'
          )) return;
      inflight = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading…';
      status.className = 'restore-status muted';
      status.textContent = 'Uploading + validating…';
      try {
        const buf = await f.arrayBuffer();
        const r = await fetch('/api/restore/sqlite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          status.className = 'restore-status err';
          status.textContent = '⚠ ' + (d.error || `failed (${r.status})`);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Restore';
          inflight = false;
          return;
        }
        const c = d.counts || {};
        status.className = 'restore-status ok';
        status.replaceChildren(
          h('strong', {}, '✓ Restored. '),
          h('div', { class: 'muted', style: { marginTop: '0.4rem' } },
            `Events: ${c.events ?? '?'} · Worktrees: ${c.worktrees ?? '?'} · Commits: ${c.commits ?? '?'}`),
          d.safety_backup
            ? h('div', { class: 'muted', style: { marginTop: '0.2rem',
                                                  fontSize: '11px' } },
                'Safety copy: ' + d.safety_backup)
            : null,
          h('div', { style: { marginTop: '0.6rem' } },
            'Server is restarting — reloading the dashboard in '),
          h('span', { id: 'restore-countdown' }, '5'),
          's…',
        );
        // Wait for the server to come back. The exec takes ~1s; poll
        // /healthz until it answers, then reload.
        let countdown = 5;
        const cd = document.getElementById('restore-countdown');
        const tick = setInterval(async () => {
          countdown -= 1;
          if (cd) cd.textContent = String(Math.max(0, countdown));
          if (countdown <= 0) {
            clearInterval(tick);
            try {
              await fetch('/healthz', { cache: 'no-store' });
              window.location.reload();
            } catch (_) {
              // Server still restarting — keep trying.
              countdown = 2;
            }
          }
        }, 1000);
      } catch (err) {
        status.className = 'restore-status err';
        status.textContent = 'Upload failed: ' + err;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Restore';
        inflight = false;
      }
    };
    const submitBtn = h('button', {
      class: 'btn btn-danger', onclick: submit,
    }, 'Restore');

    const dialog = h('div', { class: 'logs-modal-backdrop',
                                id: 'restore-dialog' },
      h('div', { class: 'logs-modal add-issue-modal',
                  role: 'dialog', 'aria-labelledby': 'restore-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'restore-title' }, '⏮ Restore SQLite backup'),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close,
                        'aria-label': 'Close', title: 'Close' }, '✕'),
        ),
        h('div', { class: 'add-issue-body' },
          h('p', {},
            'Pick a ',
            h('code', {}, '.sqlite'),
            ' file previously downloaded via 💾 Download SQLite backup. ',
            'The server will validate it (SQLite magic bytes + ',
            h('code', {}, 'PRAGMA integrity_check'),
            '), save the current DB as a safety copy, swap the new ',
            'file in place, and restart itself.',
          ),
          h('label', { class: 'restore-file-row' },
            'Backup file: ', fileInput),
          status,
        ),
        h('div', { class: 'add-issue-foot' },
          h('button', { class: 'btn', onclick: close }, t('btn.cancel')),
          submitBtn,
        ),
      ),
    );
    dialog.addEventListener('click', close);
    document.body.append(dialog);
    setTimeout(() => fileInput.focus(), 0);
  }

  // ── Server log console (modal) ─────────────────────────────────────────
  // Polls /api/logs while open. Filters by level + search. Auto-refresh
  // can be paused so you can inspect a stable view.
  const logsModal = {
    open: false,
    sinceId: 0,
    filters: { info: true, warn: true, error: true, q: '' },
    autoRefresh: true,
    timer: null,
    entries: [],
  };

  function openLogsModal() {
    if (logsModal.open) return;
    logsModal.open = true;
    logsModal.sinceId = 0;
    logsModal.entries = [];
    const root = document.body;

    const filterChip = (level, label, cls) => {
      // Build the chip imperatively so the onchange handler can flip its
      // `.on` class — renderLogList only re-renders the list, not the chip.
      const chip = h('label', {
        class: `log-chip log-chip-${cls}` + (logsModal.filters[level] ? ' on' : ''),
      });
      chip.append(
        h('input', {
          type: 'checkbox',
          checked: logsModal.filters[level] ? '' : null,
          onchange: (e) => {
            logsModal.filters[level] = e.target.checked;
            chip.classList.toggle('on', e.target.checked);
            renderLogList();
          },
        }),
        document.createTextNode(label),
      );
      return chip;
    };

    const modal = h('div', { class: 'logs-modal-backdrop', id: 'logs-modal' },
      h('div', { class: 'logs-modal', role: 'dialog', 'aria-label': 'Server logs',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', {}, '🪵 Server logs'),
          h('span', { class: 'muted', id: 'logs-meta' }, ''),
          h('span', { style: { flex: '1' } }),
          h('label', { class: 'log-toggle', title: 'Pause/resume polling' },
            h('input', {
              type: 'checkbox',
              checked: logsModal.autoRefresh ? '' : null,
              onchange: (e) => {
                logsModal.autoRefresh = e.target.checked;
                if (e.target.checked) startLogsPoll();
                else stopLogsPoll();
              },
            }),
            ' auto-refresh',
          ),
          h('button', { class: 'btn btn-inline',
                        title: 'Hide everything currently in the buffer; only newer log lines will appear.',
                        onclick: async () => {
                          // Bump sinceId to the latest ring id so the
                          // poll-loop ignores everything currently in
                          // the buffer. Without this, sinceId=0 would
                          // re-fetch every line right back.
                          try {
                            const r = await fetch('/api/logs?since=0&limit=1',
                                                   { cache: 'no-store' });
                            const d = await r.json();
                            logsModal.sinceId = d.latest_id
                              ?? logsModal.sinceId;
                          } catch (_) { /* keep current sinceId */ }
                          logsModal.entries = [];
                          renderLogList();
                        } },
            'Clear view'),
          h('button', { class: 'btn btn-inline',
                        onclick: closeLogsModal }, '✕ Close'),
        ),
        h('div', { class: 'logs-modal-filters' },
          filterChip('error', 'errors', 'error'),
          filterChip('warn',  'warnings', 'warn'),
          filterChip('info',  'info', 'info'),
          h('input', {
            type: 'search', class: 'logs-search', placeholder: 'search…',
            value: logsModal.filters.q,
            oninput: (e) => { logsModal.filters.q = e.target.value; renderLogList(); },
          }),
        ),
        h('pre', { class: 'logs-list', id: 'logs-list' },
          h('div', { class: 'logs-header' },
            h('div', { 'data-col': 'time' }, 'Time',
              h('span', { class: 'resizer', 'data-col': 'time',
                          onmousedown: (e) => startColResize(e, 'time') })),
            h('div', { 'data-col': 'level' }, 'Level',
              h('span', { class: 'resizer', 'data-col': 'level',
                          onmousedown: (e) => startColResize(e, 'level') })),
            h('div', {}, 'Message'),
          ),
          h('div', { class: 'log-rows', id: 'log-rows' }),
        ),
      ),
    );
    modal.addEventListener('click', closeLogsModal);  // backdrop click closes
    root.append(modal);
    document.addEventListener('keydown', logsKeyHandler);
    applyLogColWidths();
    pollLogs(true);
    if (logsModal.autoRefresh) startLogsPoll();
  }

  // Column-width persistence + drag-to-resize.
  // Defaults are wide enough to show "HH:MM:SS" and a 5-char level tag.
  const LOG_COL_DEFAULTS = { time: 90, level: 60 };  // px
  function loadLogColWidths() {
    try {
      const raw = localStorage.getItem('log-col-widths');
      const v = raw ? JSON.parse(raw) : {};
      return { ...LOG_COL_DEFAULTS, ...v };
    } catch (_) { return { ...LOG_COL_DEFAULTS }; }
  }
  function saveLogColWidths(widths) {
    try { localStorage.setItem('log-col-widths', JSON.stringify(widths)); }
    catch (_) {}
  }
  function applyLogColWidths() {
    const list = document.getElementById('logs-list');
    if (!list) return;
    const w = loadLogColWidths();
    list.style.setProperty('--col-time-w', `${w.time}px`);
    list.style.setProperty('--col-level-w', `${w.level}px`);
  }
  function startColResize(ev, col) {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const widths = loadLogColWidths();
    const startW = widths[col];
    const handle = ev.currentTarget;
    handle.classList.add('dragging');
    const list = document.getElementById('logs-list');
    const onMove = (e) => {
      const next = Math.max(40, Math.min(400, startW + (e.clientX - startX)));
      widths[col] = next;
      list.style.setProperty(`--col-${col}-w`, `${next}px`);
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      saveLogColWidths(widths);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function closeLogsModal() {
    if (!logsModal.open) return;
    logsModal.open = false;
    stopLogsPoll();
    document.getElementById('logs-modal')?.remove();
    document.removeEventListener('keydown', logsKeyHandler);
  }

  function logsKeyHandler(e) {
    if (e.key === 'Escape') closeLogsModal();
  }

  function startLogsPoll() {
    stopLogsPoll();
    logsModal.timer = setInterval(() => pollLogs(false), 2000);
  }
  function stopLogsPoll() {
    if (logsModal.timer) clearInterval(logsModal.timer);
    logsModal.timer = null;
  }

  async function pollLogs(reset) {
    if (reset) {
      logsModal.entries = [];
      logsModal.sinceId = 0;
    }
    try {
      const url = `/api/logs?since=${logsModal.sinceId}&limit=200`;
      const r = await fetch(url, { cache: 'no-store' });
      const data = await r.json();
      if (data.entries?.length) {
        logsModal.entries.push(...data.entries);
        logsModal.sinceId = data.entries[data.entries.length - 1].id;
        // Cap client buffer to ~2000 lines to avoid runaway DOM.
        if (logsModal.entries.length > 2000) {
          logsModal.entries = logsModal.entries.slice(-2000);
        }
      }
      const meta = document.getElementById('logs-meta');
      if (meta) meta.textContent =
        `· ring ${data.size}/${data.capacity} · ${data.levels.error} err · ${data.levels.warn} warn`;
      renderLogList();
    } catch (err) {
      const meta = document.getElementById('logs-meta');
      if (meta) meta.textContent = '· poll failed: ' + err;
    }
  }

  // ── Timer + worklog widget (rendered below the heatmap) ────────────────
  const timer = { running: null, tickInterval: null };

  function activeIssueKey() {
    const id = document.querySelector('nav.tabs button.active')?.dataset.tab;
    if (!id) return null;
    const match = (window.__lastState?.issues || []).find(
      i => `tab-${slugId(i.issue)}` === id);
    return match ? match.issue : null;
  }

  function fmtElapsed(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
                 : `${m}m ${String(s).padStart(2,'0')}s`;
  }

  function buildTimerCard() {
    // Use <details> so the card is natively collapsible. Default
    // collapsed — keep the dashboard quiet at startup; the user can
    // expand and the choice persists in localStorage.
    const open = localStorage.getItem('timer-card-open') === '1';
    const card = h('details', {
      class: 'timer-card', id: 'timer-card',
      open: open ? '' : null,
    });
    card.addEventListener('toggle', () => {
      localStorage.setItem('timer-card-open', card.open ? '1' : '0');
    });
    refreshTimerCard(card);
    return card;
  }

  function refreshTimerCard(rootMaybe) {
    const root = rootMaybe || document.getElementById('timer-card');
    if (!root) return;
    root.replaceChildren();

    const knownIssues = (window.__lastState?.issues || []).map(i => i.issue);

    if (timer.running) {
      const t = timer.running;
      const elapsedNow = Math.max(0, Math.floor(Date.now()/1000 - t.started_at));
      const elapsed = h('span', { class: 'timer-elapsed', id: 'timer-elapsed' },
        fmtElapsed(elapsedNow));
      const comment = h('input', {
        type: 'text', class: 'timer-comment',
        placeholder: 'comment (saved on stop)',
        value: t.comment || '',
        onchange: (e) => updateTimerComment(e.target.value),
      });
      // Summary stays visible when collapsed — shows state + issue +
      // live elapsed so the user can monitor a running timer at a glance.
      root.append(
        h('summary', { class: 'timer-card-summary' },
          h('span', { class: 'timer-state running' }, '⏱ Running'),
          h('strong', { class: 'timer-issue' }, t.issue),
          elapsed,
          h('span', { style: { flex: '1' } }),
          // Stop button lives in the summary so you can stop without
          // expanding the card.
          h('button', { class: 'btn timer-stop',
            onclick: (e) => { e.preventDefault(); stopTimer(comment.value); } },
            '■ Stop & log'),
        ),
        h('div', { class: 'timer-card-body' },
          h('div', { class: 'timer-comment-row' }, comment),
        ),
      );
      // Tick once a second.
      stopTimerTicker();
      timer.tickInterval = setInterval(() => {
        const now = Math.max(0, Math.floor(Date.now()/1000 - t.started_at));
        const el = document.getElementById('timer-elapsed');
        if (el) el.textContent = fmtElapsed(now);
      }, 1000);
    } else {
      stopTimerTicker();
      const initialIssue = activeIssueKey() || knownIssues[0] || '';
      let issueInput;
      if (knownIssues.length === 0) {
        issueInput = h('select', { class: 'timer-issue-input', disabled: '' },
          h('option', { value: '' }, 'no known issues'));
      } else {
        issueInput = h('select', { class: 'timer-issue-input' },
          ...knownIssues.map(k => h('option', {
            value: k,
            selected: k === initialIssue ? '' : null,
          }, k)),
        );
      }
      const commentInput = h('input', {
        type: 'text', class: 'timer-comment',
        placeholder: 'comment (optional)',
      });
      const startBtn = h('button', { class: 'btn',
        disabled: knownIssues.length === 0 ? '' : null,
        onclick: (e) => { e.preventDefault();
                          startTimer(issueInput.value, commentInput.value); },
      }, '▶ Start timer');
      const addBtn = h('button', { class: 'btn btn-secondary',
        onclick: (e) => { e.preventDefault();
                          openManualWorklog(issueInput.value || activeIssueKey()); },
        title: 'Log time without using the timer',
      }, '+ Add manual log');
      root.append(
        h('summary', { class: 'timer-card-summary' },
          h('span', { class: 'timer-state idle' }, '⏱ Timer'),
          h('span', { class: 'muted', style: { fontSize: '11.5px' } },
            'click to expand · no timer running'),
        ),
        h('div', { class: 'timer-card-body' },
          h('div', { class: 'timer-head' },
            issueInput, commentInput, startBtn, addBtn,
          ),
        ),
      );
    }
  }

  function stopTimerTicker() {
    if (timer.tickInterval) clearInterval(timer.tickInterval);
    timer.tickInterval = null;
  }

  async function loadTimerState() {
    try {
      const r = await fetch('/api/timer', { cache: 'no-store' });
      const j = await r.json();
      timer.running = j.timer || null;
    } catch (_) { timer.running = null; }
    refreshTimerCard();
  }

  async function startTimer(issue, comment) {
    issue = (issue || '').trim();
    if (!issue) { showToast('warn', t('toast.pick-issue')); return; }
    try {
      const r = await fetch('/api/timer/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue, comment }),
      });
      const j = await r.json();
      if (!r.ok) { showToast('error', j.error || 'start failed'); return; }
      timer.running = j.timer;
      refreshTimerCard();
      showToast('ok', `✓ tracking ${issue}`);
    } catch (err) { showToast('error', t('toast.start-failed', { err })); }
  }

  async function stopTimer(comment) {
    try {
      const r = await fetch('/api/timer/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      });
      const j = await r.json();
      if (!r.ok) { showToast('error', j.error || 'stop failed'); return; }
      timer.running = null;
      refreshTimerCard();
      const log = j.worklog;
      showToast('ok', `✓ logged ${log.minutes}m on ${log.issue}`);
      // If the week-summary modal is open, refresh it.
      if (weekModal.open) fetchWeekSummary(weekModal.week, false);
    } catch (err) { showToast('error', t('toast.stop-failed', { err })); }
  }

  let _commentDebounce = null;
  function updateTimerComment(comment) {
    if (_commentDebounce) clearTimeout(_commentDebounce);
    _commentDebounce = setTimeout(async () => {
      try {
        await fetch('/api/timer/comment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment }),
        });
        if (timer.running) timer.running.comment = comment;
      } catch (_) {}
    }, 500);
  }

  // Manual worklog entry — small inline modal.
  function openManualWorklog(suggestedIssue) {
    const knownIssues = (window.__lastState?.issues || []).map(i => i.issue);
    const issueInput = h('input', {
      type: 'text', list: 'manual-issue-list',
      placeholder: 'issue (e.g. BSS-10029)',
      value: suggestedIssue || activeIssueKey() || '',
    });
    const datalist = h('datalist', { id: 'manual-issue-list' },
      ...knownIssues.map(k => h('option', { value: k })));
    const minutesInput = h('input', { type: 'number', min: '1', step: '1',
                                       placeholder: 'minutes', style: { width: '6em' } });
    const dateInput = h('input', { type: 'date',
      value: new Date().toISOString().slice(0,10) });
    const commentInput = h('input', { type: 'text', placeholder: 'comment (optional)' });

    const close = () => modal.remove();

    const submit = async () => {
      const issue = issueInput.value.trim();
      const minutes = parseInt(minutesInput.value || '0', 10);
      if (!issue) { showToast('warn', t('toast.issue-required')); return; }
      if (minutes <= 0) { showToast('warn', t('toast.minutes-positive')); return; }
      try {
        const r = await fetch('/api/worklogs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue, minutes,
            date_local: dateInput.value || null,
            comment: commentInput.value,
          }),
        });
        const j = await r.json();
        if (!r.ok) { showToast('error', j.error || 'add failed'); return; }
        showToast('ok', `✓ logged ${j.minutes}m on ${j.issue}`);
        close();
        if (weekModal.open) fetchWeekSummary(weekModal.week, false);
      } catch (err) { showToast('error', t('toast.add-failed', { err })); }
    };

    const modal = h('div', { class: 'logs-modal-backdrop' },
      h('div', { class: 'manual-worklog-modal',
        role: 'dialog', 'aria-labelledby': 'manual-worklog-title',
        onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'manual-worklog-title' }, '+ Add work log'),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕ Close'),
        ),
        h('div', { class: 'manual-worklog-body' },
          h('label', {}, 'Issue', issueInput, datalist),
          h('label', {}, 'Minutes', minutesInput),
          h('label', {}, 'Date', dateInput),
          h('label', {}, 'Comment', commentInput),
          h('div', { class: 'manual-worklog-actions' },
            h('button', { class: 'btn', onclick: submit }, t('btn.add')),
            h('button', { class: 'btn btn-secondary', onclick: close }, t('btn.cancel')),
          ),
        ),
      ),
    );
    modal.addEventListener('click', close);
    document.body.append(modal);
    setTimeout(() => issueInput.focus(), 50);
  }

  async function deleteWorklog(id) {
    if (!confirm('Delete this work log entry?')) return;
    try {
      const r = await fetch(`/api/worklogs/${id}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.deleted) {
        showToast('error', j.error || 'delete failed');
        return;
      }
      showToast('ok', '✓ entry deleted');
      if (weekModal.open) fetchWeekSummary(weekModal.week, false);
    } catch (err) { showToast('error', t('toast.delete-failed', { err })); }
  }

  // Agent worklog rows are computed, not stored — "delete" remembers
  // (issue, week_id) in the agent_worklog_exclusions table so the row
  // stays hidden on subsequent renders.
  async function deleteAgentWorklog(issue) {
    if (!weekModal.week) return;
    if (!confirm(`Hide the agent worklog for ${issue} this week?`)) return;
    try {
      const r = await fetch(
        `/api/worklogs/agent?issue=${encodeURIComponent(issue)}`
        + `&week=${encodeURIComponent(weekModal.week)}`,
        { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) {
        showToast('error', j.error || 'delete failed');
        return;
      }
      showToast('ok', `✓ ${issue} agent entry hidden for the week`);
      fetchWeekSummary(weekModal.week, false);
    } catch (err) { showToast('error', t('toast.delete-failed', { err })); }
  }

  // ── Week summary modal ─────────────────────────────────────────────────
  // Two views:
  //   detail — single-week summary (default, reads /api/week-summary)
  //   list   — index of all cached weeks (reads /api/week-summary/list)
  // Opening from the toolbar always starts in detail with the current week.
  const weekModal = {
    open: false,
    view: 'detail',     // 'detail' | 'list'
    week: null,         // active week_id in detail view
    data: null,         // last detail payload
    cameFromList: false,
    // When true, the synthetic source='agent' worklogs are stripped from
    // the rendered summary (minutes/by_issue/worklog list). The server
    // payload is unchanged; toggling re-renders client-side. Persisted
    // across reloads so the choice sticks per browser.
    excludeAgent: localStorage.getItem('week-exclude-agent') === '1',
  };

  function applyAgentFilter(d, excludeAgent) {
    if (!excludeAgent) return d;
    let agentTotal = 0;
    const agentByIssue = {};
    for (const w of d.worklogs || []) {
      if (w.source !== 'agent') continue;
      agentTotal += w.minutes;
      agentByIssue[w.issue] = (agentByIssue[w.issue] || 0) + w.minutes;
    }
    return {
      ...d,
      totals: { ...d.totals,
                minutes: Math.max(0, (d.totals?.minutes || 0) - agentTotal) },
      worklogs: (d.worklogs || []).filter(w => w.source !== 'agent'),
      by_issue: (d.by_issue || []).map(it => ({
        ...it,
        minutes: Math.max(0, (it.minutes || 0) - (agentByIssue[it.issue] || 0)),
      })).sort((a, b) =>
        (b.commits || 0) - (a.commits || 0)
        || (b.minutes || 0) - (a.minutes || 0)
        || (b.tokens || 0) - (a.tokens || 0)),
    };
  }

  function toggleWeekAgent() {
    weekModal.excludeAgent = !weekModal.excludeAgent;
    prefs.setItem('week-exclude-agent',
      weekModal.excludeAgent ? '1' : '0');
    if (weekModal.data) {
      renderWeekHead();
      renderWeekSummary(weekModal.data);
    }
  }

  async function openWeekSummary(weekId) {
    if (weekModal.open) return;
    weekModal.open = true;
    weekModal.view = 'detail';
    weekModal.week = weekId || null;
    weekModal.cameFromList = false;

    const modal = h('div', { class: 'logs-modal-backdrop', id: 'week-modal' },
      h('div', { class: 'logs-modal week-modal',
                  role: 'dialog', 'aria-label': 'Week summary',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head', id: 'week-head' }),
        h('div', { class: 'week-body', id: 'week-body' },
          h('span', { class: 'muted' }, 'loading…')),
      ),
    );
    modal.addEventListener('click', closeWeekSummary);
    document.body.append(modal);
    document.addEventListener('keydown', weekKeyHandler);
    await fetchWeekSummary(weekModal.week, false);
  }

  function closeWeekSummary() {
    if (!weekModal.open) return;
    weekModal.open = false;
    document.getElementById('week-modal')?.remove();
    document.removeEventListener('keydown', weekKeyHandler);
  }

  function weekKeyHandler(e) { if (e.key === 'Escape') closeWeekSummary(); }

  // ── Header rebuild — depends on view ───────────────────────────────────
  function renderWeekHead() {
    const head = document.getElementById('week-head');
    if (!head) return;
    head.replaceChildren();

    if (weekModal.view === 'list') {
      head.append(
        h('strong', {}, '📅 Week summaries · all'),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn btn-inline',
          onclick: () => { weekModal.view = 'detail'; weekModal.week = null;
                           weekModal.cameFromList = false;
                           fetchWeekSummary(null, false); } },
          '← Detail (current week)'),
        h('button', { class: 'btn btn-inline',
                      onclick: closeWeekSummary }, '✕ Close'),
      );
      return;
    }

    // Detail view header.
    const d = weekModal.data;
    const meta = h('span', { class: 'muted' }, '· loading…');
    if (d) {
      const ageMin = d.generated_at
        ? Math.max(0, Math.floor((Date.now()/1000 - d.generated_at) / 60)) : null;
      const ageText = ageMin == null ? 'just now'
        : ageMin < 1 ? 'just now'
        : ageMin < 60 ? `${ageMin}m ago`
        : `${Math.floor(ageMin/60)}h ${ageMin%60}m ago`;
      meta.textContent = `· ${d.week_id} · ${d.start} — ${d.end}`
        + (d.is_current ? ' · current' : '') + ` · generated ${ageText}`;
    }

    // Disable the "next" arrow on the current week — there's no point
    // walking into the future, weeks that haven't started yet have no
    // commits or worklogs to summarise.
    const atCurrent = !!d?.is_current;
    head.append(h('strong', {}, '📅 Week summary'), meta,
      h('span', { class: 'muted', style: { marginLeft: '0.5rem' } },
        h('button', { class: 'btn-link',
          title: 'Previous week',
          onclick: () => fetchWeekSummary(weekShift(weekModal.week, -1), false) },
          '◀'),
        ' ',
        h('button', {
          class: 'btn-link',
          disabled: atCurrent ? '' : null,
          title: atCurrent ? 'Already at the current week' : 'Next week',
          onclick: atCurrent ? null
                  : () => fetchWeekSummary(weekShift(weekModal.week, +1), false),
        }, '▶'),
      ),
    );
    head.append(h('span', { style: { flex: '1' } }));
    if (weekModal.cameFromList) {
      head.append(h('button', { class: 'btn btn-inline',
        onclick: () => { weekModal.view = 'list'; renderWeekList(); } },
        '← Back to list'));
    }
    head.append(
      h('button', {
        class: 'btn btn-inline' + (weekModal.excludeAgent ? '' : ' on'),
        title: weekModal.excludeAgent
          ? 'Agent time is currently excluded from totals — click to include'
          : 'Agent time is currently included in totals — click to exclude',
        onclick: toggleWeekAgent,
      }, weekModal.excludeAgent ? '🤖 Agent: off' : '🤖 Agent: on'),
      h('button', { class: 'btn btn-inline',
        title: 'Show every cached week summary',
        onclick: () => { weekModal.view = 'list'; renderWeekList(); } },
        '☰ List'),
      h('button', { class: 'btn btn-inline', id: 'week-regen-btn',
        title: 'Regenerate this week (force=1)',
        onclick: () => fetchWeekSummary(weekModal.week, true) },
        '↻ Regenerate'),
      h('button', { class: 'btn btn-inline',
                    onclick: closeWeekSummary }, '✕ Close'),
    );
  }

  // Shift an ISO 'YYYY-Www' by N weeks (positive or negative). Falls back
  // to today's week when input is null. Implemented via JS Date math.
  function weekShift(weekId, delta) {
    let monday;
    if (weekId && /^\d{4}-W\d{2}$/.test(weekId)) {
      const [y, w] = weekId.split('-W').map(Number);
      // Jan 4 is always in week 1 per ISO, so anchor from there.
      const jan4 = new Date(Date.UTC(y, 0, 4));
      const jan4Day = (jan4.getUTCDay() || 7);   // 1..7, Mon=1
      monday = new Date(jan4);
      monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (w - 1) * 7);
    } else {
      const now = new Date();
      const day = (now.getDay() || 7);
      monday = new Date(now);
      monday.setHours(0,0,0,0);
      monday.setDate(now.getDate() - (day - 1));
    }
    monday.setUTCDate(monday.getUTCDate() + delta * 7);
    // Re-encode as YYYY-Www via isocalendar-equivalent.
    const target = new Date(Date.UTC(
      monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
  }

  async function fetchWeekSummary(weekId, force) {
    weekModal.view = 'detail';
    const btn = document.getElementById('week-regen-btn');
    if (btn) { btn.disabled = true; btn.textContent = '↻ regenerating…'; }
    try {
      const url = '/api/week-summary' + (weekId ? `?week=${encodeURIComponent(weekId)}` : '');
      const r = await fetch(url, {
        method: force ? 'POST' : 'GET',
        cache: 'no-store',
      });
      const d = await r.json();
      if (!r.ok) {
        showToast('error', d.error || `week-summary failed (${r.status})`);
        return;
      }
      weekModal.data = d;
      weekModal.week = d.week_id;
      renderWeekHead();
      renderWeekSummary(d);
    } catch (err) {
      showToast('error', t('toast.week-summary-failed', { err }));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Regenerate'; }
    }
  }

  async function deleteWeekSummary(weekId) {
    if (!weekId) return;
    if (!confirm(`Delete the cached summary for ${weekId}?\n\nThe data is recomputable — the next time you open ${weekId} the summary will regenerate from commits + worklogs + agent activity.`))
      return;
    try {
      const r = await fetch(
        `/api/week-summary?week=${encodeURIComponent(weekId)}`,
        { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) {
        showToast('error', j.error || 'delete failed');
        return;
      }
      showToast('ok', `✓ ${weekId} cache deleted`);
      // Refresh the list view in place.
      renderWeekList();
    } catch (err) { showToast('error', t('toast.delete-failed', { err })); }
  }

  // ── List view (all cached weeks) ────────────────────────────────────────
  async function renderWeekList() {
    weekModal.view = 'list';
    renderWeekHead();
    const body = document.getElementById('week-body');
    if (!body) return;
    body.replaceChildren(h('span', { class: 'muted' }, 'loading…'));
    try {
      const r = await fetch('/api/week-summary/list', { cache: 'no-store' });
      const j = await r.json();
      const weeks = j.weeks || [];
      if (!weeks.length) {
        body.replaceChildren(h('div', { class: 'muted', style: { padding: '1rem' } },
          'No cached week summaries yet — open the current week to generate one.'));
        return;
      }
      const fmtMin = m => m >= 60 ? `${(m/60).toFixed(1)}h` : `${m}m`;
      const accessors = {
        week_id:      w => w.week_id || '',
        commits:      w => w.commits || 0,
        minutes:      w => w.minutes || 0,
        tokens_total: w => w.tokens_total || 0,
        cost_usd:     w => w.cost_usd || 0,
      };
      const sortState = loadTableSort('week-list');
      const onResort = (next) => {
        saveTableSort('week-list', next);
        renderWeekList();   // re-fetch + re-render
      };
      const sortedWeeks = sortRowsBy(weeks, sortState, accessors);
      const rows = sortedWeeks.map(w => h('tr', { class: 'week-row' },
        // Click anywhere on the row except the delete cell jumps to the
        // detail view. Delete cell uses stopPropagation so it doesn't
        // also trigger the row click.
        h('td', { onclick: () => {
          weekModal.cameFromList = true;
          fetchWeekSummary(w.week_id, false);
        } }, w.week_id, w.is_current ? h('span', { class: 'muted',
          style: { marginLeft: '0.4rem' } }, '(current)') : null),
        h('td', { class: 'muted', onclick: () => {
          weekModal.cameFromList = true;
          fetchWeekSummary(w.week_id, false);
        } }, w.start && w.end ? `${w.start} — ${w.end}` : ''),
        h('td', { class: 'num' }, fmtNum(w.commits)),
        h('td', { class: 'num' }, fmtMin(w.minutes || 0)),
        h('td', { class: 'num' }, fmtNum(w.tokens_total)),
        h('td', { class: 'num' }, '$' + (w.cost_usd || 0).toFixed(2)),
        h('td', { class: 'num' },
          h('button', {
            class: 'btn-link danger',
            title: 'Delete this cached summary (regeneratable from /api/week-summary)',
            onclick: (e) => {
              e.stopPropagation();
              deleteWeekSummary(w.week_id);
            },
          }, '🗑'),
        ),
      ));
      body.replaceChildren(h('div', { class: 'week-card' },
        h('table', { class: 'week-table week-list-table' },
          h('thead', {}, h('tr', {},
            sortableTh('Week',    'week_id',      sortState, onResort),
            h('th', {}, t('col.range')),
            sortableTh('Commits', 'commits',      sortState, onResort, { class: 'num' }),
            sortableTh('Hours',   'minutes',      sortState, onResort, { class: 'num' }),
            sortableTh('Tokens',  'tokens_total', sortState, onResort, { class: 'num' }),
            sortableTh('Cost',    'cost_usd',     sortState, onResort, { class: 'num' }),
            h('th', {}, ''),
          )),
          h('tbody', {}, ...rows),
        ),
      ));
    } catch (err) {
      body.replaceChildren(h('div', { class: 'muted', style: { padding: '1rem' } },
        'Failed to load list: ' + err));
    }
  }

  function fmtNum(n) {
    // Use the current UI locale so 1,234 becomes 1 234 in Swedish.
    const lang = currentLang();
    return (n || 0).toLocaleString(lang === 'sv' ? 'sv-SE' : 'en-US');
  }

  function fmtMinAsHours(m) {
    m = Math.max(0, Math.floor(m || 0));
    if (m === 0) return '0';
    if (m < 60) return `${m}m`;
    const hours = m / 60;
    const lang = currentLang();
    const localised = hours.toLocaleString(
      lang === 'sv' ? 'sv-SE' : 'en-US',
      { maximumFractionDigits: 1 });
    return `${localised}h`;
  }

  function renderWeekSummary(rawData) {
    const body = document.getElementById('week-body');
    if (!body) return;
    body.replaceChildren();
    // Apply the include-agent toggle. Underlying weekModal.data stays as
    // the unfiltered server payload so flipping the toggle is instant.
    const d = applyAgentFilter(rawData, weekModal.excludeAgent);

    // Top stats row.
    const tot = d.totals;
    const stat = (label, value, sub) => h('div', { class: 'week-stat' },
      h('div', { class: 'week-stat-value' }, value),
      h('div', { class: 'week-stat-label' }, label),
      sub ? h('div', { class: 'week-stat-sub' }, sub) : null,
    );
    body.append(h('div', { class: 'week-stats' },
      stat('Commits', fmtNum(tot.commits),
           `${tot.active_days} active day${tot.active_days !== 1 ? 's' : ''}`),
      stat('Hours logged', fmtMinAsHours(tot.minutes),
           tot.minutes ? `${tot.minutes} min total` : 'no entries'),
      stat('Issues touched', fmtNum(tot.issues),
           tot.repos.length ? `${tot.repos.length} repo${tot.repos.length !== 1 ? 's' : ''}` : null),
      stat('Est. cost', '$' + (tot.cost_usd || 0).toFixed(2),
           `${fmtNum(tot.tokens_total)} tokens`),
    ));

    // Per-day mini bar chart (commits + tokens).
    if (d.by_day?.length) {
      const maxCommits = Math.max(1, ...d.by_day.map(x => x.commits));
      const maxTokens  = Math.max(1, ...d.by_day.map(x => x.tokens));
      const card = h('div', { class: 'week-card' },
        h('h4', {}, t('ui.by-day')),
        h('div', { class: 'week-day-grid' },
          ...d.by_day.flatMap(x => {
            const cPct = (x.commits / maxCommits) * 100;
            const tPct = (x.tokens  / maxTokens) * 100;
            const date = new Date(x.date + 'T00:00:00');
            const wd = date.toLocaleDateString(undefined, { weekday: 'short' });
            return [
              h('div', { class: 'week-day-cell' },
                h('div', { class: 'week-day-label' }, wd,
                  h('div', { class: 'week-day-date' }, x.date.slice(5))),
                h('div', { class: 'week-day-bar', title: `${x.commits} commit${x.commits!==1?'s':''}` },
                  h('div', { class: 'week-day-bar-fill commits',
                              style: { width: cPct + '%' } })),
                h('div', { class: 'week-day-bar', title: `${fmtNum(x.tokens)} tokens` },
                  h('div', { class: 'week-day-bar-fill tokens',
                              style: { width: tPct + '%' } })),
                h('div', { class: 'week-day-counts' },
                  h('span', { title: 'commits' }, x.commits),
                  h('span', { class: 'muted', title: 'tokens' }, fmtNum(x.tokens))),
              ),
            ];
          })),
      );
      body.append(card);
    }

    // Per-issue table — sortable by every column except Repos / Latest
    // subject. Default sort is by issue id ascending, so toggling Agent
    // on/off (which only changes minutes) doesn't reshuffle the rows.
    if (d.by_issue?.length) {
      const accessors = {
        issue:    it => it.issue || '',
        commits:  it => it.commits || 0,
        minutes:  it => it.minutes || 0,
        tokens:   it => it.tokens || 0,
        cost_usd: it => it.cost_usd || 0,
      };
      const sortState = loadTableSort('by-issue');
      const sorted = sortRowsBy(d.by_issue, sortState, accessors);
      const tbody = sorted.map(it => {
        const issueDisplay = it.issue === '__agent__' ? t('tab.generic-agent') : it.issue;
        return h('tr', {},
          h('td', {}, issueDisplay),
          h('td', { class: 'num' }, fmtNum(it.commits)),
          h('td', { class: 'num' }, fmtMinAsHours(it.minutes || 0)),
          h('td', { class: 'num' }, fmtNum(it.tokens)),
          h('td', { class: 'num' }, '$' + (it.cost_usd || 0).toFixed(2)),
          h('td', { class: 'muted' }, it.repos?.join(', ') || ''),
          (() => {
            const subjects = it.subjects || [];
            const td = h('td', { class: 'subjects hover-popover-host' },
              subjects[0] || '');
            if (subjects.length > 1) {
              td.append(h('span', { class: 'has-prompt' }, ' ⓘ'));
              td.append(h('div', { class: 'hover-popover' },
                h('div', { class: 'hover-popover-list' },
                  ...subjects.map(s => h('div', { class: 'hover-popover-list-item' }, s)),
                ),
              ));
            }
            return td;
          })(),
        );
      });
      const onResort = (next) => {
        saveTableSort('by-issue', next);
        renderWeekSummary(rawData);   // closure over the fn arg above
      };
      body.append(h('div', { class: 'week-card' },
        h('h4', {}, t('ui.by-issue')),
        h('table', { class: 'week-table' },
          h('thead', {}, h('tr', {},
            sortableTh('Issue',   'issue',    sortState, onResort),
            sortableTh('Commits', 'commits',  sortState, onResort, { class: 'num' }),
            sortableTh('Hours',   'minutes',  sortState, onResort, { class: 'num' }),
            sortableTh('Tokens',  'tokens',   sortState, onResort, { class: 'num' }),
            sortableTh('Cost',    'cost_usd', sortState, onResort, { class: 'num' }),
            h('th', {}, t('col.repos')),
            h('th', {}, t('col.latest-subject')),
          )),
          h('tbody', {}, ...tbody),
        ),
      ));
    }

    // Work logs — manual + timer entries. Two views:
    //   detail  — every entry, individually deletable
    //   grouped — one row per (date, issue) with summed minutes
    // The choice persists across reloads.
    const wlGrouped = localStorage.getItem('worklog-grouped') === '1';
    const groupBtn = h('button', {
      class: 'btn btn-inline',
      title: 'Toggle grouping by day + issue',
      onclick: () => {
        prefs.setItem('worklog-grouped', wlGrouped ? '0' : '1');
        renderWeekSummary(d);
      },
    }, wlGrouped ? '☐ Group by day' : '☑ Group by day');
    body.append(h('div', { class: 'week-card' },
      h('h4', { class: 'with-action' },
        h('span', {}, `Work logs (${(d.worklogs || []).length})`),
        h('span', {},
          groupBtn,
          h('button', { class: 'btn btn-inline',
            style: { marginLeft: '0.4rem' },
            onclick: () => openManualWorklog(activeIssueKey()) }, '+ Add log'),
        ),
      ),
      wlGrouped
        ? worklogGroupedTable(d.worklogs || [])
        : worklogTable(d.worklogs || []),
    ));

    if (!tot.commits && !tot.tokens_total && !tot.minutes) {
      body.append(h('div', { class: 'muted', style: { padding: '1rem' } },
        'No commits, tokens or work logs recorded for this week yet.'));
    }
  }

  // Grouped view: one row per (date, issue) with total minutes + entry
  // count + concatenated comments. Read-only — switch off grouping to
  // delete individual entries.
  function worklogGroupedTable(logs) {
    if (!logs.length) {
      return h('div', { class: 'muted', style: { padding: '0.4rem 0' } },
        'No work logs for this week.');
    }
    const groups = new Map();
    for (const w of logs) {
      const key = `${w.date_local}|${w.issue}`;
      const g = groups.get(key) || {
        date_local: w.date_local, issue: w.issue,
        minutes: 0, entries: 0, comments: [], sources: new Set(),
      };
      g.minutes += w.minutes;
      g.entries += 1;
      if (w.comment) g.comments.push(w.comment);
      g.sources.add(w.source);
      groups.set(key, g);
    }
    const accessors = {
      date_local: g => g.date_local || '',
      issue:      g => g.issue || '',
      minutes:    g => g.minutes || 0,
      entries:    g => g.entries || 0,
    };
    const sortState = loadTableSort('worklog-grouped');
    const rows = sortRowsBy([...groups.values()], sortState, accessors);
    const onResort = (next) => {
      saveTableSort('worklog-grouped', next);
      if (weekModal.data) renderWeekSummary(weekModal.data);
    };
    return h('table', { class: 'week-table worklog-table' },
      h('thead', {}, h('tr', {},
        sortableTh('Date',    'date_local', sortState, onResort),
        sortableTh('Issue',   'issue',      sortState, onResort),
        sortableTh('Time',    'minutes',    sortState, onResort, { class: 'num' }),
        sortableTh('Entries', 'entries',    sortState, onResort, { class: 'num' }),
        h('th', {}, t('col.comments')),
      )),
      h('tbody', {}, ...rows.map(g => h('tr', {},
        h('td', {}, g.date_local),
        h('td', {}, g.issue === '__agent__' ? t('tab.generic-agent') : g.issue),
        h('td', { class: 'num' }, fmtMinAsHours(g.minutes)),
        h('td', { class: 'num' }, g.entries),
        h('td', { title: g.comments.join('\n') },
          g.comments.length
            ? g.comments.join(' · ')
            : h('span', { class: 'muted' }, '—')),
      ))),
    );
  }

  // Render the Source column as an icon for compact display:
  //   agent → 🤖, timer → ⏱, manual → ✎. Tooltip carries the source name.
  function sourceIcon(source) {
    const map = { agent: '🤖', timer: '⏱', manual: '✎' };
    const icon = map[source] || source;
    return h('span', { class: `worklog-source-icon source-${source}`,
                       title: source }, icon);
  }

  function worklogTable(logs) {
    if (!logs.length) {
      return h('div', { class: 'muted', style: { padding: '0.4rem 0' } },
        'No work logs for this week. Use the timer below the heatmap, or click "+ Add log".');
    }
    const accessors = {
      date_local: w => w.date_local || '',
      issue:      w => w.issue || '',
      minutes:    w => w.minutes || 0,
      source:     w => w.source || '',
      comment:    w => w.comment || '',
    };
    const sortState = loadTableSort('worklog');
    logs = sortRowsBy(logs, sortState, accessors);
    const onResort = (next) => {
      saveTableSort('worklog', next);
      if (weekModal.data) renderWeekSummary(weekModal.data);
    };
    return h('table', { class: 'week-table worklog-table' },
      h('thead', {}, h('tr', {},
        sortableTh('Date',    'date_local', sortState, onResort),
        sortableTh('Issue',   'issue',      sortState, onResort),
        sortableTh('Time',    'minutes',    sortState, onResort, { class: 'num' }),
        sortableTh('Source',  'source',     sortState, onResort),
        sortableTh('Comment', 'comment',    sortState, onResort),
        h('th', {}, ''),
      )),
      h('tbody', {}, ...logs.map(w => h('tr', {
        class: w.source === 'agent' ? 'wl-agent-row' : null,
      },
        h('td', {}, w.date_local),
        h('td', {}, w.issue === '__agent__' ? t('tab.generic-agent') : w.issue),
        h('td', { class: 'num' }, fmtMinAsHours(w.minutes)),
        h('td', { class: 'source-cell' }, sourceIcon(w.source)),
        h('td', {}, w.comment || ''),
        h('td', {},
          // Agent rows are synthesized — deleting them adds the
          // (issue, week) pair to the exclusion table so they stay gone.
          h('button', {
            class: 'btn-link danger',
            title: w.source === 'agent'
              ? 'Hide this auto-tracked agent entry for the week'
              : 'Delete',
            onclick: () => w.source === 'agent'
              ? deleteAgentWorklog(w.issue)
              : deleteWorklog(w.id),
          }, '🗑'),
        ),
      ))),
    );
  }


  function renderLogList() {
    const list = document.getElementById('logs-list');
    const rows = document.getElementById('log-rows');
    if (!rows || !list) return;
    const ql = (logsModal.filters.q || '').toLowerCase();
    const wantedLevels = new Set(
      Object.entries(logsModal.filters)
        .filter(([k, v]) => k !== 'q' && v).map(([k]) => k));
    const visible = logsModal.entries.filter(e =>
      wantedLevels.has(e.level)
      && (!ql || e.msg.toLowerCase().includes(ql)));
    rows.replaceChildren(...visible.map(e => {
      const d = new Date(e.ts * 1000);
      const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
      return h('div', { class: `log-line log-${e.level}` },
        h('span', { class: 'log-ts' }, ts),
        h('span', { class: `log-level log-level-${e.level}` }, e.level),
        h('span', { class: 'log-msg' }, e.msg),
      );
    }));
    // Stick to bottom so newest is in view (unless user scrolled away).
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  async function openFileInEditor(worktree, relPath) {
    if (!editorPref) {
      showToast('warn', t('toast.pick-editor'));
      return;
    }
    try {
      const r = await fetch('/api/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktree, path: relPath, editor: editorPref }),
      });
      const result = await r.json().catch(() => ({}));
      if (!r.ok || result.error) {
        showToast('error', result.error || `Open failed (${r.status})`);
      } else {
        showToast('ok', `✓ opened in ${editorPref}`);
      }
    } catch (err) {
      showToast('error', t('toast.open-failed', { err }));
    }
  }

  // Run one of the safe server-side git ops (fetch / pull-ff / push)
  // and surface the full output in a multi-line banner. Disables the
  // firing button for the round-trip so the user doesn't double-fire
  // on slow networks. Refreshes the dashboard on success so the ↓↑
  // counts catch up.
  async function runGitOp(op, issue, repo, btn) {
    if (btn) { btn.disabled = true; btn.classList.add('git-op-running'); }
    try {
      const url = `/api/git/${encodeURIComponent(op)}`
        + `?issue=${encodeURIComponent(issue)}`
        + `&repo=${encodeURIComponent(repo)}`;
      const r = await fetch(url, { method: 'POST', cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      const opLabel = ({
        'fetch': 'fetch', 'pull-ff': 'pull --ff-only', 'push': 'push',
      })[op] || op;
      const body = (d.stdout || d.stderr || d.error || '').trim();
      if (d.ok) {
        showGitOpBanner('ok', `${issue}/${repo} · ${opLabel}`,
          body || `${opLabel} succeeded — nothing to do.`);
        refreshAll(true);
      } else {
        showGitOpBanner('error', `${issue}/${repo} · ${opLabel}`,
          body || `${opLabel} failed (rc=${d.returncode})`);
      }
    } catch (err) {
      showGitOpBanner('error', `${issue}/${repo} · ${op}`, String(err));
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('git-op-running'); }
    }
  }

  // Run the same safe git op across every repo of an issue. One round
  // trip — server fans out and returns a per-repo result list. UI
  // surfaces them as a single multi-line banner. Disables the firing
  // button for the round-trip.
  async function runIssueGitOp(op, issue, btn) {
    if (btn) { btn.disabled = true; btn.classList.add('git-op-running'); }
    try {
      const url = `/api/issue/git-op/${encodeURIComponent(op)}`
        + `?issue=${encodeURIComponent(issue)}`;
      const r = await fetch(url, { method: 'POST', cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      const opLabel = ({
        'fetch': 'fetch', 'pull-ff': 'pull --ff-only', 'push': 'push',
      })[op] || op;
      if (!r.ok) {
        showGitOpBanner('error', `${issue} · ${opLabel}`,
          d.error || `request failed (${r.status})`);
        return;
      }
      const results = d.results || [];
      const lines = results.map(res => {
        const tag = res.skipped
          ? `⤼ skipped: ${res.skipped}`
          : (res.ok ? `✓ (${res.duration_ms}ms)` :
                      `⚠ rc=${res.returncode}`);
        const detail = (res.stdout || res.stderr || '').trim();
        const oneLine = detail.split('\n').slice(0, 1).join(' ').slice(0, 200);
        return `${res.repo.padEnd(10)} ${tag}`
             + (oneLine && !res.ok ? `\n            ${oneLine}` : '');
      });
      const body = lines.length
        ? lines.join('\n')
        : `(no repos found under ${issue})`;
      const allOk = d.n_total > 0 && d.n_total === d.n_ok;
      const kind = allOk ? 'ok' : (d.n_ok > 0 ? 'warn' : 'error');
      showGitOpBanner(kind === 'error' ? 'error' : 'ok',
        `${issue} · ${opLabel} · ${d.n_ok}/${d.n_total} ok`, body);
      if (d.n_ok > 0) refreshAll(true);
    } catch (err) {
      showGitOpBanner('error', `${issue} · ${op}`, String(err));
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('git-op-running'); }
    }
  }

  // Multi-line banner for git-op results — same host as the agent
  // notification toast (shape + width), but tinted ok/error and shows
  // the full git stdout/stderr verbatim in monospace. Click anywhere
  // on the banner to dismiss it. Lifespan is generous so the user can
  // actually read multi-line output.
  function showGitOpBanner(kind, title, body) {
    let host = document.getElementById('agent-toast-host');
    if (!host) {
      host = h('div', { id: 'agent-toast-host', 'aria-live': 'polite' });
      document.body.append(host);
    }
    const t = h('div', {
      class: `toast toast-agent toast-git toast-git-${kind}`,
      role: kind === 'error' ? 'alertdialog' : 'status',
      title: 'Click to dismiss',
      onclick: () => { if (t.parentNode === host) host.removeChild(t); },
    },
      h('div', { class: 'toast-agent-head' },
        h('span', { class: 'toast-agent-icon', 'aria-hidden': 'true' },
          kind === 'ok' ? '✓' : '⚠'),
        h('strong', {}, title),
      ),
      h('pre', { class: 'toast-git-body' }, body),
    );
    host.append(t);
    const lifeMs = kind === 'error' ? 20_000 : 12_000;
    setTimeout(() => t.classList.add('fade'), lifeMs - 400);
    setTimeout(() => { if (t.parentNode === host) host.removeChild(t); }, lifeMs);
  }

  function dirtyFilesTableFor(files, repoPath) {
    const ol = h('ol', { class: 'commit-list dirty-list' });
    if (!files || !files.length) {
      ol.append(h('li', { class: 'empty' }, '(clean)'));
      return ol;
    }
    for (const f of files) {
      // Deleted files don't exist on disk anymore — no clickable target.
      // Renames (R) are clickable: the server opens the destination side.
      const isDeleted = !f.code.includes('R') && f.code.includes('D');
      const subject = (isDeleted || !repoPath)
        ? h('span', { class: 'subject',
                      title: isDeleted ? 'file deleted — cannot open' : null },
            f.path)
        : h('a', {
            class: 'subject file-link',
            href: '#',
            title: editorPref
              ? `Open in ${editorPref}`
              : 'Pick an editor in the toolbar first',
            onclick: (e) => {
              e.preventDefault();
              openFileInEditor(repoPath, f.path);
            },
          }, f.path);
      ol.append(h('li', {},
        h('code', { class: 'sha', title: porcelainTooltip(f.code) }, f.code),
        subject,
      ));
    }
    return ol;
  }

  function detailsPaneFor(repo) {
    const unpushedEmpty = repo.upstream_configured ? '(none)' : '(no upstream configured)';
    const cardKey = `${repo.issue}/${repo.repo}`;
    const root = h('div', { class: 'inner-details' });

    // Always include the merge-base row even if it's older than the last
    // commits — it's the "branch fork point" anchor.
    let displayCommits = repo.last_commits;
    if (repo.merge_base_sha && repo.merge_base_commit
        && !repo.last_commits.some(c => c.sha === repo.merge_base_sha)) {
      displayCommits = [...repo.last_commits, repo.merge_base_commit];
    }

    const renderAuthors = () => {
      const ul = h('ul', { class: 'coauthors' });
      for (const c of repo.coauthors) {
        ul.append(h('li', {}, h('strong', {}, c.count), ' ', c.author));
      }
      return ul;
    };

    // Four tabs: Working tree, Last commits, Unpushed, Authors. Empty
    // states render a placeholder of the same height as a 10-row table so
    // switching tabs never jumps the layout.
    const tabs = [
      { id: 'working',   label: 'Working tree', count: repo.n_dirty,
        render: () => repo.n_dirty > 0
          ? dirtyFilesTableFor(repo.dirty_files, repo.path)
          : h('div', { class: 'tab-empty' }, 'Working tree is clean.') },
      { id: 'commits',   label: 'Last commits', count: repo.last_commits.length,
        render: () => commitListOf(displayCommits, '(none)',
                                    repo.remote_path, repo.merge_base_sha,
                                    repo.remote_url) },
      { id: 'unpushed',  label: 'Unpushed',     count: repo.n_unpushed,
        render: () => repo.n_unpushed > 0
          ? commitListOf(repo.unpushed, unpushedEmpty,
                          repo.remote_path, null, repo.remote_url)
          : h('div', { class: 'tab-empty' }, unpushedEmpty) },
      { id: 'authors',   label: 'Authors',      count: repo.coauthors?.length || 0,
        render: () => (repo.coauthors?.length || 0) > 0
          ? renderAuthors()
          : h('div', { class: 'tab-empty' }, 'No authors recorded for this branch.') },
    ];

    // Default tab: prefer Working tree if dirty, then Unpushed if any,
    // otherwise Last commits. Remembered per-card across re-renders.
    openState.repoTabs = openState.repoTabs || {};
    let activeTabId = openState.repoTabs[cardKey];
    if (!activeTabId || !tabs.some(t => t.id === activeTabId)) {
      activeTabId = repo.n_dirty > 0    ? 'working'
                  : repo.n_unpushed > 0 ? 'unpushed'
                                        : 'commits';
    }

    const tabBar = h('div', { class: 'repo-inner-tabs', role: 'tablist' });
    const panel  = h('div', { class: 'repo-inner-panel', role: 'tabpanel' });

    function activate(id) {
      openState.repoTabs[cardKey] = id;
      tabBar.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === id));
      const t = tabs.find(x => x.id === id) || tabs[0];
      panel.replaceChildren(t.render());
    }

    for (const t of tabs) {
      tabBar.append(h('button', {
        class: 'repo-inner-tab' + (t.count === 0 ? ' empty' : ''),
        type: 'button',
        'data-tab': t.id,
        'aria-pressed': t.id === activeTabId ? 'true' : 'false',
        onclick: () => activate(t.id),
      },
        h('span', { class: 'tab-label' }, t.label),
        h('span', { class: 'tab-count' }, t.count),
      ));
    }
    root.append(tabBar, panel);
    activate(activeTabId);
    return root;
  }

  function fmtTokens(n) {
    if (!n && n !== 0) return '—';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'K';
    return (n / 1_000_000).toFixed(2) + 'M';
  }
  function fmtUsd(n) {
    if (n == null) return '—';
    if (n < 0.01) return '<$0.01';
    if (n < 100)  return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString();
  }

  // Roll up per-repo claude_session blobs into a single per-issue summary.
  // Tool counts and message counts sum, sizes sum, activity ages take the
  // most recent (smallest age), prompt text comes from the repo with the
  // most recent prompt. Each per-repo session is also surfaced as its own
  // chip so you can still tell where the work happened.
  // Synthesise the same shape `aggregateAgentData` returns for a
  // regular per-issue agent, but from the single
  // state.general_agent_session dict the server attaches for the
  // General Agent (it has no repos to aggregate over). Returns
  // null when there's no claude history yet so the modal can show
  // the empty-state note.
  function buildGeneralAgentInfoData(state) {
    const s = state?.general_agent_session;
    if (!s || !s.session_count) return null;
    const tools = s.tool_counts || {};
    return {
      perRepo: [{
        repo: 'general',
        s,
        tokens: state?.general_agent_tokens || null,
      }],
      session_count: s.session_count || 0,
      sessions_size_bytes: s.sessions_size_bytes || 0,
      tool_counts: Object.fromEntries(
        Object.entries(tools).sort(([, a], [, b]) => b - a)),
      total_tool_calls: s.total_tool_calls || 0,
      user_msg_count: s.user_msg_count || 0,
      assistant_msg_count: s.assistant_msg_count || 0,
      last_activity_age_min: s.last_activity_age_min ?? -1,
      last_user_prompt: s.last_user_prompt || '',
      last_user_prompt_repo: 'general',
      last_user_prompt_age_min: s.last_user_prompt_age_min ?? -1,
      queued_prompts: s.queued_prompts || 0,
      permission_modes: s.permission_mode
        ? [`general:${s.permission_mode}`] : [],
      issue_tokens: state?.general_agent_tokens || null,
    };
  }

  function aggregateAgentData(issueObj) {
    const perRepo = [];
    let total_sessions = 0;
    let total_bytes = 0;
    const tools = {};
    let user_msgs = 0, asst_msgs = 0, total_tools = 0;
    let last_activity = -1, last_prompt_age = -1;
    let prompt_text = '', prompt_repo = null;
    let queued = 0;
    let perm_modes = [];
    for (const r of issueObj.repos) {
      const s = r.claude_session;
      if (!s || !s.session_count) continue;
      perRepo.push({ repo: r.repo, s });
      total_sessions += s.session_count;
      total_bytes    += s.sessions_size_bytes || 0;
      user_msgs      += s.user_msg_count || 0;
      asst_msgs      += s.assistant_msg_count || 0;
      total_tools    += s.total_tool_calls || 0;
      queued         += s.queued_prompts || 0;
      for (const [k, v] of Object.entries(s.tool_counts || {})) {
        tools[k] = (tools[k] || 0) + v;
      }
      const a = s.last_activity_age_min;
      if (a >= 0 && (last_activity < 0 || a < last_activity)) last_activity = a;
      const p = s.last_user_prompt_age_min;
      if (p >= 0 && (last_prompt_age < 0 || p < last_prompt_age)) {
        last_prompt_age = p;
        prompt_text = s.last_user_prompt || '';
        prompt_repo = r.repo;
      }
      if (s.permission_mode) perm_modes.push(`${r.repo}:${s.permission_mode}`);
    }
    if (!perRepo.length) return null;
    // Token / cost rollup (server-aggregated) — issue-level total +
    // per-repo entries we attach to perRepo for the breakdown row.
    const issueTokens = issueObj.agent_tokens_total || null;
    for (const r of issueObj.repos) {
      const at = r.agent_tokens;
      if (!at) continue;
      const found = perRepo.find(x => x.repo === r.repo);
      if (found) found.tokens = at;
    }
    return {
      perRepo,
      session_count: total_sessions,
      sessions_size_bytes: total_bytes,
      tool_counts: Object.fromEntries(
        Object.entries(tools).sort(([, a], [, b]) => b - a)),
      total_tool_calls: total_tools,
      user_msg_count: user_msgs,
      assistant_msg_count: asst_msgs,
      last_activity_age_min: last_activity,
      last_user_prompt: prompt_text,
      last_user_prompt_repo: prompt_repo,
      last_user_prompt_age_min: last_prompt_age,
      queued_prompts: queued,
      permission_modes: perm_modes,
      issue_tokens: issueTokens,
    };
  }

  function fmtAge(min) {
    if (min == null || min < 0) return '—';
    const ago = t('time.ago');
    if (min < 60) return `${min}m ${ago}`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}h ${min % 60}m ${ago}`;
    return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h ${ago}`;
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
    return `${(n / 1024 / 1024).toFixed(2)}M`;
  }

  // Render the per-issue "Claude agent" collapsible block. Aggregates
  // across the issue's repos (core + bssweb + doc) so you see one block
  // per tab, matching how you actually run Claude (one terminal per issue).
  function claudeAgentSectionFor(s, issueId, pendingCount) {
    issueId = issueId || '';
    pendingCount = pendingCount || 0;
    // Header summary — includes total tokens + cost when available so the
    // most expensive context is visible without expanding the block.
    const tt = s ? s.issue_tokens : null;
    const headerExtras = tt && tt.total_tokens
      ? ` · ${fmtTokens(tt.total_tokens)} tok ≈ ${fmtUsd(tt.cost_usd)}`
      : '';
    const metaText = s
      ? `${s.session_count} session${s.session_count !== 1 ? 's' : ''} across ${s.perRepo.length} repo${s.perRepo.length !== 1 ? 's' : ''} · ${fmtBytes(s.sessions_size_bytes)} · last activity ${fmtAge(s.last_activity_age_min)}${headerExtras}`
      : `no recorded sessions${pendingCount > 0 ? ` · ${pendingCount} pending message${pendingCount !== 1 ? 's' : ''}` : ''}`;
    const summary = h('summary', { class: 'agent-summary' },
      h('span', { class: 'agent-title' },
        h('span', { class: 'section-icon section-icon-agent',
                     'aria-hidden': 'true' },
          agentIconNode()),
        'Agent information'),
      h('span', { class: 'agent-meta' }, metaText),
    );

    // Inline metrics row — only built when there's session data to show.
    const rows = [];
    if (!s) {
      rows.push(h('div', { class: 'muted', style: { padding: '0.4rem 0' } },
        'No Claude sessions found for this issue yet. Use the Messages tab to see hook events.'));
    } else {
    const lblValRow = (label, value, cls) =>
      h('div', { class: 'agent-row' },
        h('span', { class: 'agent-label' }, label),
        h('span', { class: 'agent-value ' + (cls || '') }, value),
      );
    if (s.last_user_prompt) {
      const promptAge = fmtAge(s.last_user_prompt_age_min);
      const repoNote = s.last_user_prompt_repo ? ` · in ${s.last_user_prompt_repo}` : '';
      rows.push(
        h('div', { class: 'agent-row agent-row-prompt' },
          h('span', { class: 'agent-label' },
            `Last prompt · ${promptAge}${repoNote}`),
          h('div', { class: 'agent-prompt' }, s.last_user_prompt),
        ),
      );
    }
    const meta = [];
    if (s.permission_modes && s.permission_modes.length)
      meta.push(['Permission mode', s.permission_modes.join(' · ')]);
    if (s.queued_prompts > 0)
      meta.push(['Queued prompts', String(s.queued_prompts), 'agent-warn']);
    meta.push(['Messages', `${s.user_msg_count} user · ${s.assistant_msg_count} assistant`]);
    // Token breakdown row when we have any. Shows cache_r prominently
    // because it's almost always the dominant share of total tokens.
    if (tt && tt.total_tokens > 0) {
      const tk = tt.tokens;
      const detail = `${fmtTokens(tk.in)} in · ${fmtTokens(tk.out)} out · ${fmtTokens(tk.cache_r)} cache_r · ${fmtTokens(tk.cache_w)} cache_w`;
      rows.push(
        h('div', { class: 'agent-row' },
          h('span', { class: 'agent-label' }, `Tokens · ${fmtUsd(tt.cost_usd)}`),
          h('span', { class: 'agent-value' }, `${fmtTokens(tt.total_tokens)} total — `, detail),
        ),
      );
    }
    // Per-repo session breakdown so you can still see where the activity is.
    if (s.perRepo.length > 1) {
      const breakdown = s.perRepo.map(r => {
        const tok = r.tokens && r.tokens.tokens
          ? ` · ${fmtTokens(Object.values(r.tokens.tokens).reduce((a,b)=>a+b,0))} tok ≈ ${fmtUsd(r.tokens.cost_usd)}`
          : '';
        return `${r.repo}: ${r.s.session_count}s · ${fmtAge(r.s.last_activity_age_min)}${tok}`;
      }).join(' · ');
      meta.push(['By repo', breakdown]);
    }
    for (const [k, v, cls] of meta) rows.push(lblValRow(k, v, cls));

    // Tool-use distribution as a horizontal bar of stacked segments.
    const tools = s.tool_counts || {};
    const total = s.total_tool_calls || 0;
    if (total > 0) {
      const colors = {
        Bash: '#9b6dff', Edit: '#16a34a', Read: '#0ea5e9',
        Write: '#f97316', Skill: '#ec4899',
      };
      const palette = ['#64748b', '#a16207', '#7c3aed', '#0d9488', '#dc2626'];
      const bar = h('div', { class: 'agent-toolbar' });
      const labels = h('div', { class: 'agent-toollabels' });
      let i = 0;
      for (const [name, count] of Object.entries(tools)) {
        const pct = (count / total) * 100;
        const color = colors[name] || palette[i++ % palette.length];
        bar.append(h('span', {
          class: 'agent-toolseg',
          style: { width: pct.toFixed(2) + '%', background: color },
          title: `${name}: ${count} (${pct.toFixed(1)}%)`,
        }));
        labels.append(h('span', { class: 'agent-toolchip' },
          h('span', { class: 'agent-toolswatch', style: { background: color } }),
          `${name} ${count}`));
      }
      rows.push(
        h('div', { class: 'agent-row agent-row-block' },
          h('span', { class: 'agent-label' }, `Tool use · ${total} calls`),
          bar, labels,
        ),
      );
    }
    }   // end of `else { /* s present */ }`

    // Wrap the activity rows + a Messages pane in inner tabs so the user
    // can switch between session activity (the rollup above) and the
    // recent hook events for this issue.
    const tabBar = h('div', { class: 'agent-inner-tabs', role: 'tablist' });
    const panel  = h('div', { class: 'agent-inner-panel', role: 'tabpanel' });

    const activityPanel = h('div', { class: 'agent-body' }, ...rows);
    const messagesPanel = h('div', { class: 'agent-messages',
                                      'data-loaded': '0' },
      h('span', { class: 'muted' }, t('ui.loading')));

    const activate = (which) => {
      tabBar.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.kind === which));
      if (which === 'activity') {
        panel.replaceChildren(activityPanel);
      } else {
        panel.replaceChildren(messagesPanel);
        if (messagesPanel.dataset.loaded !== '1') loadAgentMessages(issueId, messagesPanel);
        // Mark events as read since the user is now looking at them.
        markIssueEventsRead(issueId);
      }
    };

    const activityBtn = h('button', {
      class: 'agent-inner-tab' + (pendingCount === 0 ? ' active' : ''),
      type: 'button', 'data-kind': 'activity',
      onclick: () => activate('activity'),
    }, h('span', {}, t('ui.activity')));
    const messagesBtn = h('button', {
      class: 'agent-inner-tab' + (pendingCount > 0 ? ' active' : ''),
      type: 'button', 'data-kind': 'messages',
      onclick: () => activate('messages'),
      'data-issue': issueId,
    }, h('span', {}, t('ui.messages')),
       pendingCount > 0
         ? h('span', { class: 'tab-count badge-pending' }, String(pendingCount))
         : null,
    );
    tabBar.append(activityBtn, messagesBtn);

    // Initial pane: prefer Messages when there are pending events so the
    // user lands on what's new; otherwise show Activity. Don't auto-mark
    // events read on this initial render — the tab badge has to survive
    // until the user actively acknowledges it (via the Messages sub-tab
    // click handler above, or via the per-issue events modal).
    panel.replaceChildren(pendingCount > 0 ? messagesPanel : activityPanel);
    if (pendingCount > 0 && messagesPanel.dataset.loaded !== '1') {
      loadAgentMessages(issueId, messagesPanel);
    }

    return h('details', { class: 'agent-details', open: '',
                          'data-issue': issueId },
      summary,
      tabBar, panel,
    );
  }

  // Lazy-load the issue's agent events into the messages pane. Cached
  // by data-loaded='1' on the pane so re-activating the tab is free.
  async function loadAgentMessages(issueId, target) {
    target.replaceChildren(h('span', { class: 'muted' }, t('ui.loading')));
    try {
      const r = await fetch(
        `/api/events?issue=${encodeURIComponent(issueId)}&limit=200`,
        { cache: 'no-store' });
      const d = await r.json();
      target.replaceChildren(renderAgentMessages(d.events || []));
      target.dataset.loaded = '1';
    } catch (err) {
      target.replaceChildren(
        h('span', { class: 'muted' }, t('ui.load-failed', { err })));
    }
  }

  function renderAgentMessages(events) {
    if (!events.length) {
      return h('div', { class: 'muted', style: { padding: '0.6rem 0' } },
        'No agent events recorded for this issue yet. ' +
        '(Configure Claude Code hooks via setup.sh --enable-claude-hooks.)');
    }
    // Show unread-only — the user already has the 🔔 Agent events modal
    // for full history. The Messages sub-tab is the "what needs my
    // attention right now" view.
    const unread = events.filter(e => !e.read_at);
    if (!unread.length) {
      return h('div', { class: 'muted', style: { padding: '0.6rem 0' } },
        'No unread events. Open ', h('strong', {}, '🔔 Agent events'),
        ' (toolbar or tab badge) for full history.');
    }
    // Wrap the table so the re-render-on-resort path can swap just its
    // body without rebuilding the outer scroll container.
    const wrap = h('div', { class: 'agent-message-table-wrap' });
    const renderTable = () => {
      const sortState = loadTableSort('agent-msgs');
      const onResort = (next) => {
        saveTableSort('agent-msgs', next);
        renderTable();
      };
      const accessors = {
        kind:       e => (e.kind || '').toLowerCase(),
        created_at: e => e.created_at || 0,
        message:    e => (e.message || '').toLowerCase(),
      };
      const rows = sortRowsBy(unread, sortState, accessors).map(e => {
        const ts = new Date((e.created_at || 0) * 1000);
        return h('tr', { class: 'agent-message-row unread' },
          h('td', { class: 'agent-message-time' }, ts.toLocaleString()),
          h('td', { class: 'agent-message-kind-cell' },
            h('span', { class: 'agent-message-kind kind-' + e.kind },
              e.kind)),
          h('td', { class: 'agent-message-body' },
            e.message || h('span', { class: 'muted' }, '(no message)')),
        );
      });
      // Same column order as the toolbar's 🔔 Agent events modal
      // (Time → Kind → Message) so the two views feel consistent.
      // The "Issue" column from the modal is dropped here — this view
      // is already scoped to one issue.
      wrap.replaceChildren(h('table', { class: 'agent-message-table' },
        h('thead', {}, h('tr', {},
          sortableTh(t('evt.col.time'), 'created_at',
            sortState, onResort, { class: 'agent-message-time' }),
          sortableTh(t('evt.col.kind'), 'kind',
            sortState, onResort, { class: 'agent-message-kind-cell' }),
          sortableTh(t('evt.col.message'), 'message',
            sortState, onResort),
        )),
        h('tbody', {}, ...rows),
      ));
    };
    renderTable();
    return wrap;
  }

  async function markIssueEventsRead(issueId) {
    try {
      await fetch(`/api/events/mark-read?issue=${encodeURIComponent(issueId)}`,
                  { method: 'POST' });
      // Refresh state on the next tick so the tab badge clears. A full
      // refresh would be heavy — just clear the local count and the UI.
      const tab = document.querySelector(
        `nav.tabs button[data-tab="tab-${slugId(issueId)}"] .pending-events-badge`);
      if (tab) tab.remove();
      const issue = (window.__lastState?.issues || []).find(
        i => i.issue === issueId);
      if (issue) issue.pending_events = 0;
    } catch (_) {}
  }

  // ── All agent events modal ───────────────────────────────────────
  // Lists every event across every issue (latest first). Filterable
  // by kind + unread-only; click an issue to jump to its tab.
  // When `issue` is non-null the modal is scoped to a single issue —
  // the per-tab 🔔N badge opens it that way.
  const allEventsModal = {
    open: false,
    issue: null,
    // hideNoIssue defaults true so hook events posted from outside any
    // worktree (e.g. from the dashboard's own checkout) don't drown out
    // the per-issue events you actually care about. The user can flip
    // it off with the chip if they want to see everything.
    // dateRange default 'today' — opening the dialog should focus the
    // user on what just happened. Other ranges: '7d', '30d', 'all'.
    // issueFilter empty string = every issue (only used in unscoped mode).
    filters: {
      kinds: null, unreadOnly: false, hideNoIssue: true,
      dateRange: 'today', issueFilter: '',
    },
  };

  // Cutoff timestamp (in seconds) for the dateRange filter. 0 means "no
  // lower bound" (the 'all' range). Computed against `Date.now()` rather
  // than a cached value so the filter stays correct across midnight.
  function eventDateCutoffSeconds(range) {
    if (range === 'all') return 0;
    if (range === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    if (range === '7d')  return Math.floor(Date.now() / 1000) - 7  * 86400;
    if (range === '30d') return Math.floor(Date.now() / 1000) - 30 * 86400;
    return 0;
  }

  // ── GitHub modal ──────────────────────────────────────────────────────
  // Lists issues assigned to you + your open PRs across every repo in
  // the `github-repos` preference. Lean: fetch on open, render a flat
  // table per section, click anywhere to dismiss.
  const githubModal = { open: false };

  function openGithubModal() {
    if (githubModal.open) return;
    githubModal.open = true;
    const modal = h('div', { class: 'logs-modal-backdrop', id: 'github-modal' },
      h('div', { class: 'logs-modal week-modal',
                  role: 'dialog', 'aria-labelledby': 'github-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'github-modal-title' }, t('github.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', id: 'github-refresh',
            onclick: () => loadGithub(true) }, t('github.refresh')),
          h('button', { class: 'btn btn-inline',
                        onclick: closeGithubModal }, t('github.close')),
        ),
        h('div', { class: 'week-body', id: 'github-body' },
          h('span', { class: 'muted' }, t('github.loading'))),
      ),
    );
    modal.addEventListener('click', closeGithubModal);
    document.body.append(modal);
    document.addEventListener('keydown', githubKeyHandler);
    loadGithub(false);
  }

  function closeGithubModal() {
    if (!githubModal.open) return;
    githubModal.open = false;
    document.getElementById('github-modal')?.remove();
    document.removeEventListener('keydown', githubKeyHandler);
  }

  function githubKeyHandler(e) { if (e.key === 'Escape') closeGithubModal(); }

  // Server-side preferences cache used by the GitHub modal so we can
  // render display names (workspace-names pref) inline. Refreshed on
  // every loadGithub() so a rename in another tab shows up on Refresh.
  let githubModalPrefs = {};

  async function loadGithub(force) {
    const btn = document.getElementById('github-refresh');
    if (btn) btn.disabled = true;
    try {
      const qs = force ? '?force=1' : '';
      const [issuesR, prsR, prefsR] = await Promise.all([
        fetch('/api/github/issues' + qs, { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/github/prs' + qs, { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/preferences', { cache: 'no-store' }).then(r => r.json()),
      ]);
      githubModalPrefs = (prefsR && prefsR.preferences) || {};
      renderGithubModal(issuesR, prsR);
    } catch (err) {
      const body = document.getElementById('github-body');
      if (body) body.replaceChildren(h('div', { class: 'muted',
        style: { padding: '1rem' } }, String(err)));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Cell builder for the Workspace column. When a display name is set
  // for the workspace id, shows "<name>  <muted id>"; otherwise shows
  // the id. A ✏ button opens a window.prompt to set / clear the name
  // (POSTs to /api/preferences with the updated workspace-names map).
  // Empty cell for issues without an existing workspace folder.
  function workspaceCell(existingId) {
    if (!existingId) {
      return t('github.no-workspace');
    }
    const namesMap = (githubModalPrefs['workspace-names'] || {});
    const display = (namesMap[existingId] || '').trim();
    const editBtn = h('button', {
      class: 'btn btn-inline workspace-name-edit',
      title: display
        ? t('github.clear-name')
        : t('github.set-name'),
      onclick: async (e) => {
        e.preventDefault();
        const current = (namesMap[existingId] || '');
        const next = window.prompt(
          t('github.name-prompt', { workspace: existingId }),
          current,
        );
        if (next === null) return;            // cancel
        const trimmed = next.trim();
        const newMap = Object.assign({}, namesMap);
        if (trimmed) newMap[existingId] = trimmed;
        else delete newMap[existingId];
        try {
          await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              preferences: { 'workspace-names': newMap },
            }),
          });
          githubModalPrefs['workspace-names'] = newMap;
          loadGithub(false);
        } catch (err) {
          showToast('error', `rename failed: ${err}`);
        }
      },
    }, '✏');
    if (display) {
      return h('span', { class: 'workspace-cell' },
        h('a', { href: '#' + existingId, onclick: closeGithubModal },
          display),
        h('span', { class: 'muted workspace-cell-id' }, existingId),
        editBtn);
    }
    return h('span', { class: 'workspace-cell' },
      h('a', { href: '#' + existingId, onclick: closeGithubModal },
        existingId),
      editBtn);
  }

  function renderGithubModal(issuesR, prsR) {
    const body = document.getElementById('github-body');
    if (!body) return;
    const repos = (issuesR?.repos || prsR?.repos || []);
    if (!repos.length) {
      body.replaceChildren(h('div', { class: 'muted',
        style: { padding: '1rem' } }, t('github.not-configured')));
      return;
    }
    // Build a workspace-name lookup so each row can show whether it
    // already has a local worktree dir.
    const wsNames = new Set((window.__lastState?.issues || [])
      .map(i => i.issue));
    function hasWorkspaceFor(num) {
      const prefix = `${num}-`;
      for (const w of wsNames) {
        if (w === String(num) || w.startsWith(prefix)) return true;
      }
      return false;
    }
    function workspaceNameFor(number, title) {
      // Conventional `<num>-<kebab-title>` workspace folder. Title is
      // lowercased + non-alphanum collapsed to '-'; truncated so the
      // folder name doesn't blow out at very long issue titles.
      const slug = (title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
      return slug ? `${number}-${slug}` : String(number);
    }
    function existingWorkspaceFor(number) {
      const prefix = `${number}-`;
      for (const w of wsNames) {
        if (w === String(number) || w.startsWith(prefix)) return w;
      }
      return null;
    }
    function issueTable(rows, emptyKey, opts) {
      const isPRTable = (opts && opts.isPR) || false;
      if (!rows || !rows.length) {
        return h('div', { class: 'muted', style: { padding: '0.5rem 1rem' } },
          t(emptyKey));
      }
      const ths = [
        h('th', {}, t('github.col.repo')),
        h('th', { class: 'num' }, t('github.col.number')),
        h('th', {}, t('github.col.title')),
        h('th', {}, t('github.col.state')),
        h('th', {}, t('github.col.workspace')),
      ];
      if (!isPRTable) {
        ths.push(h('th', {}, t('github.col.agent')));
        ths.push(h('th', {}, t('github.col.model')));
        ths.push(h('th', {}, t('github.col.actions')));
      }
      const tbody = rows.map(it => {
        const existing = existingWorkspaceFor(it.number);
        const wsName = existing || workspaceNameFor(it.number, it.title);
        const tds = [
          h('td', { class: 'muted' }, it.repo || ''),
          h('td', { class: 'num' },
            h('a', { href: it.url, target: '_blank',
                      rel: 'noopener noreferrer' }, '#' + it.number)),
          h('td', {}, it.title || ''),
          h('td', {},
            h('span', { class: `github-pill github-pill-${it.state || 'open'}${it.isDraft ? ' github-pill-draft' : ''}` },
              it.state + (it.isDraft ? ' (draft)' : ''))),
          h('td', {}, workspaceCell(existing)),
        ];
        if (!isPRTable) {
          tds.push(githubAgentCell(existing));
          tds.push(githubModelCell(existing, it));
          tds.push(githubActionsCell(existing, wsName, it));
        }
        return h('tr', {}, ...tds);
      });
      return h('table', { class: 'github-table' },
        h('thead', {}, h('tr', {}, ...ths)),
        h('tbody', {}, ...tbody));
    }
    const issues = (issuesR?.issues || []);
    const prs = (prsR?.prs || []);
    const errs = [issuesR?.error, prsR?.error].filter(Boolean);
    const children = [
      h('div', { style: { padding: '0.5rem 1rem 0', fontSize: '12px' } },
        h('span', { class: 'muted' }, 'repos: '),
        ...repos.map(r => h('span', { class: 'pill', style: { marginRight: '0.4rem' } }, r))),
    ];
    if (errs.length) {
      children.push(h('div', { class: 'pill behind',
        style: { margin: '0.5rem 1rem' } }, errs.join('; ')));
    }
    children.push(
      h('h4', { style: { padding: '0.6rem 1rem 0', margin: 0 } },
        t('github.section.issues')),
      issueTable(issues, 'github.empty-issues'),
      h('h4', { style: { padding: '0.6rem 1rem 0', margin: 0 } },
        t('github.section.prs')),
      issueTable(prs.map(pr => ({
        repo: pr.repo, number: pr.number, title: pr.title,
        state: pr.state, url: pr.url, isDraft: pr.isDraft,
      })), 'github.empty-prs', { isPR: true }),
    );
    body.replaceChildren(...children);
  }

  // Per-issue Model picker shown in the GitHub modal table. Only
  // Saves a per-workspace preference and POSTs it server-side. Null
  // value (or empty string) clears the key.
  function persistPref(key, value) {
    if (value) prefs.setItem(key, value);
    else prefs.removeItem(key);
    return fetch('/api/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { [key]: value || null } }),
    }).catch(() => {});
  }

  // Per-workspace **Agent CLI** picker. Defaults to "use default"
  // (empty pref → falls back to the dashboard's default-provider pref).
  // Options come from /api/providers; only installed providers are
  // selectable. Stored under `workspace-provider-<id>`.
  function githubAgentCell(workspace) {
    if (!workspace) return h('td', { class: 'muted' }, '—');
    const prefKey = `workspace-provider-${workspace}`;
    const current = (prefs.getItem(prefKey) || '').trim();
    const providers = window.__providersCache || [];
    const sel = h('select', {
      class: 'github-model-select',
      title: 'Per-workspace agent CLI override',
      onchange: (e) => persistPref(prefKey, e.target.value).then(() => {
        // Re-render so the Model cell reflects the new provider's
        // models. Cheap — just reload the modal.
        loadGithub(false);
      }),
    });
    sel.append(h('option', {
      value: '', selected: (current === '') ? '' : null,
    }, t('github.agent.use-default')));
    for (const p of providers) {
      if (!p.installed) continue;
      sel.append(h('option', {
        value: p.id,
        selected: (p.id === current) ? '' : null,
      }, p.display_name));
    }
    return h('td', {}, sel);
  }

  // Per-workspace **Model** picker. Always populated from whichever
  // provider is active for this workspace — either the per-workspace
  // override or the dashboard default. Stored under
  // `workspace-model-<id>`.
  function githubModelCell(workspace) {
    if (!workspace) return h('td', { class: 'muted' }, '—');
    const providerKey = `workspace-provider-${workspace}`;
    const providerId = (prefs.getItem(providerKey)
      || prefs.getItem('default-provider') || 'claude').trim();
    const provider = (window.__providersCache || [])
      .find(p => p.id === providerId);
    if (!provider || !(provider.models || []).length) {
      return h('td', { class: 'muted' },
        t('github.agent.use-default'));
    }
    const prefKey = `workspace-model-${workspace}`;
    const current = (prefs.getItem(prefKey) || '').trim();
    const sel = h('select', {
      class: 'github-model-select',
      title: `Per-workspace model override (for ${provider.display_name})`,
      onchange: (e) => persistPref(prefKey, e.target.value),
    },
      h('option', { value: '', selected: (current === '') ? '' : null },
        t('github.agent.use-default')),
      ...provider.models.map(m => h('option', {
        value: m, selected: (m === current) ? '' : null,
      }, m.split(':').slice(-1)[0]))
    );
    return h('td', {}, sel);
  }

  // Modal: pick which configured GitHub repos to clone into the new
  // workspace. Defaults to "all" so the common case (issue spans the
  // whole tracked set) is one click. The repo list comes from the
  // /api/github/config payload — same source as the Profile editor.
  function openAddWorkspaceDialog(wsName, issueObj) {
    // align-items: flex-start on the backdrop so the small modal
    // doesn't stretch to viewport height (the inherited .logs-modal
    // styling assumes lots of content). The existing modals override
    // implicitly because they fill the area — ours doesn't.
    const backdrop = h('div', { class: 'logs-modal-backdrop',
      style: { alignItems: 'flex-start' },
      onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
    const checkboxesHost = h('div', { class: 'github-pickrepos-list' },
      h('span', { class: 'muted' }, t('github.loading')));
    const submitBtn = h('button', { class: 'btn btn-primary',
      disabled: '', onclick: () => doCreate() }, t('github.create-with', { n: 0 }));
    const modal = h('div', { class: 'logs-modal',
      style: { maxWidth: '480px', height: 'auto', alignSelf: 'flex-start' },
      role: 'dialog', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'logs-modal-head' },
        h('strong', {}, t('github.pick-repos', { number: issueObj.number })),
        h('span', { class: 'muted' }, ' · ', wsName),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn btn-inline', onclick: () => backdrop.remove() },
          t('github.close')),
      ),
      h('div', { style: { padding: '0.8rem 1rem' } },
        checkboxesHost,
        h('div', { style: { marginTop: '0.8rem', display: 'flex',
                              justifyContent: 'flex-end', gap: '0.5rem' } },
          submitBtn)),
    );
    backdrop.append(modal);
    document.body.append(backdrop);
    function escHandler(e) {
      if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escHandler); }
    }
    document.addEventListener('keydown', escHandler);

    let repos = [];
    const picked = new Set();

    function refreshSubmit() {
      submitBtn.disabled = picked.size === 0 ? '' : null;
      submitBtn.textContent = t('github.create-with', { n: picked.size });
    }

    fetch('/api/github/config', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        repos = (d.repos || []).map(slug => {
          const name = slug.split('/').pop();
          return { slug, name };
        });
        if (!repos.length) {
          checkboxesHost.replaceChildren(h('div', { class: 'muted' },
            t('github.repos.empty')));
          return;
        }
        repos.forEach(r => picked.add(r.name));
        checkboxesHost.replaceChildren(...repos.map(r => h('label',
          { class: 'github-pickrepos-row' },
          h('input', {
            type: 'checkbox', checked: '',
            onchange: (e) => {
              if (e.target.checked) picked.add(r.name);
              else picked.delete(r.name);
              refreshSubmit();
            },
          }),
          h('span', {}, r.name),
          h('span', { class: 'muted', style: { marginLeft: '0.4rem' } },
            r.slug),
        )));
        refreshSubmit();
      })
      .catch(() => {
        checkboxesHost.replaceChildren(h('div', { class: 'muted' },
          'failed to load repos'));
      });

    async function doCreate() {
      const reposList = Array.from(picked);
      submitBtn.disabled = '';
      submitBtn.textContent = '…';
      try {
        const r = await fetch('/api/issue/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issue: wsName, repos: reposList }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.status >= 400 || (r.status === 207 && (d.results || []).some(x => !x.ok))) {
          const fails = (d.results || []).filter(x => !x.ok)
            .map(x => `${x.repo || '·'}: ${x.message || x.action}`).join('; ');
          throw new Error(fails || d.error || `status ${r.status}`);
        }
        showToast('ok', `created ${wsName} (${reposList.length} repo${reposList.length === 1 ? '' : 's'})`);
        backdrop.remove();
        document.removeEventListener('keydown', escHandler);
        await refreshAll();
        loadGithub(false);
      } catch (err) {
        showToast('error', `create failed: ${err.message || err}`);
        refreshSubmit();
      }
    }
  }

  function githubActionsCell(existing, wsName, _it) {
    if (existing) {
      return h('td', {},
        h('button', {
          class: 'btn btn-inline btn-danger',
          title: t('github.action.remove-tip', { name: existing }),
          onclick: async () => {
            if (!window.confirm(`Remove workspace ${existing}?`)) return;
            try {
              const r = await fetch('/api/issue/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issue: existing }),
              });
              const d = await r.json().catch(() => ({}));
              // 207 Multi-Status means partial — surface the failures
              // instead of pretending it worked.
              if (r.status >= 400 || (r.status === 207 && (d.results || []).some(x => !x.ok))) {
                const fails = (d.results || [])
                  .filter(x => !x.ok)
                  .map(x => `${x.repo || '·'}: ${x.message || x.action}`)
                  .join('; ');
                throw new Error(fails || d.error || `status ${r.status}`);
              }
              showToast('ok', `removed ${existing}`);
              await refreshAll();
              loadGithub(false);
            } catch (err) {
              showToast('error', `remove failed: ${err.message || err}`);
            }
          },
        }, t('github.action.remove')));
    }
    return h('td', {},
      h('button', {
        class: 'btn btn-inline btn-primary',
        title: t('github.action.add-tip', { name: wsName }),
        onclick: () => openAddWorkspaceDialog(wsName, _it),
      }, t('github.action.add')));
  }

  // openAllEventsModal()      → unfiltered, every issue
  // openAllEventsModal(issue) → scoped to one issue (used by the tab badge)
  function openAllEventsModal(issueId = null) {
    if (allEventsModal.open) return;
    allEventsModal.open = true;
    allEventsModal.issue = issueId || null;
    // Reset filter state so a re-open doesn't carry over a stale
    // selection (e.g. issue A had Stop+Notification, issue B only has Stop).
    allEventsModal.filters.kinds = null;
    allEventsModal.filters.issueFilter = '';
    allEventsModal.filters.dateRange = 'today';
    const titleText = allEventsModal.issue
      ? `🔔 Agent events — ${allEventsModal.issue}`
      : '🔔 Agent events';
    const markReadTitle = allEventsModal.issue
      ? `Mark every unread event for ${allEventsModal.issue} read`
      : 'Mark every unread event read';
    const modal = h('div', { class: 'logs-modal-backdrop', id: 'all-events-modal' },
      h('div', { class: 'logs-modal week-modal',
                  role: 'dialog', 'aria-labelledby': 'all-events-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'all-events-title' }, titleText),
          h('span', { class: 'muted', id: 'all-events-meta' }, '· loading…'),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline',
                        id: 'all-events-mark-read-btn',
                        title: markReadTitle,
                        onclick: () => markAllEventsRead() }, '✓ Mark all read'),
          h('button', { class: 'btn btn-inline',
                        title: 'Re-fetch the list',
                        onclick: () => loadAllEvents() }, '↻ Refresh'),
          h('button', { class: 'btn btn-inline',
                        onclick: closeAllEventsModal }, '✕ Close'),
        ),
        h('div', { class: 'all-events-filters', id: 'all-events-filters' }),
        h('div', { class: 'week-body', id: 'all-events-body' },
          h('span', { class: 'muted' }, 'loading…')),
      ),
    );
    modal.addEventListener('click', closeAllEventsModal);
    document.body.append(modal);
    document.addEventListener('keydown', allEventsKeyHandler);
    loadAllEvents();
  }

  function closeAllEventsModal() {
    if (!allEventsModal.open) return;
    allEventsModal.open = false;
    allEventsModal.issue = null;
    document.getElementById('all-events-modal')?.remove();
    document.removeEventListener('keydown', allEventsKeyHandler);
  }

  function allEventsKeyHandler(e) {
    if (e.key === 'Escape') closeAllEventsModal();
  }

  async function loadAllEvents() {
    const body = document.getElementById('all-events-body');
    if (body) body.replaceChildren(h('span', { class: 'muted' }, 'loading…'));
    try {
      const url = allEventsModal.issue
        ? `/api/events?limit=500&issue=${encodeURIComponent(allEventsModal.issue)}`
        : '/api/events?limit=500';
      const r = await fetch(url, { cache: 'no-store' });
      const d = await r.json();
      const events = d.events || [];
      // Stash on the modal element so per-row mark-read can locate the
      // row and check whether the issue still has any other unread.
      const modal = document.getElementById('all-events-modal');
      if (modal) modal.__events = events;
      renderAllEvents(events);
    } catch (err) {
      if (body) body.replaceChildren(h('span', { class: 'muted' },
        'Failed to load: ' + err));
    }
  }

  function renderAllEvents(events) {
    const meta = document.getElementById('all-events-meta');
    const filters = document.getElementById('all-events-filters');
    const body = document.getElementById('all-events-body');
    if (!body) return;

    const unread = events.filter(e => !e.read_at).length;
    if (meta) meta.textContent = `· ${events.length} event${events.length !== 1 ? 's' : ''} · ${unread} unread`;

    // Build the kind filter chips — once we know what kinds are present.
    const kindCounts = {};
    for (const e of events) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
    const allKinds = Object.keys(kindCounts).sort();
    // Set of issues currently known to the dashboard. Events tagged with
    // an issue that isn't here came from a worktree the user no longer
    // has on disk (or never had — e.g. a hook firing from an unrelated
    // checkout) and the "hide no-issue" filter treats them the same as
    // events with no issue at all.
    const knownLiveIssues = new Set(
      (window.__lastState?.issues || []).map(i => i.issue));
    const isUnknownIssueEvent = e => !e.issue || !knownLiveIssues.has(e.issue);
    // Distinct issues for the issue dropdown (only in unscoped mode).
    // Restrict to issues that still exist on the dashboard so unknown
    // ones don't pollute the dropdown.
    const issueCounts = {};
    for (const e of events) {
      if (e.issue && knownLiveIssues.has(e.issue)) {
        issueCounts[e.issue] = (issueCounts[e.issue] || 0) + 1;
      }
    }
    const allIssues = Object.keys(issueCounts).sort();

    if (filters) {
      filters.replaceChildren();
      // Initialise the kinds filter to "all" the first time we see the data.
      if (allEventsModal.filters.kinds === null) {
        allEventsModal.filters.kinds = new Set(allKinds);
      }
      // Date-range chips (Today / 7d / 30d / All) — render first since
      // they're the most likely thing the user wants to change.
      const dateRanges = [
        { id: 'today', label: 'Today' },
        { id: '7d',    label: '7 days' },
        { id: '30d',   label: '30 days' },
        { id: 'all',   label: 'All' },
      ];
      for (const r of dateRanges) {
        filters.append(h('label', {
          class: 'log-chip log-chip-info'
                 + (allEventsModal.filters.dateRange === r.id ? ' on' : ''),
        },
          h('input', {
            type: 'radio', name: 'all-events-date-range',
            checked: allEventsModal.filters.dateRange === r.id ? '' : null,
            onchange: () => {
              allEventsModal.filters.dateRange = r.id;
              renderAllEvents(events);
            },
          }),
          r.label,
        ));
      }
      // Issue dropdown — only when the modal isn't already scoped to a
      // single issue. "All issues" is the default option.
      if (!allEventsModal.issue && allIssues.length > 0) {
        filters.append(h('span', {
          class: 'all-events-filter-divider', 'aria-hidden': 'true',
        }));
        filters.append(h('label', { class: 'all-events-issue-pick' },
          h('span', { class: 'muted' }, t('ui.issue-label')),
          h('select', {
            onchange: (ev) => {
              allEventsModal.filters.issueFilter = ev.target.value;
              renderAllEvents(events);
            },
          },
            h('option', {
              value: '',
              selected: allEventsModal.filters.issueFilter === '' ? '' : null,
            }, `All (${allIssues.length})`),
            ...allIssues.map(iss => h('option', {
              value: iss,
              selected: allEventsModal.filters.issueFilter === iss ? '' : null,
            }, `${iss} (${issueCounts[iss]})`)),
          ),
        ));
      }
      filters.append(h('span', {
        class: 'all-events-filter-divider', 'aria-hidden': 'true',
      }));
      // Kind chips.
      for (const k of allKinds) {
        const on = allEventsModal.filters.kinds.has(k);
        filters.append(h('label', {
          class: 'log-chip log-chip-info' + (on ? ' on' : ''),
        },
          h('input', {
            type: 'checkbox', checked: on ? '' : null,
            onchange: (ev) => {
              if (ev.target.checked) allEventsModal.filters.kinds.add(k);
              else allEventsModal.filters.kinds.delete(k);
              renderAllEvents(events);
            },
          }),
          `${k} (${kindCounts[k]})`,
        ));
      }
      filters.append(h('label', {
        class: 'log-chip log-chip-warn'
               + (allEventsModal.filters.unreadOnly ? ' on' : ''),
        style: { marginLeft: '0.6rem' },
      },
        h('input', {
          type: 'checkbox',
          checked: allEventsModal.filters.unreadOnly ? '' : null,
          onchange: (ev) => {
            allEventsModal.filters.unreadOnly = ev.target.checked;
            renderAllEvents(events);
          },
        }),
        'unread only',
      ));
      // Only offer the "hide no-issue" chip in the unfiltered view —
      // when scoped to one issue every event already has that issue.
      if (!allEventsModal.issue) {
        const hiddenCount = events.filter(isUnknownIssueEvent).length;
        filters.append(h('label', {
          class: 'log-chip log-chip-info'
                 + (allEventsModal.filters.hideNoIssue ? ' on' : ''),
          title: 'Hide events with no issue, and events tagged with an issue '
                 + 'that doesn\'t have a worktree on this dashboard',
        },
          h('input', {
            type: 'checkbox',
            checked: allEventsModal.filters.hideNoIssue ? '' : null,
            onchange: (ev) => {
              allEventsModal.filters.hideNoIssue = ev.target.checked;
              renderAllEvents(events);
            },
          }),
          `hide unknown-issue (${hiddenCount})`,
        ));
      }
    }

    // Apply filters.
    const wantKinds = allEventsModal.filters.kinds || new Set(allKinds);
    const cutoff = eventDateCutoffSeconds(allEventsModal.filters.dateRange);
    const issueFilter = allEventsModal.filters.issueFilter;
    const visible = events.filter(e =>
      wantKinds.has(e.kind)
      && (!allEventsModal.filters.unreadOnly || !e.read_at)
      && (!allEventsModal.filters.hideNoIssue || !isUnknownIssueEvent(e))
      && (cutoff === 0 || (e.created_at || 0) >= cutoff)
      && (!issueFilter || e.issue === issueFilter));

    if (!visible.length) {
      body.replaceChildren(h('div', { class: 'muted',
        style: { padding: '1rem' } },
        events.length === 0
          ? 'No agent events recorded yet. Run `./setup.sh --enable-claude-hooks` and Claude will start posting events.'
          : 'No events match the current filters.'));
      return;
    }

    const rows = visible.map(e => {
      const ts = new Date((e.created_at || 0) * 1000);
      // Inline ✓ button on each unread row marks just that event as read.
      const markBtn = e.read_at ? h('span', { class: 'muted' }, '—')
        : h('button', {
            class: 'btn btn-inline event-mark-read-btn', type: 'button',
            title: 'Mark this event read',
            onclick: async (ev) => {
              ev.stopPropagation();
              const ok = await markSingleEventRead(e.id);
              if (!ok) return;
              // Mutate the cached row so subsequent re-renders see it as
              // read, then re-render the modal in place.
              e.read_at = Math.floor(Date.now() / 1000);
              renderAllEvents(events);
            },
          }, '✓');
      // 🗑 — drop the row from the DB. Whatever the read state, this
      // is a hard delete; we ask once before firing.
      const delBtn = h('button', {
        class: 'btn btn-inline event-delete-btn', type: 'button',
        title: 'Delete this event',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm('Delete this event?')) return;
          const ok = await deleteSingleEvent(e.id, e);
          if (!ok) return;
          // Drop from the in-memory list and re-render. The same array
          // reference (`events`) is what's stashed on the modal so
          // subsequent operations stay consistent.
          const idx = events.indexOf(e);
          if (idx >= 0) events.splice(idx, 1);
          renderAllEvents(events);
        },
      }, '🗑');
      return h('tr', {
        class: e.read_at ? 'event-read' : 'event-unread',
      },
        h('td', { class: 'num muted' }, ts.toLocaleString()),
        h('td', {},
          h('span', { class: 'agent-message-kind kind-' + e.kind }, e.kind)),
        h('td', {},
          e.issue ? h('a', {
            href: '#tab-' + slugId(e.issue),
            class: 'event-issue-link',
            onclick: (ev) => {
              ev.preventDefault();
              closeAllEventsModal();
              focusIssueTab(e.issue);
              openAgentMessagesTab(e.issue);
            },
          }, e.issue === '__agent__' ? t('tab.generic-agent') : e.issue)
            : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'event-message' }, e.message
          || h('span', { class: 'muted' }, '(no message)')),
        h('td', { class: 'event-actions-cell' }, markBtn, delBtn),
      );
    });
    body.replaceChildren(h('div', { class: 'week-card' },
      h('table', { class: 'week-table all-events-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('evt.col.time')),
          h('th', {}, t('evt.col.kind')),
          h('th', {}, t('evt.col.issue')),
          h('th', {}, t('evt.col.message')),
          h('th', { 'aria-label': 'Actions' }, ''),
        )),
        h('tbody', {}, ...rows),
      ),
    ));
  }

  // POST mark-read for a single event id. Returns true on success and
  // updates the per-issue badge / cached count when this was the last
  // unread event for that issue.
  async function markSingleEventRead(eventId) {
    try {
      const r = await fetch(
        `/api/events/mark-read?id=${encodeURIComponent(eventId)}`,
        { method: 'POST' });
      if (!r.ok) return false;
      // Find the row in the modal's events array and the issue it
      // belongs to so we can update the tab badge cheaply.
      const modal = document.getElementById('all-events-modal');
      const cachedEvents = modal?.__events;
      if (!cachedEvents) return true;
      const evt = cachedEvents.find(x => x.id === eventId);
      if (!evt || !evt.issue) return true;
      const stillUnread = cachedEvents
        .some(x => x.issue === evt.issue && x.id !== eventId && !x.read_at);
      if (!stillUnread) {
        const badge = document.querySelector(
          `nav.tabs button[data-tab="tab-${slugId(evt.issue)}"] .pending-events-badge`);
        if (badge) badge.remove();
        const issueObj = (window.__lastState?.issues || []).find(
          i => i.issue === evt.issue);
        if (issueObj) {
          issueObj.pending_events = 0;
          issueObj.pending_events_by_kind = {};
        }
      } else {
        // One fewer unread for this issue — decrement the count if the
        // dashboard tracks the badge number.
        const issueObj = (window.__lastState?.issues || []).find(
          i => i.issue === evt.issue);
        if (issueObj && issueObj.pending_events > 0) {
          issueObj.pending_events -= 1;
          if (issueObj.pending_events_by_kind?.[evt.kind] > 0) {
            issueObj.pending_events_by_kind[evt.kind] -= 1;
          }
        }
        // Update the badge label in place.
        const badge = document.querySelector(
          `nav.tabs button[data-tab="tab-${slugId(evt.issue)}"] .pending-events-badge`);
        if (badge && issueObj) {
          badge.textContent = `🔔${filteredPendingFor(issueObj)}`;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Delete a single event from the DB. After the delete:
  //   - If the row was unread, decrement the issue's pending count.
  //   - Update / remove the per-tab 🔔 badge accordingly.
  // Caller is responsible for splicing the event out of any cached
  // arrays it holds.
  async function deleteSingleEvent(eventId, evt) {
    try {
      const r = await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
      if (!r.ok) {
        showToast('error', t('toast.delete-failed-short'));
        return false;
      }
      if (evt && evt.issue && !evt.read_at) {
        const issueObj = (window.__lastState?.issues || []).find(
          i => i.issue === evt.issue);
        if (issueObj && issueObj.pending_events > 0) {
          issueObj.pending_events -= 1;
          if (issueObj.pending_events_by_kind?.[evt.kind] > 0) {
            issueObj.pending_events_by_kind[evt.kind] -= 1;
          }
          const badge = document.querySelector(
            `nav.tabs button[data-tab="tab-${slugId(evt.issue)}"] .pending-events-badge`);
          if (badge) {
            const newCount = filteredPendingFor(issueObj);
            if (newCount === 0) badge.remove();
            else badge.textContent = `🔔${newCount}`;
          }
        }
      }
      return true;
    } catch (err) {
      showToast('error', t('toast.delete-failed', { err }));
      return false;
    }
  }

  // ── Notes modal (per-issue + cross-issue) ────────────────────────
  const NOTE_STATUSES = ['todo', 'done', 'not_done'];
  const NOTE_PRIORITIES = ['low', 'normal', 'high'];
  // priority rank for sorting (high → low)
  const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  function noteStatusLabel(s) { return t('notes.status.' + s); }
  function notePriorityLabel(p) { return t('notes.priority.' + p); }
  const NOTE_STATUS_LABELS = new Proxy({}, {
    get: (_, key) => noteStatusLabel(key),
  });
  const NOTE_PRIORITY_LABELS = new Proxy({}, {
    get: (_, key) => notePriorityLabel(key),
  });

  // Format a unix-seconds due timestamp into a "today / tomorrow /
  // overdue / N days" relative label. Returns { text, css } so the
  // caller can colour the cell appropriately.
  function formatDueDate(due_at) {
    if (!due_at) return { text: t('notes.due.cleared'), css: 'note-due-none' };
    const now = new Date();
    const due = new Date(due_at * 1000);
    // Day-resolution diff so "due today at 23:55 + now 23:50" reads as
    // "today", not "0d".
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const days = Math.round((b - a) / 86400000);
    const dateStr = due.toLocaleDateString();
    if (days < 0) {
      return { text: `${dateStr} · ${t('notes.due.overdue')} ${-days}d`,
               css: 'note-due-overdue' };
    }
    if (days === 0) return { text: t('notes.due.today'), css: 'note-due-today' };
    if (days === 1) return { text: t('notes.due.tomorrow'), css: 'note-due-soon' };
    if (days <= 7)  return { text: `${dateStr} · ${days}d`, css: 'note-due-soon' };
    return { text: dateStr, css: 'note-due-future' };
  }

  // YYYY-MM-DD ⇄ unix-seconds at local midnight. Used to roundtrip the
  // <input type="date"> in the add/edit dialog. Returns '' for null.
  function dueToInputValue(due_at) {
    if (!due_at) return '';
    const d = new Date(due_at * 1000);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function inputValueToDue(v) {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    if (!y || !m || !d) return null;
    return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
  }

  const notesModal = {
    open: false,
    issue: null,             // null when allMode is true
    allMode: false,          // cross-issue view (item 24)
    notes: [],
    // Filter state. Defaults: status = todo only (open work-items first),
    // priority/tag/search = wide open. Reset on every modal open.
    statusFilter: new Set(['todo']),
    priorityFilter: new Set(['low', 'normal', 'high']),
    activeTag: null,         // null = no tag filter; single tag string otherwise
    search: '',
    selected: new Set(),     // bulk-select: ids of selected notes
    editingId: null,
  };

  function openNotesModal(issueId, opts) {
    if (notesModal.open) closeNotesModal();
    notesModal.open = true;
    notesModal.allMode = !!(opts && opts.allMode);
    notesModal.issue = notesModal.allMode ? null : issueId;
    notesModal.editingId = null;
    notesModal.statusFilter = new Set(['todo']);
    notesModal.priorityFilter = new Set(['low', 'normal', 'high']);
    notesModal.activeTag = null;
    notesModal.search = '';
    notesModal.selected = new Set();

    const titleText = notesModal.allMode
      ? t('notes.title.all')
      : t('notes.title', { issue: issueId });

    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'notes-modal',
    },
      h('div', { class: 'logs-modal week-modal notes-modal-pane',
                  role: 'dialog', 'aria-labelledby': 'notes-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'notes-modal-title' }, titleText),
          h('span', { class: 'muted', id: 'notes-meta' }, '· loading…'),
          h('span', { style: { flex: '1' } }),
          h('button', {
            class: 'btn btn-inline',
            id: 'notes-mode-toggle',
            title: notesModal.allMode
              ? `Switch back to ${issueId || 'a single-issue'} view`
              : 'View notes from every issue in one place',
            onclick: () => {
              notesModal.allMode = !notesModal.allMode;
              notesModal.issue = notesModal.allMode ? null : issueId;
              const titleEl = document.getElementById('notes-modal-title');
              if (titleEl) {
                titleEl.textContent = notesModal.allMode
                  ? t('notes.title.all')
                  : t('notes.title', { issue: issueId });
              }
              const btn = document.getElementById('notes-mode-toggle');
              if (btn) {
                btn.textContent = notesModal.allMode
                  ? t('notes.this-button')
                  : t('notes.all-button');
              }
              notesModal.selected = new Set();
              loadNotes();
            },
          }, notesModal.allMode
              ? t('notes.this-button')
              : t('notes.all-button')),
          h('button', { class: 'btn btn-inline',
                        onclick: () => openAddNoteDialog(
                          notesModal.allMode ? null : issueId) },
            t('notes.add-button')),
          h('button', { class: 'btn btn-inline',
                        onclick: closeNotesModal }, t('notes.close-button')),
        ),
        h('div', { class: 'notes-search-row' },
          h('input', {
            type: 'search', class: 'notes-search-input',
            id: 'notes-search-input',
            placeholder: t('notes.search.placeholder'),
            autocomplete: 'off',
            oninput: (e) => {
              notesModal.search = e.target.value;
              renderNotes();
            },
          }),
          // Issue picker — narrows the list to one issue (or
          // General Agent). Empty value = all issues. Works in
          // both modes; selecting a value flips allMode off and
          // refetches; clearing flips it back on.
          (() => {
            const issues = (window.__lastState?.issues || [])
              .map((i) => i.issue)
              .sort((a, b) => a.localeCompare(b));
            return h('select', {
              class: 'notes-issue-filter', id: 'notes-issue-filter',
              onchange: (e) => {
                const v = e.target.value || '';
                notesModal.allMode = !v;
                notesModal.issue = v || null;
                notesModal.selected = new Set();
                const titleEl = document.getElementById(
                  'notes-modal-title');
                if (titleEl) {
                  const label = v === '__agent__'
                    ? t('tab.generic-agent') : v;
                  titleEl.textContent = v
                    ? t('notes.title', { issue: label })
                    : t('notes.title.all');
                }
                loadNotes();
              },
            },
              h('option', { value: '',
                ...(notesModal.allMode ? { selected: '' } : {}) },
                t('notes.title.all')),
              h('option', { value: '__agent__',
                ...(notesModal.issue === '__agent__'
                    ? { selected: '' } : {}) },
                t('tab.generic-agent')),
              ...issues.map((id) => h('option', {
                value: id,
                ...(notesModal.issue === id
                    ? { selected: '' } : {}),
              }, id)),
            );
          })(),
        ),
        h('div', { class: 'all-events-filters', id: 'notes-filters' }),
        h('div', { id: 'notes-bulk-bar', class: 'notes-bulk-bar',
                    style: { display: 'none' } }),
        h('div', { class: 'week-body', id: 'notes-body' },
          h('span', { class: 'muted' }, 'loading…')),
      ),
    );
    modal.addEventListener('click', closeNotesModal);
    document.body.append(modal);
    document.addEventListener('keydown', notesKeyHandler);
    loadNotes();
  }

  function closeNotesModal() {
    if (!notesModal.open) return;
    notesModal.open = false;
    notesModal.editingId = null;
    document.getElementById('notes-modal')?.remove();
    document.removeEventListener('keydown', notesKeyHandler);
  }

  function notesKeyHandler(e) {
    if (e.key === 'Escape') closeNotesModal();
  }

  async function loadNotes() {
    const body = document.getElementById('notes-body');
    if (body) body.replaceChildren(h('span', { class: 'muted' }, 'loading…'));
    try {
      const url = notesModal.allMode
        ? '/api/notes'
        : `/api/notes?issue=${encodeURIComponent(notesModal.issue)}`;
      const r = await fetch(url, { cache: 'no-store' });
      const d = await r.json();
      notesModal.notes = d.notes || [];
      // Drop stale selections — re-rendering can shrink the list.
      const liveIds = new Set(notesModal.notes.map(n => n.id));
      for (const id of [...notesModal.selected]) {
        if (!liveIds.has(id)) notesModal.selected.delete(id);
      }
      renderNotes();
    } catch (err) {
      if (body) body.replaceChildren(
        h('span', { class: 'muted' }, t('ui.load-failed', { err })));
    }
  }

  // Decide if a note passes the current search box. Matches across
  // content, tags, assignee, and issue so the user can find notes by
  // any of the visible facets without remembering which column it's in.
  function noteMatchesSearch(n, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    if ((n.content || '').toLowerCase().includes(needle)) return true;
    if ((n.assignee || '').toLowerCase().includes(needle)) return true;
    if ((n.issue || '').toLowerCase().includes(needle)) return true;
    for (const tag of (n.tags || [])) {
      if (String(tag).toLowerCase().includes(needle)) return true;
    }
    return false;
  }

  function renderNotes() {
    const meta = document.getElementById('notes-meta');
    const filters = document.getElementById('notes-filters');
    const body = document.getElementById('notes-body');
    if (!body) return;

    const statusCounts = { todo: 0, done: 0, not_done: 0 };
    const priorityCounts = { low: 0, normal: 0, high: 0 };
    const tagCounts = new Map();
    for (const n of notesModal.notes) {
      if (statusCounts[n.status] !== undefined) statusCounts[n.status]++;
      const p = n.priority || 'normal';
      if (priorityCounts[p] !== undefined) priorityCounts[p]++;
      for (const tag of (n.tags || [])) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    if (meta) {
      const total = notesModal.notes.length;
      meta.textContent = `· ${total} note${total !== 1 ? 's' : ''} · ${
        statusCounts.todo} todo`;
    }

    // Filter chip rows: status, priority, then tags (clickable, single-
    // active). Tags get an inline "✕ clear" when one is active.
    if (filters) {
      filters.replaceChildren();
      const statusRow = h('div', { class: 'notes-filter-row' });
      for (const st of NOTE_STATUSES) {
        const on = notesModal.statusFilter.has(st);
        statusRow.append(h('label', {
          class: `log-chip note-chip-${st}` + (on ? ' on' : ''),
        },
          h('input', {
            type: 'checkbox', checked: on ? '' : null,
            onchange: (ev) => {
              if (ev.target.checked) notesModal.statusFilter.add(st);
              else notesModal.statusFilter.delete(st);
              renderNotes();
            },
          }),
          `${NOTE_STATUS_LABELS[st]} (${statusCounts[st]})`,
        ));
      }
      filters.append(statusRow);

      const priRow = h('div', { class: 'notes-filter-row' });
      for (const p of NOTE_PRIORITIES) {
        const on = notesModal.priorityFilter.has(p);
        priRow.append(h('label', {
          class: `log-chip note-pri-${p}` + (on ? ' on' : ''),
        },
          h('input', {
            type: 'checkbox', checked: on ? '' : null,
            onchange: (ev) => {
              if (ev.target.checked) notesModal.priorityFilter.add(p);
              else notesModal.priorityFilter.delete(p);
              renderNotes();
            },
          }),
          `${NOTE_PRIORITY_LABELS[p]} (${priorityCounts[p]})`,
        ));
      }
      filters.append(priRow);

      if (tagCounts.size > 0 || notesModal.activeTag) {
        const tagRow = h('div', { class: 'notes-filter-row notes-tag-row' });
        // Sort tags by frequency desc, then name.
        const sortedTags = [...tagCounts.entries()].sort(
          (a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
        for (const [tag, count] of sortedTags) {
          const on = notesModal.activeTag === tag;
          tagRow.append(h('button', {
            class: 'log-chip note-tag-chip' + (on ? ' on' : ''),
            type: 'button',
            onclick: () => {
              notesModal.activeTag = on ? null : tag;
              renderNotes();
            },
          }, `#${tag} (${count})`));
        }
        if (notesModal.activeTag) {
          tagRow.append(h('button', {
            class: 'btn btn-inline notes-tag-clear', type: 'button',
            onclick: () => {
              notesModal.activeTag = null;
              renderNotes();
            },
          }, t('notes.clear-tag')));
        }
        filters.append(tagRow);
      }
    }

    const visible = notesModal.notes.filter(n => {
      if (!notesModal.statusFilter.has(n.status)) return false;
      if (!notesModal.priorityFilter.has(n.priority || 'normal')) return false;
      if (notesModal.activeTag
          && !(n.tags || []).includes(notesModal.activeTag)) {
        return false;
      }
      if (!noteMatchesSearch(n, notesModal.search.trim())) return false;
      return true;
    });

    renderBulkBar(visible);

    if (!visible.length) {
      body.replaceChildren(h('div', { class: 'muted',
        style: { padding: '1rem' } },
        notesModal.notes.length === 0
          ? t('notes.empty')
          : t('notes.empty-filtered')));
      return;
    }

    // Sort. The persisted sort key under table-sort-notes is one of:
    // 'created_at', 'status', 'priority', 'due_at', 'assignee',
    // 'content', or 'manual' (drag-drop-driven, using note.sort_order).
    const sortState = loadTableSort('notes');
    const sorted = sortNotes(visible, sortState);
    const onResort = (next) => {
      saveTableSort('notes', next);
      renderNotes();
    };

    const allVisibleSelected = sorted.every(
      n => notesModal.selected.has(n.id));
    const someSelected = sorted.some(n => notesModal.selected.has(n.id));
    const selAllCb = h('input', {
      type: 'checkbox',
      checked: allVisibleSelected ? '' : null,
      onchange: (ev) => {
        if (ev.target.checked) {
          for (const n of sorted) notesModal.selected.add(n.id);
        } else {
          for (const n of sorted) notesModal.selected.delete(n.id);
        }
        renderNotes();
      },
    });
    // Tri-state visual: indeterminate when some-but-not-all selected.
    selAllCb.indeterminate = someSelected && !allVisibleSelected;

    const manualSort = sortState.key === 'manual';
    const headerCells = [
      h('th', { class: 'notes-sel-col' }, selAllCb),
      h('th', { class: 'notes-drag-col',
                title: manualSort ? 'Drag to reorder' : 'Manual sort off' },
        manualSort ? '⋮⋮' : ''),
    ];
    if (notesModal.allMode) {
      headerCells.push(sortableTh(
        t('notes.col.issue'), 'issue', sortState, onResort));
    }
    headerCells.push(
      sortableTh(t('notes.col.created'),  'created_at', sortState, onResort),
      sortableTh(t('notes.col.priority'), 'priority',   sortState, onResort),
      sortableTh(t('notes.col.status'),   'status',     sortState, onResort),
      sortableTh(t('notes.col.due'),      'due_at',     sortState, onResort),
      sortableTh(t('notes.col.assignee'), 'assignee',   sortState, onResort),
      sortableTh(t('notes.col.tags'),     'tags',       sortState, onResort),
      sortableTh(t('notes.col.note'),     'content',    sortState, onResort),
      // 4th sort option for the "Manual" mode lives on the Actions
      // column header so it doesn't crowd the data columns.
      h('th', { class: 'notes-actions-col' },
        h('button', {
          class: 'btn-inline notes-manual-toggle'
                  + (manualSort ? ' on' : ''),
          type: 'button',
          title: 'Manual sort — drag rows to reorder',
          onclick: () => {
            if (manualSort) {
              saveTableSort('notes',
                { key: 'created_at', dir: 'desc' });
            } else {
              saveTableSort('notes', { key: 'manual', dir: 'asc' });
            }
            renderNotes();
          },
        }, manualSort ? '✓ ' + t('notes.sort.manual')
                       : t('notes.sort.manual')),
      ),
    );

    const rows = sorted.map((n, i) => noteRow(n, i, sorted, manualSort));
    body.replaceChildren(h('div', { class: 'week-card' },
      h('table', { class: 'week-table notes-table'
                          + (manualSort ? ' notes-table-manual' : '')
                          + (notesModal.allMode ? ' notes-table-all' : '') },
        h('thead', {}, h('tr', {}, ...headerCells)),
        h('tbody', {}, ...rows),
      ),
    ));
  }

  // Sort applied AFTER filters. Custom for 'priority' (rank-ordered)
  // and 'manual' (sort_order asc, NULLs after); 'tags' compares the
  // joined string; everything else falls through to sortRowsBy.
  function sortNotes(notes, sortState) {
    if (sortState.key === 'manual') {
      return [...notes].sort((a, b) => {
        const ao = a.sort_order, bo = b.sort_order;
        const aNil = ao == null, bNil = bo == null;
        if (aNil && bNil) return (b.created_at || 0) - (a.created_at || 0);
        if (aNil) return 1;
        if (bNil) return -1;
        return ao - bo;
      });
    }
    return sortRowsBy(notes, sortState, {
      issue:      n => n.issue || '',
      created_at: n => n.created_at || 0,
      status:     n => n.status || '',
      priority:   n => PRIORITY_RANK[n.priority || 'normal'] ?? 1,
      due_at:     n => n.due_at == null ? Infinity : n.due_at,
      assignee:   n => (n.assignee || '').toLowerCase(),
      tags:       n => (n.tags || []).join(',').toLowerCase(),
      content:    n => n.content || '',
    });
  }

  function renderBulkBar(visible) {
    const bar = document.getElementById('notes-bulk-bar');
    if (!bar) return;
    if (notesModal.selected.size === 0) {
      bar.style.display = 'none';
      bar.replaceChildren();
      return;
    }
    bar.style.display = '';
    bar.replaceChildren(
      h('span', { class: 'notes-bulk-count' },
        t('notes.bulk.selected', { count: notesModal.selected.size })),
      h('button', { class: 'btn btn-inline', type: 'button',
        onclick: () => bulkDeleteSelected() },
        '🗑 ' + t('notes.bulk.delete')),
      h('label', { class: 'notes-bulk-control' },
        t('notes.bulk.status') + ' ',
        h('select', {
          onchange: (e) => {
            const v = e.target.value;
            e.target.value = '';
            if (v) bulkSetSelected({ status: v });
          },
        },
          h('option', { value: '' }, '—'),
          ...NOTE_STATUSES.map(s => h('option', { value: s },
            NOTE_STATUS_LABELS[s])),
        ),
      ),
      h('label', { class: 'notes-bulk-control' },
        t('notes.bulk.priority') + ' ',
        h('select', {
          onchange: (e) => {
            const v = e.target.value;
            e.target.value = '';
            if (v) bulkSetSelected({ priority: v });
          },
        },
          h('option', { value: '' }, '—'),
          ...NOTE_PRIORITIES.map(p => h('option', { value: p },
            NOTE_PRIORITY_LABELS[p])),
        ),
      ),
      h('button', { class: 'btn btn-inline', type: 'button',
        onclick: () => {
          notesModal.selected = new Set();
          renderNotes();
        } }, t('notes.bulk.clear')),
    );
  }

  async function bulkDeleteSelected() {
    const ids = [...notesModal.selected];
    if (!ids.length) return;
    const msg = t('notes.bulk-delete-confirm',
      { count: ids.length, plural: ids.length === 1 ? '' : 's' });
    if (!confirm(msg)) return;
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/notes/${id}`, { method: 'DELETE' })
        .then(r => ({ id, ok: r.ok }))
        .catch(() => ({ id, ok: false }))));
    const failed = results.filter(r => !r.ok).length;
    if (failed) showToast('error', `${failed} delete${failed !== 1 ? 's' : ''} failed`);
    else        showToast('ok', `✓ ${ids.length} deleted`);
    notesModal.selected = new Set();
    await loadNotes();
    refreshAll(true);
  }

  async function bulkSetSelected(patch) {
    const ids = [...notesModal.selected];
    if (!ids.length) return;
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(r => ({ id, ok: r.ok }))
        .catch(() => ({ id, ok: false }))));
    const failed = results.filter(r => !r.ok).length;
    if (failed) showToast('error', `${failed} update${failed !== 1 ? 's' : ''} failed`);
    else        showToast('ok', `✓ ${ids.length} updated`);
    await loadNotes();
    refreshAll(true);
  }

  function noteRow(n, idx, sortedList, manualSort) {
    const ts = new Date((n.created_at || 0) * 1000).toLocaleString();

    const selCb = h('input', {
      type: 'checkbox',
      checked: notesModal.selected.has(n.id) ? '' : null,
      onchange: (ev) => {
        if (ev.target.checked) notesModal.selected.add(n.id);
        else notesModal.selected.delete(n.id);
        renderNotes();
      },
    });

    // Status selector — same pattern as the original implementation.
    const statusSelect = h('select', {
      class: `note-status-select note-status-${n.status}`,
      title: t('notes.change-status'),
      onchange: async (ev) => {
        const newStatus = ev.target.value;
        if (newStatus === n.status) return;
        const ok = await saveNoteField(n.id, { status: newStatus });
        if (ok) {
          n.status = newStatus;
          ev.target.className =
            `note-status-select note-status-${newStatus}`;
          renderNotes();
        }
      },
    },
      ...NOTE_STATUSES.map(st => h('option', {
        value: st, selected: st === n.status ? '' : null,
      }, NOTE_STATUS_LABELS[st])));

    // Priority selector.
    const prio = n.priority || 'normal';
    const prioritySelect = h('select', {
      class: `note-priority-select note-pri-${prio}`,
      title: t('notes.change-priority'),
      onchange: async (ev) => {
        const newPriority = ev.target.value;
        if (newPriority === n.priority) return;
        const ok = await saveNoteField(n.id, { priority: newPriority });
        if (ok) {
          n.priority = newPriority;
          ev.target.className =
            `note-priority-select note-pri-${newPriority}`;
          renderNotes();
        }
      },
    },
      ...NOTE_PRIORITIES.map(p => h('option', {
        value: p, selected: p === prio ? '' : null,
      }, NOTE_PRIORITY_LABELS[p])));

    // Due date — native date input. Empty value clears the due date.
    const dueInput = h('input', {
      type: 'date',
      class: 'note-due-input',
      value: dueToInputValue(n.due_at),
      onchange: async (ev) => {
        const v = inputValueToDue(ev.target.value);
        const ok = await saveNoteField(n.id, { due_at: v });
        if (ok) {
          n.due_at = v;
          renderNotes();
        }
      },
    });
    const due = formatDueDate(n.due_at);

    // Assignee — small text input. Defaults to placeholder when empty.
    const assigneeInput = h('input', {
      type: 'text',
      class: 'note-assignee-input',
      placeholder: t('notes.assignee.placeholder'),
      value: n.assignee || '',
    });
    let assigneeOriginal = n.assignee || '';
    assigneeInput.addEventListener('blur', async () => {
      const next = assigneeInput.value.trim();
      if (next === assigneeOriginal) return;
      const ok = await saveNoteField(n.id, { assignee: next || null });
      if (ok) {
        n.assignee = next || null;
        assigneeOriginal = next;
      } else {
        assigneeInput.value = assigneeOriginal;
      }
    });
    assigneeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') assigneeInput.blur();
      else if (ev.key === 'Escape') {
        assigneeInput.value = assigneeOriginal;
        assigneeInput.blur();
      }
    });

    // Tags — comma-separated input, committed on blur / Enter.
    // (Click-to-filter is still available via the tag chips in the
    // filter row above the table, so we don't duplicate them here.)
    const tagInput = h('input', {
      type: 'text',
      class: 'note-tags-input',
      placeholder: t('notes.tags.placeholder'),
      value: (n.tags || []).join(', '),
    });
    let tagsOriginal = (n.tags || []).join(', ');
    tagInput.addEventListener('blur', async () => {
      const next = tagInput.value.trim();
      if (next === tagsOriginal) return;
      const arr = next.split(',').map(s => s.trim()).filter(Boolean);
      const ok = await saveNoteField(n.id, { tags: arr });
      if (ok) {
        // Re-read from the API on next load to pick up normalised tags.
        await loadNotes();
      } else {
        tagInput.value = tagsOriginal;
      }
    });
    tagInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') tagInput.blur();
      else if (ev.key === 'Escape') {
        tagInput.value = tagsOriginal;
        tagInput.blur();
      }
    });

    // Content cell: contenteditable so the user types directly into
    // the row. Esc reverts; blur saves if text changed.
    const editor = h('div', {
      class: 'note-content-edit',
      contenteditable: 'plaintext-only',
      'data-note-id': String(n.id),
      title: t('notes.click-to-edit'),
    }, n.content);
    const original = n.content;
    editor.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        editor.textContent = original;
        editor.blur();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        editor.blur();   // Ctrl/Cmd-Enter saves
      }
    });
    editor.addEventListener('blur', async () => {
      const next = editor.textContent.trim();
      if (next === original) return;
      if (!next) {
        editor.textContent = original;
        showToast('warn', t('notes.empty-warn'));
        return;
      }
      const ok = await saveNoteField(n.id, { content: next });
      if (ok) n.content = next;
      else editor.textContent = original;
    });

    // The first column is also the drag handle when manual-sort is
    // active. Drag events bubble up to the row; we set draggable on
    // the <tr> directly so the user can grab any blank space.
    const rowAttrs = { class: 'note-row' };
    if (manualSort) {
      rowAttrs.draggable = 'true';
      rowAttrs['data-note-id'] = String(n.id);
      rowAttrs.ondragstart = (ev) => {
        ev.dataTransfer.setData('text/plain', String(n.id));
        ev.dataTransfer.effectAllowed = 'move';
        ev.currentTarget.classList.add('note-row-dragging');
      };
      rowAttrs.ondragend = (ev) => {
        ev.currentTarget.classList.remove('note-row-dragging');
        document.querySelectorAll('.note-row-drop-target')
          .forEach(el => el.classList.remove('note-row-drop-target'));
      };
      rowAttrs.ondragover = (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        ev.currentTarget.classList.add('note-row-drop-target');
      };
      rowAttrs.ondragleave = (ev) => {
        ev.currentTarget.classList.remove('note-row-drop-target');
      };
      rowAttrs.ondrop = async (ev) => {
        ev.preventDefault();
        ev.currentTarget.classList.remove('note-row-drop-target');
        const srcId = parseInt(ev.dataTransfer.getData('text/plain'), 10);
        if (!srcId || srcId === n.id) return;
        await reorderNote(srcId, n.id, sortedList);
      };
    }

    const cells = [
      h('td', { class: 'notes-sel-col' }, selCb),
      h('td', { class: 'notes-drag-col' }, manualSort ? '⋮⋮' : ''),
    ];
    if (notesModal.allMode) {
      // Render `__agent__` as "General Agent" — same friendly
      // label the rest of the UI uses (Messages pane, tab strip).
      // The actual DB column still stores the sentinel.
      const issueLabel = n.issue === '__agent__'
        ? t('tab.generic-agent') : n.issue;
      cells.push(h('td', { class: 'notes-issue-col' },
        h('button', {
          class: 'btn-inline note-issue-link', type: 'button',
          title: `Switch to ${issueLabel}-only view`,
          onclick: () => {
            notesModal.allMode = false;
            notesModal.issue = n.issue;
            notesModal.selected = new Set();
            const titleEl = document.getElementById('notes-modal-title');
            if (titleEl) titleEl.textContent = t('notes.title',
              { issue: issueLabel });
            const btn = document.getElementById('notes-mode-toggle');
            if (btn) btn.textContent = t('notes.all-button');
            loadNotes();
          },
        }, issueLabel)));
    }
    cells.push(
      h('td', { class: 'num muted' }, ts),
      h('td', {}, prioritySelect),
      h('td', {}, statusSelect),
      h('td', { class: due.css, title: due.text }, dueInput),
      h('td', {}, assigneeInput),
      h('td', { class: 'notes-tags-col' }, tagInput),
      h('td', { class: 'note-content' }, editor),
      h('td', { class: 'notes-actions-cell' },
        h('button', { class: 'btn btn-inline', title: t('notes.delete-tip'),
          onclick: async () => {
            if (!confirm(t('notes.delete-confirm'))) return;
            const ok = await deleteNote(n.id);
            if (ok) await loadNotes();
          },
        }, '🗑'),
      ),
    );
    return h('tr', rowAttrs, ...cells);
  }

  // Move srcId to just before targetId in the manual order. Compute a
  // new sort_order between the target's previous neighbour and the
  // target itself (so neighbours don't have to be touched). When the
  // target is the head, use targetOrder - 1.
  async function reorderNote(srcId, targetId, sortedList) {
    if (srcId === targetId) return;
    const without = sortedList.filter(n => n.id !== srcId);
    const targetIdx = without.findIndex(n => n.id === targetId);
    if (targetIdx < 0) return;
    const target = without[targetIdx];
    const before = without[targetIdx - 1];
    // Treat missing sort_order as the row's index — gives the first
    // drag-and-drop a sensible starting baseline rather than NaN.
    const targetOrder = target.sort_order != null
      ? target.sort_order : targetIdx + 1;
    const beforeOrder = before
      ? (before.sort_order != null ? before.sort_order : targetIdx)
      : targetOrder - 1;
    const newOrder = (beforeOrder + targetOrder) / 2;
    const ok = await saveNoteField(srcId, { sort_order: newOrder });
    if (ok) await loadNotes();
  }

  async function saveNoteField(noteId, patch) {
    try {
      const r = await fetch(`/api/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        showToast('error', d.error || t('notes.error.save-failed'));
        return false;
      }
      // Refresh top-level state so the per-tab badge re-derives.
      refreshAll(true);
      return true;
    } catch (err) {
      showToast('error', t('notes.error.save-failed') + ': ' + err);
      return false;
    }
  }

  // Back-compat shim — older call sites elsewhere in the file used
  // saveNoteEdit(noteId, content, status). Keep them working without
  // rewriting every caller.
  async function saveNoteEdit(noteId, content, status) {
    const patch = {};
    if (content !== null && content !== undefined) patch.content = content;
    if (status !== null && status !== undefined) patch.status = status;
    return saveNoteField(noteId, patch);
  }

  async function deleteNote(noteId) {
    try {
      const r = await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
      if (!r.ok) { showToast('error', t('notes.error.delete-failed')); return false; }
      refreshAll(true);
      return true;
    } catch (err) {
      showToast('error', t('notes.error.delete-failed') + ': ' + err);
      return false;
    }
  }

  // ── Tiny markdown renderer ────────────────────────────────────────
  // Just enough to render the project's README inline (headings, code
  // fences, inline code, bold/italic, links, lists, tables, paragraphs).
  // No third-party deps — keeps the dashboard offline-friendly.
  function renderMarkdownInline(text) {
    // Inline pass: code → links → bold → italic → plain text. Returns
    // an array of DOM nodes / strings to append to a parent.
    const out = [];
    let i = 0;
    const push = (node) => out.push(node);
    while (i < text.length) {
      // Inline `code`
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          push(h('code', {}, text.slice(i + 1, end)));
          i = end + 1; continue;
        }
      }
      // Link [text](url)
      if (text[i] === '[') {
        const close = text.indexOf(']', i + 1);
        if (close !== -1 && text[close + 1] === '(') {
          const urlEnd = text.indexOf(')', close + 2);
          if (urlEnd !== -1) {
            const label = text.slice(i + 1, close);
            const url   = text.slice(close + 2, urlEnd);
            push(h('a', { href: url, target: '_blank',
                          rel: 'noopener noreferrer' },
                  ...renderMarkdownInline(label)));
            i = urlEnd + 1; continue;
          }
        }
      }
      // **bold**
      if (text[i] === '*' && text[i + 1] === '*') {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) {
          push(h('strong', {}, ...renderMarkdownInline(text.slice(i + 2, end))));
          i = end + 2; continue;
        }
      }
      // *italic* — only when preceded by start/space and the closing
      // star isn't directly preceded by whitespace. Avoids capturing
      // `2 * 3` style usage; markdown spec is more nuanced but this
      // covers the patterns in our docs.
      if (text[i] === '*' && (i === 0 || /\s/.test(text[i - 1]))) {
        const end = text.indexOf('*', i + 1);
        if (end !== -1 && end > i + 1 && !/\s/.test(text[end - 1])) {
          push(h('em', {}, ...renderMarkdownInline(text.slice(i + 1, end))));
          i = end + 1; continue;
        }
      }
      // Plain run — read until next inline marker.
      let j = i;
      while (j < text.length
             && text[j] !== '`'
             && !(text[j] === '[' && /[^\s]/.test(text[j + 1] || ''))
             && !(text[j] === '*')) {
        j++;
      }
      if (j === i) { push(text[i]); i++; }
      else { push(text.slice(i, j)); i = j; }
    }
    return out;
  }

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;

    const flushPara = (buf) => {
      if (!buf.length) return;
      frag.appendChild(h('p', {},
        ...renderMarkdownInline(buf.join(' '))));
    };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]); i++;
        }
        if (i < lines.length) i++; // consume closing fence
        const pre = h('pre', { class: 'md-code' },
          h('code', { class: lang ? `language-${lang}` : null },
            codeLines.join('\n')));
        frag.appendChild(pre);
        continue;
      }

      // Heading
      const hMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (hMatch) {
        const level = hMatch[1].length;
        frag.appendChild(h('h' + level, {},
          ...renderMarkdownInline(hMatch[2])));
        i++;
        continue;
      }

      // Table — header row, separator, then body until blank.
      if (/^\s*\|.+\|\s*$/.test(line)
          && i + 1 < lines.length
          && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const splitRow = (s) => s.trim()
          .replace(/^\|/, '').replace(/\|$/, '')
          // Protect escaped pipes (\|) before splitting on real column separators,
          // then restore them as literal | characters in each cell.
          .replace(/\\\|/g, '\x00')
          .split('|')
          .map(c => c.trim().replace(/\x00/g, '|'));
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i])); i++;
        }
        frag.appendChild(h('div', { class: 'table-scroll-wrap' },
          h('table', { class: 'md-table' },
            h('thead', {}, h('tr', {},
              ...headers.map(c => h('th', {}, ...renderMarkdownInline(c))))),
            h('tbody', {},
              ...rows.map(r => h('tr', {},
                ...r.map(c => h('td', {}, ...renderMarkdownInline(c)))))),
          ),
        ));
        continue;
      }

      // List (unordered or ordered) — accumulate consecutive items.
      const ulMatch = /^([-*+])\s+(.*)$/.exec(line);
      const olMatch = /^(\d+)\.\s+(.*)$/.exec(line);
      if (ulMatch || olMatch) {
        const ordered = !!olMatch;
        const items = [];
        while (i < lines.length) {
          const m = ordered
            ? /^(\d+)\.\s+(.*)$/.exec(lines[i])
            : /^([-*+])\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          const itemText = [m[2]];
          i++;
          // Continuation lines: indented, not a new item, not blank.
          while (i < lines.length
                 && /^\s+\S/.test(lines[i])
                 && !/^([-*+])\s+/.test(lines[i].trimStart())
                 && !/^(\d+)\.\s+/.test(lines[i].trimStart())) {
            itemText.push(lines[i].trim());
            i++;
          }
          items.push(itemText.join(' '));
        }
        frag.appendChild(h(ordered ? 'ol' : 'ul', {},
          ...items.map(t => h('li', {}, ...renderMarkdownInline(t)))));
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) { i++; continue; }

      // Paragraph — collect contiguous non-special lines.
      const buf = [line];
      i++;
      while (i < lines.length
             && !/^\s*$/.test(lines[i])
             && !/^#{1,6}\s/.test(lines[i])
             && !/^```/.test(lines[i])
             && !/^([-*+])\s+/.test(lines[i])
             && !/^\d+\.\s+/.test(lines[i])
             && !/^\s*\|.+\|\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      flushPara(buf);
    }
    return frag;
  }

  // ── Help overlay ──────────────────────────────────────────────────
  // Single-modal help screen. Lists keyboard shortcuts, the main
  // toolbar controls, and the project README rendered inline. Opened
  // via the toolbar `?` button or the `?` keyboard shortcut.
  function openHelpOverlay() {
    if (document.getElementById('help-overlay')) return;
    const close = () => closeHelpOverlay();
    const shortcuts = [
      { keys: ['r'],              label: t('help.shortcut.refresh') },
      { keys: ['n'],              label: t('help.shortcut.new-issue') },
      { keys: ['/'],              label: t('help.shortcut.search') },
      { keys: ['?'],              label: t('help.shortcut.help') },
      { keys: ['Esc'],            label: t('help.shortcut.dismiss') },
      { keys: ['Ctrl', 'F'],      label: t('help.shortcut.term-search') },
    ];

    // Tab 1 — Quick info: shortcuts, features, link to AGENTS.md.
    const quickPane = h('div', { class: 'help-tab-pane', id: 'help-pane-quick' },
      h('h3', {}, t('help.section.shortcuts')),
      h('table', { class: 'help-shortcuts' },
        h('tbody', {},
          ...shortcuts.map(s => h('tr', {},
            h('td', { class: 'help-keys' },
              ...s.keys.map(k => h('kbd', {}, k))),
            h('td', {}, s.label),
          )),
        ),
      ),
      h('h3', {}, t('help.section.features')),
      h('ul', { class: 'help-features' },
        h('li', {}, t('help.feat.tabs')),
        h('li', {}, t('help.feat.bell')),
        h('li', {}, t('help.feat.notes')),
        h('li', {}, t('help.feat.console')),
        h('li', {}, t('help.feat.git-ops')),
        h('li', {}, t('help.feat.themes')),
      ),
      h('p', { class: 'help-docs-blurb' }, t('help.docs-blurb'), ' ',
        h('a', { href: '/static/AGENTS.md',
                  target: '_blank', rel: 'noopener noreferrer' },
          'AGENTS.md'),
        '.',
      ),
    );

    // Tab 2 — Claude workspace: README rendered inline.
    const workspacePane = h('div', {
      class: 'help-tab-pane', id: 'help-pane-workspace', hidden: '' },
      h('div', { id: 'help-readme', class: 'md-rendered' },
        h('span', { class: 'muted' }, t('ui.loading-readme'))),
    );

    // Tab 3 — API: Routes section of README.
    const apiPane = h('div', {
      class: 'help-tab-pane api-tab-pane', id: 'help-pane-api', hidden: '' },
      h('div', { id: 'help-api-routes', class: 'md-rendered' },
        h('span', { class: 'muted' }, t('ui.loading-readme'))),
    );

    const tabs = [
      { id: 'quick',     label: t('help.tab.quick'),     pane: quickPane },
      { id: 'workspace', label: t('help.tab.workspace'), pane: workspacePane },
      { id: 'api',       label: t('help.tab.api'),       pane: apiPane },
    ];
    let activeTabId = 'quick';
    const tabButtons = tabs.map(tab => h('button', {
      class: 'help-tab-btn' + (tab.id === activeTabId ? ' active' : ''),
      type: 'button',
      role: 'tab',
      'aria-selected': tab.id === activeTabId ? 'true' : 'false',
      'aria-controls': `help-pane-${tab.id}`,
      onclick: () => {
        activeTabId = tab.id;
        for (const t of tabs) {
          const isActive = t.id === activeTabId;
          t.pane.hidden = !isActive;
          t._btn.classList.toggle('active', isActive);
          t._btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
      },
    }, tab.label));
    tabs.forEach((t, i) => { t._btn = tabButtons[i]; });

    const dialog = h('div', { class: 'logs-modal-backdrop',
                                id: 'help-overlay' },
      h('div', { class: 'logs-modal help-modal',
                  role: 'dialog', 'aria-labelledby': 'help-modal-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'help-modal-title' }, t('help.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close,
                        'aria-label': 'Close', title: 'Close' }, '✕'),
        ),
        h('div', { class: 'help-tabs', role: 'tablist' }, ...tabButtons),
        h('div', { class: 'help-body' }, quickPane, workspacePane, apiPane),
      ),
    );
    dialog.addEventListener('click', close);
    document.body.append(dialog);
    // Fetch README into the "Agentic workspace" tab, ROUTES.md into the
    // "API" tab. Both are best-effort — failures show a muted error.
    fetch('/api/docs?file=README.md', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(d => {
        const host = document.getElementById('help-readme');
        if (host) host.replaceChildren(renderMarkdown(d.content || ''));
      })
      .catch(err => {
        const host = document.getElementById('help-readme');
        if (host) host.replaceChildren(
          h('span', { class: 'muted' }, 'Could not load README: ' + err));
      });
    fetch('/static/ROUTES.md', { cache: 'no-store' })
      .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(text => {
        const host = document.getElementById('help-api-routes');
        if (host) host.replaceChildren(renderMarkdown(text));
      })
      .catch(err => {
        const host = document.getElementById('help-api-routes');
        if (host) host.replaceChildren(
          h('span', { class: 'muted' }, 'Could not load ROUTES.md: ' + err));
      });
  }
  function closeHelpOverlay() {
    document.getElementById('help-overlay')?.remove();
  }

  // ── Add Issue dialog ──────────────────────────────────────────────
  // Creates worktrees under {root}/<issue>/<repo> for the
  // chosen repos. Server checks origin/<issue> for each repo: if the
  // branch exists, the new worktree tracks it; otherwise a new branch
  // is created from `base_branch` (default "master"). The dialog is
  // intentionally minimal — issue key, base branch, repo checkboxes,
  // submit. Per-repo results render inline once the round-trip lands.
  // Current effective repo list — derived from the `github-repos`
  // preference. Each "owner/repo" contributes its repo-name. Called
  // each time the Add-workspace dialog opens so edits from
  // Profile → Dashboard → GitHub repos take effect immediately
  // without a page reload. Empty array when the user hasn't
  // configured any GitHub repos.
  function currentExpectedRepos() {
    const ghPrefs = (githubModalPrefs || {})['github-repos'];
    const raw = Array.isArray(ghPrefs)
      ? ghPrefs
      : (typeof ghPrefs === 'string'
          ? ghPrefs.split(',')
          : []);
    const seen = new Set();
    const out = [];
    for (const slug of raw) {
      const trimmed = String(slug).trim();
      if (!trimmed || !trimmed.includes('/')) continue;
      const name = trimmed.split('/').pop();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  async function openAddIssueDialog(prefillIssue, onDone) {
    document.getElementById('add-issue-dialog')?.remove();
    // Pull the latest github-repos preference each time the dialog
    // opens so the repo checkbox list always matches the user's
    // current setup (no stale cache from a long-open page).
    try {
      const r = await fetch('/api/github/config', { cache: 'no-store' });
      const d = await r.json();
      githubModalPrefs = githubModalPrefs || {};
      githubModalPrefs['github-repos'] = d.repos || [];
    } catch (_) {}
    const issueInput = h('input', {
      type: 'text', class: 'add-issue-input', autocomplete: 'off',
      placeholder: '42-fix-auth',
      value: prefillIssue || '',
    });
    const baseInput = h('input', {
      type: 'text', class: 'add-issue-input', autocomplete: 'off',
      placeholder: 'main', value: 'main',
    });
    const repoBoxes = currentExpectedRepos().map(repo => {
      const cb = h('input', {
        type: 'checkbox', value: repo, checked: '',
      });
      return { repo, cb,
               row: h('label', { class: 'add-issue-repo-row' }, cb,
                       h('span', {}, repo)) };
    });
    const resultsHost = h('div', { class: 'add-issue-results' });
    const close = () =>
      document.getElementById('add-issue-dialog')?.remove();

    // After the request comes back, the submit button switches roles:
    // 'create' — pre-submit and on real failures
    // 'close'  — every row was either created or a benign skip
    // Route both through a single click handler so we don't end up
    // with the addEventListener (h() default) + .onclick double-fire
    // bug that bit openRemoveIssueDialog earlier.
    let buttonMode = 'create';

    const submit = async () => {
      const issue = issueInput.value.trim();
      const base = baseInput.value.trim() || 'master';
      const repos = repoBoxes.filter(b => b.cb.checked).map(b => b.repo);
      if (!issue) {
        showToast('warn', t('addIssue.warn.empty')); issueInput.focus(); return;
      }
      if (!/^[A-Za-z0-9._/-]+$/.test(issue)) {
        showToast('warn', t('addIssue.warn.invalid')); issueInput.focus(); return;
      }
      if (!repos.length) {
        showToast('warn', t('addIssue.warn.no-repos')); return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = t('addIssue.button.creating');
      resultsHost.replaceChildren(
        h('div', { class: 'muted' }, t('addIssue.button.creating')));
      try {
        const r = await fetch('/api/issue/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issue, base_branch: base, repos }),
        });
        const d = await r.json().catch(() => ({}));
        if (!d.results) {
          showToast('error', d.error || `Create failed (${r.status})`);
          submitBtn.disabled = false;
          submitBtn.textContent = t('addIssue.button.create');
          resultsHost.replaceChildren();
          return;
        }
        // Render per-repo results inline.
        resultsHost.replaceChildren(
          h('table', { class: 'hover-popover-table',
                        style: { width: '100%' } },
            h('thead', {}, h('tr', {},
              h('th', {}, t('addIssue.col.repo')),
              h('th', {}, t('addIssue.col.result')),
              h('th', {}, t('addIssue.col.detail')),
            )),
            h('tbody', {},
              ...d.results.map(rr => h('tr', {},
                h('td', {}, rr.repo),
                h('td', {},
                  h('span', {
                    class: 'pill ' + (rr.ok ? 'clean' : 'unpushed'),
                  }, rr.ok ? '✓ ' + rr.action : '✗ ' + rr.action)),
                h('td', { style: { whiteSpace: 'pre-wrap' } },
                  rr.message || ''),
              )),
            ),
          ),
        );
        const okCount  = d.results.filter(rr =>  rr.ok).length;
        const skipCount = d.results.filter(rr =>
          !rr.ok && rr.action === 'skip').length;
        const failedCount = d.results.length - okCount - skipCount;
        // Once any repo has been touched (created or already existed)
        // the dashboard's state has changed and a re-submit would just
        // re-skip the successes while re-tripping the same failures —
        // flip the button to Close. The per-repo error message in the
        // results table tells the user what to fix manually. Keep
        // Create only when EVERY repo failed, since then nothing
        // changed and a retry might genuinely help.
        const anySuccess = okCount > 0 || skipCount > 0;
        let msg;
        if (failedCount === 0) {
          if (okCount && skipCount) {
            msg = `✓ ${issue} · ${okCount} created, ${skipCount} already existed`;
          } else if (okCount) {
            msg = `✓ ${issue} · ${okCount} worktree${okCount !== 1 ? 's' : ''} created`;
          } else {
            msg = `✓ ${issue} · ${skipCount} already existed`;
          }
          showToast('ok', msg);
        } else if (anySuccess) {
          showToast('warn',
            `${issue}: ${okCount}/${d.results.length} created, `
            + `${failedCount} failed — see details`);
        } else {
          showToast('error',
            `${issue}: all ${failedCount} repos failed — see details`);
        }
        refreshAll(true);
        if (typeof onDone === 'function') onDone(failedCount === 0, issue);
        submitBtn.disabled = false;
        if (anySuccess) {
          submitBtn.textContent = t('btn.close');
          buttonMode = 'close';
          // Cancel becomes redundant once anything succeeded — disable
          // it so Close is the obvious single way out.
          cancelBtn.disabled = true;
        } else {
          submitBtn.textContent = t('addIssue.button.create');
          buttonMode = 'create';
        }
      } catch (err) {
        showToast('error', t('toast.create-failed', { err }));
        submitBtn.disabled = false;
        submitBtn.textContent = t('addIssue.button.create');
        buttonMode = 'create';
      }
    };

    const submitBtn = h('button', {
      class: 'btn btn-primary',
      onclick: () => {
        if (buttonMode === 'create') submit();
        else if (buttonMode === 'close') close();
      },
    }, t('addIssue.button.create'));
    const cancelBtn = h('button', { class: 'btn', onclick: close },
      t('addIssue.button.cancel'));

    const dialog = h('div', { class: 'logs-modal-backdrop',
                                id: 'add-issue-dialog' },
      h('div', { class: 'logs-modal add-issue-modal',
                  role: 'dialog', 'aria-labelledby': 'add-issue-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'add-issue-title' }, t('addIssue.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close,
                        'aria-label': 'Close', title: 'Close' }, '✕'),
        ),
        h('div', { class: 'add-issue-body' },
          h('label', { class: 'add-issue-label' }, t('addIssue.label.issue')),
          issueInput,
          h('div', { class: 'add-issue-help' },
            t('addIssue.help.issue')),
          h('label', { class: 'add-issue-label' }, t('addIssue.label.base')),
          baseInput,
          h('div', { class: 'add-issue-help' },
            t('addIssue.help.base')),
          h('label', { class: 'add-issue-label' }, t('addIssue.label.repos')),
          h('div', { class: 'add-issue-repos' },
            ...repoBoxes.map(b => b.row)),
          resultsHost,
        ),
        h('div', { class: 'add-issue-foot' },
          cancelBtn,
          submitBtn,
        ),
      ),
    );
    dialog.addEventListener('click', close);
    document.body.append(dialog);
    setTimeout(() => issueInput.focus(), 0);
    issueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    baseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  // Quick-add dialog — small modal with all the per-note fields.
  // Used by the per-tab "+" button (issueId fixed) and by the
  // "+ Add note" button inside the Notes modal (issueId may be null
  // in cross-issue mode, in which case the dialog shows an Issue
  // picker populated from the current state).
  function openAddNoteDialog(issueId) {
    document.getElementById('add-note-dialog')?.remove();

    // Issue picker — only shown when no fixed issueId was supplied.
    // Sourced from the current dashboard state so it stays in sync
    // with the tabs the user actually has. The General Agent is
    // prepended as a special target ("General Agent" → __agent__)
    // so notes can be attached to it from the top Notes dialog —
    // there's no per-tab "+ note" button on the General Agent,
    // this is the only entry point.
    let issuePicker = null;
    if (!issueId) {
      const issues = (window.__lastState?.issues || [])
        .map(i => i.issue).sort((a, b) => a.localeCompare(b));
      if (!issues.length) {
        showToast('warn', t('notes.error.no-issues'));
        return;
      }
      issuePicker = h('select', { class: 'note-edit-issue' },
        h('option', { value: '__agent__' }, t('tab.generic-agent')),
        ...issues.map(i => h('option', { value: i }, i)));
    }

    const ta = h('textarea', {
      class: 'note-edit-textarea', rows: '4',
      placeholder: 'Type your note…',
    });
    const statusSel = h('select', { class: 'note-edit-status' },
      ...NOTE_STATUSES.map(st => h('option', {
        value: st, selected: st === 'todo' ? '' : null,
      }, NOTE_STATUS_LABELS[st])));
    const prioritySel = h('select', { class: 'note-edit-priority' },
      ...NOTE_PRIORITIES.map(p => h('option', {
        value: p, selected: p === 'normal' ? '' : null,
      }, NOTE_PRIORITY_LABELS[p])));
    const dueInput = h('input', {
      type: 'date', class: 'note-edit-due',
    });
    const assigneeInput = h('input', {
      type: 'text', class: 'note-edit-assignee',
      placeholder: t('notes.assignee.placeholder'),
    });
    const tagsInput = h('input', {
      type: 'text', class: 'note-edit-tags',
      placeholder: t('notes.tags.placeholder'),
    });

    const close = () => document.getElementById('add-note-dialog')?.remove();
    const save = async () => {
      const content = ta.value.trim();
      if (!content) { showToast('warn', t('notes.empty-warn')); return; }
      const targetIssue = issueId || issuePicker?.value;
      if (!targetIssue) { showToast('warn', t('notes.add.warn.pick-issue')); return; }
      const tagsArr = tagsInput.value.split(',')
        .map(s => s.trim()).filter(Boolean);
      const due_at = inputValueToDue(dueInput.value);
      const assignee = assigneeInput.value.trim() || null;
      try {
        const r = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue: targetIssue,
            content,
            status: statusSel.value,
            priority: prioritySel.value,
            tags: tagsArr,
            due_at,
            assignee,
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          showToast('error', d.error || t('notes.error.add-failed'));
          return;
        }
        showToast('ok', t('notes.add-success'));
        close();
        if (notesModal.open
            && (notesModal.allMode || notesModal.issue === targetIssue)) {
          await loadNotes();
        }
        refreshAll(true);
      } catch (err) {
        showToast('error', t('notes.error.add-failed') + ': ' + err);
      }
    };

    const headTitle = issueId
      ? t('notes.add-note-title.issue', { issue: issueId })
      : t('notes.add-note-title.pick');

    const bodyChildren = [];
    if (issuePicker) {
      bodyChildren.push(h('label', { class: 'add-note-label' },
        t('notes.label.issue')));
      bodyChildren.push(issuePicker);
    }
    bodyChildren.push(
      h('div', { class: 'add-note-grid' },
        h('label', { class: 'add-note-label' }, t('notes.label.status')),
        statusSel,
        h('label', { class: 'add-note-label' }, t('notes.label.priority')),
        prioritySel,
        h('label', { class: 'add-note-label' }, t('notes.label.due')),
        dueInput,
        h('label', { class: 'add-note-label' }, t('notes.label.assignee')),
        assigneeInput,
        h('label', { class: 'add-note-label' }, t('notes.label.tags')),
        tagsInput,
      ),
      h('label', { class: 'add-note-label' }, t('notes.label.note')),
      ta,
    );

    const dialog = h('div', { class: 'logs-modal-backdrop',
                                id: 'add-note-dialog' },
      h('div', { class: 'logs-modal add-note-modal',
                  role: 'dialog', 'aria-labelledby': 'add-note-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'add-note-title' }, headTitle),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close,
                        'aria-label': t('notes.btn.close'),
                        title: t('notes.btn.close') }, '✕'),
        ),
        h('div', { class: 'add-note-body' }, ...bodyChildren),
        h('div', { class: 'add-note-foot' },
          h('button', { class: 'btn', onclick: close }, t('notes.btn.cancel')),
          h('button', { class: 'btn btn-primary', onclick: save },
            'Save'),
        ),
      ),
    );
    dialog.addEventListener('click', close);
    document.body.append(dialog);
    setTimeout(() => ta.focus(), 0);
  }

  // ── Remove issue dialog ──────────────────────────────────────────
  // Confirms before removing the per-repo worktrees of an issue.
  // Two opt-in checkboxes:
  //   - Force: pass `--force` to `git worktree remove` (drops dirty
  //     uncommitted changes). Without it, `git worktree remove`
  //     refuses if the working tree has changes — that's the safety.
  //   - Delete branches: also drop the local branch in the primary
  //     repo. Without `force` this uses `git branch -d` (refuses on
  //     unmerged commits). With `force` it falls back to `-D`.
  function openRemoveIssueDialog(issueId, onDone) {
    document.getElementById('remove-issue-dialog')?.remove();
    const forceBox = h('input', { type: 'checkbox' });
    const branchBox = h('input', { type: 'checkbox' });
    const resultsHost = h('div', { class: 'remove-issue-results' });
    let inflight = false;
    // When the user clicks Remove and a `claude --name <issue>`
    // process is still running, we pop a confirm() asking whether to
    // proceed anyway. If they accept, we forward bypass_agent_check
    // to the server so its 409 guard lets the request through.
    let bypassAgentCheck = false;
    const close = () => {
      if (inflight) return;
      document.getElementById('remove-issue-dialog')?.remove();
    };
    const submit = async () => {
      if (inflight) return;
      // Pre-check the cached state for a live agent. If found, ask
      // the user before proceeding. They can still say "remove anyway"
      // (bypassAgentCheck=true) and the server will skip its 409.
      const cachedAgentRunning = !!(window.__lastState?.issues || [])
        .find(i => i.issue === issueId)?.agent_running;
      if (cachedAgentRunning && !bypassAgentCheck) {
        if (!window.confirm(t('remove.confirm-agent', { issue: issueId }))) {
          return;
        }
        bypassAgentCheck = true;
      }
      inflight = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Removing…';
      resultsHost.replaceChildren(
        h('div', { class: 'remove-issue-progress' },
          h('span', { class: 'remove-issue-spinner' }, '⟳'),
          h('span', { class: 'muted' }, t('ui.removing-worktrees'))));
      try {
        const r = await fetch('/api/issue/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue: issueId,
            force: forceBox.checked,
            delete_branch: branchBox.checked,
            bypass_agent_check: bypassAgentCheck,
          }),
        });
        const d = await r.json().catch(() => ({}));
        // Server's belt-and-braces 409: we missed the live agent (stale
        // /api/status). Ask the user now and resubmit with the bypass
        // flag.
        if (r.status === 409 && d.agent_running && !bypassAgentCheck) {
          inflight = false;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Remove';
          resultsHost.replaceChildren();
          if (window.confirm(t('remove.confirm-agent', { issue: issueId }))) {
            bypassAgentCheck = true;
            return submit();
          }
          return;
        }
        if (!r.ok && r.status !== 207) {
          resultsHost.replaceChildren(h('span', { class: 'muted' },
            d.error || `request failed (${r.status})`));
          return;
        }
        const results = d.results || [];
        const tbl = h('table', { class: 'remove-issue-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, t('col.repo')), h('th', {}, ''), h('th', {}, t('col.detail')))),
          h('tbody', {},
            ...results.map(res => h('tr', {},
              h('td', {}, res.repo || '—'),
              h('td', { class: res.ok ? 'ok' : 'err' },
                res.ok ? '✓' : '⚠'),
              h('td', { class: 'detail' }, res.message || ''),
            )),
          ),
        );
        resultsHost.replaceChildren(tbl);
        if (results.every(x => x.ok)) {
          showToast('ok', `✓ ${issueId} removed`);
          // Drop the in-memory state for this issue immediately so the
          // dashboard re-renders without that tab, and suppress any
          // in-flight notifications for it.
          removedIssueKeys.add(issueId);
          if (window.__lastState?.issues) {
            window.__lastState.issues = window.__lastState.issues.filter(
              i => i.issue !== issueId);
          }
          if (typeof onDone === 'function') onDone(true, issueId);
          // Stay open so the user can review the per-repo result rows;
          // swap the button to Close mode. Cancel is meaningless
          // post-success — disable it so Close is the only path out.
          inflight = false;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Close';
          buttonMode = 'close-refresh';
          cancelBtn.disabled = true;
        } else {
          showToast('warn',
            `${issueId}: partial removal (${results.filter(x => x.ok).length}/${results.length})`);
          submitBtn.textContent = 'Close';
          buttonMode = 'close';
          inflight = false;
          submitBtn.disabled = false;
          if (typeof onDone === 'function') onDone(false, issueId);
        }
      } catch (err) {
        resultsHost.replaceChildren(h('span', { class: 'muted' },
          'Failed: ' + err));
        inflight = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Remove';
      }
    };
    // Single click handler that dispatches by mode. The previous code
    // re-assigned `submitBtn.onclick = close` after a successful
    // request, but the original `submit` handler attached by h() via
    // addEventListener kept firing alongside it — submit() would flip
    // inflight=true on the way through and close() then short-circuited
    // on `if (inflight) return`, leaving the dialog stuck open.
    let buttonMode = 'submit';
    const submitBtn = h('button', {
      class: 'btn btn-danger',
      onclick: () => {
        if (buttonMode === 'submit') submit();
        else if (buttonMode === 'close') close();
        else if (buttonMode === 'close-refresh') { close(); refreshAll(true); }
      },
    }, 'Remove');
    const cancelBtn = h('button', { class: 'btn', onclick: close }, t('btn.cancel'));

    const dialog = h('div', { class: 'logs-modal-backdrop',
                                id: 'remove-issue-dialog' },
      h('div', { class: 'logs-modal add-issue-modal',
                  role: 'dialog', 'aria-labelledby': 'remove-issue-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'remove-issue-title' },
            `🗑 Remove worktree — ${issueId}`),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close,
                        'aria-label': 'Close', title: 'Close' }, '✕'),
        ),
        h('div', { class: 'add-issue-body' },
          h('p', {},
            `Remove the per-repo worktree(s) for `,
            h('code', {}, issueId),
            ` under your worktrees root. By default only clean worktrees are removed and local branches are kept.`),
          h('label', { class: 'remove-issue-opt' },
            forceBox,
            ' Force — discard uncommitted changes (',
            h('code', {}, 'git worktree remove --force'),
            ')',
          ),
          h('label', { class: 'remove-issue-opt' },
            branchBox,
            ' Also delete local branches in the primary repos (',
            h('code', {}, 'git branch -d'),
            ', or ', h('code', {}, '-D'), ' if Force is on)',
          ),
          resultsHost,
        ),
        h('div', { class: 'add-issue-foot' },
          h('button', { class: 'btn', onclick: close }, t('btn.cancel')),
          submitBtn,
        ),
      ),
    );
    dialog.addEventListener('click', close);
    document.body.append(dialog);
    setTimeout(() => submitBtn.focus(), 0);
  }

  async function markAllEventsRead() {
    const scopedIssue = allEventsModal.issue;
    const confirmMsg = scopedIssue
      ? `Mark every unread event for ${scopedIssue} as read?`
      : 'Mark every unread agent event as read?';
    if (!confirm(confirmMsg)) return;
    try {
      const url = scopedIssue
        ? `/api/events/mark-read?issue=${encodeURIComponent(scopedIssue)}`
        : '/api/events/mark-read';
      const r = await fetch(url, { method: 'POST' });
      const d = await r.json();
      showToast('ok', `✓ ${d.marked_read || 0} event(s) marked read`);
      if (scopedIssue) {
        // Clear just this issue's tab badge + cached count.
        const badge = document.querySelector(
          `nav.tabs button[data-tab="tab-${slugId(scopedIssue)}"] .pending-events-badge`);
        if (badge) badge.remove();
        const issue = (window.__lastState?.issues || []).find(
          i => i.issue === scopedIssue);
        if (issue) issue.pending_events = 0;
      } else {
        // Clear every tab badge + cached counts.
        document.querySelectorAll('nav.tabs .pending-events-badge')
                .forEach(el => el.remove());
        (window.__lastState?.issues || []).forEach(i => i.pending_events = 0);
      }
      // Re-fetch the list so the modal reflects the change.
      loadAllEvents();
    } catch (err) {
      showToast('error', t('toast.mark-read-failed', { err }));
    }
  }

  // Programmatic "open Messages tab for this issue" — used by the
  // pending-event badge in the tab strip and any other shortcut.
  function openAgentMessagesTab(issueId) {
    const sec = document.getElementById(`tab-${slugId(issueId)}`);
    if (!sec) return;
    const btn = sec.querySelector(
      `.agent-inner-tab[data-kind="messages"][data-issue="${CSS.escape(issueId)}"]`)
      || sec.querySelector('.agent-inner-tab[data-kind="messages"]');
    if (btn) btn.click();
    // Scroll the agent section into view.
    const det = sec.querySelector('details.agent-details');
    if (det) {
      if (!det.open) det.open = true;
      det.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function repoCardFor(repo) {
    // Synthesised placeholder for an expected repo that hasn't been
    // materialised under the issue. Render a flat row that's visually
    // distinct from the live repo cards — no expand affordance, no
    // disk badge, no agent stats; just "this isn't here yet".
    if (repo.missing) {
      // Honour the Dashboard profile toggle. When off, the row is
      // omitted entirely so issue tabs that only use a subset of
      // repos read cleaner.
      if (!showMissingRepos) return null;
      // Match the live cards' summary structure (head + footer) so a
      // missing row takes up the same vertical space and aligns with
      // its siblings in the issue tab. All metadata fields are em-
      // dashed since they're undefined for a non-materialised repo.
      return h('div', { class: 'repo-card repo-missing',
                          'data-card-key': `${repo.issue}/${repo.repo}` },
        h('div', { class: 'repo-head' },
          h('h3', { class: 'repo-title' },
            h('span', { class: 'section-icon', 'aria-hidden': 'true' }, '🌿'),
            repo.repo),
          h('span', { class: 'repo-missing-text' },
            t('repo.not-in-worktree')),
          h('span', { class: 'pills' },
            h('span', { class: 'pill missing-pill hover-popover-host' },
              t('pill.missing'),
              h('div', { class: 'hover-popover' },
                h('div', { class: 'hover-popover-foot' },
                  `No ${repo.repo} subdirectory under {root}/${repo.issue}. `
                  + 'Use the + Add issue dialog (or git worktree add manually) to materialise it.'))),
          ),
        ),
        h('div', { class: 'footer' },
          h('span', {}, t('ui.branch-age'),  h('strong', {}, '—')),
          h('span', {}, t('ui.last-claude'), h('strong', {}, '—')),
          h('span', {}, t('ui.last-build'),  h('strong', {}, '—')),
        ),
      );
    }
    const cardCls = ['repo-card'];
    if (repo.too_behind) cardCls.push('too-behind');
    if (repo.ghost)      cardCls.push('ghost');
    // Preserve open/closed state across refreshes. Default: every card
    // starts collapsed so opening a tab is a clean overview. Once the user
    // expands a card, snapshotOpenState() captures it and the choice
    // persists across re-renders (refresh, sort change, filter change).
    const cardKey = `${repo.issue}/${repo.repo}`;
    const defaultOpen = false;
    const isOpen = (cardKey in openState.repos) ? openState.repos[cardKey] : defaultOpen;
    const card = h('details', {
      class: cardCls.join(' '),
      open: isOpen ? '' : null,
      'data-card-key': cardKey,
    });

    const ghostBadge = repo.ghost
      ? h('span', { class: 'pill ghost-pill hover-popover-host' },
          `removed ${(repo.removed_at || '').slice(0, 10)}`,
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              'Worktree no longer exists on disk — last seen on '
              + (repo.removed_at || 'an unknown date') + '.')))
      : null;

    // VS Code-style sync counts inline with the repo title — `*` for
    // uncommitted changes, `↓N ↑N` for incoming/outgoing commits
    // against the same-name remote branch (origin/<branch>) when it
    // exists, falling back to @{u}. Mirrors what `git pull` / `git
    // push` would actually transfer. Use n_unpushed directly — the
    // server already picked the right reference for it; falling back
    // to `ahead` here would re-introduce the master-divergence number
    // that we deliberately moved off the title.
    const incoming = Math.max(0, repo.n_to_pull | 0);
    const outgoing = Math.max(0, repo.n_unpushed | 0);
    const repoLabel = h('span', { class: 'repo-label' },
      repo.repo,
      repo.n_dirty > 0
        ? h('span', { class: 'repo-dirty-mark', title: 'Uncommitted changes' }, ' *')
        : null,
      h('span', { class: 'repo-sync-counts' },
        ` ↓${incoming} ↑${outgoing}`),
    );
    // Styled hover tooltip on the title — same look as the tab + agent
    // tooltips. Lays out the per-branch git stats as a small two-col
    // table so the master-divergence numbers don't get crammed into a
    // multi-line `title=` text.
    const aheadOfMaster  = Math.max(0, repo.ahead  | 0);
    const behindOfMaster = Math.max(0, repo.behind | 0);
    const upstreamLabel  = repo.upstream || 'master';
    const repoTooltip = h('div', { class: 'hover-popover',
                                     onclick: (e) => e.stopPropagation() },
      h('table', { class: 'hover-popover-table hover-popover-kv' },
        h('tbody', {},
          h('tr', {},
            h('th', {}, t('col.branch')),
            h('td', {}, repo.branch || '—')),
          h('tr', {},
            h('th', {}, t('col.upstream')),
            h('td', {}, repo.upstream || '—')),
          h('tr', {},
            h('th', {}, '↓ Pull'),
            h('td', { class: 'num' },
              `${incoming} from origin/${repo.branch}`)),
          h('tr', {},
            h('th', {}, '↑ Push'),
            h('td', { class: 'num' },
              `${outgoing} to origin/${repo.branch}`)),
          h('tr', {},
            h('th', {}, 'vs ' + upstreamLabel),
            h('td', { class: 'num' },
              `+${aheadOfMaster} ahead · −${behindOfMaster} behind`)),
          h('tr', {},
            h('th', {}, t('col.working-tree')),
            h('td', {},
              repo.n_dirty > 0
                ? h('span', { class: 'pill dirty' },
                    `${repo.n_dirty} change${repo.n_dirty !== 1 ? 's' : ''}`)
                : h('span', { class: 'pill clean' }, 'clean'))),
        ),
      ),
    );
    // Friendlier display of the worktree path: replace $HOME with ~.
    const homePrefix = (repo.path || '').match(/^\/(home|Users)\/[^/]+/)?.[0];
    const friendlyPath = homePrefix ? '~' + repo.path.slice(homePrefix.length) : repo.path;
    // Disk usage badge — populated lazily after the API call returns.
    // Wrapped in a hover-popover-host so the tooltip uses the shared
    // styled popover instead of a native title.
    const diskValue = h('span', { class: 'disk-badge-value' }, '…');
    const diskTooltipMeta = h('div', {},
      h('strong', {}, t('ui.worktree-disk')),
      h('div', { class: 'muted', style: { fontSize: '11px' } },
        'measured by ', h('code', {}, 'du -sh')));
    const diskMeasuredAt = h('div', { class: 'muted',
                                        style: { fontSize: '11px',
                                                 marginTop: '4px' } });
    const diskBadge = h('span', { class: 'disk-badge hover-popover-host' },
      diskValue,
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot',
                    style: { borderTop: 'none' } },
          diskTooltipMeta, diskMeasuredAt)),
    );
    if (!repo.ghost) {
      fetch(`/api/disk/${encodeURIComponent(repo.issue)}/${encodeURIComponent(repo.repo)}`)
        .then(r => r.json())
        .then(d => {
          diskValue.textContent = d.size || '—';
          diskMeasuredAt.textContent =
            d.computed_at ? `measured ${d.computed_at}` : '';
        })
        .catch(() => { diskValue.textContent = '?'; });
    } else {
      diskValue.textContent = '—';
    }

    // Icon-only "open this worktree in the editor" button. Hidden for
    // ghosts since the path doesn't exist on disk. Tooltip uses the
    // shared styled hover-popover so it matches the rest of the UI.
    const openTip = editorPref
      ? `Open worktree in ${editorPref}`
      : 'Pick an editor in your profile first';
    const openWtBtn = repo.ghost ? null : h('button', {
      class: 'btn open-worktree-btn hover-popover-host', type: 'button',
      'aria-label': openTip,
      onclick: (e) => { e.preventDefault(); openFileInEditor(repo.path, '.'); },
    }, t('issue.open-worktree'),
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' }, openTip)),
    );

    // Safe git ops — fetch / pull --ff-only / push. Each runs on the
    // server, returns its stdout+stderr, and we surface the result via
    // a toast + an immediate refreshAll so the ↓↑ counts update.
    // Buttons are disabled when the op would obviously be a no-op or
    // fail given the current sync state, with a styled hover-popover
    // explaining why:
    //   pull-ff: needs n_to_pull > 0 AND n_unpushed == 0 (no divergence)
    //   push:    needs n_unpushed > 0 AND n_to_pull == 0 (no rejection)
    //   fetch:   always allowed (just refreshes refs)
    const pullDisabledWhy = incoming === 0
      ? 'Nothing to pull'
      : (outgoing > 0
          ? 'Branch has diverged — pull --ff-only would refuse. Resolve manually first.'
          : null);
    const pushDisabledWhy = outgoing === 0
      ? 'Nothing to push'
      : (incoming > 0
          ? 'Remote has new commits — push would be rejected. Pull first.'
          : null);
    const fetchTip = 'git fetch origin --prune — refresh remote-tracking refs.';
    const pullTip = pullDisabledWhy
      ? `Pull disabled: ${pullDisabledWhy}`
      : `git pull --ff-only · ${incoming} commit${incoming !== 1 ? 's' : ''} to pull from origin/${repo.branch}.`;
    const pushTip = pushDisabledWhy
      ? `Push disabled: ${pushDisabledWhy}`
      : `git push origin ${repo.branch} · ${outgoing} commit${outgoing !== 1 ? 's' : ''} to push.`;
    const gitOpBtns = repo.ghost ? null : h('span', { class: 'git-ops' },
      h('button', {
        class: 'btn-icon git-op-btn hover-popover-host', type: 'button',
        'aria-label': 'Fetch',
        onclick: (e) => { e.preventDefault();
          runGitOp('fetch', repo.issue, repo.repo, e.currentTarget); },
      }, '⟳',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' }, fetchTip))),
      h('button', {
        class: 'btn-icon git-op-btn hover-popover-host'
               + (pullDisabledWhy ? ' git-op-disabled' : ''),
        type: 'button',
        disabled: pullDisabledWhy ? '' : null,
        'aria-label': 'Pull (fast-forward only)',
        onclick: (e) => { e.preventDefault();
          if (pullDisabledWhy) return;
          runGitOp('pull-ff', repo.issue, repo.repo, e.currentTarget); },
      }, '↓',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' }, pullTip))),
      h('button', {
        class: 'btn-icon git-op-btn hover-popover-host'
               + (pushDisabledWhy ? ' git-op-disabled' : ''),
        type: 'button',
        disabled: pushDisabledWhy ? '' : null,
        'aria-label': 'Push',
        onclick: (e) => { e.preventDefault();
          if (pushDisabledWhy) return;
          runGitOp('push', repo.issue, repo.repo, e.currentTarget); },
      }, '↑',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' }, pushTip))),
    );

    // Per-repo ↗ gitweb shortlog link, rendered next to the branch
    // name. This replaces the old tab-level gitweb link, which was
    // wrong on a multi-repo issue (it only ever pointed at the
    // alphabetically-first repo). Stays visible in compact mode.
    const branchGitwebUrl = repo.ghost
      ? null
      : gitwebBranchUrl(repo.remote_path, repo.branch, repo.remote_url);
    const branchGitwebLink = branchGitwebUrl ? h('a', {
      class: 'branch-gitweb hover-popover-host',
      href: branchGitwebUrl,
      target: '_blank', rel: 'noopener noreferrer',
      'aria-label': `Open ${repo.branch} on gitweb`,
      onclick: (e) => e.stopPropagation(),
    }, '↗',
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' },
          `Open the ${repo.branch} branch shortlog for ${repo.repo} on gitweb (new tab).`)),
    ) : null;

    // Order: title, branch + gitweb ↗ + path (branch + path hidden
    // in compact mode, but the gitweb ↗ stays visible), pills, then
    // the action cluster (Open + git ops + disk badge) pushed all the
    // way right by .pills's margin-left: auto. The gitweb link lives
    // next to the branch name (per-repo) so multi-repo issues can
    // jump to the right repo's shortlog directly — the old tab-level
    // ↗ link was ambiguous, only ever pointing at the alphabetically
    // first repo.
    const titleBar = h('div', { class: 'repo-head' },
      h('h3', { class: 'repo-title hover-popover-host' },
        h('span', { class: 'section-icon', 'aria-hidden': 'true' }, '🌿'),
        repoLabel,
        repoTooltip),
      h('span', { class: 'branch' },
        `${repo.branch} ⟂ ${repo.upstream || '—'}`),
      branchGitwebLink,
      h('span', { class: 'wt-path hover-popover-host' },
        friendlyPath,
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' },
            'Worktree path: ' + repo.path))),
      h('span', { class: 'pills' }, ghostBadge, pillsFor(repo, repo.behind_limit)),
      openWtBtn,
      gitOpBtns,
      diskBadge,
    );

    // "X days ago" suffix — adds a quick way to spot stale work.
    const ageSuffix = repo.last_commit_age_days >= 0
      ? ` · ${repo.last_commit_age_days}d ago`
      : '';
    const lastline = h('div', { class: 'lastline' },
      h('strong', {}, t('ui.last-commit')),
      h('code', {}, repo.last_commit),
      ' ',
      h('span', { class: 'muted' }, `· ${repo.last_commit_when} · ${repo.last_commit_author}${ageSuffix}`),
    );

    // Footer: branch age, last Claude (with the last user prompt as tooltip), last build.
    const branchAgeText = repo.branch_age_days >= 0
      ? `${repo.branch_age_days}d`
      : '—';
    const idle = repo.last_commit_age_days >= 14;
    // Build "N min/h/d ago" suffix when we have a build artifact.
    let buildSuffix = '';
    if (repo.last_build_age_min >= 0) {
      const m = repo.last_build_age_min;
      const rel = m < 60 ? `${m}m ago`
                : m < 60 * 24 ? `${Math.floor(m / 60)}h ${m % 60}m ago`
                : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h ago`;
      buildSuffix = ` (${rel})`;
    }
    const footer = h('div', { class: 'footer' },
      idle
        ? h('span', { class: 'idle-warn hover-popover-host' },
            '💤 ',
            'Branch age: ', h('strong', {}, branchAgeText),
            h('div', { class: 'hover-popover' },
              h('div', { class: 'hover-popover-foot' },
                'No commits in 14+ days — consider rebasing or closing.')))
        : h('span', {},
            'Branch age: ', h('strong', {}, branchAgeText)),
      // "Last Claude" with an inline ⓘ marker that opens a styled
      // popover showing the actual last user prompt — multi-line is
      // useless in a native title= tooltip.
      repo.last_claude_prompt
        ? h('span', { class: 'hover-popover-host' },
            'Last Claude: ', h('strong', {}, repo.last_claude),
            h('span', { class: 'has-prompt' }, ' ⓘ'),
            h('div', { class: 'hover-popover' },
              h('table', { class: 'hover-popover-table hover-popover-kv' },
                h('tbody', {},
                  h('tr', {},
                    h('th', {}, t('col.last-claude')),
                    h('td', {}, repo.last_claude)),
                  h('tr', {},
                    h('th', {}, t('col.last-prompt')),
                    h('td', { style: { whiteSpace: 'pre-wrap' } },
                      repo.last_claude_prompt)),
                ),
              ),
            ),
          )
        : h('span', {},
            'Last Claude: ', h('strong', {}, repo.last_claude)),
      h('span', {},
        'Last build: ', h('strong', {}, repo.last_build),
        buildSuffix && h('span', { class: 'muted' }, buildSuffix),
      ),
    );

    // Wrap title and footer in a single <summary> so both stay visible
    // when the card is collapsed (the rest of the body — last commit
    // line + details pane — only shows when expanded).
    const summary = h('summary', { class: 'repo-summary' }, titleBar, footer);
    card.append(summary, lastline, detailsPaneFor(repo));
    return card;
  }

  // Build a branch URL for a given repo. Delegates to the
  // host-aware helper above so GitHub remotes get
  // https://github.com/<owner>/<repo>/tree/<branch> automatically.
  function gitwebBranchUrl(remotePath, branch, remoteUrl) {
    return gitwebBranchUrlForHost(remotePath, branch, remoteUrl);
  }

  function tabSectionFor(issueObj, behindLimit) {
    const section = h('section', { class: 'tab', id: `tab-${slugId(issueObj.issue)}` });

    // Toggle every collapsible in the CURRENT sub-tab. On Branches
    // that's <details> repo-cards + the per-issue Agent info; on
    // Stashes it's the +/− toggle in each stash row. On Agent /
    // Messages the button is hidden — there's nothing to expand.
    const collapsibleSelector = 'details.repo-card, details.agent-details';
    const getStashesPane = () => {
      const wrap = section.querySelector(
        `#issue-sub-stashes-${cssId(issueObj.issue)}`);
      return wrap && wrap.firstChild;
    };
    const refreshExpandLabel = () => {
      if (!expandBtn) return;
      const sub = perIssueAgentSub.get(issueObj.issue) || 'agent';
      const showInSub = sub === 'branches' || sub === 'stashes';
      expandBtn.style.display = showInSub ? '' : 'none';
      if (!showInSub) return;
      let anyClosed = false;
      if (sub === 'stashes') {
        const pane = getStashesPane();
        anyClosed = pane?.anyStashCollapsed?.() ?? false;
      } else {
        const cards = section.querySelectorAll(collapsibleSelector);
        anyClosed = Array.from(cards).some(d => !d.open);
      }
      expandLabel.textContent = anyClosed ? '+' : '−';
      const tip = anyClosed ? t('tip.expand-all') : t('tip.collapse-all');
      expandBtn.setAttribute('aria-label', tip);
      expandBtn.title = tip;
      expandBtn.classList.toggle('expanded', !anyClosed);
      expandBtn.setAttribute(
        'aria-pressed', !anyClosed ? 'true' : 'false');
    };
    // Label lives in its own span so refreshExpandLabel can swap the
    // icon without wiping the styled hover-popover sibling. Initial
    // values are placeholders — refreshExpandLabel runs at the end of
    // tabSectionFor and reconciles label / .expanded class with the
    // actual card states.
    const expandLabel = h('span', { class: 'expand-all-label' }, '+');
    const expandBtn = h('button', {
      class: 'btn expand-all-btn hover-popover-host',
      type: 'button',
      'aria-label': t('tip.expand-all'), title: t('tip.expand-all'),
      'aria-pressed': 'false',
      onclick: (e) => {
        e.preventDefault();
        const sub = perIssueAgentSub.get(issueObj.issue) || 'agent';
        if (sub === 'stashes') {
          const pane = getStashesPane();
          if (pane?.expandAllStashes) {
            pane.expandAllStashes(pane.anyStashCollapsed?.() ?? true);
          }
        } else {
          const cards = section.querySelectorAll(collapsibleSelector);
          const anyClosed = Array.from(cards).some(d => !d.open);
          cards.forEach(d => { d.open = anyClosed; });
        }
        refreshExpandLabel();
      },
    },
      expandLabel,
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' },
          t('tip.expand-all-popover'))),
    );
    // Keep the label in sync when the user folds/unfolds individual sections.
    section.addEventListener('toggle', (e) => {
      const cl = e.target.classList;
      if (cl?.contains('repo-card') || cl?.contains('agent-details')) {
        refreshExpandLabel();
      }
    }, true);

    // Issue heading: no longer repeats the issue ID (that's already in the
    // tab button) and no longer shows a redundant status pill (that's on
    // the tab itself). Always show the freshness card (active on a
    // recent commit, idle when stale), then the summary, then the
    // expand-all button.
    const headChildren = [];
    const maxAge = Math.max(
      -1, ...issueObj.repos.map(r => r.last_commit_age_days ?? -1));
    if (maxAge >= 0) {
      const stale = maxAge >= 14;
      const ageText = maxAge === 0 ? 'today' : `${maxAge}d`;
      const idleHelp = stale
        ? `Most recent commit is ${maxAge} days old — consider rebasing or closing.`
        : `Most recent commit ${maxAge === 0 ? 'today' : maxAge + ' day' + (maxAge !== 1 ? 's' : '') + ' ago'}.`;
      headChildren.push(h('span', {
        class: 'idle-card hover-popover-host'
               + (stale ? ' idle-card-stale' : ' idle-card-fresh'),
      }, stale ? '💤 ' : '🟢 ',
        h('span', { class: 'idle-card-num' }, ageText),
        h('span', { class: 'idle-card-label' },
          stale ? 'idle' : 'active'),
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' }, idleHelp)),
      ));
    }

    // ↗ Open — open the issue's whole worktree dir
    // ({root}/<issue>/) in the configured editor so the user
    // sees core / bssweb / doc side-by-side. The per-repo Open
    // button next to each branch name handles single-repo cases.
    const issueDir = (window.__lastState?.worktrees_root || '')
      + '/' + issueObj.issue;
    const issueOpenTip = editorPref
      ? `Open ${issueDir} in ${editorPref}`
      : 'Pick an editor in your profile first';
    headChildren.push(h('button', {
      class: 'btn open-issue-btn hover-popover-host',
      type: 'button',
      'aria-label': issueOpenTip,
      onclick: (e) => {
        e.preventDefault();
        openFileInEditor(issueDir, '.');
      },
    }, t('issue.open-issue'),
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' },
          `${issueOpenTip}. ${t('tip.open-issue')}`)),
    ));

    // 💻 Console — open this issue in a new external terminal tab.
    // Hidden when inline mode is on, because the Agent sub-tab on
    // this very issue exposes Start / Stop / ↗ External right in the
    // body and the H2 chip would be redundant.
    if (!inlineConsoleOn()) {
      const consoleAlreadyRunning =
        issueObj.agent_state === 'active' || issueObj.agent_state === 'idle';
      const effectiveModelId = effectiveModelFor(issueObj.issue);
      const modelHint = ` · model: ${claudeModelLabel(effectiveModelId)}`;
      const consoleHelp = consoleAlreadyRunning
        ? `${issueObj.issue} already has an ${issueObj.agent_state} agent — switch to its existing terminal tab instead of spawning a duplicate.`
        : t('tip.open-console') + modelHint;
      headChildren.push(h('button', {
        class: 'btn console-btn hover-popover-host'
                + (consoleAlreadyRunning ? ' console-btn-running' : ''),
        type: 'button',
        disabled: consoleAlreadyRunning ? '' : null,
        'aria-disabled': consoleAlreadyRunning ? 'true' : null,
        onclick: async (e) => {
          e.preventDefault();
          if (consoleAlreadyRunning) return;
          try {
            const r = await fetch('/api/open-agent-tab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                issue: issueObj.issue,
                model: modelArgFor(effectiveModelFor(issueObj.issue)),
              }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              showToast('error', d.error || `Open failed (${r.status})`);
            } else {
              showToast('ok', `✓ ${issueObj.issue} opening…`);
            }
          } catch (err) {
            showToast('error', t('toast.open-failed', { err }));
          }
        },
      }, t('issue.open-console'),
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' }, consoleHelp)),
      ));
    }

    // Issue-level Fetch all / Pull all — runs the safe git op against
    // every repo under this issue in one server round-trip, then shows
    // a multi-line banner with the per-repo result.
    headChildren.push(h('div', { class: 'issue-git-btn-group' },
      h('button', {
        class: 'btn issue-git-btn hover-popover-host',
        type: 'button',
        'aria-label': `Fetch every repo under ${issueObj.issue}`,
        onclick: function (e) {
          e.preventDefault();
          runIssueGitOp('fetch', issueObj.issue, this);
        },
      }, '⇣ Fetch all',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' },
            `Run \`git fetch --prune origin\` in every repo under ${issueObj.issue}.`)),
      ),
      h('button', {
        class: 'btn issue-git-btn hover-popover-host',
        type: 'button',
        'aria-label': `Pull every repo under ${issueObj.issue}`,
        onclick: function (e) {
          e.preventDefault();
          runIssueGitOp('pull-ff', issueObj.issue, this);
        },
      }, '⇩ Pull all',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' },
            `Run \`git pull --ff-only\` in every repo under ${issueObj.issue}. Aborts cleanly on divergence.`)),
      ),
    ));

    // Notes controls — list + quick-add. Sit just left of Expand all
    // so the right-aligned button cluster reads as: [Notes][+] Expand.
    // Wrapped in a single flex item so the parent's `gap` rule doesn't
    // pry the two buttons apart.
    headChildren.push(h('div', { class: 'notes-btn-group' },
      h('button', {
        class: 'btn notes-btn hover-popover-host', type: 'button',
        onclick: (e) => { e.preventDefault(); openNotesModal(issueObj.issue); },
      }, '📝 Notes',
         (issueObj.pending_todos || 0) > 0
           ? h('span', { class: 'notes-btn-count' },
               String(issueObj.pending_todos))
           : null,
         h('div', { class: 'hover-popover' },
           h('div', { class: 'hover-popover-foot' },
             `Open the notes modal for ${issueObj.issue} — list, edit, change status (todo / done / not done) and delete notes scoped to this issue.`)),
      ),
      h('button', {
        class: 'btn notes-add-btn hover-popover-host', type: 'button',
        'aria-label': `Add note to ${issueObj.issue}`,
        onclick: (e) => {
          e.preventDefault();
          openAddNoteDialog(issueObj.issue);
        },
      }, '+',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' },
            `Quick-add a note to ${issueObj.issue}.`)),
      ),
    ));
    headChildren.push(expandBtn);

    // 📌 Pin / unpin — keep this issue's tab leftmost regardless of the
    // active tabSort. State is persisted in localStorage; toggling
    // re-renders the whole dashboard so the tab strip reorders. Sits
    // just left of the destructive 🗑 button so the two issue-level
    // actions stay grouped at the end of the row.
    const isPinned = pinnedIssues.has(issueObj.issue);
    const pinTip = isPinned
      ? t('tip.unpin', { issue: issueObj.issue })
      : t('tip.pin',   { issue: issueObj.issue });
    headChildren.push(h('button', {
      class: 'btn pin-issue-btn hover-popover-host'
              + (isPinned ? ' pinned' : ''),
      type: 'button',
      'aria-label': pinTip,
      'aria-pressed': isPinned ? 'true' : 'false',
      onclick: (e) => {
        e.preventDefault();
        if (pinnedIssues.has(issueObj.issue)) {
          pinnedIssues.delete(issueObj.issue);
        } else {
          pinnedIssues.add(issueObj.issue);
        }
        savePinnedIssues(pinnedIssues);
        refreshAll(true);
      },
    }, isPinned ? '📍' : '📌',
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' }, pinTip)),
    ));

    // 🗑 Remove worktree(s) for this issue. Always opens a confirmation
    // dialog with explicit checkboxes for "force" + "delete branches",
    // never one-click destructive.
    headChildren.push(h('button', {
      class: 'btn issue-remove-btn hover-popover-host', type: 'button',
      'aria-label': `Remove worktree for ${issueObj.issue}`,
      onclick: (e) => {
        e.preventDefault();
        openRemoveIssueDialog(issueObj.issue);
      },
    }, '🗑',
      h('div', { class: 'hover-popover' },
        h('div', { class: 'hover-popover-foot' },
          `Remove the worktree(s) for ${issueObj.issue}. Confirmation dialog with options for forcing dirty trees and deleting local branches.`)),
    ));
    const head = h('h2', { class: 'issue-head' }, ...headChildren);
    section.append(head);

    // --- Sub-tab routing (Branches / Agent) ---
    // When the inline-console pref is ON, split the issue body into
    // two sub-tabs: Branches (today's content) + Agent (xterm + agent
    // info). When OFF, render the single-pane body exactly as before.
    const inlineOn = inlineConsoleOn();

    const buildBranchesPanel = () => {
      const panel = h('div', { class: 'issue-subpanel issue-branches-panel' });
      for (const repo of issueObj.repos) {
        repo.behind_limit = behindLimit;
        const card = repoCardFor(repo);
        if (card) panel.append(card);
      }
      // Agent information stays under the repo cards in external mode
      // (same place it lives today). In inline mode it moves into the
      // Agent panel (see buildAgentPanel below).
      if (!inlineOn && showAgentInfo) {
        const agentData = aggregateAgentData(issueObj);
        if (agentData || (issueObj.pending_events || 0) > 0) {
          panel.append(claudeAgentSectionFor(
            agentData, issueObj.issue, issueObj.pending_events || 0));
        }
      }
      return panel;
    };

    if (!inlineOn) {
      // Single-pane path — today's UX. No sub-tab bar.
      section.append(buildBranchesPanel());
      refreshExpandLabel();
      return section;
    }

    // Inline path — horizontal icon strip at the top of the issue
    // body. Icon-only buttons for inactive tabs (🤖 / 🌿 / 💾) with the
    // active tab also showing its label so the user has a clear "you
    // are here" hint. Agent is default-active. The strip's right slot
    // (.issue-subtab-actions) holds the active tab's action controls
    // — for the agent tab that's the quick-message dropdown + +/🗑;
    // branches / stashes leave it empty for now.
    const subActive = perIssueAgentSub.get(issueObj.issue) || 'agent';
    const subBar = h('div', { class: 'issue-subtabbar issue-subtabbar-side',
                                role: 'tablist' });
    const subActions = h('div', { class: 'issue-subtab-actions' });
    // Build the Stashes pane up-front (scoped to this issue) so
    // the first click on the sub-tab already has data populated.
    const stashesPane = buildStashesPaneFor({ issueFilter: issueObj.issue });
    const stashesPanel = h('div', {
      id: `issue-sub-stashes-${cssId(issueObj.issue)}`,
      class: 'issue-subpanel issue-messages-panel',
    }, stashesPane);
    // Repopulate the right-side action slot based on which sub-tab
    // is currently active. The Agent sub-tab parks its full
    // controlsRow (title chip + quick-msg + status + start/stop/
    // disco + external/open/info/fullscreen + prev/next) here so
    // every agent control sits on the same horizontal line as the
    // sub-tab icons. Branches / stashes get an empty slot today.
    const refreshSubActions = () => {
      const cur = perIssueAgentSub.get(issueObj.issue) || 'agent';
      subActions.replaceChildren();
      if (cur === 'agent' && agentPanel && agentPanel._controlsRow) {
        subActions.append(agentPanel._controlsRow);
      } else if (cur === 'stashes' && stashesPane._controlsRow) {
        subActions.append(stashesPane._controlsRow);
      }
    };
    const mkSubBtn = (id, icon, label) => h('button', {
      class: 'issue-subtab issue-subtab-icon'
              + (subActive === id ? ' active' : ''),
      type: 'button', role: 'tab',
      'data-issue-sub': id,
      'aria-label': label,
      title: label,
      onclick: () => {
        perIssueAgentSub.set(issueObj.issue, id);
        subBar.querySelectorAll('.issue-subtab').forEach(b =>
          b.classList.toggle('active', b.dataset.issueSub === id));
        const b = document.getElementById(`issue-sub-branches-${cssId(issueObj.issue)}`);
        const a = document.getElementById(`issue-sub-agent-${cssId(issueObj.issue)}`);
        const sp = document.getElementById(`issue-sub-stashes-${cssId(issueObj.issue)}`);
        if (b) b.style.display = id === 'branches' ? '' : 'none';
        if (a) a.style.display = id === 'agent' ? '' : 'none';
        if (sp) sp.style.display = id === 'stashes' ? '' : 'none';
        if (id === 'stashes' && stashesPane.reloadStashes) {
          stashesPane.reloadStashes();
        }
        refreshSubActions();
        // Visibility of the Expand-all button is sub-tab-aware
        // (hidden on Agent / Messages, sub-tab-specific behaviour
        // on Branches / Stashes).
        refreshExpandLabel();
        if (id === 'agent') {
          ensureAgentPanelHydrated(issueObj.issue, issueObj);
          // Re-fit the terminal now that its host has real
          // pixel dimensions. ResizeObserver doesn't always fire
          // when an element goes from display:none to visible
          // (the box was 0×0, the layout engine may consider the
          // size unchanged), so without this the xterm stays at
          // whatever cols/rows the initial 0×0 measurement
          // produced — typically 80×24 — and the bottom-right of
          // the host pane shows unused background.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const cur = inlineAgentState.get(issueObj.issue);
            if (cur && cur.fit && cur.term) {
              try {
                const p = cur.fit.proposeDimensions?.();
                if (p && p.cols >= 40 && p.rows >= 5 &&
                    (p.cols !== cur.term.cols || p.rows !== cur.term.rows)) {
                  cur.fit.fit();
                  postResize(issueObj.issue, cur.term.cols, cur.term.rows);
                }
              } catch (_) {}
            }
          }));
          snapAgentTermToBottom(issueObj.issue);
        }
      },
    },
      h('span', { class: 'issue-subtab-icon-glyph', 'aria-hidden': 'true' },
        icon),
      h('span', { class: 'issue-subtab-label' }, label),
    );
    subBar.append(
      mkSubBtn('agent',    agentIconNode(), t('issue.subtab.agent')),
      mkSubBtn('branches', '🌿', t('issue.subtab.branches')),
      mkSubBtn('stashes',  '💾', t('issue.subtab.stashes')),
    );
    // The sub-tab row holds: [icon-tabs][flex-grow gap][action slot].
    // Both the strip and the slot live on the SAME horizontal line.
    const subRow = h('div', { class: 'issue-subtab-row' },
      subBar, subActions);

    const branchesPanel = buildBranchesPanel();
    branchesPanel.id = `issue-sub-branches-${cssId(issueObj.issue)}`;
    if (subActive !== 'branches') branchesPanel.style.display = 'none';

    const agentPanel = buildAgentPanel(issueObj);
    agentPanel.id = `issue-sub-agent-${cssId(issueObj.issue)}`;
    if (subActive !== 'agent') agentPanel.style.display = 'none';

    if (subActive !== 'stashes') stashesPanel.style.display = 'none';

    // Initial population of the right-side slot — must happen AFTER
    // agentPanel is built since refreshSubActions hoists the
    // agent panel's controlsRow into the slot.
    refreshSubActions();

    // Wrap the sub-tab row + panels in a flex column so the strip
    // sits at the top and the content takes all remaining height.
    // The .agent-fullscreen class is mirrored from the panel onto the
    // wrap so fullscreen mode pins the WRAP (which contains the
    // sub-tab row with the hoisted controlsRow) rather than just the
    // panel — without this the controls would be hidden behind the
    // fixed-position panel.
    const bodyWrap = h('div', {
      class: 'issue-body-wrap'
              + (fullscreenMode ? ' agent-fullscreen' : ''),
    },
      subRow,
      h('div', { class: 'issue-body-content' },
        branchesPanel, agentPanel, stashesPanel),
    );
    section.append(bodyWrap);

    refreshExpandLabel();
    return section;
  }

  // Issue keys can contain '/' (e.g. "man-remove_maven_formatter/foo")
  // which is invalid in an id; remap to '-'.
  function cssId(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '-');
  }

  // Inline SVG replacement for the 🤖 emoji — the pixel-art agent
  // mascot used as the brand icon. Body fill is the canonical Claude
  // Code mascot brown (#b9694f) regardless of the surrounding text
  // color, so the icon stays recognisable in both light and dark
  // dashboard themes. Eyes are a fixed dark fill so the face reads.
  function agentIconNode(extraClass) {
    const xmlns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(xmlns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 14');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class',
      'agent-icon-svg' + (extraClass ? ' ' + extraClass : ''));
    const BROWN = '#b9694f';
    const parts = [
      [4,  1, 12, 6,  BROWN],            // head
      [1,  6, 18, 2,  BROWN],            // belt / arms
      [4,  8, 12, 2,  BROWN],            // lower body
      [6, 10, 2,  3,  BROWN],            // left leg
      [12, 10, 2, 3,  BROWN],            // right leg
      [7,  3, 1,  2,  '#1a1a1a'],        // left eye
      [12, 3, 1,  2,  '#1a1a1a'],        // right eye
    ];
    for (const [x, y, w, h_, fill] of parts) {
      const el = document.createElementNS(xmlns, 'rect');
      el.setAttribute('x', x); el.setAttribute('y', y);
      el.setAttribute('width', w); el.setAttribute('height', h_);
      el.setAttribute('fill', fill);
      svg.appendChild(el);
    }
    return svg;
  }

  // Per-issue Map remembering which sub-tab (Branches / Agent) the
  // user last activated. Keyed by issue key. Cleared on full reload —
  // intentional: a fresh page should land you on Branches by default.
  const perIssueAgentSub = new Map();

  // Global fullscreen flag — fullscreen is a single mode, not a
  // per-issue toggle. When on, every Agent panel rendered (or
  // navigated to via ◀/▶) inherits the .agent-fullscreen class so
  // the user stays in fullscreen as they step between issues.
  // Survives renderApp rebuilds so the class re-applies to freshly
  // built panels.
  let fullscreenMode = false;

  // Per-issue state for the inline agent terminal: the open
  // xterm/WebSocket and the last-known server-side session info so
  // the status line + Start/Stop visibility update without a full
  // refresh. One agent per issue (cwd = the issue dir, matching the
  // external Agent button's whole-issue scope).
  const inlineAgentState = new Map();
  // Latest /api/agent/term/sessions snapshot indexed by issue.
  // Populated by ensureAgentPanelHydrated + polling while the Agent
  // sub-tab is active.
  let agentSessionsByKey = {};

  function inlineConsoleOn() {
    const v = prefs.getItem('console-inline-default');
    // Default ON — users who never touched the toggle get the new UX.
    return v === null || v === '' || v === '1';
  }
  function generalAgentOn() {
    const v = prefs.getItem('general-agent-enabled');
    // Default ON — the pinned General Agent tab is the recommended
    // entry point for ad-hoc agent work.
    return v === null || v === '' || v === '1';
  }
  function mcpEnabledOn() {
    const v = prefs.getItem('mcp-enabled');
    // Default ON — surfaces the 📬 badge + Messages button so users
    // see the feature exists. The toggle hides the badge and tells
    // the server to launch agents without the MCP tools registered.
    return v === null || v === '' || v === '1';
  }
  function mailboxAutoPollOn() {
    const v = prefs.getItem('mailbox-auto-poll');
    // Default ON for a fresh install — nudging idle agents about
    // unread mail is what makes the mailbox feel responsive. Users
    // who find the synthetic prompts intrusive can flip the toggle
    // off in Profile → Dashboard.
    return v === null || v === undefined || v === '' || v === '1';
  }
  function autoUpdateCheckOn() {
    const v = prefs.getItem('auto-update-check');
    // Default ON — the banner is informative-only and the actual
    // pull + restart is still gated on the user's confirmation.
    return v === null || v === '' || v === '1';
  }

  function buildAgentPanel(issueObj) {
    const issue = issueObj.issue;
    // Re-apply the fullscreen class if the panel was in that state
    // before a renderApp rebuild — otherwise the class would be
    // silently dropped on every /api/events poll-driven refresh.
    const panel = h('div', {
      class: 'issue-subpanel issue-agent-panel'
        + (fullscreenMode ? ' agent-fullscreen' : ''),
    });

    // Title chip — hidden by default (the issue H2 + tab strip already
    // identify the issue). Shown only in fullscreen where both are
    // covered, so the user can still see which issue they're in.
    // For __agent__ we show "Agent 007" so the chip still has a label
    // to grow with — without it, the chip's flex:1 spacer collapses
    // and the action buttons cluster left instead of right.
    const isGeneral = issue === '__agent__';
    const chipLabel = isGeneral
      ? t('tab.generic-agent')
      : issue;
    const titleChip = h('span', {
      class: 'agent-title-chip',
      title: chipLabel,
    }, h('span', { class: 'agent-title-chip-text' }, chipLabel));

    const statusLine = h('span', {
      class: 'agent-status-line',
      id: `agent-status-${cssId(issue)}`,
    }, t('agent.status.not-running'));

    // --- Controls (lifecycle + connection) ---
    // A single button toggles agent lifecycle: it labels itself
    // "Start" when the agent isn't running and "Stop" when it is.
    // renderAgentControls flips the label / styling / handler
    // dispatch based on the current state, mirroring the existing
    // Disconnect/Reconnect toggle below it.
    const lifecycleBtn = h('button', {
      class: 'btn btn-primary agent-lifecycle-btn',
      id: `agent-lifecycle-${cssId(issue)}`,
      type: 'button',
      onclick: () => {
        const info = agentSessionsByKey[issue];
        if (info && info.alive) stopInlineAgent(issue);
        else                    startInlineAgent(issueObj);
      },
    }, t('agent.controls.start'));
    // Disconnect / Reconnect — same button slot; the label flips
    // based on whether a live WS is attached. Disconnect leaves
    // the server-side pty running so the user can re-attach from
    // any tab without losing the agent's session state. Hidden
    // unless the server reports a live session for this issue.
    const discoBtn = h('button', {
      class: 'btn agent-disco-btn',
      id: `agent-disco-${cssId(issue)}`,
      type: 'button',
      style: { display: 'none' },
      onclick: () => toggleDisconnectAgent(issueObj),
      title: t('agent.controls.disconnect-tip'),
    }, t('agent.controls.disconnect'));
    // External console / Open editor / prev-next nav don't apply to
    // the pinned general Agent tab (no worktree, no issue list to
    // step through). Skip those for __agent__.
    // CSS hides the External button while in fullscreen — the issue
    // head's [Notes][+] pair gets covered by the position:fixed wrap,
    // so we surface a fullscreen-only copy of the Notes controls in
    // its slot (see agent-notes-btn-group below).
    const externalBtn = isGeneral ? null : h('button', {
      class: 'btn agent-external-btn',
      type: 'button',
      title: t('agent.controls.external-tip'),
      onclick: () => openExternalConsole(issue),
    }, t('agent.controls.external'));

    // Fullscreen-only mirror of the issue-head Notes controls. CSS
    // keeps this hidden in normal mode (where the head row is visible
    // and provides the same buttons) and reveals it only when the
    // panel is in fullscreen.
    const notesFsBtnGroup = isGeneral ? null : h('div', {
      class: 'notes-btn-group agent-notes-btn-group',
    },
      h('button', {
        class: 'btn notes-btn hover-popover-host', type: 'button',
        onclick: (e) => { e.preventDefault(); openNotesModal(issue); },
      }, '📝 Notes',
         (issueObj.pending_todos || 0) > 0
           ? h('span', { class: 'notes-btn-count' },
               String(issueObj.pending_todos))
           : null,
         h('div', { class: 'hover-popover' },
           h('div', { class: 'hover-popover-foot' },
             `Open the notes modal for ${issue}.`)),
      ),
      h('button', {
        class: 'btn notes-add-btn hover-popover-host', type: 'button',
        'aria-label': `Add note to ${issue}`,
        onclick: (e) => { e.preventDefault(); openAddNoteDialog(issue); },
      }, '+',
        h('div', { class: 'hover-popover' },
          h('div', { class: 'hover-popover-foot' },
            `Quick-add a note to ${issue}.`)),
      ),
    );

    // 🤖 Agent information — only when the "Show Agent information"
    // pref is on. Opens the same Activity / Messages content
    // claudeAgentSectionFor() renders inline, but as a modal so the
    // terminal pane stays unobstructed.
    const infoBtn = showAgentInfo ? h('button', {
      class: 'btn agent-info-btn',
      type: 'button',
      title: t('agent.controls.info-tip'),
      onclick: () => openAgentInformationModal(issueObj),
    }, agentIconNode('agent-icon-inline'),
       ' ',
       t('agent.controls.info')) : null;

    // ↗ Open — mirror of the issue title-bar Open button. Hidden by
    // CSS unless the panel is in fullscreen (where the title bar is
    // covered, so the user would have no other way to open the
    // worktree dir in their editor).
    const issueDir = (window.__lastState?.worktrees_root || '')
      + '/' + issue;
    const openInEditorBtn = isGeneral ? null : h('button', {
      class: 'btn agent-open-btn',
      type: 'button',
      title: editorPref
        ? `Open ${issueDir} in ${editorPref}`
        : 'Pick an editor in your profile first',
      onclick: () => openFileInEditor(issueDir, '.'),
    }, t('issue.open-issue'));

    // 🔍 Search — floating search overlay on the terminal (Ctrl+F).
    const searchBtn = h('button', {
      class: 'btn btn-inline agent-search-toggle',
      title: t('agent.controls.search-tip'),
      onclick: () => toggleAgentSearch(issue),
    }, t('agent.controls.search'));

    // ⤢ Fullscreen — toggle a "agent-fullscreen" class on the panel
    // so the terminal expands to fill the viewport. Click again to
    // restore (Escape also exits). The button's label flips to "Exit
    // fullscreen" while on. Fullscreen is a global mode (see
    // fullscreenMode); the initial render just mirrors that flag.
    const isFullscreen = fullscreenMode;
    const fullscreenBtn = h('button', {
      class: 'btn agent-fullscreen-btn',
      type: 'button',
      title: t('agent.controls.fullscreen-tip'),
      onclick: () => toggleAgentFullscreen(issue),
    }, isFullscreen
        ? t('agent.controls.fullscreen-exit')
        : t('agent.controls.fullscreen'));

    // ← → previous/next agent panel. The pinned General Agent tab
    // is part of the navigation ring too, so the user can flip
    // between issues and the general agent without leaving the
    // console view (fullscreen state carries across).
    const prevBtn = h('button', {
      class: 'btn agent-nav-btn agent-nav-prev',
      type: 'button',
      title: t('agent.nav.prev-tip'),
      onclick: () => stepIssue(issue, -1),
    }, '◀');
    const nextBtn = h('button', {
      class: 'btn agent-nav-btn agent-nav-next',
      type: 'button',
      title: t('agent.nav.next-tip'),
      onclick: () => stepIssue(issue, +1),
    }, '▶');

    // controlsRow lives as `panel._controlsRow` so refreshSubActions
    // can MOVE it into the sub-tab row's right slot (.issue-subtab-actions).
    // A DOM node only has one parent at a time — moving it out naturally
    // removes it from the panel.
    // 📋 Paste clipboard image — explicit button so the browser's
    const controlsRow = h('div', { class: 'agent-controls' },
      titleChip,
      buildQuickMessageBar(issue),
      statusLine,
      lifecycleBtn,
      discoBtn,
      // External is shown in normal mode; the Notes pair takes its
      // place in fullscreen. CSS in dashboard.css picks which one is
      // visible based on .agent-fullscreen on an ancestor.
      externalBtn,
      notesFsBtnGroup,
      openInEditorBtn,
      infoBtn,
      searchBtn,
      fullscreenBtn,
      // Prev/next sit at the far right, matching the tab-strip's
      // own ◀ / ▶ scroll affordances.
      prevBtn,
      nextBtn,
    );
    panel.append(controlsRow);
    panel._controlsRow = controlsRow;
    // Direct ref so toggleAgentFullscreen / stepIssue can update the
    // label even after refreshSubActions hoists the controlsRow out
    // of the panel into .issue-subtab-actions (panel.querySelector
    // returns null once it's no longer a descendant).
    panel._fullscreenBtn = fullscreenBtn;

    // --- Terminal host (xterm.js attaches here when running) ---
    // CRITICAL: when an xterm is already running for this issue, we
    // MUST reuse its host DOM element across renderApp calls, or
    // the periodic pollNewEvents() → refreshAll(true) rebuild would
    // throw the terminal away every ~10 seconds (any agent hook
    // event triggers a status refresh, which re-renders the panel).
    const cur = inlineAgentState.get(issue) || {};
    // Save the scroll position before re-parenting resets xterm's
    // viewport. viewportY is the absolute index of the visible top
    // row (= buffer.ydisp); baseY (= ybase) is the index that "at
    // bottom" means. We keep both so forceFitLater can restore a
    // relative offset (rows-above-bottom) instead of the absolute
    // viewport row — restoring absolute is wrong once the scrollback
    // grew, and walked the user to the top of the buffer.
    const savedBuf = cur.term?.buffer?.active;
    const savedViewportY = savedBuf?.viewportY ?? null;
    const savedBaseY     = savedBuf?.baseY     ?? null;
    const wasAtBottom    = savedViewportY !== null && savedBaseY !== null
                            && savedViewportY === savedBaseY;
    let termHost;
    if (cur.host && cur.term) {
      // Reuse the existing host; xterm.js is still attached to its
      // children. Just lift it into the new panel.
      termHost = cur.host;
      // Reapply id in case the host was detached and dropped from
      // any document lookups.
      termHost.id = `agent-term-${cssId(issue)}`;
    } else {
      termHost = h('div', {
        class: 'agent-term-host',
        id: `agent-term-${cssId(issue)}`,
      });
      const placeholder = h('div', {
        class: 'agent-term-placeholder',
        id: `agent-term-placeholder-${cssId(issue)}`,
      }, t('agent.terminal.placeholder'));
      termHost.append(placeholder);
    }
    // Search bar — idempotent: only append if not already in the host
    // (reused host elements carry the bar from their first build).
    if (!termHost.querySelector('.agent-search-bar')) {
      termHost.append(buildAgentSearchBar(issue));
    }
    // Drag-and-drop into the xterm host. Idempotent: __dropzoneAttached
    // marker keeps re-renders from stacking listeners on the same host.
    attachDropZone(termHost, issue);
    panel.append(termHost);

    // Agent information is no longer appended inline — it lives in
    // a modal opened from the 🤖 button above (when the
    // "Show Agent information" profile pref is on).

    // After the DOM is mounted (next microtask) hydrate the panel
    // so the status line + Start/Stop reflect the live server
    // session. If a session is already running, auto-reattach —
    // page refresh shouldn't force the user to click anything.
    setTimeout(() => {
      ensureAgentPanelHydrated(issueObj.issue, issueObj);
    }, 0);
    // Force-fit the terminal once layout has settled. ResizeObserver
    // doesn't always fire for display:none → visible transitions,
    // and FitAddon's initial run during term.open() can race the
    // CSS layout. Re-fit twice (next paint and again at 80 ms) so
    // even a slow font measurement catches up. Guarded by the same
    // cols/rows floor as the observer.
    const forceFitLater = () => {
      const cur = inlineAgentState.get(issueObj.issue);
      if (!cur || !cur.fit || !cur.term) return;
      try {
        const p = cur.fit.proposeDimensions?.();
        if (p && p.cols >= 40 && p.rows >= 5 &&
            (p.cols !== cur.term.cols || p.rows !== cur.term.rows)) {
          cur.fit.fit();
          postResize(issueObj.issue, cur.term.cols, cur.term.rows);
        }
      } catch (_) {}
      // Restore scroll after re-parenting. Re-parenting resets xterm's
      // viewport to the top of the buffer. Three cases:
      //  - User was already at the bottom: snap back to bottom. Done
      //    unconditionally because agentSessionsByKey may not be
      //    populated yet on the very first paint, and the old code
      //    fell through to the "restore offset" branch and walked
      //    them to the top.
      //  - Session is alive: same — keep them on the live tail.
      //  - Otherwise: restore the offset FROM THE BOTTOM (not the
      //    absolute row), so scrollback growth between save and
      //    restore doesn't change where they end up.
      const session = agentSessionsByKey[issueObj.issue];
      try {
        if (wasAtBottom || (session && session.alive)) {
          cur.term.scrollToBottom();
        } else if (savedViewportY !== null && savedBaseY !== null) {
          cur.term.scrollToBottom();
          const offsetFromBottom = savedBaseY - savedViewportY;
          if (offsetFromBottom > 0) cur.term.scrollLines(-offsetFromBottom);
        }
      } catch (_) {}
    };
    requestAnimationFrame(() => requestAnimationFrame(forceFitLater));
    setTimeout(forceFitLater, 80);
    setTimeout(forceFitLater, 300);

    return panel;
  }

  // Modal-version of the Agent information block. Reuses
  // claudeAgentSectionFor's <details> rendering but force-opens it.
  function openAgentInformationModal(issueObj) {
    document.getElementById('agent-info-modal')?.remove();
    const close = () =>
      document.getElementById('agent-info-modal')?.remove();
    const isGeneral = issueObj.issue === '__agent__';
    // For the General Agent the modal title is the friendly label
    // ("General Agent") instead of the raw "__agent__" sentinel.
    const titleSubject = isGeneral
      ? t('tab.generic-agent')
      : issueObj.issue;
    const agentData = isGeneral
      ? buildGeneralAgentInfoData(window.__lastState)
      : aggregateAgentData(issueObj);
    const body = h('div', { class: 'agent-info-modal-body' });
    if (isGeneral && !agentData) {
      // No claude history at the General Agent's cwd yet — same
      // friendly note as before so the modal isn't blank.
      body.append(h('div', { class: 'muted', style: { padding: '1rem' } },
        t('agent.info.general-not-tracked')));
    } else if (agentData || (issueObj.pending_events || 0) > 0) {
      const section = claudeAgentSectionFor(
        agentData, issueObj.issue, issueObj.pending_events || 0);
      // Force the <details> open inside the modal so the user
      // doesn't have to click summary first.
      const det = section.querySelector?.('details') || section;
      if (det && det.tagName === 'DETAILS') det.open = true;
      body.append(section);
    } else {
      body.append(h('div', { class: 'muted', style: { padding: '1rem' } },
        t('agent.info.empty')));
    }
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'agent-info-modal',
      onclick: close,
    },
      h('div', { class: 'logs-modal agent-info-modal',
                  role: 'dialog', 'aria-labelledby': 'agent-info-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'agent-info-title' },
            t('agent.info.modal-title', { issue: titleSubject })),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕')),
        body,
      ),
    );
    document.body.append(modal);
  }

  // Build the per-agent mailbox UI (inbox + outbox + compose form)
  // as a self-contained DOM node. Used both inside the General
  // Agent's "Messages" sub-tab and as the body of the per-issue
  // 📬-badge modal. Reads /api/mcp/messages (non-destructive peek
  // — does NOT mark messages read; that happens when the agent
  // itself calls the read_messages MCP tool).
  function buildMessagesPaneFor(agent) {
    const threadList = h('div', { class: 'mcp-msg-list' },
      h('span', { class: 'muted' }, 'loading…'));
    const inboxList = h('div', { class: 'mcp-msg-list',
                                   style: { display: 'none' } });
    const outboxList = h('div', { class: 'mcp-msg-list',
                                    style: { display: 'none' } });
    // Thread view: set of conversation-root ids the user has
    // collapsed. When a root is in here, its descendants are
    // hidden and the root shows a "+N replies" chip the user can
    // click to expand again. Persists across the 4s auto-reload.
    const collapsedThreads = new Set();
    // Last-seen root ids so the pane-head Expand-all button can
    // flip "all collapsed" ↔ "all expanded" without re-deriving.
    let lastThreadRootIds = [];

    function activate(which) {
      tabThread.classList.toggle('active', which === 'thread');
      tabInbox.classList.toggle('active', which === 'inbox');
      tabOutbox.classList.toggle('active', which === 'outbox');
      threadList.style.display = which === 'thread' ? '' : 'none';
      inboxList.style.display = which === 'inbox' ? '' : 'none';
      outboxList.style.display = which === 'outbox' ? '' : 'none';
    }

    const tabThread = h('button', {
      class: 'btn btn-inline active',
      onclick: () => activate('thread'),
    }, t('mcp.tab.thread'));
    const tabInbox = h('button', {
      class: 'btn btn-inline',
      onclick: () => activate('inbox'),
    }, t('mcp.tab.inbox'));
    const tabOutbox = h('button', {
      class: 'btn btn-inline',
      onclick: () => activate('outbox'),
    }, t('mcp.tab.outbox'));

    // Client-side message search: case-insensitive substring match
    // against the body text, the from/to agent ids, the kind label,
    // and any ref in the payload. Filtering re-runs renderList on
    // the cached _items per side so the search applies whichever
    // tab is active. Empty input = no filter.
    let searchTerm = '';
    const _itemsBySide = { thread: [], inbox: [], outbox: [] };
    const matches = (m) => {
      if (!searchTerm) return true;
      const hay = [
        m.payload?.text, m.payload?.context, m.payload?.ref,
        m.from, m.to, m.kind,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(searchTerm);
    };
    function applyFilter() {
      renderList(threadList, _itemsBySide.thread.filter(matches), 'thread');
      renderList(inboxList,  _itemsBySide.inbox.filter(matches),  'inbox');
      renderList(outboxList, _itemsBySide.outbox.filter(matches), 'outbox');
      // Re-attach the inline compose row to the target message
      // after every render — the lists were just replaced, so
      // the previous in-row compose is gone.
      try { positionCompose(); } catch (_) {}
    }
    const searchInput = h('input', {
      type: 'search', class: 'mcp-search',
      placeholder: t('mcp.search.placeholder'),
      oninput: (e) => {
        searchTerm = (e.target.value || '').trim().toLowerCase();
        applyFilter();
      },
    });

    // Hard combobox (<select>) of every known agent — issue keys
    // from state.issues + the '__agent__' sentinel for the General
    // Agent. The calling agent is filtered out (no self-mail).
    // Disabled placeholder as the first option so the user has to
    // pick before Send becomes meaningful.
    const issues = (window.__lastState?.issues || [])
      .map((i) => i.issue).filter(Boolean);
    const known = ['__agent__', ...issues]
      .filter((id) => id !== agent);
    // Special pseudo-recipient that triggers a broadcast instead of
    // a regular send_message. Internal value: '__broadcast__';
    // the send button checks for it before issuing the MCP call.
    const toInput = h('select', { class: 'mcp-compose-to' },
      h('option', { value: '', disabled: '', selected: '' },
        '— pick agent —'),
      h('option', { value: '__broadcast__' },
        '📢 ' + t('mcp.broadcast-option')),
      ...known.map((id) => h('option', { value: id },
        id === '__agent__' ? t('tab.generic-agent') : id)));
    const bodyInput = h('input', {
      type: 'text',
      placeholder: t('mcp.compose'),
      class: 'mcp-compose-body',
    });
    // When the user hits Reply on a message, we stash its id here
    // so the next send_message call sets in_reply_to. A small chip
    // above the compose row shows the user what they're replying
    // to (with a ✕ to clear).
    let replyTo = null;
    const replyChipHost = h('div', { class: 'mcp-reply-chip-host',
                                      style: { display: 'none' } });
    function setReplyTo(mid) {
      replyTo = mid;
      replyChipHost.replaceChildren();
      if (!mid) {
        replyChipHost.style.display = 'none';
      } else {
        replyChipHost.style.display = '';
        replyChipHost.append(
          h('span', { class: 'mcp-reply-chip' },
            `↩ replying to #${mid}`,
            h('button', {
              class: 'btn btn-inline mcp-reply-clear',
              title: 'Clear reply',
              onclick: () => setReplyTo(null),
            }, '✕'),
          ),
        );
      }
      // Move the compose row inline (or back) to reflect the new
      // reply target. Wrapped in try because positionCompose is
      // declared after this fn in source order — the closure
      // resolves at call time, so it's safe.
      try { positionCompose(); } catch (_) {}
    }
    const sendBtn = h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const to = (toInput.value || '').trim();
        const text = (bodyInput.value || '').trim();
        if (!to || !text) return;
        sendBtn.disabled = true;
        try {
          // Broadcast path — picker reads __broadcast__: fan out
          // to every live issue agent via the broadcast_message
          // MCP tool. Confirm first so an accidental click can be
          // backed out.
          if (to === '__broadcast__') {
            let live = [];
            try {
              const r = await fetch('/api/agent/term/sessions');
              const d = await r.json();
              live = (d.sessions || [])
                .map((s) => s.issue)
                .filter((s) => s !== '__agent__' && s !== agent);
            } catch (_) { /* network — let server decide */ }
            if (!live.length) {
              window.alert(t('mcp.broadcast-empty'));
              return;
            }
            const ok = window.confirm(t('mcp.broadcast-confirm',
              { n: live.length, agents: live.join(', ') }));
            if (!ok) return;
            await fetch(`/mcp?agent=${encodeURIComponent(agent)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: Date.now(),
                method: 'tools/call',
                params: { name: 'broadcast_message',
                          arguments: { text } },
              }),
            });
            bodyInput.value = '';
            setReplyTo(null);
            await reload();
            return;
          }
          // Regular single-recipient send.
          const args = { to, text };
          if (replyTo) args.in_reply_to = replyTo;
          const r = await fetch(`/mcp?agent=${encodeURIComponent(agent)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: Date.now(),
              method: 'tools/call',
              params: { name: 'send_message', arguments: args },
            }),
          });
          // Surface MCP tool errors (e.g. unknown recipient) — the
          // server returns 200 with isError=true in the result.
          try {
            const d = await r.json();
            const block = d?.result?.content?.[0];
            if (d?.result?.isError && block?.text) {
              window.alert(block.text);
              return;
            }
          } catch (_) { /* non-JSON or parse fail — continue */ }
          bodyInput.value = '';
          setReplyTo(null);
          await reload();
        } finally {
          sendBtn.disabled = false;
        }
      },
    }, t('mcp.send'));

    // Display label for an agent id. The General Agent's sentinel
    // (`__agent__`) is an implementation detail — show its friendly
    // name in every from / to / reply chip.
    const labelFor = (id) =>
      id === '__agent__' ? t('tab.generic-agent') : (id || '?');

    function renderList(target, items, side) {
      if (!items.length) {
        target.replaceChildren(h('span', { class: 'muted' },
          t('mcp.empty')));
        return;
      }
      // Thread view: group each root with its descendants so a
      // reply renders directly under its parent. Roots are sorted
      // newest-first; replies inside a thread stay chronological
      // (oldest-first) so the conversation reads top-to-bottom
      // within each block. Collapsed roots show only themselves
      // with a "+N replies" chip; expanded ones show the whole
      // subtree.
      const byId = new Map();
      const threadDescendantCount = new Map();  // rootId -> N
      let threadRootIds = [];
      if (side === 'thread') {
        for (const m of items) byId.set(m.id, m);
        const children = new Map();   // parent_id -> [child, …]
        const roots = [];
        for (const m of items) {
          const parentId = m.in_reply_to;
          if (parentId && byId.has(parentId)) {
            if (!children.has(parentId)) children.set(parentId, []);
            children.get(parentId).push(m);
          } else {
            roots.push(m);
          }
        }
        for (const arr of children.values()) {
          arr.sort((a, b) => a.created_at - b.created_at);
        }
        roots.sort((a, b) => b.created_at - a.created_at);  // newest thread first
        const ordered = [];
        const seen = new Set();
        const walk = (m, rootId) => {
          if (seen.has(m.id)) return;  // safety: cycles, dupes
          seen.add(m.id);
          ordered.push(m);
          for (const c of (children.get(m.id) || [])) walk(c, rootId);
        };
        const walkCount = (m) => {
          let n = 0;
          for (const c of (children.get(m.id) || [])) {
            n += 1 + walkCount(c);
          }
          return n;
        };
        threadRootIds = roots.map((r) => r.id);
        lastThreadRootIds = threadRootIds;
        for (const r of roots) {
          threadDescendantCount.set(r.id, walkCount(r));
          if (collapsedThreads.has(r.id)) {
            // Collapsed: emit just the root.
            ordered.push(r);
            seen.add(r.id);
          } else {
            walk(r, r.id);
          }
        }
        items = ordered;
      }
      const depthOf = (m) => {
        let depth = 0; let cur = m;
        const seen = new Set();
        while (cur && cur.in_reply_to && byId.has(cur.in_reply_to)
                && !seen.has(cur.id)) {
          seen.add(cur.id);
          cur = byId.get(cur.in_reply_to);
          depth++;
          if (depth > 10) break;  // safety
        }
        return depth;
      };
      target.replaceChildren(...items.map((m) => {
        // In Inbox we always look at `from`, in Outbox always `to`.
        // In Thread the row's direction depends on whether `agent`
        // is the sender or recipient of THIS message.
        let who; let arrow; let isOutgoing;
        if (side === 'thread') {
          isOutgoing = m.from === agent;
          who = labelFor(isOutgoing ? m.to : m.from);
          arrow = isOutgoing ? '→' : '←';
        } else {
          isOutgoing = side === 'outbox';
          who = labelFor(side === 'inbox' ? m.from : m.to);
          arrow = side === 'inbox' ? '←' : '→';
        }
        const kindLabel = t('mcp.kind.' + (m.kind || 'message'))
          || (m.kind || 'message');
        const text = (m.payload?.text || m.payload?.context || '');
        const ref = m.payload?.ref;
        const when = m.created_at
          ? new Date(m.created_at * 1000).toLocaleString()
          : '';
        const unreadCls = (side === 'inbox' && !m.read_at)
          ? ' mcp-msg-unread' : '';
        // ↩ Reply: only on INCOMING rows (no point replying to
        // yourself). Pre-fills the compose form's "to" with the
        // sender, stashes the message id in replyTo so
        // send_message threads it via in_reply_to, focuses the
        // body. Patches the picker if the sender has disappeared
        // from state.issues so the reply target stays selectable.
        const showReply = (side === 'inbox')
          || (side === 'thread' && !isOutgoing);
        const replyBtn = showReply ? h('button', {
          class: 'btn btn-inline mcp-msg-action',
          title: 'Reply to this message',
          onclick: () => {
            const sender = m.from;
            if (sender) {
              let opt = Array.from(toInput.options)
                .find((o) => o.value === sender);
              if (!opt) {
                opt = h('option', { value: sender }, sender);
                toInput.append(opt);
              }
              toInput.value = sender;
            }
            setReplyTo(m.id);
            try { bodyInput.focus(); } catch (_) {}
          },
        }, '↩') : null;
        // ✕ Delete — hard delete via POST /api/mcp/delete. When
        // the row is part of a thread (in_reply_to set or has
        // child replies in the current conversation set) we ask
        // the user whether to delete just this row or the whole
        // conversation. The thread view's full message set is the
        // source of truth for "is this part of a thread?" — we
        // search lastItems.thread for descendants by id chain.
        function threadSize(id) {
          const all = (_itemsBySide.thread || []);
          const idx = new Map(all.map((x) => [x.id, x]));
          // Walk up to the root.
          let root = id;
          let seen = new Set();
          while (root) {
            if (seen.has(root)) break;
            seen.add(root);
            const node = idx.get(root);
            if (!node || node.in_reply_to == null) break;
            if (!idx.has(node.in_reply_to)) break;
            root = node.in_reply_to;
          }
          // BFS down from root.
          const out = new Set([root]);
          const stack = [root];
          while (stack.length) {
            const cur = stack.pop();
            for (const x of all) {
              if (x.in_reply_to === cur && !out.has(x.id)) {
                out.add(x.id); stack.push(x.id);
              }
            }
          }
          return out.size;
        }
        const delBtn = h('button', {
          class: 'btn btn-inline mcp-msg-action mcp-msg-del',
          title: 'Delete this message',
          onclick: async () => {
            const inThread = (m.in_reply_to != null)
              || (_itemsBySide.thread || []).some(
                  (x) => x.in_reply_to === m.id);
            let url = '/api/mcp/delete';
            if (inThread) {
              const choice = await confirmThreadDelete(threadSize(m.id));
              if (choice === 'cancel') return;
              if (choice === 'thread') url = '/api/mcp/delete-thread';
            }
            try {
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: m.id }),
              });
              await reload();
            } catch (_) { /* leave row in place on failure */ }
          },
        }, '✕');
        // Threading indicator: when a row replies to another
        // message (in_reply_to set), show a small chip that links
        // back. Clicking it scrolls + highlights the parent row.
        const parent = m.in_reply_to;
        const replyChip = parent ? h('span', {
          class: 'mcp-msg-parent', title: `Jump to message #${parent}`,
          role: 'button', tabindex: '0',
          onclick: () => {
            const el = document.getElementById(`mcp-msg-${parent}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('mcp-msg-flash');
              setTimeout(() => el.classList.remove('mcp-msg-flash'), 1400);
            }
          },
        }, `↪ in reply to #${parent}`) : null;
        // When this row is a conversation root in thread view,
        // show a +N/−N chip that toggles the collapsed state of
        // its sub-tree. The pane-head Expand-all button drives
        // the same `collapsedThreads` Set.
        const isRoot = side === 'thread' && threadDescendantCount.has(m.id);
        const descN = isRoot ? threadDescendantCount.get(m.id) : 0;
        const isCollapsed = isRoot && collapsedThreads.has(m.id);
        const threadToggleChip = (isRoot && descN > 0) ? h('span', {
          class: 'mcp-thread-toggle',
          role: 'button', tabindex: '0',
          title: isCollapsed
            ? `Expand thread (${descN} more)` : 'Collapse thread',
          onclick: (e) => {
            e.stopPropagation();
            if (isCollapsed) collapsedThreads.delete(m.id);
            else            collapsedThreads.add(m.id);
            applyFilter();
          },
        }, isCollapsed ? `+${descN} replies` : `−${descN}`) : null;
        const depth = side === 'thread' ? depthOf(m) : 0;
        const dirCls = side === 'thread'
          ? (isOutgoing ? ' mcp-msg-out' : ' mcp-msg-in')
          : '';
        return h('div', {
          class: 'mcp-msg-row' + unreadCls + dirCls,
          id: `mcp-msg-${m.id}`,
          style: depth > 0
            ? { marginLeft: `${Math.min(depth, 6) * 1.2}rem` }
            : null,
        },
          h('div', { class: 'mcp-msg-head' },
            h('span', { class: 'mcp-msg-kind' }, kindLabel),
            h('span', { class: 'mcp-msg-who' },
              `${arrow} ${who}`),
            ref ? h('span', { class: 'mcp-msg-ref' },
              `[${ref}]`) : null,
            replyChip,
            threadToggleChip,
            h('span', { class: 'muted', style: { marginLeft: 'auto' } },
              when),
            replyBtn, delBtn,
          ),
          text ? h('div', { class: 'mcp-msg-body' }, text) : null,
        );
      }));
    }

    async function reload() {
      try {
        const enc = encodeURIComponent(agent);
        const [inboxR, outboxR, threadR] = await Promise.all([
          fetch(`/api/mcp/messages?agent=${enc}&direction=inbox`,
                  { cache: 'no-store' }),
          fetch(`/api/mcp/messages?agent=${enc}&direction=outbox`,
                  { cache: 'no-store' }),
          fetch(`/api/mcp/messages?agent=${enc}&direction=thread`,
                  { cache: 'no-store' }),
        ]);
        const inboxD = await inboxR.json();
        const outboxD = await outboxR.json();
        const threadD = await threadR.json();
        _itemsBySide.inbox  = inboxD.messages || [];
        _itemsBySide.outbox = outboxD.messages || [];
        _itemsBySide.thread = threadD.messages || [];
        applyFilter();
      } catch (err) {
        threadList.replaceChildren(
          h('span', { class: 'muted' }, 'Failed to load: ' + err));
      }
    }

    // Expand/collapse-all-conversations toggle — only meaningful
    // in the Thread view, where each root has descendants worth
    // hiding. Click flips "all expanded" ↔ "all collapsed" for
    // every conversation in the current list.
    const expandConvBtn = h('button', {
      class: 'btn btn-inline mcp-thread-expand-btn',
      title: 'Expand or collapse all conversations',
      onclick: () => {
        const allCollapsed = lastThreadRootIds.length > 0
          && lastThreadRootIds.every((id) => collapsedThreads.has(id));
        if (allCollapsed) {
          collapsedThreads.clear();
        } else {
          for (const id of lastThreadRootIds) collapsedThreads.add(id);
        }
        applyFilter();
      },
    }, '⊞');
    const deleteAllBtn = h('button', {
      class: 'btn btn-inline mcp-msg-del',
      title: 'Delete all messages',
      onclick: async () => {
        if (!window.confirm('Delete all messages? This cannot be undone.')) return;
        try {
          await fetch('/api/mcp/delete-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent }),
          });
          await reload();
        } catch (_) {}
      },
    }, '🗑 Delete all');
    // Controls hoisted into the sub-tab row's action slot by
    // refreshSubActions when the Messages tab is active.
    const msgControlsRow = h('div', { class: 'messages-controls' },
      searchInput,
      h('div', { class: 'mcp-filter-group' },
        tabThread, tabInbox, tabOutbox),
      expandConvBtn,
      h('button', { class: 'btn btn-inline',
                    onclick: () => reload() }, '↻'),
      deleteAllBtn,
    );
    // Named compose row so positionCompose() can move it between
    // its default home (top of the pane) and an inline slot
    // under whatever message the user is replying to.
    const composeRow = h('div', { class: 'mcp-compose' },
      toInput, bodyInput, sendBtn);
    const pane = h('div', { class: 'mcp-pane' },
      // Compose pinned at top; when ↩ Reply is clicked, the compose
      // row is detached and re-appended inside the message row.
      composeRow,
      replyChipHost,
      h('div', { class: 'mcp-msg-body-wrap' },
        threadList, inboxList, outboxList),
    );
    pane._controlsRow = msgControlsRow;

    function positionCompose() {
      if (replyTo) {
        const rowEl = document.getElementById(`mcp-msg-${replyTo}`);
        if (rowEl && rowEl.isConnected) {
          if (!rowEl.contains(composeRow)) {
            rowEl.append(composeRow);
            composeRow.classList.add('mcp-compose-inline');
            // The "↩ replying to #N" chip is redundant when the
            // compose row is physically under the message — hide
            // it to free vertical space.
            replyChipHost.style.display = 'none';
          }
          return;
        }
      }
      // Default home: directly after the header.
      if (composeRow.parentElement !== pane) {
        header.after(composeRow);
        composeRow.classList.remove('mcp-compose-inline');
      }
      replyChipHost.style.display = '';
    }
    // Expose reload so callers (modal close/reopen, status refresh)
    // can re-fetch without rebuilding the DOM.
    pane.reloadMessages = reload;
    reload();
    // Light polling so agent-originated traffic appears without
    // the user clicking ↻. Self-clears once the pane leaves the
    // DOM (panel rebuilds, modal closes, etc.) so we never leak
    // an interval. 4s feels close to "instant" without hammering
    // SQLite — every tick is two cheap SELECTs.
    const pollId = setInterval(() => {
      if (!pane.isConnected) {
        clearInterval(pollId);
        return;
      }
      reload();
    }, 4000);
    return pane;
  }

  // Per-agent mailbox modal — used when the 📬 badge on an issue tab
  // is clicked. The General Agent surfaces the same UI as a sub-tab
  // inside its panel (see buildGeneralAgentPanel), so this modal is
  // the path used for issue agents that don't have a sub-tab strip.
  function openAgentMessagesModal(agent) {
    if (!agent) return;
    document.getElementById('agent-messages-modal')?.remove();
    const close = () =>
      document.getElementById('agent-messages-modal')?.remove();
    const isGeneral = agent === '__agent__';
    const subject = isGeneral ? t('tab.generic-agent') : agent;
    const pane = buildMessagesPaneFor(agent);
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'agent-messages-modal',
      onclick: close,
    },
      h('div', { class: 'logs-modal',
                  role: 'dialog', 'aria-labelledby': 'agent-messages-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'agent-messages-title' },
            `📬 ${t('tab.messages')} — ${subject}`),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: close }, '✕'),
        ),
        pane,
      ),
    );
    document.body.append(modal);
  }

  // Git-stash pane for the General Agent → Stashes sub-tab. Lists
  // every stash across primary repos (--primaries root). Adding
  // stashes is intentionally left to the agent (git stash push in
  // the relevant worktree); the dashboard only surfaces / inspects
  // / drops. Polls every 5s while visible so an agent-pushed
  // stash appears without the user clicking ↻.
  function buildStashesPaneFor(opts) {
    // Optional per-issue scoping: when issueFilter is set, only
    // stashes whose branch matches the issue key (exact, or with
    // a `_v2` / `+` suffix variant) are shown. Used by the per-
    // issue tab so the sub-tab is automatically narrowed to that
    // issue's worktree branch.
    const issueFilter = (opts && opts.issueFilter) || '';
    const matchesIssue = issueFilter
      ? new RegExp('^' + issueFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                   + '(?:[_+].*)?$')
      : null;
    const listEl = h('div', { class: 'mcp-msg-list' },
      h('span', { class: 'muted' }, 'loading…'));

    // Inline expand state — keyed by `${repo}\x1f${ref}` so a row's
    // open/closed status survives the 5-second reload. The file
    // list is cached in fileCache the first time the user opens
    // it, so re-expanding the same row never re-hits the server.
    const expandedKey = new Set();
    const fileCache = new Map();
    function rowKey(repo, ref) { return repo + '\x1f' + ref; }
    // Per-pane filters. Persist across the 5-second auto-reload
    // (only the list content is re-rendered, not the inputs).
    let repoFilter = '';
    let searchTerm = '';
    let lastItems = [];   // last successful fetch — drives the picker

    function renderStashFiles(holder, repo, ref) {
      holder.replaceChildren(
        h('span', { class: 'muted' }, 'loading…'));
      const cached = fileCache.get(rowKey(repo, ref));
      const apply = (data) => {
        if (data && data.error) {
          holder.replaceChildren(h('span', { class: 'muted' },
            'Error: ' + data.error));
          return;
        }
        const files = (data && data.files) || [];
        if (!files.length) {
          holder.replaceChildren(h('span', { class: 'muted' },
            t('stashes.empty')));
          return;
        }
        holder.replaceChildren(...files.map((f) => {
          const addedTxt = f.added == null
            ? t('stashes.binary')
            : t('stashes.added', { n: f.added });
          const removedTxt = f.removed == null
            ? null
            : t('stashes.removed', { n: f.removed });
          return h('div', { class: 'stash-file-row' },
            h('span', { class: 'stash-file-path' }, f.path),
            h('span', { style: { marginLeft: 'auto' } },
              f.added == null
                ? h('span', { class: 'muted' }, addedTxt)
                : h('span', { class: 'stash-added' }, addedTxt)),
            removedTxt
              ? h('span', { class: 'stash-removed' }, removedTxt)
              : null,
          );
        }));
      };
      if (cached) { apply(cached); return; }
      fetch(`/api/stashes/show?repo=${encodeURIComponent(repo)}`
              + `&ref=${encodeURIComponent(ref)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { fileCache.set(rowKey(repo, ref), d); apply(d); })
        .catch((err) => {
          holder.replaceChildren(h('span', { class: 'muted' },
            'Failed to load: ' + err));
        });
    }

    function row(s) {
      const repo = s.repo || '?';
      const ref = s.ref || '?';
      const key = rowKey(repo, ref);
      const when = s.date
        ? new Date(s.date).toLocaleString()
        : '';
      const filesHolder = h('div', { class: 'stash-files' });
      const isOpen = () => expandedKey.has(key);
      const toggleBtn = h('button', {
        class: 'btn btn-inline mcp-msg-action stash-toggle',
        title: t('stashes.view'),
        onclick: () => {
          if (isOpen()) {
            expandedKey.delete(key);
            filesHolder.replaceChildren();
            filesHolder.style.display = 'none';
            toggleBtn.textContent = '+';
          } else {
            expandedKey.add(key);
            filesHolder.style.display = '';
            toggleBtn.textContent = '−';
            renderStashFiles(filesHolder, repo, ref);
          }
        },
      }, isOpen() ? '−' : '+');
      const dropBtn = h('button', {
        class: 'btn btn-inline mcp-msg-action mcp-msg-del',
        title: t('stashes.drop'),
        onclick: async () => {
          const ok = window.confirm(
            t('stashes.confirm-drop', { ref, repo }));
          if (!ok) return;
          try {
            await fetch('/api/stashes/drop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo, ref }),
            });
            expandedKey.delete(key);
            fileCache.delete(key);
            await reload();
          } catch (_) { /* leave row in place on failure */ }
        },
      }, '✕');
      // If the row was open before a reload, restore that state on
      // the new DOM node (cached file list hits avoid the refetch).
      if (isOpen()) {
        filesHolder.style.display = '';
        renderStashFiles(filesHolder, repo, ref);
      } else {
        filesHolder.style.display = 'none';
      }
      // Two-column row: toggle on the left, everything else in the
      // right column. The message moves into the head row right
      // after the branch chip — saves a line of vertical space.
      // Long messages truncate with ellipsis; full text shows via
      // title= on hover.
      return h('div', { class: 'mcp-msg-row stash-row' },
        toggleBtn,
        h('div', { class: 'stash-row-body' },
          h('div', { class: 'mcp-msg-head' },
            h('span', { class: 'mcp-msg-kind' }, repo),
            h('span', { class: 'mcp-msg-who' }, ref),
            s.branch ? h('span', { class: 'mcp-msg-ref' },
              'on ' + s.branch) : null,
            s.message ? h('span', {
              class: 'stash-msg', title: s.message,
            }, s.message) : null,
            h('span', { class: 'muted stash-date' }, when),
            dropBtn,
          ),
          filesHolder,
        ),
      );
    }

    // Free-text search — substring match against message, ref,
    // branch and repo. Empty input = no filter.
    const searchInput = h('input', {
      type: 'search', class: 'mcp-search stash-search',
      placeholder: t('mcp.search.placeholder'),
      oninput: (e) => {
        searchTerm = (e.target.value || '').trim().toLowerCase();
        renderList();
      },
    });
    // Repo picker — populated from whatever repos appear in the
    // last fetch. Selecting one filters the list to just that
    // repo; "(all repos)" clears the filter. Rebuilt on every
    // reload so a freshly-pushed stash from a new repo shows up.
    const repoPicker = h('select', { class: 'mcp-search stash-repo-pick',
      onchange: (e) => {
        repoFilter = e.target.value || '';
        renderList();
      },
    });

    function rebuildRepoPicker() {
      const sourceItems = matchesIssue
        ? (lastItems || []).filter(
            (s) => matchesIssue.test(s.branch || ''))
        : (lastItems || []);
      const repos = Array.from(new Set(
        sourceItems.map((s) => s.repo).filter(Boolean))).sort();
      repoPicker.replaceChildren(
        h('option', { value: '' }, '— all repos —'),
        ...repos.map((r) =>
          h('option', { value: r, ...(r === repoFilter
                                          ? { selected: '' } : {}) }, r)),
      );
      // If the previously-selected repo is no longer present
      // (last stash dropped), reset back to "all".
      if (repoFilter && !repos.includes(repoFilter)) {
        repoFilter = '';
        repoPicker.value = '';
      }
    }

    function matchesSearch(s) {
      if (!searchTerm) return true;
      const hay = [s.repo, s.ref, s.branch, s.message]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(searchTerm);
    }
    function renderList() {
      const items = lastItems.filter((s) =>
        (!matchesIssue || matchesIssue.test(s.branch || '')) &&
        (!repoFilter || s.repo === repoFilter) &&
        matchesSearch(s));
      if (!items.length) {
        listEl.replaceChildren(h('span', { class: 'muted' },
          t('stashes.empty')));
        return;
      }
      listEl.replaceChildren(...items.map(row));
    }

    async function reload() {
      try {
        const r = await fetch('/api/stashes', { cache: 'no-store' });
        const d = await r.json();
        lastItems = d.stashes || [];
        rebuildRepoPicker();
        renderList();
      } catch (err) {
        listEl.replaceChildren(h('span', { class: 'muted' },
          'Failed to load: ' + err));
      }
    }

    // Controls hoisted into the sub-tab row's action slot by
    // refreshSubActions when the Stashes tab is active.
    const stashControlsRow = h('div', { class: 'stashes-controls' },
      searchInput,
      repoPicker,
      h('button', { class: 'btn btn-inline',
                    onclick: () => reload() }, '↻'),
    );

    const pane = h('div', { class: 'mcp-pane' },
      h('div', { class: 'mcp-msg-body-wrap' }, listEl),
    );
    pane._controlsRow = stashControlsRow;
    pane.reloadStashes = reload;
    // Bulk expand/collapse — used by the issue head's Expand-all
    // button when the Stashes sub-tab is the active one. We mark
    // every currently-visible row as expanded (or closed), then
    // toggle the matching DOM rows so file lists appear/disappear
    // without rebuilding the list.
    pane.expandAllStashes = (open) => {
      const list = listEl;
      const rows = list.querySelectorAll('.mcp-msg-row.stash-row');
      rows.forEach((row) => {
        const toggle = row.querySelector('.stash-toggle');
        if (!toggle) return;
        const isOpen = toggle.textContent === '−';
        if (open === isOpen) return;
        toggle.click();
      });
    };
    pane.anyStashCollapsed = () => {
      const rows = listEl.querySelectorAll(
        '.mcp-msg-row.stash-row .stash-toggle');
      return Array.from(rows).some((b) => b.textContent !== '−');
    };
    reload();
    // Self-clearing poll while the pane is in the DOM.
    const pollId = setInterval(() => {
      if (!pane.isConnected) { clearInterval(pollId); return; }
      reload();
    }, 5000);
    return pane;
  }

  // Apply the .agent-fullscreen class (or remove it) to a single
  // panel, its containing wrap, and its fullscreen button label.
  // Used both when entering fullscreen on the current panel and when
  // stepping into a new one while the mode is already on.
  function applyFullscreenClasses(panel, on) {
    if (!panel) return;
    panel.classList.toggle('agent-fullscreen', on);
    const wrap = panel.closest('.issue-body-wrap');
    if (wrap) wrap.classList.toggle('agent-fullscreen', on);
    const btn = panel._fullscreenBtn;
    if (btn) {
      btn.textContent = on
        ? t('agent.controls.fullscreen-exit')
        : t('agent.controls.fullscreen');
    }
  }

  // Wipe the class off every panel/wrap that still has it (the user
  // may have stepped between multiple issues while in fullscreen, so
  // several DOM nodes may be carrying it) and reset every fullscreen
  // button's label back to "Fullscreen".
  function clearAllFullscreenClasses() {
    document.querySelectorAll('.agent-fullscreen').forEach((el) =>
      el.classList.remove('agent-fullscreen'));
    document.querySelectorAll('.agent-fullscreen-btn').forEach((b) => {
      b.textContent = t('agent.controls.fullscreen');
    });
  }

  // Snap an agent's xterm viewport to the bottom AND focus it so the
  // user can type immediately. The naïve "call scrollToBottom() a few
  // times on timers" approach we tried before kept missing the case
  // where this fix matters most: the host was still display:none (or
  // had just become visible but layout hadn't run), so
  // xterm-viewport had no scrollable area yet. scrollToBottom()
  // updates the buffer's internal ydisp = ybase, but
  // xterm-viewport.scrollTop can't be set meaningfully when
  // scrollHeight === clientHeight. When layout eventually runs,
  // ydisp is at bottom (content renders correctly) but scrollTop is
  // still 0. They're DESYNCED: the user sees the bottom, but the
  // first wheel event syncs ydisp from scrollTop=0 and jumps the
  // buffer to the top of scrollback.
  //
  // The new approach verifies state before declaring success:
  //   1. Wait until host.clientHeight > 0 AND xterm-viewport's
  //      scrollHeight > clientHeight (i.e. it actually has scroll
  //      range — otherwise scrollToBottom is a no-op).
  //   2. Call term.scrollToBottom() AND directly set
  //      viewport.scrollTop = scrollHeight (belt-and-suspenders).
  //   3. Verify viewportY === baseY (internal) AND
  //      scrollTop is at the bottom within 2 px (DOM).
  //   4. Re-arm on the next animation frame until verified or the
  //      time budget runs out (≈ 2 s).
  function snapAgentTermToBottom(issue) {
    const cur = inlineAgentState.get(issue);
    if (!cur || !cur.term || !cur.host) {
      scrollLog(issue, 'snap: no state, abort');
      return;
    }
    const startedAt = performance.now();
    const DEADLINE_MS = 2000;
    let attempt = 0;
    const trySnap = () => {
      attempt++;
      const cur = inlineAgentState.get(issue);
      if (!cur || !cur.term || !cur.host) {
        scrollLog(issue, 'attempt', attempt, 'state gone, give up');
        return;
      }
      if (!cur.host.isConnected) {
        scrollLog(issue, 'attempt', attempt, 'host detached, give up');
        return;
      }
      const host = cur.host;
      const hostH = host.clientHeight;
      const viewport = host.querySelector('.xterm-viewport');
      const vSH = viewport ? viewport.scrollHeight : 0;
      const vCH = viewport ? viewport.clientHeight : 0;
      const buf = cur.term.buffer?.active;
      const elapsed = performance.now() - startedAt;
      // No layout yet → can't anchor scroll. Retry.
      if (!viewport || hostH === 0 || vCH === 0) {
        scrollLog(issue, 'attempt', attempt, 'not laid out yet',
          { hostH, vSH, vCH, elapsedMs: Math.round(elapsed) });
        if (elapsed < DEADLINE_MS) requestAnimationFrame(trySnap);
        return;
      }
      try { cur.term.scrollToBottom(); } catch (_) {}
      try { cur.term.focus(); } catch (_) {}
      // Direct DOM sync. xterm.js usually does this itself when
      // scrollToBottom runs, but if scrollHeight changed in the same
      // frame (font measurement, render flush) the scrollTop xterm
      // wrote may be stale. Set it explicitly to the current
      // scrollHeight so DOM and ydisp end up in sync no matter what.
      const targetTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      try { viewport.scrollTop = targetTop; } catch (_) {}
      // Verify both ends.
      const buf2 = cur.term.buffer?.active;
      const internalOk = buf2 && buf2.viewportY === buf2.baseY;
      const domOk = Math.abs(viewport.scrollTop - targetTop) <= 2;
      if (internalOk && domOk) {
        scrollLog(issue, 'attempt', attempt, 'STUCK',
          { hostH, vSH, vCH, scrollTop: viewport.scrollTop,
            viewportY: buf2?.viewportY, baseY: buf2?.baseY,
            elapsedMs: Math.round(elapsed) });
        return;
      }
      scrollLog(issue, 'attempt', attempt, 'not stuck yet, retry',
        { internalOk, domOk, hostH, vSH, vCH,
          scrollTop: viewport.scrollTop, targetTop,
          viewportY: buf2?.viewportY, baseY: buf2?.baseY,
          elapsedMs: Math.round(elapsed) });
      if (elapsed < DEADLINE_MS) requestAnimationFrame(trySnap);
      else scrollLog(issue, 'deadline reached, give up');
    };
    trySnap();
  }

  // Fullscreen toggle. Fullscreen is a single global mode — turning
  // it on from any panel marks the global flag and applies the
  // .agent-fullscreen class to the calling panel; turning it off
  // clears the class from every panel that picked it up while
  // navigating around. The body class locks overflow while on.
  function toggleAgentFullscreen(issue) {
    const panel = document.getElementById(`issue-sub-agent-${cssId(issue)}`);
    if (!panel) return;
    const turnOn = !fullscreenMode;
    fullscreenMode = turnOn;
    document.body.classList.toggle('agent-fullscreen-active', turnOn);
    if (turnOn) {
      applyFullscreenClasses(panel, true);
    } else {
      clearAllFullscreenClasses();
    }
    snapAgentTermToBottom(issue);
  }

  // Move to the previous (-1) or next (+1) tab in the agent
  // navigation list. The list starts with '__agent__' (the pinned
  // General Agent tab, if enabled) followed by every visible
  // issue tab in strip order. Pinned-only filtering matches the
  // strip's visibility rules so the arrows never open a tab the
  // user has hidden. Wraps at the ends so navigation is endless.
  function stepIssue(fromIssue, dir) {
    const state = window.__lastState || {};
    let issues = (state.issues || []).map(i => i.issue);
    if (showPinnedOnly) {
      issues = issues.filter(i => pinnedIssues.has(i));
    }
    const tabs = [];
    if (generalAgentOn()) tabs.push('__agent__');
    tabs.push(...issues);
    if (tabs.length < 2) return;
    const idx = tabs.indexOf(fromIssue);
    if (idx < 0) return;
    const targetIdx = ((idx + dir) % tabs.length + tabs.length) % tabs.length;
    const target = tabs[targetIdx];
    if (!target || target === fromIssue) return;
    // Make sure the target issue lands on its Agent sub-tab so the
    // user sees the console immediately, not the Branches view.
    perIssueAgentSub.set(target, 'agent');
    // Stepping to the General Agent: it's a top-level pinned tab,
    // not an issue tab. Activate the agent-general tab directly;
    // no sub-tab juggling needed.
    if (target === '__agent__') {
      activateTab('tab-agent-general');
      if (fullscreenMode) {
        applyFullscreenClasses(
          document.getElementById('issue-sub-agent-__agent__'), true);
        snapAgentTermToBottom('__agent__');
      }
      return;
    }
    focusIssueTab(target);
    // Make sure the target's Agent sub-tab is the active one —
    // even if perIssueAgentSub said "branches" before stepping in,
    // we want to land on the console. This mirrors what the
    // sub-tab onclick handler does: flip inline display: '' / 'none'
    // on the two panels and toggle the .active class on the buttons.
    const targetBranches = document.getElementById(
      `issue-sub-branches-${cssId(target)}`);
    const targetPanel = document.getElementById(
      `issue-sub-agent-${cssId(target)}`);
    if (targetBranches) targetBranches.style.display = 'none';
    if (targetPanel) targetPanel.style.display = '';
    const targetSection = targetPanel?.closest('section.tab');
    targetSection?.querySelectorAll('.issue-subtab').forEach(b =>
      b.classList.toggle('active', b.dataset.issueSub === 'agent'));
    if (fullscreenMode) {
      // The target panel was built earlier without knowing about
      // fullscreen mode, so its .agent-fullscreen class needs to be
      // applied now (to both panel and wrap) for position:fixed to
      // engage. The fullscreen button label also flips to "Exit".
      applyFullscreenClasses(targetPanel, true);
      snapAgentTermToBottom(target);
    }
  }

  // Escape exits whichever agent panel is currently in fullscreen.
  // Bound once at module load — re-entrant clicks of the same
  // button still work via the explicit toggle button.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!fullscreenMode) return;
    // If any modal is open, let the modal handle Escape — don't also exit fullscreen.
    if (document.querySelector('.logs-modal-backdrop')) return;
    // If the user is typing inside an xterm, the Escape goes to the
    // terminal first (xterm consumes it for editor / vim integration).
    // Only fire our handler when the event reaches document — which
    // happens when the focus is outside the terminal pane.
    if (e.target && (e.target.closest?.('.agent-term-host'))) return;
    fullscreenMode = false;
    document.body.classList.remove('agent-fullscreen-active');
    clearAllFullscreenClasses();
  });

  async function ensureAgentPanelHydrated(issue, issueObj) {
    // Pull the latest sessions snapshot so the Start/Stop button +
    // status line for THIS panel can render correctly. Called on
    // sub-tab activate; cheap (a few-byte JSON).
    try {
      const r = await fetch('/api/agent/term/sessions', { cache: 'no-store' });
      const d = await r.json();
      const map = {};
      for (const s of (d.sessions || [])) {
        map[s.issue] = s;
      }
      agentSessionsByKey = map;
    } catch (_) { /* leave snapshot empty on error */ }
    renderAgentControls(issue);
    // Auto-reattach: if the server has a live session for this issue
    // and we don't have a local xterm yet (e.g. after a page reload),
    // open the WS silently so the user doesn't have to click Start
    // just to see what's running. Only triggers when the caller hands
    // us the issueObj — i.e. from the sub-tab activate path and the
    // initial render — not from the close-handler's hydration probe
    // (which uses its own setTimeout reconnect path).
    //
    // CRITICAL: only auto-attach when the Agent sub-tab is the active
    // one. Otherwise the agent-term-host is inside a display:none
    // panel, FitAddon measures 0×0 and the pty gets resized to cols=2
    // — every claude line then wraps at 2 chars.
    if (!issueObj) return;
    // The pinned General Agent tab has no Branches sub-tab — its
    // single panel IS the agent. Skip the sub-tab gate for it.
    const isAgentSubActive = issue === '__agent__'
      || (perIssueAgentSub.get(issue) || 'branches') === 'agent';
    if (!isAgentSubActive) return;
    const live = agentSessionsByKey[issue];
    const localState = inlineAgentState.get(issue) || {};
    if (live && live.alive && !localState.ws
        && !userDisconnected.has(issue)) {
      startInlineAgent(issueObj);
    }
  }

  function renderAgentControls(issue) {
    const life  = document.getElementById(`agent-lifecycle-${cssId(issue)}`);
    const disco = document.getElementById(`agent-disco-${cssId(issue)}`);
    const status = document.getElementById(`agent-status-${cssId(issue)}`);
    if (!life || !status) return;
    const info = agentSessionsByKey[issue];
    const alive = !!(info && info.alive);
    const local = inlineAgentState.get(issue) || {};
    const attached = !!local.ws;
    // Single Start/Stop toggle. `btn-primary` only on Start so the
    // accent-blue colour reads as "the action you want when off".
    if (alive) {
      life.textContent = t('agent.controls.stop');
      life.classList.remove('btn-primary');
      life.classList.add('agent-lifecycle-stop');
      life.title = '';
    } else {
      life.textContent = t('agent.controls.start');
      life.classList.add('btn-primary');
      life.classList.remove('agent-lifecycle-stop');
      life.title = '';
    }
    // When the agent starts, the lifecycle button still has focus from
    // the click. Redirect it to the terminal so Enter reaches the console.
    if (alive && local.term) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === life || (disco && active === disco)) {
          try { local.term.focus(); } catch (_) {}
        }
      });
    }
    if (disco) {
      disco.style.display = alive ? '' : 'none';
      if (attached) {
        disco.textContent = t('agent.controls.disconnect');
        disco.title       = t('agent.controls.disconnect-tip');
      } else {
        disco.textContent = t('agent.controls.reconnect');
        disco.title       = t('agent.controls.reconnect-tip');
      }
    }
    // Status dot — icon-only in the row, full text in the title=
    // tooltip so the user can hover to see pid + uptime when they
    // care. Saves a chunk of horizontal space in the controls strip.
    if (alive) {
      const age = humanAge((Date.now() / 1000) - info.started_at);
      status.textContent = t('agent.status.running', { age });
      status.title = t('agent.status.running-tip',
        { pid: info.pid, age });
    } else {
      status.textContent = t('agent.status.not-running');
      status.title = t('agent.status.not-running-tip');
    }
  }

  // Issues for which the user explicitly clicked Disconnect. The
  // ws.close auto-reattach logic checks this set and stays out of
  // the way, so manual disconnect actually sticks until the user
  // hits Reconnect.
  const userDisconnected = new Set();
  // Set the next time we attach the WS, ask the server to skip
  // its scrollback replay (?no_replay=1). Used for user-initiated
  // Reconnect: the cached bytes were written at the OLD pty width,
  // so replaying them into a wider xterm (e.g. after fullscreen)
  // wraps every line wrong and looks like garbage. One-shot —
  // consumed by attachInlineWebSocket and removed.
  const skipReplayOnce = new Set();

  function toggleDisconnectAgent(issueObj) {
    const issue = issueObj.issue;
    const local = inlineAgentState.get(issue) || {};
    if (local.ws) {
      // Currently attached → disconnect: tear down local state
      // (xterm + WS + poll) but leave the server-side pty alone.
      userDisconnected.add(issue);
      tearDownAgentTerm(issue);
      // tearDownAgentTerm closes the WS via close().
      renderAgentControls(issue);
    } else {
      // Not attached → reconnect: clear the manual-disconnect
      // flag, re-spawn xterm + WS against the existing pty.
      // Skip the server's scrollback replay so an old narrow-
      // pty render doesn't get pasted into the new (potentially
      // wider, e.g. fullscreen) xterm — it would wrap wrong and
      // look scrambled.
      userDisconnected.delete(issue);
      skipReplayOnce.add(issue);
      startInlineAgent(issueObj);
    }
  }

  function humanAge(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  // Three-button delete confirm for threaded messages. Returns a
  // Promise that resolves to 'cancel' | 'one' | 'thread' — the
  // caller dispatches to /api/mcp/delete or /api/mcp/delete-thread
  // accordingly.  window.confirm() only has two states, so we
  // build a tiny modal rather than overloading OK/Cancel.
  function confirmThreadDelete(n) {
    return new Promise((resolve) => {
      document.getElementById('mcp-del-confirm')?.remove();
      const finish = (choice) => {
        document.getElementById('mcp-del-confirm')?.remove();
        document.removeEventListener('keydown', keyHandler);
        resolve(choice);
      };
      const keyHandler = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      };
      const cancelBtn = h('button', {
        class: 'btn', onclick: () => finish('cancel'),
      }, t('mcp.delete.btn.cancel'));
      const oneBtn = h('button', {
        class: 'btn', onclick: () => finish('one'),
      }, t('mcp.delete.btn.one'));
      const threadBtn = h('button', {
        class: 'btn btn-primary mcp-msg-del',
        onclick: () => finish('thread'),
      }, t('mcp.delete.btn.thread', { n }));
      const modal = h('div', {
        class: 'logs-modal-backdrop', id: 'mcp-del-confirm',
        onclick: () => finish('cancel'),
      },
        h('div', { class: 'logs-modal mcp-del-modal',
                    role: 'dialog',
                    onclick: (e) => e.stopPropagation() },
          h('div', { class: 'logs-modal-head' },
            h('strong', {}, t('mcp.delete.thread-title')),
          ),
          h('div', { class: 'mcp-del-body' },
            t('mcp.delete.thread-help')),
          h('div', { class: 'mcp-del-foot' },
            cancelBtn, oneBtn, threadBtn),
        ),
      );
      document.addEventListener('keydown', keyHandler);
      document.body.append(modal);
      threadBtn.focus();
    });
  }

  // ── Quick messages ────────────────────────────────────────────────────
  // Global (synced) list of pre-written messages the user can drop into
  // any agent's terminal with one click. Stored as a JSON array of
  // strings under the synced pref `quick-messages` so the list rides
  // along to other machines via the existing preferences pipeline.

  // Built-in quick messages — universally useful claude slash
  // commands + a couple of natural-language prompts. Always
  // shown at the top of the picker, can't be removed; user
  // additions are stored separately in the synced pref.
  const DEFAULT_QUICK_MESSAGES = [
    '/compact',
    '/status',
    '/cost',
    '/clear',
    '/help',
    '/voice',
    'continue',
    "summarise what you've done so far",
  ];
  // User-managed quick-skill list. Each entry is a skill id (or
  // namespaced `<plugin>:<skill>`); rendered as a dedicated
  // "skills" section in the quick-message dropdown that sends
  // "Load the <id> skill." to the agent. Ships empty — users add
  // the skills relevant to their workflow via their preferences.
  function getUserQuickSkills() {
    try {
      const raw = prefs.getItem('quick-skills');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter((s) => typeof s === 'string')
        : [];
    } catch (_) { return []; }
  }
  function quickSkillMessage(skillId) {
    return `Load the ${skillId} skill.`;
  }

  // Combined lookup set — anything in here is "locked" (not
  // removable, never stored in the regular user-messages pref).
  function isLockedQuickMessage(msg) {
    if (DEFAULT_QUICK_MESSAGES.includes(msg)) return true;
    return getUserQuickSkills().some(
      (id) => quickSkillMessage(id) === msg);
  }

  function getUserQuickMessages() {
    try {
      const raw = prefs.getItem('quick-messages');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter((s) => typeof s === 'string'
                            && !isLockedQuickMessage(s))
        : [];
    } catch (_) { return []; }
  }
  function setUserQuickMessages(list) {
    prefs.setItem('quick-messages', JSON.stringify(list || []));
    // Patch every visible bar (other agent panels too) so a new
    // entry shows up everywhere immediately, not just on the
    // panel that added it.
    document.querySelectorAll('.agent-quick-bar').forEach((bar) => {
      if (typeof bar.refreshOptions === 'function') bar.refreshOptions();
    });
  }
  function sendQuickMessageTo(issue, text) {
    const st = inlineAgentState.get(issue) || {};
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
      window.alert(t('agent.quick.no-ws'));
      return false;
    }
    // Bracketed paste so claude's TUI treats the text as one block
    // and auto-submits via the trailing \r — same trick the
    // mailbox-poll nudge uses.
    const payload = '\x1b[200~' + text + '\x1b[201~\r';
    try {
      st.ws.send(new TextEncoder().encode(payload));
      return true;
    } catch (_) { return false; }
  }
  function buildQuickMessageBar(issue) {
    // Auto-send: picking from the dropdown immediately fires the
    // message into the agent's pty and resets the picker, so the
    // user never has to click a separate Send button. Trade-off:
    // they can't "select to inspect" a saved message — Remove
    // now opens a tiny manage modal instead.
    const select = h('select', {
      class: 'quick-msg-select',
      onchange: () => {
        const text = (select.value || '').trim();
        if (!text) return;
        const sent = sendQuickMessageTo(issue, text);
        // Reset to the placeholder regardless of WS state — when
        // the WS is down, sendQuickMessageTo alerts and returns
        // false; we still want the picker to clear so a second
        // attempt is a deliberate re-pick.
        select.value = '';
        void sent;  // silence unused-var lint
        // Return focus to the terminal so the user can keep typing.
        try { inlineAgentState.get(issue)?.term?.focus(); } catch (_) {}
      },
    });
    function refreshOptions() {
      const userList = getUserQuickMessages();
      const skillList = getUserQuickSkills();
      const children = [
        h('option', { value: '', disabled: '', selected: '' },
          t('agent.quick.placeholder')),
        // Built-in slash commands + natural prompts.
        ...DEFAULT_QUICK_MESSAGES.map((msg) =>
          h('option', { value: msg, title: msg + ' (built-in)' },
            msg)),
      ];
      if (skillList.length) {
        children.push(h('option', { value: '', disabled: '' },
          '──── skills ────'));
        for (const id of skillList) {
          const msg = quickSkillMessage(id);
          children.push(h('option', { value: msg, title: msg }, id));
        }
      }
      if (userList.length) {
        children.push(h('option', { value: '', disabled: '' },
          '──── my messages ────'));
        for (const msg of userList) {
          const label = msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
          children.push(h('option', { value: msg, title: msg }, label));
        }
      }
      select.replaceChildren(...children);
      // Auto-send means we never want a value lingering after a
      // refresh — always reset to the placeholder.
      select.value = '';
    }
    refreshOptions();
    const addBtn = h('button', {
      class: 'btn btn-inline quick-msg-add',
      title: t('agent.quick.add-tip'),
      onclick: () => {
        const text = window.prompt(t('agent.quick.prompt'));
        if (!text) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        if (LOCKED_QUICK_MESSAGES.has(trimmed)) return;
        const list = getUserQuickMessages();
        if (!list.includes(trimmed)) {
          list.push(trimmed);
          setUserQuickMessages(list);
        }
      },
    }, t('agent.quick.add'));
    const removeBtn = h('button', {
      class: 'btn btn-inline quick-msg-remove',
      title: t('agent.quick.remove-tip'),
      onclick: () => openManageQuickMessagesModal(),
    }, t('agent.quick.remove'));
    const bar = h('div', { class: 'agent-quick-bar' },
      select, addBtn, removeBtn);
    bar.refreshOptions = refreshOptions;
    return bar;
  }

  // Modal listing user-added quick messages with checkboxes for
  // multi-select deletion. Built-ins aren't shown — they're locked.
  function openManageQuickMessagesModal() {
    document.getElementById('quick-msg-manage-modal')?.remove();
    const close = () =>
      document.getElementById('quick-msg-manage-modal')?.remove();
    const listEl = h('div', { class: 'quick-msg-manage-list' });

    const deleteBtn = h('button', {
      class: 'btn btn-inline quick-msg-delete-sel',
      title: t('agent.quick.manage-delete-tip'),
      onclick: () => {
        const toDelete = new Set(
          [...listEl.querySelectorAll('.quick-msg-check:checked')]
            .map((cb) => cb.dataset.msg)
        );
        if (!toDelete.size) return;
        setUserQuickMessages(getUserQuickMessages().filter((m) => !toDelete.has(m)));
        rebuild();
      },
    }, t('agent.quick.delete-selected'));
    deleteBtn.disabled = true;

    function updateDeleteBtn() {
      deleteBtn.disabled =
        listEl.querySelectorAll('.quick-msg-check:checked').length === 0;
    }

    function rebuild() {
      const cur = getUserQuickMessages();
      if (!cur.length) {
        listEl.replaceChildren(
          h('div', { class: 'muted', style: { padding: '0.6rem' } },
            t('agent.quick.manage-empty')));
        deleteBtn.disabled = true;
        return;
      }
      listEl.replaceChildren(...cur.map((msg) => {
        const label = msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
        const cb = h('input', {
          type: 'checkbox',
          class: 'quick-msg-check',
          onchange: updateDeleteBtn,
        });
        cb.dataset.msg = msg;
        return h('div', { class: 'quick-msg-manage-row' },
          cb,
          h('span', { class: 'quick-msg-manage-text', title: msg }, label));
      }));
      updateDeleteBtn();
    }
    rebuild();
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'quick-msg-manage-modal',
      onclick: close,
    },
      h('div', { class: 'logs-modal',
                  role: 'dialog',
                  onclick: (e) => e.stopPropagation(),
                  style: { maxWidth: '36em' } },
        h('div', { class: 'logs-modal-head' },
          h('strong', {}, t('agent.quick.manage-title')),
          h('span', { style: { flex: '1' } }),
          deleteBtn,
          h('button', { class: 'btn btn-inline', onclick: close }, '✕')),
        listEl,
      ),
    );
    document.body.append(modal);
  }

  // ── Agent terminal search ─────────────────────────────────────────────
  // Floating search bar that sits top-right of the terminal host.
  // Activated by the 🔍 button in the controls row or Ctrl+F in
  // the terminal. Uses @xterm/addon-search for per-character
  // highlighting and find-next/prev with wrapping.

  function buildAgentSearchBar(issue) {
    const barId = `agent-search-bar-${cssId(issue)}`;

    const input = h('input', {
      type: 'text',
      class: 'agent-search-input',
      placeholder: t('agent.search.placeholder'),
      spellcheck: false,
      autocomplete: 'off',
    });

    const counter = h('span', { class: 'agent-search-count' });

    let caseBtn, regexBtn;

    function searchOpts() {
      return {
        caseSensitive: caseBtn.classList.contains('active'),
        regex: regexBtn.classList.contains('active'),
        decorations: {
          matchBackground: '#623115',
          matchBorder: '#c87941',
          matchOverviewRuler: '#c87941',
          activeMatchBackground: '#9e4b0e',
          activeMatchBorder: '#f5a623',
          activeMatchColorOverviewRuler: '#f5a623',
        },
      };
    }

    function doSearch(backwards) {
      const sa = inlineAgentState.get(issue)?.searchAddon;
      if (!sa) return;
      const query = input.value;
      if (!query) { sa.clearDecorations(); counter.textContent = ''; return; }
      if (backwards) sa.findPrevious(query, searchOpts());
      else sa.findNext(query, searchOpts());
    }

    caseBtn = h('button', {
      class: 'btn agent-search-opt',
      title: 'Match case',
      onclick: () => { caseBtn.classList.toggle('active'); doSearch(false); },
    }, 'Aa');

    regexBtn = h('button', {
      class: 'btn agent-search-opt',
      title: 'Use regular expression',
      onclick: () => { regexBtn.classList.toggle('active'); doSearch(false); },
    }, '.*');

    const prevBtn = h('button', {
      class: 'btn agent-search-nav',
      title: 'Previous match (Shift+Enter)',
      onclick: () => doSearch(true),
    }, '▲');

    const nextBtn = h('button', {
      class: 'btn agent-search-nav',
      title: 'Next match (Enter)',
      onclick: () => doSearch(false),
    }, '▼');

    const closeBtn = h('button', {
      class: 'btn agent-search-close',
      title: 'Clear search',
      onclick: () => {
        input.value = '';
        counter.textContent = '';
        const sa = inlineAgentState.get(issue)?.searchAddon;
        if (sa) { try { sa.clearDecorations(); } catch (_) {} }
        input.focus();
      },
    }, '✕');

    input.addEventListener('input', () => doSearch(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) doSearch(true); else doSearch(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAgentSearch(issue);
      }
    });

    const bar = h('div', { class: 'agent-search-bar', id: barId },
      input, counter, caseBtn, regexBtn, prevBtn, nextBtn, closeBtn);
    if (!showTermSearch) bar.style.display = 'none';
    return bar;
  }

  function toggleAgentSearch(issue) {
    const bar = document.getElementById(`agent-search-bar-${cssId(issue)}`);
    if (!bar) return;
    if (showTermSearch) {
      // Pref ON — bar is always visible, just focus the input.
      _focusAgentSearchInput(bar, issue);
    } else {
      // Pref OFF — 🔍 / Ctrl+F acts as a toggle: show+focus if hidden,
      // clear+hide if already visible.
      const hidden = bar.style.display === 'none';
      if (hidden) {
        bar.style.display = '';
        _focusAgentSearchInput(bar, issue);
      } else {
        closeAgentSearch(issue);
      }
    }
  }

  function _focusAgentSearchInput(bar, issue) {
    const input = bar.querySelector('.agent-search-input');
    if (!input) return;
    input.focus();
    input.select();
    if (input.value) {
      const sa = inlineAgentState.get(issue)?.searchAddon;
      if (sa) {
        try {
          sa.findNext(input.value, {
            caseSensitive: bar.querySelector('.agent-search-opt.active[title="Match case"]') !== null,
            regex: bar.querySelector('.agent-search-opt.active[title="Use regular expression"]') !== null,
          });
        } catch (_) {}
      }
    }
  }

  function closeAgentSearch(issue) {
    const bar = document.getElementById(`agent-search-bar-${cssId(issue)}`);
    if (!bar) return;
    const sa = inlineAgentState.get(issue)?.searchAddon;
    if (sa) { try { sa.clearDecorations(); } catch (_) {} }
    bar.querySelector('.agent-search-count').textContent = '';
    bar.querySelector('.agent-search-input')?.blur();
    // When pref is OFF, hide the bar again after closing.
    if (!showTermSearch) bar.style.display = 'none';
    // Return focus to the terminal so keystrokes go to the agent.
    try { inlineAgentState.get(issue)?.term?.focus(); } catch (_) {}
  }

  // ── Drag-and-drop into the agent console ──────────────────────────────
  // Native drag from a file manager → e.dataTransfer carries
  // text/uri-list with file:///abs/path entries. Parse, decode,
  // send @path straight to the pty. No upload, no copy.
  // Browser-sandboxed drags (from a web page/tab) carry only bytes
  // with no host path, so they are rejected with a hint to use the
  // file manager instead.

  // Diagnostic logging gated by ?debug-drop=1 in the URL. Off unless
  // explicitly enabled so the console stays clean for normal use.
  const DROP_DEBUG = (() => {
    try {
      return new URLSearchParams(location.search).get('debug-drop') === '1';
    } catch (_) { return false; }
  })();
  function dropLog(...args) { if (DROP_DEBUG) console.log('[drop]', ...args); }

  // Same shape for the agent-terminal scroll-to-bottom path. Enable
  // with ?debug-scroll=1 to see every snap attempt: how many ticks it
  // took to verify, the measured host.clientHeight / scrollTop /
  // scrollHeight / viewportY / baseY, and why a retry fired.
  const SCROLL_DEBUG = (() => {
    try {
      return new URLSearchParams(location.search).get('debug-scroll') === '1';
    } catch (_) { return false; }
  })();
  function scrollLog(...args) {
    if (SCROLL_DEBUG) console.log('[scroll]', ...args);
  }

  function parseFileUris(text) {
    if (!text) return [];
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (!line.startsWith('file://')) continue;
      try {
        // file:///abs/path → /abs/path. URL decodes %20, etc.
        const u = new URL(line);
        if (u.protocol !== 'file:') continue;
        // u.pathname is already decoded by the URL parser.
        if (u.pathname) out.push(decodeURIComponent(u.pathname));
      } catch (_) { /* skip malformed */ }
    }
    return out;
  }

  function insertAtPathsInto(issue, paths) {
    if (!paths.length) {
      dropLog('insertAtPathsInto: no paths');
      return false;
    }
    const st = inlineAgentState.get(issue) || {};
    const wsState = st.ws ? st.ws.readyState : 'no-ws';
    dropLog('insertAtPathsInto', { issue, paths, wsState });
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) {
      window.alert(t('agent.quick.no-ws'));
      return false;
    }
    // Wrap each path in @<path> and join with a single space, so
    // claude sees them as a paste block. NO trailing \r — the
    // user composes the rest of the prompt before Enter.
    const refs = paths.map((p) => '@' + p).join(' ') + ' ';
    const payload = '\x1b[200~' + refs + '\x1b[201~';
    try { st.ws.send(new TextEncoder().encode(payload)); }
    catch (_) { return false; }
    return true;
  }

  async function handleAgentDrop(issue, dt) {
    dropLog('handleAgentDrop start', {
      issue,
      types: Array.from(dt.types || []),
      itemsCount: dt.items ? dt.items.length : null,
      filesCount: dt.files ? dt.files.length : null,
    });
    // 1. Native file paths via text/uri-list (file:// URIs).
    //    No upload needed — insert @path and Claude reads the local file.
    const native = parseFileUris(dt.getData('text/uri-list'));
    if (native.length) {
      dropLog('handleAgentDrop: native uri-list', native);
      insertAtPathsInto(issue, native);
      return;
    }
    // 2. Use dt.items to get File objects — more reliable than dt.files on
    //    Wayland where text files and PDFs may not appear in dt.files.
    const files = [];
    if (dt.items) {
      for (const item of dt.items) {
        dropLog('handleAgentDrop: dt.item', { kind: item.kind, type: item.type });
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length) {
      // Fallback for browsers without dt.items.
      files.push(...Array.from(dt.files || []));
    }
    dropLog('handleAgentDrop: file count after extraction', files.length,
            files.map((f) => ({ name: f.name, type: f.type, size: f.size })));
    if (!files.length) return;
    const paths = [];
    for (const file of files) {
      const p = await uploadFileBlob(issue, file, file.name);
      if (p) paths.push(p);
    }
    if (paths.length) insertAtPathsInto(issue, paths);
  }

  async function uploadFileBlob(issue, blob, filename) { // blob may be any File/Blob
    const url = '/api/agent/upload'
      + `?issue=${encodeURIComponent(issue)}`
      + `&name=${encodeURIComponent(filename)}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try { detail = (await r.json()).error || detail; } catch (_) {}
        showToast('error', t('agent.drop.toast.failed', { error: detail }));
        return null;
      }
      const d = await r.json();
      return d.path || null;
    } catch (err) {
      showToast('error', t('agent.drop.toast.failed', { error: err }));
      return null;
    }
  }

  // Clipboard image paste (e.g. a Linux screenshot) → upload → @path.
  // Uses navigator.clipboard.read() because e.clipboardData.items is
  // often empty for images on Linux/Wayland. Hooked at keydown so we
  // can cancel the event before xterm sees Ctrl+V.
  async function handleClipboardImagePaste(issue) {
    if (!navigator.clipboard?.read) return false;
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch (_) {
      return false; // permission denied or no clipboard API
    }
    for (const item of items) {
      const imageType = item.types.find((tp) => tp.startsWith('image/'));
      if (!imageType) continue;
      let blob;
      try { blob = await item.getType(imageType); } catch (_) { continue; }
      const ext = imageType.split('/')[1].replace(/[^a-z0-9]/g, '') || 'png';
      const name = `screenshot-${Date.now()}.${ext}`;
      const p = await uploadFileBlob(issue, blob, name);
      if (p) {
        insertAtPathsInto(issue, [p]);
        showToast('info', t('agent.drop.toast.image-pasted'));
      }
      return true;
    }
    return false;
  }

  // Global drag-and-drop for all agent terminals.
  // We register ONE listener on document in capture phase so it fires
  // before xterm's canvas handlers (which stopPropagation on bubble).
  // Each terminal registers its host element in this map.
  const dropZoneHosts = new Map(); // issue → host element

  (function initGlobalDropZone() {
    let activeHost = null; // host currently being dragged over

    // Accept any drag with at least one type over the terminal area.
    // Checking only specific types (Files, text/uri-list) missed PDFs
    // and other file types that carry their MIME type directly.
    const isFileDrag = (e) =>
      !!(e.dataTransfer && (e.dataTransfer.types || []).length > 0);

    const hostForTarget = (target) => {
      for (const [, host] of dropZoneHosts) {
        if (host.isConnected && host.contains(target)) return host;
      }
      return null;
    };

    document.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      const host = hostForTarget(e.target);
      if (!host) {
        if (activeHost) {
          dropLog('dragover: clearing activeHost (target outside host)',
                  { target: e.target?.tagName, types: Array.from(e.dataTransfer?.types || []) });
          activeHost.classList.remove('is-dragover'); activeHost = null;
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (host !== activeHost) {
        dropLog('dragover: activeHost set', { hostId: host.id });
        if (activeHost) activeHost.classList.remove('is-dragover');
        activeHost = host;
        host.classList.add('is-dragover');
      }
    }, { capture: true, passive: false });

    document.addEventListener('dragleave', (e) => {
      if (!activeHost) return;
      // Only clear when the drag leaves the host entirely.
      if (!e.relatedTarget || !activeHost.contains(e.relatedTarget)) {
        dropLog('dragleave: clearing activeHost',
                { relatedTarget: e.relatedTarget?.tagName ?? null });
        activeHost.classList.remove('is-dragover');
        activeHost = null;
      }
    }, { capture: true });

    document.addEventListener('drop', (e) => {
      const host = activeHost || hostForTarget(e.target);
      dropLog('drop fired', {
        target: e.target?.tagName,
        hadActiveHost: !!activeHost,
        hostMatched: !!host,
        hostId: host?.id,
        types: Array.from(e.dataTransfer?.types || []),
      });
      // Defensive cleanup: always strip .is-dragover from every
      // registered host so a stale "drop hint" overlay can never
      // get stuck visible — even if the drop didn't match any host
      // or the handler bails early below.
      for (const [, h] of dropZoneHosts) h.classList?.remove('is-dragover');
      activeHost = null;
      if (!host) return;
      e.preventDefault();
      e.stopPropagation();
      // Find which issue this host belongs to.
      let dropIssue = null;
      for (const [iss, h] of dropZoneHosts) { if (h === host) { dropIssue = iss; break; } }
      dropLog('drop: resolved issue', dropIssue);
      if (!dropIssue) return;
      handleAgentDrop(dropIssue, e.dataTransfer).catch((err) => {
        dropLog('drop: handleAgentDrop threw', err);
        showToast('error', t('agent.drop.toast.failed', { error: err }));
      });
    }, { capture: true });
  })();

  function attachDropZone(host, issue) {
    if (!host) return;
    // Register / refresh the host. Called on every buildAgentPanel so
    // the reference stays current after re-parents.
    dropZoneHosts.set(issue, host);
    if (host.__dropzoneAttached) return;
    host.__dropzoneAttached = true;
    host.append(h('div', { class: 'agent-drop-hint' },
      t('agent.drop.hint')));
  }

  function startInlineAgent(issueObj) {
    const issue = issueObj.issue;
    // Any explicit Start (or Reconnect, which routes through here)
    // clears the manual-disconnect flag so close-handler auto-
    // reattach is reenabled.
    userDisconnected.delete(issue);
    let cur = inlineAgentState.get(issue) || {};
    if (cur.term && cur.ws) {
      // Already attached.
      return;
    }
    // Re-using a prior term that's still alive (e.g. after a renderApp
    // rebuild that preserved the xterm host): just open a new WS.
    // Validate the references first — a stale close handler could
    // have stuffed disposed term + detached host back into state,
    // in which case the reuse path would silently attach to nothing.
    if (cur.term && cur.host && cur.fit) {
      const liveHost = document.getElementById(
        `agent-term-${cssId(issue)}`);
      const stillUsable = cur.host.isConnected
        && liveHost === cur.host
        && !(cur.term._core?._isDisposed);
      if (stillUsable) {
        attachInlineWebSocket(issue, cur.term, cur.fit, cur.host, cur.ro);
        return;
      }
      // Stale — drop and fall through to fresh-term creation.
      inlineAgentState.set(issue, { term: null, ws: null });
      cur = inlineAgentState.get(issue);
    }
    const host = document.getElementById(`agent-term-${cssId(issue)}`);
    const placeholder = document.getElementById(`agent-term-placeholder-${cssId(issue)}`);
    if (!host) return;
    if (placeholder) placeholder.remove();

    // xterm.js wiring. Globals: Terminal, FitAddon, WebLinksAddon.
    // Fixed dark VS-Code-style palette so the terminal reads as a
    // real console regardless of the dashboard's light/dark theme.
    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
      fontSize: 13,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#3a3d41',
        black: '#000000', red: '#cd3131', green: '#0dbc79',
        yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc',
        cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c',
        brightGreen: '#23d18b', brightYellow: '#f5f543',
        brightBlue: '#3b8eea', brightMagenta: '#d670d6',
        brightCyan: '#29b8db', brightWhite: '#ffffff',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    }
    if (window.Unicode11Addon?.Unicode11Addon) {
      const u11 = new window.Unicode11Addon.Unicode11Addon();
      term.loadAddon(u11);
      term.unicode.activeVersion = '11';
    }
    let searchAddon = null;
    if (window.SearchAddon?.SearchAddon) {
      searchAddon = new window.SearchAddon.SearchAddon();
      term.loadAddon(searchAddon);
      searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
        const bar = document.getElementById(`agent-search-bar-${cssId(issue)}`);
        if (!bar) return;
        const inputEl = bar.querySelector('.agent-search-input');
        bar.querySelector('.agent-search-count').textContent = resultCount
          ? `${resultIndex + 1}/${resultCount}`
          : (inputEl?.value ? t('agent.search.no-results') : '');
      });
    }
    term.open(host);
    // ImageAddon must be loaded AFTER term.open() — it hooks into the
    // renderer which is only initialised once the terminal is mounted.
    if (window.ImageAddon?.ImageAddon) {
      try {
        const imgAddon = new window.ImageAddon.ImageAddon();
        term.loadAddon(imgAddon);
        console.log('[xterm] ImageAddon loaded ok for', issue);
        // Expose on the state map so the browser console can test:
        // window.__xtermDebug('<issue>').writeIIP('<base64-png>')
        term._imageAddon = imgAddon;
      } catch (e) {
        console.error('[xterm] ImageAddon failed to load:', e);
      }
    } else {
      console.warn('[xterm] ImageAddon not available (window.ImageAddon missing)');
    }
    // Ctrl+F / Cmd+F → toggle the search overlay; suppress xterm's
    // own browser find-bar shortcut.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        if (e.type === 'keydown') toggleAgentSearch(issue);
        return false;
      }
      return true;
    });
    // Initial fit. Same sanity floor as the ResizeObserver — if the
    // host is in a transitional layout state and FitAddon proposes
    // tiny dims, leave term at its default 80×24 instead of pinning
    // it to e.g. 10 cols (which then becomes the WS query-string
    // size and the server creates the pty at 10 cols — every byte
    // claude emits wraps at 10 chars).
    try {
      const proposed = fit.proposeDimensions?.();
      if (proposed && proposed.cols >= 40 && proposed.rows >= 5) {
        fit.fit();
      }
    } catch (_) {}

    // Forward keystrokes → server. Use a binary frame so multi-byte
    // sequences (arrow keys, function keys, IME composition) survive
    // unchanged. The ws reference is closed over via the state map.
    term.onData((data) => {
      const st = inlineAgentState.get(issue) || {};
      if (st.ws && st.ws.readyState === WebSocket.OPEN) {
        st.ws.send(new TextEncoder().encode(data));
      }
    });

    // ResizeObserver fires every time the host's box size changes —
    // including transitional states like display:none ↔ visible
    // when the user switches issue tabs. proposeDimensions can
    // return tiny cols during those transitions (the host might
    // momentarily measure < its real width). Apply the same
    // > 40 cols / > 5 rows sanity floor we use on postResize, and
    // skip the fit entirely when dimensions are identical. Without
    // this, switching tabs shrinks xterm to ~10 cols and the pty's
    // live output wraps at 10 chars per line.
    const ro = new ResizeObserver(() => {
      let didFit = false;
      try {
        const proposed = fit.proposeDimensions?.();
        if (!proposed) return;
        if (!proposed.cols || !proposed.rows) return;
        if (proposed.cols < 40 || proposed.rows < 5) return;
        if (proposed.cols === term.cols && proposed.rows === term.rows) return;
        fit.fit();
        didFit = true;
      } catch (_) { return; }
      postResize(issue, term.cols, term.rows);
      // After growing the terminal, snap the viewport to the cursor
      // so the prompt sits at the bottom of the visible area instead
      // of stranded near the top with empty rows below.
      if (didFit) {
        try { term.scrollToBottom(); } catch (_) {}
      }
    });
    ro.observe(host);

    // IntersectionObserver is the safety net for the scroll-to-bottom
    // problem. ResizeObserver only fires on box-size changes and skips
    // the fit when proposed dimensions match current ones, so a
    // display:none → visible flip with unchanged dimensions never
    // triggered a re-snap. Watching intersection ratio directly is
    // immune to that: any hidden → visible transition fires here,
    // regardless of which code path caused it (tab switch, sub-tab
    // activate, ◀/▶ nav, fullscreen toggle, …). snapAgentTermToBottom
    // is idempotent and verifies state, so over-firing is harmless.
    let lastVisible = host.offsetParent !== null;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const nowVisible = entry.intersectionRatio > 0;
        if (nowVisible && !lastVisible) {
          scrollLog(issue, 'IO: hidden → visible, snap');
          snapAgentTermToBottom(issue);
        }
        lastVisible = nowVisible;
      }
    }, { threshold: [0, 0.01] });
    io.observe(host);

    // Park term/fit/host/ro in the state map BEFORE the WS connects.
    // If a renderApp re-fires while the WS is still in CONNECTING
    // (e.g. a SessionEnd event from the kill we just sent triggers
    // the 10s pollNewEvents → refreshAll), buildAgentPanel's host-
    // preservation path sees these and reuses the live host element
    // instead of building a fresh placeholder over our xterm.
    inlineAgentState.set(issue, { term, fit, host, ro, io, ws: null, searchAddon });

    attachInlineWebSocket(issue, term, fit, host, ro);
  }

  function attachInlineWebSocket(issue, term, fit, host, ro) {
    const port = location.port || '80';
    // Consume the one-shot "skip replay" flag set by manual
    // Reconnect. The server will skip its scrollback push so we
    // don't paste old narrow-pty render bytes into a new wider
    // xterm and end up with scrambled wrap.
    const skipReplay = skipReplayOnce.has(issue);
    if (skipReplay) skipReplayOnce.delete(issue);
    const url = `ws://${location.hostname}:${port}/api/agent/term/ws`
      + `?issue=${encodeURIComponent(issue)}`
      + `&cols=${term.cols}&rows=${term.rows}`
      + (skipReplay ? '&no_replay=1' : '');
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      requestAnimationFrame(() => {
        try { fit.fit(); } catch (_) {}
        postResize(issue, term.cols, term.rows);
        try { term.scrollToBottom(); } catch (_) {}
        // After a skip-replay reconnect, also nudge claude to
        // redraw at the new dimensions — Ctrl+L (form feed) is
        // the de-facto "repaint" key for TUIs.
        if (skipReplay) {
          try {
            term.reset();
            ws.send(new TextEncoder().encode('\x0c'));
          } catch (_) {}
        }
      });
      ensureAgentPanelHydrated(issue);
      const prev = inlineAgentState.get(issue) || {};
      if (prev.poll) clearInterval(prev.poll);
      const pollId = setInterval(() => {
        if (document.getElementById(`agent-term-${cssId(issue)}`)) {
          renderAgentControls(issue);
        } else {
          clearInterval(pollId);
        }
      }, 5000);
      const prevState = inlineAgentState.get(issue) || {};
      inlineAgentState.set(issue, { term, ws, fit, poll: pollId,
                                     host, ro, io: prevState.io,
                                     searchAddon: prevState.searchAddon });
    });

    ws.addEventListener('message', (ev) => {
      // Text frames carry control messages (currently just the
      // "init" handshake that tells us the pty's current dims).
      // Binary frames are pty bytes to render.
      if (typeof ev.data === 'string') {
        try {
          const ctl = JSON.parse(ev.data);
          if (ctl.type === 'init'
              && typeof ctl.cols === 'number'
              && typeof ctl.rows === 'number') {
            // Match xterm to the pty's current size instead of
            // immediately re-resizing the pty to whatever fit.fit()
            // produced. Suppresses the SIGWINCH-on-attach flicker.
            try { term.resize(ctl.cols, ctl.rows); } catch (_) {}
            // Mute outgoing resizes for a moment so the ResizeObserver
            // that fires right after the panel becomes visible
            // doesn't fight us.
            suppressResizeUntil.set(issue,
              Date.now() + RESIZE_SUPPRESS_MS);
          }
        } catch (_) { /* malformed control — ignore */ }
        return;
      }
      const data = new Uint8Array(ev.data);
      // Only auto-scroll if the user is already at the bottom.
      // If they scrolled up to read something, leave them there.
      // viewportY is the absolute index of the visible top row in
      // the buffer (= ydisp); baseY is the index that "at bottom"
      // means (= ybase). Both are positive once any scrollback
      // exists, so comparing viewportY to 0 (the old check) only
      // matched at session start and broke as soon as the first
      // line scrolled off — auto-scroll then stopped following.
      const atBottom = (term.buffer.active.viewportY
                          === term.buffer.active.baseY);
      term.write(data, () => {
        if (!atBottom) return;
        const st = inlineAgentState.get(issue);
        if (st && st.ws === ws) {
          try { term.scrollToBottom(); } catch (_) {}
        }
      });
    });

    ws.addEventListener('close', () => {
      const state = inlineAgentState.get(issue) || {};
      // Three stale-close races to defend against:
      //  (a) user clicked Disconnect → tearDownAgentTerm wiped
      //      the state map (state.term === null sentinel); this
      //      handler must not "restore" the now-disposed term.
      //  (b) user clicked Stop → same shape: tearDownAgentTerm
      //      sets state.term to null and we must NOT overwrite
      //      it with the closure-captured old term, otherwise
      //      the next Start hits the cur.term/host/fit reuse
      //      path and tries to attach to a disposed term —
      //      the symptom is the placeholder staying visible
      //      even though /api/agent/term/sessions says alive.
      //  (c) user clicked Disconnect then Reconnect → a fresh
      //      term is registered; don't clobber it.
      if (userDisconnected.has(issue)) return;
      if (state.term === null) return;
      if (state.term && state.term !== term) return;
      if (state.poll) clearInterval(state.poll);
      // KEEP the xterm visible on disconnect — render a yellow
      // banner so the user knows, but don't dispose. If the server
      // session is still alive, auto-reattach after a short delay
      // (renderApp triggered by event polling can transiently
      // detach us; we want that to be invisible to the user).
      const wasAttached = !!state.ws;
      inlineAgentState.set(issue, { term, fit, host, ro, io: state.io, ws: null,
                                     searchAddon: state.searchAddon });
      try {
        term.write('\r\n\x1b[33m[' + t('agent.terminal.disconnected') + ']\x1b[0m\r\n');
      } catch (_) {}
      ensureAgentPanelHydrated(issue).then(() => {
        const live = agentSessionsByKey[issue];
        if (userDisconnected.has(issue)) return;  // manual disconnect — stay down
        if (live && live.alive && wasAttached) {
          setTimeout(() =>
            attachInlineWebSocket(issue, term, fit, host, ro), 800);
        }
      });
    });

    ws.addEventListener('error', () => {
      try {
        term.write('\r\n\x1b[31m[' + t('agent.terminal.ws-error') + ']\x1b[0m\r\n');
      } catch (_) {}
    });
  }

  // Debounced per-issue. Fullscreen toggles trigger a cascade of
  // size changes (CSS class flip → host width → ResizeObserver →
  // fit.fit → new cols/rows). Without the debounce we'd send
  // multiple TIOCSWINSZ in quick succession; claude redraws its
  // TUI on every SIGWINCH which makes the screen flicker like the
  // agent stopped. Collapsing to one resize 200ms after the last
  // change keeps claude happy.
  //
  // Also gated by suppressResizeUntil — the server's init frame
  // sets a short suppression window so the immediate post-attach
  // ResizeObserver doesn't post a resize that contradicts the
  // size we just adopted from the pty.
  const _resizeTimers = new Map();
  const suppressResizeUntil = new Map();
  const RESIZE_SUPPRESS_MS = 1500;
  function postResize(issue, cols, rows) {
    if (!cols || !rows || cols < 40 || rows < 5) return;
    const until = suppressResizeUntil.get(issue) || 0;
    if (Date.now() < until) return;
    const prev = _resizeTimers.get(issue);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      _resizeTimers.delete(issue);
      fetch('/api/agent/term/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue, cols, rows }),
      }).catch(() => {});
    }, 200);
    _resizeTimers.set(issue, t);
  }

  function tearDownAgentTerm(issue) {
    const cur = inlineAgentState.get(issue) || {};
    if (cur.poll) clearInterval(cur.poll);
    if (cur.ro) try { cur.ro.disconnect(); } catch (_) {}
    if (cur.io) try { cur.io.disconnect(); } catch (_) {}
    if (cur.ws) try { cur.ws.close(); } catch (_) {}
    if (cur.term) try { cur.term.dispose(); } catch (_) {}
    inlineAgentState.set(issue, { term: null, ws: null });
    const host = document.getElementById(`agent-term-${cssId(issue)}`);
    if (host) {
      host.innerHTML = '';
      const placeholder = h('div', {
        class: 'agent-term-placeholder',
        id: `agent-term-placeholder-${cssId(issue)}`,
      }, t('agent.terminal.placeholder'));
      host.append(placeholder);
    }
  }

  async function stopInlineAgent(issue) {
    tearDownAgentTerm(issue);
    try {
      await fetch('/api/agent/term/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue }),
      });
    } catch (_) {}
    // Show the friendly label ("Agent 007") for the sentinel
    // instead of the raw `__agent__` id; the DB / API still use
    // the sentinel.
    const displayIssue = issue === '__agent__'
      ? t('tab.generic-agent') : issue;
    showToast('ok', t('toast.agent.stopped', { issue: displayIssue }));
    ensureAgentPanelHydrated(issue);
  }

  function openExternalConsole(issue) {
    // Reuses the existing /api/open-agent-tab handler the 💻 button
    // already uses — same model selection rules, same env contract.
    fetch('/api/open-agent-tab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue }),
    }).catch(() => {});
  }

  const slugId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '-');

  function renderApp(state) {
    const previousTab = location.hash ? location.hash.slice(1) : null;

    // Mirror the global fullscreen flag onto <body> on every render
    // so notification-driven refreshAll() rebuilds can't drop the
    // overflow lock while a panel is still fullscreen.
    document.body.classList.toggle('agent-fullscreen-active', fullscreenMode);

    const app = $('#app');
    app.replaceChildren();
    // Auto-update banner mount point — content goes here via
    // renderUpdateBanner(state) called from refreshAll after the
    // panel rebuild. Empty by default so it takes no space.
    app.append(h('div', { id: 'update-banner-host' }));

    const sync = state.sync || {};
    const syncStale = sync.enabled && (sync.age_seconds == null
                                       || sync.age_seconds > sync.stale_seconds);
    const syncMetaText = !sync.enabled
      ? 'sync disabled'
      : (sync.last_iso ? `Synced ${sync.last_iso}` : 'never synced');

    // Filter row state — shown/hidden via the ☰ Filters toggle. Default
    // closed so the toolbar stays slim.
    const filtersOpen = localStorage.getItem('toolbar-filters-open') === '1';

    // Refresh-now button with an SVG progress ring that fills as the
    // next auto-refresh approaches. updateCountdown() drives the ring +
    // tooltip from setInterval.
    const refreshBtn = h('button', {
      class: 'btn refresh-now-btn', id: 'refresh-now-btn',
      onclick: () => refreshAll(true),
    },
      t('toolbar.refresh-now'),
    );
    const ringSvg = svg('svg', {
      class: 'refresh-progress', viewBox: '0 0 20 20',
      width: '14', height: '14', 'aria-hidden': 'true',
    },
      svg('circle', {
        class: 'refresh-progress-bg', cx: '10', cy: '10', r: '8',
        fill: 'none',
      }),
      svg('circle', {
        class: 'refresh-progress-fg', cx: '10', cy: '10', r: '8',
        fill: 'none',
      }),
    );
    refreshBtn.prepend(ringSvg);
    app.append(
      h('div', { class: 'toolbar' },
        refreshBtn,
        // Sync UI is opt-in via the profile popover toggle. When off,
        // the Sync now / Auto-sync buttons aren't rendered at all.
        syncUiOn ? h('button', {
                      class: 'btn hover-popover-host', id: 'sync-now-btn',
                      onclick: () => syncNow() },
          t('toolbar.sync-now'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.refresh-now')))) : null,
        h('button', { class: 'btn hover-popover-host',
                      onclick: () => openWeekSummary() },
          t('toolbar.week-summary'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.week-summary')))),
        h('button', { class: 'btn hover-popover-host',
                      onclick: () => openGithubModal() },
          t('toolbar.github'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.github')))),
        // The pending-event callout lives on each issue tab (the 🔔N
        // pill), so the toolbar button stays plain — no global count.
        h('button', {
          class: 'btn hover-popover-host',
          onclick: () => openAllEventsModal(),
        }, t('toolbar.agent-events'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.agent-events')))),
        h('button', {
          class: 'btn hover-popover-host',
          onclick: () => openNotesModal(null, { allMode: true }),
        }, t('toolbar.notes'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.notes')))),
        syncUiOn ? (() => {
          const enabled = !!(sync.enabled);
          const disabled = !sync.thread_running;
          const intervalMin = Math.round((sync.interval_seconds || 0) / 60);
          const titleParts = disabled
            ? ['Auto-sync thread disabled (server started with --no-sync)']
            : [`Auto-sync is ${enabled ? 'ON' : 'OFF'}`,
               `Interval when ON: ${intervalMin} min (~${Math.round(1440 / Math.max(intervalMin,1))} ticks/day)`,
               'Click to toggle.'];
          return h('button', {
            class: 'btn auto-sync-toggle hover-popover-host'
                   + (enabled ? ' on' : ''),
            id: 'auto-sync-btn',
            disabled: disabled ? '' : null,
            onclick: () => toggleAutoSync(),
          }, enabled ? '⏵ Auto-sync: ON' : '⏸ Auto-sync: OFF',
            h('div', { class: 'hover-popover' },
              h('div', { class: 'hover-popover-foot' },
                titleParts.join(' · '))),
          );
        })() : null,
        (() => {
          // Notifications button — visible only when permission isn't yet
          // granted, so it acts as a one-time opt-in.
          if (typeof Notification === 'undefined') return null;
          if (Notification.permission === 'granted') return null;
          return h('button', {
            class: 'btn hover-popover-host',
            onclick: () => requestNotificationPermission(),
          }, t('toolbar.enable-notifications'),
            h('div', { class: 'hover-popover' },
              h('div', { class: 'hover-popover-foot' },
                t('tip.enable-notifications'))),
          );
        })(),
        // Spacer pushes the right-hand cluster (Add issue + Filters)
        // to the right edge of the toolbar.
        h('span', { style: { flex: '1' } }),
        (() => {
          // Clones in flight = the primary repos don't have a .git
          // yet, so `git worktree add` from them would fail. Disable
          // the button with an explanatory tooltip until they finish.
          const inFlight = (primariesStatus && primariesStatus.in_flight)
            ? Object.keys(primariesStatus.in_flight) : [];
          const disabled = inFlight.length > 0;
          return h('button', {
            class: 'btn hover-popover-host'
              + (disabled ? ' is-disabled' : ''),
            disabled: disabled ? true : null,
            onclick: disabled ? null : (() => openAddIssueDialog()),
          },
            t('toolbar.add-issue'),
            h('div', { class: 'hover-popover' },
              h('div', { class: 'hover-popover-foot' },
                disabled
                  ? t('tip.add-issue.cloning',
                      { repos: inFlight.join(', ') })
                  : t('tip.add-issue'))));
        })(),
        h('button', {
          class: 'btn pinned-only-toggle hover-popover-host'
                  + (showPinnedOnly ? ' on' : ''),
          id: 'pinned-only-toggle',
          type: 'button',
          'aria-pressed': showPinnedOnly ? 'true' : 'false',
          onclick: () => {
            showPinnedOnly = !showPinnedOnly;
            localStorage.setItem(
              'show-pinned-only', showPinnedOnly ? '1' : '0');
            const btn = document.getElementById('pinned-only-toggle');
            if (btn) {
              btn.classList.toggle('on', showPinnedOnly);
              btn.setAttribute(
                'aria-pressed', showPinnedOnly ? 'true' : 'false');
              // Swap the leading text node so the 📌 ↔ 📍 glyph
              // tracks the toggle without a full re-render. The
              // first child is the label text; the hover-popover
              // div follows it.
              const labelNode = btn.firstChild;
              if (labelNode && labelNode.nodeType === Node.TEXT_NODE) {
                labelNode.nodeValue = showPinnedOnly
                  ? t('toolbar.pinned-only.on')
                  : t('toolbar.pinned-only');
              }
            }
            applyFilters();
          },
        }, showPinnedOnly
            ? t('toolbar.pinned-only.on')
            : t('toolbar.pinned-only'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.pinned-only')))),
        h('button', {
          class: 'btn compact-toolbar-toggle hover-popover-host'
                  + (compactMode ? ' on' : ''),
          id: 'compact-toolbar-toggle',
          type: 'button',
          'aria-pressed': compactMode ? 'true' : 'false',
          onclick: () => applyCompactMode(!compactMode),
        }, t('toolbar.compact'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.compact')))),
        h('button', {
          class: 'btn filters-toggle hover-popover-host'
                 + (filtersOpen ? ' on' : ''),
          id: 'filters-toggle',
          onclick: (e) => {
            const row = document.getElementById('filters-row');
            const btn = document.getElementById('filters-toggle');
            const isOpen = row.classList.toggle('open');
            btn.classList.toggle('on', isOpen);
            prefs.setItem('toolbar-filters-open', isOpen ? '1' : '0');
          },
        }, t('toolbar.filters'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.filters')))),
        h('button', { class: 'btn hover-popover-host help-toggle',
                      'aria-label': 'Help',
                      onclick: () => openHelpOverlay() },
          t('toolbar.help'),
          h('div', { class: 'hover-popover' },
            h('div', { class: 'hover-popover-foot' },
              t('tip.help')))),
        // Profile button at the far right of the toolbar — the
        // page title used to live in a separate <header> with the
        // profile on its right; that's been removed to free
        // vertical space.
        profileButton(state.user, state.editors || [], {
          generated: state.generated,
          worktreesRoot: state.worktrees_root,
          syncMeta: syncMetaText,
          syncStale,
          syncEnabled: sync.enabled,
        }),
      ),
      h('div', {
        class: 'filters-row' + (filtersOpen ? ' open' : ''),
        id: 'filters-row',
      },
        h('label', { class: 'toggle' },
          h('input', {
            type: 'checkbox', id: 'show-ghosts',
            checked: state.show_ghosts ? '' : null,
            onchange: () => { showGhosts = document.getElementById('show-ghosts').checked; refreshAll(true); },
          }),
          ' Show removed worktrees',
          state.summary.n_ghosts ? h('span', { class: 'badge-count' }, ` (${state.summary.n_ghosts})`) : null,
        ),
        h('label', { class: 'search-box' },
          h('input', {
            type: 'search', placeholder: 'filter tabs…',
            id: 'tab-search-input',
            value: searchText,
            oninput: (e) => { searchText = e.target.value; applyFilters(); },
          }),
        ),
        h('label', { class: 'sort-control' },
          'Sort: ',
          h('select', {
            id: 'tab-sort',
            onchange: (e) => { tabSort = e.target.value; refreshAll(true); },
          },
            h('option', { value: 'name',      selected: tabSort === 'name'      ? '' : null }, 'Name'),
            h('option', { value: 'recent',    selected: tabSort === 'recent'    ? '' : null }, 'Most recent'),
            h('option', { value: 'staleness', selected: tabSort === 'staleness' ? '' : null }, 'Most stale'),
          ),
        ),
        h('span', { class: 'filter-chips' },
          h('span', { class: 'filter-label' }, t('ui.filter.show-only')),
          ...['dirty', 'unpushed'].map(kind => h('label', {
            class: 'chip' + (filterFlags[kind] ? ' on' : ''),
            'data-kind': kind,
          },
            h('input', {
              type: 'checkbox', class: 'chip-cb',
              checked: filterFlags[kind] ? '' : null,
              onchange: (e) => {
                filterFlags[kind] = e.target.checked;
                applyFilters();
              },
            }),
            kind,
          )),
        ),
      ),
    );

    if (syncUiOn && syncStale) {
      const ageMin = sync.age_seconds == null
        ? null
        : Math.floor(sync.age_seconds / 60);
      const ageText = ageMin == null
        ? 'never (since this server started)'
        : ageMin >= 120 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`
        : `${ageMin} min ago`;
      app.append(h('div', { class: 'banner banner-warn' },
        h('strong', {}, '⚠ agent-workspace not synced recently'),
        ` · last sync: ${ageText} · threshold: ${Math.floor(sync.stale_seconds / 60)} min · `,
        h('button', { class: 'btn btn-inline', onclick: () => syncNow() }, t('btn.sync-now')),
      ));
    }

    // Missing-primary-repos banner. Surfaced on first start (and any
    // time a repo from the user's Expected-repos preference is not
    // yet checked out under <primaries_root>/<repo>). Each missing
    // repo gets a one-click Clone action that streams `git clone
    // --progress` so the button doubles as a live progress bar.
    // Dismiss hides the banner until the next page reload. The
    // shared "Clone all" button kicks off every missing repo in
    // parallel (the server runs each in its own daemon thread).
    if (!primariesBannerDismissed
        && primariesStatus
        && Array.isArray(primariesStatus.missing)
        && primariesStatus.missing.length) {
      const missing = primariesStatus.missing;
      const root = primariesStatus.primaries_root || '';
      const inFlight = primariesStatus.in_flight || {};
      const failures = primariesStatus.recent_failures || {};
      const banner = h('div', { class: 'banner banner-warn missing-primaries' });
      const head = h('div', { class: 'missing-primaries-head' },
        h('strong', {}, '⚠ Missing primary repos'),
        ` · expected under ${root}`,
      );
      banner.append(head);
      const rowsHost = h('div', { class: 'missing-primaries-rows' });
      for (const r of missing) {
        const flight = inFlight[r];
        const failed = !flight && !!failures[r];
        const pct = flight && flight.progress
          ? Math.max(0, Math.min(100, +flight.progress.pct || 0))
          : 0;
        const phase = flight && flight.progress
          ? flight.progress.phase : null;
        let label;
        if (flight) {
          // Compact phase initial so the button stays narrow:
          // "Recv 45%", "Resolv 90%", "Compress 12%".
          const short = phase ? phase.split(/\s+/)[0] : 'Cloning';
          label = `${short} ${r} ${pct}%`;
        } else if (failed) {
          label = `Retry ${r}`;
        } else {
          label = `Clone ${r}`;
        }
        const btn = h('button', {
          class: 'btn btn-inline primaries-clone-btn'
                  + (flight ? ' cloning' : '')
                  + (failed ? ' btn-danger' : ''),
          id: `primaries-clone-btn-${r}`,
          type: 'button',
          disabled: flight ? '' : null,
          title: failed
            ? (failures[r].error || '')
            : (flight && phase ? `${phase} — ${pct}%` : null),
          onclick: () => clonePrimary(r),
        }, label);
        if (flight) {
          // Drive the gradient fill via a CSS variable so the
          // existing .primaries-clone-btn rule paints the progress
          // bar without per-element style rewrites.
          btn.style.setProperty('--clone-pct', `${pct}%`);
        }
        rowsHost.append(btn, ' ');
      }
      banner.append(rowsHost);
      // Footer: Clone all + Dismiss.
      const anyInFlight = Object.keys(inFlight).length > 0;
      const cloneAllNeeded = missing.filter(r => !inFlight[r]);
      const foot = h('div', { class: 'missing-primaries-foot' });
      if (cloneAllNeeded.length > 1) {
        foot.append(h('button', {
          class: 'btn btn-inline btn-primary',
          type: 'button',
          onclick: () => {
            for (const r of cloneAllNeeded) clonePrimary(r);
          },
        }, `Clone all (${cloneAllNeeded.length})`));
        foot.append(' ');
      }
      foot.append(h('button', {
        class: 'btn btn-inline', type: 'button',
        onclick: () => {
          primariesBannerDismissed = true;
          if (window.__lastState) {
            snapshotOpenState();
            renderApp(window.__lastState);
            applyFilters();
          }
        },
      }, 'Dismiss'));
      banner.append(foot);
      app.append(banner);
      // If we already see in-flight clones (e.g. the user reloaded
      // mid-clone), kick the poll loop so the banner advances.
      if (anyInFlight) maybeStartPrimariesPoll();
    }

    // End-of-workday reminder: weekday (Mon–Fri) at/after 16:00 local,
    // and the last sync was either earlier than today's 16:00 or never.
    // Auto-dismisses once you sync (manual or auto) past 16:00.
    if (syncUiOn && shouldShowEodReminder(sync)) {
      app.append(h('div', { class: 'banner banner-warn eod-reminder' },
        h('strong', {}, '🕓 End-of-day sync reminder'),
        " · It's after 16:00 — push today's work to agent-workspace so other machines pick it up. ",
        h('button', { class: 'btn btn-inline', onclick: () => syncNow() }, t('btn.sync-now')),
      ));
    }
    // Fire a desktop notification too (deduped per-day via localStorage).
    if (syncUiOn) maybeFireEodNotification(sync);

    const s = state.summary;
    const stat = (cls, label, value) =>
      h('div', { class: `stat ${cls}` },
        h('div', { class: 'label' }, label),
        h('div', { class: 'value' }, String(value)));

    // AGENTS card: number of live (active+idle) Claude sessions across
    // every issue, against the count we expect (one per live issue).
    // A mismatch means a tab was probably closed — hovering the card
    // pops a styled per-issue table.
    const agentsTotal    = s.n_agents_total ?? 0;
    const agentsExpected = s.n_agents_expected ?? 0;
    const agentsIdle     = s.n_agents_idle ?? 0;
    const agentsCls      = (agentsExpected > 0 && agentsTotal < agentsExpected)
      ? 'warn' : 'ok';
    // Per-issue rows for the hover table. Skip ghost issues (no live
    // worktree, nothing to monitor) so the tooltip stays focused on
    // what the user can act on.
    const liveIssues = (state.issues || []).filter(
      i => !(i.repos || []).every(r => r.ghost));
    const agentTooltipRows = liveIssues.map(i => {
      const st = i.agent_state || 'unknown';
      return h('tr', {
        class: 'hover-popover-row',
        title: `Open ${i.issue} tab`,
        tabindex: '0',
        onclick: () => focusIssueTab(i.issue),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusIssueTab(i.issue);
          }
        },
      },
        h('td', {}, i.issue),
        h('td', {},
          h('span',
            { class: `agent-state-pill agent-state-${st}` }, st)),
      );
    });
    const agentTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('tip.kv.issue')),
          h('th', {}, t('tip.kv.status')),
        )),
        h('tbody', {},
          agentTooltipRows.length
            ? agentTooltipRows
            : h('tr', {}, h('td', { colspan: '2', class: 'muted' },
                t('tip.kv.no-live-issues'))),
        ),
      ),
    );
    const agentsCard = h('div', { class: `stat ${agentsCls} hover-popover-host` },
      h('div', { class: 'label' }, t('stat.agents')),
      h('div', { class: 'value' },
        String(agentsTotal),
        agentsIdle > 0
          ? h('span', { class: 'stat-sub' },
              ' ' + t('stat.idle-suffix', { n: agentsIdle }))
          : null,
      ),
      agentTooltip,
    );

    // UNPUSHED COMMITS — same shape as the AGENTS card: hover tooltip
    // lists every issue that has unpushed work, with the per-issue
    // sum of n_unpushed across its repos.
    const issuesWithUnpushed = (state.issues || []).map(i => {
      const live = (i.repos || []).filter(
        r => !r.ghost && !r.missing);
      const unp = live.reduce((sum, r) => sum + (r.n_unpushed | 0), 0);
      return { issue: i.issue, unpushed: unp, repos: live };
    }).filter(x => x.unpushed > 0)
      .sort((a, b) => b.unpushed - a.unpushed);
    const unpushedTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('stat.issues')),
          h('th', { class: 'num' }, t('stat.unpushed')),
        )),
        h('tbody', {},
          issuesWithUnpushed.length
            ? issuesWithUnpushed.map(x => h('tr', {
                class: 'hover-popover-row',
                title: `Open ${x.issue} tab`,
                tabindex: '0',
                onclick: () => focusIssueTab(x.issue),
                onkeydown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focusIssueTab(x.issue);
                  }
                },
              },
                h('td', {}, x.issue),
                h('td', { class: 'num' }, '↑' + x.unpushed),
              ))
            : h('tr', {}, h('td', { colspan: '2', class: 'muted' },
                'Nothing unpushed.')),
        ),
      ),
    );
    const unpushedCard = h('div', {
      class: `stat ${s.n_unpushed ? 'warn' : 'ok'} hover-popover-host`,
    },
      h('div', { class: 'label' }, t('stat.unpushed')),
      h('div', { class: 'value' }, String(s.n_unpushed)),
      unpushedTooltip,
    );

    // Helper for the "click row → activate tab" boilerplate shared by
    // every per-issue popover row.
    const issueRow = (cells, issue) => h('tr', {
      class: 'hover-popover-row',
      title: `Open ${issue} tab`,
      tabindex: '0',
      onclick: () => focusIssueTab(issue),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          focusIssueTab(issue);
        }
      },
    }, ...cells);

    // ISSUES card — every issue, with its agent state. Click an issue
    // to jump to its tab.
    const allIssuesList = (state.issues || []).slice()
      .sort((a, b) => a.issue.localeCompare(b.issue));
    const issuesTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table issues-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('stat.issues')),
          h('th', {}, t('stat.issues.agent')),
          h('th', { class: 'num' }, t('stat.issues.repos')),
        )),
        h('tbody', {},
          allIssuesList.length
            ? allIssuesList.map(i => {
                const live = (i.repos || []).filter(
                  r => !r.ghost && !r.missing);
                return issueRow([
                  h('td', {}, i.issue),
                  h('td', {}, h('span',
                    { class: `agent-state-pill agent-state-${i.agent_state || 'unknown'}` },
                    i.agent_state || 'unknown')),
                  h('td', { class: 'num' }, String(live.length)),
                ], i.issue);
              })
            : h('tr', {}, h('td', { colspan: '3', class: 'muted' },
                t('stat.issues.empty'))),
        ),
      ),
    );
    const issuesCard = h('div', { class: 'stat hover-popover-host' },
      h('div', { class: 'label' }, t('stat.issues')),
      h('div', { class: 'value' }, String(s.n_issues)),
      issuesTooltip,
    );

    // REPO CHECKOUTS card — one row per live repo across every issue.
    const allRepoRows = [];
    for (const i of (state.issues || [])) {
      for (const r of (i.repos || [])) {
        if (r.ghost || r.missing) continue;
        allRepoRows.push({
          issue: i.issue,
          repo: r.repo,
          branch: r.branch || '—',
        });
      }
    }
    allRepoRows.sort((a, b) =>
      a.issue.localeCompare(b.issue) || a.repo.localeCompare(b.repo));
    const reposTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('stat.issues')),
          h('th', {}, t('col.repo')),
          h('th', {}, t('col.branch')),
        )),
        h('tbody', {},
          allRepoRows.length
            ? allRepoRows.map(r => issueRow([
                h('td', {}, r.issue),
                h('td', {}, r.repo),
                h('td', {}, r.branch),
              ], r.issue))
            : h('tr', {}, h('td', { colspan: '3', class: 'muted' },
                t('empty.no-repos'))),
        ),
      ),
    );
    const reposCard = h('div', { class: 'stat hover-popover-host' },
      h('div', { class: 'label' }, t('stat.repo-checkouts')),
      h('div', { class: 'value' }, String(s.n_repos)),
      reposTooltip,
    );

    // DIRTY TREES card — one row per issue that has at least one repo
    // with uncommitted changes; column shows total dirty file count.
    const dirtyRows = (state.issues || []).map(i => {
      const live = (i.repos || []).filter(r => !r.ghost && !r.missing);
      const dirty = live.reduce((sum, r) => sum + (r.n_dirty | 0), 0);
      const dirtyRepos = live.filter(r => (r.n_dirty | 0) > 0)
        .map(r => r.repo).join(', ');
      return { issue: i.issue, dirty, dirtyRepos };
    }).filter(x => x.dirty > 0)
      .sort((a, b) => b.dirty - a.dirty);
    const dirtyTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('stat.issues')),
          h('th', {}, t('col.repos')),
          h('th', { class: 'num' }, t('col.dirty')),
        )),
        h('tbody', {},
          dirtyRows.length
            ? dirtyRows.map(x => issueRow([
                h('td', {}, x.issue),
                h('td', {}, x.dirtyRepos),
                h('td', { class: 'num' }, String(x.dirty)),
              ], x.issue))
            : h('tr', {}, h('td', { colspan: '3', class: 'muted' },
                t('empty.no-dirty'))),
        ),
      ),
    );
    const dirtyCard = h('div', {
      class: `stat ${s.n_dirty ? 'warn' : 'ok'} hover-popover-host`,
    },
      h('div', { class: 'label' }, t('stat.dirty-trees')),
      h('div', { class: 'value' }, String(s.n_dirty)),
      dirtyTooltip,
    );

    // BRANCHES >N BEHIND card — one row per repo whose branch is more
    // than `behind_limit` commits behind upstream. Click jumps to the
    // owning issue's tab.
    const behindRows = [];
    for (const i of (state.issues || [])) {
      for (const r of (i.repos || [])) {
        if (r.ghost || r.missing) continue;
        if (!r.too_behind) continue;
        behindRows.push({
          issue: i.issue,
          repo: r.repo,
          behind: r.behind | 0,
          upstream: r.upstream || '',
        });
      }
    }
    behindRows.sort((a, b) => b.behind - a.behind);
    const behindTooltip = h('div', {
      class: 'hover-popover', role: 'tooltip',
    },
      h('table', { class: 'hover-popover-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('stat.issues')),
          h('th', {}, t('col.repo')),
          h('th', { class: 'num' }, t('col.behind')),
          h('th', {}, t('col.upstream')),
        )),
        h('tbody', {},
          behindRows.length
            ? behindRows.map(x => issueRow([
                h('td', {}, x.issue),
                h('td', {}, x.repo),
                h('td', { class: 'num' }, '↓' + x.behind),
                h('td', { class: 'muted' }, x.upstream),
              ], x.issue))
            : h('tr', {}, h('td', { colspan: '4', class: 'muted' },
                'No branches that far behind.')),
        ),
      ),
    );
    const behindCard = h('div', {
      class: `stat ${s.n_behind_bad ? 'danger' : 'ok'} hover-popover-host`,
    },
      h('div', { class: 'label' },
        t('stat.behind', { n: state.behind_limit })),
      h('div', { class: 'value' }, String(s.n_behind_bad)),
      behindTooltip,
    );

    app.append(h('div', { class: 'summary' },
      agentsCard,
      issuesCard,
      dirtyCard,
      unpushedCard,
      reposCard,
      behindCard,
    ));

    if (s.n_behind_bad > 0) {
      // Per-row dismissals — clicking ✕ on a row stores its current
      // `behind` value in localStorage; the row stays hidden until
      // its behind count exceeds the dismissed value (i.e. the
      // branch falls further behind), at which point it re-surfaces.
      // The summary card count is unaffected — it always reflects
      // reality. Only the banner is dismissible.
      let acks;
      try { acks = JSON.parse(localStorage.getItem('behindAcks') || '{}'); }
      catch (_) { acks = {}; }
      const items = (s.behind_bad_list || []).filter(o => {
        const a = acks[`${o.issue}/${o.repo}`];
        return !(typeof a === 'number' && o.behind <= a);
      });
      if (items.length > 0) {
        app.append(h('div', { class: 'banner' },
          h('strong', {}, `⚠ ${items.length} branch(es) more than ${state.behind_limit} commits behind their upstream — rebase/merge before continuing work:`),
          h('ul', {}, ...items.map(o => h('li', {},
            `${o.issue}/${o.repo}: ${o.behind} commits behind ${o.upstream} `,
            h('button', {
              class: 'banner-dismiss',
              title: 'Hide until this branch falls further behind',
              'aria-label': `Dismiss warning for ${o.issue}/${o.repo}`,
              onclick: () => {
                let cur;
                try { cur = JSON.parse(localStorage.getItem('behindAcks') || '{}'); }
                catch (_) { cur = {}; }
                cur[`${o.issue}/${o.repo}`] = o.behind;
                localStorage.setItem('behindAcks', JSON.stringify(cur));
                if (window.__lastState) renderApp(window.__lastState);
              },
            }, '✕'),
          ))),
        ));
      }
    }

    if (showActivity) {
      const heatmap = h('div', { class: 'heatmap-card' });
      app.append(heatmap);
      loadHeatmap(heatmap);
    }

    // Timer + work-log controls live just below the activity heatmap.
    if (showTimer) {
      app.append(buildTimerCard());
      loadTimerState();
    }

    // First-run / empty-state — no issue tabs. Render the pinned
    // Starting + Agent tabs and bail; renderPinnedTabs creates a
    // stub nav.tabs so the layout still has a tab strip.
    if (!state.issues || state.issues.length === 0) {
      renderPinnedTabs(state, app);
      resolveInitialActiveTab(previousTab);
      return;
    }
    const tabsNav = h('nav', { class: 'tabs' });
    // Sort issues by the user-selected key before laying out tabs.
    const sortedIssues = sortIssues(state.issues, tabSort);
    // Refresh per-issue badge freshness state before we render the
    // strip — count increases since the last rebuild get a 7-second
    // "fresh" stamp that the badge styling reads via isBadgeFresh.
    bumpBadgeFreshness(sortedIssues);

    // Hover tooltip on each tab — a small table listing every repo
    // under the issue with its ↓ ↑ counts + dirty marker. Replaces the
    // misleading aggregate "↑N" that used to live in the tab text and
    // matches the look of the agent-events table.
    function buildTabInfoTooltip(issueObj) {
      const rows = (issueObj.repos || []).map(r => {
        if (r.missing) {
          return h('tr', {},
            h('td', {}, r.repo),
            h('td', { class: 'muted', colspan: '3' },
              t('repo.not-in-worktree')));
        }
        if (r.ghost) {
          return h('tr', {},
            h('td', {}, r.repo),
            h('td', { class: 'muted', colspan: '3' }, 'removed'));
        }
        const inc = Math.max(0, r.n_to_pull | 0);
        const out = Math.max(0, r.n_unpushed | 0);
        return h('tr', {},
          h('td', {}, r.repo),
          h('td', { class: 'num' }, '↓' + inc),
          h('td', { class: 'num' }, '↑' + out),
          h('td', {},
            r.n_dirty > 0
              ? h('span', { class: 'pill dirty' },
                  `${r.n_dirty} change${r.n_dirty !== 1 ? 's' : ''}`)
              : h('span', { class: 'muted' }, '—')),
        );
      });
      return h('div', { class: 'hover-popover',
                          onclick: (e) => e.stopPropagation() },
        h('table', { class: 'hover-popover-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, t('col.repo')),
            h('th', { class: 'num' }, '↓ Pull'),
            h('th', { class: 'num' }, '↑ Push'),
            h('th', {}, t('col.working-tree')),
          )),
          h('tbody', {}, ...rows),
        ),
      );
    }

    sortedIssues.forEach((issueObj, i) => {
      const warn = issueObj.repos.filter(r => r.too_behind).length;
      const idle = issueObj.repos.some(r => (r.last_commit_age_days ?? -1) >= 14);
      const dirty = issueObj.repos.some(
        r => !r.ghost && !r.missing && r.n_dirty > 0);
      const cls = (i === 0 ? 'active' : '') + (warn ? ' has-warn' : '');
      const btn = h('button', {
        class: cls.trim() || null,
        'data-tab': `tab-${slugId(issueObj.issue)}`,
        onclick: () => focusIssueTab(issueObj.issue),
      }, (idle ? '💤 ' : '') + issueObj.issue
         + (dirty ? ' *' : ''));
      // Tiny info icon at the end of the tab — only THIS triggers the
      // hover popover with the per-repo ↓ ↑ table. Hovering the rest
      // of the tab (e.g. while clicking to switch) leaves the strip
      // quiet. Click on the icon doesn't activate the tab — the
      // stopPropagation prevents the parent button's onclick.
      btn.append(h('span', {
        class: 'tab-info-icon tab-info-host',
        role: 'button', tabindex: '0',
        'aria-label': `${issueObj.issue} details`,
        onclick: (ev) => ev.stopPropagation(),
      }, 'ⓘ', buildTabInfoTooltip(issueObj)));
      // GitHub issue + PR pills — present when the dashboard's
      // GitHub integration is configured AND a) the workspace folder
      // name starts with a digit-prefix matching an issue, or
      // b) a PR exists whose head branch equals the workspace name.
      const gh = issueObj.github;
      if (gh?.issue) {
        const gi = gh.issue;
        btn.append(h('a', {
          class: `github-pill github-pill-${gi.state || 'open'}`,
          href: gi.url, target: '_blank', rel: 'noopener noreferrer',
          title: gi.title || '',
          onclick: (e) => e.stopPropagation(),
        }, `#${gi.number}`));
      }
      if (gh?.pr) {
        const gp = gh.pr;
        btn.append(h('a', {
          class: `github-pill github-pill-pr github-pill-${gp.state || 'open'}${gp.isDraft ? ' github-pill-draft' : ''}`,
          href: gp.url, target: '_blank', rel: 'noopener noreferrer',
          title: gp.title || '',
          onclick: (e) => e.stopPropagation(),
        }, 'PR'));
      }
      if (warn) btn.append(h('span', { class: 'badge' }, `⚠${warn}`));
      // Pending agent-event badge — clicking it opens the agent-events
      // modal scoped to this issue, where the events can be read and
      // marked read without leaving the current tab. Use a <span> (not
      // <button>) so the parser doesn't auto-close the outer tab button.
      // Count only the kinds the user has opted in to (configured from
      // the profile popover).
      const pending = filteredPendingFor(issueObj);
      if (pending > 0) {
        const evFresh = isBadgeFresh(issueObj.issue, 'events');
        btn.append(h('span', {
          class: 'badge pending-events-badge'
                  + (evFresh ? ' badge-fresh' : ''),
          role: 'button', tabindex: '0',
          title: `${pending} unread agent event${pending !== 1 ? 's' : ''} — click to open`,
          onclick: (e) => {
            e.stopPropagation();
            openAllEventsModal(issueObj.issue);
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openAllEventsModal(issueObj.issue);
            }
          },
        }, `🔔${pending}`));
      }
      // TODO-notes badge — same shape as the bell, different colour and
      // icon. Click opens the per-issue Notes modal scoped to this tab.
      const todos = issueObj.pending_todos || 0;
      if (todos > 0) {
        const todoFresh = isBadgeFresh(issueObj.issue, 'todos');
        btn.append(h('span', {
          class: 'badge pending-todos-badge'
                  + (todoFresh ? ' badge-fresh' : ''),
          role: 'button', tabindex: '0',
          title: `${todos} open note${todos !== 1 ? 's' : ''} — click to open`,
          onclick: (e) => {
            e.stopPropagation();
            openNotesModal(issueObj.issue);
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openNotesModal(issueObj.issue);
            }
          },
        }, `📝${todos}`));
      }
      // MCP unread-mail badge — only when the feature is enabled.
      // Per the General Agent design, the per-agent mailbox UI lives
      // under the General Agent's Messages sub-tab. Clicking the
      // badge on a non-General tab opens the same view as a modal
      // so the user can peek at *this issue's* inbox in place.
      const unread = issueObj.unread_messages || 0;
      if (unread > 0 && mcpEnabledOn()) {
        btn.append(h('span', {
          class: 'badge mcp-unread-badge',
          role: 'button', tabindex: '0',
          title: `${unread} unread message${unread !== 1 ? 's' : ''} — click to open`,
          onclick: (e) => {
            e.stopPropagation();
            openAgentMessagesModal(issueObj.issue);
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openAgentMessagesModal(issueObj.issue);
            }
          },
        }, `📬${unread}`));
      }
      tabsNav.append(btn);
    });
    // Wrap the strip in a flex container with both ◀ / ▶ scroll buttons
    // grouped on the right. Buttons only render when the strip overflows
    // (.tabs-wrap.overflowing toggled by setupTabsScroll). Scrollbar
    // is hidden since the arrows are the canonical control.
    const scrollLeft = h('button', {
      class: 'tabs-scroll-btn left', type: 'button',
      title: 'Scroll tabs left', 'aria-label': 'Scroll tabs left',
    }, '◀');
    const scrollRight = h('button', {
      class: 'tabs-scroll-btn right', type: 'button',
      title: 'Scroll tabs right', 'aria-label': 'Scroll tabs right',
    }, '▶');
    const scrollBtns = h('div', { class: 'tabs-scroll-btns' },
      scrollLeft, scrollRight);
    const tabsWrap = h('div', { class: 'tabs-wrap' }, tabsNav, scrollBtns);
    app.append(tabsWrap);
    setupTabsScroll(tabsWrap);

    // Inject the pinned Starting (only when no issues — not the
    // case in this branch) + Agent tabs into the live tab strip.
    renderPinnedTabs(state, app);

    sortedIssues.forEach((issueObj) => {
      const sec = tabSectionFor(issueObj, state.behind_limit);
      app.append(sec);
    });

    resolveInitialActiveTab(previousTab);
  }

  // Pick which tab to activate after a render. Order of preference:
  //   1. Whatever the URL hash points at, IF its button exists and
  //      isn't hidden by the Pinned-only filter.
  //   2. The first visible issue tab.
  //   3. The Agent tab (always visible when generalAgentOn()).
  //   4. The Starting tab (only when no issues).
  // Doing the resolution here in one place removes the need for
  // overlapping fallback logic across renderApp / applyFilters /
  // activateTab.
  function resolveInitialActiveTab(previousTab) {
    const visibleIssueBtn = (() => {
      const buttons = document.querySelectorAll('nav.tabs button');
      for (const b of buttons) {
        if (b.style.display !== 'none') return b;
      }
      return null;
    })();
    const agentBtn = document.querySelector(
      '.tabs-wrap > button.tab-general-agent');
    const startingBtn = document.querySelector(
      '.tabs-wrap > button.tab-starting');

    const wanted = previousTab
      && document.querySelector(
        `.tabs-wrap [data-tab="${CSS.escape(previousTab)}"]`);
    if (wanted && wanted.style.display !== 'none') {
      activateTab(previousTab);
      return;
    }
    if (visibleIssueBtn) {
      activateTab(visibleIssueBtn.dataset.tab);
      return;
    }
    if (agentBtn) {
      activateTab('tab-agent-general');
      return;
    }
    if (startingBtn) {
      activateTab('tab-starting');
    }
  }

  // Render the pinned "General Agent" tab + section. Called from
  // both the empty-state path and the populated-dashboard path so
  // the tab is always available — there's literally nowhere on the
  // dashboard where this should be missing.
  // Pinned tabs that sit outside the scrolling nav.tabs strip:
  //   - "Starting" — only when no issues exist (hosts the empty-state
  //      guidance card with Add-issue / Help buttons).
  //   - "Agent" — when generalAgentOn() is true (hosts the issue-less
  //      claude terminal).
  // Order in DOM: [Starting?] [Agent?] then nav.tabs (issue tabs).
  // Both render as direct children of .tabs-wrap so the horizontal
  // scroll on nav.tabs can't ever push them off the left edge.
  function renderPinnedTabs(state, app) {
    const tabsWrap = app.querySelector('.tabs-wrap')
      || (() => {
        const stubNav = h('nav', { class: 'tabs' });
        const stubWrap = h('div', { class: 'tabs-wrap tabs-wrap-empty' },
          stubNav);
        app.append(stubWrap);
        return stubWrap;
      })();
    const noIssues = !state.issues || state.issues.length === 0;

    // Build helpers in INSERTION order so the first prepended ends
    // up rightmost among the pinned tabs. We want Starting (left)
    // then Agent (right of Starting, left of issues) — so prepend
    // Agent first, then Starting.

    let agentBtn = null;
    if (generalAgentOn()) {
      const generalEvents = state.general_pending_events || 0;
      const generalTodos = state.general_pending_todos || 0;
      agentBtn = h('button', {
        class: 'tab tab-general-agent',
        type: 'button',
        'data-tab': 'tab-agent-general',
        onclick: () => activateTab('tab-agent-general'),
      });
      agentBtn.append(agentIconNode('agent-icon-inline'));
      // Use the "Agent Engineering" label only on the top tab
      // strip — other surfaces (modal titles, agent picker rows,
      // pane subjects) keep saying "General Agent" so the rename
      // is purely the entry-point chrome the user sees first.
      agentBtn.append(' ' + t('tab.engineering-agent'));
      if (generalEvents > 0) {
        agentBtn.append(h('span', { class: 'badge bell-badge' },
          '🔔 ' + generalEvents));
      }
      if (generalTodos > 0) {
        agentBtn.append(h('span', { class: 'badge note-badge' },
          '📝 ' + generalTodos));
      }
      const generalUnread = state.general_unread_messages || 0;
      if (generalUnread > 0 && mcpEnabledOn()) {
        const focusMessages = () => {
          activateTab('tab-agent-general');
          // Activate the Messages sub-tab inside the General Agent
          // panel. Find by the rendered button (its label = the
          // translated "Messages") and click it; matches the same
          // path the human would take.
          const sec = document.getElementById('tab-agent-general');
          const btn = sec?.querySelector(
            '.issue-subtab[data-issue-sub="messages"]');
          if (btn) btn.click();
        };
        agentBtn.append(h('span', {
          class: 'badge mcp-unread-badge',
          role: 'button', tabindex: '0',
          title: `${generalUnread} unread message${generalUnread !== 1 ? 's' : ''} — click to open`,
          onclick: (e) => { e.stopPropagation(); focusMessages(); },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); e.stopPropagation();
              focusMessages();
            }
          },
        }, '📬 ' + generalUnread));
      }
      tabsWrap.prepend(agentBtn);

      const agentSection = h('section', {
        class: 'tab tab-general-agent-section',
        id: 'tab-agent-general',
      });
      agentSection.append(buildGeneralAgentPanel());
      app.append(agentSection);
    }

    let startingBtn = null;
    if (noIssues) {
      startingBtn = h('button', {
        class: 'tab tab-starting',
        type: 'button',
        'data-tab': 'tab-starting',
        onclick: () => activateTab('tab-starting'),
      }, '🌱 ', t('tab.starting'));
      tabsWrap.prepend(startingBtn);
      app.append(buildStartingSection(state));
    }
  }

  // Backwards-compat shim — old call sites still invoke
  // renderGeneralAgentTab; route to the new unified function.
  function renderGeneralAgentTab(state, app) {
    renderPinnedTabs(state, app);
  }

  // General Agent panel — used by the pinned tab. Identical to the
  // per-issue Agent panel, but the issueObj is synthetic (issue key
  // '__agent__', no repos) so the panel skips the repo picker /
  // Open editor button and the build_agent_argv on the server side
  // runs the agent CLI in $HOME without a workspace prompt.
  function buildGeneralAgentPanel() {
    const fakeIssueObj = {
      issue: '__agent__',
      repos: [],
      pending_events: 0,
      pending_events_by_kind: {},
      pending_todos: 0,
      agent_state: 'closed',
      agent_running: false,
    };
    const agentPanel = buildAgentPanel(fakeIssueObj);
    agentPanel.id = 'issue-sub-agent-__agent__';
    agentPanel.classList.add('issue-agent-panel-general');

    // When the MCP toggle is off, the Messages tab serves no purpose
    // (no tools are exposed, no badges appear); just return the
    // terminal-only panel as before.
    if (!mcpEnabledOn()) return agentPanel;

    // Build the Messages + Stashes panes up-front so their initial
    // fetches fire before the user clicks the sub-tab. The panes
    // self-poll while in the DOM (4s for messages, 5s for stashes)
    // so they stay current without explicit refreshes.
    const messagesPane = buildMessagesPaneFor('__agent__');
    const messagesWrap = h('div', {
      id: 'issue-sub-messages-__agent__',
      class: 'issue-subpanel issue-messages-panel',
    }, messagesPane);
    const stashesPane = buildStashesPaneFor();
    const stashesWrap = h('div', {
      id: 'issue-sub-stashes-__agent__',
      class: 'issue-subpanel issue-messages-panel',
    }, stashesPane);

    // Sub-tab strip — same shape as the per-issue Branches/Agent
    // strip: horizontal icon-only buttons with the active tab also
    // showing its label. Agent is default-active so users land on
    // the terminal; flipping to Messages re-fetches /api/mcp/messages
    // and flipping to Stashes re-fetches /api/stashes. The strip's
    // right slot (.issue-subtab-actions) holds the active sub-tab's
    // action controls — quick-message bar for Agent, empty for the
    // other two.
    const subActive = perIssueAgentSub.get('__agent__') || 'agent';
    const subBar = h('div', { class: 'issue-subtabbar issue-subtabbar-side',
                                role: 'tablist' });
    const subActions = h('div', { class: 'issue-subtab-actions' });
    const refreshSubActions = () => {
      const cur = perIssueAgentSub.get('__agent__') || 'agent';
      subActions.replaceChildren();
      if (cur === 'agent' && agentPanel && agentPanel._controlsRow) {
        subActions.append(agentPanel._controlsRow);
      } else if (cur === 'messages' && messagesPane._controlsRow) {
        subActions.append(messagesPane._controlsRow);
      } else if (cur === 'stashes' && stashesPane._controlsRow) {
        subActions.append(stashesPane._controlsRow);
      }
    };
    const activate = (id) => {
      perIssueAgentSub.set('__agent__', id);
      subBar.querySelectorAll('.issue-subtab').forEach((b) =>
        b.classList.toggle('active', b.dataset.issueSub === id));
      agentPanel.style.display    = id === 'agent'    ? '' : 'none';
      messagesWrap.style.display  = id === 'messages' ? '' : 'none';
      stashesWrap.style.display   = id === 'stashes'  ? '' : 'none';
      if (id === 'messages' && messagesPane.reloadMessages) {
        messagesPane.reloadMessages();
      }
      if (id === 'stashes' && stashesPane.reloadStashes) {
        stashesPane.reloadStashes();
      }
      refreshSubActions();
      // When flipping back to the Agent sub-tab from Messages,
      // re-fit the xterm. Mirrors the per-issue activate(): going
      // display:none → '' doesn't always re-fire the ResizeObserver,
      // and without an explicit fit the terminal keeps whatever
      // cols/rows it computed against the 0×0 hidden host.
      if (id === 'agent') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const cur = inlineAgentState.get('__agent__');
          if (cur && cur.fit && cur.term) {
            try {
              const p = cur.fit.proposeDimensions?.();
              if (p && p.cols >= 40 && p.rows >= 5 &&
                  (p.cols !== cur.term.cols || p.rows !== cur.term.rows)) {
                cur.fit.fit();
                postResize('__agent__', cur.term.cols, cur.term.rows);
              }
            } catch (_) {}
          }
        }));
        snapAgentTermToBottom('__agent__');
      }
    };
    const mkSubBtn = (id, content, label) => h('button', {
      class: 'issue-subtab issue-subtab-icon'
              + (subActive === id ? ' active' : ''),
      type: 'button', role: 'tab',
      'data-issue-sub': id,
      'aria-label': label, title: label,
      onclick: () => activate(id),
    },
      h('span', { class: 'issue-subtab-icon-glyph', 'aria-hidden': 'true' },
        content),
      h('span', { class: 'issue-subtab-label' }, label),
    );
    subBar.append(
      mkSubBtn('agent',    agentIconNode(), t('issue.subtab.agent')),
      mkSubBtn('messages', '📬', t('issue.subtab.messages')),
      mkSubBtn('stashes',  '💾', t('issue.subtab.stashes')),
    );
    // Initial population of the right-side slot (Agent is the default
    // active sub-tab).
    refreshSubActions();
    const subRow = h('div', { class: 'issue-subtab-row' },
      subBar, subActions);

    // Apply the persisted sub-tab's visibility. Was a bug before:
    // when subActive === 'messages' from a previous activate() and
    // /api/status auto-refreshed (every 5 min, rebuilding this
    // panel), the new messagesWrap was constructed with inline
    // display:none and never flipped back — the user saw an empty
    // panel after every refresh.
    agentPanel.style.display    = subActive === 'agent'    ? '' : 'none';
    messagesWrap.style.display  = subActive === 'messages' ? '' : 'none';
    stashesWrap.style.display   = subActive === 'stashes'  ? '' : 'none';

    return h('div', {
      class: 'issue-body-wrap general-agent-body-wrap'
              + (fullscreenMode ? ' agent-fullscreen' : ''),
    },
      subRow,
      h('div', { class: 'issue-body-content' },
        agentPanel, messagesWrap, stashesWrap),
    );
  }

  // The "Starting" tab — only rendered when no issues exist. Hosts
  // the empty-state card with the Add-issue / Help buttons. Lives
  // alongside the Agent tab (also pinned) so the user can flip
  // between agent and guidance even on an empty dashboard.
  function buildStartingSection(state) {
    return h('section', {
      class: 'tab tab-starting-section',
      id: 'tab-starting',
    },
      h('div', { class: 'empty-state-card' },
        h('div', { class: 'empty-state-icon', 'aria-hidden': 'true' }, '🌱'),
        h('h2', {}, t('empty.dashboard.title')),
        h('p', {}, t('empty.dashboard.body', {
          path: state.worktrees_root || '~/git/worktrees' })),
        h('div', { class: 'empty-state-actions' },
          (() => {
            const inFlight = (primariesStatus && primariesStatus.in_flight)
              ? Object.keys(primariesStatus.in_flight) : [];
            const disabled = inFlight.length > 0;
            return h('button', {
              class: 'btn btn-primary' + (disabled ? ' is-disabled' : ''),
              disabled: disabled ? true : null,
              title: disabled
                ? t('tip.add-issue.cloning',
                    { repos: inFlight.join(', ') })
                : null,
              onclick: disabled ? null : (() => openAddIssueDialog()),
            }, t('toolbar.add-issue'));
          })(),
          h('button', {
            class: 'btn',
            onclick: () => openHelpOverlay(),
          }, t('toolbar.help')),
        ),
      ),
    );
  }

  // User-facing "navigate to this issue's tab" entry point. Wraps
  // activateTab() with auto-pinning so that clicks from popup lists
  // (agent events, week summary, tooltips) always land on a
  // visible tab, even when "Pinned only" is on.
  //
  // activateTab() itself stays auto-pin-free so that internal
  // restoration paths (renderApp's previousTab restore, applyFilters'
  // first-visible fallback) don't accidentally re-pin what the user
  // just unpinned.
  function focusIssueTab(issueKey) {
    if (showPinnedOnly && !pinnedIssues.has(issueKey)) {
      pinnedIssues.add(issueKey);
      savePinnedIssues(pinnedIssues);
      if (window.__lastState) {
        snapshotOpenState();
        renderApp(window.__lastState);
        applyFilters();
      }
    }
    activateTab(`tab-${slugId(issueKey)}`);
    // If there's a live inline-agent xterm for this issue, refit it
    // now that its host has real pixel dimensions. Necessary because
    // ResizeObserver doesn't reliably fire on display:none → visible
    // transitions, so without this the terminal keeps the 80×24 it
    // computed during initial 0×0 layout.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const cur = inlineAgentState.get(issueKey);
      if (cur && cur.fit && cur.term) {
        try {
          const p = cur.fit.proposeDimensions?.();
          if (p && p.cols >= 40 && p.rows >= 5 &&
              (p.cols !== cur.term.cols || p.rows !== cur.term.rows)) {
            cur.fit.fit();
            postResize(issueKey, cur.term.cols, cur.term.rows);
          }
        } catch (_) {}
        // snapAgentTermToBottom does scrollToBottom + focus with the
        // verifying retry loop, so it works even if the host's layout
        // hasn't settled yet on the very first paint after focus.
        const agentSubActive = issueKey === '__agent__'
          || (perIssueAgentSub.get(issueKey) || 'agent') === 'agent';
        if (agentSubActive) snapAgentTermToBottom(issueKey);
      }
    }));
  }

  function activateTab(id) {
    // Find the target button by data-tab anywhere under .tabs-wrap
    // (the General Agent button is a sibling of nav.tabs, not a
    // descendant). Fall back to the General Agent when the target
    // tab exists but its button is currently hidden (e.g. pinned-
    // only is on and the issue isn't in the pinned set).
    let btn = document.querySelector(
      `.tabs-wrap button[data-tab="${CSS.escape(id)}"]`);
    if (btn && btn.style.display === 'none') {
      const fallback = document.querySelector(
        '.tabs-wrap > button.tab-general-agent');
      if (fallback) {
        btn = fallback;
        id = 'tab-agent-general';
      }
    }
    // Clear active from BOTH nav.tabs buttons (issue tabs) and the
    // General Agent button (sibling of nav.tabs in .tabs-wrap).
    document.querySelectorAll('nav.tabs button, .tabs-wrap > button')
      .forEach(b => b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById(id);
    if (btn) {
      btn.classList.add('active');
      btn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    }
    if (sec) sec.classList.add('active');
    history.replaceState(null, '', '#' + id);
    // Snap any inline agent terminal in the newly-visible section
    // back to the bottom (and focus it). The ResizeObserver normally
    // handles this via its post-fit scrollToBottom, but bails when
    // proposed dimensions match current ones — which is the common
    // case for a tab that previously rendered at the same size.
    // Without this explicit snap the viewport stays wherever the
    // user last left it (often near the top), claude's subsequent
    // writes never re-attach to the bottom (atBottom check returns
    // false), and the user can't catch up to the live tail.
    if (sec) {
      const host = sec.querySelector('.agent-term-host');
      if (host) {
        for (const [issue, st] of inlineAgentState) {
          if (st && st.host === host) {
            snapAgentTermToBottom(issue);
            break;
          }
        }
      }
    }
  }

  // Single-row tabs with ◀ / ▶ scroll buttons. Buttons are hidden when
  // the strip fits its container; click scrolls the strip by 60% of the
  // visible width. Re-evaluates on resize via ResizeObserver.
  function setupTabsScroll(wrap) {
    const tabs = wrap.querySelector('nav.tabs');
    const left = wrap.querySelector('.tabs-scroll-btn.left');
    const right = wrap.querySelector('.tabs-scroll-btn.right');
    const update = () => {
      const overflow = tabs.scrollWidth - tabs.clientWidth > 1;
      wrap.classList.toggle('overflowing', overflow);
      if (!overflow) return;
      // Disable each arrow when there's nothing more to scroll that way.
      left.disabled  = tabs.scrollLeft <= 0;
      right.disabled = tabs.scrollLeft + tabs.clientWidth
                       >= tabs.scrollWidth - 1;
    };
    const step = () => Math.max(120, Math.floor(tabs.clientWidth * 0.6));
    left.onclick  = () => tabs.scrollBy({ left: -step(), behavior: 'smooth' });
    right.onclick = () => tabs.scrollBy({ left:  step(), behavior: 'smooth' });
    tabs.addEventListener('scroll', update, { passive: true });
    // ResizeObserver catches viewport / parent width changes (window
    // resize, sidebar opening, etc.) — but it only fires on border-box
    // changes, not on scrollWidth growing inside an unchanged width.
    new ResizeObserver(update).observe(tabs);
    // MutationObserver catches content mutations that change
    // scrollWidth without changing clientWidth — a badge going from
    // 1 digit to 2 digits, a new tab appended in place, OR the
    // applyFilters() pass toggling `style.display` on tabs when
    // "Pinned only" filters the strip down. attributeFilter: ['style']
    // is what catches that last case; without it the .overflowing
    // class can stay on with stale ◀/▶ buttons that have nothing to
    // scroll to.
    new MutationObserver(update).observe(tabs, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden'],
    });
    // Two-stage initial check: rAF for the common case (catches
    // layout after the next paint) plus a small setTimeout fallback
    // for late layout shifts (web fonts loading, late image decode,
    // popovers measuring themselves, etc.).
    requestAnimationFrame(update);
    setTimeout(update, 250);
  }

  // ── Activity heatmap ────────────────────────────────────────────
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // Heat bucket as a CSS class index 0..4. SVG presentation attributes
  // don't support CSS var(), so we apply the colour via a class
  // (.cell.heat-N { fill: var(--heat-N) }).
  function heatLevel(count) {
    if (count === 0) return 0;
    if (count === 1) return 1;
    if (count <= 4)  return 2;
    if (count <= 9)  return 3;
    return 4;
  }
  // Token heatmap uses log-scale buckets — daily token use ranges across
  // 5+ orders of magnitude during active vs idle days.
  function tokenHeatLevel(tokens) {
    if (tokens === 0)        return 0;
    if (tokens < 100_000)    return 1;
    if (tokens < 1_000_000)  return 2;
    if (tokens < 5_000_000)  return 3;
    return 4;
  }

  // Format a JS Date as YYYY-MM-DD in the LOCAL timezone. Using
  // toISOString() here would shift days for UTC-offset users (Date
  // values are constructed from local midnight strings), causing the
  // last-day cell to look up the wrong key in `counts` and never light up.
  function localIsoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Day index (0..6) of the week-start in the locale. JS's Date.getDay()
  // uses Sun=0..Sat=6, so we return that same scale: 0 if locale starts
  // on Sunday (en-US), 1 if it starts on Monday (most of Europe / ISO),
  // 6 if Saturday (some Middle-East locales). Falls back to 1 (Monday).
  function localeWeekStart() {
    try {
      const tag = (navigator.language || 'en-US');
      const loc = new Intl.Locale(tag);
      // getWeekInfo() returns {firstDay: 1..7} where 1=Mon..7=Sun (ISO).
      const info = (typeof loc.getWeekInfo === 'function') ? loc.getWeekInfo()
                 : loc.weekInfo;
      if (info && Number.isInteger(info.firstDay)) {
        const v = info.firstDay === 7 ? 0 : info.firstDay;  // ISO Sun=7 → JS Sun=0
        if (v >= 0 && v <= 6) return v;
      }
    } catch (_) { /* ignore */ }
    return 1;  // sensible default: Monday-first (ISO 8601)
  }
  // Cached so we don't re-resolve every render. Clamp defensively.
  let WEEK_START = localeWeekStart();
  if (!Number.isInteger(WEEK_START) || WEEK_START < 0 || WEEK_START > 6) WEEK_START = 1;
  // Three letter labels rotated to start at the locale's first day.
  const DAY_LABELS_ALL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Builds an SVG heatmap from {series:[{date,count}], total, ...}.
  function buildHeatmapSvg(data) {
    const cell = 11, gap = 2, step = cell + gap;
    const dayLabelW = 28;
    const monthLabelH = 14;

    if (!data.series.length) return null;

    // Anchor at the locale's week-start day on/before the earliest series
    // date. WEEK_START uses Date.getDay() scale (Sun=0..Sat=6).
    const start = new Date(data.series[0].date + 'T00:00:00');
    const anchor = new Date(start);
    const startOffset = (start.getDay() - WEEK_START + 7) % 7;
    anchor.setDate(start.getDate() - startOffset);

    // Determine total weeks shown.
    const end = new Date(data.series[data.series.length - 1].date + 'T00:00:00');
    const dayDelta = Math.round((end - anchor) / 86400000);
    const weeks = Math.floor(dayDelta / 7) + 1;

    const w = dayLabelW + weeks * step + gap;
    const hSvg = monthLabelH + 7 * step;
    // No fixed width/height — CSS scales the SVG to fill the card. The
    // viewBox + meet preserveAspectRatio keeps cells square at any width.
    const root = svg('svg', { viewBox: `0 0 ${w} ${hSvg}`,
                              preserveAspectRatio: 'xMidYMid meet' });

    // Day-of-week labels — rotated to start at the locale's first day.
    // We label every other row so adjacent text doesn't collide.
    const dayNames = [];
    for (let i = 0; i < 7; i++) {
      dayNames.push(i % 2 === 1 ? DAY_LABELS_ALL[(WEEK_START + i) % 7] : '');
    }
    for (let d = 0; d < 7; d++) {
      if (!dayNames[d]) continue;
      const y = monthLabelH + d * step + cell - 1;
      root.append(svg('text', { x: 0, y, 'text-anchor': 'start' }, dayNames[d]));
    }

    // Map series → cells, also collect month-label positions. Track year-
    // month so each calendar month gets exactly one label (otherwise every
    // week with a date <= 7 would emit a duplicate "May May" label).
    const monthLabels = {};                      // weekIndex → 'Jan'
    const labeledYearMonths = new Set();         // 'YYYY-M' → already labeled
    const counts = {};
    for (const item of data.series) counts[item.date] = item.count;

    const isTokens = data.kind === 'tokens';
    // Build a date → cost lookup for the token tooltip.
    const costs = isTokens
      ? Object.fromEntries(data.series.map(it => [it.date, it.cost_usd || 0]))
      : null;

    // Iterate every (week, day) cell. Skip cells outside the data window
    // (before start or after end) — those positions are simply empty.
    for (let week = 0; week < weeks; week++) {
      for (let day = 0; day < 7; day++) {
        const d = new Date(anchor);
        d.setDate(anchor.getDate() + week * 7 + day);
        if (d > end || d < start) continue;
        const iso = localIsoDate(d);
        const c = counts[iso] || 0;
        const x = dayLabelW + week * step;
        const y = monthLabelH + day * step;
        const lvl = isTokens ? tokenHeatLevel(c) : heatLevel(c);
        const rect = svg('rect', {
          class: `cell heat-${lvl}`, x, y, width: cell, height: cell, rx: 2,
        });
        const tip = isTokens
          ? `${iso}: ${fmtTokens(c)} tokens (${fmtUsd(costs[iso] || 0)})`
          : `${iso}: ${c} commit${c !== 1 ? 's' : ''}`;
        rect.append(svg('title', {}, tip));
        root.append(rect);

        // Capture the leftmost cell of each new month — once per year-month.
        if (d.getDate() <= 7) {
          const ym = `${d.getFullYear()}-${d.getMonth()}`;
          if (!labeledYearMonths.has(ym) && !(week in monthLabels)) {
            monthLabels[week] = d.toLocaleString('en-US', { month: 'short' });
            labeledYearMonths.add(ym);
          }
        }
      }
    }
    for (const [week, name] of Object.entries(monthLabels)) {
      const x = dayLabelW + parseInt(week, 10) * step;
      root.append(svg('text', { x, y: monthLabelH - 4 }, name));
    }
    return root;
  }

  // Build the headline-stats span shown next to "Activity" in the summary.
  function heatmapStatsLabel(data) {
    if (!data) return '(loading…)';
    if (data.kind === 'tokens') {
      return `${fmtTokens(data.total)} tokens (${fmtUsd(data.total_cost_usd)}) in the last ${data.days} days`
           + (data.model ? ` · ${data.model}` : '');
    }
    return `${data.total} commits in the last ${data.days} days`
         + (data.email ? ` · ${data.email}` : '');
  }

  // Render the inner content (tabs body) for the chosen kind.
  function renderHeatmapBody(target, data, statsEl) {
    target.replaceChildren();
    statsEl.textContent = heatmapStatsLabel(data);
    const svgEl = buildHeatmapSvg(data);
    const scroll = h('div', { class: 'scroll' });
    if (svgEl) scroll.append(svgEl);
    else scroll.append(h('div', { style: { color: 'var(--fg-muted)' } },
      data.kind === 'tokens' ? '(no token activity in window)' : '(no commits in window)'));
    const legend = h('div', { class: 'legend' }, 'Less ');
    for (const c of ['var(--heat-0)','var(--heat-1)','var(--heat-2)','var(--heat-3)','var(--heat-4)']) {
      legend.append(h('span', { class: 'swatch', style: { background: c } }));
    }
    legend.append(' More');
    target.append(scroll, legend);
  }

  // Cache so swapping tabs doesn't refetch every click. Persists across
  // dashboard re-renders so the heatmap doesn't flash empty during auto
  // refresh — we render cached data instantly, then refetch in the
  // background and re-render only when new data arrives.
  const _heatmapCache = { commits: null, tokens: null };

  async function fetchHeatmapKind(kind) {
    const url = kind === 'tokens' ? '/api/heatmap/tokens' : '/api/heatmap';
    const r = await fetch(url, { cache: 'no-store' });
    const data = await r.json();
    _heatmapCache[kind] = data;
    return data;
  }

  async function loadHeatmap(container) {
    container.replaceChildren();

    // The whole card is a <details> so the heatmap collapses. Default
    // closed; restored from openState across renders.
    const details = h('details', {
      class: 'heatmap-details',
      open: openState.heatmap ? '' : null,
    });

    let activeKind = openState.heatmapKind || 'commits';
    const statsSpan = h('span', { class: 'stats' }, '(loading…)');

    // Match the timer-card visual: small uppercase pill on the left, then
    // a muted stats line. Same disclosure +/− marker via heatmap-details
    // CSS keeps the two cards in sync.
    const summary = h('summary', {},
      h('span', { class: 'section-pill' }, '📊 Activity'),
      statsSpan,
    );

    // Tab row INSIDE the body (not the summary). Putting buttons inside
    // <summary> conflicts with the details-toggle click — even with
    // stopPropagation, some browsers still fire the toggle. Inside the
    // body the buttons are normal, no conflicts.
    const body = h('div', { class: 'heatmap-body' });
    const content = h('div', { class: 'heatmap-content' });

    const mkTab = (kind, label) => {
      const btn = h('button', {
        class: 'heatmap-tab' + (kind === activeKind ? ' active' : ''),
        type: 'button',
        onclick: async (e) => {
          e.preventDefault();
          if (kind === activeKind) return;
          activeKind = kind;
          openState.heatmapKind = kind;
          tabsRow.querySelectorAll('.heatmap-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const data = await fetchHeatmapKind(kind);
          renderHeatmapBody(content, data, statsSpan);
        },
      }, label);
      return btn;
    };
    const tabsRow = h('div', { class: 'heatmap-tabs' },
      mkTab('commits', 'Commits'),
      mkTab('tokens',  'Tokens'),
    );

    body.append(tabsRow, content);
    details.append(summary, body);
    container.append(details);

    try {
      const data = await fetchHeatmapKind(activeKind);
      renderHeatmapBody(content, data, statsSpan);
    } catch (err) {
      content.textContent = 'heatmap failed: ' + err;
    }
  }

  // ── Status refresh + auto-poll ──────────────────────────────────
  let refreshTimer = null;
  let nextRefreshAt = 0;
  let countdownTimer = null;
  let showGhosts = false;
  let tabSort = 'name';   // 'name' | 'recent' | 'staleness'
  let searchText = '';    // text from the speed-search box

  // Claude model preference — applied when the 🤖 Agent button asks
  // the server to open a terminal tab with `claude`. One of:
  //   'default' → no --model flag (claude picks; today: Opus 4.7)
  //   'sonnet'  → claude --model sonnet
  //   'haiku'   → claude --model haiku
  // Per-issue overrides live in claudeModelByIssue keyed by issue id;
  // an absent / empty entry means "fall back to the profile default".
  // Three short helpers (CLAUDE_MODEL_CHOICES / effectiveModelFor /
  // modelArgFor) keep the lookup + flag translation in one place.
  const CLAUDE_MODEL_CHOICES = [
    { id: 'default', short: 'Default',
      summary: 'Opus 4.7 with 1M context',
      tagline: 'Most capable for complex work',
      recommended: true },
    { id: 'sonnet',  short: 'Sonnet',
      summary: 'Sonnet 4.6',
      tagline: 'Best for everyday tasks' },
    { id: 'haiku',   short: 'Haiku',
      summary: 'Haiku 4.5',
      tagline: 'Fastest for quick answers' },
  ];
  function _isValidModelChoice(id) {
    return CLAUDE_MODEL_CHOICES.some(c => c.id === id);
  }
  let claudeModelPref =
    localStorage.getItem('claude-model-pref') || 'default';
  if (!_isValidModelChoice(claudeModelPref)) claudeModelPref = 'default';
  function loadModelByIssue() {
    try {
      const raw = localStorage.getItem('claude-model-by-issue');
      const parsed = raw ? JSON.parse(raw) : {};
      // Strip unknown ids (e.g. an old localStorage entry from a
      // previous version of this list).
      const out = {};
      for (const [k, v] of Object.entries(parsed || {})) {
        if (typeof v === 'string' && _isValidModelChoice(v)) out[k] = v;
      }
      return out;
    } catch { return {}; }
  }
  function saveModelByIssue(obj) {
    try {
      localStorage.setItem(
        'claude-model-by-issue', JSON.stringify(obj));
    } catch { /* quota / disabled — runtime-only override */ }
  }
  const claudeModelByIssue = loadModelByIssue();
  function effectiveModelFor(issue) {
    const perIssue = claudeModelByIssue[issue];
    if (perIssue && _isValidModelChoice(perIssue)) return perIssue;
    return claudeModelPref;
  }
  // Map a choice id to the actual --model value (empty string = no
  // --model flag, so claude uses its own default).
  function modelArgFor(choiceId) {
    return (choiceId === 'default' || !choiceId) ? '' : choiceId;
  }
  function claudeModelLabel(choiceId) {
    const c = CLAUDE_MODEL_CHOICES.find(x => x.id === choiceId);
    return c ? c.short : choiceId;
  }

  // Pinned issues — kept leftmost in the tab strip regardless of tabSort.
  // Persisted as a JSON array of issue IDs in localStorage so the choice
  // survives reloads. Toggled from the 📌 button in each issue head.
  function loadPinnedIssues() {
    try {
      const raw = localStorage.getItem('pinned-issues');
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return new Set(); }
  }
  function savePinnedIssues(set) {
    try {
      localStorage.setItem('pinned-issues', JSON.stringify([...set]));
    } catch { /* quota / disabled — pinning becomes session-only */ }
  }
  const pinnedIssues = loadPinnedIssues();
  // "Pinned only" filter — when on, the tab strip hides every issue
  // that isn't pinned. Persisted across reloads.
  let showPinnedOnly = localStorage.getItem('show-pinned-only') === '1';
  // Per-element collapse state, preserved across renders (refresh, sort,
  // filter changes). Keys: 'heatmap' (bool) and `repos[<issue>/<repo>]` (bool).
  // Absence means "use default" (heatmap defaults closed, repo cards open).
  const openState = { heatmap: undefined, repos: {}, repoTabs: {} };

  function snapshotOpenState() {
    const heat = document.querySelector('.heatmap-details');
    if (heat) openState.heatmap = heat.open;
    document.querySelectorAll('details.repo-card[data-card-key]').forEach(d => {
      openState.repos[d.dataset.cardKey] = d.open;
    });
  }
  // Filter chips above the tabs: when one is on, tabs whose issues lack
  // that signal are hidden.
  const filterFlags = { dirty: false, unpushed: false };

  // Editor preference for the "open file" links in dirty-file lists.
  // Persisted in localStorage; the choices come from state.editors which
  // the server populates from its allowlist + shutil.which().
  let editorPref = localStorage.getItem('editor-pref') || '';
  // Sync UI toggle. When off, the toolbar's Sync now / Auto-sync buttons
  // are hidden and the End-of-day-sync reminder banner + notification
  // are suppressed. Default OFF — the user opts in via the profile.
  let syncUiOn = localStorage.getItem('sync-ui-on') === '1';

  // Run the periodic refresh loop? Default ON. When off, the toolbar's
  // Refresh-now button still works (manual refetch) but the page won't
  // poll on its own. Persisted to localStorage as a per-device setting
  // — different machines can have different refresh policies.
  let autoRefreshEnabled = localStorage.getItem('auto-refresh-enabled') !== '0';
  // Show "Not in this worktree" placeholder rows? The server fills
  // these in for every expected repo (core / bssweb / doc / …) that
  // hasn't been materialised yet for a given issue. Default ON;
  // users who only ever use a subset of repos can hide them from the
  // Dashboard profile tab so each issue tab reads cleaner.
  let showMissingRepos = localStorage.getItem('show-missing-repos') !== '0';
  // Missing-primary-repos banner state. primariesStatus is the
  // cached response from /api/primaries/status; primariesBannerDismissed
  // is a session-only flag so the user can hide the banner until the
  // next page reload without us nagging them every refresh.
  let primariesStatus = null;
  let primariesBannerDismissed = false;
  let primariesPollTimer = null;
  async function fetchPrimariesStatus() {
    try {
      const r = await fetch('/api/primaries/status', { cache: 'no-store' });
      if (!r.ok) { primariesStatus = null; return; }
      primariesStatus = await r.json();
    } catch (_) { primariesStatus = null; }
  }
  // While any clone is in flight on the server, poll status every 3s
  // and re-render so the banner advances (cloning → done) without
  // the user having to refresh.
  function maybeStartPrimariesPoll() {
    if (primariesPollTimer) return;
    primariesPollTimer = setInterval(async () => {
      const wasInFlight = primariesStatus
        && primariesStatus.in_flight
        && Object.keys(primariesStatus.in_flight).length > 0;
      await fetchPrimariesStatus();
      if (window.__lastState) {
        snapshotOpenState();
        renderApp(window.__lastState);
        applyFilters();
      }
      const stillInFlight = primariesStatus
        && primariesStatus.in_flight
        && Object.keys(primariesStatus.in_flight).length > 0;
      if (wasInFlight && !stillInFlight) {
        // Something finished — tell the user.
        const failures = primariesStatus?.recent_failures || {};
        const failedNames = Object.keys(failures);
        if (failedNames.length) {
          for (const r of failedNames) {
            const err = (failures[r] || {}).error || 'unknown';
            showToast('error', `Clone of ${r} failed: ${err}`);
          }
        } else {
          showToast('ok', '✓ primary repo clone(s) finished');
        }
      }
      if (!stillInFlight) {
        clearInterval(primariesPollTimer);
        primariesPollTimer = null;
      }
    }, 3000);
  }
  async function clonePrimary(repo) {
    const btnId = `primaries-clone-btn-${repo}`;
    const btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = `Cloning ${repo}…`; }
    try {
      const r = await fetch('/api/primaries/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 202) {
        showToast('ok', `${repo} cloning in background…`);
      } else if (r.ok) {
        showToast('ok', `✓ ${repo} cloned`);
      } else {
        showToast('error', d.error || `clone failed (${r.status})`);
      }
    } catch (err) {
      // Server probably accepted + started anyway — the poll loop
      // will pick that up. Don't toast as a hard error.
      showToast('warn',
        `Network blip starting ${repo} clone — checking status…`);
    }
    await fetchPrimariesStatus();
    if (window.__lastState) {
      snapshotOpenState();
      renderApp(window.__lastState);
      applyFilters();
    }
    maybeStartPrimariesPoll();
  }
  // Show the per-issue "Agent information" collapsible block? Default
  // ON. Users who don't run Claude (or don't care about token totals)
  // can hide it from the profile's Dashboard tab.
  let showAgentInfo   = localStorage.getItem('show-agent-info') !== '0';
  // Always show the terminal search bar in the top-right of the terminal? Default ON.
  let showTermSearch  = localStorage.getItem('show-term-search') !== '0';
  // Show the activity heatmap card at the top of the page? Default ON.
  let showActivity  = localStorage.getItem('show-activity') !== '0';
  // Show the Timer / work-log card below the heatmap? Default ON.
  let showTimer     = localStorage.getItem('show-timer') !== '0';
  // Compact dashboard — hides the noisier always-visible decoration on
  // each repo card (subtitle line, worktree path, disk size, inline
  // ↓N ↑N counters, full footer) so the page reads quieter. Default
  // ON. Two controls toggle the same flag in lock-step: a checkbox
  // in the profile popover and a 🗜 button in the toolbar; both call
  // applyCompactMode below so each one stays in sync with the other.
  let compactMode = localStorage.getItem('compact-mode') !== '0';
  function applyCompactMode(on) {
    compactMode = !!on;
    localStorage.setItem('compact-mode', compactMode ? '1' : '0');
    if (document.body) {
      document.body.classList.toggle('compact-dashboard', compactMode);
    }
    // Sync any currently-mounted UI controls — the profile checkbox
    // and the toolbar toggle — so flipping one updates the other
    // without a full re-render.
    const cb = document.getElementById('compact-toggle');
    if (cb && 'checked' in cb) cb.checked = compactMode;
    const btn = document.getElementById('compact-toolbar-toggle');
    if (btn) {
      btn.classList.toggle('on', compactMode);
      btn.setAttribute('aria-pressed', compactMode ? 'true' : 'false');
    }
  }
  if (document.body) {
    document.body.classList.toggle('compact-dashboard', compactMode);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.toggle('compact-dashboard', compactMode);
    }, { once: true });
  }


  // Which event kinds are allowed to drive the per-tab 🔔 bell badge.
  // Stored in localStorage as a comma-separated list. An empty/missing
  // value means "every kind" — preserves the original behaviour for
  // users who never open the filter. Toggled from the profile popover.
  const KNOWN_NOTIFY_KINDS = [
    'Notification', 'Stop', 'UserPromptSubmit',
    'SessionStart', 'SessionEnd',
  ];
  function loadNotifyKinds() {
    const raw = localStorage.getItem('notify-kinds');
    if (raw == null) return null;          // null → "all kinds"
    if (raw === '')   return new Set();    // empty string → opt-out of every kind
    return new Set(raw.split(',').filter(Boolean));
  }
  function saveNotifyKinds(set) {
    if (set === null) prefs.removeItem('notify-kinds');
    else prefs.setItem('notify-kinds', [...set].join(','));
  }
  let notifyKinds = loadNotifyKinds();

  // ── Notification badge freshness ─────────────────────────────────
  // The 🔔N / 📝N badges should "pop" colourful only briefly after a
  // new event lands. We track per-issue per-kind unread counts; when
  // a count goes UP we stamp a freshness expiry. Renderer checks
  // isBadgeFresh to decide whether to add .badge-fresh (which the CSS
  // turns into a coloured pulse animation that fades to the dim
  // "still pending" look). Tab-strip rendering calls
  // bumpBadgeFreshness before laying out the per-issue buttons.
  const BADGE_FRESH_MS = 7000;          // mid-point of the user's 5–10s
  const badgeFreshUntil = new Map();    // "issue|kind" → expiry ms
  const lastBadgeCount  = new Map();    // "issue|kind" → previous count
  function bumpBadgeFreshness(issues) {
    const now = Date.now();
    for (const i of (issues || [])) {
      const pairs = [
        ['events', filteredPendingFor(i)],
        ['todos',  i.pending_todos || 0],
      ];
      for (const [kind, cur] of pairs) {
        const k = `${i.issue}|${kind}`;
        const prev = lastBadgeCount.get(k) || 0;
        if (cur > prev) badgeFreshUntil.set(k, now + BADGE_FRESH_MS);
        lastBadgeCount.set(k, cur);
      }
    }
  }
  function isBadgeFresh(issue, kind) {
    const exp = badgeFreshUntil.get(`${issue}|${kind}`) || 0;
    return Date.now() < exp;
  }

  // Sum of the issue's per-kind unread counts, restricted to the kinds
  // the user has enabled. Falls back to the server-computed total when
  // the per-kind breakdown is missing or the filter is unset.
  function filteredPendingFor(issueObj) {
    const total = issueObj.pending_events || 0;
    if (notifyKinds === null) return total;
    const byKind = issueObj.pending_events_by_kind || {};
    let sum = 0;
    for (const k of notifyKinds) sum += byKind[k] || 0;
    return sum;
  }

  function issueRecency(issue) {
    return Math.min(...issue.repos.map(r => (r.last_commit_age_days ?? 1e9)));
  }
  function issueStaleness(issue) {
    return Math.max(...issue.repos.map(r => (r.last_commit_age_days ?? -1)));
  }
  function sortIssues(issues, key) {
    const arr = [...issues];
    if (key === 'recent') arr.sort((a, b) => issueRecency(a) - issueRecency(b));
    else if (key === 'staleness') arr.sort((a, b) => issueStaleness(b) - issueStaleness(a));
    else arr.sort((a, b) => a.issue.localeCompare(b.issue));
    // Stable secondary pass: pinned issues come first, preserving the
    // primary sort within the pinned and unpinned groups.
    arr.sort((a, b) => {
      const pa = pinnedIssues.has(a.issue) ? 0 : 1;
      const pb = pinnedIssues.has(b.issue) ? 0 : 1;
      return pa - pb;
    });
    return arr;
  }

  function applyFilters() {
    const q = (searchText || '').trim().toLowerCase();
    let firstVisibleId = null;
    let activeIsVisible = false;
    // Defensive cleanup: clear any stale inline display:none on tab
    // sections (left over by an earlier version of this code) so the
    // .active section is never accidentally hidden.
    document.querySelectorAll('section.tab').forEach(sec => { sec.style.display = ''; });
    document.querySelectorAll('nav.tabs button').forEach(btn => {
      const id = btn.dataset.tab;
      const issueObj = (window.__lastState?.issues || []).find(i => `tab-${slugId(i.issue)}` === id);
      if (!issueObj) { btn.style.display = 'none'; return; }
      // Ghost repos hold stale historical state — don't let them satisfy
      // a "dirty / unpushed / behind" filter (the live worktree may have
      // been removed precisely because it was clean).
      const liveRepos = issueObj.repos.filter(r => !r.ghost);
      // "unpushed" = there are commits on this branch that aren't on its
      // remote tracking branch (n_unpushed > 0). Note: this is distinct
      // from the "+N ahead" pill, which is ahead-of-master (branch progress).
      const matchesChips =
        (!filterFlags.dirty    || liveRepos.some(r => r.n_dirty > 0)) &&
        (!filterFlags.unpushed || liveRepos.some(r => r.n_unpushed > 0));
      const matchesText = !q || issueObj.issue.toLowerCase().includes(q);
      // "Pinned only" toggle hides everything not in pinnedIssues.
      const matchesPinned = !showPinnedOnly
                            || pinnedIssues.has(issueObj.issue);
      const visible = matchesChips && matchesText && matchesPinned;
      btn.style.display = visible ? '' : 'none';
      if (visible && !firstVisibleId) firstVisibleId = id;
      if (visible && btn.classList.contains('active')) activeIsVisible = true;
    });
    // The pinned Starting + Agent buttons live OUTSIDE nav.tabs so
    // they're always visible. Treat them as "visible active" when
    // either is the currently-selected tab so we don't auto-swap
    // away from them just because every issue tab is hidden.
    const pinnedActive = document.querySelector(
      '.tabs-wrap > button.tab-general-agent.active, '
      + '.tabs-wrap > button.tab-starting.active');
    if (pinnedActive) activeIsVisible = true;

    // Tab CONTENT visibility is driven entirely by the .active class
    // (CSS: section.tab { display:none } / .active { display:flex }).
    // When the active issue tab got hidden by the filter, fall back
    // to the pinned-tab order we use everywhere else.
    if (!activeIsVisible) {
      if (firstVisibleId) {
        activateTab(firstVisibleId);
      } else {
        resolveInitialActiveTab(null);
      }
    }
    // Update visual state on each chip.
    document.querySelectorAll('.filter-chips label.chip').forEach(label => {
      label.classList.toggle('on', !!filterFlags[label.dataset.kind]);
    });
  }

  function showToast(kind, text, persistMs = 4000) {
    // kind ∈ 'ok' | 'warn' | 'error'. Renders in a fixed-position host at
    // the top of the viewport so toasts overlay content without reflowing
    // the page. Only one toast is shown at a time — a fresh call replaces
    // any pending fade-out.
    let host = document.getElementById('toast-host');
    if (!host) {
      host = h('div', { id: 'toast-host', 'aria-live': 'polite' });
      document.body.append(host);
    }
    host.replaceChildren();
    const t = h('span', { class: `toast toast-${kind}`, role: 'status' }, text);
    host.append(t);
    const ms = kind === 'error' ? Math.max(persistMs, 8000) : persistMs;
    setTimeout(() => t.classList.add('fade'), ms - 400);
    setTimeout(() => { if (t.parentNode === host) host.removeChild(t); }, ms);
  }

  // True iff today is a weekday, the local clock is past 16:00, and the
  // user hasn't synced today since 16:00. Used to drive the end-of-day
  // sync reminder banner. Caller passes state.sync.
  function shouldShowEodReminder(sync) {
    const now = new Date();
    const dow = now.getDay();          // Sun=0..Sat=6
    if (dow === 0 || dow === 6) return false;     // weekend
    if (now.getHours() < 16) return false;        // not 16:00 yet
    if (!sync || !sync.last_ts) return true;      // never synced today → remind
    const lastSync = new Date(sync.last_ts * 1000);
    const todayCutoff = new Date(now);
    todayCutoff.setHours(16, 0, 0, 0);
    // Reminder shows until the user does a sync at/after 16:00 today.
    return lastSync < todayCutoff;
  }

  // ── Web Notifications (GNOME notification center on Linux) ──────
  // Fire a single desktop notification per local-day for the EOD reminder.
  // localStorage key tracks which date we last notified for so we don't
  // re-spam every dashboard refresh after 16:00.
  function maybeFireEodNotification(sync) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (!shouldShowEodReminder(sync)) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('eod-notified') === today) return;
    try {
      const n = new Notification('agent-workspace · time to sync', {
        body: "It's after 16:00 — push today's worktree state so other "
            + "machines pick it up.",
        tag: 'agent-workspace-eod',
        icon: '/static/favicon.svg',
      });
      n.onclick = () => { window.focus(); n.close(); };
      localStorage.setItem('eod-notified', today);
    } catch (_) { /* notifications can fail in private windows etc. */ }
  }

  // First-run modal nudge: browsers require Notification.requestPermission
  // to be called inside a user-gesture handler, so we can't auto-prompt
  // on page load. The next-best thing is to show a small modal on first
  // load asking the user to click Enable — that click *is* a gesture
  // and triggers the real browser prompt. Remembers the dismissal in
  // localStorage so we don't nag.
  function maybeShowNotifPrompt() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    if (localStorage.getItem('notif-prompt-dismissed') === '1') return;
    if (document.getElementById('notif-prompt-modal')) return;
    const close = () =>
      document.getElementById('notif-prompt-modal')?.remove();
    const dismiss = () => {
      localStorage.setItem('notif-prompt-dismissed', '1');
      close();
    };
    const enable = async () => {
      // Mark dismissed regardless — pressing Enable counts as a
      // decision; the browser handles the actual permission flow.
      localStorage.setItem('notif-prompt-dismissed', '1');
      close();
      await requestNotificationPermission();
    };
    const modal = h('div', {
      class: 'logs-modal-backdrop', id: 'notif-prompt-modal',
      onclick: dismiss,
    },
      h('div', { class: 'logs-modal notif-prompt-modal',
                  role: 'dialog',
                  'aria-labelledby': 'notif-prompt-title',
                  onclick: (e) => e.stopPropagation() },
        h('div', { class: 'logs-modal-head' },
          h('strong', { id: 'notif-prompt-title' },
            t('notif.modal.title')),
          h('span', { style: { flex: '1' } }),
          h('button', { class: 'btn btn-inline', onclick: dismiss }, '✕'),
        ),
        h('div', { class: 'notif-prompt-body' },
          h('p', {}, t('notif.modal.body'))),
        h('div', { class: 'notif-prompt-foot' },
          h('button', { class: 'btn', onclick: dismiss },
            t('notif.modal.dismiss')),
          h('button', { class: 'btn btn-primary', onclick: enable },
            t('notif.modal.enable'))),
      ),
    );
    document.body.append(modal);
  }

  async function requestNotificationPermission() {
    if (typeof Notification === 'undefined') {
      showToast('error', t('toast.notify.unsupported'));
      return;
    }
    if (Notification.permission === 'granted') {
      showToast('ok', '✓ Notifications already enabled');
      return;
    }
    if (Notification.permission === 'denied') {
      showToast('error', t('toast.notify.blocked'));
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      showToast('ok', '✓ Notifications enabled');
      // Refresh so the toolbar button label updates.
      await refreshAll(true);
    } else {
      showToast('warn', t('toast.notify.not-enabled'));
    }
  }

  async function toggleAutoSync() {
    const btn = document.getElementById('auto-sync-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/sync-toggle', { method: 'POST', cache: 'no-store' });
      const result = await r.json();
      if (result.error) {
        showToast('error', result.error);
      } else {
        showToast('ok', result.enabled ? '✓ Auto-sync ON' : '✓ Auto-sync OFF');
      }
    } catch (err) {
      showToast('error', t('toast.toggle-failed', { err }));
    }
    // Refresh so the button label + meta line reflect the new state.
    await refreshAll(true);
  }

  async function syncNow() {
    const btn = document.getElementById('sync-now-btn');
    const original = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '⇅ syncing…'; }
    let result = null;
    let networkErr = null;
    try {
      const r = await fetch('/api/sync-now', { method: 'POST', cache: 'no-store' });
      result = await r.json();
    } catch (err) {
      networkErr = err;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
    if (networkErr) {
      showToast('error', t('toast.sync-request-failed', { err: networkErr }));
    } else {
      const errs = (result.errors || []).filter(Boolean);
      if (errs.length) {
        // Show first error inline; keep it long enough to read.
        showToast('error', `Sync finished with ${errs.length} error(s): ${errs[0]}`);
      } else if (result.committed || result.pulled) {
        const parts = [];
        if (result.pushed)       parts.push('pushed');
        if (result.pulled)       parts.push('pulled');
        if (result.materialized) parts.push(`materialized ${result.materialized.length}`);
        showToast('ok', '✓ synced' + (parts.length ? ' — ' + parts.join(', ') : ''));
      } else {
        showToast('ok', '✓ already up to date');
      }
    }
    // Refresh the dashboard to pick up the new sync timestamp.
    await refreshAll(true);
  }

  async function refreshAll(force = false) {
    try {
      // Capture current expand/collapse state so the re-render can restore it.
      snapshotOpenState();
      // Remember which agent xterm currently has keyboard focus so
      // we can re-focus it after the panel rebuild. renderApp
      // detaches + re-attaches the term host's DOM subtree, which
      // browsers treat as a blur — without this, the user has to
      // click into the terminal again after every 5-min refresh.
      const focusedAgentIssue = activeAgentTermIssue();
      const url = '/api/status' + (showGhosts ? '?show_ghosts=1' : '');
      const r = await fetch(url, { cache: 'no-store' });
      const state = await r.json();
      // Piggy-back the update-status fetch on the main refresh
      // cycle so we don't need a separate poller. Failures are
      // non-fatal — the banner just stays hidden.
      try {
        const ur = await fetch('/api/update/status', { cache: 'no-store' });
        state.update = await ur.json();
      } catch (_) { /* offline / route missing — banner stays hidden */ }
      window.__lastState = state;     // expose for the filter logic
      // Debug helper: window.__xtermTest('__agent__') injects a rainbow strip.
      // window.__xtermMandelbrot('__agent__') renders a Mandelbrot fractal.
      // Both write the IIP sequence directly to xterm.js (bypasses PTY).
      const _xtermWriteCanvas = (issue, canvas) => {
        const st = inlineAgentState.get(issue);
        if (!st?.term) { console.warn('no terminal for', issue); return; }
        canvas.toBlob(blob => {
          blob.arrayBuffer().then(buf => {
            const bytes = new Uint8Array(buf);
            let bin = '';
            bytes.forEach(b => bin += String.fromCharCode(b));
            const b64 = btoa(bin);
            st.term.write(`\x1b]1337;File=inline=1;size=${bytes.length};width=auto:${b64}\x07\n`);
            console.log('[xterm] IIP written to', issue, 'size=', bytes.length);
          });
        }, 'image/png');
      };
      window.__xtermTest = (issue) => {
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAIAAAC6iKlyAAAB/ElEQVR42u3QeWsIABzH4W8iTZocOTI52sjRokWjRWtatJhYtDZy5MiSyZElS5YmjSxNmtakaYcmTViOHK3liGnRokWjRYuWI0eOj3fx++v7vIRHSAwUCSJRjBRjRZKYLKaKmWK2mCvmi4UiSywRy8RKsVoUiPVis9gudordYr84KA6LclEhTooqUS1qRZ1oFM2iRVwXt8Q90S4eiQ7xXLwUr8Vb8V58FJ/Fd/Fb/9AvBn1jSD/D+hjVy7geJnQzpYtpncx6wpwHzGtjwR0W3WDxVZZeZvlFVtWz5jyFNWw4w5ZTFJ2g+Bh7jlByiNIDlO3j6C6O76ByG6c3cXYd5/K5kEfTCi7lcCWb1kxuZ3A/nfY0HqfybDovknk1kTfjeTeaD8P5NJQvg/kxgD/6i36ir6gf9aFe1IO6URfqRE/RQ9SG7uLlkOWbeDlk+RpeDlluwcshy814OWS5AS+HLNfh5ZDlWrwcslyNl0OWq/ByyHIlXg5ZrsDLIcvleDlkuQwvhyyX4uWQ5RK8HLK8Fy+HLBfj5ZDlIrwcsrwVL4csb8TLIctr8XLIcj5eDlnOw8shy7l4OWQ5By+HLGfj5ZDlTLwcspyBl0OW0/FyyHIaXg5ZTsXLIcsz8HLIcgpeDlmehJdDlpPwcsjyGLwcsjwCL4csJ+LlkOUE/gPZ86SBINW8HgAAAABJRU5ErkJggg==';
        const st = inlineAgentState.get(issue);
        if (!st?.term) { console.warn('no terminal for', issue); return; }
        const size = atob(b64).length;
        st.term.write(`\x1b]1337;File=inline=1;size=${size};width=auto:${b64}\x07\n`);
      };
      window.__xtermMandelbrot = (issue = '__agent__', W = 400, H = 180, maxIter = 100) => {
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(W, H);
        const d = img.data;
        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            const cx = -2.5 + px / W * 3.5;
            const cy = -1.2 + py / H * 2.4;
            let zr = 0, zi = 0, i = 0;
            while (zr*zr + zi*zi <= 4 && i < maxIter) {
              const tmp = zr*zr - zi*zi + cx;
              zi = 2*zr*zi + cy;
              zr = tmp;
              i++;
            }
            const idx = (py * W + px) * 4;
            if (i === maxIter) {
              d[idx] = d[idx+1] = d[idx+2] = 0;
            } else {
              const t = i / maxIter;
              d[idx]   = Math.round(9*(1-t)*t*t*t*255);
              d[idx+1] = Math.round(15*(1-t)*(1-t)*t*t*255);
              d[idx+2] = Math.round(8.5*(1-t)*(1-t)*(1-t)*t*255);
            }
            d[idx+3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        _xtermWriteCanvas(issue, canvas);
        console.log('[xterm] Mandelbrot computed', W, 'x', H);
      };
      renderApp(state);
      renderUpdateBanner(state);
      applyFilters();
      updateAppBadge();
      if (focusedAgentIssue) restoreAgentFocus(focusedAgentIssue);
      serverStatus.hide();
    } catch (err) {
      console.error('refresh failed', err);
      serverStatus.show(err);
    } finally {
      // Always reschedule, even on failure — otherwise a single bad
      // refresh leaves the countdown stuck on "refreshing…" forever.
      scheduleNextRefresh();
    }
  }

  // Poll for images queued by POST /api/terminal-image and write them
  // directly to xterm.js via IIP. Runs independently of the status loop.
  async function pollTerminalImages() {
    try {
      const r = await fetch('/api/terminal-image/pending', { cache: 'no-store' });
      if (r.ok) {
        const items = await r.json();
        for (const { issue, data } of items) {
          const st = inlineAgentState.get(issue);
          if (!st?.term) { console.warn('[iip] no terminal for', issue); continue; }
          const size = atob(data).length;
          st.term.write(`\r\n\x1b]1337;File=inline=1;size=${size};width=auto:${data}\x07\r\n`);
          console.log('[iip] rendered image for', issue, 'size=', size);
        }
      }
    } catch (_) { /* network blip — silent */ }
    setTimeout(pollTerminalImages, 1000);
  }
  pollTerminalImages();

  // Return the issue key whose xterm currently owns keyboard
  // focus, or null. Used by refreshAll to restore focus after
  // the renderApp rebuild detaches the term host.
  function activeAgentTermIssue() {
    const active = document.activeElement;
    if (!active) return null;
    const host = active.closest?.('.agent-term-host');
    if (!host || !host.id) return null;
    // Host id shape: `agent-term-<cssId(issue)>`. Walk the state
    // map for an entry whose host element matches — we can't
    // reverse cssId reliably (it replaces non-alnum with '-').
    for (const [issue, st] of inlineAgentState) {
      if (st && st.host === host) return issue;
    }
    return null;
  }

  function restoreAgentFocus(issue) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const cur = inlineAgentState.get(issue);
      if (!cur || !cur.term) return;
      try { cur.term.focus(); } catch (_) {}
    }));
  }

  // ── Auto-update banner + apply ────────────────────────────────────────
  // Session-local: when the user clicks Dismiss we remember the
  // remote_sha they dismissed, so the banner stays hidden for that
  // sha but re-appears once origin advances.
  let updateDismissedSha = '';

  function renderUpdateBanner(state) {
    const upd = state.update || {};
    const host = document.getElementById('update-banner-host');
    if (!host) return;  // shell not yet built (initial paint)
    const behind = upd.ok ? (upd.behind || 0) : 0;
    const sha    = upd.remote_sha || '';
    if (behind <= 0 || sha === updateDismissedSha) {
      host.replaceChildren();
      return;
    }
    const plural = behind === 1 ? '' : 's';
    const subtitle = t('update.banner.subtitle',
                        { n: behind, plural, branch: upd.branch || 'master' });
    host.replaceChildren(
      h('div', { class: 'update-banner', role: 'status' },
        h('span', { class: 'update-banner-title' },
          t('update.banner.title')),
        h('span', { class: 'update-banner-sub' },
          ' — ', subtitle,
          upd.remote_subject ? h('span', { class: 'muted' },
            ' · ' + upd.remote_subject) : null),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn btn-primary update-banner-go',
                      onclick: () => applyDashboardUpdate(state) },
          t('update.banner.update-btn')),
        h('button', { class: 'btn update-banner-dismiss',
                      onclick: () => {
                        updateDismissedSha = sha;
                        host.replaceChildren();
                      } },
          t('update.banner.dismiss-btn')),
      ),
    );
  }

  async function applyDashboardUpdate(state) {
    const upd = state.update || {};
    const branch = upd.branch || 'master';
    // List live agent terminals so the user knows what gets stopped.
    let agentList = [];
    try {
      const r = await fetch('/api/agent/term/sessions');
      const d = await r.json();
      agentList = (d.sessions || []).map((s) =>
        s.issue === '__agent__' ? t('tab.generic-agent') : s.issue);
    } catch (_) { /* network blip — let confirm continue blind */ }
    const msg = agentList.length
      ? t('update.confirm.with-agents', {
          branch, n: agentList.length, agents: agentList.join(', ') })
      : t('update.confirm.no-agents', { branch });
    if (!window.confirm(msg)) return;

    // Cover the dashboard with a "Restarting…" overlay. We poll
    // /api/status every 2s; the first reachable response after the
    // current `started_at` confirms the new server is up, then we
    // reload the page.
    const startedAtBefore = state?.sync?.started_at
      ?? state?.generated /* string ts; we just compare for change */
      ?? '';
    const overlay = h('div', { id: 'update-overlay',
                                class: 'update-overlay' },
      h('div', { class: 'update-overlay-card' },
        h('div', { class: 'update-overlay-spinner' }, '⟳'),
        h('div', {}, t('update.restarting')),
      ),
    );
    document.body.append(overlay);

    let resp;
    try {
      resp = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      overlay.remove();
      window.alert(t('update.pull-failed', { error: err }));
      return;
    }
    if (!resp.ok && resp.status !== 202) {
      overlay.remove();
      let detail = '';
      try {
        const d = await resp.json();
        detail = d.error || d.stdout || `HTTP ${resp.status}`;
      } catch (_) { detail = `HTTP ${resp.status}`; }
      window.alert(t('update.pull-failed', { error: detail }));
      return;
    }

    // Wait for the new server to answer. Poll up to 60s. The
    // restart helper takes ~2s to kill us and bring up a fresh
    // server, so most pings during the first second will fail.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch('/api/status', { cache: 'no-store' });
        if (!r.ok) continue;
        const d = await r.json();
        // `generated` is a server-side timestamp string that bumps
        // every status response — so once we see a different value
        // OR (after the server fully restarts) the fetch just
        // succeeds again, reload.
        if (d.generated && d.generated !== startedAtBefore) {
          location.reload();
          return;
        }
      } catch (_) { /* still down — keep polling */ }
    }
    // Timed out. Leave the overlay in place and let the user
    // reload manually; the helper logs the new pid.
    overlay.querySelector('.update-overlay-card')
      ?.append(
        h('div', { class: 'muted', style: { marginTop: '1rem' } },
          'Took too long. Refresh the page manually.'));
  }

  // Plain restart — no git pull. Mirrors applyDashboardUpdate's
  // confirm → overlay → POST → poll loop but hits /api/server/restart.
  async function restartDashboard() {
    const state = window.__lastState || {};
    let agentList = [];
    try {
      const r = await fetch('/api/agent/term/sessions');
      const d = await r.json();
      agentList = (d.sessions || []).map((s) =>
        s.issue === '__agent__' ? t('tab.generic-agent') : s.issue);
    } catch (_) { /* network blip — let confirm continue blind */ }
    const msg = agentList.length
      ? t('restart.confirm.with-agents',
          { n: agentList.length, agents: agentList.join(', ') })
      : t('restart.confirm.no-agents');
    if (!window.confirm(msg)) return;

    const startedAtBefore = state?.sync?.started_at
      ?? state?.generated
      ?? '';
    const overlay = h('div', { id: 'update-overlay',
                                class: 'update-overlay' },
      h('div', { class: 'update-overlay-card' },
        h('div', { class: 'update-overlay-spinner' }, '⟳'),
        h('div', {}, t('update.restarting')),
      ),
    );
    document.body.append(overlay);

    let resp;
    try {
      resp = await fetch('/api/server/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      overlay.remove();
      window.alert(t('restart.failed', { error: err }));
      return;
    }
    if (!resp.ok && resp.status !== 202) {
      overlay.remove();
      let detail = '';
      try {
        const d = await resp.json();
        detail = d.error || `HTTP ${resp.status}`;
      } catch (_) { detail = `HTTP ${resp.status}`; }
      window.alert(t('restart.failed', { error: detail }));
      return;
    }

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch('/api/status', { cache: 'no-store' });
        if (!r.ok) continue;
        const d = await r.json();
        if (d.generated && d.generated !== startedAtBefore) {
          location.reload();
          return;
        }
      } catch (_) { /* still down — keep polling */ }
    }
    overlay.querySelector('.update-overlay-card')
      ?.append(
        h('div', { class: 'muted', style: { marginTop: '1rem' } },
          'Took too long. Refresh the page manually.'));
  }

  // ── Live mailbox-badge poller ─────────────────────────────────────────
  // /api/status is the canonical source for tab badges but it's
  // heavy and only refreshes every 5 min. To make new mail show
  // up on the recipient's tab badge ~instantly we poll a cheap
  // /api/mcp/unread-counts every 3 s and patch just the badges
  // (no panel rebuild). Self-cleaning: only runs while the page
  // is visible to avoid hammering when the tab is backgrounded.
  function applyUnreadBadgeCounts(counts) {
    const state = window.__lastState;
    if (!state) return;
    let changed = false;
    // Per-issue tabs.
    for (const issueObj of (state.issues || [])) {
      const n = counts[issueObj.issue] || 0;
      if ((issueObj.unread_messages || 0) !== n) {
        issueObj.unread_messages = n;
        changed = true;
      }
    }
    // General Agent's top-level count.
    const g = counts.__agent__ || 0;
    if ((state.general_unread_messages || 0) !== g) {
      state.general_unread_messages = g;
      changed = true;
    }
    if (!changed) return;
    // Patch in place — no full renderApp. We just rewrite the
    // 📬N text content on each visible mcp-unread-badge.
    function setBadge(host, n) {
      if (!host) return;
      const badge = host.querySelector('.mcp-unread-badge');
      if (n > 0) {
        if (badge) {
          // Replace the text node while preserving the icon.
          badge.textContent = '📬' + n;
        }
        // If there was no badge and now there's one to show, a
        // full refresh would be needed to install it — leave to
        // the next /api/status tick.
      } else if (badge) {
        badge.remove();
      }
    }
    document.querySelectorAll('nav.tabs button[data-tab]')
      .forEach((btn) => {
        const issueKey = btn.dataset.tab?.replace(/^tab-/, '');
        if (!issueKey) return;
        const issueObj = (state.issues || [])
          .find((i) => slugId(i.issue) === issueKey);
        if (issueObj) setBadge(btn, issueObj.unread_messages || 0);
      });
    const generalBtn = document.querySelector(
      '.tabs-wrap > .tab-general-agent');
    if (generalBtn) setBadge(generalBtn, g);
  }

  let badgePollTimer = null;
  async function pollUnreadBadges() {
    if (document.hidden) return;  // skip while backgrounded
    try {
      const r = await fetch('/api/mcp/unread-counts',
                              { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      applyUnreadBadgeCounts(d.counts || {});
    } catch (_) { /* network blip — try again next tick */ }
  }
  function startBadgePoller() {
    if (badgePollTimer) clearInterval(badgePollTimer);
    badgePollTimer = setInterval(pollUnreadBadges, 3000);
    // Wake immediately on focus so a tab that's been backgrounded
    // catches up the moment the user comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      pollUnreadBadges();
      // Tab came back to the foreground — snap whichever agent
      // terminals are currently on-screen back to the bottom + give
      // focus to the visible one so the user can type immediately
      // instead of having to scroll or hit Enter first. offsetParent
      // is null for display:none ancestors, so this picks only the
      // panel(s) the user actually sees.
      for (const [issue, st] of inlineAgentState) {
        if (st && st.host && st.host.offsetParent) {
          snapAgentTermToBottom(issue);
        }
      }
    });
  }

  function scheduleNextRefresh() {
    // Auto-refresh off → clear any pending timers and update the ring
    // to its "paused" look, but DON'T fire setTimeout. The user can
    // still re-trigger a manual fetch via the Refresh-now button.
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    if (!autoRefreshEnabled) {
      nextRefreshAt = 0;
      updateCountdown();
      return;
    }
    nextRefreshAt = Date.now() + REFRESH_MS;
    refreshTimer = setTimeout(() => refreshAll(), REFRESH_MS);
    countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function updateCountdown() {
    const btn = document.getElementById('refresh-now-btn');
    if (!btn) return;
    const fg = btn.querySelector('.refresh-progress-fg');
    // Auto-refresh paused — empty ring, no spinner, explanatory tooltip.
    if (!autoRefreshEnabled) {
      if (fg) {
        const r = fg.r?.baseVal?.value ?? 8;
        const C = 2 * Math.PI * r;
        fg.style.strokeDasharray = String(C);
        fg.style.strokeDashoffset = String(C);  // fully empty
      }
      btn.classList.remove('refreshing');
      btn.classList.add('auto-off');
      btn.title = t('toolbar.auto-refresh-off');
      return;
    }
    btn.classList.remove('auto-off');
    const ms = nextRefreshAt - Date.now();
    const total = REFRESH_MS;
    // Drive the SVG ring: stroke-dashoffset goes from `C` (empty) down
    // to `0` (full) as the interval elapses.
    if (fg) {
      const r = fg.r?.baseVal?.value ?? 8;
      const C = 2 * Math.PI * r;
      const frac = ms <= 0 ? 1
        : Math.max(0, Math.min(1, (total - ms) / total));
      fg.style.strokeDasharray = String(C);
      fg.style.strokeDashoffset = String(C * (1 - frac));
    }
    if (ms <= 0) {
      btn.title = t('toolbar.refreshing');
      btn.classList.add('refreshing');
      return;
    }
    btn.classList.remove('refreshing');
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    btn.title = t('toolbar.next-refresh',
      { time: `${m}:${String(s).padStart(2, '0')}` });
  }

  // ── App-icon badge ────────────────────────────────────────────────
  // Sets the OS-level launcher badge (PWA dock icon, Chrome's app
  // launcher) to the total number of unread agent events across all
  // live issues. Falls back silently when navigator.setAppBadge isn't
  // available (Firefox, Safari ≤ 16.4).
  function updateAppBadge() {
    if (typeof navigator === 'undefined' || !navigator.setAppBadge) return;
    const issues = window.__lastState?.issues || [];
    const total = issues.reduce(
      (sum, i) => sum + (i.pending_events | 0), 0);
    try {
      if (total > 0) navigator.setAppBadge(total);
      else navigator.clearAppBadge?.();
    } catch (_) { /* best-effort */ }
  }

  // ── Notification toast poller ────────────────────────────────────
  // Polls /api/events every ~10s and pops a toast for any new event of
  // kind "Notification" (the Claude-Code "needs your input" hook). Only
  // events created after page load show up — we seed lastSeenEventId
  // with the max id we already see so a reload doesn't replay history.
  const NOTIFY_POLL_MS = 5 * 1000;
  let lastSeenEventId = 0;
  let notifyPollTimer = null;
  // Issues whose worktrees have been removed this session. Events for
  // these are suppressed even if __lastState hasn't refreshed yet.
  const removedIssueKeys = new Set();

  // Kinds that pop a toast. For now only "Notification" — the actual
  // "Claude needs your attention" hook. Stop / SessionStart fire too
  // often to be useful as a popup. Keep this independent of the bell
  // filter (which controls badge counts, not popups).
  const TOAST_KINDS = new Set(['Notification']);

  async function seedLastSeenEventId() {
    try {
      const r = await fetch('/api/events?limit=1', { cache: 'no-store' });
      const d = await r.json();
      const top = (d.events || [])[0];
      lastSeenEventId = top ? top.id : 0;
    } catch (_) { /* leave at 0; first poll will set it */ }
  }

  async function pollNewEvents() {
    try {
      const r = await fetch('/api/events?limit=50', { cache: 'no-store' });
      const d = await r.json();
      const events = d.events || [];
      // Same "issue must exist on this dashboard" filter the events
      // modal applies — events tagged with an unknown issue (or no
      // issue at all) belong to a different checkout and would just
      // spam this user. lastSeenEventId is still advanced past them
      // so we don't keep re-evaluating the same rows next tick.
      const knownLiveIssues = new Set(
        (window.__lastState?.issues || []).map(i => i.issue));
      const isUnknownIssueEvent = (e) =>
        !e.issue || removedIssueKeys.has(e.issue) || !knownLiveIssues.has(e.issue);
      // Events come newest-first. Walk in reverse so toasts fire in the
      // order they were posted, and we only show ones strictly newer
      // than what we've already seen.
      const fresh = events.filter(e => e.id > lastSeenEventId).reverse();
      let badgeRefreshNeeded = false;
      const curIssue = activeIssueKey();
      // True when the user is staring at the agent for this exact
      // issue — the inline xterm pane is visible and showing the
      // same activity the toast would announce. Suppressing the
      // toast (and the web notification) keeps typing quiet.
      const isInlineAgentVisible = (issue) => {
        if (!issue || curIssue !== issue) return false;
        if (!inlineConsoleOn()) return false;
        // tabSectionFor defaults a freshly-rendered issue to its
        // Agent sub-tab when no explicit choice was made — match
        // that here. Previously we defaulted to 'branches', which
        // meant the toast fired even when the user was visibly
        // staring at the agent terminal.
        if ((perIssueAgentSub.get(issue) || 'agent') !== 'agent') return false;
        if (typeof document !== 'undefined'
            && document.visibilityState !== 'visible') return false;
        return true;
      };
      for (const e of fresh) {
        if (isUnknownIssueEvent(e)) continue;
        // Any fresh event for a known live issue can change a bell
        // badge — schedule a status refresh so the tab badge reflects
        // it without waiting for the 5-min auto-refresh.
        badgeRefreshNeeded = true;
        if (!TOAST_KINDS.has(e.kind)) continue;
        // Skip the toast + web notification when the user is
        // actively looking at this issue's inline agent terminal.
        // The screen already shows the relevant state.
        if (isInlineAgentVisible(e.issue)) continue;
        showAgentNotificationToast(e);
        // Also fire a Web Notification when the dashboard tab is
        // hidden, so the user sees it in Chrome's own notification
        // stream (and via the OS bridge). When the tab is visible
        // the in-app banner is enough.
        fireWebNotificationForAgentEvent(e);
      }
      if (events.length) {
        lastSeenEventId = Math.max(lastSeenEventId, events[0].id);
      }
      if (badgeRefreshNeeded) refreshAll(true);
    } catch (_) { /* network blip — try again next tick */ }
  }

  // Fires a Web Notification for an agent event when the page is
  // hidden (or the user hasn't focused it). Skipped when permission
  // hasn't been granted, or when the document is currently visible —
  // in that case the in-app banner toast is the right surface.
  // Track when the window last had focus so we can suppress spurious
  // OS notifications during brief focus switches (e.g. drag-from-Nautilus
  // moves focus to the file manager for < 2 s then comes right back).
  let _lastFocusAt = Date.now();
  window.addEventListener('focus', () => { _lastFocusAt = Date.now(); });

  function fireWebNotificationForAgentEvent(event) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    // When the tab is in the foreground, the in-app banner already
    // covers it; don't double-pop the user.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible'
        && document.hasFocus()) return;
    // Suppress if the window was focused very recently — this catches
    // short focus-away events like dragging a file from the file manager.
    if (Date.now() - _lastFocusAt < 3000) return;
    try {
      const issue = event.issue || '(no issue)';
      const n = new Notification(`Claude · ${issue}`, {
        body: event.message || 'Agent needs your attention',
        tag: `claude-event-${event.id}`,
        icon: '/static/favicon.svg',
      });
      // Just focus the dashboard tab — don't auto-open the events
      // modal. A single click on a system notification is too easy to
      // trigger accidentally; require a deliberate click on the 🔔
      // badge (or the toolbar button) to actually open the dialog.
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (_) { /* notifications can fail in private windows etc. */ }
  }

  // Stacked, longer-lived toast for agent notifications. Click to open
  // the per-issue events modal so the user can read + mark it read.
  // Uses its OWN host element (not #toast-host) because that host has
  // a CSS transform — and a transform on an ancestor makes
  // position:fixed children pin to the ancestor rather than to the
  // viewport, which is why aligning to the body box was breaking.
  function showAgentNotificationToast(event) {
    let host = document.getElementById('agent-toast-host');
    if (!host) {
      host = h('div', { id: 'agent-toast-host', 'aria-live': 'polite' });
      document.body.append(host);
    }
    const issueLabel = event.issue || '(no issue)';
    const message = event.message || '(no message)';
    const removeToast = () => {
      if (t.parentNode === host) host.removeChild(t);
    };
    // Dismiss button — also marks the event read so the per-tab 🔔
    // badge clears immediately. Stops propagation so clicking the ✕
    // doesn't bubble to the toast's own onclick (which opens the
    // events modal).
    const dismissBtn = h('button', {
      class: 'toast-agent-dismiss', type: 'button',
      'aria-label': 'Dismiss + mark read',
      title: 'Dismiss and mark read',
      onclick: async (e) => {
        e.stopPropagation();
        removeToast();
        const ok = await markSingleEventRead(event.id);
        // markSingleEventRead only updates per-tab badges in-place
        // when the events modal is open (it reads from its cache).
        // From a free-standing toast we have to refresh the dashboard
        // so the 🔔 badge clears.
        if (ok) refreshAll(true);
      },
    }, '✕');
    const t = h('div', {
      class: 'toast toast-agent', role: 'alertdialog',
      title: 'Click to dismiss + mark read',
      onclick: async () => {
        removeToast();
        const ok = await markSingleEventRead(event.id);
        if (ok) refreshAll(true);
      },
    },
      h('div', { class: 'toast-agent-head' },
        h('span', { class: 'toast-agent-icon', 'aria-hidden': 'true' }, '🔔'),
        h('strong', {}, issueLabel),
        h('span', { class: 'toast-agent-kind' }, event.kind),
        dismissBtn,
      ),
      h('div', { class: 'toast-agent-body' }, message),
    );
    host.append(t);
    const lifeMs = 12_000;
    setTimeout(() => t.classList.add('fade'), lifeMs - 400);
    setTimeout(() => { if (t.parentNode === host) host.removeChild(t); }, lifeMs);
  }

  // ── Bootstrap ──────────────────────────────────────────────────
  // Hover-popover positioning. The popover is `position: fixed` so it
  // escapes `overflow: hidden` on ancestors (the repo card clips its
  // own contents to keep rounded corners). When the mouse enters a
  // host we read its bounding rect and snap the popover just below
  // it. Delegated on document so newly rendered hosts pick it up
  // automatically without per-element wiring. After positioning we
  // also clamp the popover horizontally so it doesn't slide past the
  // viewport edge.
  function positionHoverPopoverFor(host) {
    const popover = host.querySelector('.hover-popover');
    if (!popover) return;
    const hr = host.getBoundingClientRect();
    popover.style.left = `${Math.max(8, hr.left)}px`;
    popover.style.top  = `${hr.bottom + 4}px`;
    // After the browser paints the popover (CSS :hover flips display
    // to block), nudge it left if it would overflow the viewport.
    requestAnimationFrame(() => {
      const pr = popover.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) {
        popover.style.left =
          `${Math.max(8, window.innerWidth - pr.width - 8)}px`;
      }
    });
  }
  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest && e.target.closest(
      '.hover-popover-host, .tab-info-host');
    if (!host) return;
    positionHoverPopoverFor(host);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────
  // Global handler. Skips when focus is in an input / textarea /
  // contenteditable / select so we don't hijack typing. Esc always
  // closes anything that's open (modals, toasts, help overlay) before
  // any other shortcut fires.
  function isTextInputFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
    }
    return tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }
  function dismissTopmostOverlay() {
    // Order: help overlay → most-recent toast → any open modal backdrop
    // → any open hover-popover host that has focus-within.
    if (typeof closeHelpOverlay === 'function'
        && document.getElementById('help-overlay')) {
      closeHelpOverlay();
      return true;
    }
    const banner = document.querySelector('#agent-toast-host .toast-agent');
    if (banner) { banner.remove(); return true; }
    const modal = document.querySelector('.logs-modal-backdrop');
    if (modal) { modal.click(); return true; }
    if (document.getElementById('profile-popover')?.classList.contains('open')) {
      closeProfilePopover();
      return true;
    }
    return false;
  }
  document.addEventListener('keydown', (e) => {
    // Always allow Esc — it dismisses overlays even when typing in a
    // form (matches Gmail, GitHub, VS Code).
    if (e.key === 'Escape') {
      if (dismissTopmostOverlay()) e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTextInputFocused()) return;
    switch (e.key) {
      case 'r': case 'R':
        e.preventDefault();
        refreshAll(true);
        showToast('ok', '↻ Refreshing…');
        break;
      case 'n': case 'N':
        e.preventDefault();
        openAddIssueDialog();
        break;
      case '/':
        e.preventDefault();
        // Open the filters row first if collapsed so the search input
        // can gain focus.
        const filtersRow = document.getElementById('filters-row');
        if (filtersRow && !filtersRow.classList.contains('open')) {
          document.getElementById('filters-toggle')?.click();
        }
        const searchInput = document.getElementById('tab-search-input');
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
        break;
      case '?':
        e.preventDefault();
        if (typeof openHelpOverlay === 'function') openHelpOverlay();
        break;
    }
  });

  // Focus trap. Tab/Shift+Tab inside any open modal cycle through that
  // modal's focusable elements rather than escaping to the page below.
  // Works for every modal because they all use the .logs-modal-backdrop
  // wrapper — the trap finds the topmost backdrop in the DOM and limits
  // the focus ring to its descendants.
  function topmostModalRoot() {
    const all = document.querySelectorAll('.logs-modal-backdrop');
    return all.length ? all[all.length - 1] : null;
  }
  function focusableWithin(root) {
    const sel = 'a[href], area[href], button:not([disabled]), '
              + 'input:not([disabled]):not([type="hidden"]), '
              + 'select:not([disabled]), textarea:not([disabled]), '
              + '[tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll(sel)).filter(el =>
      el.getClientRects().length > 0);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const modal = topmostModalRoot();
    if (!modal) return;
    const focusable = focusableWithin(modal);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !modal.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !modal.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }, true);

  // Minimum time the splash stays visible. Even if the state arrives
  // immediately we keep the matrix animation up for this long so the
  // boot doesn't feel like a flash. The browser's blank pre-paint phase
  // is excluded — we measure from when the splash inline script ran
  // (window.__splashStart).
  const MIN_SPLASH_MS = 2000;
  const waitMinSplash = () => {
    const start = window.__splashStart || 0;
    const elapsed = performance.now() - start;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    return new Promise(r => setTimeout(r, remaining));
  };
  const getInitialState = () => {
    const raw = $('#initial-state')?.textContent;
    let inline = null;
    if (raw) {
      try { inline = JSON.parse(raw); } catch (_) {}
    }
    // Server now ships a sentinel `{ _pending: true }` so the / route
    // doesn't block on gather_all(). Fetch the real state from
    // /api/status — the splash stays up until it arrives.
    if (inline && !inline._pending) return Promise.resolve(inline);
    return fetch('/api/status').then(r => r.json());
  };
  const bootApp = () => {
    Promise.all([getInitialState(), waitMinSplash()]).then(([state]) => {
      window.__lastState = state;
      renderApp(state);
      applyFilters();
      const splash = document.getElementById('splash-screen');
      if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => {
          splash.remove();
          if (window.__splashRaf) cancelAnimationFrame(window.__splashRaf);
        }, 600);
      }
      scheduleNextRefresh();
      updateAppBadge();
      // 3-second badge poller so a fresh agent message updates the
      // recipient's 📬N tab counter in near-real-time instead of
      // waiting for the next 5-minute /api/status refresh.
      startBadgePoller();
      // Best-effort fetch of the missing-primaries status; on
      // resolution we re-render so the banner shows up if anything's
      // missing.
      fetchPrimariesStatus().then(() => {
        if (primariesStatus && primariesStatus.missing
            && primariesStatus.missing.length
            && window.__lastState) {
          snapshotOpenState();
          renderApp(window.__lastState);
          applyFilters();
        }
      });
      // Start the notification poller AFTER seeding so we don't toast
      // events that already exist when the page loaded.
      seedLastSeenEventId().then(() => {
        notifyPollTimer = setInterval(pollNewEvents, NOTIFY_POLL_MS);
      });
      // First-run nudge for desktop notifications. Slight delay so it
      // doesn't fight the initial paint.
      setTimeout(maybeShowNotifPrompt, 600);
    }).catch(err => {
      console.error('failed to load initial state', err);
      // Surface the banner instead of replacing the page. If we have a
      // stale state from the cached HTML (PWA offline launch) the SW
      // already served it; if not, the app pane stays empty until the
      // next successful refresh.
      serverStatus.show(err);
      const splash = document.getElementById('splash-screen');
      if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => splash.remove(), 600);
      }
      scheduleNextRefresh();
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
  } else {
    bootApp();
  }
})();
