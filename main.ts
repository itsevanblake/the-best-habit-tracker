import { Plugin, PluginSettingTab, MarkdownRenderChild, Modal, App, Setting, Notice, ItemView, WorkspaceLeaf, requestUrl } from "obsidian";
import { createClient, SupabaseClient, Session, RealtimeChannel } from "@supabase/supabase-js";

type HabitType = "build" | "break";
// "habit" (default) is the existing recurring/streak item. "task" is a
// one-off item scheduled for a specific date — no streak, no Four Laws
// formula, just "show up on that date and check it off."
type ItemKind = "habit" | "task";

interface HabitDefinition {
	id: string;
	name: string;
	color: string;
	createdAt: string; // YYYY-MM-DD
	kind?: ItemKind; // default "habit"
	scheduledDate?: string; // YYYY-MM-DD — only for kind: "task". Hidden from the tracker until this date.
	archived?: boolean; // for kind: "task", set automatically once checked off, collapsing it into the "Done" section. For kind: "habit", set manually via the Archive action (ConfirmArchiveModal), collapsing it into the "Archived Habits" section — check-in history and streak are kept, and it's restorable anytime via the ↩️ button.
	type?: HabitType; // default "build" — a "break" habit inverts the framing (Clear's four laws apply in reverse to quitting a habit), not the click mechanic: a checked day still means "I succeeded today" (i.e. "I resisted").
	// The Complete Habit Formula — Clear's own four-part sentence structure,
	// one field per Law of Behavior Change, 1:1:
	// "After I [trigger], I will [routine]. [craving hook]. Once done, [reward]."
	stackedAfter?: string; // Trigger, Law 1 (Make It Obvious): the cue/environment. "After I ___"
	craving?: string; // Craving, Law 2 (Make It Attractive): what makes you want to, e.g. temptation bundling.
	minimumVersion?: string; // Routine, Law 3 (Make It Easy): the actual scaled-down, <2-minute action.
	reward?: string; // Reward, Law 4 (Make It Satisfying): the immediate payoff tied to completion.
	// Also part of Atomic Habits, but not part of the 4-law formula above.
	identity?: string; // "I am someone who..." — identity-based habits: the vote this habit casts for who you're becoming.
	linkedGoal?: string; // Note name of the Goals/Quarters file this habit is the "system" for.
	// Per-habit check-in alarm (habit kind only — not meaningful for a
	// one-off task). Once alarmTime passes local time with this habit not
	// yet checked in today, HabitTrackerPlugin.checkAlarm() nags (sound +
	// Notice) every alarmRepeatMinutes until it is. See PluginSettings.
	// lastCallAlarms for the generic, non-habit-tied version.
	alarmEnabled?: boolean;
	alarmTime?: string; // "HH:MM", 24h, local time
	alarmRepeatMinutes?: number; // default 10 if alarmEnabled but unset
	// Optional display-only qualifier — prefixes the DISPLAYED name (see
	// habitDisplayName()) without touching the stored base `name`. Habit-only
	// (meaningless for a one-off task).
	timeOfDay?: "morning" | "midday" | "evening";
	// Which weekdays this habit is actually meant to be done on, as
	// getDay() numbers (0 = Sunday ... 6 = Saturday). Habit-only — a task
	// already has its own scheduledDate. Undefined (or all seven listed)
	// means "every day", which is the pre-scheduling behavior, so every
	// habit created before this feature existed keeps its exact streak
	// with no migration. See habitScheduledDays() and
	// computeScheduledStreak() for how this reshapes the streak.
	scheduledDays?: number[];
}

type TimeOfDay = "morning" | "midday" | "evening";
const TIME_OF_DAY_LABELS: Record<TimeOfDay, string> = { morning: "Morning", midday: "Mid-day", evening: "Evening" };

// The name to display everywhere a habit's name is shown to the user —
// prefixes the base `name` with its Time of Day qualifier (if set) without
// ever mutating the stored name itself. Habit-only; tasks don't have a
// timeOfDay field so this is a no-op for them.
function habitDisplayName(habit: HabitDefinition): string {
	return habit.timeOfDay ? `${TIME_OF_DAY_LABELS[habit.timeOfDay]} ${habit.name}` : habit.name;
}

// A generic, non-habit-tied nag — "last call" for whatever the name
// describes (e.g. "Log off for the day"). Unlike a per-habit alarm there's
// no data condition that auto-silences it, so it keeps repeating every
// LAST_CALL_REPEAT_MINUTES until explicitly dismissed via the Notice's
// Dismiss button — a dismissal that only lasts for that calendar day (see
// HabitTrackerPlugin.checkAlarm()'s day-boundary reset).
interface LastCallAlarm {
	id: string;
	name: string;
	time: string; // "HH:MM", 24h, local time
	enabled: boolean;
}

// A day can be a full completion (true) or the minimum/2-minute-rule version
// (Law 3). Both count toward streaks ("showing up" is what matters), but
// render differently so the distinction stays visible.
type EntryValue = true | "min";

interface PluginData {
	habits: HabitDefinition[];
	entries: Record<string, Record<string, EntryValue>>; // habitId -> "YYYY-MM-DD" -> value
	customColors: string[]; // user-saved colors from the color wheel, shown alongside the preset PALETTE
	hasCreatedFirstHabit: boolean; // once true, the habit creation walkthrough stops opening automatically
}

const DEFAULT_DATA: PluginData = { habits: [], entries: {}, customColors: [], hasCreatedFirstHabit: false };

interface PluginSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
	// Local-only (not synced via Supabase) since sound/confetti is a
	// per-device preference, not habit data.
	celebrationEffectsEnabled: boolean;
	// Day-streak thresholds that trigger a celebration (maybeCelebrate()) and
	// drive each habit's "days to next milestone" bubble. User-editable via
	// the settings tab's Milestones section. Order doesn't matter for
	// storage — read sites sort a copy (see HabitTrackerPlugin.sortedMilestones()).
	milestones: number[];
	// Generic "last call" nags — not tied to any specific habit. See the
	// LastCallAlarm doc comment above. This settings block (plus each
	// habit's own alarmEnabled/alarmTime/alarmRepeatMinutes fields) is what
	// the external ~/.second-brain-cron/habit-alarm.sh fallback reads
	// straight out of data.json via jq, so the two halves (in-app +
	// closed-Obsidian) share one source of truth instead of drifting.
	lastCallAlarms: LastCallAlarm[];
	// AI Assistance — powers the "Review Formula" button in the Add/Edit
	// Habit modal, which sends the Complete Habit Formula fields to the
	// Anthropic Messages API and gets back a critique + rewrite per field.
	// Local-only (not synced via Supabase): an API key is a per-device
	// credential, not habit data.
	anthropicApiKey: string;
	anthropicModel: string;
	// Design Tweaks — every visual decision in the plugin's look, exposed as
	// an adjustable value (see TWEAK_SPEC / TweakPanelModal). Stored as a
	// sparse map of tweak-id -> value: only values the user actually changed
	// are written, so an untouched install stores `{}` and always tracks
	// whatever the shipped defaults become. That also means a future
	// restyle doesn't need a migration — unset ids simply fall through to
	// the new defaults. Synced like other settings, so a look follows you
	// across devices.
	designTweaks: Record<string, string>;
	// Copy overrides, same sparse-map contract as designTweaks above: only
	// strings the user actually rewrote are stored, keyed by COPY_SPEC id.
	// Kept separate from designTweaks because the two have different
	// lifecycles — a token change repaints, a copy change re-renders.
	designCopy: Record<string, string>;
}

// ---- Design Tweaks ----
// Each entry is one aesthetic decision the design makes, surfaced as a live
// control. `kind` picks the widget; `cssVar` (when present) means the value
// is written straight onto .habit-tracker-root as a custom property, which
// is why the whole system needs no re-render — CSS recalculates on its own.
// Entries with `bodyClass` instead are structural: they toggle a class that
// styles.css keys off, for things a single custom property can't express
// (hiding a whole pill, swapping a border style).
//
// `def` must match what styles.css actually ships, because Reset and the
// "changed?" check both compare against it. When you change a shipped value
// in styles.css, change it here too or the panel will misreport state.
type TweakKind = "color" | "range" | "select" | "toggle" | "font";

interface TweakDef {
	id: string;
	label: string;
	group: string;
	kind: TweakKind;
	def: string;
	cssVar?: string;
	bodyClass?: string;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: Array<{ value: string; label: string }>;
	help?: string;
}

// Font stacks offered in the two font pickers. Deliberately all
// system-available (no webfont loading, which an Obsidian plugin can't do
// reliably offline) — each is a real stack with macOS and Windows members
// plus a generic fallback, rather than a single face that silently degrades
// on the other OS.
const TWEAK_FONT_STACKS: Array<{ value: string; label: string }> = [
	{ value: '"Bahnschrift", "Avenir Next Condensed", "Futura", "Segoe UI", system-ui, sans-serif', label: "Condensed geometric (default display)" },
	{ value: '"DM Sans", "Segoe UI", system-ui, sans-serif', label: "Neutral sans (default body)" },
	{ value: 'system-ui, -apple-system, "Segoe UI", sans-serif', label: "System UI" },
	{ value: '"Futura", "Century Gothic", "Avenir Next", system-ui, sans-serif', label: "Geometric" },
	{ value: '"Avenir Next", "Avenir", "Segoe UI", system-ui, sans-serif', label: "Humanist" },
	{ value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: "Grotesque" },
	{ value: '"Impact", "Haettenschweiler", "Arial Narrow Bold", sans-serif', label: "Poster / heavy" },
	{ value: '"Georgia", "Iowan Old Style", "Times New Roman", serif', label: "Serif" },
	{ value: '"Menlo", "Consolas", "SF Mono", ui-monospace, monospace', label: "Monospace" },
	{ value: '"Chalkboard SE", "Comic Sans MS", "Bradley Hand", cursive', label: "Handwritten" },
];

const TWEAK_WEIGHTS: Array<{ value: string; label: string }> = [
	{ value: "400", label: "Regular" },
	{ value: "500", label: "Medium" },
	{ value: "600", label: "Semibold" },
	{ value: "700", label: "Bold" },
	{ value: "800", label: "Extrabold" },
	{ value: "900", label: "Black" },
];

const TWEAK_SPEC: TweakDef[] = [
	// ---- Color ----
	{ id: "accent", label: "Accent", group: "Color", kind: "color", def: "#a855f7", cssVar: "--htx-glow-violet", help: "The main violet. Drives borders, toolbar outlines, focus rings, and the active view segment." },
	{ id: "accentBright", label: "Accent (bright)", group: "Color", kind: "color", def: "#c084fc", cssVar: "--htx-glow-violet-bright", help: "Hover and focus state of the accent." },
	{ id: "accentSoft", label: "Accent (deep)", group: "Color", kind: "color", def: "#6d28d9", cssVar: "--htx-violet-soft", help: "The darker end of the accent, used in the panel wash." },
	{ id: "bg", label: "Page ground", group: "Color", kind: "color", def: "#0a0713", cssVar: "--htx-bg" },
	{ id: "bg2", label: "Page ground (top)", group: "Color", kind: "color", def: "#120a24", cssVar: "--htx-bg-2", help: "The panel fades from this at the top to the page ground below." },
	{ id: "card", label: "Card fill", group: "Color", kind: "color", def: "#150d29", cssVar: "--htx-card" },
	{ id: "text", label: "Text", group: "Color", kind: "color", def: "#f3ecff", cssVar: "--htx-text" },
	{ id: "textMuted", label: "Text (muted)", group: "Color", kind: "color", def: "#b7a9d9", cssVar: "--htx-text-muted" },
	{ id: "textFaint", label: "Text (faint)", group: "Color", kind: "color", def: "#8574ad", cssVar: "--htx-text-faint", help: "Formula lines and missed-day numerals. Watch contrast if you darken this." },
	{ id: "gold", label: "Streak gold", group: "Color", kind: "color", def: "#fbbf24", cssVar: "--htx-gold" },
	{ id: "goldBright", label: "Streak gold (bright)", group: "Color", kind: "color", def: "#fde68a", cssVar: "--htx-gold-bright" },
	{ id: "green", label: "Success green", group: "Color", kind: "color", def: "#34d399", cssVar: "--htx-green", help: "The check-in flash." },
	{ id: "greenBright", label: "Success green (bright)", group: "Color", kind: "color", def: "#4ade80", cssVar: "--htx-green-bright" },
	{ id: "red", label: "Alert red", group: "Color", kind: "color", def: "#f87171", cssVar: "--htx-red", help: "Streak-at-risk pulse, alarms, overdue tasks." },
	{ id: "borderStrength", label: "Border strength", group: "Color", kind: "range", def: "30", cssVar: "--htx-border-pct", min: 0, max: 100, step: 5, unit: "%", help: "How much accent shows in card and control outlines." },

	// ---- Type ----
	{ id: "fontDisplay", label: "Display face", group: "Type", kind: "font", def: TWEAK_FONT_STACKS[0].value, cssVar: "--htx-font-display", options: TWEAK_FONT_STACKS, help: "Habit names, big numbers, headings." },
	{ id: "fontBody", label: "Body face", group: "Type", kind: "font", def: TWEAK_FONT_STACKS[1].value, cssVar: "--htx-font-body", options: TWEAK_FONT_STACKS },
	{ id: "rootSize", label: "Overall scale", group: "Type", kind: "range", def: "1.1", cssVar: "--htx-root-size", min: 0.8, max: 1.6, step: 0.05, unit: "em", help: "Scales the entire tracker at once." },
	{ id: "nameSize", label: "Habit name size", group: "Type", kind: "range", def: "1.15", cssVar: "--htx-name-size", min: 0.8, max: 2.4, step: 0.05, unit: "em" },
	{ id: "nameWeight", label: "Habit name weight", group: "Type", kind: "select", def: "700", cssVar: "--htx-name-weight", options: TWEAK_WEIGHTS },
	{ id: "pillSize", label: "Stat pill size", group: "Type", kind: "range", def: "0.74", cssVar: "--htx-pill-size", min: 0.55, max: 1.2, step: 0.02, unit: "em" },
	{ id: "numWeight", label: "Number weight", group: "Type", kind: "select", def: "700", cssVar: "--htx-num-weight", options: TWEAK_WEIGHTS },
	{ id: "tracking", label: "Label letter-spacing", group: "Type", kind: "range", def: "0.03", cssVar: "--htx-tracking", min: -0.02, max: 0.3, step: 0.01, unit: "em", help: "Affects uppercase labels like SUN/MON and BUILD." },
	{ id: "identityItalic", label: "Identity line in italic", group: "Type", kind: "toggle", def: "on", bodyClass: "ht-identity-roman", help: "The → \"I am the type of person who…\" line." },

	// ---- Shape ----
	{ id: "radius", label: "Corner radius", group: "Shape", kind: "range", def: "12", cssVar: "--htx-radius-base", min: 0, max: 28, step: 1, unit: "px", help: "Scales every rounded corner together." },
	{ id: "cardPadding", label: "Card padding", group: "Shape", kind: "range", def: "20", cssVar: "--htx-card-pad", min: 6, max: 44, step: 1, unit: "px" },
	{ id: "cardGap", label: "Gap between cards", group: "Shape", kind: "range", def: "16", cssVar: "--htx-card-gap", min: 0, max: 48, step: 1, unit: "px" },
	{ id: "panelPadding", label: "Panel padding", group: "Shape", kind: "range", def: "18", cssVar: "--htx-panel-pad", min: 0, max: 48, step: 1, unit: "px" },
	{ id: "cellSize", label: "Day cell size", group: "Shape", kind: "range", def: "76", cssVar: "--htx-cell-size", min: 40, max: 140, step: 2, unit: "px", help: "Max width of a Week/Month day cell." },
	{ id: "cellGap", label: "Day cell gap", group: "Shape", kind: "range", def: "8", cssVar: "--htx-cell-gap", min: 0, max: 24, step: 1, unit: "px" },
	{ id: "cellRadius", label: "Day cell radius", group: "Shape", kind: "range", def: "10", cssVar: "--htx-cell-radius", min: 0, max: 40, step: 1, unit: "px" },
	{ id: "hairline", label: "Outline weight", group: "Shape", kind: "range", def: "1", cssVar: "--htx-hairline", min: 1, max: 4, step: 1, unit: "px" },

	// ---- Effects ----
	{ id: "glow", label: "Glow strength", group: "Effects", kind: "range", def: "100", cssVar: "--htx-glow-pct", min: 0, max: 250, step: 10, unit: "%", help: "0 turns every neon bloom off." },
	{ id: "shadow", label: "Shadow depth", group: "Effects", kind: "range", def: "100", cssVar: "--htx-shadow-pct", min: 0, max: 250, step: 10, unit: "%" },
	{ id: "motion", label: "Motion speed", group: "Effects", kind: "range", def: "100", cssVar: "--htx-motion-pct", min: 0, max: 300, step: 10, unit: "%", help: "0 stops animation. Your OS reduced-motion setting still overrides this." },
	{ id: "hoverLift", label: "Cards lift on hover", group: "Effects", kind: "toggle", def: "on", bodyClass: "ht-no-hover-lift" },
	{ id: "panelWash", label: "Panel background wash", group: "Effects", kind: "toggle", def: "on", bodyClass: "ht-no-panel-wash", help: "The soft radial haze behind all the cards." },
	{ id: "identityBar", label: "Card identity bar", group: "Effects", kind: "select", def: "fade", bodyClass: "ht-bar", options: [
		{ value: "fade", label: "Fade at the ends" },
		{ value: "solid", label: "Solid, full width" },
		{ value: "off", label: "None" },
	], help: "The colored line at each card's top edge." },
	{ id: "barHeight", label: "Identity bar height", group: "Effects", kind: "range", def: "2", cssVar: "--htx-bar-h", min: 1, max: 8, step: 1, unit: "px" },

	// ---- Structure ----
	{ id: "secondaryStats", label: "Secondary stat row", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-secondary", help: "best / this week / this month / this year." },
	{ id: "pillBest", label: "Show “best”", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-pill-best" },
	{ id: "pillWeek", label: "Show “this week”", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-pill-week" },
	{ id: "pillMonth", label: "Show “this month”", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-pill-month" },
	{ id: "pillYear", label: "Show “this year”", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-pill-year" },
	{ id: "pillVotes", label: "Show “votes”", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-pill-votes" },
	{ id: "typeBadge", label: "Show BUILD / BREAK badge", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-type-badge" },
	{ id: "identityLine", label: "Show identity line", group: "Structure", kind: "toggle", def: "on", bodyClass: "ht-no-identity" },
	{ id: "milestoneStyle", label: "Milestone bubble", group: "Structure", kind: "select", def: "dashed", bodyClass: "ht-milestone", options: [
		{ value: "dashed", label: "Dashed outline" },
		{ value: "solid", label: "Solid outline" },
		{ value: "filled", label: "Filled" },
	] },
	{ id: "formulaDefault", label: "Formula starts", group: "Structure", kind: "select", def: "closed", options: [
		{ value: "closed", label: "Collapsed" },
		{ value: "open", label: "Expanded" },
	], help: "Whether each card's Four Laws panel is open when the tracker loads." },
];

const TWEAK_GROUPS = ["Color", "Type", "Shape", "Effects", "Structure"];

// ---- Editable copy ----
// Every user-facing string, registered with an id and its shipped default,
// so the Design Tweaks panel can rewrite any of it. Same sparse-storage
// rule as the design tokens: only edited strings are persisted, so an
// untouched install tracks whatever the shipped wording becomes.
//
// `vars` lists the placeholders a string may contain, written {likeThis}.
// They're substituted at render time by copyText(); an unknown placeholder
// is left alone rather than throwing, so a typo degrades to visible text
// instead of a crash. Strings whose original was a conditional (the
// walkthrough's habit-vs-task branches) are registered as separate ids —
// one per branch — rather than trying to make one editable string carry a
// conditional, which would be unexplainable in a text field.
interface CopyDef {
	id: string;
	label: string;
	group: string;
	def: string;
	multiline?: boolean;
	vars?: string[];
	help?: string;
}

const COPY_GROUP_STATS = "Text · Stats";
const COPY_GROUP_TOOLBAR = "Text · Toolbar";
const COPY_GROUP_CARD = "Text · Card";
const COPY_GROUP_MILESTONE = "Text · Milestones";
const COPY_GROUP_STATES = "Text · Empty & Modals";
const COPY_GROUP_WALK = "Text · Walkthrough";

const COPY_SPEC: CopyDef[] = [
	// --- Stats ---
	{ id: "stat.streak", label: "Streak label", group: COPY_GROUP_STATS, def: "streak" },
	{ id: "stat.clean", label: "Streak label (Break habits)", group: COPY_GROUP_STATS, def: "clean", help: "Shown instead of “streak” on a Break habit." },
	{ id: "stat.best", label: "Best label", group: COPY_GROUP_STATS, def: "best" },
	{ id: "stat.week", label: "This-week label", group: COPY_GROUP_STATS, def: "this week" },
	{ id: "stat.month", label: "This-month label", group: COPY_GROUP_STATS, def: "this month" },
	{ id: "stat.votes", label: "Total label", group: COPY_GROUP_STATS, def: "votes", help: "The all-time count. “votes” is the Atomic Habits framing." },
	{ id: "stat.year", label: "This-year label", group: COPY_GROUP_STATS, def: "this year" },
	{ id: "stat.streakIcon", label: "Streak icon", group: COPY_GROUP_STATS, def: "🔥" },
	{ id: "stat.repair", label: "Repair hint", group: COPY_GROUP_STATS, vars: ["day"], def: "repair by {day}", help: "Shown on a scheduled habit whose missed day can still be made up on an off day." },
	{ id: "stat.cleanIcon", label: "Streak icon (Break)", group: COPY_GROUP_STATS, def: "🛡️" },
	{ id: "stat.bestIcon", label: "Best icon", group: COPY_GROUP_STATS, def: "🏆" },
	{ id: "streaks.completionsIcon", label: "Completions icon (Streaks)", group: COPY_GROUP_STATS, def: "✅" },
	{ id: "streaks.consistencyIcon", label: "Consistency icon (Streaks)", group: COPY_GROUP_STATS, def: "🎯" },
	{ id: "streaks.trendIcon", label: "Trend icon (Streaks)", group: COPY_GROUP_STATS, def: "📈" },
	{ id: "streaks.statusIcon", label: "Task status icon (Streaks)", group: COPY_GROUP_STATS, def: "✅" },
	{ id: "streaks.scheduledIcon", label: "Task scheduled icon (Streaks)", group: COPY_GROUP_STATS, def: "📅" },

	// --- Toolbar ---
	{ id: "tb.day", label: "Day tab", group: COPY_GROUP_TOOLBAR, def: "Day" },
	{ id: "day.done", label: "Day view — done", group: COPY_GROUP_TOOLBAR, def: "Done ✓" },
	{ id: "day.minDone", label: "Day view — minimum done", group: COPY_GROUP_TOOLBAR, def: "Minimum version ✓" },
	{ id: "day.notDone", label: "Day view — not done", group: COPY_GROUP_TOOLBAR, def: "Not yet — click to check off" },
	{ id: "day.upcoming", label: "Day view — future day", group: COPY_GROUP_TOOLBAR, def: "Upcoming" },
	{ id: "day.offDay", label: "Day view — not scheduled", group: COPY_GROUP_TOOLBAR, def: "Not scheduled today" },
	{ id: "day.repairOpen", label: "Day view — repair available", group: COPY_GROUP_TOOLBAR, def: "Off day — make up a missed day" },
	{ id: "day.repairDone", label: "Day view — repaired", group: COPY_GROUP_TOOLBAR, def: "Made up ✓" },
	{ id: "tb.week", label: "Week tab", group: COPY_GROUP_TOOLBAR, def: "Week" },
	{ id: "tb.month", label: "Month tab", group: COPY_GROUP_TOOLBAR, def: "Month" },
	{ id: "tb.year", label: "Year tab", group: COPY_GROUP_TOOLBAR, def: "Year" },
	{ id: "tb.yeardays", label: "Year-Days tab", group: COPY_GROUP_TOOLBAR, def: "Year - Days" },
	{ id: "tb.streaks", label: "Streaks tab", group: COPY_GROUP_TOOLBAR, def: "Streaks", help: "Opens the in-depth streak breakdown for every habit and task." },
	{ id: "tb.today", label: "Today button", group: COPY_GROUP_TOOLBAR, def: "Today" },
	{ id: "tb.reorder", label: "Reorder button", group: COPY_GROUP_TOOLBAR, def: "⠿ Reorder" },
	{ id: "tb.walkthrough", label: "Walkthrough button", group: COPY_GROUP_TOOLBAR, def: "🎓 Creation Walkthrough" },
	{ id: "tb.addHabit", label: "Add-habit button", group: COPY_GROUP_TOOLBAR, def: "Add habit" },

	// --- Card ---
	{ id: "card.build", label: "Build badge", group: COPY_GROUP_CARD, def: "BUILD" },
	{ id: "card.break", label: "Break badge", group: COPY_GROUP_CARD, def: "BREAK" },
	{ id: "card.formulaShow", label: "Show formula", group: COPY_GROUP_CARD, def: "▸ Show the formula ({n})", vars: ["n"] },
	{ id: "card.formulaHide", label: "Hide formula", group: COPY_GROUP_CARD, def: "▾ Hide the formula" },
	{ id: "card.identityPrefix", label: "Identity prefix", group: COPY_GROUP_CARD, def: "→ " },
	{ id: "card.cuePrefix", label: "Cue prefix", group: COPY_GROUP_CARD, def: "⛓ Cue: " },
	{ id: "card.cravingPrefix", label: "Craving prefix", group: COPY_GROUP_CARD, def: "🍯 Craving: " },
	{ id: "card.routinePrefix", label: "Routine prefix", group: COPY_GROUP_CARD, def: "💡 Routine: " },
	{ id: "card.rewardPrefix", label: "Reward prefix", group: COPY_GROUP_CARD, def: "🎉 Reward: " },
	{ id: "card.goalPrefix", label: "Goal prefix", group: COPY_GROUP_CARD, def: "🎯 " },

	// --- Milestones & celebration ---
	{ id: "ms.next", label: "Days to next milestone", group: COPY_GROUP_MILESTONE, def: "🎯 {n} {dayWord} to next milestone", vars: ["n", "dayWord"], help: "{dayWord} becomes day / days automatically." },
	{ id: "ms.achieved", label: "Milestone achieved", group: COPY_GROUP_MILESTONE, def: "🎉 {n}-Day Milestone Achieved!", vars: ["n"] },
	{ id: "ms.allDone", label: "All milestones done", group: COPY_GROUP_MILESTONE, def: "🏆 All milestones achieved!" },
	{ id: "ms.firstTitle", label: "First-habit title", group: COPY_GROUP_MILESTONE, def: "🎉 You just built your first habit!" },
	{ id: "ms.firstTaskTitle", label: "First-task title", group: COPY_GROUP_MILESTONE, def: "🎉 You just built full accountability into a task!" },
	{ id: "ms.firstBody", label: "First-habit body", group: COPY_GROUP_MILESTONE, multiline: true, vars: ["habit"], def: '"{habit}" is live, and you\'ve filled in the whole loop for it — the cue, the craving, the routine, and the reward.' },
	{ id: "ms.firstTaskBody", label: "First-task body", group: COPY_GROUP_MILESTONE, multiline: true, vars: ["habit", "date"], def: '"{habit}" is scheduled for {date}, and you\'ve filled in the whole loop for it — the cue, the craving, the routine, and the reward.' },
	{ id: "ms.firstBody2", label: "First-habit body (2nd para)", group: COPY_GROUP_MILESTONE, multiline: true, def: "The only thing left is showing up. Keep coming back to the daily tracker, check it off, and protect your streak — small, consistent reps are what actually compound into the person you're becoming." },
	{ id: "ms.firstTaskBody2", label: "First-task body (2nd para)", group: COPY_GROUP_MILESTONE, multiline: true, def: "It'll stay out of the way until its date, then show up ready to check off — you've already named exactly when, why, and how you'll follow through." },
	{ id: "ms.firstCta", label: "First-habit button", group: COPY_GROUP_MILESTONE, def: "Let's go" },
	{ id: "ms.allHabitsTitle", label: "All-habits-done title", group: COPY_GROUP_MILESTONE, def: "🎉 Every habit, checked off!" },
	{ id: "ms.allTasksTitle", label: "All-tasks-done title", group: COPY_GROUP_MILESTONE, def: "🎉 Every task checked off!" },
	{ id: "ms.allHabitsBody", label: "All-habits-done body", group: COPY_GROUP_MILESTONE, multiline: true, vars: ["count", "plural"], def: "You showed up for all {count} habit{plural} today — that's today's vote cast for who you're becoming." },
	{ id: "ms.allTasksBody", label: "All-tasks-done body", group: COPY_GROUP_MILESTONE, multiline: true, vars: ["count", "plural", "date"], def: "All {count} task{plural} tracked for {date} are done — full accountability, nothing left on the table." },
	{ id: "ms.allCta", label: "All-done button", group: COPY_GROUP_MILESTONE, def: "Nice" },

	// --- Empty states & modals ---
	{ id: "st.emptyIcon", label: "Empty icon", group: COPY_GROUP_STATES, def: "🌱" },
	{ id: "st.emptyTitle", label: "Empty title", group: COPY_GROUP_STATES, def: "No habits yet" },
	{ id: "st.emptyBody", label: "Empty body", group: COPY_GROUP_STATES, multiline: true, def: "Every streak starts with day one — add your first habit below to get started." },
	{ id: "st.emptyFilterIcon", label: "Filtered-empty icon", group: COPY_GROUP_STATES, def: "🔍" },
	{ id: "st.emptyFilterTitle", label: "Filtered-empty title", group: COPY_GROUP_STATES, def: 'No habit named "{name}" yet', vars: ["name"] },
	{ id: "st.doneSection", label: "Done section", group: COPY_GROUP_STATES, def: "✅ Done ({n})", vars: ["n"] },
	{ id: "st.deleteTitle", label: "Delete title", group: COPY_GROUP_STATES, def: "Delete habit?" },
	{ id: "st.deleteBody", label: "Delete body", group: COPY_GROUP_STATES, multiline: true, vars: ["name"], def: '"{name}" and all of its check-in history will be permanently deleted. This can\'t be undone.' },
	{ id: "st.deleteConfirm", label: "Delete typed-confirm prompt", group: COPY_GROUP_STATES, multiline: true, vars: ["n"], def: "This habit has {n} logged days. Type its name to confirm." },
	{ id: "st.deleteCancel", label: "Delete cancel button", group: COPY_GROUP_STATES, def: "Cancel" },
	{ id: "st.deleteConfirmBtn", label: "Delete confirm button", group: COPY_GROUP_STATES, def: "Delete" },
	{ id: "st.archivedSection", label: "Archived section", group: COPY_GROUP_STATES, def: "📦 Archived ({n})", vars: ["n"] },
	{ id: "st.archiveTitle", label: "Archive title", group: COPY_GROUP_STATES, def: "Archive habit?" },
	{ id: "st.archiveBody", label: "Archive body", group: COPY_GROUP_STATES, multiline: true, vars: ["name"], def: '"{name}" will move to Archived Habits. Its check-in history and streak are kept, and you can restore it anytime.' },
	{ id: "st.archiveConfirm", label: "Archive typed-confirm prompt", group: COPY_GROUP_STATES, def: 'Type "Archive" to confirm.' },
	{ id: "st.archiveCancel", label: "Archive cancel button", group: COPY_GROUP_STATES, def: "Cancel" },
	{ id: "st.archiveConfirmBtn", label: "Archive confirm button", group: COPY_GROUP_STATES, def: "Archive" },

	// --- Walkthrough ---
	{ id: "wt.intro", label: "Intro tooltip", group: COPY_GROUP_WALK, def: '👇 Click "+ Add habit" below to start' },
	{ id: "wt.skip", label: "Skip button", group: COPY_GROUP_WALK, def: "Skip walkthrough" },
	{ id: "wt.back", label: "Back button", group: COPY_GROUP_WALK, def: "Back" },
	{ id: "wt.next", label: "Next button", group: COPY_GROUP_WALK, def: "Next" },
	{ id: "wt.nameTitle", label: "1 · Name — title", group: COPY_GROUP_WALK, def: "Name it" },
	{ id: "wt.nameBody", label: "1 · Name — body", group: COPY_GROUP_WALK, multiline: true, def: 'Let\'s build this together. Start by giving it a short, concrete name — something you\'d recognize at a glance, like "Morning run" or "Book the dentist".' },
	{ id: "wt.kindTitle", label: "2 · Kind — title", group: COPY_GROUP_WALK, def: "Habit or Task?" },
	{ id: "wt.kindBody", label: "2 · Kind — body", group: COPY_GROUP_WALK, multiline: true, def: "Is this something you'll do repeatedly (a Habit), or is this something you'll do once on a specific date (a Task)? Pick whichever fits." },
	{ id: "wt.identityBody", label: "3 · Identity — body", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'This isn\'t just about the outcome — it\'s a vote for who you\'re becoming. Every time you follow through, you\'re proving something to yourself. Who are you becoming by doing this? Example: "{example}"' },
	{ id: "wt.goalBodyHabit", label: "4 · Goal — body (habit)", group: COPY_GROUP_WALK, multiline: true, def: "You don't rise to the level of your goals — you fall to the level of your systems. This habit is your system; pick which Goal it's actually serving." },
	{ id: "wt.goalBodyTask", label: "4 · Goal — body (task)", group: COPY_GROUP_WALK, multiline: true, def: "You don't rise to the level of your goals — you fall to the level of your systems. This task is one rep of that system; pick which Goal it's actually serving." },
	{ id: "wt.colorTitle", label: "5 · Color — title", group: COPY_GROUP_WALK, def: "Pick a color" },
	{ id: "wt.colorBody", label: "5 · Color — body", group: COPY_GROUP_WALK, multiline: true, def: "Give it a color so you can spot it at a glance. Click a preset color, or pick and save your own from the wheel." },
	{ id: "wt.typeBody", label: "6 · Build/Break — body", group: COPY_GROUP_WALK, multiline: true, def: "Are you starting this habit, or trying to quit one? Pick Build if you're starting it, or Break if you're trying to quit it — the same Four Laws apply, just reversed for breaking a habit." },
	{ id: "wt.dateTitle", label: "7 · Date — title", group: COPY_GROUP_WALK, def: "Scheduled date" },
	{ id: "wt.dateBody", label: "7 · Date — body", group: COPY_GROUP_WALK, multiline: true, def: 'When are you doing this? Pick the exact date — it\'ll stay out of the way until then, and show up ready to check off. Naming a specific day, not just "someday," is what actually gets one-off tasks done.' },
	{ id: "wt.cueBodyHabit", label: "8 · Cue — body (habit)", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'What will remind you to do this? Anchor it to something you already do without thinking, so the cue is impossible for you to miss. Example: "{example}"' },
	{ id: "wt.cueBodyTask", label: "8 · Cue — body (task)", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'When and where will you actually do this? Naming the exact moment — not just "sometime that day" — is what actually gets a one-off task done. Example: "{example}"' },
	{ id: "wt.cravingBody", label: "9 · Craving — body", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'What makes you actually want to do this? Tie it to something you already crave, so that craving pulls you in. Example: "{example}"' },
	{ id: "wt.routineBody", label: "10 · Routine — body", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'Now scale it down for yourself. What\'s the two-minute version you could do even on your worst day? Optimize for showing up, not for going hard. Example: "{example}"' },
	{ id: "wt.rewardBodyHabit", label: "11 · Reward — body (habit)", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'How will you know you\'re done, right away? Give yourself an immediate payoff — that\'s what will make you want to repeat this tomorrow. Example: "{example}"' },
	{ id: "wt.rewardBodyTask", label: "11 · Reward — body (task)", group: COPY_GROUP_WALK, multiline: true, vars: ["example"], def: 'How will you know you\'re done, right away? Give yourself an immediate payoff the moment you check it off. Example: "{example}"' },
	{ id: "wt.commitTitle", label: "12 · Commit — title", group: COPY_GROUP_WALK, def: "Commit" },
	{ id: "wt.commitBody", label: "12 · Commit — body", group: COPY_GROUP_WALK, multiline: true, vars: ["verb", "subject"], def: 'Ready to commit? Check the box below to say "I commit to {verb} {subject}" — a small, deliberate act that locks in your intention before you start.' },
	{ id: "wt.finishTitleHabit", label: "13 · Finish — title (habit)", group: COPY_GROUP_WALK, def: "Add the habit" },
	{ id: "wt.finishTitleTask", label: "13 · Finish — title (task)", group: COPY_GROUP_WALK, def: "Add the task" },
	{ id: "wt.finishBodyHabit", label: "13 · Finish — body (habit)", group: COPY_GROUP_WALK, multiline: true, def: "You've just built your whole system. Click below to add your first habit and start your streak." },
	{ id: "wt.finishBodyTask", label: "13 · Finish — body (task)", group: COPY_GROUP_WALK, multiline: true, def: "You've just built full accountability into this one-off. Click below to add your task — it'll stay out of sight until its date, then show up ready to check off." },
];

const COPY_GROUPS = [COPY_GROUP_STATS, COPY_GROUP_TOOLBAR, COPY_GROUP_CARD, COPY_GROUP_MILESTONE, COPY_GROUP_STATES, COPY_GROUP_WALK];

// Built with a plain loop rather than Object.fromEntries: the build targets
// es2018, where fromEntries doesn't exist in the type lib (and isn't
// guaranteed at runtime on older Electron builds).
const COPY_BY_ID: Record<string, CopyDef> = {};
COPY_SPEC.forEach((c) => {
	COPY_BY_ID[c.id] = c;
});

// Resolves one copy string: user override if set, else the shipped default,
// with {placeholders} substituted. Unknown placeholders are deliberately
// left as-is so a typo shows up on screen instead of throwing mid-render.
function copyText(overrides: Record<string, string>, id: string, vars?: Record<string, string | number>): string {
	const def = COPY_BY_ID[id];
	if (!def) return "";
	const raw = overrides[id] !== undefined && overrides[id] !== "" ? overrides[id] : def.def;
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

// Reads a tweak's current value, falling back to its shipped default.
function tweakValue(tweaks: Record<string, string>, id: string): string {
	const def = TWEAK_SPEC.find((t) => t.id === id);
	if (!def) return "";
	const raw = tweaks[id];
	return raw === undefined || raw === "" ? def.def : raw;
}

// Pushes the whole tweak set onto a root element as inline custom
// properties plus structural classes. Called on every render and on every
// live control change; cheap enough to do wholesale rather than diffing,
// since it's a few dozen setProperty calls on one element.
function applyTweaksTo(el: HTMLElement, tweaks: Record<string, string>) {
	for (const def of TWEAK_SPEC) {
		const value = tweakValue(tweaks, def.id);
		if (def.cssVar) {
			el.style.setProperty(def.cssVar, def.unit && def.kind === "range" ? `${value}${def.unit}` : value);
		}
		if (!def.bodyClass) continue;
		if (def.kind === "toggle") {
			// A toggle's class is the NEGATIVE (ht-no-*): present only when
			// the user has turned the thing off, so the default state adds
			// no classes at all.
			el.toggleClass(def.bodyClass, value !== "on");
		} else if (def.kind === "select") {
			(def.options ?? []).forEach((opt) => el.toggleClass(`${def.bodyClass}-${opt.value}`, value === opt.value));
		}
	}
}

const DEFAULT_MILESTONES = [7, 30, 60, 100, 150, 200, 250, 300, 365];

// Fixed repeat interval for last-call alarms (see LastCallAlarm) — unlike
// per-habit alarms these don't expose their own configurable repeat, since
// they're meant to be a short, insistent nag until dismissed rather than a
// tunable per-item setting.
const LAST_CALL_REPEAT_MINUTES = 10;

const DEFAULT_SETTINGS: PluginSettings = {
	supabaseUrl: "",
	supabaseAnonKey: "",
	celebrationEffectsEnabled: true,
	milestones: DEFAULT_MILESTONES,
	lastCallAlarms: [],
	anthropicApiKey: "",
	anthropicModel: "claude-haiku-4-5-20251001",
	designTweaks: {},
	designCopy: {},
};

// A cohesive, vibrant set (consistent saturation/lightness rather than a
// mixed bag of muddy and bright tones) that reads well in both light and
// dark themes.
const PALETTE = [
	"#22c55e", // green
	"#3b82f6", // blue
	"#ef4444", // red
	"#f97316", // orange
	"#a855f7", // purple
	"#eab308", // yellow
	"#ec4899", // pink
	"#14b8a6", // teal
];

function pad(n: number): string {
	return n < 10 ? "0" + n : "" + n;
}

function formatDate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr(): string {
	return formatDate(new Date());
}

function addDays(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + n);
	return copy;
}

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "") || "habit"
	);
}

// Obsidian's --text-on-accent is tuned for the theme's own accent color, not
// an arbitrary user-picked habit color — a light/pastel custom color can
// make that text unreadable. Picks black or white via the standard YIQ
// perceived-brightness formula so text painted directly on a habit's color
// (badges, done-cell labels) stays legible regardless of which color was
// chosen.
function contrastColor(hex: string): string {
	const clean = hex.replace("#", "");
	const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
	const r = parseInt(full.slice(0, 2), 16);
	const g = parseInt(full.slice(2, 4), 16);
	const b = parseInt(full.slice(4, 6), 16);
	if ([r, g, b].some((n) => Number.isNaN(n))) return "#ffffff";
	const yiq = (r * 299 + g * 587 + b * 114) / 1000;
	return yiq >= 150 ? "#1a1a1a" : "#ffffff";
}

// A small confetti burst radiating out from the cell that was just checked
// off, contained within the habit card (card needs position: relative,
// already set in styles.css). Pure CSS animation driven by per-piece custom
// properties — no external assets/libraries.
function burstConfetti(card: HTMLElement, originEl: HTMLElement, habitColor: string) {
	const cardRect = card.getBoundingClientRect();
	const originRect = originEl.getBoundingClientRect();
	const originX = originRect.left + originRect.width / 2 - cardRect.left;
	const originY = originRect.top + originRect.height / 2 - cardRect.top;
	const colors = [habitColor, "#ffd166", "#06d6a0", "#ef476f", "#118ab2"];
	for (let i = 0; i < 14; i++) {
		const piece = card.createDiv({ cls: "habit-tracker-confetti-piece" });
		const angle = Math.random() * Math.PI * 2;
		const distance = 40 + Math.random() * 50;
		piece.style.left = `${originX}px`;
		piece.style.top = `${originY}px`;
		piece.style.setProperty("--tx", `${Math.cos(angle) * distance}px`);
		piece.style.setProperty("--ty", `${Math.sin(angle) * distance - 20}px`);
		piece.style.setProperty("--rot", `${Math.random() * 360}deg`);
		piece.style.backgroundColor = colors[i % colors.length];
		window.setTimeout(() => piece.remove(), 700);
	}
}

// A bigger, longer-falling confetti burst reserved for milestone hits
// (settings.milestones, see maybeCelebrate() below) — visually distinct
// from the small per-check-in pop burstConfetti() plays on every ordinary
// day, so crossing a milestone actually reads as a bigger moment. Falls
// from the top of the card rather than radiating from a single cell, since
// maybeCelebrate() runs after the DOM has already been rebuilt and no
// longer has a reference to the exact cell that was clicked.
function burstMilestoneConfetti(card: HTMLElement, habitColor: string) {
	const cardRect = card.getBoundingClientRect();
	const colors = [habitColor, "#ffd166", "#06d6a0", "#ef476f", "#118ab2", "#a855f7"];
	for (let i = 0; i < 36; i++) {
		const piece = card.createDiv({ cls: "habit-tracker-confetti-piece habit-tracker-confetti-piece-milestone" });
		piece.style.left = `${Math.random() * cardRect.width}px`;
		piece.style.top = "-10px";
		piece.style.setProperty("--tx", `${(Math.random() - 0.5) * 140}px`);
		piece.style.setProperty("--ty", `${cardRect.height + 60}px`);
		piece.style.setProperty("--rot", `${360 + Math.random() * 720}deg`);
		piece.style.backgroundColor = colors[i % colors.length];
		piece.style.animationDelay = `${Math.random() * 0.35}s`;
		window.setTimeout(() => piece.remove(), 1700);
	}
}

// One synthesized note via the Web Audio API — the shared building block
// for both the daily chime and the milestone fanfare below.
function playTone(ctx: AudioContext, freq: number, start: number, duration: number, peakGain: number) {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "sine";
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0, start);
	gain.gain.linearRampToValueAtTime(peakGain, start + 0.02);
	gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(start);
	osc.stop(start + duration + 0.05);
}

// The check-off chime. No bundled audio asset needed — everything is
// synthesized. Fails silently if audio is unavailable (e.g. blocked by the
// OS/browser) since the confetti still carries the moment on its own.
//
// Non-milestone days: a quick two-note chime whose pitch climbs with the
// streak through a 7-day cycle (day 1 lowest, day 7 highest — a full major
// scale step per day), then resets back down for the next week, so it
// keeps climbing "sexier" all week without ever fully maxing out into
// something unpleasant.
//
// Milestone days (settings.milestones, shared with maybeCelebrate()): a
// bigger "crazy nice" fanfare — an ascending run into a full bright chord —
// instead of the plain daily chime.
function playCelebrationChime(streak: number, isMilestone: boolean) {
	try {
		const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		const ctx = new AudioCtx();
		const now = ctx.currentTime;
		const baseFreq = 523.25; // C5
		const semitone = (n: number) => baseFreq * Math.pow(2, n / 12);

		if (!isMilestone) {
			// One step per day of the current 7-day cycle, spread across a
			// full octave (day 1 lowest, day 7 exactly an octave up) instead
			// of a single scale step per day — makes the day-to-day climb
			// unmistakable rather than subtle.
			//
			// streak can be 0 (or, in theory, negative) when the marked day
			// doesn't chain to today — e.g. clicking a past cell in the grid
			// that's isolated from the current streak. JS's % can return a
			// negative result for a negative left-hand side (unlike most
			// other languages), which would index daySteps with -1 and
			// silently produce NaN frequencies (dead silence, no error) —
			// clamp to at least day 1 so there's always an audible, correct
			// tone instead.
			const daySteps = [0, 2, 4, 5, 7, 9, 12];
			const dayInWeek = (Math.max(1, streak) - 1) % 7;
			const root = semitone(daySteps[dayInWeek]);
			playTone(ctx, root, now, 0.22, 0.14);
			playTone(ctx, root * Math.pow(2, 4 / 12), now + 0.06, 0.22, 0.11);
			window.setTimeout(() => ctx.close(), 500);
			return;
		}

		const run = [0, 4, 7, 12, 16, 19];
		run.forEach((semi, i) => playTone(ctx, semitone(semi), now + i * 0.06, 0.3, 0.13));
		const chordStart = now + run.length * 0.06 + 0.05;
		[0, 4, 7, 12].forEach((semi) => playTone(ctx, semitone(semi), chordStart, 0.6, 0.14));
		window.setTimeout(() => ctx.close(), 1200);
	} catch {
		// Web Audio unsupported/blocked — the confetti still plays.
	}
}

// The check-in alarm's sound — deliberately more urgent/insistent than the
// daily celebration chime above: a fast alternating two-tone "buzzer",
// repeated a few times, closer to an alarm clock going off than a pleasant
// confirmation ding. Same synthesis approach (Web Audio, no bundled asset)
// and same fail-silent behavior if audio is unavailable — the Notice banner
// still carries the moment on its own.
function playAlarmChime() {
	try {
		const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		const ctx = new AudioCtx();
		const now = ctx.currentTime;
		const highFreq = 880; // A5
		const lowFreq = 659.25; // E5
		const beepDuration = 0.14;
		const beepGap = 0.18;
		for (let i = 0; i < 4; i++) {
			const pairStart = now + i * beepGap * 2;
			playTone(ctx, highFreq, pairStart, beepDuration, 0.18);
			playTone(ctx, lowFreq, pairStart + beepGap, beepDuration, 0.18);
		}
		window.setTimeout(() => ctx.close(), 1800);
	} catch {
		// Web Audio unsupported/blocked — the Notice banner still shows.
	}
}

// Grows a textarea's height to fit its content instead of leaving it a
// fixed number of rows — reset to "auto" first so it can shrink back down
// too (e.g. after deleting text), not just grow.
function autoGrow(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = el.scrollHeight + "px";
}

// ---- Scheduling ----
// A habit can be pinned to specific weekdays (HabitDefinition.scheduledDays).
// Everything below treats "no schedule" and "all seven days" as the same
// thing — a plain daily habit — so the scheduled code path IS the daily code
// path, rather than two parallel implementations that can drift apart.

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function habitScheduledDays(habit: HabitDefinition): number[] {
	const days = habit.scheduledDays;
	if (!days || days.length === 0 || days.length >= 7) return ALL_WEEKDAYS;
	return days;
}

function isDailyHabit(habit: HabitDefinition): boolean {
	return habitScheduledDays(habit).length === 7;
}

function isScheduledOn(habit: HabitDefinition, date: Date): boolean {
	return habitScheduledDays(habit).includes(date.getDay());
}

// The next/previous calendar date this habit is scheduled for, exclusive of
// `from`. Bounded at 7 steps because any non-empty weekday set repeats
// weekly — if nothing matches in 7 days, nothing ever will.
function nextScheduledDate(habit: HabitDefinition, from: Date): Date {
	for (let i = 1; i <= 7; i++) {
		const d = addDays(from, i);
		if (isScheduledOn(habit, d)) return d;
	}
	return addDays(from, 1);
}

function prevScheduledDate(habit: HabitDefinition, from: Date): Date {
	for (let i = 1; i <= 7; i++) {
		const d = addDays(from, -i);
		if (isScheduledOn(habit, d)) return d;
	}
	return addDays(from, -1);
}

// Sunday-start week key ("YYYY-MM-DD" of that week's Sunday), matching the
// Sunday-Saturday week that computeStats' totalThisWeek and the Week view
// already use. Repair quota is one per calendar week, keyed by this.
function weekKey(date: Date): string {
	return formatDate(addDays(date, -date.getDay()));
}

// The off-days that can repair a missed scheduled day: everything strictly
// between the miss and the next scheduled day. For a Mon/Wed/Sat habit,
// missing Monday opens exactly Tuesday; the window shuts when Wednesday
// arrives. A daily habit has no gap between scheduled days, so this is
// always empty — daily habits can never be repaired, which is what keeps
// their behavior identical to before.
function repairWindow(habit: HabitDefinition, missed: Date): Date[] {
	const end = nextScheduledDate(habit, missed);
	const out: Date[] = [];
	for (let d = addDays(missed, 1); formatDate(d) < formatDate(end); d = addDays(d, 1)) out.push(d);
	return out;
}

// Is `date` an off-day currently unlocked for repair — i.e. the scheduled
// day it follows was missed, the window is still open, and this week's one
// repair hasn't been spent? Drives the cell's clickable/locked state.
function isRepairUnlocked(habit: HabitDefinition, entries: Record<string, EntryValue>, date: Date): boolean {
	if (isScheduledOn(habit, date)) return false;
	if (isDailyHabit(habit)) return false;
	const missed = prevScheduledDate(habit, date);
	if (entries[formatDate(missed)]) return false;
	if (formatDate(missed) < formatDate(new Date(habit.createdAt))) return false;
	// Window must still be open: the next scheduled day after the miss
	// hasn't arrived yet.
	if (formatDate(nextScheduledDate(habit, missed)) <= todayStr()) return false;
	return !isRepairSpent(habit, entries, date, formatDate(date));
}

// Has this habit already used its one repair for `date`'s week? `exclude`
// lets a caller ask "ignoring this day itself".
function isRepairSpent(
	habit: HabitDefinition,
	entries: Record<string, EntryValue>,
	date: Date,
	exclude: string
): boolean {
	const key = weekKey(date);
	for (const dateStr in entries) {
		if (!entries[dateStr] || dateStr === exclude) continue;
		const d = new Date(dateStr + "T00:00:00");
		if (weekKey(d) !== key) continue;
		if (isScheduledOn(habit, d)) continue;
		// An off-day check-in that sits in some miss's repair window is a
		// spent repair.
		const missed = prevScheduledDate(habit, d);
		if (!entries[formatDate(missed)]) return true;
	}
	return false;
}

interface Stats {
	streak: number;
	bestStreak: number;
	total: number;
	totalThisWeek: number;
	totalThisMonth: number;
	totalThisYear: number;
	// True when the most recent scheduled day was missed but its repair
	// window is still open — the streak is held at its current number
	// rather than reset, pending that repair. Purely a display signal.
	atRisk: boolean;
	// The last date the pending miss can still be repaired on, or null.
	repairBy: string | null;
}

function computeStats(habit: HabitDefinition, entries: Record<string, EntryValue>): Stats {
	let total = 0;
	let totalThisWeek = 0;
	let totalThisMonth = 0;
	let totalThisYear = 0;
	const now = new Date();
	const currentYear = "" + now.getFullYear();
	const currentYearMonth = currentYear + "-" + pad(now.getMonth() + 1);
	// Sunday-Saturday, matching the Week view's own definition of "this week".
	const weekStart = formatDate(addDays(now, -now.getDay()));
	const weekEnd = formatDate(addDays(now, 6 - now.getDay()));
	for (const date in entries) {
		if (entries[date]) {
			total++;
			if (date.startsWith(currentYear)) totalThisYear++;
			if (date.startsWith(currentYearMonth)) totalThisMonth++;
			if (date >= weekStart && date <= weekEnd) totalThisWeek++;
		}
	}

	const { streak, atRisk, repairBy } = computeScheduledStreak(habit, entries);

	return {
		streak,
		bestStreak: computeBestStreak(habit, entries),
		total,
		totalThisWeek,
		totalThisMonth,
		totalThisYear,
		atRisk,
		repairBy,
	};
}

interface StreakResult {
	streak: number;
	atRisk: boolean;
	repairBy: string | null;
}

// Current streak, counted in *scheduled occurrences* rather than calendar
// days: a Mon/Wed/Sat habit done on all three reads as a 3-streak, and the
// Thursday/Friday in between are not misses because nothing was owed then.
//
// Two rules apply depending on the schedule, and the split is deliberate:
//
//   Daily habits (no schedule, or all seven days) keep the original
//   forgiving rule — one missed day survives, two consecutive reset — so
//   every habit that predates this feature reports exactly the streak it
//   always did. This is the regression-guarded path.
//
//   Scheduled habits are strict: a missed scheduled day resets the streak.
//   What softens that is the repair window (see repairWindow) — the streak
//   is held, not lost, while an off-day repair is still possible, and only
//   collapses once that window shuts unused.
function computeScheduledStreak(habit: HabitDefinition, entries: Record<string, EntryValue>): StreakResult {
	if (isDailyHabit(habit)) {
		let streak = 0;
		let missStreak = 0;
		let cursor = new Date();
		let isToday = true;
		while (true) {
			const dateStr = formatDate(cursor);
			if (entries[dateStr]) {
				streak++;
				missStreak = 0;
			} else if (!isToday) {
				missStreak++;
				if (missStreak >= 2) break;
			}
			isToday = false;
			cursor = addDays(cursor, -1);
		}
		return { streak, atRisk: isStreakAtRisk(habit, entries), repairBy: null };
	}

	const floor = formatDate(new Date(habit.createdAt + "T00:00:00"));
	const today = new Date();
	const todayKey = todayStr();
	// Weeks whose single repair has already been consumed by a more recent
	// miss. Walking newest-first means the most recent repair is the one
	// that counts when two misses compete for the same week's allowance.
	const spentWeeks = new Set<string>();
	let streak = 0;
	let atRisk = false;
	let repairBy: string | null = null;

	let cursor = isScheduledOn(habit, today) ? today : prevScheduledDate(habit, today);
	while (formatDate(cursor) >= floor) {
		const dateStr = formatDate(cursor);

		if (entries[dateStr]) {
			streak++;
		} else if (dateStr === todayKey) {
			// Today is never a miss — the day isn't over yet.
		} else {
			const window = repairWindow(habit, cursor);
			const repairDay = window.find((d) => entries[formatDate(d)]);
			const windowOpen = formatDate(nextScheduledDate(habit, cursor)) > todayKey;

			if (repairDay && !spentWeeks.has(weekKey(repairDay))) {
				spentWeeks.add(weekKey(repairDay));
				streak++;
			} else if (repairDay) {
				// An off-day check-in exists but this week's repair was
				// already used by a later miss — it can't cover this one.
				break;
			} else if (windowOpen && window.length > 0 && !spentWeeks.has(weekKey(window[0]))) {
				// Still repairable: hold the count and flag it, rather than
				// showing a break that a check-in tomorrow would undo.
				atRisk = true;
				repairBy = formatDate(window[window.length - 1]);
			} else {
				break;
			}
		}

		cursor = prevScheduledDate(habit, cursor);
	}

	return { streak, atRisk, repairBy };
}

// Longest streak ever achieved (same forgiving one-gap rule as the current
// streak), scanning forward through history rather than backward from
// today. Surfacing this alongside the current streak matters because
// Clear's "don't break the chain" framing is about the record you're
// building, not just today's status.
function computeBestStreak(habit: HabitDefinition, entries: Record<string, EntryValue>): number {
	if (isDailyHabit(habit)) {
		const doneDates = Object.keys(entries)
			.filter((d) => entries[d])
			.sort();
		if (doneDates.length === 0) return 0;

		let best = 1;
		let current = 1;
		for (let i = 1; i < doneDates.length; i++) {
			const prev = new Date(doneDates[i - 1]);
			const cur = new Date(doneDates[i]);
			const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
			if (diffDays === 1 || diffDays === 2) {
				current++;
			} else {
				current = 1;
			}
			best = Math.max(best, current);
		}
		return best;
	}

	// Scheduled habits: same strict-with-repair rule as the current streak,
	// scanned forward. Note the quota tie-break runs the other way here —
	// walking oldest-first, the earliest repair in a week claims that
	// week's allowance, where the backward walk gives it to the latest.
	// Both are defensible; neither can change a streak's length by more
	// than the one repair they disagree about.
	//
	// Only the habit's CURRENT schedule is known — schedule changes aren't
	// recorded — so history is always re-read through today's weekdays.
	// Changing a habit's days can therefore move its best-ever streak.
	const todayKey = todayStr();
	const floorDate = new Date(habit.createdAt + "T00:00:00");
	const spentWeeks = new Set<string>();
	let best = 0;
	let current = 0;

	let cursor = isScheduledOn(habit, floorDate) ? floorDate : nextScheduledDate(habit, floorDate);
	while (formatDate(cursor) <= todayKey) {
		const dateStr = formatDate(cursor);
		if (entries[dateStr]) {
			current++;
			best = Math.max(best, current);
		} else if (dateStr !== todayKey) {
			const repairDay = repairWindow(habit, cursor).find((d) => entries[formatDate(d)]);
			if (repairDay && !spentWeeks.has(weekKey(repairDay))) {
				spentWeeks.add(weekKey(repairDay));
				current++;
				best = Math.max(best, current);
			} else {
				current = 0;
			}
		}
		cursor = nextScheduledDate(habit, cursor);
	}
	return best;
}

// ---- Streaks view analytics -------------------------------------------
// Everything the Streaks tab shows is derived here from `entries` plus the
// habit's schedule — nothing new is persisted. The occurrence list is the
// shared spine: for a daily habit it's every day since creation, for a
// scheduled one it's only the days that habit was actually due.

// "2026-08-15" -> "Aug 15". Used in the Streaks view's run chips, where
// the full ISO date is too wide to sit inline.
function shortDate(iso: string): string {
	return new Date(iso + "T00:00:00").toLocaleString("default", { month: "short", day: "numeric" });
}

interface StreakRun {
	start: string;
	end: string;
	length: number;
	// The occurrence that ended the run, or null if the run is still live.
	brokenOn: string | null;
}

interface Consistency {
	// Occurrences owed since the habit was created, excluding today (the
	// day isn't over, so counting it would drag every rate down).
	owed: number;
	met: number;
	rate: number; // 0-100
	recentRate: number; // last 30 occurrences
	priorRate: number; // the 30 before those
}

// Every date this habit was due, oldest first, from creation through today.
function occurrenceDates(habit: HabitDefinition, through: Date = new Date()): Date[] {
	const out: Date[] = [];
	const end = formatDate(through);
	const daily = isDailyHabit(habit);
	let cursor = new Date(habit.createdAt + "T00:00:00");
	if (!daily && !isScheduledOn(habit, cursor)) cursor = nextScheduledDate(habit, cursor);
	// Hard bound: a corrupt or absurd createdAt shouldn't spin forever.
	let guard = 0;
	while (formatDate(cursor) <= end && guard++ < 20000) {
		out.push(cursor);
		cursor = daily ? addDays(cursor, 1) : nextScheduledDate(habit, cursor);
	}
	return out;
}

// Was this occurrence satisfied — either checked off directly, or covered
// by an off-day repair? Mirrors the streak rules so the page can never
// disagree with the number on the card.
function occurrenceMet(habit: HabitDefinition, entries: Record<string, EntryValue>, date: Date, spentWeeks: Set<string>): boolean {
	if (entries[formatDate(date)]) return true;
	if (isDailyHabit(habit)) return false;
	const repairDay = repairWindow(habit, date).find((d) => entries[formatDate(d)]);
	if (!repairDay || spentWeeks.has(weekKey(repairDay))) return false;
	spentWeeks.add(weekKey(repairDay));
	return true;
}

// Completed streak runs, oldest first. The longest of these always equals
// computeBestStreak() — asserted in the test harness, since two functions
// that disagree about the best streak would be worse than either alone.
function computeStreakRuns(habit: HabitDefinition, entries: Record<string, EntryValue>): StreakRun[] {
	const occurrences = occurrenceDates(habit);
	const todayKey = todayStr();
	const daily = isDailyHabit(habit);
	const spentWeeks = new Set<string>();
	const runs: StreakRun[] = [];

	let runStart: Date | null = null;
	let runEnd: Date | null = null;
	let length = 0;
	let pendingGap = false; // daily only: one missed day is survivable

	const close = (brokenOn: string | null) => {
		if (runStart && runEnd && length > 0) {
			runs.push({ start: formatDate(runStart), end: formatDate(runEnd), length, brokenOn });
		}
		runStart = null;
		runEnd = null;
		length = 0;
		pendingGap = false;
	};

	for (const date of occurrences) {
		const dateStr = formatDate(date);
		if (occurrenceMet(habit, entries, date, spentWeeks)) {
			if (!runStart) runStart = date;
			runEnd = date;
			length++;
			pendingGap = false;
		} else if (dateStr === todayKey) {
			// Today is never a break — the day isn't over.
		} else if (daily && !pendingGap && length > 0) {
			// First missed day of a daily habit: survivable, so hold.
			pendingGap = true;
		} else {
			close(length > 0 ? dateStr : null);
		}
	}
	close(null);
	return runs;
}

function computeConsistency(habit: HabitDefinition, entries: Record<string, EntryValue>): Consistency {
	const todayKey = todayStr();
	const occurrences = occurrenceDates(habit).filter((d) => formatDate(d) !== todayKey);
	const spentWeeks = new Set<string>();
	const met: boolean[] = occurrences.map((d) => occurrenceMet(habit, entries, d, spentWeeks));
	const owed = met.length;
	const metCount = met.filter(Boolean).length;
	const pct = (arr: boolean[]) => (arr.length === 0 ? 0 : Math.round((arr.filter(Boolean).length / arr.length) * 100));
	return {
		owed,
		met: metCount,
		rate: pct(met),
		recentRate: pct(met.slice(-30)),
		priorRate: pct(met.slice(-60, -30)),
	};
}

// Evening cutoff (local time) after which an unmarked today starts reading
// as "at risk" rather than just "not done yet" — see isStreakAtRisk() below.
const AT_RISK_HOUR = 18;

// Purely a rendering signal (never touches stored data): true once it's
// evening, today isn't checked in yet, and yesterday was — i.e. there's an
// active streak that will actually break at midnight if today stays blank.
// A habit with no streak yet (yesterday blank) has nothing to protect, so
// it doesn't get the at-risk treatment.
function isStreakAtRisk(habit: HabitDefinition, entries: Record<string, EntryValue>): boolean {
	if (new Date().getHours() < AT_RISK_HOUR) return false;
	const today = todayStr();
	if (entries[today]) return false;

	if (isDailyHabit(habit)) {
		const yesterday = formatDate(addDays(new Date(), -1));
		return !!entries[yesterday];
	}

	// Scheduled habits are at risk on two kinds of evening: one where the
	// habit is actually owed today, and one where today is the last chance
	// to repair an earlier miss.
	const now = new Date();
	if (isRepairUnlocked(habit, entries, now)) return true;
	if (!isScheduledOn(habit, now)) return false;
	return computeScheduledStreak(habit, entries).streak > 0;
}

// Toggles a day's state: empty -> full -> empty. A day previously marked
// "min" (the old three-state minimum-version cycle) still clears back to
// empty on the next click, same as "full" — it just can't be newly created
// anymore.
function nextEntryValue(current: EntryValue | undefined): EntryValue | undefined {
	return current === undefined ? true : undefined;
}

interface HabitLevers {
	// The Complete Habit Formula — Clear's own four-part sentence, one
	// field per Law, in order:
	// "After I [stackedAfter], I will [minimumVersion]. [craving]. Once done, [reward]."
	stackedAfter: string; // Trigger — Law 1
	craving: string; // Craving — Law 2
	minimumVersion: string; // Routine — Law 3
	reward: string; // Reward — Law 4
	// Also part of Atomic Habits, not part of the 4-law formula itself.
	identity: string;
	linkedGoal: string;
}

interface HabitFormValues extends HabitLevers {
	name: string;
	color: string;
	type: HabitType;
	kind: ItemKind;
	scheduledDate: string;
	alarmEnabled: boolean;
	alarmTime: string;
	alarmRepeatMinutes: number;
	timeOfDay: TimeOfDay | "";
	// getDay() numbers this habit is scheduled for. Always a full 0-6 set
	// for a daily habit, so the form never has to special-case "unset".
	scheduledDays: number[];
	// The day tracking starts. This is the floor for every streak and
	// consistency calculation (see occurrenceDates), so it's editable rather
	// than silently stamped: a habit set up at 9pm would otherwise owe its
	// creation day immediately and open at ~50% consistency with no way to
	// correct it short of back-filling a day you never actually intended to
	// track. Defaults to today when creating.
	createdAt: string;
}

// The Complete Habit Formula fields, matching the Four Laws 1:1.
const FORMULA_KEYS: (keyof HabitLevers)[] = ["stackedAfter", "craving", "minimumVersion", "reward"];
// Also part of Atomic Habits, but not part of the 4-law formula sentence.
// linkedGoal is deliberately excluded here — it gets its own dropdown
// (picked from Life Compass Goals) rather than the generic textarea
// treatment every other lever field gets, see renderGoalPicker below.
const OTHER_LEVER_KEYS: (keyof HabitLevers)[] = ["identity"];

// Shown as each field's placeholder hint for a brand-new habit (nothing
// set yet). Native placeholder text is inherently the right tool here: it
// renders dimmed automatically, and disappears the instant that specific
// field is typed into.
// All seven describe the same example habit — a desk/coffee/task/streak
// morning-work routine — so the whole form reads as one coherent worked
// example instead of disconnected fragments.
const EXAMPLE_LEVERS: HabitLevers = {
	stackedAfter: "After I sit down at my desk with my morning coffee",
	craving: "The fresh coffee is the reward for starting — I only drink it at my desk",
	minimumVersion: "Open my workspace dashboard and check off exactly one high-priority task",
	reward: "Immediately check my visual streak counter",
	identity: "I am someone who follows through on what matters most",
	linkedGoal: "Run a sub-4-hour marathon by December 2026",
};

// Definitions grounded directly in James Clear's Atomic Habits framework,
// matching this vault's own Wiki/Concepts pages (Four Laws of Behavior
// Change, Habit Loop, Habit Stacking, Identity-Based Habits) rather than
// generic explanations.
const LEVER_TERM_INFO: Record<keyof HabitLevers, { term: string; definition: string }> = {
	stackedAfter: {
		term: "Cue — Law 1, Make It Obvious",
		definition:
			'The cue. Often a habit stack anchored to something you already do reliably: "After [current habit], I will [new habit]." The cue habit needs to be automatic — waking up, brushing teeth, sitting down with coffee.',
	},
	craving: {
		term: "Craving — Law 2, Make It Attractive",
		definition:
			"The want that pulls you into the habit. Clear's temptation bundling: pair the habit with something you already desire, so the craving for that thing becomes attached to the habit itself.",
	},
	minimumVersion: {
		term: "Routine — Law 3, Make It Easy",
		definition:
			"The actual response — scaled down to a version that takes two minutes or less, to remove friction and build consistency before intensity. Optimize for the starting line, not the finish line.",
	},
	reward: {
		term: "Reward — Law 4, Make It Satisfying",
		definition:
			'The immediate payoff tied to completion — what makes the loop worth repeating. Clear: habit trackers and "don\'t break the chain" work because they supply this reward instantly, when the real-world payoff is too delayed to feel.',
	},
	identity: {
		term: "Identity-Based Habits",
		definition:
			'Clear\'s core claim: lasting change works top-down through identity, not bottom-up through outcomes — "not behavior change, not results change, it\'s identity change." Every completed day is a vote for the type of person you\'re becoming.',
	},
	linkedGoal: {
		term: "Systems Over Goals",
		definition:
			"Clear: \"You do not rise to the level of your goals. You fall to the level of your systems.\" A goal tells you where you're going. A system gets you there. A habit is the system — this links it to the goal it actually serves.",
	},
};

const LEVER_LABELS: Record<keyof HabitLevers, string> = {
	stackedAfter: "Cue",
	craving: "Craving",
	minimumVersion: "Routine",
	reward: "Reward",
	identity: "Identity",
	linkedGoal: "Goal",
};

// Short, concrete "why this helps" used in the validation Notice when a
// field is left blank — distinct from the fuller definitions in
// LEVER_TERM_INFO, which live in the "?" help toggles.
const LEVER_HELP_REASON: Record<keyof HabitLevers, string> = {
	stackedAfter: "anchoring it to a habit you already do makes the cue impossible to miss",
	craving: "tying the habit to something you already want is what pulls you into starting",
	minimumVersion: "a routine scaled down to under two minutes removes the excuse not to start",
	reward: "an immediate payoff is what makes the loop worth repeating tomorrow",
	identity: "naming who you're becoming is what actually makes a habit stick",
	linkedGoal: "connecting it to what it's actually for keeps the system pointed at something real",
};

const TYPE_INFO = {
	term: "Build vs. Break",
	definition:
		"The Four Laws of Behavior Change (make it obvious/attractive/easy/satisfying) work in reverse to break a bad habit: make it invisible, unattractive, difficult, and unsatisfying — same framework, applied backward.",
};

// The Complete Habit Formula, exactly as Clear breaks it down — one law
// per field, 1:1, grounded in this vault's own Wiki/Concepts/Four Laws of
// Behavior Change page.
const FOUR_LAWS: { law: string; stage: string; fields: string; text: string }[] = [
	{
		law: "Law 1 — Make It Obvious",
		stage: "cue",
		fields: "Cue",
		text: "Surface the cue. The environment is already set up so the cue is impossible to miss.",
	},
	{
		law: "Law 2 — Make It Attractive",
		stage: "craving",
		fields: "Craving",
		text: "The sensory or emotional pull that's directly tied to taking the action — temptation bundling.",
	},
	{
		law: "Law 3 — Make It Easy",
		stage: "response",
		fields: "Routine",
		text: "The action is scaled down to a tiny, friction-free step — takes less than two minutes.",
	},
	{
		law: "Law 4 — Make It Satisfying",
		stage: "reward",
		fields: "Reward",
		text: "The instant, visible payoff tied to completion — reinforces the loop so it repeats tomorrow.",
	},
];

// ---- AI Assistance — "Review Formula" button in the Add/Edit Habit modal.
// Sends the four Complete Habit Formula fields to the Anthropic Messages
// API in one call and gets back a critique + suggested rewrite per field,
// judged against Clear's own Four Laws (same framing as FOUR_LAWS above). ----

type FormulaFieldKey = "stackedAfter" | "craving" | "minimumVersion" | "reward";

interface FormulaReviewResult {
	critique: string;
	rewrite: string;
}

type FormulaReview = Partial<Record<FormulaFieldKey, FormulaReviewResult>>;

const FORMULA_REVIEW_SYSTEM_PROMPT = `You are a habit-design coach grounded in James Clear's Atomic Habits, specifically the Four Laws of Behavior Change. The user is filling in "The Complete Habit Formula" for a habit: "After I [Cue], I will [Routine]. [Craving]. Once done, [Reward]."

For each of the four fields they've written, judge it against its Law:
- Cue (Law 1, Make It Obvious): is the cue a specific, already-automatic moment — not vague like "in the morning"?
- Craving (Law 2, Make It Attractive): is there a real temptation-bundling pull, something they already want, tied to the habit?
- Routine (Law 3, Make It Easy): is it scaled down to under two minutes — the smallest possible version, not the aspirational full version?
- Reward (Law 4, Make It Satisfying): is the payoff immediate and tied to completion — not a delayed, someday-in-the-future outcome?

Only include a field in your response if the user actually wrote something for it (skip empty fields). For each included field, give a one-sentence critique of its concrete weakness, and one rewritten version that's stronger — concise, specific, in the user's own voice, not generic. Respond with ONLY minified JSON, no markdown fencing, no prose outside the JSON, in this exact shape:
{"stackedAfter":{"critique":"...","rewrite":"..."},"craving":{"critique":"...","rewrite":"..."},"minimumVersion":{"critique":"...","rewrite":"..."},"reward":{"critique":"...","rewrite":"..."}}
Omit keys for fields that were empty.`;

async function reviewHabitFormula(plugin: HabitTrackerPlugin, fields: Record<FormulaFieldKey, string>): Promise<FormulaReview> {
	const apiKey = plugin.settings.anthropicApiKey;
	if (!apiKey) throw new Error("No Anthropic API key set — add one in Habit Tracker settings.");

	const formulaKeys = FORMULA_KEYS as FormulaFieldKey[];
	const userContent = formulaKeys
		.filter((k) => fields[k]?.trim())
		.map((k) => `${LEVER_LABELS[k]}: ${fields[k].trim()}`)
		.join("\n");
	if (!userContent) throw new Error("Fill in at least one formula field first.");

	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: plugin.settings.anthropicModel || DEFAULT_SETTINGS.anthropicModel,
			max_tokens: 1024,
			system: FORMULA_REVIEW_SYSTEM_PROMPT,
			messages: [{ role: "user", content: userContent }],
		}),
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		const detail = response.json?.error?.message ?? response.text ?? `HTTP ${response.status}`;
		throw new Error(`Anthropic API error: ${detail}`);
	}

	const text: string = response.json?.content?.[0]?.text ?? "";
	// Claude sometimes wraps the JSON in a ```json fence or adds a stray
	// sentence around it despite the system prompt asking for bare JSON —
	// pull out the outermost {...} rather than requiring the whole
	// response to be valid JSON on its own.
	const match = text.match(/\{[\s\S]*\}/);
	try {
		return JSON.parse(match ? match[0] : text) as FormulaReview;
	} catch {
		const snippet = text.trim().slice(0, 200);
		throw new Error(`Couldn't parse the AI's response.${snippet ? ` Got: "${snippet}"` : " Got an empty response."}`);
	}
}

// ---- Cross-plugin interop with life-compass (unrelated data store, read
// directly — mirrors life-compass's own getHabitTrackerHabits(), see that
// plugin's CLAUDE.md section). ----

interface LinkedOutcomeLite {
	id: string;
	name: string;
	archived?: boolean;
}

function getLifeCompassOutcomes(app: App): LinkedOutcomeLite[] | null {
	const anyApp = app as unknown as { plugins: { plugins: Record<string, { data?: { outcomes?: LinkedOutcomeLite[] } }> } };
	return anyApp.plugins?.plugins?.["life-compass"]?.data?.outcomes ?? null;
}

// Small "?" toggle next to a Setting's name that shows/hides a definition
// + example box directly beneath it.
function addHelpToggle(setting: Setting, container: HTMLElement, term: string, definition: string, example: string) {
	const helpBtn = setting.nameEl.createSpan({ text: "?", cls: "habit-tracker-help-btn" });
	const infoBox = container.createDiv({ cls: "habit-tracker-help-box" });
	infoBox.createEl("strong", { text: term });
	infoBox.createEl("p", { text: definition });
	infoBox.createEl("p", { cls: "habit-tracker-help-example", text: `Example: "${example}"` });
	helpBtn.onclick = () => {
		infoBox.toggleClass("habit-tracker-help-box-visible", !infoBox.hasClass("habit-tracker-help-box-visible"));
	};
}

interface HabitFormOptions {
	title: string;
	submitLabel: string;
	initial?: Partial<HabitFormValues>;
	onSubmit: (values: HabitFormValues) => void;
	walkthrough?: boolean;
	// Habit-only: when present, the form shows a "Split into two occurrences"
	// panel that hands back two independent field sets (see
	// habitFieldsFromFormValues) instead of the normal single onSubmit.
	onSplit?: (originalValues: HabitFormValues, copyValues: HabitFormValues) => void | Promise<void>;
}

// Maps a completed HabitFormValues onto the subset of HabitDefinition fields
// that a plain save (or a Split copy) actually writes — id/createdAt/kind/
// archived are always handled separately by the caller. Only ever called
// for kind: "habit" (Split is habit-only).
function habitFieldsFromFormValues(values: HabitFormValues): Omit<HabitDefinition, "id" | "createdAt" | "kind" | "archived"> {
	return {
		name: values.name.trim(),
		color: values.color,
		type: values.type,
		alarmEnabled: values.alarmEnabled,
		alarmTime: values.alarmTime,
		alarmRepeatMinutes: values.alarmRepeatMinutes,
		timeOfDay: values.timeOfDay || undefined,
		// Stored only when it actually constrains something — a full week is
		// left undefined so daily habits keep the exact shape they had
		// before scheduling existed.
		scheduledDays: values.scheduledDays.length >= 7 ? undefined : [...values.scheduledDays].sort(),
		stackedAfter: values.stackedAfter.trim() || undefined,
		craving: values.craving.trim() || undefined,
		minimumVersion: values.minimumVersion.trim() || undefined,
		reward: values.reward.trim() || undefined,
		identity: values.identity.trim() || undefined,
		linkedGoal: values.linkedGoal.trim() || undefined,
	};
}

interface WalkthroughStep {
	title: string | (() => string);
	body: string | (() => string);
	target: HTMLElement;
	focusEl?: HTMLElement;
	// Evaluated fresh each time this step is about to show — lets a step
	// apply only to Habit or only to Task (e.g. Build/Break vs Scheduled
	// Date) without needing to rebuild the whole steps array once Kind is
	// picked partway through the tour.
	skipIf?: () => boolean;
}

interface WalkthroughRefs {
	nameSetting: Setting;
	nameInputEl: HTMLInputElement;
	kindSetting: Setting;
	kindSelectEl: HTMLSelectElement;
	leverElements: Partial<Record<keyof HabitLevers, { setting: Setting; textareaEl: HTMLTextAreaElement }>>;
	goalSetting: Setting;
	goalSelectEl: HTMLSelectElement;
	colorSetting: Setting;
	swatchRow: HTMLElement;
	typeSetting: Setting;
	typeSelectEl: HTMLSelectElement;
	scheduledDateSetting: Setting;
	scheduledDateInputEl: HTMLInputElement;
	commitCheckboxEl?: HTMLInputElement;
	footer: HTMLElement;
	submitBtn: HTMLButtonElement;
}

class HabitFormModal extends Modal {
	plugin: HabitTrackerPlugin;
	opts: HabitFormOptions;
	values: HabitFormValues;
	isNew: boolean;
	commitChecked = false;
	commitLabelTextEl: HTMLElement;
	walkthroughRefs?: WalkthroughRefs;

	constructor(app: App, plugin: HabitTrackerPlugin, opts: HabitFormOptions) {
		super(app);
		this.plugin = plugin;
		this.opts = opts;
		this.isNew = !opts.initial;
		this.values = {
			name: opts.initial?.name ?? "",
			color: opts.initial?.color ?? PALETTE[0],
			type: opts.initial?.type ?? "build",
			kind: opts.initial?.kind ?? "habit",
			scheduledDate: opts.initial?.scheduledDate ?? "",
			alarmEnabled: opts.initial?.alarmEnabled ?? false,
			alarmTime: opts.initial?.alarmTime ?? "20:00",
			alarmRepeatMinutes: opts.initial?.alarmRepeatMinutes ?? 10,
			timeOfDay: opts.initial?.timeOfDay ?? "",
			scheduledDays: opts.initial ? habitScheduledDays(opts.initial as HabitDefinition) : [...ALL_WEEKDAYS],
			createdAt: opts.initial?.createdAt ?? todayStr(),
			stackedAfter: opts.initial?.stackedAfter ?? "",
			craving: opts.initial?.craving ?? "",
			minimumVersion: opts.initial?.minimumVersion ?? "",
			reward: opts.initial?.reward ?? "",
			identity: opts.initial?.identity ?? "",
			linkedGoal: opts.initial?.linkedGoal ?? "",
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.createEl("h3", { text: this.opts.title });

		// Habit-only sections (Identity & Context, Type, Complete Habit
		// Formula, commit checkbox, walkthrough entry point) get hidden
		// entirely for a one-off task — none of the streak/Four-Laws
		// machinery applies to something you do once on a scheduled date.
		// Populated below as each section is built, then toggled together
		// whenever Kind changes.
		const habitOnlySections: HTMLElement[] = [];

		if (!this.opts.walkthrough) {
			const walkthroughBtn = contentEl.createEl("button", {
				text: copyText(this.plugin.settings.designCopy, "tb.walkthrough"),
				cls: "habit-tracker-walkthrough-btn habit-tracker-modal-walkthrough-btn",
			});
			walkthroughBtn.type = "button";
			walkthroughBtn.onclick = () => {
				this.opts.walkthrough = true;
				walkthroughBtn.addClass("habit-tracker-modal-walkthrough-btn-hidden");
				this.startWalkthrough(contentEl, this.walkthroughRefs!, walkthroughBtn);
			};
		}

		// Plain Enter moves focus to the next field in the form instead of
		// doing its default thing (submitting, or — in a textarea —
		// inserting a newline). Shift+Enter is the escape hatch: in fields
		// where a newline actually makes sense, it's let through instead of
		// advancing.
		const focusOrder: HTMLElement[] = [];
		const advanceOnEnter = (el: HTMLElement, allowShiftNewline = false) => {
			focusOrder.push(el);
			el.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key !== "Enter") return;
				if (allowShiftNewline && e.shiftKey) return;
				e.preventDefault();
				const next = focusOrder[focusOrder.indexOf(el) + 1];
				if (next) next.focus();
			});
		};

		const nameSetting = new Setting(contentEl).setName("Name");
		let nameInputEl: HTMLInputElement;
		nameSetting.addText((text) => {
			nameInputEl = text.inputEl;
			text
				.setPlaceholder("e.g. Morning run")
				.setValue(this.values.name)
				.onChange((value) => {
					this.values.name = value;
				});
			advanceOnEnter(text.inputEl);
		});

		const timeOfDayWrap = contentEl.createDiv({ cls: "habit-tracker-form-field-wrap" });
		habitOnlySections.push(timeOfDayWrap);
		new Setting(timeOfDayWrap)
			.setName("Time of Day")
			.setDesc('Optional — prefixes the displayed name (e.g. "Run" + Morning → "Morning Run") without changing the underlying Name field.')
			.addDropdown((dd) => {
				dd.addOption("", "— None —");
				dd.addOption("morning", "Morning");
				dd.addOption("midday", "Mid-day");
				dd.addOption("evening", "Evening");
				dd.setValue(this.values.timeOfDay);
				dd.onChange((v) => {
					this.values.timeOfDay = v as TimeOfDay | "";
				});
			});

		const scheduledDaysWrap = contentEl.createDiv({ cls: "habit-tracker-form-field-wrap" });
		habitOnlySections.push(scheduledDaysWrap);
		new Setting(scheduledDaysWrap)
			.setName("Days")
			.setDesc(
				"Which days this habit is due. Streaks count scheduled days only — Mon/Wed/Sat done three times is a 3-day streak. Miss one and an off-day unlocks to make it up (once a week)."
			);
		// A plain sibling div, not this Setting's own controlEl — Setting
		// lays its control out beside the name/description by default
		// (a narrow column of chips squeezed to the right of the paragraph),
		// where a full-width row below the description reads much better
		// for 8 chips.
		const dayChips = scheduledDaysWrap.createDiv({ cls: "habit-tracker-daypicker" });
		const chipEls: HTMLElement[] = [];
		const chipLabelEls: HTMLElement[] = [];
		let allChip: HTMLButtonElement;
		let allChipLabel: HTMLElement;
		// getDay() already matches this file's own day-index convention —
		// 0 = Sunday .. 6 = Saturday, same order as ALL_WEEKDAYS/WEEKDAY_SHORT.
		const todayWeekday = new Date().getDay();
		// A checkmark (not just the filled background already on
		// habit-tracker-daypicker-on) so a selected day reads unambiguously
		// as "checked" even at a glance, the same way a done heatmap cell
		// isn't just colored but visibly marked. Label text lives in its own
		// child span (not chip.setText on the button itself) so repainting
		// it can't wipe out today's chip's separate "Today" badge span.
		const paintChips = () => {
			chipEls.forEach((chip, day) => {
				const on = this.values.scheduledDays.includes(day);
				chip.toggleClass("habit-tracker-daypicker-on", on);
				chipLabelEls[day].setText((on ? "✓ " : "") + WEEKDAY_SHORT[day]);
			});
			const allOn = this.values.scheduledDays.length === 7;
			allChip.toggleClass("habit-tracker-daypicker-on", allOn);
			allChipLabel.setText((allOn ? "✓ " : "") + "All");
		};
		// Leftmost, in day order (All, Sun, Mon, ... Sat) — same grid, same
		// chip shape, so it reads as part of the picker rather than a
		// separate control, but a dashed border (matching the Add Habit
		// card's own "bulk action" affordance elsewhere in this plugin)
		// keeps it visually distinct from the 7 day chips it acts on. A
		// second click un-marks every day rather than just re-selecting all
		// (a plain toggle, mirroring a table's own "select all" checkbox) —
		// unlike a single day chip, this bypasses the "at least one day"
		// guard below: an empty scheduledDays already means "every day" to
		// habitScheduledDays() elsewhere, the same as all 7 explicitly
		// checked, so clearing here changes nothing about how the habit
		// actually runs, only how the picker looks mid-edit.
		allChip = dayChips.createEl("button", { cls: "habit-tracker-daypicker-chip habit-tracker-daypicker-all" });
		allChip.type = "button";
		allChip.setAttr("aria-label", "Mark or unmark every day");
		allChipLabel = allChip.createSpan();
		allChip.onclick = () => {
			this.values.scheduledDays = this.values.scheduledDays.length === 7 ? [] : [...ALL_WEEKDAYS];
			paintChips();
		};
		ALL_WEEKDAYS.forEach((day) => {
			const chip = dayChips.createEl("button", { cls: "habit-tracker-daypicker-chip" });
			chip.type = "button";
			chip.setAttr("aria-label", WEEKDAY_LONG[day] + (day === todayWeekday ? " (today)" : ""));
			// Which weekday it actually is right now — independent of
			// selection state, so it stays put whether or not that day is
			// checked. Small and out of the way (top edge of the chip), not
			// competing with the ✓/label text for the same line.
			if (day === todayWeekday) {
				chip.createSpan({ cls: "habit-tracker-daypicker-today-badge", text: "Today" });
			}
			chipLabelEls[day] = chip.createSpan();
			chip.onclick = () => {
				const on = this.values.scheduledDays.includes(day);
				// Never let the last day be turned off via an individual chip
				// — a habit due on no day at all, arrived at one accidental
				// click at a time, has no clear meaning. The All chip above
				// is the deliberate, unambiguous way to clear everything.
				if (on && this.values.scheduledDays.length === 1) {
					new Notice("A habit needs at least one day.");
					return;
				}
				this.values.scheduledDays = on
					? this.values.scheduledDays.filter((d) => d !== day)
					: [...this.values.scheduledDays, day];
				paintChips();
			};
			chipEls.push(chip);
		});
		paintChips();

		// Start date. Sits with the Days picker because the two together are
		// what decide which days this habit owes — and therefore what its
		// consistency percentage is measured against.
		const startWrap = contentEl.createDiv({ cls: "habit-tracker-form-field-wrap" });
		habitOnlySections.push(startWrap);
		new Setting(startWrap)
			.setName("Tracking since")
			.setDesc("The first day this habit counts. Consistency and streaks are measured from here — move it forward if you set the habit up too late in the day to actually do it.")
			.addText((text) => {
				text.inputEl.type = "date";
				// A future start date would leave zero days owed, which reads
				// as 0% consistency rather than "not started yet", so the
				// picker simply can't go past today.
				text.inputEl.max = todayStr();
				text.setValue(this.values.createdAt).onChange((v) => {
					if (!v) return;
					if (v > todayStr()) {
						new Notice("Tracking can't start in the future.");
						text.setValue(this.values.createdAt);
						return;
					}
					this.values.createdAt = v;
				});
			});

		let scheduledDateInputEl: HTMLInputElement;
		const scheduledDateSetting = new Setting(contentEl).setName("Scheduled date").addText((text) => {
			scheduledDateInputEl = text.inputEl;
			text.inputEl.type = "date";
			text.setValue(this.values.scheduledDate).onChange((v) => {
				this.values.scheduledDate = v;
			});
		});
		scheduledDateSetting.settingEl.addClass("habit-tracker-task-only");

		const applyKindVisibility = () => {
			const isTask = this.values.kind === "task";
			habitOnlySections.forEach((el) => el.toggleClass("habit-tracker-kind-hidden", isTask));
			scheduledDateSetting.settingEl.toggleClass("habit-tracker-kind-hidden", !isTask);
		};

		let kindSelectEl: HTMLSelectElement;
		const kindSetting = new Setting(contentEl).setName("Kind").addDropdown((dd) => {
			kindSelectEl = dd.selectEl;
			dd.addOption("habit", "Habit (recurring)");
			dd.addOption("task", "Task (one-off, scheduled)");
			dd.setValue(this.values.kind);
			dd.onChange((v) => {
				this.values.kind = v as ItemKind;
				applyKindVisibility();
				this.updateCommitLabel();
			});
		});

		// A reusable row: label (fixed, not part of any editable control —
		// can't be typed into or deleted) + auto-growing textarea (native
		// placeholder clears itself the instant that specific field is
		// typed into) + "?" help toggle.
		const leverElements: Partial<Record<keyof HabitLevers, { setting: Setting; textareaEl: HTMLTextAreaElement }>> = {};
		const renderLeverRow = (key: keyof HabitLevers, container: HTMLElement = contentEl) => {
			let textareaEl: HTMLTextAreaElement;
			const setting = new Setting(container).setName(LEVER_LABELS[key]).addTextArea((text) => {
				textareaEl = text.inputEl;
				if (this.isNew) text.setPlaceholder(EXAMPLE_LEVERS[key]);
				text.setValue(this.values[key]).onChange((v) => {
					this.values[key] = v;
					autoGrow(text.inputEl);
				});
				text.inputEl.addClass("habit-tracker-lever-input");
				text.inputEl.rows = 1;
				window.setTimeout(() => autoGrow(text.inputEl), 0);
				advanceOnEnter(text.inputEl, true);
			});
			setting.settingEl.addClass("habit-tracker-lever-setting");
			leverElements[key] = { setting, textareaEl: textareaEl! };
			const info = LEVER_TERM_INFO[key];
			addHelpToggle(setting, container, info.term, info.definition, EXAMPLE_LEVERS[key]);
		};

		const identityWrap = contentEl.createDiv();
		identityWrap.createEl("h4", { text: "Identity & Context" });
		identityWrap.createEl("p", {
			cls: "setting-item-description",
			text: "What identity is the evidence for, the cue's specifics, and what it's actually for.",
		});
		for (const key of OTHER_LEVER_KEYS) renderLeverRow(key, identityWrap);

		// Goal — picked from Life Compass's Goals (still called Outcome
		// internally in that plugin's own data model; only the UI label
		// changed) rather than typed free-text, so the link is reliable
		// instead of depending on the two plugins agreeing on spelling.
		const lifeCompassOutcomes = getLifeCompassOutcomes(this.plugin.app);
		let goalSelectEl: HTMLSelectElement;
		const goalSetting = new Setting(identityWrap).setName(LEVER_LABELS.linkedGoal).addDropdown((dd) => {
			goalSelectEl = dd.selectEl;
			dd.addOption("", "— None —");
			const currentValue = this.values.linkedGoal;
			let currentMatchesGoal = false;
			for (const o of lifeCompassOutcomes ?? []) {
				if (o.archived) continue;
				dd.addOption(o.name, o.name);
				if (o.name === currentValue) currentMatchesGoal = true;
			}
			// Preserve a pre-existing value that doesn't match any current
			// Goal by name (legacy free-text data, or Life Compass isn't
			// installed) rather than silently discarding it.
			if (currentValue && !currentMatchesGoal) {
				dd.addOption(currentValue, `${currentValue} (custom)`);
			}
			dd.setValue(currentValue);
			dd.onChange((v) => {
				this.values.linkedGoal = v;
			});
		});
		addHelpToggle(goalSetting, identityWrap, LEVER_TERM_INFO.linkedGoal.term, LEVER_TERM_INFO.linkedGoal.definition, EXAMPLE_LEVERS.linkedGoal);
		if (!lifeCompassOutcomes) {
			identityWrap.createEl("p", {
				cls: "setting-item-description",
				text: "Life Compass isn't installed/enabled — install it to pick a Goal here, or leave this on its existing custom value.",
			});
		} else if (lifeCompassOutcomes.filter((o) => !o.archived).length === 0) {
			identityWrap.createEl("p", {
				cls: "setting-item-description",
				text: "No Goals yet in Life Compass — add one there, then come back to link it.",
			});
		}

		const colorSetting = new Setting(contentEl).setName("Color");
		const swatchRow = contentEl.createDiv({ cls: "habit-tracker-swatch-row" });
		const swatches: HTMLElement[] = [];
		const deselectSwatches = () => swatches.forEach((s) => s.removeClass("habit-tracker-swatch-selected"));

		// Renders one preset/custom color circle, inserted right before the
		// color wheel + save button so newly-saved colors land next to them.
		const renderSwatch = (c: string, deletable: boolean) => {
			const swatch = swatchRow.createDiv({ cls: "habit-tracker-swatch" });
			swatch.style.backgroundColor = c;
			if (c === this.values.color) swatch.addClass("habit-tracker-swatch-selected");
			swatch.onclick = () => {
				this.values.color = c;
				deselectSwatches();
				swatch.addClass("habit-tracker-swatch-selected");
				colorWheel.value = c;
			};
			swatches.push(swatch);
			swatchRow.insertBefore(swatch, colorWheel);
			if (deletable) {
				const delBtn = swatch.createSpan({ cls: "habit-tracker-swatch-delete", text: "×" });
				delBtn.setAttr("aria-label", "Delete saved color");
				delBtn.onclick = (e) => {
					e.stopPropagation();
					this.plugin.data.customColors = this.plugin.data.customColors.filter((x) => x !== c);
					this.plugin.persist();
					swatches.splice(swatches.indexOf(swatch), 1);
					swatch.remove();
				};
			}
			return swatch;
		};

		// Full color wheel for anything the presets don't cover — a native
		// <input type="color"> opens the OS's own color picker (a real
		// wheel/spectrum) on both desktop and mobile.
		const colorWheel = swatchRow.createEl("input", { cls: "habit-tracker-color-wheel" });
		colorWheel.type = "color";
		colorWheel.value = this.values.color;
		colorWheel.setAttr("aria-label", "Custom color");
		colorWheel.oninput = () => {
			this.values.color = colorWheel.value;
			deselectSwatches();
		};

		const saveColorBtn = swatchRow.createEl("button", { cls: "habit-tracker-save-color-btn", text: "💾" });
		saveColorBtn.type = "button";
		saveColorBtn.setAttr("aria-label", "Save this color to your presets");
		saveColorBtn.onclick = () => {
			const c = colorWheel.value;
			if (PALETTE.includes(c) || this.plugin.data.customColors.includes(c)) {
				new Notice("That color is already saved.");
				return;
			}
			this.plugin.data.customColors.push(c);
			this.plugin.persist();
			renderSwatch(c, true);
		};

		PALETTE.forEach((c) => renderSwatch(c, false));
		this.plugin.data.customColors.forEach((c) => renderSwatch(c, true));

		const typeWrap = contentEl.createDiv({ cls: "habit-tracker-form-field-wrap" });
		habitOnlySections.push(typeWrap);
		let typeSelectEl: HTMLSelectElement;
		const typeSetting = new Setting(typeWrap).setName("Type").addDropdown((dd) => {
			typeSelectEl = dd.selectEl;
			dd.addOption("build", "Build (start a habit)");
			dd.addOption("break", "Break (quit a habit)");
			dd.setValue(this.values.type);
			dd.onChange((v) => {
				this.values.type = v as HabitType;
				this.updateCommitLabel();
			});
		});
		addHelpToggle(typeSetting, typeWrap, TYPE_INFO.term, TYPE_INFO.definition, "Quitting smoking = Break. Morning meditation = Build.");

		const formulaWrap = contentEl.createDiv();
		formulaWrap.createEl("h4", { text: "The Complete Habit Formula" });
		formulaWrap.createEl("p", {
			cls: "setting-item-description",
			text: 'Clear\'s own structure, one field per Law: "After I [Cue], I will [Routine]. [Craving]. Once done, [Reward]."',
		});

		// Toggleable panel mapping each field to its specific Law.
		const fourLawsToggle = formulaWrap.createDiv({
			cls: "habit-tracker-fourlaws-toggle",
			text: "📖 How this maps to the 4 Laws of Behavior Change",
		});
		const fourLawsBox = formulaWrap.createDiv({ cls: "habit-tracker-fourlaws-box" });
		for (const item of FOUR_LAWS) {
			const row = fourLawsBox.createDiv({ cls: "habit-tracker-fourlaws-row" });
			const heading = row.createDiv({ cls: "habit-tracker-fourlaws-heading" });
			heading.createSpan({ text: item.law, cls: "habit-tracker-fourlaws-law" });
			heading.createSpan({ text: `(${item.stage})`, cls: "habit-tracker-fourlaws-stage" });
			heading.createSpan({ text: `→ ${item.fields}`, cls: "habit-tracker-fourlaws-fields" });
			row.createEl("p", { text: item.text });
		}
		fourLawsToggle.onclick = () => {
			fourLawsBox.toggleClass("habit-tracker-fourlaws-box-visible", !fourLawsBox.hasClass("habit-tracker-fourlaws-box-visible"));
		};

		for (const key of FORMULA_KEYS) renderLeverRow(key, formulaWrap);

		if (this.plugin.settings.anthropicApiKey) {
			const reviewBtn = formulaWrap.createEl("button", {
				text: "✨ Review Formula",
				cls: "habit-tracker-review-formula-btn",
			});
			reviewBtn.type = "button";
			const reviewResultsEl = formulaWrap.createDiv({ cls: "habit-tracker-review-results" });
			reviewBtn.onclick = async () => {
				reviewBtn.disabled = true;
				const originalLabel = reviewBtn.textContent;
				reviewBtn.textContent = "Reviewing…";
				reviewResultsEl.empty();
				try {
					const fields = {
						stackedAfter: this.values.stackedAfter,
						craving: this.values.craving,
						minimumVersion: this.values.minimumVersion,
						reward: this.values.reward,
					};
					const review = await reviewHabitFormula(this.plugin, fields);
					const reviewedKeys = FORMULA_KEYS.filter((k) => review[k]);
					if (reviewedKeys.length === 0) {
						reviewResultsEl.createEl("p", {
							cls: "setting-item-description",
							text: "Fill in at least one formula field, then try again.",
						});
					}
					for (const key of reviewedKeys) {
						const result = review[key]!;
						const card = reviewResultsEl.createDiv({ cls: "habit-tracker-review-card" });
						card.createEl("strong", { text: LEVER_LABELS[key] });
						card.createEl("p", { cls: "habit-tracker-review-critique", text: result.critique });
						card.createEl("p", { cls: "habit-tracker-review-rewrite", text: `"${result.rewrite}"` });
						const actions = card.createDiv({ cls: "habit-tracker-review-actions" });
						const useBtn = actions.createEl("button", { text: "Use this" });
						useBtn.type = "button";
						useBtn.onclick = () => {
							this.values[key] = result.rewrite;
							const el = leverElements[key]!.textareaEl;
							el.value = result.rewrite;
							autoGrow(el);
							card.remove();
						};
						const dismissBtn = actions.createEl("button", { text: "Dismiss" });
						dismissBtn.type = "button";
						dismissBtn.onclick = () => card.remove();
					}
				} catch (e) {
					reviewResultsEl.createEl("p", {
						cls: "setting-item-description",
						text: e instanceof Error ? e.message : "Something went wrong reviewing your formula.",
					});
				} finally {
					reviewBtn.disabled = false;
					reviewBtn.textContent = originalLabel;
				}
			};
		}

		// Per-habit check-in alarm — habit-only (hidden for a task, same as
		// Type above), since the firing condition is "not checked in today,"
		// which isn't meaningful for a one-off scheduled item.
		const alarmWrap = contentEl.createDiv();
		habitOnlySections.push(alarmWrap);
		alarmWrap.createEl("h4", { text: "Check-in Alarm" });
		alarmWrap.createEl("p", {
			cls: "setting-item-description",
			text: "Once the alarm time passes local time with this habit not yet checked in today, nag (sound + banner) every few minutes until it is.",
		});
		new Setting(alarmWrap).setName("Enable alarm").addToggle((toggle) =>
			toggle.setValue(this.values.alarmEnabled).onChange((value) => {
				this.values.alarmEnabled = value;
			})
		);
		new Setting(alarmWrap)
			.setName("Alarm time")
			.setDesc("24-hour local time (HH:MM).")
			.addText((text) => {
				text.inputEl.type = "time";
				text.setValue(this.values.alarmTime).onChange((value) => {
					// A native time input only ever emits valid HH:MM (or
					// empty while mid-edit) — ignore anything else rather
					// than storing a half-typed value.
					if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
					this.values.alarmTime = value;
				});
			});
		new Setting(alarmWrap)
			.setName("Repeat every (minutes)")
			.setDesc("How often to re-nag once the alarm time has passed and it's still not checked in.")
			.addText((text) =>
				text.setValue("" + this.values.alarmRepeatMinutes).onChange((value) => {
					const n = parseInt(value, 10);
					if (!Number.isFinite(n) || n <= 0) return;
					this.values.alarmRepeatMinutes = n;
				})
			);

		let commitCheckboxEl: HTMLInputElement | undefined;
		if (this.isNew) {
			const commitWrap = contentEl.createDiv();
			// Wrapping the checkbox and text in a single <label> makes the
			// whole row clickable, not just the small checkbox itself.
			const commitRow = commitWrap.createEl("label", { cls: "habit-tracker-commit-row" });
			const commitCheckbox = commitRow.createEl("input", { cls: "habit-tracker-commit-checkbox" });
			commitCheckboxEl = commitCheckbox;
			commitCheckbox.type = "checkbox";
			commitCheckbox.checked = this.commitChecked;
			commitCheckbox.onchange = () => {
				this.commitChecked = commitCheckbox.checked;
			};
			advanceOnEnter(commitCheckbox);
			this.commitLabelTextEl = commitRow.createSpan();
			this.updateCommitLabel();
		}

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const submitBtn = footer.createEl("button", { text: this.opts.submitLabel, cls: "mod-cta" });
		submitBtn.onclick = () => this.submit();
		focusOrder.push(submitBtn);

		// Split — habit-only (hidden for a task, same as every other section
		// pushed onto habitOnlySections), and only offered at all when the
		// caller wired onSplit (both habit call sites do; task-edit doesn't).
		// Inline toggle/panel, not a chained second modal — matches the
		// fourLawsToggle/-Box precedent above rather than inventing new
		// modal-within-modal plumbing.
		if (this.opts.onSplit) {
			const splitWrap = contentEl.createDiv();
			habitOnlySections.push(splitWrap);
			const splitToggle = splitWrap.createDiv({
				cls: "habit-tracker-split-toggle",
				text: "🪓 Split into two occurrences",
			});
			const splitPanel = splitWrap.createDiv({ cls: "habit-tracker-split-panel" });
			splitPanel.createEl("p", {
				cls: "setting-item-description",
				text: "Creates a fully independent copy of this habit with its own streak — useful when the same habit happens at two different times of day with different cues (e.g. a morning and an evening meditation).",
			});

			let splitTriggerEl: HTMLTextAreaElement;
			new Setting(splitPanel)
				.setName("New Cue for the copy")
				.setDesc('Required — the copy starts with a blank Cue since "After I ___" is usually different for the second occurrence.')
				.addTextArea((text) => {
					splitTriggerEl = text.inputEl;
					autoGrow(text.inputEl);
					text.inputEl.addEventListener("input", () => autoGrow(text.inputEl));
				});

			let splitTimeOfDayOriginal: TimeOfDay | "" = this.values.timeOfDay || "morning";
			new Setting(splitPanel)
				.setName("Time of Day (this one)")
				.addDropdown((dd) => {
					dd.addOption("", "— None —");
					dd.addOption("morning", "Morning");
					dd.addOption("midday", "Mid-day");
					dd.addOption("evening", "Evening");
					dd.setValue(splitTimeOfDayOriginal);
					dd.onChange((v) => {
						splitTimeOfDayOriginal = v as TimeOfDay | "";
					});
				});

			let splitTimeOfDayCopy: TimeOfDay | "" = "evening";
			new Setting(splitPanel)
				.setName("Time of Day (the copy)")
				.addDropdown((dd) => {
					dd.addOption("", "— None —");
					dd.addOption("morning", "Morning");
					dd.addOption("midday", "Mid-day");
					dd.addOption("evening", "Evening");
					dd.setValue(splitTimeOfDayCopy);
					dd.onChange((v) => {
						splitTimeOfDayCopy = v as TimeOfDay | "";
					});
				});

			const splitBtn = splitPanel.createEl("button", { text: "Create split", cls: "mod-cta" });
			splitBtn.type = "button";
			splitBtn.onclick = async () => {
				if (this.isNew && !this.validateRequiredFields()) return;
				const copyTrigger = splitTriggerEl.value.trim();
				if (!copyTrigger) {
					new Notice('Fill out "New Cue for the copy" first.');
					return;
				}
				if (splitTimeOfDayOriginal === splitTimeOfDayCopy) {
					new Notice("Time of Day for this one and the copy must be different.");
					return;
				}
				const originalValues: HabitFormValues = { ...this.values, timeOfDay: splitTimeOfDayOriginal };
				const copyValues: HabitFormValues = { ...this.values, timeOfDay: splitTimeOfDayCopy, stackedAfter: copyTrigger };
				await this.opts.onSplit!(originalValues, copyValues);
				this.close();
			};

			splitToggle.onclick = () => {
				splitPanel.toggleClass("habit-tracker-split-panel-visible", !splitPanel.hasClass("habit-tracker-split-panel-visible"));
			};
		}

		applyKindVisibility();

		this.walkthroughRefs = {
			nameSetting,
			nameInputEl,
			kindSetting,
			kindSelectEl,
			leverElements,
			goalSetting,
			goalSelectEl,
			colorSetting,
			swatchRow,
			typeSetting,
			typeSelectEl,
			scheduledDateSetting,
			scheduledDateInputEl,
			commitCheckboxEl,
			footer,
			submitBtn,
		};
		if (this.opts.walkthrough) this.startWalkthrough(contentEl, this.walkthroughRefs);

		window.setTimeout(() => nameInputEl?.focus(), 0);
	}

	// A guided, spotlight-and-tooltip tour through the form, used for a
	// user's very first habit (or whenever they click "Habit Creation
	// Walkthrough"). Each step highlights one field and explains it in
	// plain language; the tour advances either via the tooltip's own
	// Next/Back buttons, or naturally by the user filling out/selecting
	// that step's field directly (typing + Enter/Tab away, picking a
	// color, choosing Build/Break, checking the commit box).
	startWalkthrough(contentEl: HTMLElement, refs: WalkthroughRefs, restartBtn?: HTMLElement) {
		const lever = (key: keyof HabitLevers) => refs.leverElements[key]!;
		const isTask = () => this.values.kind === "task";
		const steps: WalkthroughStep[] = [
			{
				title: copyText(this.plugin.settings.designCopy, "wt.nameTitle"),
				body: copyText(this.plugin.settings.designCopy, "wt.nameBody"),
				target: refs.nameSetting.settingEl,
				focusEl: refs.nameInputEl,
			},
			{
				title: copyText(this.plugin.settings.designCopy, "wt.kindTitle"),
				body: copyText(this.plugin.settings.designCopy, "wt.kindBody"),
				target: refs.kindSetting.settingEl,
				focusEl: refs.kindSelectEl,
			},
			{
				title: LEVER_TERM_INFO.identity.term,
				body: copyText(this.plugin.settings.designCopy, "wt.identityBody", { example: EXAMPLE_LEVERS.identity }),
				target: lever("identity").setting.settingEl,
				focusEl: lever("identity").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.linkedGoal.term,
				body: () => copyText(this.plugin.settings.designCopy, isTask() ? "wt.goalBodyTask" : "wt.goalBodyHabit"),
				target: refs.goalSetting.settingEl,
				focusEl: refs.goalSelectEl,
			},
			{
				title: copyText(this.plugin.settings.designCopy, "wt.colorTitle"),
				body: copyText(this.plugin.settings.designCopy, "wt.colorBody"),
				target: refs.swatchRow,
			},
			{
				title: TYPE_INFO.term,
				body: copyText(this.plugin.settings.designCopy, "wt.typeBody"),
				target: refs.typeSetting.settingEl,
				focusEl: refs.typeSelectEl,
				skipIf: isTask,
			},
			{
				title: copyText(this.plugin.settings.designCopy, "wt.dateTitle"),
				body: copyText(this.plugin.settings.designCopy, "wt.dateBody"),
				target: refs.scheduledDateSetting.settingEl,
				focusEl: refs.scheduledDateInputEl,
				skipIf: () => !isTask(),
			},
			{
				title: LEVER_TERM_INFO.stackedAfter.term,
				body: () => copyText(this.plugin.settings.designCopy, isTask() ? "wt.cueBodyTask" : "wt.cueBodyHabit", { example: EXAMPLE_LEVERS.stackedAfter }),
				target: lever("stackedAfter").setting.settingEl,
				focusEl: lever("stackedAfter").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.craving.term,
				body: copyText(this.plugin.settings.designCopy, "wt.cravingBody", { example: EXAMPLE_LEVERS.craving }),
				target: lever("craving").setting.settingEl,
				focusEl: lever("craving").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.minimumVersion.term,
				body: copyText(this.plugin.settings.designCopy, "wt.routineBody", { example: EXAMPLE_LEVERS.minimumVersion }),
				target: lever("minimumVersion").setting.settingEl,
				focusEl: lever("minimumVersion").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.reward.term,
				body: () => copyText(this.plugin.settings.designCopy, isTask() ? "wt.rewardBodyTask" : "wt.rewardBodyHabit", { example: EXAMPLE_LEVERS.reward }),
				target: lever("reward").setting.settingEl,
				focusEl: lever("reward").textareaEl,
			},
		];

		if (refs.commitCheckboxEl) {
			steps.push({
				title: copyText(this.plugin.settings.designCopy, "wt.commitTitle"),
				body: () => {
					const verb = isTask() ? "completing" : this.values.type === "break" ? "breaking" : "building";
					const subject = isTask() ? "this task" : "this habit";
					return copyText(this.plugin.settings.designCopy, "wt.commitBody", { verb, subject });
				},
				target: (refs.commitCheckboxEl.closest("label") as HTMLElement) ?? refs.commitCheckboxEl,
				focusEl: refs.commitCheckboxEl,
			});
		}

		steps.push({
			title: () => copyText(this.plugin.settings.designCopy, isTask() ? "wt.finishTitleTask" : "wt.finishTitleHabit"),
			body: () => copyText(this.plugin.settings.designCopy, isTask() ? "wt.finishBodyTask" : "wt.finishBodyHabit"),
			target: refs.footer,
			focusEl: refs.submitBtn,
		});

		const tooltip = contentEl.createDiv({ cls: "habit-tracker-walkthrough-tooltip" });
		const progressEl = tooltip.createDiv({ cls: "habit-tracker-walkthrough-progress" });
		const titleEl = tooltip.createEl("strong", { cls: "habit-tracker-walkthrough-title" });
		const bodyEl = tooltip.createEl("p", { cls: "habit-tracker-walkthrough-body" });
		const btnRow = tooltip.createDiv({ cls: "habit-tracker-walkthrough-btns" });
		const skipBtn = btnRow.createEl("button", { text: copyText(this.plugin.settings.designCopy, "wt.skip"), cls: "habit-tracker-walkthrough-skip" });
		const backBtn = btnRow.createEl("button", { text: copyText(this.plugin.settings.designCopy, "wt.back") });
		const nextBtn = btnRow.createEl("button", { text: copyText(this.plugin.settings.designCopy, "wt.next"), cls: "mod-cta" });
		skipBtn.type = "button";
		backBtn.type = "button";
		nextBtn.type = "button";

		let stepIndex = 0;
		let active = true;

		const positionTooltip = (target: HTMLElement) => {
			const contentRect = contentEl.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			// Target position in contentEl's scroll coordinate space.
			const targetTop = targetRect.top - contentRect.top + contentEl.scrollTop;
			const targetBottom = targetRect.bottom - contentRect.top + contentEl.scrollTop;

			const maxLeft = Math.max(0, contentEl.clientWidth - tooltip.offsetWidth);
			const left = Math.min(Math.max(0, targetRect.left - contentRect.left), maxLeft);

			// Flip above when placing below would run past the bottom of the
			// visible form and there's room overhead. Without this the tooltip
			// always went below, which on late steps forced contentEl to grow
			// its padding and scroll the field up toward the top edge — the
			// user ended up reading a tooltip whose field had drifted away.
			const gap = 12;
			const wouldOverflow = targetBottom + gap + tooltip.offsetHeight > contentEl.scrollTop + contentEl.clientHeight;
			const roomAbove = targetTop - contentEl.scrollTop > tooltip.offsetHeight + gap;
			const placeAbove = wouldOverflow && roomAbove;

			const top = placeAbove ? targetTop - tooltip.offsetHeight - gap : targetBottom + gap;
			tooltip.style.top = `${top}px`;
			tooltip.style.left = `${left}px`;
			tooltip.toggleClass("habit-tracker-walkthrough-tooltip-above", placeAbove);

			// Point the arrow at the target rather than just sitting under it.
			// Offset is measured from the tooltip's own left edge, clamped so
			// the arrow never slides off its corners (which happens when the
			// tooltip is pushed left by maxLeft but the target is far right).
			const targetCenter = targetRect.left - contentRect.left + Math.min(targetRect.width / 2, 90);
			const arrowX = Math.min(Math.max(targetCenter - left, 16), Math.max(16, tooltip.offsetWidth - 26));
			tooltip.style.setProperty("--wt-arrow-x", `${arrowX}px`);

			// Only the below-placement can overflow the form's scrollable
			// height — when flipped above, the tooltip sits over existing
			// content and needs no extra room. The tooltip is position:
			// absolute, so on a step near the bottom its true bottom edge can
			// sit past contentEl's normal-flow content height;
			// contentEl.scrollHeight doesn't reliably grow to include it, so
			// scrolling alone would leave it clipped by the modal's edge with
			// nowhere further to scroll. Force real scrollable room to exist.
			if (placeAbove) return;
			const tooltipBottom = top + tooltip.offsetHeight + 16;
			if (tooltipBottom > contentEl.scrollHeight) {
				contentEl.style.paddingBottom = `${tooltipBottom - contentEl.scrollHeight + parseFloat(contentEl.style.paddingBottom || "0")}px`;
			}
			const maxScrollTop = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
			const wantedScrollTop = Math.min(maxScrollTop, tooltipBottom - contentEl.clientHeight);
			if (wantedScrollTop > contentEl.scrollTop) {
				contentEl.scrollTo({ top: wantedScrollTop, behavior: "smooth" });
			}
		};

		const endWalkthrough = () => {
			active = false;
			steps.forEach((s) => {
				s.target.removeClass("habit-tracker-walkthrough-highlight");
				// Must clear too, or the last step's input keeps its bright
				// ring for the rest of the modal's life.
				s.focusEl?.removeClass("habit-tracker-walkthrough-focus");
			});
			contentEl.removeClass("habit-tracker-walkthrough-active");
			contentEl.style.paddingBottom = "";
			tooltip.remove();
			// Bring the "Habit Creation Walkthrough" button back (whether the
			// tour was skipped or finished) so the user can restart it
			// later instead of it being gone for the rest of the session.
			restartBtn?.removeClass("habit-tracker-modal-walkthrough-btn-hidden");
		};

		// direction controls which way to keep looking when landing on a
		// skipped step (e.g. Type is skipped for a Task, Scheduled Date is
		// skipped for a Habit) — Next skips forward, Back skips backward, so
		// neither button ever gets stuck bouncing on a step that doesn't
		// apply to the current Kind.
		const showStep = (i: number, direction: 1 | -1 = 1) => {
			if (!active) return;
			while (i >= 0 && i < steps.length && steps[i].skipIf?.()) i += direction;
			if (i >= steps.length) {
				endWalkthrough();
				return;
			}
			if (i < 0) return;
			stepIndex = i;
			const step = steps[stepIndex];
			steps.forEach((s) => {
				s.target.removeClass("habit-tracker-walkthrough-highlight");
				s.focusEl?.removeClass("habit-tracker-walkthrough-focus");
			});
			step.target.addClass("habit-tracker-walkthrough-highlight");
			// Tier two of the emphasis: the row gets the spotlight, the input
			// inside it gets its own bright ring, so "this section" and "type
			// in this box" read as different things. Steps without a focusEl
			// (Color, whose target is the swatch row itself) just get the row.
			step.focusEl?.addClass("habit-tracker-walkthrough-focus");
			progressEl.setText(`Step ${stepIndex + 1} of ${steps.length}`);
			titleEl.setText(typeof step.title === "function" ? step.title() : step.title);
			bodyEl.setText(typeof step.body === "function" ? step.body() : step.body);
			backBtn.style.visibility = stepIndex === 0 ? "hidden" : "visible";
			nextBtn.setText(stepIndex === steps.length - 1 ? "Got it" : "Next");
			// While scrollIntoView's smooth scroll (and the 150ms wait for it
			// to settle) is in flight, the tooltip is still sitting at its
			// OLD screen position — a click landing in that window can miss
			// whichever button the user actually meant to hit. Make it
			// non-interactive/dimmed for that brief stretch instead of
			// leaving it clickable in a stale spot.
			tooltip.addClass("habit-tracker-walkthrough-tooltip-repositioning");
			step.target.scrollIntoView({ block: "center", behavior: "smooth" });
			window.setTimeout(() => {
				positionTooltip(step.target);
				tooltip.removeClass("habit-tracker-walkthrough-tooltip-repositioning");
				step.focusEl?.focus();
			}, 150);
		};

		skipBtn.onclick = (e) => {
			e.stopPropagation();
			endWalkthrough();
		};
		backBtn.onclick = (e) => {
			e.stopPropagation();
			showStep(stepIndex - 1, -1);
		};
		nextBtn.onclick = (e) => {
			e.stopPropagation();
			showStep(stepIndex + 1, 1);
		};

		// Following along by typing/clicking/pressing Enter in the actual
		// fields advances the tour too, not just the Next button — so the
		// tooltip tracks whichever way the user chooses to move.
		const bindAdvance = (el: HTMLElement | undefined, type: string, index: number, predicate?: () => boolean) => {
			if (!el || index < 0) return;
			el.addEventListener(type, (e: Event) => {
				if (!active || stepIndex !== index) return;
				// Defensive: only meaningful for focus-type events, and
				// nothing currently binds one (text fields advance on Enter
				// instead — see the keydown handler below). Kept because it
				// guards a subtle ordering bug if a blur binding is ever
				// added back: blur fires the instant the user mousedowns on
				// Skip/Back/Next, BEFORE that button's own click handler, so
				// without this the tour would scroll toward the next field a
				// beat before endWalkthrough() tears it down — reading like
				// "Skip advanced a step" rather than closing.
				const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
				if (related === skipBtn || related === backBtn || related === nextBtn) return;
				if (predicate && !predicate()) return;
				showStep(index + 1);
			});
		};

		// Text fields advance on Enter, never on blur.
		//
		// Blur used to advance whenever the field was non-empty, which meant
		// clicking anywhere — empty space, another field, the form background
		// — counted as "done with this step". Combined with the walkthrough's
		// interaction gate that left users locked out of the text they had
		// just typed. Enter is an unambiguous "I'm finished with this field";
		// merely looking away is not, so blur is deliberately inert now and
		// clicking off and back on a field is a no-op for the tour.
		//
		// The lever fields are textareas that auto-grow, so Enter would
		// otherwise insert a newline. preventDefault() keeps it as a commit
		// key; Shift+Enter still inserts a real newline for multi-line notes.
		steps.forEach((step, i) => {
			const el = step.focusEl;
			const isText = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox");
			if (!isText) return;
			const field = el as HTMLTextAreaElement | HTMLInputElement;
			field.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key !== "Enter" || e.shiftKey) return;
				if (!active || stepIndex !== i) return;
				if (field.value.trim().length === 0) return;
				e.preventDefault();
				showStep(i + 1);
			});
		});

		// Clicking into any field re-syncs the tour to that step, so the
		// spotlight follows the user instead of stranding them somewhere
		// else in the form. Guarded on stepIndex so re-focusing the current
		// field (the common case, after clicking away and back) does nothing.
		steps.forEach((step, i) => {
			step.focusEl?.addEventListener("focus", () => {
				if (!active || stepIndex === i) return;
				showStep(i);
			});
		});
		bindAdvance(
			refs.swatchRow,
			"click",
			steps.findIndex((s) => s.target === refs.swatchRow)
		);
		bindAdvance(
			refs.typeSelectEl,
			"change",
			steps.findIndex((s) => s.focusEl === refs.typeSelectEl)
		);
		bindAdvance(
			refs.kindSelectEl,
			"change",
			steps.findIndex((s) => s.focusEl === refs.kindSelectEl)
		);
		bindAdvance(
			refs.goalSelectEl,
			"change",
			steps.findIndex((s) => s.focusEl === refs.goalSelectEl)
		);
		if (refs.commitCheckboxEl) {
			const commitEl = refs.commitCheckboxEl;
			bindAdvance(
				commitEl,
				"change",
				steps.findIndex((s) => s.focusEl === commitEl),
				() => commitEl.checked
			);
		}

		contentEl.addClass("habit-tracker-walkthrough-active");
		// A short delay before the very first step, so scrollIntoView's
		// measurements land after Obsidian's modal-open animation has
		// settled instead of mid-transition (where the modal's own size/
		// position is still changing, throwing off where "the field" is).
		window.setTimeout(() => showStep(0), 50);
	}

	updateCommitLabel() {
		if (!this.commitLabelTextEl) return;
		if (this.values.kind === "task") {
			this.commitLabelTextEl.setText("I commit to completing this task");
			return;
		}
		const verb = this.values.type === "break" ? "breaking" : "building";
		this.commitLabelTextEl.setText(`I commit to ${verb} this habit`);
	}

	// Shared by submit() (always) and the Split panel's confirm handler (only
	// when this.isNew — an existing habit being edited gets no extra gate
	// beyond what editing already requires). Shows the same Notice submit()
	// always has on failure; returns whether validation passed.
	validateRequiredFields(): boolean {
		if (!this.values.name.trim()) {
			new Notice(this.values.kind === "task" ? "Task needs a name." : "Habit needs a name.");
			return false;
		}
		const isTask = this.values.kind === "task";
		if (isTask && !this.values.scheduledDate) {
			new Notice("Pick a scheduled date for this task.");
			return false;
		}
		if (this.isNew) {
			const verb = isTask ? "completing" : this.values.type === "break" ? "breaking" : "building";
			const subject = isTask ? "this task" : "this habit";
			for (const key of [...FORMULA_KEYS, ...OTHER_LEVER_KEYS]) {
				if (!this.values[key].trim()) {
					new Notice(`Fill out "${LEVER_LABELS[key]}" — ${LEVER_HELP_REASON[key]}, which will help you with ${verb} ${subject}.`);
					return false;
				}
			}
			if (!this.values.linkedGoal.trim()) {
				new Notice(`Pick a "${LEVER_LABELS.linkedGoal}" — ${LEVER_HELP_REASON.linkedGoal}, which will help you with ${verb} ${subject}.`);
				return false;
			}
			if (!this.commitChecked) {
				new Notice(`Check "I commit to ${verb} ${subject}" to continue.`);
				return false;
			}
		}
		return true;
	}

	submit() {
		if (!this.validateRequiredFields()) return;
		const name = this.values.name.trim();
		this.opts.onSubmit({
			...this.values,
			name,
			identity: this.values.identity.trim(),
			stackedAfter: this.values.stackedAfter.trim(),
			craving: this.values.craving.trim(),
			minimumVersion: this.values.minimumVersion.trim(),
			reward: this.values.reward.trim(),
			linkedGoal: this.values.linkedGoal.trim(),
		});
		if (this.opts.walkthrough && this.isNew) {
			this.showCongrats(name);
		} else {
			this.close();
		}
	}

	// Shown in place of closing immediately, only when the habit was just
	// created via the walkthrough — the one moment it's worth pausing on
	// before handing the user back to the tracker.
	showCongrats(habitName: string) {
		const { contentEl } = this;
		const isTask = this.values.kind === "task";
		contentEl.empty();
		contentEl.addClass("habit-tracker-walkthrough-congrats");
		contentEl.createEl("h3", { text: copyText(this.plugin.settings.designCopy, isTask ? "ms.firstTaskTitle" : "ms.firstTitle") });
		contentEl.createEl("p", {
			text: isTask
				? copyText(this.plugin.settings.designCopy, "ms.firstTaskBody", { habit: habitName, date: this.values.scheduledDate })
				: copyText(this.plugin.settings.designCopy, "ms.firstBody", { habit: habitName }),
		});
		contentEl.createEl("p", {
			text: copyText(this.plugin.settings.designCopy, isTask ? "ms.firstTaskBody2" : "ms.firstBody2"),
		});
		const doneBtn = contentEl.createEl("button", { text: copyText(this.plugin.settings.designCopy, "ms.firstCta"), cls: "mod-cta" });
		doneBtn.type = "button";
		doneBtn.onclick = () => this.close();
		window.setTimeout(() => doneBtn.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Fired once per day (habits) or once per scheduled date (tasks) — see
// HabitTrackerPlugin.maybeCelebrateAllHabitsDoneToday/
// maybeCelebrateAllTasksDoneForDate — the moment every item tracked for
// that day is checked off, not just an individual streak/task.
class DailyCongratsModal extends Modal {
	kind: "habits" | "tasks";
	count: number;
	date?: string;

	plugin: HabitTrackerPlugin;

	constructor(plugin: HabitTrackerPlugin, kind: "habits" | "tasks", count: number, date?: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.kind = kind;
		this.count = count;
		this.date = date;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.addClass("habit-tracker-walkthrough-congrats");
		const isTasks = this.kind === "tasks";
		const plural = this.count === 1 ? "" : "s";
		contentEl.createEl("h3", { text: copyText(this.plugin.settings.designCopy, isTasks ? "ms.allTasksTitle" : "ms.allHabitsTitle") });
		contentEl.createEl("p", {
			text: isTasks
				? copyText(this.plugin.settings.designCopy, "ms.allTasksBody", { count: this.count, plural, date: this.date ?? "" })
				: copyText(this.plugin.settings.designCopy, "ms.allHabitsBody", { count: this.count, plural }),
		});
		const doneBtn = contentEl.createEl("button", { text: copyText(this.plugin.settings.designCopy, "ms.allCta"), cls: "mod-cta" });
		doneBtn.type = "button";
		doneBtn.onclick = () => this.close();
		window.setTimeout(() => doneBtn.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Below this many logged entries, a habit's history is treated as
// "meaningful" — deleting it destroys a real record, not a false start —
// and the modal requires typing the name back rather than a single click.
// A brand-new habit with a handful of check-ins stays a quick one-click
// delete; that friction asymmetry (vs. the settings-tab history reset,
// which always requires typed confirmation regardless of size) was a
// design-review finding: the *more* destructive action had *less*
// friction than the less destructive one.
const DELETE_CONFIRM_TYPED_THRESHOLD = 7;

class ConfirmDeleteModal extends Modal {
	habitName: string;
	entryCount: number;
	onConfirm: () => void;

	plugin: HabitTrackerPlugin;

	constructor(plugin: HabitTrackerPlugin, habitName: string, entryCount: number, onConfirm: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.habitName = habitName;
		this.entryCount = entryCount;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.createEl("h3", { text: copyText(this.plugin.settings.designCopy, "st.deleteTitle") });
		contentEl.createEl("p", {
			text: copyText(this.plugin.settings.designCopy, "st.deleteBody", { name: this.habitName }),
		});

		const needsTypedConfirm = this.entryCount >= DELETE_CONFIRM_TYPED_THRESHOLD;
		let confirmInput: HTMLInputElement | undefined;
		let deleteBtn: HTMLButtonElement;

		if (needsTypedConfirm) {
			contentEl.createEl("p", {
				cls: "habit-tracker-settings-label",
				text: copyText(this.plugin.settings.designCopy, "st.deleteConfirm", { n: this.entryCount }),
			});
			confirmInput = contentEl.createEl("input", {
				type: "text",
				placeholder: this.habitName,
				cls: "habit-tracker-reset-confirm-input",
			});
		}

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const cancelBtn = footer.createEl("button", { text: copyText(this.plugin.settings.designCopy, "st.deleteCancel") });
		cancelBtn.onclick = () => this.close();
		deleteBtn = footer.createEl("button", { text: copyText(this.plugin.settings.designCopy, "st.deleteConfirmBtn"), cls: "mod-warning" });
		deleteBtn.disabled = needsTypedConfirm;
		if (confirmInput) {
			confirmInput.addEventListener("input", () => {
				deleteBtn.disabled = confirmInput!.value !== this.habitName;
			});
		}
		deleteBtn.onclick = () => {
			if (needsTypedConfirm && confirmInput?.value !== this.habitName) return;
			this.onConfirm();
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Archiving isn't destructive (history/streak are kept, restorable anytime
// via ↩️), so unlike ConfirmDeleteModal above there's no entry-count
// threshold — typing "Archive" is always required, a fixed word rather than
// the habit's own name, so it can't be satisfied by accidentally pasting the
// name from somewhere else.
class ConfirmArchiveModal extends Modal {
	habitName: string;
	onConfirm: () => void;
	plugin: HabitTrackerPlugin;

	constructor(plugin: HabitTrackerPlugin, habitName: string, onConfirm: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.habitName = habitName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.createEl("h3", { text: copyText(this.plugin.settings.designCopy, "st.archiveTitle") });
		contentEl.createEl("p", {
			text: copyText(this.plugin.settings.designCopy, "st.archiveBody", { name: this.habitName }),
		});
		contentEl.createEl("p", {
			cls: "habit-tracker-settings-label",
			text: copyText(this.plugin.settings.designCopy, "st.archiveConfirm"),
		});
		const confirmInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "Archive",
			cls: "habit-tracker-reset-confirm-input",
		});

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const cancelBtn = footer.createEl("button", { text: copyText(this.plugin.settings.designCopy, "st.archiveCancel") });
		cancelBtn.onclick = () => this.close();
		const archiveBtn = footer.createEl("button", {
			text: copyText(this.plugin.settings.designCopy, "st.archiveConfirmBtn"),
			cls: "mod-warning",
		});
		archiveBtn.disabled = true;
		confirmInput.addEventListener("input", () => {
			archiveBtn.disabled = confirmInput.value !== "Archive";
		});
		archiveBtn.onclick = () => {
			if (confirmInput.value !== "Archive") return;
			this.onConfirm();
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---- Design Tweaks panel ----
// A floating, draggable overlay (not a Modal) on purpose: a modal would
// cover the tracker and gate interaction behind a backdrop, and the whole
// point is watching real cards change under the slider you're dragging.
// Appended to document.body so it survives block re-renders and floats
// above whatever pane the tracker is in.
class TweakPanel {
	plugin: HabitTrackerPlugin;
	el: HTMLElement;
	// Working copy. Only committed to settings on Save, so experimenting
	// never persists by accident — but it IS applied live, so what you see
	// is always the working copy, not the saved one.
	draft: Record<string, string>;
	// Copy overrides get their own draft. Unlike design tokens (which are
	// pure CSS and repaint for free), changing a string requires a real
	// re-render, so these two are applied by different paths — see
	// applyLive() vs applyCopyLive().
	copyDraft: Record<string, string>;
	private onKeydown: (e: KeyboardEvent) => void;
	private static openInstance: TweakPanel | null = null;

	// What was persisted when the panel opened. close() restores this so an
	// unsaved copy experiment doesn't survive; Save refreshes it.
	private savedCopySnapshot: Record<string, string>;

	constructor(plugin: HabitTrackerPlugin) {
		this.plugin = plugin;
		this.draft = { ...plugin.settings.designTweaks };
		this.copyDraft = { ...plugin.settings.designCopy };
		this.savedCopySnapshot = { ...plugin.settings.designCopy };
	}

	static toggle(plugin: HabitTrackerPlugin) {
		if (TweakPanel.openInstance) {
			TweakPanel.openInstance.close();
			return;
		}
		const panel = new TweakPanel(plugin);
		TweakPanel.openInstance = panel;
		panel.open();
	}

	open() {
		this.el = document.body.createDiv({ cls: "habit-tweak-panel" });
		this.renderHeader();
		const body = this.el.createDiv({ cls: "habit-tweak-body" });
		TWEAK_GROUPS.forEach((group, i) => this.renderGroup(body, group, i === 0));
		COPY_GROUPS.forEach((group) => this.renderCopyGroup(body, group));
		this.renderFooter();
		this.makeDraggable();
		this.onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		document.addEventListener("keydown", this.onKeydown);
	}

	close() {
		document.removeEventListener("keydown", this.onKeydown);
		this.el?.remove();
		if (TweakPanel.openInstance === this) TweakPanel.openInstance = null;
		// applyCopyLive() mutated the in-memory settings for preview, so
		// unsaved copy edits have to be rolled back to what was stored when
		// the panel opened (Save overwrites this snapshot, so saving then
		// closing keeps the new copy).
		this.plugin.settings.designCopy = { ...this.savedCopySnapshot };
		// Any unsaved experimenting is discarded by re-applying what's
		// actually stored — otherwise closing would silently leave the
		// draft on screen until the next full reload.
		this.plugin.refreshAll();
	}

	// Writes the draft to every open tracker block immediately. This is the
	// live-preview mechanism: no persist, no re-render, just custom
	// properties on each root.
	private applyLive() {
		document.querySelectorAll<HTMLElement>(".habit-tracker-root").forEach((root) => applyTweaksTo(root, this.draft));
	}

	private set(id: string, value: string) {
		const def = TWEAK_SPEC.find((t) => t.id === id);
		if (def && value === def.def) delete this.draft[id];
		else this.draft[id] = value;
		this.applyLive();
		this.refreshChangedCount();
	}

	private changedCount(): number {
		const tweaks = TWEAK_SPEC.filter((t) => this.draft[t.id] !== undefined && this.draft[t.id] !== t.def).length;
		const copy = COPY_SPEC.filter((c) => this.copyDraft[c.id] !== undefined && this.copyDraft[c.id] !== c.def).length;
		return tweaks + copy;
	}

	private countEl: HTMLElement;

	private refreshChangedCount() {
		if (!this.countEl) return;
		const n = this.changedCount();
		this.countEl.setText(n === 0 ? "matching shipped defaults" : `${n} change${n === 1 ? "" : "s"} from default`);
		this.countEl.toggleClass("habit-tweak-count-dirty", n > 0);
	}

	private renderHeader() {
		const header = this.el.createDiv({ cls: "habit-tweak-header" });
		const titleWrap = header.createDiv({ cls: "habit-tweak-title-wrap" });
		titleWrap.createDiv({ cls: "habit-tweak-title", text: "Design Tweaks" });
		this.countEl = titleWrap.createDiv({ cls: "habit-tweak-count" });
		const closeBtn = header.createEl("button", { cls: "habit-tweak-close", text: "✕" });
		closeBtn.setAttr("aria-label", "Close Design Tweaks");
		closeBtn.onclick = () => this.close();
		this.refreshChangedCount();
	}

	private renderGroup(parent: HTMLElement, group: string, startOpen: boolean) {
		const section = parent.createDiv({ cls: "habit-tweak-section" });
		const head = section.createDiv({ cls: "habit-tweak-section-head" });
		head.setAttr("tabindex", "0");
		head.setAttr("role", "button");
		const caret = head.createSpan({ cls: "habit-tweak-caret", text: startOpen ? "▾" : "▸" });
		head.createSpan({ text: group });
		const content = section.createDiv({ cls: "habit-tweak-section-body" });
		if (!startOpen) content.addClass("habit-tweak-hidden");
		const toggle = () => {
			const nowHidden = content.hasClass("habit-tweak-hidden");
			content.toggleClass("habit-tweak-hidden", !nowHidden);
			caret.setText(nowHidden ? "▾" : "▸");
			head.setAttr("aria-expanded", nowHidden ? "true" : "false");
		};
		head.onclick = toggle;
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		head.setAttr("aria-expanded", startOpen ? "true" : "false");

		TWEAK_SPEC.filter((t) => t.group === group).forEach((def) => this.renderControl(content, def));
	}

	// Copy groups are collapsed by default — there are far more strings than
	// design knobs, and the everyday use of this panel is visual tuning.
	private renderCopyGroup(parent: HTMLElement, group: string) {
		const section = parent.createDiv({ cls: "habit-tweak-section" });
		const head = section.createDiv({ cls: "habit-tweak-section-head" });
		head.setAttr("tabindex", "0");
		head.setAttr("role", "button");
		head.setAttr("aria-expanded", "false");
		const caret = head.createSpan({ cls: "habit-tweak-caret", text: "▸" });
		head.createSpan({ text: group });
		const content = section.createDiv({ cls: "habit-tweak-section-body habit-tweak-hidden" });
		const toggle = () => {
			const nowHidden = content.hasClass("habit-tweak-hidden");
			content.toggleClass("habit-tweak-hidden", !nowHidden);
			caret.setText(nowHidden ? "▾" : "▸");
			head.setAttr("aria-expanded", nowHidden ? "true" : "false");
		};
		head.onclick = toggle;
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		COPY_SPEC.filter((c) => c.group === group).forEach((def) => this.renderCopyControl(content, def));
	}

	private renderCopyControl(parent: HTMLElement, def: CopyDef) {
		const row = parent.createDiv({ cls: "habit-tweak-row habit-tweak-row-copy" });
		const labelRow = row.createDiv({ cls: "habit-tweak-copy-labelrow" });
		labelRow.createSpan({ cls: "habit-tweak-label", text: def.label });
		if (def.vars?.length) {
			// Placeholders are shown inline rather than in a tooltip: they're
			// the one thing you must not delete, so they shouldn't be hidden
			// behind a hover on a text field you're about to rewrite.
			labelRow.createSpan({ cls: "habit-tweak-vars", text: def.vars.map((v) => `{${v}}`).join(" ") });
		}
		if (def.help) labelRow.setAttr("title", def.help);

		const current = copyText(this.copyDraft, def.id);
		const input = def.multiline
			? row.createEl("textarea", { cls: "habit-tweak-textarea" })
			: row.createEl("input", { cls: "habit-tweak-text", type: "text" });
		input.value = current;
		if (def.multiline) (input as HTMLTextAreaElement).rows = Math.min(6, Math.ceil(current.length / 46) + 1);

		const commit = () => {
			const v = input.value;
			// An emptied field means "go back to shipped" rather than
			// "render nothing" — blanking a label by accident would leave an
			// unlabelled control with no way to tell what it was.
			if (v === def.def || v.trim() === "") {
				delete this.copyDraft[def.id];
				if (v.trim() === "") input.value = def.def;
			} else {
				this.copyDraft[def.id] = v;
			}
			this.applyCopyLive();
			this.refreshChangedCount();
		};
		input.addEventListener("change", commit);
		input.addEventListener("blur", commit);
	}

	// Copy changes can't be repainted like custom properties — the strings
	// are baked into the DOM at render time — so this commits the draft to
	// settings-in-memory and forces a rebuild. Not persisted until Save;
	// close() re-reads from disk to discard.
	private applyCopyLive() {
		this.plugin.settings.designCopy = { ...this.copyDraft };
		this.plugin.refreshAll();
	}

	private renderControl(parent: HTMLElement, def: TweakDef) {
		const row = parent.createDiv({ cls: "habit-tweak-row" });
		const labelWrap = row.createDiv({ cls: "habit-tweak-label-wrap" });
		const label = labelWrap.createDiv({ cls: "habit-tweak-label", text: def.label });
		if (def.help) label.setAttr("title", def.help);
		const valueEl = labelWrap.createDiv({ cls: "habit-tweak-value" });
		const control = row.createDiv({ cls: "habit-tweak-control" });
		const current = tweakValue(this.draft, def.id);

		const markValue = (v: string) => {
			if (def.kind === "range") valueEl.setText(`${v}${def.unit ?? ""}`);
			else if (def.kind === "toggle") valueEl.setText(v === "on" ? "on" : "off");
			else if (def.kind === "color") valueEl.setText(v);
			else valueEl.setText("");
		};
		markValue(current);

		if (def.kind === "color") {
			const swatch = control.createEl("input", { cls: "habit-tweak-color", type: "color" });
			swatch.value = current;
			const hex = control.createEl("input", { cls: "habit-tweak-hex", type: "text" });
			hex.value = current;
			swatch.addEventListener("input", () => {
				hex.value = swatch.value;
				markValue(swatch.value);
				this.set(def.id, swatch.value);
			});
			hex.addEventListener("change", () => {
				// Only accept a well-formed hex; anything else snaps back so
				// a half-typed value can't blank out a color mid-edit.
				if (!/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) {
					hex.value = tweakValue(this.draft, def.id);
					return;
				}
				swatch.value = hex.value.trim();
				markValue(hex.value.trim());
				this.set(def.id, hex.value.trim());
			});
		} else if (def.kind === "range") {
			const slider = control.createEl("input", { cls: "habit-tweak-range", type: "range" });
			slider.min = String(def.min ?? 0);
			slider.max = String(def.max ?? 100);
			slider.step = String(def.step ?? 1);
			slider.value = current;
			slider.addEventListener("input", () => {
				markValue(slider.value);
				this.set(def.id, slider.value);
			});
		} else if (def.kind === "toggle") {
			const btn = control.createEl("button", { cls: "habit-tweak-toggle" });
			const paint = (v: string) => {
				btn.toggleClass("habit-tweak-toggle-on", v === "on");
				btn.setText(v === "on" ? "On" : "Off");
				btn.setAttr("aria-pressed", v === "on" ? "true" : "false");
			};
			paint(current);
			btn.onclick = () => {
				const next = tweakValue(this.draft, def.id) === "on" ? "off" : "on";
				paint(next);
				markValue(next);
				this.set(def.id, next);
			};
		} else {
			// select + font share the same widget; font just has long values.
			const sel = control.createEl("select", { cls: "habit-tweak-select" });
			(def.options ?? []).forEach((opt) => {
				const o = sel.createEl("option", { text: opt.label });
				o.value = opt.value;
			});
			sel.value = current;
			if (def.kind === "font") sel.style.fontFamily = current;
			sel.addEventListener("change", () => {
				if (def.kind === "font") sel.style.fontFamily = sel.value;
				this.set(def.id, sel.value);
			});
		}
	}

	private renderFooter() {
		const footer = this.el.createDiv({ cls: "habit-tweak-footer" });

		const saveBtn = footer.createEl("button", { cls: "habit-tweak-btn habit-tweak-btn-cta", text: "Save" });
		saveBtn.onclick = async () => {
			this.plugin.settings.designTweaks = { ...this.draft };
			this.plugin.settings.designCopy = { ...this.copyDraft };
			this.savedCopySnapshot = { ...this.copyDraft };
			await this.plugin.persist();
			this.plugin.refreshAll();
			new Notice(`Design saved — ${this.changedCount()} tweak(s) applied.`);
		};

		const copyBtn = footer.createEl("button", { cls: "habit-tweak-btn", text: "Copy CSS" });
		copyBtn.onclick = async () => {
			const css = this.exportCss();
			await navigator.clipboard.writeText(css);
			new Notice("CSS copied — paste it into styles.css to make it the default.");
		};

		const resetBtn = footer.createEl("button", { cls: "habit-tweak-btn habit-tweak-btn-warn", text: "Reset" });
		resetBtn.onclick = () => {
			this.draft = {};
			this.copyDraft = {};
			this.applyLive();
			this.applyCopyLive();
			this.el.empty();
			this.renderHeader();
			const body = this.el.createDiv({ cls: "habit-tweak-body" });
			TWEAK_GROUPS.forEach((g, i) => this.renderGroup(body, g, i === 0));
			COPY_GROUPS.forEach((g) => this.renderCopyGroup(body, g));
			this.renderFooter();
			new Notice("Reverted to shipped defaults (not saved yet).");
		};
	}

	// Emits only what differs from the shipped design, as a paste-ready
	// block — a full dump would be noise, and would also silently freeze
	// values that should keep tracking future default changes.
	private exportCss(): string {
		const vars: string[] = [];
		const classes: string[] = [];
		for (const def of TWEAK_SPEC) {
			const v = this.draft[def.id];
			if (v === undefined || v === def.def) continue;
			if (def.cssVar) {
				vars.push(`\t${def.cssVar}: ${v}${def.unit && def.kind === "range" ? def.unit : ""};`);
			} else if (def.bodyClass) {
				classes.push(
					def.kind === "toggle"
						? `${def.label}: ${v} → class .${def.bodyClass}`
						: `${def.label}: ${v} → class .${def.bodyClass}-${v}`
				);
			} else {
				classes.push(`${def.label}: ${v} (behavioral — set in plugin settings, no CSS)`);
			}
		}
		const copyLines: string[] = [];
		for (const def of COPY_SPEC) {
			const v = this.copyDraft[def.id];
			if (v === undefined || v === def.def) continue;
			copyLines.push(`\t{ id: "${def.id}", def: ${JSON.stringify(v)} },`);
		}
		if (!vars.length && !classes.length && !copyLines.length) return "/* No changes from the shipped design. */";
		let out = "";
		if (vars.length) out += `.habit-tracker-root {\n${vars.join("\n")}\n}\n`;
		if (classes.length) out += `\n/* Structural tweaks (applied as classes by applyTweaksTo):\n${classes.map((c) => `   ${c}`).join("\n")}\n*/\n`;
		if (copyLines.length) out += `\n/* Copy overrides — paste these \`def\` values into COPY_SPEC in main.ts:\n${copyLines.join("\n")}\n*/\n`;
		return out;
	}

	private makeDraggable() {
		const header = this.el.querySelector<HTMLElement>(".habit-tweak-header");
		if (!header) return;
		let startX = 0;
		let startY = 0;
		let originLeft = 0;
		let originTop = 0;
		let dragging = false;

		const onMove = (e: MouseEvent) => {
			if (!dragging) return;
			// Clamped so the panel can't be dragged fully off-screen and
			// stranded — its header has to stay grabbable.
			const maxLeft = window.innerWidth - 80;
			const maxTop = window.innerHeight - 40;
			this.el.style.left = `${Math.min(Math.max(originLeft + e.clientX - startX, -240), maxLeft)}px`;
			this.el.style.top = `${Math.min(Math.max(originTop + e.clientY - startY, 0), maxTop)}px`;
			this.el.style.right = "auto";
		};
		const onUp = () => {
			dragging = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		header.addEventListener("mousedown", (e: MouseEvent) => {
			if ((e.target as HTMLElement).closest("button")) return;
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			const rect = this.el.getBoundingClientRect();
			originLeft = rect.left;
			originTop = rect.top;
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			e.preventDefault();
		});
	}
}

class HabitTrackerSettingTab extends PluginSettingTab {
	plugin: HabitTrackerPlugin;
	email = "";
	password = "";
	statusEl: HTMLElement;

	constructor(app: App, plugin: HabitTrackerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("habit-tracker-settings-tab");
		containerEl.createEl("h2", { text: "Habit Tracker — Sync" });
		containerEl.createEl("p", {
			text: "Connect a free Supabase project to sync habits across devices in real time. Leave blank to use this device only (local storage, synced only however your vault itself syncs).",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Supabase project URL")
			.setDesc("From your Supabase project's Settings → API.")
			.addText((text) =>
				text
					.setPlaceholder("https://xxxxx.supabase.co")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Supabase anon public key")
			.setDesc("Also from Settings → API. Safe to store here — it's a public key, actual access is controlled by row-level security.")
			.addText((text) =>
				text
					.setPlaceholder("eyJ...")
					.setValue(this.plugin.settings.supabaseAnonKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseAnonKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", { text: "Milestones" });
		containerEl.createEl("p", {
			text: "Day-streak thresholds that trigger a celebration (confetti + sound) and drive each habit's \"days to next milestone\" bubble.",
			cls: "setting-item-description",
		});
		this.renderMilestonesSection(containerEl);

		containerEl.createEl("h2", { text: "Last Call Alarms" });
		containerEl.createEl("p", {
			text: 'Generic nags not tied to any specific habit (e.g. "Log off for the day"). Once the alarm time passes local time, nags (sound + banner) every few minutes until dismissed — dismissing lasts only for that calendar day. Per-habit alarms live in each habit\'s own edit form (✏️ in its stats row) instead. Both are also read by an external script (~/.second-brain-cron/habit-alarm.sh) so the nag still fires even when Obsidian is closed.',
			cls: "setting-item-description",
		});
		this.renderLastCallAlarmsSection(containerEl);

		containerEl.createEl("h2", { text: "AI Assistance" });
		containerEl.createEl("p", {
			text: 'Powers the "✨ Review Formula" button in the Add/Edit Habit form, which critiques and suggests rewrites for your Complete Habit Formula fields (Cue/Craving/Routine/Reward). Uses the Anthropic API — your key is stored locally on this device only, never synced.',
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("From console.anthropic.com. Leave blank to hide the Review Formula button.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async (value) => {
						this.plugin.settings.anthropicApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Anthropic model id to use for the review.")
			.addText((text) =>
				text
					.setPlaceholder("claude-haiku-4-5-20251001")
					.setValue(this.plugin.settings.anthropicModel)
					.onChange(async (value) => {
						this.plugin.settings.anthropicModel = value.trim() || DEFAULT_SETTINGS.anthropicModel;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Sign in" });
		this.statusEl = containerEl.createEl("p", { cls: "setting-item-description" });
		this.updateStatus();

		new Setting(containerEl).setName("Email").addText((text) => {
			// Mobile keyboards auto-capitalize/auto-correct text fields by
			// default, which can silently mangle an email as you type it
			// (e.g. capitalizing the first letter) and cause sign-in to
			// fail with "invalid" even though it looks right. Opt out
			// explicitly, and normalize case on our end too as a backstop.
			text.inputEl.setAttribute("autocapitalize", "none");
			text.inputEl.setAttribute("autocorrect", "off");
			text.inputEl.setAttribute("spellcheck", "false");
			text.inputEl.type = "email";
			text.setPlaceholder("you@example.com").onChange((value) => {
				this.email = value.trim().toLowerCase();
			});
		});

		new Setting(containerEl).setName("Password").addText((text) => {
			text.inputEl.setAttribute("autocapitalize", "none");
			text.inputEl.setAttribute("autocorrect", "off");
			text.inputEl.setAttribute("spellcheck", "false");
			text.inputEl.type = "password";
			text.onChange((value) => {
				this.password = value;
			});
		});

		new Setting(containerEl)
			.addButton((btn) =>
				btn.setButtonText("Sign up").onClick(async () => {
					await this.plugin.signUp(this.email, this.password);
					this.updateStatus();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						await this.plugin.signIn(this.email, this.password);
						this.updateStatus();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Sign out").onClick(async () => {
					await this.plugin.signOut();
					this.updateStatus();
				})
			);
	}

	updateStatus() {
		const session = this.plugin.session;
		this.statusEl.setText(
			session ? `Signed in as ${session.user.email}. Syncing live.` : "Not signed in. Habit data is local-only on this device."
		);
	}

	// One row per configured milestone (editable value + a remove button),
	// plus an "add a new one" row at the bottom — same
	// list-with-inline-edit/remove shape as the color-wheel swatches in
	// HabitFormModal, just built from Setting rows since this is a
	// PluginSettingTab rather than a modal.
	renderMilestonesSection(containerEl: HTMLElement) {
		const listEl = containerEl.createDiv({ cls: "habit-tracker-settings-milestones-list" });

		const renderList = () => {
			listEl.empty();
			const sorted = [...this.plugin.settings.milestones].sort((a, b) => a - b);
			if (sorted.length === 0) {
				listEl.createEl("p", { text: "No milestones configured — celebrations won't trigger.", cls: "setting-item-description" });
			}
			for (const m of sorted) {
				new Setting(listEl)
					.setName(`${m} days`)
					.addText((text) =>
						text
							.setValue("" + m)
							.onChange(async (value) => {
								const n = parseInt(value, 10);
								if (!Number.isFinite(n) || n <= 0) return;
								const idx = this.plugin.settings.milestones.indexOf(m);
								if (idx === -1) return;
								this.plugin.settings.milestones[idx] = n;
								await this.plugin.saveSettings();
							})
					)
					.addButton((btn) =>
						btn
							.setButtonText("🗑")
							.setTooltip("Remove milestone")
							.onClick(async () => {
								this.plugin.settings.milestones = this.plugin.settings.milestones.filter((x) => x !== m);
								await this.plugin.saveSettings();
								renderList();
							})
					);
			}
		};
		renderList();

		let newMilestoneValue = "";
		let newMilestoneTextEl: HTMLInputElement;
		new Setting(containerEl)
			.setName("Add milestone")
			.setDesc("Enter a day-streak count, e.g. 500.")
			.addText((text) => {
				newMilestoneTextEl = text.inputEl;
				text.setPlaceholder("500").onChange((value) => {
					newMilestoneValue = value;
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						const n = parseInt(newMilestoneValue, 10);
						if (!Number.isFinite(n) || n <= 0) {
							new Notice("Enter a positive whole number of days.");
							return;
						}
						if (this.plugin.settings.milestones.includes(n)) {
							new Notice("That milestone already exists.");
							return;
						}
						this.plugin.settings.milestones.push(n);
						await this.plugin.saveSettings();
						newMilestoneValue = "";
						newMilestoneTextEl.value = "";
						renderList();
					})
			);
	}

	// Same list-with-inline-edit/remove + "add a new one" row shape as
	// renderMilestonesSection above, for settings.lastCallAlarms.
	renderLastCallAlarmsSection(containerEl: HTMLElement) {
		const listEl = containerEl.createDiv({ cls: "habit-tracker-settings-lastcall-list" });

		const renderList = () => {
			listEl.empty();
			const alarms = this.plugin.settings.lastCallAlarms;
			if (alarms.length === 0) {
				listEl.createEl("p", { text: "No last call alarms configured.", cls: "setting-item-description" });
			}
			for (const alarm of alarms) {
				new Setting(listEl)
					.setName(alarm.name)
					.addText((text) => {
						text.inputEl.type = "time";
						text.setValue(alarm.time).onChange(async (value) => {
							if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
							alarm.time = value;
							await this.plugin.saveSettings();
						});
					})
					.addToggle((toggle) =>
						toggle.setValue(alarm.enabled).onChange(async (value) => {
							alarm.enabled = value;
							await this.plugin.saveSettings();
						})
					)
					.addButton((btn) =>
						btn
							.setButtonText("🗑")
							.setTooltip("Remove last call alarm")
							.onClick(async () => {
								this.plugin.settings.lastCallAlarms = this.plugin.settings.lastCallAlarms.filter((a) => a.id !== alarm.id);
								await this.plugin.saveSettings();
								renderList();
							})
					);
			}
		};
		renderList();

		let newAlarmName = "";
		let newAlarmTime = "20:00";
		let newAlarmNameTextEl: HTMLInputElement;
		new Setting(containerEl)
			.setName("Add last call alarm")
			.setDesc('Name it (e.g. "Log off for the day") and pick a time.')
			.addText((text) => {
				newAlarmNameTextEl = text.inputEl;
				text.setPlaceholder("Name").onChange((value) => {
					newAlarmName = value;
				});
			})
			.addText((text) => {
				text.inputEl.type = "time";
				text.setValue(newAlarmTime).onChange((value) => {
					if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
					newAlarmTime = value;
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						if (!newAlarmName.trim()) {
							new Notice("Enter a name for the alarm.");
							return;
						}
						this.plugin.settings.lastCallAlarms.push({
							id: slugify(newAlarmName) + "-" + Date.now(),
							name: newAlarmName.trim(),
							time: newAlarmTime,
							enabled: true,
						});
						await this.plugin.saveSettings();
						newAlarmName = "";
						newAlarmNameTextEl.value = "";
						renderList();
					})
			);
	}
}

type ViewMode = "day" | "week" | "month" | "year" | "yeardays" | "streaks";
type CellStyle = "year" | "week" | "month" | "yeardays" | "day";

class HabitTrackerBlock extends MarkdownRenderChild {
	plugin: HabitTrackerPlugin;
	filterName: string | null;
	currentView: ViewMode;
	// Which month the Month view is browsing to, as an integer offset from
	// the real current month (0 = this month, +1 = next, -1 = previous, ...).
	// Purely in-memory per-block state like currentView — not persisted to
	// data.json, and resets to 0 (today's month) on every fresh block load.
	selectedMonthOffset: number = 0;
	// Same idea, for Week view: an integer offset in weeks from the real
	// current week (0 = this week, +1 = next, -1 = previous, ...).
	selectedWeekOffset: number = 0;
	// Same in-memory, resets-on-load pattern as the other view offsets: an
	// integer offset in days from today (0 = today, -1 = yesterday).
	selectedDayOffset: number = 0;
	// Same idea, for Year and Year-Days view (they share one offset since
	// both show a single calendar year): an integer offset in years from
	// the real current year (0 = this year, +1 = next, -1 = previous, ...).
	selectedYearOffset: number = 0;
	// Remembers each habit's year-view horizontal scroll position across
	// re-renders (every click triggers a full rebuild via refreshAll,
	// which would otherwise reset scroll back to January every time).
	yearScrollByHabit: Map<string, number> = new Map();
	// Set while the "🎓 Habit Creation Walkthrough" toolbar button is
	// pointing at the "+ Add habit" card, waiting for the user to click it
	// before the actual form walkthrough begins.
	pendingWalkthroughIntro = false;
	// Same in-memory-only pattern as currentView/selectedMonthOffset/etc
	// above — whether this block is currently in drag-to-reorder mode.
	// Resets to false on every fresh block load, never persisted.
	reorderModeActive: boolean = false;
	// Ids of habits whose Four Laws formula panel is currently expanded on
	// this block. Same in-memory-only, resets-on-load pattern as the fields
	// above — the collapsed default is deliberate (see renderHabit), so
	// persisting an expanded state would defeat the point.
	expandedLevers: Set<string> = new Set();
	// Counterpart to expandedLevers, used when the Design Tweaks
	// "Formula starts" default is Expanded — then we track who's been
	// explicitly closed instead. See toggleLevers in renderHabit.
	collapsedLevers: Set<string> = new Set();
	// Id of the habit currently being dragged, while a drag gesture is in
	// progress. Kept as plain block-level state rather than round-tripping
	// through event.dataTransfer.getData() on dragover/drop — Obsidian's
	// Electron/Chromium webview supports dataTransfer fine, but since this
	// is always a same-page, same-block reorder (never a drag to/from
	// outside the app), a plain instance field is simpler and avoids any
	// dependency on dataTransfer's read-during-dragover quirks (some
	// browsers only expose custom data types on `drop`, not `dragover`,
	// which would break the live drop-indicator).
	draggedHabitId: string | null = null;

	constructor(
		containerEl: HTMLElement,
		plugin: HabitTrackerPlugin,
		filterName: string | null,
		defaultView: ViewMode
	) {
		super(containerEl);
		this.plugin = plugin;
		this.filterName = filterName;
		this.currentView = defaultView;
	}

	onload() {
		this.plugin.registerBlock(this);
		this.render();
	}

	onunload() {
		this.plugin.unregisterBlock(this);
	}

	render() {
		const el = this.containerEl;


		// Capture the current scroll position of every year-view grid
		// before we tear the DOM down, so it can be restored after rebuild
		// instead of snapping back to the start.
		el.querySelectorAll<HTMLElement>(".habit-tracker-grid-wrap[data-habit-id]").forEach((w) => {
			const id = w.getAttribute("data-habit-id");
			if (id) this.yearScrollByHabit.set(id, w.scrollLeft);
		});

		el.empty();
		el.addClass("habit-tracker-root");
		// Design Tweaks land here rather than in a stylesheet: inline custom
		// properties on the block root, so every card/cell/control below
		// recalculates from them without any extra render work.
		applyTweaksTo(el, this.plugin.settings.designTweaks);

		const data = this.plugin.data;
		const allItems = this.filterName
			? data.habits.filter((h) => h.name.toLowerCase() === this.filterName!.toLowerCase())
			: data.habits;

		// Tasks: hidden entirely until their scheduled date arrives, then
		// shown as a single checkable row (no heatmap/streak) rather than
		// mixed into the regular habit grid list. Once checked off they
		// auto-archive into a collapsed Done section below.
		const today = todayStr();
		const habits = allItems.filter((h) => h.kind !== "task" && !h.archived);
		const archivedHabits = allItems.filter((h) => h.kind !== "task" && h.archived);
		const pendingTasks = allItems.filter((h) => h.kind === "task" && !h.archived && (h.scheduledDate ?? "") <= today);
		const doneTasks = allItems.filter((h) => h.kind === "task" && h.archived);

		const toggleRow = el.createDiv({ cls: "habit-tracker-global-toggle-row" });
		const leftGroup = toggleRow.createDiv({ cls: "habit-tracker-toggle-row-left" });
		if (!this.filterName) {
			const walkthroughBtn = leftGroup.createEl("button", {
				text: "🎓 Creation Walkthrough",
				cls: "habit-tracker-walkthrough-btn",
			});
			walkthroughBtn.type = "button";
			walkthroughBtn.onclick = () => this.showAddHabitIntro();
		}
		const toggle = leftGroup.createDiv({ cls: "habit-tracker-view-toggle" });
		const modeLabels: Record<ViewMode, string> = { day: copyText(this.plugin.settings.designCopy, "tb.day"), week: copyText(this.plugin.settings.designCopy, "tb.week"), month: copyText(this.plugin.settings.designCopy, "tb.month"), year: copyText(this.plugin.settings.designCopy, "tb.year"), yeardays: copyText(this.plugin.settings.designCopy, "tb.yeardays"), streaks: copyText(this.plugin.settings.designCopy, "tb.streaks") };
		(["day", "week", "month", "year", "yeardays", "streaks"] as ViewMode[]).forEach((mode, modeIndex) => {
			const b = toggle.createEl("button", {
				text: modeLabels[mode],
				cls: "habit-tracker-view-btn" + (this.currentView === mode ? " habit-tracker-view-btn-active" : ""),
			});
			b.onclick = () => {
				this.currentView = mode;
				this.render();
				// With six segments the group scrolls on a narrow pane, so
				// pull the newly-chosen one into view. This lives in the
				// click handler, NOT in render(): running it on every render
				// meant checking off a habit dragged the toggle row — and
				// with it the whole note — back to the top.
				const again = this.containerEl.querySelectorAll<HTMLElement>(".habit-tracker-view-btn")[modeIndex];
				again?.scrollIntoView({ block: "nearest", inline: "nearest" });
			};
		});

		if (this.currentView === "month") {
			const monthNav = leftGroup.createDiv({ cls: "habit-tracker-view-nav" });
			const prevBtn = monthNav.createEl("button", { text: "◀", cls: "habit-tracker-view-nav-btn" });
			prevBtn.type = "button";
			prevBtn.setAttr("aria-label", "Previous month");
			prevBtn.onclick = () => {
				this.selectedMonthOffset -= 1;
				this.render();
			};
			const navMonth = new Date();
			navMonth.setMonth(navMonth.getMonth() + this.selectedMonthOffset);
			monthNav.createSpan({
				text: navMonth.toLocaleString("default", { month: "long", year: "numeric" }),
				cls: "habit-tracker-view-nav-label habit-tracker-view-nav-label-month",
			});
			const nextBtn = monthNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next month");
			nextBtn.onclick = () => {
				this.selectedMonthOffset += 1;
				this.render();
			};
			if (this.selectedMonthOffset !== 0) {
				const todayBtn = monthNav.createEl("button", { text: copyText(this.plugin.settings.designCopy, "tb.today"), cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to current month");
				todayBtn.onclick = () => {
					this.selectedMonthOffset = 0;
					this.render();
				};
			}
		}

		if (this.currentView === "day") {
			const dayNav = leftGroup.createDiv({ cls: "habit-tracker-view-nav" });
			const prevBtn = dayNav.createEl("button", { text: "◀", cls: "habit-tracker-view-nav-btn" });
			prevBtn.type = "button";
			prevBtn.setAttr("aria-label", "Previous day");
			prevBtn.onclick = () => {
				this.selectedDayOffset -= 1;
				this.render();
			};
			const navDay = addDays(new Date(), this.selectedDayOffset);
			// "Today"/"Yesterday" rather than a bare date for the two days
			// you'd actually be back-filling — a date string alone makes you
			// do the arithmetic to work out where you are.
			const dayLabel =
				this.selectedDayOffset === 0
					? `Today · ${navDay.toLocaleString("default", { weekday: "long", month: "short", day: "numeric" })}`
					: this.selectedDayOffset === -1
					? `Yesterday · ${navDay.toLocaleString("default", { weekday: "long", month: "short", day: "numeric" })}`
					: navDay.toLocaleString("default", { weekday: "long", month: "short", day: "numeric", year: navDay.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
			dayNav.createSpan({ text: dayLabel, cls: "habit-tracker-view-nav-label habit-tracker-view-nav-label-day" });
			const nextBtn = dayNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next day");
			nextBtn.onclick = () => {
				this.selectedDayOffset += 1;
				this.render();
			};
			if (this.selectedDayOffset !== 0) {
				const todayBtn = dayNav.createEl("button", { text: copyText(this.plugin.settings.designCopy, "tb.today"), cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to today");
				todayBtn.onclick = () => {
					this.selectedDayOffset = 0;
					this.render();
				};
			}
		}

		if (this.currentView === "week") {
			const weekNav = leftGroup.createDiv({ cls: "habit-tracker-view-nav" });
			const prevBtn = weekNav.createEl("button", { text: "◀", cls: "habit-tracker-view-nav-btn" });
			prevBtn.type = "button";
			prevBtn.setAttr("aria-label", "Previous week");
			prevBtn.onclick = () => {
				this.selectedWeekOffset -= 1;
				this.render();
			};
			const navWeekStart = addDays(addDays(new Date(), -new Date().getDay()), this.selectedWeekOffset * 7);
			const navWeekEnd = addDays(navWeekStart, 6);
			const sameYear = navWeekStart.getFullYear() === navWeekEnd.getFullYear();
			const startLabel = navWeekStart.toLocaleString("default", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
			const endLabel = navWeekEnd.toLocaleString("default", { month: "short", day: "numeric", year: "numeric" });
			weekNav.createSpan({
				text: `${startLabel} – ${endLabel}`,
				cls: "habit-tracker-view-nav-label habit-tracker-view-nav-label-week",
			});
			const nextBtn = weekNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next week");
			nextBtn.onclick = () => {
				this.selectedWeekOffset += 1;
				this.render();
			};
			if (this.selectedWeekOffset !== 0) {
				const todayBtn = weekNav.createEl("button", { text: copyText(this.plugin.settings.designCopy, "tb.today"), cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to current week");
				todayBtn.onclick = () => {
					this.selectedWeekOffset = 0;
					this.render();
				};
			}
		}

		if (this.currentView === "year" || this.currentView === "yeardays") {
			const yearNav = leftGroup.createDiv({ cls: "habit-tracker-view-nav" });
			const prevBtn = yearNav.createEl("button", { text: "◀", cls: "habit-tracker-view-nav-btn" });
			prevBtn.type = "button";
			prevBtn.setAttr("aria-label", "Previous year");
			prevBtn.onclick = () => {
				this.selectedYearOffset -= 1;
				this.render();
			};
			const navYear = new Date().getFullYear() + this.selectedYearOffset;
			yearNav.createSpan({
				text: `${navYear}`,
				cls: "habit-tracker-view-nav-label",
			});
			const nextBtn = yearNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next year");
			nextBtn.onclick = () => {
				this.selectedYearOffset += 1;
				this.render();
			};
			if (this.selectedYearOffset !== 0) {
				const todayBtn = yearNav.createEl("button", { text: copyText(this.plugin.settings.designCopy, "tb.today"), cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to current year");
				todayBtn.onclick = () => {
					this.selectedYearOffset = 0;
					this.render();
				};
			}
		}

		if (!this.filterName) {
			// Reorder is hidden on the Streaks view — that page is read-only
			// and has no draggable cards — but the gear stays, so settings
			// remain reachable from every view.
			if (this.currentView !== "streaks") {
				const reorderBtn = toggleRow.createEl("button", {
					text: copyText(this.plugin.settings.designCopy, "tb.reorder"),
					cls: "habit-tracker-reorder-btn" + (this.reorderModeActive ? " habit-tracker-reorder-btn-active" : ""),
				});
				reorderBtn.type = "button";
				reorderBtn.setAttr("aria-label", this.reorderModeActive ? "Exit reorder mode" : "Reorder habits");
				reorderBtn.onclick = () => {
					this.reorderModeActive = !this.reorderModeActive;
					this.render();
				};
			}

			const gearBtn = toggleRow.createEl("button", { text: "⚙️", cls: "habit-tracker-gear-btn" });
			gearBtn.type = "button";
			gearBtn.setAttr("aria-label", "Settings");
			gearBtn.onclick = () => this.toggleSettingsPanel();
		}

		const visibleCount = habits.length + pendingTasks.length + doneTasks.length + archivedHabits.length;
		if (visibleCount === 0 && !this.filterName) {
			const empty = el.createDiv({ cls: "habit-tracker-empty" });
			empty.createDiv({ text: copyText(this.plugin.settings.designCopy, "st.emptyIcon"), cls: "habit-tracker-empty-icon" });
			empty.createDiv({ text: copyText(this.plugin.settings.designCopy, "st.emptyTitle"), cls: "habit-tracker-empty-title" });
			empty.createDiv({
				text: copyText(this.plugin.settings.designCopy, "st.emptyBody"),
				cls: "habit-tracker-empty-subtitle",
			});
		} else if (visibleCount === 0 && this.filterName) {
			const empty = el.createDiv({ cls: "habit-tracker-empty" });
			empty.createDiv({ text: copyText(this.plugin.settings.designCopy, "st.emptyFilterIcon"), cls: "habit-tracker-empty-icon" });
			empty.createDiv({ text: copyText(this.plugin.settings.designCopy, "st.emptyFilterTitle", { name: this.filterName ?? "" }), cls: "habit-tracker-empty-title" });
		}

		if (this.currentView === "streaks") {
			this.renderStreaksPage(el, allItems.filter((h) => !h.archived));
			return;
		}

		const list = el.createDiv({ cls: "habit-tracker-list" });
		for (const task of pendingTasks) {
			this.renderTask(list, task, today);
		}
		for (const habit of habits) {
			this.renderHabit(list, habit);
		}

		if (doneTasks.length > 0) {
			const doneToggle = el.createDiv({ cls: "habit-tracker-done-toggle", text: copyText(this.plugin.settings.designCopy, "st.doneSection", { n: doneTasks.length }) });
			const doneSection = el.createDiv({ cls: "habit-tracker-done-section" });
			for (const task of doneTasks) {
				this.renderTask(doneSection, task, today);
			}
			doneToggle.onclick = () => {
				doneSection.toggleClass("habit-tracker-done-section-visible", !doneSection.hasClass("habit-tracker-done-section-visible"));
			};
		}

		// Same collapsed-section behavior as Done tasks above (reuses
		// .habit-tracker-done-section for the collapsible content — archived
		// habits keep full cards, history/streak still visible, rather than
		// a stripped-down row, since restoring one via its ↩️ button should
		// show exactly what's being brought back). The toggle itself gets
		// its own look, not .habit-tracker-done-toggle's plain muted text —
		// styled like .habit-tracker-add-card below (same dashed-card shape
		// and hover glow) so it reads as a peer action, not a footnote.
		if (archivedHabits.length > 0) {
			const archivedToggle = el.createDiv({
				cls: "habit-tracker-archived-toggle",
				text: copyText(this.plugin.settings.designCopy, "st.archivedSection", { n: archivedHabits.length }),
			});
			const archivedSection = el.createDiv({ cls: "habit-tracker-done-section" });
			for (const habit of archivedHabits) {
				this.renderHabit(archivedSection, habit);
			}
			archivedToggle.onclick = () => {
				archivedSection.toggleClass("habit-tracker-done-section-visible", !archivedSection.hasClass("habit-tracker-done-section-visible"));
			};
		}

		if (!this.filterName) {
			const addCard = list.createDiv({ cls: "habit-tracker-add-card" });
			addCard.createSpan({ text: "+", cls: "habit-tracker-add-icon" });
			addCard.createSpan({ text: copyText(this.plugin.settings.designCopy, "tb.addHabit"), cls: "habit-tracker-add-label" });
			addCard.onclick = () => {
				const fromIntro = this.pendingWalkthroughIntro;
				if (fromIntro) {
					this.pendingWalkthroughIntro = false;
					this.containerEl.querySelector(".habit-tracker-add-card")?.removeClass("habit-tracker-walkthrough-highlight");
					this.containerEl.querySelector(".habit-tracker-block-walkthrough-tooltip")?.remove();
				}
				this.openAddHabitModal(fromIntro || !this.plugin.data.hasCreatedFirstHabit);
			};
		}
	}

	openAddHabitModal(walkthrough: boolean) {
		new HabitFormModal(this.plugin.app, this.plugin, {
			title: "New habit",
			submitLabel: "Add habit",
			walkthrough,
			onSubmit: async (values) => {
				const habit: HabitDefinition = {
					id: slugify(values.name) + "-" + Date.now(),
					name: values.name,
					color: values.color,
					createdAt: values.createdAt || todayStr(),
					type: values.type,
					kind: values.kind,
					scheduledDate: values.kind === "task" ? values.scheduledDate : undefined,
					alarmEnabled: values.kind === "task" ? undefined : values.alarmEnabled,
					alarmTime: values.kind === "task" ? undefined : values.alarmTime,
					alarmRepeatMinutes: values.kind === "task" ? undefined : values.alarmRepeatMinutes,
					timeOfDay: values.kind === "task" ? undefined : (values.timeOfDay || undefined),
					scheduledDays:
						values.kind === "task" || values.scheduledDays.length >= 7 ? undefined : [...values.scheduledDays].sort(),
					stackedAfter: values.stackedAfter || undefined,
					craving: values.craving || undefined,
					minimumVersion: values.minimumVersion || undefined,
					reward: values.reward || undefined,
					identity: values.identity || undefined,
					linkedGoal: values.linkedGoal || undefined,
				};
				this.plugin.data.habits.push(habit);
				this.plugin.data.entries[habit.id] = {};
				this.plugin.data.hasCreatedFirstHabit = true;
				await this.plugin.persist();
				this.plugin.refreshAll();
			},
			onSplit: async (originalValues, copyValues) => {
				// Mint both ids up front — see the "-copy-" infix note below,
				// this is not cosmetic.
				const originalId = slugify(originalValues.name) + "-" + Date.now();
				// The copy's `name` is unchanged from the original by design
				// (only Time of Day differs), so without the "-copy-" infix
				// both ids would be minted from the identical slugified name
				// within the same JS millisecond in this same handler — a
				// real, likely collision that would silently overwrite one
				// habit's `entries` map with the other's.
				const copyId = slugify(copyValues.name) + "-copy-" + Date.now();
				// Both halves keep the original's start date — a split is a
				// reshaping of an existing habit, not two brand-new ones, so
				// resetting to today would wipe its accumulated history from
				// every consistency figure.
				const originalHabit: HabitDefinition = {
					id: originalId,
					createdAt: originalValues.createdAt || todayStr(),
					kind: "habit",
					...habitFieldsFromFormValues(originalValues),
				};
				const copyHabit: HabitDefinition = {
					id: copyId,
					createdAt: copyValues.createdAt || todayStr(),
					kind: "habit",
					...habitFieldsFromFormValues(copyValues),
				};
				this.plugin.data.habits.push(originalHabit, copyHabit);
				this.plugin.data.entries[originalId] = {};
				this.plugin.data.entries[copyId] = {};
				this.plugin.data.hasCreatedFirstHabit = true;
				await this.plugin.persist();
				this.plugin.refreshAll();
				new Notice(`Split into "${habitDisplayName(originalHabit)}" and "${habitDisplayName(copyHabit)}".`);
			},
		}).open();
	}

	// The toolbar walkthrough button doesn't jump straight into the form —
	// it first points at the "+ Add habit" card and waits for the user to
	// click it themselves, same as anyone discovering the feature would.
	// The actual form walkthrough (startWalkthrough() in HabitFormModal)
	// only begins once that click happens (see addCard.onclick above).
	showAddHabitIntro() {
		const addCard = this.containerEl.querySelector<HTMLElement>(".habit-tracker-add-card");
		if (!addCard) return;
		this.containerEl.querySelector(".habit-tracker-block-walkthrough-tooltip")?.remove();

		this.pendingWalkthroughIntro = true;
		addCard.addClass("habit-tracker-walkthrough-highlight");
		addCard.scrollIntoView({ block: "center", behavior: "smooth" });

		const tooltip = this.containerEl.createDiv({ cls: "habit-tracker-walkthrough-tooltip habit-tracker-block-walkthrough-tooltip" });
		tooltip.createDiv({ text: copyText(this.plugin.settings.designCopy, "wt.intro"), cls: "habit-tracker-walkthrough-title" });
		const dismissBtn = tooltip.createEl("button", { text: "Never mind", cls: "habit-tracker-walkthrough-skip" });
		dismissBtn.type = "button";
		dismissBtn.onclick = () => {
			this.pendingWalkthroughIntro = false;
			addCard.removeClass("habit-tracker-walkthrough-highlight");
			tooltip.remove();
		};

		window.setTimeout(() => {
			const rootRect = this.containerEl.getBoundingClientRect();
			const cardRect = addCard.getBoundingClientRect();
			tooltip.style.top = `${cardRect.bottom - rootRect.top + 8}px`;
			tooltip.style.left = `${Math.max(0, cardRect.left - rootRect.left)}px`;
		}, 50);
	}

	// A single-checkbox panel, rather than a full settings tab, since
	// there's exactly one preference to expose here (celebration effects
	// on/off). Centered over the whole viewport (via a fixed backdrop
	// appended to <body>, not anchored under the gear button) so it's
	// never clipped/off-position regardless of where the tracker sits on
	// the page or how far the note is scrolled.
	toggleSettingsPanel() {
		const existing = document.querySelector(".habit-tracker-settings-backdrop");
		if (existing) {
			existing.remove();
			return;
		}
		const backdrop = document.body.createDiv({ cls: "habit-tracker-settings-backdrop" });
		const panel = backdrop.createDiv({ cls: "habit-tracker-settings-panel" });
		panel.createEl("h4", { text: "Habit Tracker Settings" });
		const label = panel.createEl("label", { cls: "habit-tracker-settings-row" });
		const checkbox = label.createEl("input");
		checkbox.type = "checkbox";
		checkbox.checked = this.plugin.settings.celebrationEffectsEnabled;
		label.createSpan({ text: "🎉 Celebrate when marking a habit (confetti + sound)" });
		checkbox.onchange = async () => {
			this.plugin.settings.celebrationEffectsEnabled = checkbox.checked;
			await this.plugin.saveSettings();
		};
		panel.createEl("h4", { text: "Danger Zone", cls: "habit-tracker-settings-danger-heading" });
		const resetBtn = panel.createEl("button", { text: "🗑️ Reset Habit Streak Data", cls: "habit-tracker-settings-danger-btn" });
		resetBtn.type = "button";

		const resetForm = panel.createDiv({ cls: "habit-tracker-reset-form" });
		resetBtn.onclick = () => {
			resetForm.toggleClass("habit-tracker-reset-form-visible", !resetForm.hasClass("habit-tracker-reset-form-visible"));
		};

		resetForm.createEl("label", { text: "What to reset", cls: "habit-tracker-settings-label" });
		const scopeSelect = resetForm.createEl("select", { cls: "dropdown habit-tracker-reset-scope" });
		scopeSelect.createEl("option", { text: "All habits", value: "__all__" });
		for (const h of this.plugin.data.habits) {
			scopeSelect.createEl("option", { text: habitDisplayName(h), value: h.id });
		}

		resetForm.createEl("p", {
			cls: "habit-tracker-reset-warning",
			text: "This permanently deletes all check-in history (streaks, totals, the heatmap) for the selected scope. The habit itself isn't deleted. This cannot be undone.",
		});

		resetForm.createEl("label", { text: 'Type "delete" to confirm', cls: "habit-tracker-settings-label" });
		const confirmInput = resetForm.createEl("input", { cls: "habit-tracker-reset-confirm-input" });
		confirmInput.type = "text";
		confirmInput.placeholder = "delete";
		confirmInput.autocomplete = "off";
		confirmInput.spellcheck = false;

		const confirmBtn = resetForm.createEl("button", { text: "Reset streak data", cls: "mod-warning habit-tracker-reset-confirm-btn" });
		confirmBtn.type = "button";
		confirmBtn.disabled = true;
		confirmInput.oninput = () => {
			confirmBtn.disabled = confirmInput.value.trim().toLowerCase() !== "delete";
		};
		confirmBtn.onclick = async () => {
			if (confirmInput.value.trim().toLowerCase() !== "delete") return;
			const scope = scopeSelect.value;
			if (scope === "__all__") {
				this.plugin.data.entries = {};
				new Notice("Reset check-in history for all habits.");
			} else {
				this.plugin.data.entries[scope] = {};
				const habitForScope = this.plugin.data.habits.find((h) => h.id === scope);
				const habitName = habitForScope ? habitDisplayName(habitForScope) : "that habit";
				new Notice(`Reset check-in history for "${habitName}".`);
			}
			await this.plugin.persist();
			this.plugin.refreshAll();
			backdrop.remove();
		};

		const closeBtn = panel.createEl("button", { text: "Done", cls: "mod-cta habit-tracker-settings-close" });
		closeBtn.type = "button";
		closeBtn.onclick = () => backdrop.remove();

		backdrop.onclick = (e) => {
			if (e.target === backdrop) backdrop.remove();
		};
		const closeOnEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			backdrop.remove();
			document.removeEventListener("keydown", closeOnEscape);
		};
		document.addEventListener("keydown", closeOnEscape);
	}

	// A one-off scheduled task: a single checkable row, not the full
	// heatmap/streak card a recurring habit gets. Completion reuses the
	// same entries[id][date] mechanism as habits — a task's one and only
	// trackable day is its own scheduledDate.
	renderTask(parentEl: HTMLElement, task: HabitDefinition, today: string) {
		const entries = this.plugin.data.entries[task.id] || (this.plugin.data.entries[task.id] = {});
		const date = task.scheduledDate ?? today;
		const done = !!entries[date];
		const overdue = !done && date < today;

		const row = parentEl.createDiv({ cls: "habit-tracker-task-row" + (done ? " habit-tracker-task-row-done" : "") + (overdue ? " habit-tracker-task-row-overdue" : "") });
		row.style.setProperty("--habit-color", task.color);

		const header = row.createDiv({ cls: "habit-tracker-task-header" });

		const checkbox = header.createEl("input", { cls: "habit-tracker-task-checkbox" });
		checkbox.type = "checkbox";
		checkbox.checked = done;
		checkbox.setAttr("aria-label", `Mark "${task.name}" done`);
		checkbox.onchange = async () => {
			if (checkbox.checked) {
				entries[date] = true;
				task.archived = true;
			} else {
				delete entries[date];
				task.archived = false;
			}
			await this.plugin.persist();
			this.plugin.refreshAll();
			if (checkbox.checked) this.plugin.maybeCelebrateAllTasksDoneForDate(date);
		};

		const dot = header.createSpan({ cls: "habit-tracker-dot" });
		dot.style.backgroundColor = task.color;
		header.createSpan({ text: task.name, cls: "habit-tracker-task-name" });
		header.createSpan({ text: overdue ? `⚠️ Overdue (${date})` : date, cls: "habit-tracker-task-date" });

		const editBtn = header.createSpan({ text: "✏️", cls: "habit-tracker-edit-btn" });
		editBtn.setAttr("aria-label", "Edit task");
		editBtn.onclick = () => {
			new HabitFormModal(this.plugin.app, this.plugin, {
				title: "Edit task",
				submitLabel: "Save",
				initial: task,
				onSubmit: async (values) => {
					task.name = values.name;
					task.color = values.color;
					task.kind = values.kind;
					task.scheduledDate = values.kind === "task" ? values.scheduledDate : undefined;
					if (values.kind === "task") task.archived = false;
					task.type = values.type;
					task.stackedAfter = values.stackedAfter || undefined;
					task.craving = values.craving || undefined;
					task.minimumVersion = values.minimumVersion || undefined;
					task.reward = values.reward || undefined;
					task.identity = values.identity || undefined;
					task.linkedGoal = values.linkedGoal || undefined;
					await this.plugin.persist();
					this.plugin.refreshAll();
				},
			}).open();
		};

		const deleteBtn = header.createSpan({ text: "🗑", cls: "habit-tracker-delete-btn" });
		deleteBtn.setAttr("aria-label", "Delete task");
		deleteBtn.onclick = () => {
			// Tasks are one-off, not streak history — always a quick confirm.
			new ConfirmDeleteModal(this.plugin, task.name, 0, async () => {
				this.plugin.data.habits = this.plugin.data.habits.filter((h) => h.id !== task.id);
				delete this.plugin.data.entries[task.id];
				await this.plugin.persist();
				this.plugin.refreshAll();
			}).open();
		};

		// Same accountability levers as a habit — captured on the same form,
		// so worth surfacing here too rather than only at creation time.
		if (task.identity) {
			row.createDiv({ text: `→ ${task.identity}`, cls: "habit-tracker-identity" });
		}
		if (task.stackedAfter) {
			row.createDiv({ text: `⛓ Cue: ${task.stackedAfter}`, cls: "habit-tracker-meta-line" });
		}
		if (task.craving) {
			row.createDiv({ text: `🍯 Craving: ${task.craving}`, cls: "habit-tracker-meta-line" });
		}
		if (task.minimumVersion) {
			row.createDiv({ text: `💡 Routine: ${task.minimumVersion}`, cls: "habit-tracker-meta-line" });
		}
		if (task.reward) {
			row.createDiv({ text: `🎉 Reward: ${task.reward}`, cls: "habit-tracker-meta-line" });
		}
		if (task.linkedGoal) {
			const goalLink = row.createDiv({ text: `🎯 ${task.linkedGoal}`, cls: "habit-tracker-meta-line habit-tracker-goal-link" });
			const openGoal = () => this.plugin.app.workspace.openLinkText(task.linkedGoal!, "", false);
			goalLink.onclick = openGoal;
			goalLink.setAttr("tabindex", "0");
			goalLink.setAttr("role", "link");
			goalLink.setAttr("aria-label", `Open goal: ${task.linkedGoal}`);
			goalLink.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openGoal();
				}
			});
		}
	}

	// The Streaks view: every habit and task on one screen, in tracker
	// order, each with its records, its consistency, and a rolling-365-day
	// timeline. Read-only by design — this is where you go to understand the
	// history, not to change it, so no cell here is clickable.
	renderStreaksPage(el: HTMLElement, items: HabitDefinition[]) {
		const page = el.createDiv({ cls: "habit-tracker-streaks" });

		if (items.length === 0) {
			const empty = page.createDiv({ cls: "habit-tracker-empty" });
			empty.createDiv({ text: copyText(this.plugin.settings.designCopy, "st.emptyIcon"), cls: "habit-tracker-empty-icon" });
			empty.createDiv({ text: "Nothing to break down yet", cls: "habit-tracker-empty-title" });
			return;
		}

		for (const item of items) {
			const entries = this.plugin.data.entries[item.id] || {};
			const isTask = item.kind === "task";
			const row = page.createDiv({ cls: "habit-tracker-streaks-row" });
			row.style.setProperty("--habit-color", item.color);

			// --- header
			const head = row.createDiv({ cls: "habit-tracker-streaks-head" });
			const dot = head.createSpan({ cls: "habit-tracker-dot" });
			dot.style.backgroundColor = item.color;
			head.createSpan({ text: habitDisplayName(item), cls: "habit-tracker-streaks-name" });
			if (isTask) {
				head.createSpan({ text: "TASK", cls: "habit-tracker-schedule-badge" });
			} else if (!isDailyHabit(item)) {
				head.createSpan({
					text: habitScheduledDays(item).map((d) => WEEKDAY_SHORT[d]).join(" · "),
					cls: "habit-tracker-schedule-badge",
				});
			}

			// --- records + analytics
			const statGrid = row.createDiv({ cls: "habit-tracker-streaks-stats" });
			// Icons match the ones the habit cards already use in the Day/
			// Week/Month views, so a metric is recognisable by the same glyph
			// wherever it appears — the Streaks grid was the one surface
			// showing these numbers with bare labels.
			const stat = (label: string, value: string, title?: string, icon?: string) => {
				const cell = statGrid.createDiv({ cls: "habit-tracker-streaks-stat" });
				cell.createDiv({ text: value, cls: "habit-tracker-streaks-stat-value" });
				const labelEl = cell.createDiv({ cls: "habit-tracker-streaks-stat-label" });
				if (icon) labelEl.createSpan({ text: icon, cls: "habit-tracker-streaks-stat-icon" });
				labelEl.createSpan({ text: label });
				if (title) cell.setAttr("title", title);
			};
			const cd = this.plugin.settings.designCopy;
			// A Break habit counts clean days, so it takes the shield the
			// card's streak pill uses rather than the flame.
			const streakIcon = copyText(cd, item.type === "break" ? "stat.cleanIcon" : "stat.streakIcon");

			if (isTask) {
				// A task is a one-off: it has no streak to speak of, so the
				// streak columns show an em-dash with an explanation rather
				// than a misleading zero or an empty hole in the grid.
				const done = Object.keys(entries).some((d) => entries[d]);
				stat("streak", "—", "Tasks are one-offs — they don't carry a streak.", streakIcon);
				stat("best", "—", "Tasks are one-offs — they don't carry a streak.", copyText(cd, "stat.bestIcon"));
				stat("status", done ? "done" : "open", undefined, copyText(cd, "streaks.statusIcon"));
				stat("scheduled", item.scheduledDate ?? "—", undefined, copyText(cd, "streaks.scheduledIcon"));
			} else {
				const stats = computeStats(item, entries);
				const runs = computeStreakRuns(item, entries);
				const con = computeConsistency(item, entries);
				const unit = isDailyHabit(item) ? "days" : "sessions";

				stat("current", `${stats.streak}`, `Counted in ${unit}.`, streakIcon);
				stat("best", `${stats.bestStreak}`, `Longest run ever, counted in ${unit}.`, copyText(cd, "stat.bestIcon"));
				stat("completions", `${stats.total}`, undefined, copyText(cd, "streaks.completionsIcon"));
				stat(
					"consistency",
					`${con.rate}%`,
					`${con.met} of ${con.owed} ${unit} owed since ${item.createdAt}. Today is excluded — the day isn't over.`,
					copyText(cd, "streaks.consistencyIcon")
				);

				// Trend only means something once there's a prior window to
				// compare against, so it's omitted rather than faked at zero.
				if (con.owed >= 40) {
					const delta = con.recentRate - con.priorRate;
					const arrow = delta > 2 ? "↑" : delta < -2 ? "↓" : "→";
					const trendCls =
						delta > 2 ? " habit-tracker-streaks-trend-up" : delta < -2 ? " habit-tracker-streaks-trend-down" : "";
					const cell = statGrid.createDiv({ cls: "habit-tracker-streaks-stat" + trendCls });
					cell.createDiv({ text: `${arrow} ${con.recentRate}%`, cls: "habit-tracker-streaks-stat-value" });
					const trendLabel = cell.createDiv({ cls: "habit-tracker-streaks-stat-label" });
					trendLabel.createSpan({ text: copyText(cd, "streaks.trendIcon"), cls: "habit-tracker-streaks-stat-icon" });
					trendLabel.createSpan({ text: "last 30" });
					cell.setAttr("title", `Last 30 ${unit}: ${con.recentRate}% vs ${con.priorRate}% the 30 before.`);
				}

				// --- past runs
				const finished = runs.filter((r) => r.brokenOn).reverse().slice(0, 4);
				if (finished.length > 0) {
					const runsEl = row.createDiv({ cls: "habit-tracker-streaks-runs" });
					runsEl.createSpan({ text: "past runs", cls: "habit-tracker-streaks-runs-label" });
					for (const r of finished) {
						const chip = runsEl.createSpan({ cls: "habit-tracker-streaks-run" });
						chip.createSpan({ text: `${r.length}`, cls: "habit-tracker-streaks-run-len" });
						chip.createSpan({ text: `${shortDate(r.start)} – ${shortDate(r.end)}`, cls: "habit-tracker-streaks-run-range" });
						chip.setAttr("title", `${r.length} ${unit}, ${r.start} to ${r.end}. Broke on ${r.brokenOn}.`);
					}
				}
			}

			// --- rolling 365-day timeline
			const tl = row.createDiv({ cls: "habit-tracker-streaks-timeline" });
			const created = item.createdAt;
			for (let i = 364; i >= 0; i--) {
				const d = addDays(new Date(), -i);
				const dateStr = formatDate(d);
				const cell = tl.createDiv({ cls: "habit-tracker-tl-cell" });
				if (dateStr < created) {
					cell.addClass("habit-tracker-tl-pre");
					continue;
				}
				const offDay = !isTask && !isDailyHabit(item) && !isScheduledOn(item, d);
				if (entries[dateStr]) {
					cell.addClass(offDay ? "habit-tracker-tl-repair" : "habit-tracker-tl-done");
					if (entries[dateStr] === "min") cell.addClass("habit-tracker-tl-min");
					cell.style.backgroundColor = item.color;
				} else if (offDay) {
					cell.addClass("habit-tracker-tl-off");
				} else if (dateStr < todayStr() && !isTask) {
					cell.addClass("habit-tracker-tl-missed");
				}
				cell.setAttr("title", `${dateStr}${entries[dateStr] ? " — done" : offDay ? " — not scheduled" : ""}`);
			}

			// Anchors under the rail. Without them the timeline is a bar of
			// colour with no indication of which end is now — and for a
			// young habit, no way to tell a short history from a broken
			// layout.
			const scale = row.createDiv({ cls: "habit-tracker-streaks-scale" });
			scale.createSpan({ text: "1 year ago" });
			scale.createSpan({ text: "today" });
			// The start marker is positioned at the point on the rail where
			// the habit actually begins, not centred — a centred label would
			// claim every habit started six months ago. Suppressed near
			// either end, where it would collide with the fixed anchors.
			const daysOld = Math.round((Date.now() - new Date(created + "T00:00:00").getTime()) / 86400000);
			if (daysOld <= 364) {
				const pct = ((364 - daysOld) / 364) * 100;
				if (pct > 14 && pct < 84) {
					const marker = scale.createSpan({ text: `started ${shortDate(created)}`, cls: "habit-tracker-streaks-scale-start" });
					marker.style.left = `${pct}%`;
				}
			}
		}
	}

	renderHabit(parentEl: HTMLElement, habit: HabitDefinition) {
		const entries = this.plugin.data.entries[habit.id] || (this.plugin.data.entries[habit.id] = {});
		const stats = computeStats(habit, entries);
		const view = this.currentView;

		const card = parentEl.createDiv({ cls: "habit-tracker-habit" });
		card.setAttr("data-habit-id", habit.id);
		card.style.setProperty("--habit-color", habit.color);
		card.style.setProperty("--habit-color-contrast", contrastColor(habit.color));
		const isBreak = habit.type === "break";

		if (this.reorderModeActive) {
			card.addClass("habit-tracker-habit-reorderable");
			card.draggable = true;
			this.attachReorderHandlers(card, habit);
		}

		const header = card.createDiv({ cls: "habit-tracker-header" });
		const titleRow = header.createDiv({ cls: "habit-tracker-title-row" });
		if (this.reorderModeActive) {
			titleRow.createSpan({ text: "⠿", cls: "habit-tracker-drag-handle" });
		}
		const dot = titleRow.createSpan({ cls: "habit-tracker-dot" });
		dot.style.backgroundColor = habit.color;
		titleRow.createSpan({ text: habitDisplayName(habit), cls: "habit-tracker-name" });
		titleRow.createSpan({
			text: copyText(this.plugin.settings.designCopy, isBreak ? "card.break" : "card.build"),
			cls: "habit-tracker-type-badge" + (isBreak ? " habit-tracker-type-badge-break" : " habit-tracker-type-badge-build"),
		});
		// Only shown when the habit isn't daily — otherwise it'd be seven
		// redundant labels on every card.
		if (habit.kind !== "task" && !isDailyHabit(habit)) {
			titleRow.createSpan({
				text: habitScheduledDays(habit).map((d) => WEEKDAY_SHORT[d]).join(" · "),
				cls: "habit-tracker-schedule-badge",
			});
		}

		// Primary row: only the two numbers that matter for a daily glance
		// (current streak, lifetime votes). best/week/month/year are real
		// and still one click away, but they were previously six co-equal
		// pills competing for attention — a design-review finding — so they
		// move to a visually demoted secondary row below instead.
		const statsRow = header.createDiv({ cls: "habit-tracker-stats-row" });
		const streakPill = statsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-streak" });
		streakPill.createSpan({ text: copyText(this.plugin.settings.designCopy, isBreak ? "stat.cleanIcon" : "stat.streakIcon"), cls: "habit-tracker-pill-icon" });
		streakPill.createSpan({ text: `${stats.streak}`, cls: "habit-tracker-pill-value" });
		streakPill.createSpan({ text: copyText(this.plugin.settings.designCopy, isBreak ? "stat.clean" : "stat.streak"), cls: "habit-tracker-pill-label" });
		// The streak is being held rather than counted forward: a scheduled
		// day was missed but an off-day repair is still possible. Say by
		// when, since the whole point is that it's recoverable.
		if (stats.atRisk && stats.repairBy) {
			streakPill.addClass("habit-tracker-pill-streak-at-risk");
			const by = new Date(stats.repairBy + "T00:00:00");
			statsRow.createSpan({
				text: copyText(this.plugin.settings.designCopy, "stat.repair").replace(
					"{day}",
					by.toLocaleString("default", { weekday: "long" })
				),
				cls: "habit-tracker-repair-hint",
			});
		}

		const totalPill = statsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-votes" });
		totalPill.createSpan({ text: `${stats.total}`, cls: "habit-tracker-pill-value" });
		totalPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.votes"), cls: "habit-tracker-pill-label" });

		// Appended to `card`, not `header` — header is a flex row shared
		// with the title and edit/delete actions, and a second full-width
		// row of pills would compete with those for header's own flex-wrap
		// layout. Sitting below the header as its own block avoids that.
		const secondaryStatsRow = card.createDiv({ cls: "habit-tracker-stats-row habit-tracker-stats-row-secondary" });
		const bestPill = secondaryStatsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-best" });
		bestPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.bestIcon"), cls: "habit-tracker-pill-icon" });
		bestPill.createSpan({ text: `${stats.bestStreak}`, cls: "habit-tracker-pill-value" });
		bestPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.best"), cls: "habit-tracker-pill-label" });

		const weekPill = secondaryStatsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-week" });
		weekPill.createSpan({ text: `${stats.totalThisWeek}`, cls: "habit-tracker-pill-value" });
		weekPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.week"), cls: "habit-tracker-pill-label" });

		const monthPill = secondaryStatsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-month" });
		monthPill.createSpan({ text: `${stats.totalThisMonth}`, cls: "habit-tracker-pill-value" });
		monthPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.month"), cls: "habit-tracker-pill-label" });

		const yearPill = secondaryStatsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-year" });
		yearPill.createSpan({ text: `${stats.totalThisYear}`, cls: "habit-tracker-pill-value" });
		yearPill.createSpan({ text: copyText(this.plugin.settings.designCopy, "stat.year"), cls: "habit-tracker-pill-label" });

		// Own container, deliberately kept separate from statsRow — the
		// number of stat pills can grow (and does, per-habit-type), and
		// these two buttons must never be the thing that gets squeezed off
		// the edge on a narrow/mobile viewport as a result. See styles.css
		// .habit-tracker-actions for the flex-shrink:0 + wrap handling.
		const actionsRow = header.createDiv({ cls: "habit-tracker-actions" });

		const editBtn = actionsRow.createSpan({
			text: "✏️",
			cls: "habit-tracker-edit-btn" + (this.reorderModeActive ? " habit-tracker-action-btn-disabled" : ""),
		});
		editBtn.setAttr("aria-label", "Edit habit");
		editBtn.onclick = () => {
			// Editing/deleting mid-drag is confusing (the array index the
			// click was aimed at can shift under a pending drag), so both
			// actions are simply no-ops while reorder mode is active — same
			// pattern as the grid cells below, rather than removing the
			// buttons entirely (keeps the layout stable while toggling).
			if (this.reorderModeActive) return;
			new HabitFormModal(this.plugin.app, this.plugin, {
				title: "Edit habit",
				submitLabel: "Save",
				initial: habit,
				onSubmit: async (values) => {
					habit.name = values.name;
					// Not part of habitFieldsFromFormValues (which deliberately
					// omits id/createdAt/kind), so it has to be assigned here
					// or an edited start date would silently not stick.
					if (values.createdAt) habit.createdAt = values.createdAt;
					habit.color = values.color;
					habit.type = values.type;
					habit.kind = values.kind;
					habit.scheduledDate = values.kind === "task" ? values.scheduledDate : undefined;
					// Changing a task's scheduled date is how you reschedule a
					// missed/overdue one — un-archive it so it re-enters the
					// pending list under its new date instead of staying stuck
					// in Done/overdue limbo.
					if (values.kind === "task") habit.archived = false;
					habit.alarmEnabled = values.kind === "task" ? undefined : values.alarmEnabled;
					habit.alarmTime = values.kind === "task" ? undefined : values.alarmTime;
					habit.alarmRepeatMinutes = values.kind === "task" ? undefined : values.alarmRepeatMinutes;
					habit.timeOfDay = values.kind === "task" ? undefined : (values.timeOfDay || undefined);
					habit.scheduledDays =
						values.kind === "task" || values.scheduledDays.length >= 7 ? undefined : [...values.scheduledDays].sort();
					habit.stackedAfter = values.stackedAfter || undefined;
					habit.craving = values.craving || undefined;
					habit.minimumVersion = values.minimumVersion || undefined;
					habit.reward = values.reward || undefined;
					habit.identity = values.identity || undefined;
					habit.linkedGoal = values.linkedGoal || undefined;
					await this.plugin.persist();
					this.plugin.refreshAll();
				},
				onSplit: async (originalValues, copyValues) => {
					Object.assign(habit, habitFieldsFromFormValues(originalValues));
					if (originalValues.createdAt) habit.createdAt = originalValues.createdAt;
					// The copy's `name` is unchanged from the original by
					// design (only Time of Day differs) — the "-copy-" infix
					// avoids colliding with an id minted from the same
					// slugified name at the same millisecond elsewhere.
					const copyId = slugify(copyValues.name) + "-copy-" + Date.now();
					const copyHabit: HabitDefinition = {
						id: copyId,
						// Deliberately today, NOT the original's start date:
						// this half is split off an existing habit and gets a
						// brand-new empty entry set below, so inheriting the
						// original's history window would make it owe every
						// day since then with nothing logged — opening at 0%.
						createdAt: todayStr(),
						kind: "habit",
						...habitFieldsFromFormValues(copyValues),
					};
					this.plugin.data.habits.push(copyHabit);
					this.plugin.data.entries[copyId] = {};
					await this.plugin.persist();
					this.plugin.refreshAll();
					new Notice(`Split into "${habitDisplayName(habit)}" and "${habitDisplayName(copyHabit)}".`);
				},
			}).open();
		};

		// Archive (or, for an already-archived habit, Restore) sits between
		// Edit and Delete — a reversible middle ground for a habit you're
		// done with but don't want to lose history/streak on, one click
		// short of the permanent, typed-confirm Delete beside it.
		if (habit.archived) {
			const restoreBtn = actionsRow.createSpan({
				text: "↩️",
				cls: "habit-tracker-restore-btn" + (this.reorderModeActive ? " habit-tracker-action-btn-disabled" : ""),
			});
			restoreBtn.setAttr("aria-label", "Restore habit");
			restoreBtn.onclick = async () => {
				if (this.reorderModeActive) return;
				habit.archived = false;
				await this.plugin.persist();
				this.plugin.refreshAll();
			};
		} else {
			const archiveBtn = actionsRow.createSpan({
				text: "📦",
				cls: "habit-tracker-archive-btn" + (this.reorderModeActive ? " habit-tracker-action-btn-disabled" : ""),
			});
			archiveBtn.setAttr("aria-label", "Archive habit");
			archiveBtn.onclick = () => {
				if (this.reorderModeActive) return;
				new ConfirmArchiveModal(this.plugin, habitDisplayName(habit), async () => {
					habit.archived = true;
					await this.plugin.persist();
					this.plugin.refreshAll();
				}).open();
			};
		}

		const deleteBtn = actionsRow.createSpan({
			text: "🗑",
			cls: "habit-tracker-delete-btn" + (this.reorderModeActive ? " habit-tracker-action-btn-disabled" : ""),
		});
		deleteBtn.setAttr("aria-label", "Delete habit");
		deleteBtn.onclick = () => {
			if (this.reorderModeActive) return;
			new ConfirmDeleteModal(this.plugin, habitDisplayName(habit), Object.keys(entries).length, async () => {
				this.plugin.data.habits = this.plugin.data.habits.filter((h) => h.id !== habit.id);
				delete this.plugin.data.entries[habit.id];
				this.yearScrollByHabit.delete(habit.id);
				await this.plugin.persist();
				this.plugin.refreshAll();
			}).open();
		};

		// Days-to-next-milestone bubble, sourced from the same configurable
		// settings.milestones list as maybeCelebrate()/playCelebrationChime()
		// (see HabitTrackerPlugin.sortedMilestones()). On the exact day a
		// milestone is hit, this flips to an "Achieved" state for the rest
		// of that day; the next tracked day (once the streak moves past
		// that milestone number) it reverts to counting down to whichever
		// milestone comes next.
		const milestones = this.plugin.sortedMilestones();
		const milestoneBubble = card.createDiv({ cls: "habit-tracker-milestone-bubble" });
		if (milestones.length === 0) {
			milestoneBubble.remove();
		} else if (milestones.includes(stats.streak)) {
			milestoneBubble.addClass("habit-tracker-milestone-bubble-achieved");
			milestoneBubble.setText(copyText(this.plugin.settings.designCopy, "ms.achieved", { n: stats.streak }));
		} else {
			const nextMilestone = milestones.find((m) => m > stats.streak);
			if (nextMilestone !== undefined) {
				const daysLeft = nextMilestone - stats.streak;
				milestoneBubble.setText(copyText(this.plugin.settings.designCopy, "ms.next", { n: daysLeft, dayWord: daysLeft === 1 ? "day" : "days" }));
			} else {
				milestoneBubble.addClass("habit-tracker-milestone-bubble-achieved");
				milestoneBubble.setText(copyText(this.plugin.settings.designCopy, "ms.allDone"));
			}
		}

		// Atomic Habits detail line(s) — only rendered when set, so a habit
		// with none of these looks exactly as plain as before.
		//
		// The identity line stays permanently visible: it's the "who you're
		// becoming" anchor and the whole point of the system. The Four Laws
		// levers below it (cue/craving/routine/reward/goal) collapse behind
		// a toggle instead of re-rendering in full every day forever — they
		// matter most at creation/review time, and previously crowded out
		// the one thing a daily glance actually needs (is today checked in).
		// Expanded state is per-habit, in-memory only, same pattern as
		// currentView/reorderModeActive — resets on a fresh block load.
		if (habit.identity) {
			card.createDiv({ text: copyText(this.plugin.settings.designCopy, "card.identityPrefix") + habit.identity, cls: "habit-tracker-identity" });
		}

		const leverBits: Array<{ text: string; goal?: boolean }> = [];
		if (habit.stackedAfter) leverBits.push({ text: copyText(this.plugin.settings.designCopy, "card.cuePrefix") + habit.stackedAfter });
		if (habit.craving) leverBits.push({ text: copyText(this.plugin.settings.designCopy, "card.cravingPrefix") + habit.craving });
		if (habit.minimumVersion) leverBits.push({ text: copyText(this.plugin.settings.designCopy, "card.routinePrefix") + habit.minimumVersion });
		if (habit.reward) leverBits.push({ text: copyText(this.plugin.settings.designCopy, "card.rewardPrefix") + habit.reward });
		if (habit.linkedGoal) leverBits.push({ text: copyText(this.plugin.settings.designCopy, "card.goalPrefix") + habit.linkedGoal, goal: true });

		if (leverBits.length) {
			// Default open/closed comes from the Design Tweaks panel; the
			// per-habit toggle still wins once the user touches it, tracked
			// in collapsedLevers/expandedLevers depending on which way the
			// default points.
			const defaultOpen = tweakValue(this.plugin.settings.designTweaks, "formulaDefault") === "open";
			const expanded = defaultOpen ? !this.collapsedLevers.has(habit.id) : this.expandedLevers.has(habit.id);
			const toggle = card.createDiv({
				cls: "habit-tracker-levers-toggle",
				text: expanded ? copyText(this.plugin.settings.designCopy, "card.formulaHide") : copyText(this.plugin.settings.designCopy, "card.formulaShow", { n: leverBits.length }),
			});
			toggle.setAttr("tabindex", "0");
			toggle.setAttr("role", "button");
			toggle.setAttr("aria-expanded", expanded ? "true" : "false");
			const toggleLevers = () => {
				// Two sets rather than one, because "toggled" means the
				// opposite thing depending on which way the default points:
				// with a closed default we track who's been opened, with an
				// open default we track who's been closed. Flipping the
				// default in the panel then re-reads correctly instead of
				// inverting everyone's existing choice.
				const set = defaultOpen ? this.collapsedLevers : this.expandedLevers;
				if (set.has(habit.id)) set.delete(habit.id);
				else set.add(habit.id);
				this.render();
			};
			toggle.onclick = toggleLevers;
			toggle.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggleLevers();
				}
			});

			if (expanded) {
				const leversWrap = card.createDiv({ cls: "habit-tracker-levers-panel" });
				leverBits.forEach((bit) => {
					if (!bit.goal) {
						leversWrap.createDiv({ text: bit.text, cls: "habit-tracker-meta-line" });
						return;
					}
					const goalLink = leversWrap.createDiv({ text: bit.text, cls: "habit-tracker-meta-line habit-tracker-goal-link" });
					const openGoal = () => this.plugin.app.workspace.openLinkText(habit.linkedGoal!, "", false);
					goalLink.onclick = openGoal;
					goalLink.setAttr("tabindex", "0");
					goalLink.setAttr("role", "link");
					goalLink.setAttr("aria-label", `Open goal: ${habit.linkedGoal}`);
					goalLink.addEventListener("keydown", (e: KeyboardEvent) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							openGoal();
						}
					});
				});
			}
		}

		const grid = card.createDiv({ cls: "habit-tracker-grid-wrap" });
		grid.setAttr("data-habit-id", habit.id);
		if (view === "day") {
			this.renderDayGrid(grid, habit, entries, this.selectedDayOffset);
		} else if (view === "week") {
			this.renderWeekGrid(grid, habit, entries, this.selectedWeekOffset);
		} else if (view === "month") {
			this.renderMonthGrid(grid, habit, entries, this.selectedMonthOffset);
		} else if (view === "yeardays") {
			this.renderYearDaysGrid(grid, habit, entries, this.selectedYearOffset);
		} else {
			this.renderYearGrid(grid, habit, entries, this.selectedYearOffset);
		}
	}

	// Vanilla HTML5 drag-and-drop wiring for one reorderable habit card.
	// Only ever called when this.reorderModeActive is true (see
	// renderHabit above) — cards behave exactly as before when it's off.
	attachReorderHandlers(card: HTMLElement, habit: HabitDefinition) {
		card.addEventListener("dragstart", (event: DragEvent) => {
			this.draggedHabitId = habit.id;
			card.addClass("habit-tracker-habit-dragging");
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "move";
				// Best-effort only — the actual reorder logic relies on
				// this.draggedHabitId (see comment on that field above),
				// not on reading this back out on drop.
				event.dataTransfer.setData("text/plain", habit.id);
			}
		});

		card.addEventListener("dragover", (event: DragEvent) => {
			if (!this.draggedHabitId || this.draggedHabitId === habit.id) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			const rect = card.getBoundingClientRect();
			const isAbove = event.clientY - rect.top < rect.height / 2;
			card.toggleClass("habit-tracker-habit-drop-above", isAbove);
			card.toggleClass("habit-tracker-habit-drop-below", !isAbove);
		});

		card.addEventListener("dragleave", () => {
			card.removeClass("habit-tracker-habit-drop-above");
			card.removeClass("habit-tracker-habit-drop-below");
		});

		card.addEventListener("drop", async (event: DragEvent) => {
			event.preventDefault();
			const droppedAbove = card.hasClass("habit-tracker-habit-drop-above");
			card.removeClass("habit-tracker-habit-drop-above");
			card.removeClass("habit-tracker-habit-drop-below");

			const draggedId = this.draggedHabitId;
			this.draggedHabitId = null;
			if (!draggedId || draggedId === habit.id) return;

			const habits = this.plugin.data.habits;
			const fromIndex = habits.findIndex((h) => h.id === draggedId);
			if (fromIndex === -1) return;

			const [moved] = habits.splice(fromIndex, 1);
			// Re-find the target's index after the splice above, since
			// removing an earlier element shifts every later index down by
			// one — inserting at the stale index would land one slot off
			// whenever the drag moved a card downward.
			let insertAt = habits.findIndex((h) => h.id === habit.id);
			if (insertAt === -1) insertAt = habits.length;
			if (!droppedAbove) insertAt += 1;

			// No-op guard: dropping a card back into the exact slot it came
			// from (e.g. dropped on itself's old neighbor with no real
			// order change) skips persist/refresh entirely.
			if (insertAt === fromIndex) {
				habits.splice(fromIndex, 0, moved);
				return;
			}

			habits.splice(insertAt, 0, moved);
			await this.plugin.persist();
			this.plugin.refreshAll();
		});

		card.addEventListener("dragend", () => {
			this.draggedHabitId = null;
			card.removeClass("habit-tracker-habit-dragging");
			card.removeClass("habit-tracker-habit-drop-above");
			card.removeClass("habit-tracker-habit-drop-below");
		});
	}

	renderYearGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>, yearOffset: number = 0) {
		const year = new Date().getFullYear() + yearOffset;
		const jan1 = new Date(year, 0, 1);
		const dec31 = new Date(year, 11, 31);
		// Start columns at Jan 1 itself (not the nearest Sunday) so every
		// month's cells begin flush at the top row — no leading blank
		// padding days from the previous year pushing January down.
		const start = jan1;
		const totalDays = Math.round((dec31.getTime() - start.getTime()) / 86400000) + 1;
		const weeks = Math.ceil(totalDays / 7);

		container.createDiv({ text: `${year}`, cls: "habit-tracker-month-title" });

		const monthRow = container.createDiv({ cls: "habit-tracker-months" });
		const gridEl = container.createDiv({ cls: "habit-tracker-grid" });
		gridEl.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;

		let lastMonth = -1;
		for (let w = 0; w < weeks; w++) {
			const colStart = addDays(start, w * 7);
			const label = monthRow.createSpan({ cls: "habit-tracker-month-label" });
			if (colStart.getFullYear() === year && colStart.getMonth() !== lastMonth) {
				label.setText(colStart.toLocaleString("default", { month: "short" }));
				lastMonth = colStart.getMonth();
			}
		}

		// DOM insertion order must be column-major (all rows of week 0, then
		// all rows of week 1, ...) to match the CSS's `grid-auto-flow:
		// column` — otherwise each cell's visual position doesn't match the
		// date baked into it, and clicks land on the wrong day.
		for (let w = 0; w < weeks; w++) {
			for (let row = 0; row < 7; row++) {
				const d = addDays(start, w * 7 + row);
				if (d.getFullYear() !== year) {
					// Padding day from the previous/next year, needed to keep
					// weeks aligned to Sunday — not a real trackable day.
					const blank = gridEl.createDiv({ cls: "habit-tracker-cell habit-tracker-cell-blank" });
					continue;
				}
				this.renderCell(gridEl, habit, entries, d, "year");
			}
		}

		// Keep the current month in focus: restore this habit's previous
		// scroll position if we captured one (so checking/unchecking days
		// doesn't keep snapping the view back to January), otherwise this
		// is the first render and we center on today's column by default.
		const savedScroll = this.yearScrollByHabit.get(habit.id);
		requestAnimationFrame(() => {
			if (savedScroll !== undefined) {
				container.scrollLeft = savedScroll;
			} else {
				const todayCell = gridEl.querySelector(`[data-date="${todayStr()}"]`) as HTMLElement | null;
				todayCell?.scrollIntoView({ inline: "center", block: "nearest" });
			}
		});
	}

	// Day view: one full-width check bar per habit instead of a grid.
	// Deliberately not "a bigger square" — a lone cell leaves most of the
	// card empty and reads as a cropped Week view, whereas a bar spanning
	// the card reads as a checklist row and gives a large tap target on
	// mobile, which is where a today-only view is most useful.
	renderDayGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>, dayOffset: number = 0) {
		const d = addDays(new Date(), dayOffset);
		const gridEl = container.createDiv({ cls: "habit-tracker-day-grid" });
		this.renderCell(gridEl, habit, entries, d, "day");
	}

	renderWeekGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>, weekOffset: number = 0) {
		const today = new Date();
		const start = addDays(addDays(today, -today.getDay()), weekOffset * 7); // Sunday of the selected week

		const gridEl = container.createDiv({ cls: "habit-tracker-week-grid" });
		for (let i = 0; i < 7; i++) {
			const d = addDays(start, i);
			this.renderCell(gridEl, habit, entries, d, "week");
		}
	}

	renderMonthGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>, monthOffset: number = 0) {
		const today = new Date();
		const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
		const year = first.getFullYear();
		const month = first.getMonth();
		const lastOfMonth = new Date(year, month + 1, 0);
		// Day 1 always starts in column 1 (no leading blank cells aligning it
		// to its real weekday) — there's no weekday header anymore, so
		// calendar-aligning it just left day 1 stranded wherever its weekday
		// happened to fall with a run of empty cells before it.
		const start = first;
		const daysInMonth = lastOfMonth.getDate();
		const weeks = Math.ceil(daysInMonth / 7);

		container.createDiv({ text: first.toLocaleString("default", { month: "long", year: "numeric" }), cls: "habit-tracker-month-title" });

		const gridEl = container.createDiv({ cls: "habit-tracker-month-grid" });
		// Row-major order matches the grid's default (row) auto-flow.
		for (let w = 0; w < weeks; w++) {
			for (let col = 0; col < 7; col++) {
				const d = addDays(start, w * 7 + col);
				if (d.getMonth() !== month || d.getFullYear() !== year) {
					// Only trips for the trailing cells past the month's last
					// day (e.g. a 5-cell final row) — start is always the 1st.
					gridEl.createDiv({ cls: "habit-tracker-week-cell habit-tracker-cell-blank" });
					continue;
				}
				this.renderCell(gridEl, habit, entries, d, "month");
			}
		}
	}

	renderYearDaysGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>, yearOffset: number = 0) {
		const year = new Date().getFullYear() + yearOffset;
		const jan1 = new Date(year, 0, 1);
		const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		const totalDays = isLeap ? 366 : 365;

		container.createDiv({ text: `${year} — ${totalDays} days`, cls: "habit-tracker-month-title" });

		const gridEl = container.createDiv({ cls: "habit-tracker-yeardays-grid" });
		for (let i = 0; i < totalDays; i++) {
			const d = addDays(jan1, i);
			this.renderCell(gridEl, habit, entries, d, "yeardays", i + 1);
		}
	}

	renderCell(
		gridEl: HTMLElement,
		habit: HabitDefinition,
		entries: Record<string, EntryValue>,
		d: Date,
		style: CellStyle,
		dayNumberOverride?: number
	) {
		const today = new Date();
		const dateStr = formatDate(d);
		// `day` counts as boxed so it inherits the whole week/month state
		// vocabulary (-done / -missed / -future / -min) rather than needing a
		// parallel set; habit-tracker-day-cell only overrides the shape.
		const boxed = style === "week" || style === "month" || style === "day";
		const cellBaseCls =
			style === "day"
				? "habit-tracker-week-cell habit-tracker-day-cell"
				: style === "week" || style === "month"
				? "habit-tracker-week-cell"
				: style === "yeardays"
				? "habit-tracker-yeardays-cell"
				: "habit-tracker-cell";
		const cell = gridEl.createDiv({ cls: cellBaseCls });
		cell.setAttr("data-date", dateStr);

		// Scheduling state. A daily habit has no off-days, so all three of
		// these stay false and the cell behaves exactly as it always has.
		const offDay = !isDailyHabit(habit) && !isScheduledOn(habit, d);
		const isRepairEntry = offDay && !!entries[dateStr];
		const repairUnlocked = offDay && !entries[dateStr] && isRepairUnlocked(habit, entries, d);
		if (offDay) cell.addClass("habit-tracker-cell-offday");
		if (repairUnlocked) cell.addClass("habit-tracker-cell-repairable");
		if (isRepairEntry) cell.addClass("habit-tracker-cell-repair");
		// aria-label is set once state is known, below — every style gets
		// one (not just the unboxed year/year-days cells that lack a printed
		// date), since a screen-reader user needs the same done/missed/today
		// signal a sighted user reads off the cell's fill color.

		if (style === "day") {
			const when = cell.createDiv({ cls: "habit-tracker-day-when" });
			when.createSpan({ text: d.toLocaleString("default", { weekday: "long" }), cls: "habit-tracker-day-weekday" });
			when.createSpan({ text: d.toLocaleString("default", { month: "short", day: "numeric" }), cls: "habit-tracker-day-date" });
			// Order matters, and mirrors the aria stateWord built further
			// down so the bar and the screen-reader label never disagree:
			// an actual entry wins over everything, then repair states, then
			// an ordinary off-day, then time. Without the off-day branches a
			// Mon/Wed/Sat habit would read "Not yet — click to check off" on
			// a Tuesday it was never due.
			const v = entries[dateStr];
			const statusId = v
				? isRepairEntry
					? "day.repairDone"
					: v === "min"
					? "day.minDone"
					: "day.done"
				: repairUnlocked
				? "day.repairOpen"
				: offDay
				? "day.offDay"
				: d > today
				? "day.upcoming"
				: "day.notDone";
			cell.createDiv({ cls: "habit-tracker-day-status", text: copyText(this.plugin.settings.designCopy, statusId) });
		} else if (style === "week") {
			cell.createDiv({ text: d.toLocaleString("default", { weekday: "short" }), cls: "habit-tracker-week-day-label" });
			cell.createDiv({ text: "" + d.getDate(), cls: "habit-tracker-week-date-label" });
		} else if (style === "month") {
			cell.createDiv({ text: "" + d.getDate(), cls: "habit-tracker-week-date-label" });
		} else {
			cell.createSpan({ text: "" + (dayNumberOverride ?? d.getDate()), cls: "habit-tracker-cell-daynum" });
		}

		const futureCls = boxed ? "habit-tracker-week-cell-future" : "habit-tracker-cell-future";
		const doneCls = boxed ? "habit-tracker-week-cell-done" : "habit-tracker-cell-done";
		const missedCls = boxed ? "habit-tracker-week-cell-missed" : "habit-tracker-cell-missed";

		if (d > today) {
			cell.addClass(futureCls);
		}

		if (entries[dateStr]) {
			cell.addClass(doneCls);
			cell.style.backgroundColor = habit.color;
			if (entries[dateStr] === "min") {
				cell.addClass(boxed ? "habit-tracker-week-cell-min" : "habit-tracker-cell-min");
			}
		} else if (dateStr < todayStr() && !offDay) {
			// A day strictly before today with no entry — visibly greyed out
			// so a gap in the streak reads at a glance, in every view (year,
			// year-days, week, month all funnel through this one function).
			// Today itself is excluded even before it's checked off, since a
			// streak isn't broken until the day is actually over. Off-days
			// are excluded too: nothing was owed, so nothing was missed.
			cell.addClass(missedCls);
		}
		if (dateStr === todayStr()) {
			cell.addClass("habit-tracker-cell-today");
			if (isStreakAtRisk(habit, entries)) {
				cell.addClass("habit-tracker-cell-at-risk");
			}
		}

		// State-aware label for every style (not just the unboxed year/
		// year-days cells that lack a printed date) — a screen-reader user
		// needs "done"/"missed"/"today" the same way a sighted user reads it
		// off the cell's fill color, which boxed week/month cells don't
		// otherwise convey via their printed date+weekday text alone.
		const stateWord = entries[dateStr]
			? isRepairEntry
				? "made up on an off day"
				: entries[dateStr] === "min"
				? "minimum version done"
				: "done"
			: repairUnlocked
			? "off day, unlocked to make up a missed day"
			: offDay
			? "off day, not scheduled"
			: d > today
			? "upcoming"
			: dateStr < todayStr()
			? "missed"
			: "not yet done today";
		cell.setAttr("aria-label", `${habitDisplayName(habit)}, ${d.toDateString()}, ${stateWord}`);

		// While reorder mode is active, cell click-to-toggle is disabled
		// entirely (no handler attached, not just a no-op) so a drag
		// gesture starting/ending over a cell can never accidentally
		// register as a habit check-in. The card-level
		// habit-tracker-habit-reorderable class (styles.css) gives the
		// whole grid a dimmed, non-interactive look to match. Cells are also
		// pulled out of tab order in this state (tabindex -1) so reorder
		// mode doesn't leave a trail of dead focus stops across every card.
		if (this.reorderModeActive) {
			cell.setAttr("tabindex", "-1");
			return;
		}

		// A locked off-day is inert: the habit isn't due, and no missed day
		// has unlocked it for repair. An off-day that already holds a repair
		// stays clickable so a mistaken one can be cleared.
		if (offDay && !repairUnlocked && !entries[dateStr]) {
			cell.setAttr("tabindex", "-1");
			cell.setAttr("aria-disabled", "true");
			return;
		}

		const toggle = async () => {
			const oldStreak = computeStats(habit, entries).streak;
			const next = nextEntryValue(entries[dateStr]);
			if (next === undefined) {
				delete entries[dateStr];
			} else {
				entries[dateStr] = next;
			}
			await this.plugin.persist();
			if (!next) {
				// Clearing a day isn't a reward moment — refresh immediately.
				this.plugin.refreshAll();
				return;
			}
			// Checking a day off IS the core reward moment, but refreshAll()
			// rebuilds the whole DOM, which would destroy this exact cell
			// mid-animation. Paint the new state directly on it, play a
			// brief pop, then let the rebuild catch up.
			cell.style.backgroundColor = habit.color;
			cell.addClass(doneCls);
			if (next === "min") cell.addClass(boxed ? "habit-tracker-week-cell-min" : "habit-tracker-cell-min");
			cell.addClass("habit-tracker-cell-pop");
			const newStreak = computeStats(habit, entries).streak;
			if (this.plugin.settings.celebrationEffectsEnabled) {
				const card = cell.closest<HTMLElement>(".habit-tracker-habit");
				if (card) burstConfetti(card, cell, habit.color);
				playCelebrationChime(newStreak, this.plugin.settings.milestones.includes(newStreak));
			}
			window.setTimeout(() => {
				this.plugin.refreshAll();
				this.plugin.maybeCelebrate(habit, oldStreak, newStreak);
				if (dateStr === todayStr()) this.plugin.maybeCelebrateAllHabitsDoneToday();
			}, 160);
		};
		cell.onclick = toggle;
		cell.setAttr("tabindex", "0");
		cell.setAttr("role", "button");
		cell.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
	}
}

// ---- Dedicated full-tab view — same rendering as an unfiltered,
// no-options `habit-tracker` code block (all habits, "+ Add Habit",
// Year/Month/Week/Year-Days toggle), just opened in its own workspace tab
// instead of embedded in a note. HabitTrackerBlock itself already contains
// no markdown-specific logic (nothing touches MarkdownPostProcessorContext),
// so it's reused here as-is via Component.addChild — the same lifecycle
// mechanism the code-block processor uses via ctx.addChild — rather than
// duplicating its render logic. That also means this view's block
// auto-registers with/unregisters from the plugin's refreshAll() broadcast,
// same as any embedded block.
const HABIT_TRACKER_VIEW_TYPE = "habit-tracker-view";

class HabitTrackerView extends ItemView {
	plugin: HabitTrackerPlugin;
	block: HabitTrackerBlock | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: HabitTrackerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return HABIT_TRACKER_VIEW_TYPE;
	}
	getDisplayText() {
		return "Habit Tracker";
	}
	getIcon() {
		return "flame";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("habit-tracker-view-root");
		// No habit filter, "week" default — identical to what a bare
		// ```habit-tracker``` block with no options renders.
		this.block = new HabitTrackerBlock(root, this.plugin, null, "week");
		this.addChild(this.block);
	}

	async onClose() {
		// this.block is a child Component — Obsidian unloads/unregisters it
		// automatically when this view unloads, same as MarkdownRenderChild
		// cleanup for an embedded block.
	}
}

const SYNC_TABLE = "habit_tracker_data";

function mergeData(local: PluginData, remote: PluginData): PluginData {
	// Used once, at initial connect — unions rather than picks a winner, so
	// pre-existing divergent history on either side survives. After this
	// point, remote realtime updates just replace local state directly.
	const habitsById = new Map<string, HabitDefinition>();
	for (const h of remote.habits) habitsById.set(h.id, h);
	for (const h of local.habits) if (!habitsById.has(h.id)) habitsById.set(h.id, h);

	const entries: PluginData["entries"] = {};
	const allIds = new Set([...Object.keys(local.entries), ...Object.keys(remote.entries)]);
	for (const id of allIds) {
		entries[id] = { ...(remote.entries[id] || {}), ...(local.entries[id] || {}) };
	}

	const customColors = Array.from(new Set([...(remote.customColors ?? []), ...(local.customColors ?? [])]));
	const hasCreatedFirstHabit = !!(remote.hasCreatedFirstHabit || local.hasCreatedFirstHabit);

	return { habits: Array.from(habitsById.values()), entries, customColors, hasCreatedFirstHabit };
}

export default class HabitTrackerPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;
	supabase: SupabaseClient | null = null;
	session: Session | null = null;
	private realtimeChannel: RealtimeChannel | null = null;
	private blocks: Set<HabitTrackerBlock> = new Set();
	// In-memory only (doesn't need to persist/survive a restart) tracking of
	// each alarm's last fire, so checkAlarm() can space repeats apart
	// instead of nagging on every ~1-minute tick — one map entry per habit
	// id / last-call alarm id. lastAlarmTickDate resets all of this (plus
	// the last-call dismissed-today set) at the start of each new day, so a
	// repeat gap from late last night never delays today's very first nag,
	// and yesterday's dismissals never silently suppress today's.
	private habitAlarmLastFiredAt: Map<string, number> = new Map();
	private lastCallAlarmLastFiredAt: Map<string, number> = new Map();
	private lastCallDismissedToday: Map<string, string> = new Map(); // alarmId -> "YYYY-MM-DD" it was dismissed on
	private lastAlarmTickDate: string | null = null;
	// In-memory only, same reasoning as the alarm maps above — a stray
	// repeat popup after an app restart is harmless, so this doesn't need
	// to survive one or sync across devices. Habits only ever congratulate
	// for "today" (the grid can't check off a future/past day into "all
	// done"), so a single date is enough; tasks can complete a batch for
	// any scheduled date (including an overdue one), so that needs a set.
	private lastAllHabitsCongratsDate: string | null = null;
	private allTasksCongratsShownDates: Set<string> = new Set();

	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings);
		// Migrate old data.json without a milestones field, and guard against
		// a corrupt/non-array value — never crash load over it. Copied
		// (rather than sharing DEFAULT_MILESTONES/saved's array by
		// reference) since the settings tab mutates this array in place.
		this.settings.milestones =
			Array.isArray(saved?.settings?.milestones) && saved.settings.milestones.length > 0
				? [...saved.settings.milestones]
				: [...DEFAULT_MILESTONES];
		// Defensive migration, same spirit as milestones above: guard
		// against a corrupt/hand-edited data.json rather than letting it
		// silently break checkAlarm()'s comparisons.
		this.settings.lastCallAlarms = Array.isArray(saved?.settings?.lastCallAlarms) ? [...saved.settings.lastCallAlarms] : [];
		this.data = {
			habits: saved?.habits ?? DEFAULT_DATA.habits,
			entries: saved?.entries ?? DEFAULT_DATA.entries,
			customColors: saved?.customColors ?? DEFAULT_DATA.customColors,
			hasCreatedFirstHabit: saved?.hasCreatedFirstHabit ?? DEFAULT_DATA.hasCreatedFirstHabit,
		};

		this.addSettingTab(new HabitTrackerSettingTab(this.app, this));

		this.registerView(HABIT_TRACKER_VIEW_TYPE, (leaf) => new HabitTrackerView(leaf, this));
		this.addRibbonIcon("flame", "Open Habit Tracker", () => this.activateView());
		this.addCommand({ id: "open-habit-tracker", name: "Open Habit Tracker", callback: () => this.activateView() });
		// Deliberately command-only (no ribbon icon): this is a design tool
		// for tuning the look, not part of the daily check-in flow, so it
		// stays out of the way until deliberately summoned.
		this.addCommand({
			id: "open-design-tweaks",
			name: "Design Tweaks (live theme editor)",
			callback: () => TweakPanel.toggle(this),
		});

		this.registerMarkdownCodeBlockProcessor("habit-tracker", (source, el, ctx) => {
			const filterMatch = source.match(/^\s*habit:\s*(.+)\s*$/m);
			const filterName = filterMatch ? filterMatch[1].trim() : null;
			const viewMatch = source.match(/^\s*view:\s*(day|week|month|year|yeardays)\s*$/m);
			// Week is the default on every device unless the note explicitly
			// requests a different view.
			const defaultView: ViewMode = viewMatch ? (viewMatch[1] as ViewMode) : "week";
			const block = new HabitTrackerBlock(el, this, filterName, defaultView);
			ctx.addChild(block);
		});

		// Local fallback: pick up changes written to the local file by
		// another process (e.g. a manual restore) without requiring a
		// restart. This is a secondary safety net — the primary sync path
		// once signed in is the Supabase realtime subscription below.
		this.registerInterval(
			window.setInterval(async () => {
				const onDisk = await this.loadData();
				if (!onDisk) return;
				const onDiskData: PluginData = {
					habits: onDisk.habits ?? [],
					entries: onDisk.entries ?? {},
					customColors: onDisk.customColors ?? [],
					hasCreatedFirstHabit: onDisk.hasCreatedFirstHabit ?? false,
				};
				if (JSON.stringify(onDiskData) !== JSON.stringify(this.data)) {
					this.data = onDiskData;
					this.refreshAll();
				}
			}, 5000)
		);

		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
			await this.initSupabase();
		}

		// Check-in alarm: registerInterval (same pattern as the local-fallback
		// poll above) ties this to the plugin's lifecycle, so it's cleared
		// automatically on unload without needing an explicit clearInterval.
		// ~1-minute granularity is plenty for a "did you check in today"
		// nag — checkAlarm() itself decides whether alarmRepeatMinutes has
		// actually elapsed before firing anything.
		this.registerInterval(window.setInterval(() => this.checkAlarm(), 60000));
		// Also run once immediately, in case Obsidian is opened after the
		// alarm time has already passed — otherwise the first nag would wait
		// up to a full minute for no reason.
		this.checkAlarm();
	}

	// Runs every ~1 minute (see the registerInterval call above) and drives
	// both alarm kinds independently:
	//  - Per-habit alarms (HabitDefinition.alarmEnabled/alarmTime/
	//    alarmRepeatMinutes): fires once alarmTime passes local time and
	//    that specific habit isn't checked in yet today, repeating every
	//    alarmRepeatMinutes until it is. Re-reads this.data.entries fresh
	//    on every call (never a cached/stale snapshot), so checking in a
	//    habit naturally stops its nag on the very next tick.
	//  - Last call alarms (settings.lastCallAlarms): fires once their time
	//    passes local time, with no data condition to auto-silence it —
	//    it repeats every LAST_CALL_REPEAT_MINUTES until explicitly
	//    dismissed via the Notice's own Dismiss button, and that dismissal
	//    only holds for the rest of the current calendar day.
	checkAlarm() {
		const today = todayStr();
		const now = new Date();
		const nowStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
		const nowMs = Date.now();

		// Day-boundary reset: clear every alarm's "last fired" clock and the
		// last-call dismissed-today set once the calendar day rolls over, so
		// nothing carries over from yesterday and silently suppresses today.
		if (this.lastAlarmTickDate !== today) {
			this.habitAlarmLastFiredAt.clear();
			this.lastCallAlarmLastFiredAt.clear();
			this.lastCallDismissedToday.clear();
			this.lastAlarmTickDate = today;
		}

		for (const habit of this.data.habits) {
			if (habit.kind === "task") continue;
			if (!habit.alarmEnabled || !habit.alarmTime) continue;
			if (nowStr < habit.alarmTime) continue;
			if (this.data.entries[habit.id]?.[today]) continue;
			// Nothing is owed on an off-day, so don't nag — unless today is
			// an open window to repair a missed scheduled day, which is
			// exactly when a reminder is most useful.
			if (!isScheduledOn(habit, now) && !isRepairUnlocked(habit, this.data.entries[habit.id] || {}, now)) continue;

			const repeatMinutes = habit.alarmRepeatMinutes && habit.alarmRepeatMinutes > 0 ? habit.alarmRepeatMinutes : 10;
			const lastFired = this.habitAlarmLastFiredAt.get(habit.id);
			if (lastFired !== undefined && nowMs - lastFired < repeatMinutes * 60000) continue;

			this.habitAlarmLastFiredAt.set(habit.id, nowMs);
			playAlarmChime();
			const notice = new Notice(`⏰ "${habitDisplayName(habit)}" not checked in yet`, 15000);
			notice.noticeEl.addClass("habit-tracker-alarm-notice");
		}

		for (const alarm of this.settings.lastCallAlarms) {
			if (!alarm.enabled) continue;
			if (nowStr < alarm.time) continue;
			if (this.lastCallDismissedToday.get(alarm.id) === today) continue;

			const lastFired = this.lastCallAlarmLastFiredAt.get(alarm.id);
			if (lastFired !== undefined && nowMs - lastFired < LAST_CALL_REPEAT_MINUTES * 60000) continue;

			this.lastCallAlarmLastFiredAt.set(alarm.id, nowMs);
			playAlarmChime();
			this.showLastCallNotice(alarm);
		}
	}

	// A last call alarm's Notice includes its own Dismiss button (built via
	// a DocumentFragment, since Notice's message can be a string or a
	// DocumentFragment) — clicking it records today's date against this
	// alarm so checkAlarm() skips it for the rest of the day, then hides
	// the notice immediately rather than waiting out its own duration.
	showLastCallNotice(alarm: LastCallAlarm) {
		const frag = createFragment((el) => {
			el.createSpan({ text: `⏰ Last call: "${alarm.name}"` });
			const dismissBtn = el.createEl("button", { text: "Dismiss", cls: "habit-tracker-alarm-notice-dismiss" });
			dismissBtn.type = "button";
			dismissBtn.onclick = (e) => {
				e.stopPropagation();
				this.lastCallDismissedToday.set(alarm.id, todayStr());
				notice.hide();
			};
		});
		const notice = new Notice(frag, 20000);
		notice.noticeEl.addClass("habit-tracker-alarm-notice");
	}

	onunload() {
		if (this.realtimeChannel) this.supabase?.removeChannel(this.realtimeChannel);
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(HABIT_TRACKER_VIEW_TYPE);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: HABIT_TRACKER_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async initSupabase() {
		this.supabase = createClient(this.settings.supabaseUrl, this.settings.supabaseAnonKey);
		const { data } = await this.supabase.auth.getSession();
		if (data.session) {
			this.session = data.session;
			await this.connectRemote();
		}
	}

	async saveSettings() {
		await this.saveLocal();
		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey && !this.supabase) {
			await this.initSupabase();
		}
	}

	async signUp(email: string, password: string) {
		if (!this.supabase) {
			new Notice("Enter the Supabase URL and anon key first.");
			return;
		}
		const { error } = await this.supabase.auth.signUp({ email, password });
		if (error) {
			new Notice(`Sign up failed: ${error.message}`);
		} else {
			new Notice("Account created. Check your email to confirm, then sign in.");
		}
	}

	async signIn(email: string, password: string) {
		if (!this.supabase) {
			new Notice("Enter the Supabase URL and anon key first.");
			return;
		}
		const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
		if (error) {
			new Notice(`Sign in failed: ${error.message}`);
			return;
		}
		this.session = data.session;
		new Notice("Signed in. Syncing…");
		await this.connectRemote();
	}

	async signOut() {
		if (this.realtimeChannel) {
			this.supabase?.removeChannel(this.realtimeChannel);
			this.realtimeChannel = null;
		}
		await this.supabase?.auth.signOut();
		this.session = null;
		new Notice("Signed out. This device is now local-only.");
	}

	async connectRemote() {
		if (!this.supabase || !this.session) return;

		const { data: row } = await this.supabase
			.from(SYNC_TABLE)
			.select("data")
			.eq("user_id", this.session.user.id)
			.maybeSingle();

		if (row?.data) {
			this.data = mergeData(this.data, row.data as PluginData);
		}
		await this.persist();
		this.refreshAll();
		this.subscribeRealtime();
	}

	subscribeRealtime() {
		if (!this.supabase || !this.session) return;
		if (this.realtimeChannel) this.supabase.removeChannel(this.realtimeChannel);

		this.realtimeChannel = this.supabase
			.channel("habit_tracker_data_changes")
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: SYNC_TABLE,
					filter: `user_id=eq.${this.session.user.id}`,
				},
				(payload) => {
					const incoming = payload.new.data as PluginData;
					this.data = {
						habits: incoming.habits ?? [],
						entries: incoming.entries ?? {},
						customColors: incoming.customColors ?? [],
						hasCreatedFirstHabit: incoming.hasCreatedFirstHabit ?? false,
					};
					this.saveLocal();
					this.refreshAll();
				}
			)
			.subscribe();
	}

	async saveLocal() {
		await this.saveData({
			settings: this.settings,
			habits: this.data.habits,
			entries: this.data.entries,
			customColors: this.data.customColors,
			hasCreatedFirstHabit: this.data.hasCreatedFirstHabit,
		});
	}

	// The single write path for every mutation (add/edit/delete habit,
	// toggle a day): saves locally first so the device always has an
	// up-to-date offline copy, then pushes to Supabase if signed in so
	// other devices' realtime subscriptions pick it up immediately.
	async persist() {
		await this.saveLocal();
		if (this.supabase && this.session) {
			const { error } = await this.supabase.from(SYNC_TABLE).upsert({
				user_id: this.session.user.id,
				data: this.data,
				updated_at: new Date().toISOString(),
			});
			if (error) {
				new Notice(`Sync failed, saved locally only: ${error.message}`);
			}
		}
	}

	registerBlock(block: HabitTrackerBlock) {
		this.blocks.add(block);
	}

	unregisterBlock(block: HabitTrackerBlock) {
		this.blocks.delete(block);
	}

	refreshAll() {
		for (const block of this.blocks) {
			block.render();
		}
	}

	// Ascending copy of settings.milestones for read sites that need the
	// "next milestone above X" ordering (the milestone bubble, and the
	// first-match-wins loop in maybeCelebrate() below). Storage order
	// doesn't matter — settings.milestones itself is left exactly as the
	// user entered/reordered it in the settings tab.
	sortedMilestones(): number[] {
		return [...this.settings.milestones].sort((a, b) => a - b);
	}

	// Law 4 (Make it Satisfying): an immediate reward beyond the visual
	// heatmap for crossing a real milestone, since delayed real-world
	// payoffs are exactly what habit tracking is meant to compensate for.
	// Only fires the day a streak newly crosses a threshold (oldStreak < m
	// <= newStreak) — never on a render that merely displays an
	// already-reached streak.
	maybeCelebrate(habit: HabitDefinition, oldStreak: number, newStreak: number) {
		for (const m of this.sortedMilestones()) {
			if (oldStreak < m && newStreak >= m) {
				const label = habit.type === "break" ? "clean streak" : "day streak";
				new Notice(`🎉 ${newStreak}-${label} on "${habitDisplayName(habit)}"! Keep going.`);
				// The toast fades and is easy to miss — echo the milestone as
				// a brief glow directly on the streak pill it's about, plus a
				// bigger falling-confetti burst across the whole card, so
				// there's an in-card moment to match it.
				for (const block of this.blocks) {
					const card = block.containerEl.querySelector(
						`.habit-tracker-habit[data-habit-id="${CSS.escape(habit.id)}"]`
					);
					if (!(card instanceof HTMLElement)) continue;
					const pill = card.querySelector(".habit-tracker-pill-streak");
					if (pill instanceof HTMLElement) {
						pill.addClass("habit-tracker-pill-celebrate");
						window.setTimeout(() => pill.removeClass("habit-tracker-pill-celebrate"), 1400);
					}
					if (this.settings.celebrationEffectsEnabled) {
						burstMilestoneConfetti(card, habit.color);
					}
				}
				break;
			}
		}
	}

	// A bigger, once-a-day moment distinct from the per-habit milestone
	// toast above — every habit checked off, not just one streak crossing
	// a threshold. Only ever evaluated for today (the grid has no notion
	// of "all done" for a past day), and guarded so it can't refire twice
	// the same day even if the user unchecks/rechecks a habit afterward.
	maybeCelebrateAllHabitsDoneToday() {
		const today = todayStr();
		if (this.lastAllHabitsCongratsDate === today) return;
		// Only habits actually scheduled for today count — a Mon/Wed/Sat
		// habit shouldn't hold Tuesday's "all done" hostage.
		const now = new Date();
		const habits = this.data.habits.filter(
			(h) => h.kind !== "task" && !h.archived && isScheduledOn(h, now)
		);
		if (habits.length === 0) return;
		const allDone = habits.every((h) => !!this.data.entries[h.id]?.[today]);
		if (!allDone) return;
		this.lastAllHabitsCongratsDate = today;
		new DailyCongratsModal(this, "habits", habits.length).open();
	}

	// Same idea for tasks, but keyed per scheduled date rather than just
	// "today" — an overdue task still tracks against the day it was
	// originally scheduled for (see renderTask's `date` calculation), so
	// clearing out a batch of overdue tasks from the same day is its own
	// congrats moment, independent of today's.
	maybeCelebrateAllTasksDoneForDate(date: string) {
		if (this.allTasksCongratsShownDates.has(date)) return;
		const tasksForDate = this.data.habits.filter((h) => h.kind === "task" && (h.scheduledDate ?? todayStr()) === date);
		if (tasksForDate.length === 0) return;
		const allDone = tasksForDate.every((t) => !!this.data.entries[t.id]?.[date]);
		if (!allDone) return;
		this.allTasksCongratsShownDates.add(date);
		new DailyCongratsModal(this, "tasks", tasksForDate.length, date).open();
	}
}
