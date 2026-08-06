import { Plugin, MarkdownRenderChild, Modal, App, Setting, Notice } from "obsidian";

interface HabitDefinition {
	id: string;
	name: string;
	color: string;
	createdAt: string; // YYYY-MM-DD
}

interface PluginData {
	habits: HabitDefinition[];
	entries: Record<string, Record<string, boolean>>; // habitId -> "YYYY-MM-DD" -> done
}

const DEFAULT_DATA: PluginData = { habits: [], entries: {} };

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

interface Stats {
	streak: number;
	total: number;
	totalThisYear: number;
}

function computeStats(entries: Record<string, boolean>): Stats {
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

	return { streak, total, totalThisYear };
}

interface HabitFormOptions {
	title: string;
	submitLabel: string;
	initialName?: string;
	initialColor?: string;
	onSubmit: (name: string, color: string) => void;
}

class HabitFormModal extends Modal {
	opts: HabitFormOptions;
	name: string;
	color: string;

	constructor(app: App, opts: HabitFormOptions) {
		super(app);
		this.opts = opts;
		this.name = opts.initialName ?? "";
		this.color = opts.initialColor ?? PALETTE[0];
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
				.setValue(this.name)
				.onChange((value) => {
					this.name = value;
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
			if (c === this.color) swatch.addClass("habit-tracker-swatch-selected");
			swatch.onclick = () => {
				this.color = c;
				swatches.forEach((s) => s.removeClass("habit-tracker-swatch-selected"));
				swatch.addClass("habit-tracker-swatch-selected");
			};
			swatches.push(swatch);
		});

		const footer = contentEl.createDiv({ cls: "habit-tracker-modal-footer" });
		const submitBtn = footer.createEl("button", { text: this.opts.submitLabel, cls: "mod-cta" });
		submitBtn.onclick = () => this.submit();

		window.setTimeout(() => nameInputEl?.focus(), 0);
	}

	submit() {
		if (!this.name.trim()) {
			new Notice("Habit needs a name.");
			return;
		}
		this.opts.onSubmit(this.name.trim(), this.color);
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
					onSubmit: async (name, color) => {
						const habit: HabitDefinition = {
							id: slugify(name) + "-" + Date.now(),
							name,
							color,
							createdAt: todayStr(),
						};
						this.plugin.data.habits.push(habit);
						this.plugin.data.entries[habit.id] = {};
						await this.plugin.saveData(this.plugin.data);
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

		const header = card.createDiv({ cls: "habit-tracker-header" });
		const titleRow = header.createDiv({ cls: "habit-tracker-title-row" });
		const dot = titleRow.createSpan({ cls: "habit-tracker-dot" });
		dot.style.backgroundColor = habit.color;
		titleRow.createSpan({ text: habit.name, cls: "habit-tracker-name" });

		const statsRow = header.createDiv({ cls: "habit-tracker-stats-row" });
		const streakPill = statsRow.createDiv({ cls: "habit-tracker-pill habit-tracker-pill-streak" });
		streakPill.createSpan({ text: "🔥", cls: "habit-tracker-pill-icon" });
		streakPill.createSpan({ text: `${stats.streak}`, cls: "habit-tracker-pill-value" });
		streakPill.createSpan({ text: "streak", cls: "habit-tracker-pill-label" });

		const totalPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		totalPill.createSpan({ text: `${stats.total}`, cls: "habit-tracker-pill-value" });
		totalPill.createSpan({ text: "total", cls: "habit-tracker-pill-label" });

		const yearPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
		yearPill.createSpan({ text: `${stats.totalThisYear}`, cls: "habit-tracker-pill-value" });
		yearPill.createSpan({ text: "this year", cls: "habit-tracker-pill-label" });

		const editBtn = statsRow.createSpan({ text: "✏️", cls: "habit-tracker-edit-btn" });
		editBtn.setAttr("aria-label", "Edit habit");
		editBtn.onclick = () => {
			new HabitFormModal(this.plugin.app, {
				title: "Edit habit",
				submitLabel: "Save",
				initialName: habit.name,
				initialColor: habit.color,
				onSubmit: async (name, color) => {
					habit.name = name;
					habit.color = color;
					await this.plugin.saveData(this.plugin.data);
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
				await this.plugin.saveData(this.plugin.data);
				this.plugin.refreshAll();
			}).open();
		};

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

	renderYearGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, boolean>) {
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

	renderWeekGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, boolean>) {
		const today = new Date();
		const start = addDays(today, -today.getDay()); // Sunday of this week

		const gridEl = container.createDiv({ cls: "habit-tracker-week-grid" });
		for (let i = 0; i < 7; i++) {
			const d = addDays(start, i);
			this.renderCell(gridEl, habit, entries, d, "week");
		}
	}

	renderMonthGrid(container: HTMLElement, habit: HabitDefinition, entries: Record<string, boolean>) {
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
		entries: Record<string, boolean>,
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
		}
		if (dateStr === todayStr()) {
			cell.addClass("habit-tracker-cell-today");
		}
		cell.onclick = async () => {
			entries[dateStr] = !entries[dateStr];
			if (!entries[dateStr]) delete entries[dateStr];
			await this.plugin.saveData(this.plugin.data);
			this.plugin.refreshAll();
		};
	}
}

export default class HabitTrackerPlugin extends Plugin {
	data: PluginData;
	private blocks: Set<HabitTrackerBlock> = new Set();

	async onload() {
		this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
		if (!this.data.habits) this.data.habits = [];
		if (!this.data.entries) this.data.entries = {};

		this.registerMarkdownCodeBlockProcessor("habit-tracker", (source, el, ctx) => {
			const filterMatch = source.match(/^\s*habit:\s*(.+)\s*$/m);
			const filterName = filterMatch ? filterMatch[1].trim() : null;
			const viewMatch = source.match(/^\s*view:\s*(week|month|year)\s*$/m);
			const defaultView: ViewMode = viewMatch ? (viewMatch[1] as ViewMode) : "year";
			const block = new HabitTrackerBlock(el, this, filterName, defaultView);
			ctx.addChild(block);
		});
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
}
