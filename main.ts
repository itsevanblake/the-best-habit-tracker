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
	archived?: boolean; // only for kind: "task" — set automatically once checked off; collapses it into the "Done" section.
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
	// Twice Daily (habit kind only): opt-in second occurrence per day
	// ("Morning"/"Evening"), each independently checkable. Either occurrence
	// done counts the day toward streaks (see EntryValue). alarmEnabled2/
	// alarmTime2/alarmRepeatMinutes2 mirror the existing alarm* fields above
	// but drive the Evening occurrence's own alarm.
	twiceDaily?: boolean;
	alarmEnabled2?: boolean;
	alarmTime2?: string; // "HH:MM", 24h, local time
	alarmRepeatMinutes2?: number; // default 10 if alarmEnabled2 but unset
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

// A day can be a full completion (true), the minimum/2-minute-rule version
// (Law 3), or — for a Twice Daily habit — an object tracking each named
// occurrence independently. All forms count toward streaks ("showing up" is
// what matters), but render differently so the distinction stays visible.
// Invariant: never persist an empty occurrence object — when both
// occurrences are cleared, delete the entries[dateStr] key entirely, same as
// today.
type EntryValue = true | "min" | { morning?: true; evening?: true };

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

interface Stats {
	streak: number;
	bestStreak: number;
	total: number;
	totalThisWeek: number;
	totalThisMonth: number;
	totalThisYear: number;
	totalOccurrences: number;
}

// Number of individual occurrences a single day's entry value represents:
// 1 for a plain completion (true/"min"), and for a Twice Daily object, 1 per
// occurrence actually marked done (0, 1, or 2). Lets totalOccurrences count
// a day with both morning AND evening done as 2, instead of computeStats's
// truthy-day counting (`total`) which treats it the same as a single done.
function occurrenceCount(v: EntryValue): number {
	if (typeof v === "object") return (v.morning ? 1 : 0) + (v.evening ? 1 : 0);
	return 1;
}

function computeStats(entries: Record<string, EntryValue>): Stats {
	let total = 0;
	let totalThisWeek = 0;
	let totalThisMonth = 0;
	let totalThisYear = 0;
	let totalOccurrences = 0;
	const now = new Date();
	const currentYear = "" + now.getFullYear();
	const currentYearMonth = currentYear + "-" + pad(now.getMonth() + 1);
	// Sunday-Saturday, matching the Week view's own definition of "this week".
	const weekStart = formatDate(addDays(now, -now.getDay()));
	const weekEnd = formatDate(addDays(now, 6 - now.getDay()));
	for (const date in entries) {
		if (entries[date]) {
			total++;
			totalOccurrences += occurrenceCount(entries[date]);
			if (date.startsWith(currentYear)) totalThisYear++;
			if (date.startsWith(currentYearMonth)) totalThisMonth++;
			if (date >= weekStart && date <= weekEnd) totalThisWeek++;
		}
	}

	// Streak: forgiving — a single missed day doesn't reset it, only two
	// missed days in a row do. Today is always given grace (not counted as
	// a miss) since the day isn't over yet.
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

	return { streak, bestStreak: computeBestStreak(entries), total, totalThisWeek, totalThisMonth, totalThisYear, totalOccurrences };
}

// Longest streak ever achieved (same forgiving one-gap rule as the current
// streak), scanning forward through history rather than backward from
// today. Surfacing this alongside the current streak matters because
// Clear's "don't break the chain" framing is about the record you're
// building, not just today's status.
function computeBestStreak(entries: Record<string, EntryValue>): number {
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

// Evening cutoff (local time) after which an unmarked today starts reading
// as "at risk" rather than just "not done yet" — see isStreakAtRisk() below.
const AT_RISK_HOUR = 18;

// Purely a rendering signal (never touches stored data): true once it's
// evening, today isn't checked in yet, and yesterday was — i.e. there's an
// active streak that will actually break at midnight if today stays blank.
// A habit with no streak yet (yesterday blank) has nothing to protect, so
// it doesn't get the at-risk treatment.
function isStreakAtRisk(entries: Record<string, EntryValue>): boolean {
	if (new Date().getHours() < AT_RISK_HOUR) return false;
	const today = todayStr();
	if (entries[today]) return false;
	const yesterday = formatDate(addDays(new Date(), -1));
	return !!entries[yesterday];
}

// Toggles a day's state: empty -> full -> empty. A day previously marked
// "min" (the old three-state minimum-version cycle) still clears back to
// empty on the next click, same as "full" — it just can't be newly created
// anymore.
function nextEntryValue(current: EntryValue | undefined): EntryValue | undefined {
	return current === undefined ? true : undefined;
}

// Same idea as nextEntryValue, but for a Twice Daily habit: a 3-state cycle
// (none -> one occurrence done -> both done -> none) instead of a 2-state
// toggle. Chosen over per-occurrence click targets (e.g. splitting the cell
// in half) because Year/Year-Days cells are too small for two independent
// tap targets, especially on mobile.
function nextEntryValueTwiceDaily(current: EntryValue | undefined): EntryValue | undefined {
	if (current === undefined) return { morning: true };
	if (current === true || current === "min") return undefined; // legacy value -> terminal, clears
	if (current.morning && current.evening) return undefined;
	return { morning: true, evening: true };
}

// True when a value represents a Twice Daily habit with exactly one of its
// two occurrences done (used to add the dashed "-partial" render class).
function isPartialOccurrence(v: EntryValue): boolean {
	return typeof v === "object" && !(v.morning && v.evening);
}

// Whether a specific occurrence ("morning"/"evening") is done for a given
// habit/date — used by checkAlarm()'s per-slot loop. A legacy plain-`true`
// value counts as done for either slot (see EntryValue's migration note).
function occurrenceDone(entries: Record<string, EntryValue> | undefined, date: string, occurrence: "morning" | "evening"): boolean {
	const v = entries?.[date];
	if (v === true) return true;
	if (typeof v === "object") return !!v[occurrence];
	return false;
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
	twiceDaily: boolean;
	alarmEnabled2: boolean;
	alarmTime2: string;
	alarmRepeatMinutes2: number;
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
		term: "Trigger — Law 1, Make It Obvious",
		definition:
			'The cue. Often a habit stack anchored to something you already do reliably: "After [current habit], I will [new habit]." The trigger habit needs to be automatic — waking up, brushing teeth, sitting down with coffee.',
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
	stackedAfter: "Trigger",
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
		fields: "Trigger",
		text: "Surface the cue. The environment is already set up so the trigger is impossible to miss.",
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

const FORMULA_REVIEW_SYSTEM_PROMPT = `You are a habit-design coach grounded in James Clear's Atomic Habits, specifically the Four Laws of Behavior Change. The user is filling in "The Complete Habit Formula" for a habit: "After I [Trigger], I will [Routine]. [Craving]. Once done, [Reward]."

For each of the four fields they've written, judge it against its Law:
- Trigger (Law 1, Make It Obvious): is the cue a specific, already-automatic moment — not vague like "in the morning"?
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
			twiceDaily: opts.initial?.twiceDaily ?? false,
			alarmEnabled2: opts.initial?.alarmEnabled2 ?? false,
			alarmTime2: opts.initial?.alarmTime2 ?? "08:00",
			alarmRepeatMinutes2: opts.initial?.alarmRepeatMinutes2 ?? 10,
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
				text: "🎓 Creation Walkthrough",
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
			// Evening Alarm has a second, independent visibility condition
			// (Twice Daily) on top of the habit/task split every other
			// habit-only section uses, so it's re-applied here rather than
			// living in habitOnlySections — a task is never twiceDaily
			// (nulled in both save handlers), so isTask alone is always
			// enough to force it hidden regardless of the stale toggle value.
			eveningAlarmWrap.toggleClass("habit-tracker-kind-hidden", isTask || !this.values.twiceDaily);
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

		const typeWrap = contentEl.createDiv();
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
			text: 'Clear\'s own structure, one field per Law: "After I [Trigger], I will [Routine]. [Craving]. Once done, [Reward]."',
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

		// Twice Daily — habit-only (hidden for a task, same as Type above):
		// opt-in second occurrence per day ("Morning"/"Evening"), each
		// independently checkable. Placed immediately above the alarm
		// section since it changes that section's own heading/shape.
		const twiceDailyWrap = contentEl.createDiv();
		habitOnlySections.push(twiceDailyWrap);
		new Setting(twiceDailyWrap)
			.setName("Twice Daily")
			.setDesc("Track this habit as two independent occurrences per day (e.g. a morning and an evening meditation) instead of one.")
			.addToggle((toggle) =>
				toggle.setValue(this.values.twiceDaily).onChange((value) => {
					this.values.twiceDaily = value;
					alarmHeadingEl.setText(value ? "Morning Alarm" : "Check-in Alarm");
					eveningAlarmWrap.toggleClass("habit-tracker-kind-hidden", !value);
				})
			);

		// Per-habit check-in alarm — habit-only (hidden for a task, same as
		// Type above), since the firing condition is "not checked in today,"
		// which isn't meaningful for a one-off scheduled item. When Twice
		// Daily is on, this section becomes the Morning occurrence's alarm
		// and a second, identically-shaped Evening Alarm section appears
		// below it.
		const alarmWrap = contentEl.createDiv();
		habitOnlySections.push(alarmWrap);
		const alarmHeadingEl = alarmWrap.createEl("h4", { text: this.values.twiceDaily ? "Morning Alarm" : "Check-in Alarm" });
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

		// Evening occurrence's alarm — identical shape to the section above,
		// writing to the alarm*2 fields instead. Shown/hidden via the same
		// habit-tracker-kind-hidden class habitOnlySections already uses,
		// just toggled by the Twice Daily switch instead of Kind.
		const eveningAlarmWrap = contentEl.createDiv();
		eveningAlarmWrap.toggleClass("habit-tracker-kind-hidden", this.values.kind === "task" || !this.values.twiceDaily);
		eveningAlarmWrap.createEl("h4", { text: "Evening Alarm" });
		eveningAlarmWrap.createEl("p", {
			cls: "setting-item-description",
			text: "Once the alarm time passes local time with this habit's evening occurrence not yet checked in today, nag (sound + banner) every few minutes until it is.",
		});
		new Setting(eveningAlarmWrap).setName("Enable alarm").addToggle((toggle) =>
			toggle.setValue(this.values.alarmEnabled2).onChange((value) => {
				this.values.alarmEnabled2 = value;
			})
		);
		new Setting(eveningAlarmWrap)
			.setName("Alarm time")
			.setDesc("24-hour local time (HH:MM).")
			.addText((text) => {
				text.inputEl.type = "time";
				text.setValue(this.values.alarmTime2).onChange((value) => {
					if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
					this.values.alarmTime2 = value;
				});
			});
		new Setting(eveningAlarmWrap)
			.setName("Repeat every (minutes)")
			.setDesc("How often to re-nag once the alarm time has passed and it's still not checked in.")
			.addText((text) =>
				text.setValue("" + this.values.alarmRepeatMinutes2).onChange((value) => {
					const n = parseInt(value, 10);
					if (!Number.isFinite(n) || n <= 0) return;
					this.values.alarmRepeatMinutes2 = n;
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
				title: "Name it",
				body: 'Let\'s build this together. Start by giving it a short, concrete name — something you\'d recognize at a glance, like "Morning run" or "Book the dentist".',
				target: refs.nameSetting.settingEl,
				focusEl: refs.nameInputEl,
			},
			{
				title: "Habit or Task?",
				body: "Is this something you'll do repeatedly (a Habit), or is this something you'll do once on a specific date (a Task)? Pick whichever fits.",
				target: refs.kindSetting.settingEl,
				focusEl: refs.kindSelectEl,
			},
			{
				title: LEVER_TERM_INFO.identity.term,
				body: `This isn't just about the outcome — it's a vote for who you're becoming. Every time you follow through, you're proving something to yourself. Who are you becoming by doing this? Example: "${EXAMPLE_LEVERS.identity}"`,
				target: lever("identity").setting.settingEl,
				focusEl: lever("identity").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.linkedGoal.term,
				body: () =>
					isTask()
						? "You don't rise to the level of your goals — you fall to the level of your systems. This task is one rep of that system; pick which Goal it's actually serving."
						: "You don't rise to the level of your goals — you fall to the level of your systems. This habit is your system; pick which Goal it's actually serving.",
				target: refs.goalSetting.settingEl,
				focusEl: refs.goalSelectEl,
			},
			{
				title: "Pick a color",
				body: "Give it a color so you can spot it at a glance. Click a preset color, or pick and save your own from the wheel.",
				target: refs.swatchRow,
			},
			{
				title: TYPE_INFO.term,
				body: "Are you starting this habit, or trying to quit one? Pick Build if you're starting it, or Break if you're trying to quit it — the same Four Laws apply, just reversed for breaking a habit.",
				target: refs.typeSetting.settingEl,
				focusEl: refs.typeSelectEl,
				skipIf: isTask,
			},
			{
				title: "Scheduled date",
				body: 'When are you doing this? Pick the exact date — it\'ll stay out of the way until then, and show up ready to check off. Naming a specific day, not just "someday," is what actually gets one-off tasks done.',
				target: refs.scheduledDateSetting.settingEl,
				focusEl: refs.scheduledDateInputEl,
				skipIf: () => !isTask(),
			},
			{
				title: LEVER_TERM_INFO.stackedAfter.term,
				body: () =>
					isTask()
						? `When and where will you actually do this? Naming the exact moment — not just "sometime that day" — is what actually gets a one-off task done. Example: "${EXAMPLE_LEVERS.stackedAfter}"`
						: `What will remind you to do this? Anchor it to something you already do without thinking, so the cue is impossible for you to miss. Example: "${EXAMPLE_LEVERS.stackedAfter}"`,
				target: lever("stackedAfter").setting.settingEl,
				focusEl: lever("stackedAfter").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.craving.term,
				body: `What makes you actually want to do this? Tie it to something you already crave, so that craving pulls you in. Example: "${EXAMPLE_LEVERS.craving}"`,
				target: lever("craving").setting.settingEl,
				focusEl: lever("craving").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.minimumVersion.term,
				body: `Now scale it down for yourself. What's the two-minute version you could do even on your worst day? Optimize for showing up, not for going hard. Example: "${EXAMPLE_LEVERS.minimumVersion}"`,
				target: lever("minimumVersion").setting.settingEl,
				focusEl: lever("minimumVersion").textareaEl,
			},
			{
				title: LEVER_TERM_INFO.reward.term,
				body: () =>
					isTask()
						? `How will you know you're done, right away? Give yourself an immediate payoff the moment you check it off. Example: "${EXAMPLE_LEVERS.reward}"`
						: `How will you know you're done, right away? Give yourself an immediate payoff — that's what will make you want to repeat this tomorrow. Example: "${EXAMPLE_LEVERS.reward}"`,
				target: lever("reward").setting.settingEl,
				focusEl: lever("reward").textareaEl,
			},
		];

		if (refs.commitCheckboxEl) {
			steps.push({
				title: "Commit",
				body: () => {
					const verb = isTask() ? "completing" : this.values.type === "break" ? "breaking" : "building";
					const subject = isTask() ? "this task" : "this habit";
					return `Ready to commit? Check the box below to say "I commit to ${verb} ${subject}" — a small, deliberate act that locks in your intention before you start.`;
				},
				target: (refs.commitCheckboxEl.closest("label") as HTMLElement) ?? refs.commitCheckboxEl,
				focusEl: refs.commitCheckboxEl,
			});
		}

		steps.push({
			title: () => (isTask() ? "Add the task" : "Add the habit"),
			body: () =>
				isTask()
					? "You've just built full accountability into this one-off. Click below to add your task — it'll stay out of sight until its date, then show up ready to check off."
					: "You've just built your whole system. Click below to add your first habit and start your streak.",
			target: refs.footer,
			focusEl: refs.submitBtn,
		});

		const tooltip = contentEl.createDiv({ cls: "habit-tracker-walkthrough-tooltip" });
		const progressEl = tooltip.createDiv({ cls: "habit-tracker-walkthrough-progress" });
		const titleEl = tooltip.createEl("strong", { cls: "habit-tracker-walkthrough-title" });
		const bodyEl = tooltip.createEl("p", { cls: "habit-tracker-walkthrough-body" });
		const btnRow = tooltip.createDiv({ cls: "habit-tracker-walkthrough-btns" });
		const skipBtn = btnRow.createEl("button", { text: "Skip walkthrough", cls: "habit-tracker-walkthrough-skip" });
		const backBtn = btnRow.createEl("button", { text: "Back" });
		const nextBtn = btnRow.createEl("button", { text: "Next", cls: "mod-cta" });
		skipBtn.type = "button";
		backBtn.type = "button";
		nextBtn.type = "button";

		let stepIndex = 0;
		let active = true;

		const positionTooltip = (target: HTMLElement) => {
			const contentRect = contentEl.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			const top = targetRect.bottom - contentRect.top + contentEl.scrollTop + 10;
			const maxLeft = Math.max(0, contentEl.clientWidth - tooltip.offsetWidth);
			const left = Math.min(Math.max(0, targetRect.left - contentRect.left), maxLeft);
			tooltip.style.top = `${top}px`;
			tooltip.style.left = `${left}px`;

			// The tooltip is position: absolute, so on a step near the
			// bottom of the form its true bottom edge can sit past
			// contentEl's normal-flow content height — contentEl.scrollHeight
			// (and therefore how far it can actually scroll) doesn't
			// reliably grow to include it, so scrolling alone can leave the
			// tooltip's bottom permanently clipped by the modal's own edge
			// with nowhere further to scroll to. Force real scrollable room
			// to exist by padding contentEl out to the tooltip's bottom
			// before scrolling to it.
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
			steps.forEach((s) => s.target.removeClass("habit-tracker-walkthrough-highlight"));
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
			steps.forEach((s) => s.target.removeClass("habit-tracker-walkthrough-highlight"));
			step.target.addClass("habit-tracker-walkthrough-highlight");
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
				// A blur fires (moving focus off the current field) the
				// instant the user mousedowns on Skip/Back/Next — BEFORE
				// that button's own click handler runs. Without this guard,
				// this listener would fire showStep()'s scrollIntoView on
				// its way to the next field a beat before endWalkthrough()
				// (from Skip) tears the tour down, which visibly scrolls the
				// form even though the tour is closing — reading exactly
				// like "Skip just went to the next field" instead of
				// closing.
				const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
				if (related === skipBtn || related === backBtn || related === nextBtn) return;
				if (predicate && !predicate()) return;
				showStep(index + 1);
			});
		};

		steps.forEach((step, i) => {
			const el = step.focusEl;
			if (el instanceof HTMLTextAreaElement) {
				bindAdvance(el, "blur", i, () => el.value.trim().length > 0);
			} else if (el instanceof HTMLInputElement && el.type !== "checkbox") {
				bindAdvance(el, "blur", i, () => el.value.trim().length > 0);
			}
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

	submit() {
		if (!this.values.name.trim()) {
			new Notice(this.values.kind === "task" ? "Task needs a name." : "Habit needs a name.");
			return;
		}
		const isTask = this.values.kind === "task";
		if (isTask && !this.values.scheduledDate) {
			new Notice("Pick a scheduled date for this task.");
			return;
		}
		if (this.isNew) {
			const verb = isTask ? "completing" : this.values.type === "break" ? "breaking" : "building";
			const subject = isTask ? "this task" : "this habit";
			for (const key of [...FORMULA_KEYS, ...OTHER_LEVER_KEYS]) {
				if (!this.values[key].trim()) {
					new Notice(`Fill out "${LEVER_LABELS[key]}" — ${LEVER_HELP_REASON[key]}, which will help you with ${verb} ${subject}.`);
					return;
				}
			}
			if (!this.values.linkedGoal.trim()) {
				new Notice(`Pick a "${LEVER_LABELS.linkedGoal}" — ${LEVER_HELP_REASON.linkedGoal}, which will help you with ${verb} ${subject}.`);
				return;
			}
			if (!this.commitChecked) {
				new Notice(`Check "I commit to ${verb} ${subject}" to continue.`);
				return;
			}
		}
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
		contentEl.createEl("h3", { text: isTask ? "🎉 You just built full accountability into a task!" : "🎉 You just built your first habit!" });
		contentEl.createEl("p", {
			text: isTask
				? `"${habitName}" is scheduled for ${this.values.scheduledDate}, and you've filled in the whole loop for it — the trigger, the craving, the routine, and the reward.`
				: `"${habitName}" is live, and you've filled in the whole loop for it — the trigger, the craving, the routine, and the reward.`,
		});
		contentEl.createEl("p", {
			text: isTask
				? "It'll stay out of the way until its date, then show up ready to check off — you've already named exactly when, why, and how you'll follow through."
				: "The only thing left is showing up. Keep coming back to the daily tracker, check it off, and protect your streak — small, consistent reps are what actually compound into the person you're becoming.",
		});
		const doneBtn = contentEl.createEl("button", { text: "Let's go", cls: "mod-cta" });
		doneBtn.type = "button";
		doneBtn.onclick = () => this.close();
		window.setTimeout(() => doneBtn.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmDeleteModal extends Modal {
	habitName: string;
	onConfirm: () => void;

	constructor(app: App, habitName: string, onConfirm: () => void) {
		super(app);
		this.habitName = habitName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.createEl("h3", { text: "Delete habit?" });
		contentEl.createEl("p", {
			text: `"${this.habitName}" and all of its check-in history will be permanently deleted. This can't be undone.`,
		});

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.close();
		const deleteBtn = footer.createEl("button", { text: "Delete", cls: "mod-warning" });
		deleteBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
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
			text: 'Powers the "✨ Review Formula" button in the Add/Edit Habit form, which critiques and suggests rewrites for your Complete Habit Formula fields (Trigger/Craving/Routine/Reward). Uses the Anthropic API — your key is stored locally on this device only, never synced.',
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

type ViewMode = "week" | "month" | "year" | "yeardays";
type CellStyle = "year" | "week" | "month" | "yeardays";

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

		const data = this.plugin.data;
		const allItems = this.filterName
			? data.habits.filter((h) => h.name.toLowerCase() === this.filterName!.toLowerCase())
			: data.habits;

		// Tasks: hidden entirely until their scheduled date arrives, then
		// shown as a single checkable row (no heatmap/streak) rather than
		// mixed into the regular habit grid list. Once checked off they
		// auto-archive into a collapsed Done section below.
		const today = todayStr();
		const habits = allItems.filter((h) => h.kind !== "task");
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
		const modeLabels: Record<ViewMode, string> = { week: "Week", month: "Month", year: "Year", yeardays: "Year - Days" };
		(["week", "month", "year", "yeardays"] as ViewMode[]).forEach((mode) => {
			const b = toggle.createEl("button", {
				text: modeLabels[mode],
				cls: "habit-tracker-view-btn" + (this.currentView === mode ? " habit-tracker-view-btn-active" : ""),
			});
			b.onclick = () => {
				this.currentView = mode;
				this.render();
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
				cls: "habit-tracker-view-nav-label",
			});
			const nextBtn = monthNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next month");
			nextBtn.onclick = () => {
				this.selectedMonthOffset += 1;
				this.render();
			};
			if (this.selectedMonthOffset !== 0) {
				const todayBtn = monthNav.createEl("button", { text: "Today", cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to current month");
				todayBtn.onclick = () => {
					this.selectedMonthOffset = 0;
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
				cls: "habit-tracker-view-nav-label",
			});
			const nextBtn = weekNav.createEl("button", { text: "▶", cls: "habit-tracker-view-nav-btn" });
			nextBtn.type = "button";
			nextBtn.setAttr("aria-label", "Next week");
			nextBtn.onclick = () => {
				this.selectedWeekOffset += 1;
				this.render();
			};
			if (this.selectedWeekOffset !== 0) {
				const todayBtn = weekNav.createEl("button", { text: "Today", cls: "habit-tracker-view-today-btn" });
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
				const todayBtn = yearNav.createEl("button", { text: "Today", cls: "habit-tracker-view-today-btn" });
				todayBtn.type = "button";
				todayBtn.setAttr("aria-label", "Back to current year");
				todayBtn.onclick = () => {
					this.selectedYearOffset = 0;
					this.render();
				};
			}
		}

		if (!this.filterName) {
			const gearBtn = toggleRow.createEl("button", { text: "⚙️", cls: "habit-tracker-gear-btn" });
			gearBtn.type = "button";
			gearBtn.setAttr("aria-label", "Settings");
			gearBtn.onclick = () => this.toggleSettingsPanel();
		}

		const visibleCount = habits.length + pendingTasks.length + doneTasks.length;
		if (visibleCount === 0 && !this.filterName) {
			const empty = el.createDiv({ cls: "habit-tracker-empty" });
			empty.createDiv({ text: "🌱", cls: "habit-tracker-empty-icon" });
			empty.createDiv({ text: "No habits yet", cls: "habit-tracker-empty-title" });
			empty.createDiv({
				text: "Every streak starts with day one — add your first habit below to get started.",
				cls: "habit-tracker-empty-subtitle",
			});
		} else if (visibleCount === 0 && this.filterName) {
			const empty = el.createDiv({ cls: "habit-tracker-empty" });
			empty.createDiv({ text: "🔍", cls: "habit-tracker-empty-icon" });
			empty.createDiv({ text: `No habit named "${this.filterName}" yet`, cls: "habit-tracker-empty-title" });
		}

		const list = el.createDiv({ cls: "habit-tracker-list" });
		for (const task of pendingTasks) {
			this.renderTask(list, task, today);
		}
		for (const habit of habits) {
			this.renderHabit(list, habit);
		}

		if (doneTasks.length > 0) {
			const doneToggle = el.createDiv({ cls: "habit-tracker-done-toggle", text: `✅ Done (${doneTasks.length})` });
			const doneSection = el.createDiv({ cls: "habit-tracker-done-section" });
			for (const task of doneTasks) {
				this.renderTask(doneSection, task, today);
			}
			doneToggle.onclick = () => {
				doneSection.toggleClass("habit-tracker-done-section-visible", !doneSection.hasClass("habit-tracker-done-section-visible"));
			};
		}

		if (!this.filterName) {
			const addCard = list.createDiv({ cls: "habit-tracker-add-card" });
			addCard.createSpan({ text: "+", cls: "habit-tracker-add-icon" });
			addCard.createSpan({ text: "Add habit", cls: "habit-tracker-add-label" });
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
					createdAt: todayStr(),
					type: values.type,
					kind: values.kind,
					scheduledDate: values.kind === "task" ? values.scheduledDate : undefined,
					alarmEnabled: values.kind === "task" ? undefined : values.alarmEnabled,
					alarmTime: values.kind === "task" ? undefined : values.alarmTime,
					alarmRepeatMinutes: values.kind === "task" ? undefined : values.alarmRepeatMinutes,
					twiceDaily: values.kind === "task" ? undefined : values.twiceDaily,
					alarmEnabled2: values.kind === "task" ? undefined : values.alarmEnabled2,
					alarmTime2: values.kind === "task" ? undefined : values.alarmTime2,
					alarmRepeatMinutes2: values.kind === "task" ? undefined : values.alarmRepeatMinutes2,
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
		tooltip.createDiv({ text: "👇 Click \"+ Add habit\" below to start", cls: "habit-tracker-walkthrough-title" });
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
			scopeSelect.createEl("option", { text: h.name, value: h.id });
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
				const habitName = this.plugin.data.habits.find((h) => h.id === scope)?.name ?? "that habit";
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
			new ConfirmDeleteModal(this.plugin.app, task.name, async () => {
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
			row.createDiv({ text: `⛓ Trigger: ${task.stackedAfter}`, cls: "habit-tracker-meta-line" });
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
			goalLink.onclick = () => {
				this.plugin.app.workspace.openLinkText(task.linkedGoal!, "", false);
			};
		}
	}

	renderHabit(parentEl: HTMLElement, habit: HabitDefinition) {
		const entries = this.plugin.data.entries[habit.id] || (this.plugin.data.entries[habit.id] = {});
		const stats = computeStats(entries);
		const view = this.currentView;

		const card = parentEl.createDiv({ cls: "habit-tracker-habit" });
		card.setAttr("data-habit-id", habit.id);
		card.style.setProperty("--habit-color", habit.color);
		card.style.setProperty("--habit-color-contrast", contrastColor(habit.color));
		const isBreak = habit.type === "break";

		const header = card.createDiv({ cls: "habit-tracker-header" });
		const titleRow = header.createDiv({ cls: "habit-tracker-title-row" });
		const dot = titleRow.createSpan({ cls: "habit-tracker-dot" });
		dot.style.backgroundColor = habit.color;
		titleRow.createSpan({ text: habit.name, cls: "habit-tracker-name" });
		titleRow.createSpan({
			text: isBreak ? "BREAK" : "BUILD",
			cls: "habit-tracker-type-badge" + (isBreak ? " habit-tracker-type-badge-break" : " habit-tracker-type-badge-build"),
		});

		const statsRow = header.createDiv({ cls: "habit-tracker-stats-row" });
		const streakPill = statsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-streak" });
		streakPill.createSpan({ text: isBreak ? "🛡️" : "🔥", cls: "habit-tracker-pill-icon" });
		streakPill.createSpan({ text: `${stats.streak}`, cls: "habit-tracker-pill-value" });
		streakPill.createSpan({ text: isBreak ? "clean" : "streak", cls: "habit-tracker-pill-label" });

		const bestPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		bestPill.createSpan({ text: "🏆", cls: "habit-tracker-pill-icon" });
		bestPill.createSpan({ text: `${stats.bestStreak}`, cls: "habit-tracker-pill-value" });
		bestPill.createSpan({ text: "best", cls: "habit-tracker-pill-label" });

		const weekPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		weekPill.createSpan({ text: `${stats.totalThisWeek}`, cls: "habit-tracker-pill-value" });
		weekPill.createSpan({ text: "this week", cls: "habit-tracker-pill-label" });

		const monthPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		monthPill.createSpan({ text: `${stats.totalThisMonth}`, cls: "habit-tracker-pill-value" });
		monthPill.createSpan({ text: "this month", cls: "habit-tracker-pill-label" });

		const totalPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		totalPill.createSpan({ text: `${stats.total}`, cls: "habit-tracker-pill-value" });
		totalPill.createSpan({ text: "votes", cls: "habit-tracker-pill-label" });

		// Twice Daily habits can rack up 2 occurrences on the same day, which
		// "votes" (a day-with-any-completion count) can't reflect — only show
		// this pill when it would actually say something votes doesn't.
		if (stats.totalOccurrences !== stats.total) {
			const occurrencesPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
			occurrencesPill.createSpan({ text: "✅", cls: "habit-tracker-pill-icon" });
			occurrencesPill.createSpan({ text: `${stats.totalOccurrences}`, cls: "habit-tracker-pill-value" });
			occurrencesPill.createSpan({ text: "completions", cls: "habit-tracker-pill-label" });
		}

		const yearPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		yearPill.createSpan({ text: `${stats.totalThisYear}`, cls: "habit-tracker-pill-value" });
		yearPill.createSpan({ text: "this year", cls: "habit-tracker-pill-label" });

		// Own container, deliberately kept separate from statsRow — the
		// number of stat pills can grow (and does, per-habit-type), and
		// these two buttons must never be the thing that gets squeezed off
		// the edge on a narrow/mobile viewport as a result. See styles.css
		// .habit-tracker-actions for the flex-shrink:0 + wrap handling.
		const actionsRow = header.createDiv({ cls: "habit-tracker-actions" });

		const editBtn = actionsRow.createSpan({ text: "✏️", cls: "habit-tracker-edit-btn" });
		editBtn.setAttr("aria-label", "Edit habit");
		editBtn.onclick = () => {
			new HabitFormModal(this.plugin.app, this.plugin, {
				title: "Edit habit",
				submitLabel: "Save",
				initial: habit,
				onSubmit: async (values) => {
					habit.name = values.name;
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
					habit.twiceDaily = values.kind === "task" ? undefined : values.twiceDaily;
					habit.alarmEnabled2 = values.kind === "task" ? undefined : values.alarmEnabled2;
					habit.alarmTime2 = values.kind === "task" ? undefined : values.alarmTime2;
					habit.alarmRepeatMinutes2 = values.kind === "task" ? undefined : values.alarmRepeatMinutes2;
					habit.stackedAfter = values.stackedAfter || undefined;
					habit.craving = values.craving || undefined;
					habit.minimumVersion = values.minimumVersion || undefined;
					habit.reward = values.reward || undefined;
					habit.identity = values.identity || undefined;
					habit.linkedGoal = values.linkedGoal || undefined;
					await this.plugin.persist();
					this.plugin.refreshAll();
				},
			}).open();
		};

		const deleteBtn = actionsRow.createSpan({ text: "🗑", cls: "habit-tracker-delete-btn" });
		deleteBtn.setAttr("aria-label", "Delete habit");
		deleteBtn.onclick = () => {
			new ConfirmDeleteModal(this.plugin.app, habit.name, async () => {
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
			milestoneBubble.setText(`🎉 ${stats.streak}-Day Milestone Achieved!`);
		} else {
			const nextMilestone = milestones.find((m) => m > stats.streak);
			if (nextMilestone !== undefined) {
				const daysLeft = nextMilestone - stats.streak;
				milestoneBubble.setText(`🎯 ${daysLeft} ${daysLeft === 1 ? "day" : "days"} to next milestone`);
			} else {
				milestoneBubble.addClass("habit-tracker-milestone-bubble-achieved");
				milestoneBubble.setText("🏆 All milestones achieved!");
			}
		}

		// Atomic Habits detail line(s) — only rendered when set, so a habit
		// with none of these looks exactly as plain as before.
		if (habit.identity) {
			card.createDiv({ text: `→ ${habit.identity}`, cls: "habit-tracker-identity" });
		}
		const triggerBits: string[] = [];
		if (habit.stackedAfter) triggerBits.push(`⛓ Trigger: ${habit.stackedAfter}`);
		if (triggerBits.length) {
			card.createDiv({ text: triggerBits.join("   ·   "), cls: "habit-tracker-meta-line" });
		}
		if (habit.craving) {
			card.createDiv({ text: `🍯 Craving: ${habit.craving}`, cls: "habit-tracker-meta-line" });
		}
		if (habit.minimumVersion) {
			card.createDiv({ text: `💡 Routine: ${habit.minimumVersion}`, cls: "habit-tracker-meta-line" });
		}
		if (habit.reward) {
			card.createDiv({ text: `🎉 Reward: ${habit.reward}`, cls: "habit-tracker-meta-line" });
		}
		if (habit.linkedGoal) {
			const goalLink = card.createDiv({ text: `🎯 ${habit.linkedGoal}`, cls: "habit-tracker-meta-line habit-tracker-goal-link" });
			goalLink.onclick = () => {
				this.plugin.app.workspace.openLinkText(habit.linkedGoal!, "", false);
			};
		}

		const grid = card.createDiv({ cls: "habit-tracker-grid-wrap" });
		grid.setAttr("data-habit-id", habit.id);
		if (view === "week") {
			this.renderWeekGrid(grid, habit, entries, this.selectedWeekOffset);
		} else if (view === "month") {
			this.renderMonthGrid(grid, habit, entries, this.selectedMonthOffset);
		} else if (view === "yeardays") {
			this.renderYearDaysGrid(grid, habit, entries, this.selectedYearOffset);
		} else {
			this.renderYearGrid(grid, habit, entries, this.selectedYearOffset);
		}
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
		const boxed = style === "week" || style === "month";
		const cellBaseCls =
			style === "week" || style === "month"
				? "habit-tracker-week-cell"
				: style === "yeardays"
				? "habit-tracker-yeardays-cell"
				: "habit-tracker-cell";
		const cell = gridEl.createDiv({ cls: cellBaseCls });
		cell.setAttr("data-date", dateStr);
		// Only show the hover tooltip on the small square cells (year and
		// year-days) — the week/month cells already print the date
		// directly, and the tooltip's positioning logic overflows past the
		// card edge for cells near the left/top border, so it's both
		// redundant and buggy there.
		if (!boxed) {
			cell.setAttr("aria-label", dateStr);
		}

		if (style === "week") {
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
			if (isPartialOccurrence(entries[dateStr])) {
				cell.addClass(boxed ? "habit-tracker-week-cell-partial" : "habit-tracker-cell-partial");
			}
		} else if (dateStr < todayStr()) {
			// A day strictly before today with no entry — visibly greyed out
			// so a gap in the streak reads at a glance, in every view (year,
			// year-days, week, month all funnel through this one function).
			// Today itself is excluded even before it's checked off, since a
			// streak isn't broken until the day is actually over.
			cell.addClass(missedCls);
		}
		if (dateStr === todayStr()) {
			cell.addClass("habit-tracker-cell-today");
			if (isStreakAtRisk(entries)) {
				cell.addClass("habit-tracker-cell-at-risk");
			}
		}
		cell.onclick = async () => {
			const oldStreak = computeStats(entries).streak;
			const next = habit.twiceDaily ? nextEntryValueTwiceDaily(entries[dateStr]) : nextEntryValue(entries[dateStr]);
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
			cell.removeClass(boxed ? "habit-tracker-week-cell-partial" : "habit-tracker-cell-partial");
			if (isPartialOccurrence(next)) cell.addClass(boxed ? "habit-tracker-week-cell-partial" : "habit-tracker-cell-partial");
			cell.addClass("habit-tracker-cell-pop");
			const newStreak = computeStats(entries).streak;
			if (this.plugin.settings.celebrationEffectsEnabled) {
				const card = cell.closest<HTMLElement>(".habit-tracker-habit");
				if (card) burstConfetti(card, cell, habit.color);
				playCelebrationChime(newStreak, this.plugin.settings.milestones.includes(newStreak));
			}
			window.setTimeout(() => {
				this.plugin.refreshAll();
				this.plugin.maybeCelebrate(habit, oldStreak, newStreak);
			}, 160);
		};
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

		this.registerMarkdownCodeBlockProcessor("habit-tracker", (source, el, ctx) => {
			const filterMatch = source.match(/^\s*habit:\s*(.+)\s*$/m);
			const filterName = filterMatch ? filterMatch[1].trim() : null;
			const viewMatch = source.match(/^\s*view:\s*(week|month|year|yeardays)\s*$/m);
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

			// Twice Daily habits get two independent alarm slots (Morning ==
			// the existing alarmEnabled/alarmTime/alarmRepeatMinutes fields,
			// Evening == the new *2 fields); everyone else keeps exactly one
			// slot with today's behavior (empty label, no map-key suffix).
			const slots = habit.twiceDaily
				? [
						{ enabled: habit.alarmEnabled, time: habit.alarmTime, repeatMinutes: habit.alarmRepeatMinutes, occurrence: "morning" as const, keySuffix: "", label: " (Morning)" },
						{ enabled: habit.alarmEnabled2, time: habit.alarmTime2, repeatMinutes: habit.alarmRepeatMinutes2, occurrence: "evening" as const, keySuffix: ":evening", label: " (Evening)" },
				  ]
				: [{ enabled: habit.alarmEnabled, time: habit.alarmTime, repeatMinutes: habit.alarmRepeatMinutes, occurrence: "morning" as const, keySuffix: "", label: "" }];

			for (const slot of slots) {
				if (!slot.enabled || !slot.time) continue;
				if (nowStr < slot.time) continue;
				if (occurrenceDone(this.data.entries[habit.id], today, slot.occurrence)) continue;

				const repeatMinutes = slot.repeatMinutes && slot.repeatMinutes > 0 ? slot.repeatMinutes : 10;
				const mapKey = habit.id + slot.keySuffix;
				const lastFired = this.habitAlarmLastFiredAt.get(mapKey);
				if (lastFired !== undefined && nowMs - lastFired < repeatMinutes * 60000) continue;

				this.habitAlarmLastFiredAt.set(mapKey, nowMs);
				playAlarmChime();
				const notice = new Notice(`⏰ "${habit.name}"${slot.label} not checked in yet`, 15000);
				notice.noticeEl.addClass("habit-tracker-alarm-notice");
			}
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
				new Notice(`🎉 ${newStreak}-${label} on "${habit.name}"! Keep going.`);
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
}
