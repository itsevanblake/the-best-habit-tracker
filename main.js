var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => HabitTrackerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_DATA = { habits: [], entries: {} };
var PALETTE = ["#2e8840", "#1872ff", "#e73400", "#dd6f00", "#c30062", "#7bc96f"];
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}
function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayStr() {
  return formatDate(/* @__PURE__ */ new Date());
}
function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "habit";
}
function computeStats(entries) {
  let total = 0;
  let totalThisYear = 0;
  const currentYear = "" + (/* @__PURE__ */ new Date()).getFullYear();
  for (const date in entries) {
    if (entries[date]) {
      total++;
      if (date.startsWith(currentYear))
        totalThisYear++;
    }
  }
  let streak = 0;
  let missStreak = 0;
  let cursor = /* @__PURE__ */ new Date();
  let isToday = true;
  while (true) {
    const dateStr = formatDate(cursor);
    if (entries[dateStr]) {
      streak++;
      missStreak = 0;
    } else if (!isToday) {
      missStreak++;
      if (missStreak >= 2)
        break;
    }
    isToday = false;
    cursor = addDays(cursor, -1);
  }
  return { streak, total, totalThisYear };
}
var HabitFormModal = class extends import_obsidian.Modal {
  constructor(app, opts) {
    var _a, _b;
    super(app);
    this.opts = opts;
    this.name = (_a = opts.initialName) != null ? _a : "";
    this.color = (_b = opts.initialColor) != null ? _b : PALETTE[0];
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("habit-tracker-modal");
    contentEl.createEl("h3", { text: this.opts.title });
    const nameSetting = new import_obsidian.Setting(contentEl).setName("Name");
    let nameInputEl;
    nameSetting.addText((text) => {
      nameInputEl = text.inputEl;
      text.setPlaceholder("e.g. Morning run").setValue(this.name).onChange((value) => {
        this.name = value;
      });
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter")
          this.submit();
      });
    });
    new import_obsidian.Setting(contentEl).setName("Color");
    const swatchRow = contentEl.createDiv({ cls: "habit-tracker-swatch-row" });
    const swatches = [];
    PALETTE.forEach((c) => {
      const swatch = swatchRow.createDiv({ cls: "habit-tracker-swatch" });
      swatch.style.backgroundColor = c;
      if (c === this.color)
        swatch.addClass("habit-tracker-swatch-selected");
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
    window.setTimeout(() => nameInputEl == null ? void 0 : nameInputEl.focus(), 0);
  }
  submit() {
    if (!this.name.trim()) {
      new import_obsidian.Notice("Habit needs a name.");
      return;
    }
    this.opts.onSubmit(this.name.trim(), this.color);
    this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ConfirmDeleteModal = class extends import_obsidian.Modal {
  constructor(app, habitName, onConfirm) {
    super(app);
    this.habitName = habitName;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("habit-tracker-modal");
    contentEl.createEl("h3", { text: "Delete habit?" });
    contentEl.createEl("p", {
      text: `"${this.habitName}" and all of its check-in history will be permanently deleted. This can't be undone.`
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
};
var HabitTrackerBlock = class extends import_obsidian.MarkdownRenderChild {
  constructor(containerEl, plugin, filterName, defaultView) {
    super(containerEl);
    // Remembers each habit's year-view horizontal scroll position across
    // re-renders (every click triggers a full rebuild via refreshAll,
    // which would otherwise reset scroll back to January every time).
    this.yearScrollByHabit = /* @__PURE__ */ new Map();
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
    el.querySelectorAll(".habit-tracker-grid-wrap[data-habit-id]").forEach((w) => {
      const id = w.getAttribute("data-habit-id");
      if (id)
        this.yearScrollByHabit.set(id, w.scrollLeft);
    });
    el.empty();
    el.addClass("habit-tracker-root");
    const data = this.plugin.data;
    const habits = this.filterName ? data.habits.filter((h) => h.name.toLowerCase() === this.filterName.toLowerCase()) : data.habits;
    const toggleRow = el.createDiv({ cls: "habit-tracker-global-toggle-row" });
    const toggle = toggleRow.createDiv({ cls: "habit-tracker-view-toggle" });
    const modeLabels = { week: "Week", month: "Month", year: "Year" };
    ["week", "month", "year"].forEach((mode) => {
      const b = toggle.createEl("button", {
        text: modeLabels[mode],
        cls: "habit-tracker-view-btn" + (this.currentView === mode ? " habit-tracker-view-btn-active" : "")
      });
      b.onclick = () => {
        this.currentView = mode;
        this.render();
      };
    });
    if (habits.length === 0 && !this.filterName) {
      el.createDiv({
        text: "No habits yet \u2014 add your first one below.",
        cls: "habit-tracker-empty"
      });
    } else if (habits.length === 0 && this.filterName) {
      el.createDiv({
        text: `No habit named "${this.filterName}" yet.`,
        cls: "habit-tracker-empty"
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
            const habit = {
              id: slugify(name) + "-" + Date.now(),
              name,
              color,
              createdAt: todayStr()
            };
            this.plugin.data.habits.push(habit);
            this.plugin.data.entries[habit.id] = {};
            await this.plugin.saveData(this.plugin.data);
            this.plugin.refreshAll();
          }
        }).open();
      };
    }
  }
  renderHabit(parentEl, habit) {
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
    streakPill.createSpan({ text: "\u{1F525}", cls: "habit-tracker-pill-icon" });
    streakPill.createSpan({ text: `${stats.streak}`, cls: "habit-tracker-pill-value" });
    streakPill.createSpan({ text: "streak", cls: "habit-tracker-pill-label" });
    const totalPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
    totalPill.createSpan({ text: `${stats.total}`, cls: "habit-tracker-pill-value" });
    totalPill.createSpan({ text: "total", cls: "habit-tracker-pill-label" });
    const yearPill = statsRow.createDiv({ cls: "habit-tracker-pill" });
    yearPill.createSpan({ text: `${stats.totalThisYear}`, cls: "habit-tracker-pill-value" });
    yearPill.createSpan({ text: "this year", cls: "habit-tracker-pill-label" });
    const editBtn = statsRow.createSpan({ text: "\u270F\uFE0F", cls: "habit-tracker-edit-btn" });
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
        }
      }).open();
    };
    const deleteBtn = statsRow.createSpan({ text: "\u{1F5D1}", cls: "habit-tracker-delete-btn" });
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
  renderYearGrid(container, habit, entries) {
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const jan1 = new Date(year, 0, 1);
    const dec31 = new Date(year, 11, 31);
    const start = jan1;
    const totalDays = Math.round((dec31.getTime() - start.getTime()) / 864e5) + 1;
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
    for (let w = 0; w < weeks; w++) {
      for (let row = 0; row < 7; row++) {
        const d = addDays(start, w * 7 + row);
        if (d.getFullYear() !== year) {
          const blank = gridEl.createDiv({ cls: "habit-tracker-cell habit-tracker-cell-blank" });
          continue;
        }
        this.renderCell(gridEl, habit, entries, d, "year");
      }
    }
    const savedScroll = this.yearScrollByHabit.get(habit.id);
    requestAnimationFrame(() => {
      if (savedScroll !== void 0) {
        container.scrollLeft = savedScroll;
      } else {
        const todayCell = gridEl.querySelector(`[data-date="${todayStr()}"]`);
        todayCell == null ? void 0 : todayCell.scrollIntoView({ inline: "center", block: "nearest" });
      }
    });
  }
  renderWeekGrid(container, habit, entries) {
    const today = /* @__PURE__ */ new Date();
    const start = addDays(today, -today.getDay());
    const gridEl = container.createDiv({ cls: "habit-tracker-week-grid" });
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      this.renderCell(gridEl, habit, entries, d, "week");
    }
  }
  renderMonthGrid(container, habit, entries) {
    const today = /* @__PURE__ */ new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const first = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);
    const start = addDays(first, -first.getDay());
    const totalDays = Math.round((lastOfMonth.getTime() - start.getTime()) / 864e5) + 1;
    const weeks = Math.ceil(totalDays / 7);
    container.createDiv({ text: first.toLocaleString("default", { month: "long", year: "numeric" }), cls: "habit-tracker-month-title" });
    const headerRow = container.createDiv({ cls: "habit-tracker-month-weekday-header" });
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((wd) => {
      headerRow.createSpan({ text: wd });
    });
    const gridEl = container.createDiv({ cls: "habit-tracker-month-grid" });
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
  renderCell(gridEl, habit, entries, d, style) {
    const today = /* @__PURE__ */ new Date();
    const dateStr = formatDate(d);
    const boxed = style !== "year";
    const cell = gridEl.createDiv({
      cls: boxed ? "habit-tracker-week-cell" : "habit-tracker-cell"
    });
    cell.setAttr("data-date", dateStr);
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
      if (!entries[dateStr])
        delete entries[dateStr];
      await this.plugin.saveData(this.plugin.data);
      this.plugin.refreshAll();
    };
  }
};
var HabitTrackerPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.blocks = /* @__PURE__ */ new Set();
  }
  async onload() {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    if (!this.data.habits)
      this.data.habits = [];
    if (!this.data.entries)
      this.data.entries = {};
    this.registerMarkdownCodeBlockProcessor("habit-tracker", (source, el, ctx) => {
      const filterMatch = source.match(/^\s*habit:\s*(.+)\s*$/m);
      const filterName = filterMatch ? filterMatch[1].trim() : null;
      const viewMatch = source.match(/^\s*view:\s*(week|month|year)\s*$/m);
      const defaultView = viewMatch ? viewMatch[1] : "year";
      const block = new HabitTrackerBlock(el, this, filterName, defaultView);
      ctx.addChild(block);
    });
  }
  registerBlock(block) {
    this.blocks.add(block);
  }
  unregisterBlock(block) {
    this.blocks.delete(block);
  }
  refreshAll() {
    for (const block of this.blocks) {
      block.render();
    }
  }
};
