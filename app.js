import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const LEGACY_KEY = "daybook-tracker-v1";
const GUEST_KEY = "daybook-tracker-v2:guest";
const LAST_USER_KEY = "daybook-tracker-last-user";
const HABIT_CATEGORIES = ["Health", "Fitness", "Mindfulness", "Learning", "Personal care", "Home", "Other"];
const $ = (selector) => document.querySelector(selector);
const dateInput = $("#selected-date");
const welcomeScreen = $("#welcome-screen");
const trackerShell = $("#tracker-shell");
const habitForm = $("#habit-form");
const habitNameInput = $("#habit-name");
const habitList = $("#habit-list");
const expenseForm = $("#expense-form");
const expenseList = $("#expense-list");
const statusMessage = $("#status-message");

const initialData = () => ({ habits: [], expenses: [], monthlyBudgets: {} });

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeData(value) {
  if (!value || !Array.isArray(value.habits) || !Array.isArray(value.expenses)) {
    throw new Error("Saved tracker data is not in the expected format.");
  }
  return {
    habits: value.habits.map((habit) => ({
      id: String(habit.id),
      name: String(habit.name),
      category: HABIT_CATEGORIES.includes(habit.category) ? habit.category : "Other",
      completedDates: Array.isArray(habit.completedDates) ? habit.completedDates : []
    })),
    expenses: value.expenses.map((expense) => ({
      id: String(expense.id),
      date: String(expense.date),
      note: String(expense.note),
      category: String(expense.category),
      amount: Number(expense.amount)
    })).filter((expense) => Number.isFinite(expense.amount)),
    monthlyBudgets: value.monthlyBudgets && typeof value.monthlyBudgets === "object" ? value.monthlyBudgets : {}
  };
}

function readData(key) {
  const saved = localStorage.getItem(key);
  if (saved) return normalizeData(JSON.parse(saved));
  if (key === GUEST_KEY) {
    const oldData = localStorage.getItem(LEGACY_KEY);
    if (oldData) return normalizeData(JSON.parse(oldData));
  }
  return initialData();
}

let startupStorageKey = GUEST_KEY;
const cachedUserId = localStorage.getItem(LAST_USER_KEY);
if (!navigator.onLine && cachedUserId) startupStorageKey = localDataKey(cachedUserId);

let data;
try {
  data = readData(startupStorageKey);
} catch (error) {
  const message = document.createElement("main");
  message.className = "app-shell";
  const heading = document.createElement("h1");
  heading.textContent = "Couldn't load your tracker";
  const details = document.createElement("p");
  details.textContent = error.message;
  const reassurance = document.createElement("p");
  reassurance.textContent = "Your saved data has not been changed.";
  message.append(heading, details, reassurance);
  document.body.replaceChildren(message);
  throw error;
}

let currentStorageKey = startupStorageKey;
let cloudModules = null;
let cloudUser = null;
let cloudWriteQueue = Promise.resolve();
let cloudLoading = false;
let localChangesPendingKey = null;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
function selectedDate() {
  return dateInput.value || localDateString(new Date());
}

function selectedMonth() {
  return selectedDate().slice(0, 7);
}

function money(amount) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function setStatus(message, state) {
  const indicator = $("#connection-state");
  indicator.textContent = message;
  indicator.classList.toggle("is-online", state === "online");
  indicator.classList.toggle("is-warning", state === "warning");
  statusMessage.textContent = message;
}

function showTracker(mode) {
  welcomeScreen.classList.add("hidden");
  trackerShell.classList.remove("hidden");
  if (mode) sessionStorage.setItem("daybook-mode", mode);
}

function showWelcome() {
  welcomeScreen.classList.remove("hidden");
  trackerShell.classList.add("hidden");
}

function localDataKey(userId) {
  return `daybook-tracker-v2:user:${userId}`;
}

function persistLocal() {
  try {
    localStorage.setItem(currentStorageKey, JSON.stringify(data));
    statusMessage.textContent = "Saved on this device.";
    return true;
  } catch (error) {
    setStatus("Couldn't save locally", "warning");
    console.error("Unable to save tracker data to this device.", error);
    alert("Could not save your changes. Check browser storage settings.");
    return false;
  }
}

function queueCloudSave() {
  if (!cloudUser || !cloudModules || !navigator.onLine) return;
  const userId = cloudUser.uid;
  const snapshot = JSON.parse(JSON.stringify(data));
  cloudWriteQueue = cloudWriteQueue.then(async () => {
    await cloudModules.set(
      cloudModules.ref(cloudModules.database, `users/${userId}/tracker`),
      snapshot
    );
    if (cloudUser && cloudUser.uid === userId) setStatus(`Synced · ${cloudUser.email}`, "online");
  }).catch((error) => {
    console.error("Firebase sync failed.", error);
    if (cloudUser && cloudUser.uid === userId) setStatus("Saved locally · cloud sync needs attention", "warning");
  });
}

function saveData() {
  if (!persistLocal()) return;
  if (cloudUser) {
    queueCloudSave();
  } else if (currentStorageKey !== GUEST_KEY) {
    localChangesPendingKey = currentStorageKey;
  }
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthExpenses(month) {
  return data.expenses.filter((expense) => expense.date.startsWith(month));
}

function currentStreak(habit, endDate) {
  const dates = new Set(habit.completedDates);
  let cursor = new Date(`${endDate}T12:00:00`);
  const today = localDateString(new Date());
  if (!dates.has(localDateString(cursor)) && endDate >= today) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (dates.has(localDateString(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function longestStreak(habit) {
  const dates = [...new Set(habit.completedDates)].sort();
  const dayNumber = (date) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  let best = 0;
  let run = 0;
  let previous = null;
  dates.forEach((date) => {
    run = previous && dayNumber(date) - dayNumber(previous) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = date;
  });
  return best;
}

function buildBadges() {
  const checkIns = data.habits.reduce((total, habit) => total + new Set(habit.completedDates).size, 0);
  const maxStreak = Math.max(0, ...data.habits.map(longestStreak));
  const definitions = [
    { title: "First step", detail: "Complete a habit once", earned: checkIns >= 1, icon: "🌱" },
    { title: "Three in a row", detail: "Build a 3-day habit streak", earned: maxStreak >= 3, icon: "🔥" },
    { title: "One-week rhythm", detail: "Build a 7-day habit streak", earned: maxStreak >= 7, icon: "🌿" },
    { title: "A whole month", detail: "Build a 30-day habit streak", earned: maxStreak >= 30, icon: "🏆" },
    { title: "Mindful logger", detail: "Log 10 food expenses", earned: data.expenses.length >= 10, icon: "🧾" }
  ];
  const badgeList = $("#badge-list");
  badgeList.replaceChildren();
  definitions.forEach((badge) => {
    const card = document.createElement("article");
    card.className = `badge-card${badge.earned ? " earned" : ""}`;
    card.innerHTML = `<span class="badge-icon" aria-hidden="true">${badge.icon}</span><strong>${escapeText(badge.title)}</strong><span>${escapeText(badge.detail)}</span><small>${badge.earned ? "Earned" : "In progress"}</small>`;
    badgeList.append(card);
  });
  const earned = definitions.filter((badge) => badge.earned).length;
  $("#badge-count").textContent = `${earned} of ${definitions.length} earned`;
}

function renderHabits() {
  const date = selectedDate();
  const completedCount = data.habits.filter((habit) => habit.completedDates.includes(date)).length;
  $("#habits-done").textContent = completedCount;
  $("#habits-total").textContent = data.habits.length;
  $("#habit-count").textContent = `${data.habits.length} ${data.habits.length === 1 ? "habit" : "habits"}`;
  $("#habit-summary-note").textContent = data.habits.length && completedCount === data.habits.length
    ? "Lovely work showing up today"
    : data.habits.length ? "Every small step counts" : "Start with one small win";
  habitList.replaceChildren();
  data.habits.forEach((habit) => {
    const done = habit.completedDates.includes(date);
    const streak = currentStreak(habit, date);
    const item = document.createElement("li");
    item.className = `habit-row${done ? " is-done" : ""}`;
    item.innerHTML = `<button class="habit-toggle" type="button" aria-label="${done ? "Mark incomplete" : "Mark complete"}: ${escapeText(habit.name)}" aria-pressed="${done}" data-toggle-habit="${escapeText(habit.id)}">${done ? "✓" : ""}</button><span class="habit-name">${escapeText(habit.name)}</span><span class="habit-category-chip">${escapeText(habit.category)}</span><span class="streak-chip" title="Current consecutive-day streak">🔥 ${streak}</span><button class="delete-button" type="button" aria-label="Delete habit: ${escapeText(habit.name)}" data-delete-habit="${escapeText(habit.id)}">×</button>`;
    habitList.append(item);
  });
  $("#habit-empty").classList.toggle("visible", data.habits.length === 0);
  buildBadges();
}

function getDailyTotals(expenses) {
  return expenses.reduce((totals, expense) => {
    totals[expense.date] = (totals[expense.date] || 0) + expense.amount;
    return totals;
  }, {});
}

function dateOffset(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function renderWeeklyReport() {
  const selected = new Date(`${selectedDate()}T12:00:00`);
  const weekStart = new Date(selected);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const start = localDateString(weekStart);
  const end = dateOffset(start, 6);
  const previousStart = dateOffset(start, -7);
  const previousEnd = dateOffset(start, -1);
  const weekExpenses = data.expenses.filter((expense) => expense.date >= start && expense.date <= end);
  const priorExpenses = data.expenses.filter((expense) => expense.date >= previousStart && expense.date <= previousEnd);
  const total = weekExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const priorTotal = priorExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const checkIns = data.habits.reduce((sum, habit) => sum + habit.completedDates.filter((date) => date >= start && date <= end).length, 0);
  const activeHabitDays = new Set(data.habits.flatMap((habit) => habit.completedDates.filter((date) => date >= start && date <= end))).size;
  const weekDates = Array.from({ length: 7 }, (_, index) => dateOffset(start, index));
  const dailyTotals = getDailyTotals(weekExpenses);
  const dailyMax = Math.max(0, ...Object.values(dailyTotals));
  const displayDate = (date) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
  const dateRange = `${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(weekStart)} – ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${end}T12:00:00`))}`;
  $("#weekly-range").textContent = dateRange;

  let comparison = "No food expenses logged in the previous week.";
  if (priorTotal > 0) {
    const change = Math.round(((total - priorTotal) / priorTotal) * 100);
    comparison = change > 0 ? `Food spending is up ${change}% from last week.` : change < 0 ? `Food spending is down ${Math.abs(change)}% from last week.` : "Food spending is unchanged from last week.";
  } else if (total > 0) {
    comparison = "This is your first week with food expenses logged.";
  }

  const report = $("#weekly-report");
  report.innerHTML = `<div class="weekly-metrics"><article><span>Food spending</span><strong>${money(total)}</strong></article><article><span>Habit check-ins</span><strong>${checkIns}</strong></article><article><span>Active habit days</span><strong>${activeHabitDays}/7</strong></article></div><p class="weekly-comparison">${escapeText(comparison)}</p><div class="week-chart">${weekDates.map((date) => {
    const spend = dailyTotals[date] || 0;
    const habitCount = data.habits.reduce((sum, habit) => sum + Number(habit.completedDates.includes(date)), 0);
    const width = dailyMax ? Math.max(3, Math.round(spend / dailyMax * 100)) : 0;
    return `<div class="week-day-row"><span class="week-day-label">${displayDate(date)}</span><span class="week-bar-track"><i style="width:${width}%"></i></span><strong>${money(spend)}</strong><small>${habitCount} ${habitCount === 1 ? "habit" : "habits"}</small></div>`;
  }).join("")}</div>`;
}

function renderBudget(month, total) {
  const budget = Number(data.monthlyBudgets[month]) || 0;
  const budgetInput = $("#budget-amount");
  $("#clear-budget").classList.toggle("hidden", !budget);
  if (document.activeElement !== budgetInput) budgetInput.value = budget || "";
  const alert = $("#budget-alert");
  alert.classList.add("hidden");
  if (!budget) {
    $("#budget-progress-label").textContent = "Set a budget and keep your spending on track.";
    $("#spending-score").textContent = "—";
    $("#score-out-of").textContent = "";
    $("#score-note").textContent = "Set a monthly budget to begin";
    return;
  }

  const ratio = total / budget;
  const percent = Math.round(ratio * 100);
  $("#budget-progress-label").textContent = `${money(total)} of ${money(budget)} used · ${percent}%`;
  const today = new Date();
  const selected = new Date(`${selectedDate()}T12:00:00`);
  const elapsed = selected.getFullYear() === today.getFullYear() && selected.getMonth() === today.getMonth()
    ? today.getDate()
    : Math.max(1, selected.getDate());
  const monthLength = daysInMonth(selected.getFullYear(), selected.getMonth());
  const pace = total / Math.max(1, budget * elapsed / monthLength);
  const score = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, pace - 1) * 55)));
  $("#spending-score").textContent = score;
  $("#score-out-of").textContent = "/100";
  $("#score-note").textContent = pace <= 1 ? "On or below budget pace" : "Spending is ahead of budget pace";
  if (ratio >= 1) {
    alert.textContent = `Budget alert: you've used ${percent}% of this month's food budget.`;
    alert.className = "budget-alert over-budget";
  } else if (ratio >= .8) {
    alert.textContent = `Heads up: you've used ${percent}% of this month's food budget.`;
    alert.className = "budget-alert near-budget";
  }
}

function renderExpenses() {
  const date = selectedDate();
  const month = selectedMonth();
  const allMonthExpenses = monthExpenses(month);
  const dayExpenses = data.expenses.filter((expense) => expense.date === date);
  const dayTotal = dayExpenses.reduce((total, expense) => total + expense.amount, 0);
  const monthTotal = allMonthExpenses.reduce((total, expense) => total + expense.amount, 0);
  $("#today-spend").textContent = money(dayTotal);
  $("#expense-day-total").textContent = money(dayTotal);
  $("#expense-count").textContent = `${dayExpenses.length} ${dayExpenses.length === 1 ? "entry" : "entries"}`;
  $("#month-spend").textContent = money(monthTotal);
  $("#month-label").textContent = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(`${month}-15T12:00:00`));
  expenseList.replaceChildren();
  dayExpenses.forEach((expense) => {
    const item = document.createElement("li");
    item.className = "expense-item";
    const icon = expense.category === "Groceries" ? "⌂" : expense.category === "Dining out" ? "✦" : expense.category === "Delivery" ? "↗" : "·";
    item.innerHTML = `<span class="category-mark" aria-hidden="true">${icon}</span><span class="expense-description"><strong>${escapeText(expense.note)}</strong><span>${escapeText(expense.category)}</span></span><strong class="expense-amount">${money(expense.amount)}</strong><button class="delete-button" type="button" aria-label="Delete expense: ${escapeText(expense.note)}" data-delete-expense="${escapeText(expense.id)}">×</button>`;
    expenseList.append(item);
  });
  $("#expense-empty").classList.toggle("visible", dayExpenses.length === 0);
  renderBudget(month, monthTotal);
}

function renderInsights() {
  const month = selectedMonth();
  const expenses = monthExpenses(month);
  const monthTotal = expenses.reduce((total, expense) => total + expense.amount, 0);
  const selected = new Date(`${selectedDate()}T12:00:00`);
  const now = new Date();
  const elapsed = selected.getFullYear() === now.getFullYear() && selected.getMonth() === now.getMonth() ? now.getDate() : selected.getDate();
  const days = daysInMonth(selected.getFullYear(), selected.getMonth());
  const prediction = elapsed ? monthTotal / elapsed * days : 0;
  $("#spend-prediction").textContent = money(prediction);
  $("#prediction-note").textContent = elapsed ? `Average ${money(monthTotal / elapsed)} per day so far` : "Add expenses to estimate";
  const streaks = data.habits.map((habit) => currentStreak(habit, selectedDate()));
  const best = Math.max(0, ...streaks);
  $("#best-streak").textContent = `${best} ${best === 1 ? "day" : "days"}`;

  const totals = expenses.reduce((result, expense) => {
    result[expense.category] = (result[expense.category] || 0) + expense.amount;
    return result;
  }, {});
  const categoryAnalysis = $("#category-analysis");
  categoryAnalysis.replaceChildren();
  const sortedCategories = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!sortedCategories.length) {
    categoryAnalysis.innerHTML = '<p class="empty-insight">Add food expenses to see your category breakdown.</p>';
  } else {
    sortedCategories.forEach(([category, amount]) => {
      const row = document.createElement("div");
      row.className = "category-row";
      const percent = monthTotal ? Math.round(amount / monthTotal * 100) : 0;
      row.innerHTML = `<div class="category-label"><span>${escapeText(category)}</span><strong>${money(amount)} <small>${percent}%</small></strong></div><div class="progress-track"><span style="width:${percent}%"></span></div>`;
      categoryAnalysis.append(row);
    });
  }

  const habitGroups = new Map();
  data.habits.forEach((habit) => {
    const category = HABIT_CATEGORIES.includes(habit.category) ? habit.category : "Other";
    if (!habitGroups.has(category)) habitGroups.set(category, { habits: 0, checkIns: 0 });
    const group = habitGroups.get(category);
    group.habits += 1;
    group.checkIns += habit.completedDates.filter((date) => date.startsWith(month)).length;
  });
  const habitAnalysis = $("#habit-category-analysis");
  habitAnalysis.replaceChildren();
  const sortedHabitGroups = [...habitGroups.entries()].sort((a, b) => b[1].checkIns - a[1].checkIns || a[0].localeCompare(b[0]));
  const totalHabitCheckIns = sortedHabitGroups.reduce((sum, [, group]) => sum + group.checkIns, 0);
  if (!sortedHabitGroups.length) {
    habitAnalysis.innerHTML = '<p class="empty-insight">Add habits and choose a category to see your habit analysis.</p>';
  } else {
    sortedHabitGroups.forEach(([category, group]) => {
      const percent = totalHabitCheckIns ? Math.round(group.checkIns / totalHabitCheckIns * 100) : 0;
      const row = document.createElement("div");
      row.className = "category-row";
      row.innerHTML = `<div class="category-label"><span>${escapeText(category)} <small>${group.habits} ${group.habits === 1 ? "habit" : "habits"}</small></span><strong>${group.checkIns} check-ins <small>${percent}%</small></strong></div><div class="progress-track"><span style="width:${percent}%"></span></div>`;
      habitAnalysis.append(row);
    });
  }

  renderWeeklyReport();

  const completedByDay = {};
  data.habits.forEach((habit) => habit.completedDates.forEach((date) => {
    if (date.startsWith(month)) completedByDay[date] = (completedByDay[date] || 0) + 1;
  }));
  const expenseByDay = getDailyTotals(expenses);
  const comparisonDays = Object.keys(expenseByDay).filter((date) => completedByDay[date] !== undefined);
  const relationship = $("#relationship-analysis");
  if (comparisonDays.length < 5 || !data.habits.length) {
    relationship.innerHTML = '<p>Log food spending and habit check-ins on at least five of the same days to see whether they tend to move together.</p><p class="subtle-copy">This is a simple association, not proof that one caused the other.</p>';
  } else {
    const pairs = comparisonDays.map((date) => [completedByDay[date] / data.habits.length, expenseByDay[date]]);
    const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
    const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
    const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - meanX) * (pair[1] - meanY), 0);
    const denominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - meanX) ** 2, 0) * pairs.reduce((sum, pair) => sum + (pair[1] - meanY) ** 2, 0));
    const correlation = denominator ? numerator / denominator : 0;
    const direction = correlation > .2 ? "higher habit completion often appeared alongside higher food spending" : correlation < -.2 ? "higher habit completion often appeared alongside lower food spending" : "there wasn't a clear pattern between habit completion and food spending";
    relationship.innerHTML = `<p>Across <strong>${pairs.length} shared days</strong>, ${direction}.</p><p class="subtle-copy">This observation uses the days you logged both. It is not proof of cause and effect.</p>`;
  }

  const habitCheckins = Object.values(completedByDay).reduce((sum, count) => sum + count, 0);
  const topCategory = sortedCategories[0];
  const summary = $("#monthly-summary");
  if (!expenses.length && !habitCheckins) {
    summary.innerHTML = "<p>Your monthly summary will appear as you log habits and food expenses.</p>";
  } else {
    summary.innerHTML = `<p>You logged <strong>${expenses.length} food ${expenses.length === 1 ? "expense" : "expenses"}</strong>, totalling <strong>${money(monthTotal)}</strong>, and completed <strong>${habitCheckins} habit ${habitCheckins === 1 ? "check-in" : "check-ins"}</strong> this month.</p>${topCategory ? `<p>Your biggest food category is <strong>${escapeText(topCategory[0])}</strong> at ${money(topCategory[1])}.</p>` : ""}<p class="subtle-copy">Month-end spending estimate: ${money(prediction)}.</p>`;
  }
}

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $("#calendar-title").textContent = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(calendarMonth);
  const grid = $("#calendar-grid");
  grid.replaceChildren();
  const offset = new Date(year, month, 1).getDay();
  const count = daysInMonth(year, month);
  for (let index = 0; index < offset; index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-blank";
    grid.append(blank);
  }
  const expenseDays = new Set(data.expenses.map((expense) => expense.date));
  for (let day = 1; day <= count; day += 1) {
    const date = localDateString(new Date(year, month, day));
    const hasHabit = data.habits.some((habit) => habit.completedDates.includes(date));
    const hasExpense = expenseDays.has(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `calendar-day${date === selectedDate() ? " selected" : ""}${date === localDateString(new Date()) ? " today" : ""}`;
    button.dataset.calendarDate = date;
    button.setAttribute("aria-label", `${date}${hasHabit ? ", habit complete" : ""}${hasExpense ? ", expense logged" : ""}`);
    button.innerHTML = `<span>${day}</span><span class="day-markers">${hasHabit ? '<i class="marker-habit"></i>' : ""}${hasExpense ? '<i class="marker-expense"></i>' : ""}</span>`;
    grid.append(button);
  }
}

function render() {
  const date = selectedDate();
  const dateObject = new Date(`${date}T12:00:00`);
  $("#today-label").textContent = date === localDateString(new Date())
    ? "YOUR DAILY CHECK-IN"
    : new Intl.DateTimeFormat("en-IN", { weekday: "long", month: "long", day: "numeric" }).format(dateObject).toUpperCase();
  renderHabits();
  renderExpenses();
  renderInsights();
  renderCalendar();
}

function setView(viewName) {
  document.querySelectorAll(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${viewName}-view`));
}

async function connectFirebase() {
  if (!isFirebaseConfigured || cloudModules || cloudLoading || !navigator.onLine) return;
  cloudLoading = true;
  try {
    const [appSdk, authSdk, databaseSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js")
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const database = databaseSdk.getDatabase(app);
    cloudModules = {
      auth,
      database,
      signOut: authSdk.signOut,
      onAuthStateChanged: authSdk.onAuthStateChanged,
      ref: databaseSdk.ref,
      get: databaseSdk.get,
      set: databaseSdk.set
    };
    cloudModules.onAuthStateChanged(auth, handleAuthState);
  } catch (error) {
    console.error("Firebase could not initialize.", error);
    const lastUserId = localStorage.getItem(LAST_USER_KEY);
    if (lastUserId) {
      try {
        currentStorageKey = localDataKey(lastUserId);
        data = readData(currentStorageKey);
        render();
        setStatus("Offline · using this account's local copy", "warning");
      } catch (storageError) {
        console.error("Unable to load the last synced account copy.", storageError);
        setStatus("Offline local mode", "warning");
      }
    } else {
      setStatus("Offline local mode", "warning");
    }
  } finally {
    cloudLoading = false;
  }
}

async function handleAuthState(user) {
  cloudUser = user;
  if (!user) {
    localStorage.removeItem(LAST_USER_KEY);
    currentStorageKey = GUEST_KEY;
    try {
      data = readData(GUEST_KEY);
    } catch (error) {
      console.error("Unable to load local tracker data.", error);
      setStatus("Couldn't load local data", "warning");
    }
    $("#account-button").textContent = "Sign in";
    $("#account-button").classList.remove("hidden");
    $("#profile-button").classList.add("hidden");
    $("#sign-out-button").classList.add("hidden");
    setStatus(navigator.onLine ? "Local mode" : "Offline local mode", navigator.onLine ? "local" : "warning");
    if (sessionStorage.getItem("daybook-mode") !== "local") showWelcome();
    render();
    return;
  }

  showTracker("account");
  currentStorageKey = localDataKey(user.uid);
  localStorage.setItem(LAST_USER_KEY, user.uid);
  $("#account-button").classList.add("hidden");
  $("#profile-button").classList.remove("hidden");
  $("#sign-out-button").classList.remove("hidden");
  setStatus("Syncing account…", "warning");
  let localAccountData = initialData();
  try {
    localAccountData = readData(currentStorageKey);
    const result = await cloudModules.get(cloudModules.ref(cloudModules.database, `users/${user.uid}/tracker`));
    const preserveOfflineChanges = localChangesPendingKey === currentStorageKey;
    data = preserveOfflineChanges ? localAccountData : result.exists() ? normalizeData(result.val()) : localAccountData;
    persistLocal();
    if (preserveOfflineChanges || !result.exists()) queueCloudSave();
    if (preserveOfflineChanges) localChangesPendingKey = null;
    setStatus(`Synced · ${user.email}`, "online");
  } catch (error) {
    data = localAccountData;
    console.error("Firebase data could not be loaded.", error);
    setStatus("Offline · using this account's local copy", "warning");
  }
  render();
}

$("#account-button").addEventListener("click", () => window.location.assign("login.html"));
$("#profile-button").addEventListener("click", () => window.location.assign("profile.html"));
$("#continue-local").addEventListener("click", () => showTracker("local"));

$("#sign-out-button").addEventListener("click", async () => {
  if (!cloudModules) return;
  try {
    sessionStorage.removeItem("daybook-mode");
    await cloudModules.signOut(cloudModules.auth);
  } catch (error) {
    console.error("Unable to sign out.", error);
    setStatus("Sign out failed", "warning");
  }
});

dateInput.value = localDateString(new Date());
calendarMonth = new Date(new Date(`${selectedDate()}T12:00:00`).getFullYear(), new Date(`${selectedDate()}T12:00:00`).getMonth(), 1);
dateInput.addEventListener("change", () => {
  const date = new Date(`${selectedDate()}T12:00:00`);
  calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  render();
});

habitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = habitNameInput.value.trim();
  if (!name) return;
  data.habits.push({
    id: crypto.randomUUID(),
    name,
    category: $("#habit-category").value,
    completedDates: []
  });
  saveData();
  habitForm.reset();
  render();
  habitNameInput.focus();
});

habitList.addEventListener("click", (event) => {
  const toggleButton = event.target.closest("[data-toggle-habit]");
  const deleteButton = event.target.closest("[data-delete-habit]");
  if (toggleButton) {
    const habit = data.habits.find((item) => item.id === toggleButton.dataset.toggleHabit);
    if (!habit) return;
    const date = selectedDate();
    habit.completedDates = habit.completedDates.includes(date)
      ? habit.completedDates.filter((completedDate) => completedDate !== date)
      : [...habit.completedDates, date];
    saveData();
    render();
  } else if (deleteButton) {
    data.habits = data.habits.filter((habit) => habit.id !== deleteButton.dataset.deleteHabit);
    saveData();
    render();
  }
});

expenseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(expenseForm);
  const amount = Number(formData.get("amount"));
  const note = String(formData.get("note")).trim();
  if (!note || !Number.isFinite(amount) || amount <= 0) return;
  data.expenses.push({
    id: crypto.randomUUID(),
    date: selectedDate(),
    note,
    category: String(formData.get("category")),
    amount
  });
  saveData();
  expenseForm.reset();
  render();
});

expenseList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-expense]");
  if (!deleteButton) return;
  data.expenses = data.expenses.filter((expense) => expense.id !== deleteButton.dataset.deleteExpense);
  saveData();
  render();
});

$("#budget-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = Number($("#budget-amount").value);
  if (!Number.isFinite(amount) || amount <= 0) return;
  data.monthlyBudgets[selectedMonth()] = amount;
  saveData();
  render();
});
$("#clear-budget").addEventListener("click", () => {
  delete data.monthlyBudgets[selectedMonth()];
  saveData();
  render();
});

document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$("#previous-month").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
$("#next-month").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
$("#calendar-grid").addEventListener("click", (event) => {
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  dateInput.value = day.dataset.calendarDate;
  setView("dashboard");
  render();
});

window.addEventListener("online", () => {
  connectFirebase();
  if (cloudUser) queueCloudSave();
  else setStatus("Local mode", "local");
});
window.addEventListener("offline", () => setStatus(cloudUser ? "Offline · changes saved on this device" : "Offline local mode", "warning"));

if (isFirebaseConfigured) {
  $("#landing-setup-note").textContent = "Sign in or create an account to sync your tracker. You can also use local mode.";
  connectFirebase();
} else {
  $("#profile-button").classList.add("hidden");
  $("#landing-setup-note").textContent = "Firebase sign-in is not configured yet. You can still use the tracker locally on this device.";
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch((error) => {
    console.error("Offline support could not be registered.", error);
  });
}

if (sessionStorage.getItem("daybook-mode") === "local") showTracker();
else showWelcome();
render();
