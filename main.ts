import { Plugin, PluginSettingTab, MarkdownRenderChild, Modal, App, Setting, Notice, Platform } from "obsidian";
import { createClient, SupabaseClient, Session, RealtimeChannel } from "@supabase/supabase-js";

type HabitType = "build" | "break";

interface HabitDefinition {
	id: string;
	name: string;
	color: string;
	createdAt: string; // YYYY-MM-DD
	type?: HabitType; // default "build" — a "break" habit inverts the framing (Clear's four laws apply in reverse to quitting a habit), not the click mechanic: a checked day still means "I succeeded today" (i.e. "I resisted").
	identity?: string; // "I am someone who..." — Clear's identity-based habits: the vote this habit casts for who you're becoming.
	stackedAfter?: string; // Law 1 (Make it Obvious): habit stacking anchor, "After I ___, I will do this."
	whenWhere?: string; // Law 1: implementation intention, "I will do this at [time] in [location]."
	minimumVersion?: string; // Law 3 (Make it Easy): the 2-minute-rule fallback version for a low-friction day.
	linkedGoal?: string; // Note name of the Goals/Quarters file this habit is the "system" for.
}

// A day can be a full completion (true) or the minimum/2-minute-rule
// version (Law 3) — both count toward streaks ("showing up" is what
// matters), but render differently so the distinction stays visible.
type EntryValue = true | "min";

interface PluginData {
	habits: HabitDefinition[];
	entries: Record<string, Record<string, EntryValue>>; // habitId -> "YYYY-MM-DD" -> value
}

const DEFAULT_DATA: PluginData = { habits: [], entries: {} };

interface PluginSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
}

const DEFAULT_SETTINGS: PluginSettings = { supabaseUrl: "", supabaseAnonKey: "" };

const PALETTE = ["#2e8840", "#1872ff", "#e73400", "#dd6f00", "#c30062", "#7bc96f"];

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
	totalThisYear: number;
}

function computeStats(entries: Record<string, EntryValue>): Stats {
	let total = 0;
	let totalThisYear = 0;
	const currentYear = "" + new Date().getFullYear();
	for (const date in entries) {
		if (entries[date]) {
			total++;
			if (date.startsWith(currentYear)) totalThisYear++;
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

	return { streak, bestStreak: computeBestStreak(entries), total, totalThisYear };
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

// Cycles a day's state: empty -> full -> minimum version -> empty. Both
// "full" and "min" count as success for streak purposes (Law 4: showing up
// is what earns the reward), they just render differently.
function nextEntryValue(current: EntryValue | undefined): EntryValue | undefined {
	if (current === undefined) return true;
	if (current === true) return "min";
	return undefined;
}

interface HabitLevers {
	identity: string;
	stackedAfter: string;
	whenWhere: string;
	minimumVersion: string;
	linkedGoal: string;
}

interface HabitFormValues extends HabitLevers {
	name: string;
	color: string;
	type: HabitType;
}

// Shown as each field's placeholder hint for a brand-new habit (nothing
// set yet). Native placeholder text is inherently the right tool here: it
// renders dimmed automatically, and disappears the instant that specific
// field is typed into — no custom clear-on-type logic needed, and it
// can never be accidentally submitted as real data (placeholders aren't
// part of a field's value).
const EXAMPLE_LEVERS: HabitLevers = {
	identity: "I am someone who takes care of my body",
	stackedAfter: "I brush my teeth in the morning",
	whenWhere: "7am, in my bedroom",
	minimumVersion: "Just put on my running shoes",
	linkedGoal: "2026-Q3",
};

// Definitions grounded directly in James Clear's Atomic Habits framework,
// matching this vault's own Wiki/Concepts pages (Four Laws of Behavior
// Change, Habit Loop, Habit Stacking, Identity-Based Habits) rather than
// generic explanations.
const LEVER_TERM_INFO: Record<keyof HabitLevers, { term: string; definition: string }> = {
	identity: {
		term: "Identity-Based Habits",
		definition:
			'Clear\'s core claim: lasting change works top-down through identity, not bottom-up through outcomes — "not behavior change, not results change, it\'s identity change." Every completed day is a vote for the type of person you\'re becoming.',
	},
	stackedAfter: {
		term: "Habit Stacking",
		definition:
			'Law 1, Make It Obvious. Anchor a new habit to one you already do reliably: "After [current habit], I will [new habit]." The trigger habit needs to be automatic — waking up, brushing teeth, making coffee.',
	},
	whenWhere: {
		term: "Implementation Intention",
		definition:
			'Also Law 1, Make It Obvious. Clear: "clarity beats motivation" — a specific "I will [behavior] at [time] in [location]" plan beats a vague intention to do something eventually.',
	},
	minimumVersion: {
		term: "The 2-Minute Rule",
		definition:
			"Law 3, Make It Easy. Scale any habit down to a version that takes two minutes or less, to remove friction and build consistency before intensity — optimize for the starting line, not the finish line.",
	},
	linkedGoal: {
		term: "Systems Over Goals",
		definition:
			'Clear: "You do not rise to the level of your goals. You fall to the level of your systems." A habit is the system — this links it to the goal it actually serves.',
	},
};

const TYPE_INFO = {
	term: "Build vs. Break",
	definition:
		"The Four Laws of Behavior Change (make it obvious/attractive/easy/satisfying) work in reverse to break a bad habit: make it invisible, unattractive, difficult, and unsatisfying — same framework, applied backward.",
};

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
}

class HabitFormModal extends Modal {
	opts: HabitFormOptions;
	values: HabitFormValues;
	isNew: boolean;

	constructor(app: App, opts: HabitFormOptions) {
		super(app);
		this.opts = opts;
		this.isNew = !opts.initial;
		this.values = {
			name: opts.initial?.name ?? "",
			color: opts.initial?.color ?? PALETTE[0],
			type: opts.initial?.type ?? "build",
			identity: opts.initial?.identity ?? "",
			stackedAfter: opts.initial?.stackedAfter ?? "",
			whenWhere: opts.initial?.whenWhere ?? "",
			minimumVersion: opts.initial?.minimumVersion ?? "",
			linkedGoal: opts.initial?.linkedGoal ?? "",
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("habit-tracker-modal");
		contentEl.createEl("h3", { text: this.opts.title });

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
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});

		new Setting(contentEl).setName("Color");
		const swatchRow = contentEl.createDiv({ cls: "habit-tracker-swatch-row" });
		const swatches: HTMLElement[] = [];
		PALETTE.forEach((c) => {
			const swatch = swatchRow.createDiv({ cls: "habit-tracker-swatch" });
			swatch.style.backgroundColor = c;
			if (c === this.values.color) swatch.addClass("habit-tracker-swatch-selected");
			swatch.onclick = () => {
				this.values.color = c;
				swatches.forEach((s) => s.removeClass("habit-tracker-swatch-selected"));
				swatch.addClass("habit-tracker-swatch-selected");
			};
			swatches.push(swatch);
		});

		const typeSetting = new Setting(contentEl).setName("Type").addDropdown((dd) => {
			dd.addOption("build", "Build (start a habit)");
			dd.addOption("break", "Break (quit a habit)");
			dd.setValue(this.values.type);
			dd.onChange((v) => {
				this.values.type = v as HabitType;
			});
		});
		addHelpToggle(typeSetting, contentEl, TYPE_INFO.term, TYPE_INFO.definition, "Quitting smoking = Break. Morning meditation = Build.");

		contentEl.createEl("h4", { text: "Optional — Atomic Habits levers" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Each label is fixed — you're only ever typing into the box beside it. For a new habit, the grey hint text shows an example and disappears the moment you start typing that field.",
		});

		// Five separate fields rather than one combined box: the label
		// (Setting.setName) isn't part of any editable control, so it can't
		// be typed into or deleted, and each field's own native placeholder
		// clears itself the instant that specific field is typed into —
		// both were explicit requirements, and both are just how these
		// primitives already behave, no custom logic required.
		const leverRows: { label: string; key: keyof HabitLevers; example: string }[] = [
			{ label: "Identity", key: "identity", example: EXAMPLE_LEVERS.identity },
			{ label: "Stack", key: "stackedAfter", example: EXAMPLE_LEVERS.stackedAfter },
			{ label: "When/Where", key: "whenWhere", example: EXAMPLE_LEVERS.whenWhere },
			{ label: "Minimum", key: "minimumVersion", example: EXAMPLE_LEVERS.minimumVersion },
			{ label: "Goal", key: "linkedGoal", example: EXAMPLE_LEVERS.linkedGoal },
		];
		for (const row of leverRows) {
			const setting = new Setting(contentEl).setName(row.label).addTextArea((text) => {
				if (this.isNew) text.setPlaceholder(row.example);
				text.setValue(this.values[row.key]).onChange((v) => {
					this.values[row.key] = v;
					autoGrow(text.inputEl);
				});
				text.inputEl.addClass("habit-tracker-lever-input");
				text.inputEl.rows = 1;
				window.setTimeout(() => autoGrow(text.inputEl), 0);
			});
			setting.settingEl.addClass("habit-tracker-lever-setting");
			const info = LEVER_TERM_INFO[row.key];
			addHelpToggle(setting, contentEl, info.term, info.definition, row.example);
		}

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const submitBtn = footer.createEl("button", { text: this.opts.submitLabel, cls: "mod-cta" });
		submitBtn.onclick = () => this.submit();

		window.setTimeout(() => nameInputEl?.focus(), 0);
	}

	submit() {
		if (!this.values.name.trim()) {
			new Notice("Habit needs a name.");
			return;
		}
		this.opts.onSubmit({
			...this.values,
			name: this.values.name.trim(),
			identity: this.values.identity.trim(),
			stackedAfter: this.values.stackedAfter.trim(),
			whenWhere: this.values.whenWhere.trim(),
			minimumVersion: this.values.minimumVersion.trim(),
			linkedGoal: this.values.linkedGoal.trim(),
		});
		this.close();
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
}

type ViewMode = "week" | "month" | "year";
type CellStyle = "year" | "week" | "month";

class HabitTrackerBlock extends MarkdownRenderChild {
	plugin: HabitTrackerPlugin;
	filterName: string | null;
	currentView: ViewMode;
	// Remembers each habit's year-view horizontal scroll position across
	// re-renders (every click triggers a full rebuild via refreshAll,
	// which would otherwise reset scroll back to January every time).
	yearScrollByHabit: Map<string, number> = new Map();

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
		const habits = this.filterName
			? data.habits.filter((h) => h.name.toLowerCase() === this.filterName!.toLowerCase())
			: data.habits;

		const toggleRow = el.createDiv({ cls: "habit-tracker-global-toggle-row" });
		const toggle = toggleRow.createDiv({ cls: "habit-tracker-view-toggle" });
		const modeLabels: Record<ViewMode, string> = { week: "Week", month: "Month", year: "Year" };
		(["week", "month", "year"] as ViewMode[]).forEach((mode) => {
			const b = toggle.createEl("button", {
				text: modeLabels[mode],
				cls: "habit-tracker-view-btn" + (this.currentView === mode ? " habit-tracker-view-btn-active" : ""),
			});
			b.onclick = () => {
				this.currentView = mode;
				this.render();
			};
		});

		if (habits.length === 0 && !this.filterName) {
			el.createDiv({
				text: "No habits yet — add your first one below.",
				cls: "habit-tracker-empty",
			});
		} else if (habits.length === 0 && this.filterName) {
			el.createDiv({
				text: `No habit named "${this.filterName}" yet.`,
				cls: "habit-tracker-empty",
			});
		}

		const list = el.createDiv({ cls: "habit-tracker-list" });
		for (const habit of habits) {
			this.renderHabit(list, habit);
		}

		if (!this.filterName) {
			const addCard = list.createDiv({ cls: "habit-tracker-add-card" });
			addCard.createSpan({ text: "+", cls: "habit-tracker-add-icon" });
			addCard.createSpan({ text: "Add habit", cls: "habit-tracker-add-label" });
			addCard.onclick = () => {
				new HabitFormModal(this.plugin.app, {
					title: "New habit",
					submitLabel: "Add habit",
					onSubmit: async (values) => {
						const habit: HabitDefinition = {
							id: slugify(values.name) + "-" + Date.now(),
							name: values.name,
							color: values.color,
							createdAt: todayStr(),
							type: values.type,
							identity: values.identity || undefined,
							stackedAfter: values.stackedAfter || undefined,
							whenWhere: values.whenWhere || undefined,
							minimumVersion: values.minimumVersion || undefined,
							linkedGoal: values.linkedGoal || undefined,
						};
						this.plugin.data.habits.push(habit);
						this.plugin.data.entries[habit.id] = {};
						await this.plugin.persist();
						this.plugin.refreshAll();
					},
				}).open();
			};
		}
	}

	renderHabit(parentEl: HTMLElement, habit: HabitDefinition) {
		const entries = this.plugin.data.entries[habit.id] || (this.plugin.data.entries[habit.id] = {});
		const stats = computeStats(entries);
		const view = this.currentView;

		const card = parentEl.createDiv({ cls: "habit-tracker-habit" });
		card.style.setProperty("--habit-color", habit.color);
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

		const totalPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		totalPill.createSpan({ text: `${stats.total}`, cls: "habit-tracker-pill-value" });
		totalPill.createSpan({ text: "votes", cls: "habit-tracker-pill-label" });

		const yearPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		yearPill.createSpan({ text: `${stats.totalThisYear}`, cls: "habit-tracker-pill-value" });
		yearPill.createSpan({ text: "this year", cls: "habit-tracker-pill-label" });

		const editBtn = statsRow.createSpan({ text: "✏️", cls: "habit-tracker-edit-btn" });
		editBtn.setAttr("aria-label", "Edit habit");
		editBtn.onclick = () => {
			new HabitFormModal(this.plugin.app, {
				title: "Edit habit",
				submitLabel: "Save",
				initial: habit,
				onSubmit: async (values) => {
					habit.name = values.name;
					habit.color = values.color;
					habit.type = values.type;
					habit.identity = values.identity || undefined;
					habit.stackedAfter = values.stackedAfter || undefined;
					habit.whenWhere = values.whenWhere || undefined;
					habit.minimumVersion = values.minimumVersion || undefined;
					habit.linkedGoal = values.linkedGoal || undefined;
					await this.plugin.persist();
					this.plugin.refreshAll();
				},
			}).open();
		};

		const deleteBtn = statsRow.createSpan({ text: "🗑", cls: "habit-tracker-delete-btn" });
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

		// Atomic Habits detail line(s) — only rendered when set, so a habit
		// with none of these looks exactly as plain as before.
		if (habit.identity) {
			card.createDiv({ text: `→ ${habit.identity}`, cls: "habit-tracker-identity" });
		}
		const metaBits: string[] = [];
		if (habit.stackedAfter) metaBits.push(`⛓ After: ${habit.stackedAfter}`);
		if (habit.whenWhere) metaBits.push(`📍 ${habit.whenWhere}`);
		if (metaBits.length) {
			card.createDiv({ text: metaBits.join("   ·   "), cls: "habit-tracker-meta-line" });
		}
		if (habit.minimumVersion) {
			card.createDiv({ text: `💡 Minimum version: ${habit.minimumVersion}`, cls: "habit-tracker-meta-line" });
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
			this.renderWeekGrid(grid, habit, entries);
		} else if (view === "month") {
			this.renderMonthGrid(grid, habit, entries);
		} else {
			this.renderYearGrid(grid, habit, entries);
		}
	}

	renderYearGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>) {
		const year = new Date().getFullYear();
		const jan1 = new Date(year, 0, 1);
		const dec31 = new Date(year, 11, 31);
		// Start columns at Jan 1 itself (not the nearest Sunday) so every
		// month's cells begin flush at the top row — no leading blank
		// padding days from the previous year pushing January down.
		const start = jan1;
		const totalDays = Math.round((dec31.getTime() - start.getTime()) / 86400000) + 1;
		const weeks = Math.ceil(totalDays / 7);

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

	renderWeekGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>) {
		const today = new Date();
		const start = addDays(today, -today.getDay()); // Sunday of this week

		const gridEl = container.createDiv({ cls: "habit-tracker-week-grid" });
		for (let i = 0; i < 7; i++) {
			const d = addDays(start, i);
			this.renderCell(gridEl, habit, entries, d, "week");
		}
	}

	renderMonthGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, EntryValue>) {
		const today = new Date();
		const year = today.getFullYear();
		const month = today.getMonth();
		const first = new Date(year, month, 1);
		const lastOfMonth = new Date(year, month + 1, 0);
		const start = addDays(first, -first.getDay()); // Sunday on/before the 1st
		const totalDays = Math.round((lastOfMonth.getTime() - start.getTime()) / 86400000) + 1;
		const weeks = Math.ceil(totalDays / 7);

		container.createDiv({ text: first.toLocaleString("default", { month: "long", year: "numeric" }), cls: "habit-tracker-month-title" });

		const headerRow = container.createDiv({ cls: "habit-tracker-month-weekday-header" });
		["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((wd) => {
			headerRow.createSpan({ text: wd });
		});

		const gridEl = container.createDiv({ cls: "habit-tracker-month-grid" });
		// Row-major order matches the grid's default (row) auto-flow.
		for (let w = 0; w < weeks; w++) {
			for (let col = 0; col < 7; col++) {
				const d = addDays(start, w * 7 + col);
				if (d.getMonth() !== month || d.getFullYear() !== year) {
					gridEl.createDiv({ cls: "habit-tracker-week-cell habit-tracker-cell-blank" });
					continue;
				}
				this.renderCell(gridEl, habit, entries, d, "month");
			}
		}
	}

	renderCell(
		gridEl: HTMLElement,
		habit: HabitDefinition,
		entries: Record<string, EntryValue>,
		d: Date,
		style: CellStyle
	) {
		const today = new Date();
		const dateStr = formatDate(d);
		const boxed = style !== "year";
		const cell = gridEl.createDiv({
			cls: boxed ? "habit-tracker-week-cell" : "habit-tracker-cell",
		});
		cell.setAttr("data-date", dateStr);
		// Only show the hover tooltip on the small year-view squares — the
		// week/month cells already print the date directly, and the
		// tooltip's positioning logic overflows past the card edge for
		// cells near the left/top border, so it's both redundant and buggy
		// there.
		if (style === "year") {
			cell.setAttr("aria-label", dateStr);
		}

		if (style === "week") {
			cell.createDiv({ text: d.toLocaleString("default", { weekday: "short" }), cls: "habit-tracker-week-day-label" });
			cell.createDiv({ text: "" + d.getDate(), cls: "habit-tracker-week-date-label" });
		} else if (style === "month") {
			cell.createDiv({ text: "" + d.getDate(), cls: "habit-tracker-week-date-label" });
		} else {
			cell.createSpan({ text: "" + d.getDate(), cls: "habit-tracker-cell-daynum" });
		}

		const futureCls = boxed ? "habit-tracker-week-cell-future" : "habit-tracker-cell-future";
		const doneCls = boxed ? "habit-tracker-week-cell-done" : "habit-tracker-cell-done";

		if (d > today) {
			cell.addClass(futureCls);
		}

		if (entries[dateStr]) {
			cell.addClass(doneCls);
			cell.style.backgroundColor = habit.color;
			if (entries[dateStr] === "min") {
				cell.addClass(boxed ? "habit-tracker-week-cell-min" : "habit-tracker-cell-min");
			}
		}
		if (dateStr === todayStr()) {
			cell.addClass("habit-tracker-cell-today");
		}
		cell.onclick = async () => {
			const oldStreak = computeStats(entries).streak;
			const next = nextEntryValue(entries[dateStr]);
			if (next === undefined) {
				delete entries[dateStr];
			} else {
				entries[dateStr] = next;
			}
			await this.plugin.persist();
			this.plugin.refreshAll();
			if (next) {
				const newStreak = computeStats(entries).streak;
				this.plugin.maybeCelebrate(habit, oldStreak, newStreak);
			}
		};
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

	return { habits: Array.from(habitsById.values()), entries };
}

export default class HabitTrackerPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;
	supabase: SupabaseClient | null = null;
	session: Session | null = null;
	private realtimeChannel: RealtimeChannel | null = null;
	private blocks: Set<HabitTrackerBlock> = new Set();

	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings);
		this.data = {
			habits: saved?.habits ?? DEFAULT_DATA.habits,
			entries: saved?.entries ?? DEFAULT_DATA.entries,
		};

		this.addSettingTab(new HabitTrackerSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor("habit-tracker", (source, el, ctx) => {
			const filterMatch = source.match(/^\s*habit:\s*(.+)\s*$/m);
			const filterName = filterMatch ? filterMatch[1].trim() : null;
			const viewMatch = source.match(/^\s*view:\s*(week|month|year)\s*$/m);
			// Year view's wide, horizontally-scrolling grid works well with a
			// mouse on a desktop pane, but is a poor first impression on a
			// narrow phone screen — default to Week there instead unless the
			// note explicitly requests a view.
			const defaultView: ViewMode = viewMatch ? (viewMatch[1] as ViewMode) : Platform.isMobile ? "week" : "year";
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
				const onDiskData: PluginData = { habits: onDisk.habits ?? [], entries: onDisk.entries ?? {} };
				if (JSON.stringify(onDiskData) !== JSON.stringify(this.data)) {
					this.data = onDiskData;
					this.refreshAll();
				}
			}, 5000)
		);

		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
			await this.initSupabase();
		}
	}

	onunload() {
		if (this.realtimeChannel) this.supabase?.removeChannel(this.realtimeChannel);
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
					this.data = { habits: incoming.habits ?? [], entries: incoming.entries ?? {} };
					this.saveLocal();
					this.refreshAll();
				}
			)
			.subscribe();
	}

	async saveLocal() {
		await this.saveData({ settings: this.settings, habits: this.data.habits, entries: this.data.entries });
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

	// Law 4 (Make it Satisfying): an immediate reward beyond the visual
	// heatmap for crossing a real milestone, since delayed real-world
	// payoffs are exactly what habit tracking is meant to compensate for.
	maybeCelebrate(habit: HabitDefinition, oldStreak: number, newStreak: number) {
		const milestones = [7, 30, 60, 100, 365];
		for (const m of milestones) {
			if (oldStreak < m && newStreak >= m) {
				const label = habit.type === "break" ? "clean streak" : "day streak";
				new Notice(`🎉 ${newStreak}-${label} on "${habit.name}"! Keep going.`);
				break;
			}
		}
	}
}
