"use strict";

const LEGACY_STORAGE_KEY = "teacher-load-manager-v1";
const LEGACY_ACCOUNTS_KEY = "teacher-load-manager-accounts-v1";
let csrfToken = "";
let cloudRevision = 0;
let appInitialized = false;
let cloudSaveInProgress = false;
let cloudRefreshInProgress = false;
let cloudRefreshTimer = 0;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DEFAULT_PERIOD_TIMES = Object.fromEntries(
  Array.from({ length: 7 }, (_, index) => [String(index + 1), { start: "", end: "" }]),
);
const DEFAULT_SETTINGS = {
  schoolName: "My School",
  schoolYear: "2026–2027",
  schoolAddress: "",
  schoolId: "",
  principalName: "",
  principalDesignation: "",
  schoolLogo: "",
  groupNames: ["Morning shift", "Afternoon shift"],
  autoRecordPeriods: true,
  periodTimes: DEFAULT_PERIOD_TIMES,
  groupPeriodTimes: createGroupPeriodTimes(["Morning shift", "Afternoon shift"]),
};
function createGroupPeriodTimes(groupNames, savedGroupTimes = {}, fallbackTimes = DEFAULT_PERIOD_TIMES) {
  return Object.fromEntries(groupNames.map((groupName) => {
    const savedTimes = savedGroupTimes[groupName] ?? {};
    return [groupName, Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => {
        const period = String(index + 1);
        return [period, savedTimes[period] ?? fallbackTimes[period] ?? { start: "", end: "" }];
      }),
    )];
  }));
}

const AVATAR_COLORS = ["", "blue", "amber", "rose"];

const state = {
  teachers: [],
  loads: [],
  substitutionPlans: [],
  leaveApplications: [],
  settings: { ...DEFAULT_SETTINGS },
  activeView: "overview",
  teacherQuery: "",
  loadQuery: "",
  singleLoadFromAutoMode: false,
  editingSubstitutionPlanId: "",
  settingsDraftGroupPeriodTimes: null,
  settingsPeriodGroup: "",
  currentAccount: null,
};

const elements = {
  views: [...document.querySelectorAll(".view-panel")],
  navLinks: [...document.querySelectorAll(".nav-link")],
  breadcrumb: document.querySelector("#breadcrumb-current"),
  teacherDialog: document.querySelector("#teacher-dialog"),
  teacherPasswordDialog: document.querySelector("#teacher-password-dialog"),
  loadDialog: document.querySelector("#load-dialog"),
  teacherLoadPreview: document.querySelector("#teacher-load-preview"),
  settingsDialog: document.querySelector("#settings-dialog"),
  toastRegion: document.querySelector("#toast-region"),
};

async function apiRequest(action, body = null) {
  const response = await fetch(`api.php?action=${encodeURIComponent(action)}`, {
    method: body === null ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === null ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: body === null ? undefined : JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The local server returned an invalid response. Check that XAMPP Apache and PHP are running.");
  }
  if (!response.ok || result?.error) {
    const error = new Error(result?.error ?? `The server returned HTTP ${response.status}.`);
    error.code = result?.code ?? "";
    throw error;
  }
  if (typeof result?.csrfToken === "string") csrfToken = result.csrfToken;
  return result;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function applySchoolState(parsed) {
  state.teachers = [];
  state.loads = [];
  state.substitutionPlans = [];
  state.leaveApplications = [];
  state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!parsed || !Array.isArray(parsed.teachers) || !Array.isArray(parsed.loads)) {
    throw new Error("The shared school records have an invalid format.");
  }
  state.teachers = parsed.teachers;
  state.substitutionPlans = Array.isArray(parsed.substitutionPlans) ? parsed.substitutionPlans : [];
  state.leaveApplications = Array.isArray(parsed.leaveApplications) ? parsed.leaveApplications : [];
  state.loads = parsed.loads.map((load) => {
    if (load.minutes !== undefined) return { ...load, minutes: Number(load.minutes) };
    const legacyHours = Number(load.hours);
    const { hours, ...legacyLoad } = load;
    return { ...legacyLoad, minutes: Number.isFinite(legacyHours) ? legacyHours * 60 : 0 };
  });
  const groupNames = Array.isArray(parsed.settings?.groupNames) && parsed.settings.groupNames.length
    ? parsed.settings.groupNames
    : [...DEFAULT_SETTINGS.groupNames];
  const periodTimes = { ...DEFAULT_PERIOD_TIMES, ...(parsed.settings?.periodTimes ?? {}) };
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(parsed.settings ?? {}),
    groupNames,
    periodTimes,
    groupPeriodTimes: createGroupPeriodTimes(
      groupNames,
      parsed.settings?.groupPeriodTimes ?? {},
      periodTimes,
    ),
  };
}

async function loadCloudState() {
  const result = await apiRequest("state/load");
  const { data } = result;
  if (!data || typeof data !== "object" || !Number.isSafeInteger(Number(data.revision))) {
    throw new Error("The shared records response is incomplete.");
  }
  applySchoolState(data.data);
  cloudRevision = Number(data.revision);
}

async function saveState() {
  if (!state.currentAccount) {
    showToast("Sign in before saving shared school records.", "error");
    return false;
  }
  cloudSaveInProgress = true;
  try {
    const result = await apiRequest("state/save", {
      data: {
        teachers: state.teachers,
        loads: state.loads,
        substitutionPlans: state.substitutionPlans,
        leaveApplications: state.leaveApplications,
        settings: state.settings,
      },
      expectedRevision: cloudRevision,
    });
    cloudRevision = Number(result.revision);
    return true;
  } catch (error) {
    const message = error.code === "CONFLICT"
      ? "Another user changed school records. Reload the page before trying again; your unsaved change was not saved."
      : `Couldn't save shared records: ${error.message}`;
    showToast(message, "error");
    return false;
  } finally {
    cloudSaveInProgress = false;
  }
}

async function refreshCloudState() {
  if (!state.currentAccount || document.hidden || cloudSaveInProgress || cloudRefreshInProgress
    || document.querySelector("dialog[open]")) return;
  cloudRefreshInProgress = true;
  try {
    const activeView = state.activeView;
    await loadCloudState();
    state.activeView = activeView;
    render();
    switchView(activeView);
  } catch (error) {
    showToast(`Couldn't refresh shared records: ${error.message}`, "error");
  } finally {
    cloudRefreshInProgress = false;
  }
}

async function importLegacyRecords() {
  if (!isAdminAccount()) {
    showToast("Only the admin can import records from this browser.", "error");
    return;
  }
  if (!window.confirm("Import this browser's old teacher, load, leave, and substitution records into the XAMPP MySQL database? Existing records will be kept. Old passwords and accounts are not imported.")) {
    return;
  }

  let imported;
  try {
    imported = {
      teachers: [],
      loads: [],
      substitutionPlans: [],
      leaveApplications: [],
    };
    const saved = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (saved) {
      const records = JSON.parse(saved);
      if (!records || !Array.isArray(records.teachers) || !Array.isArray(records.loads)) {
        throw new Error("The browser's saved school records have an invalid format.");
      }
      imported.teachers.push(...records.teachers);
      imported.loads.push(...records.loads);
      imported.substitutionPlans.push(...(Array.isArray(records.substitutionPlans) ? records.substitutionPlans : []));
      imported.leaveApplications.push(...(Array.isArray(records.leaveApplications) ? records.leaveApplications : []));
    }

    const savedAccounts = localStorage.getItem(LEGACY_ACCOUNTS_KEY);
    if (savedAccounts) {
      const legacyAccounts = JSON.parse(savedAccounts);
      if (!Array.isArray(legacyAccounts)) throw new Error("The browser's saved accounts have an invalid format.");
      legacyAccounts.filter((account) => account.role === "teacher" && account.teacherId).forEach((account) => {
        const accountRecordsText = localStorage.getItem(`${LEGACY_STORAGE_KEY}:account:${account.id}`);
        if (!accountRecordsText) return;
        const accountRecords = JSON.parse(accountRecordsText);
        if (!accountRecords || !Array.isArray(accountRecords.teachers) || !Array.isArray(accountRecords.loads)) {
          throw new Error(`Saved records for ${account.username || "a teacher"} have an invalid format.`);
        }
        imported.teachers.push(...accountRecords.teachers.filter((teacher) => teacher.id === account.teacherId));
        imported.loads.push(...accountRecords.loads.filter((load) => load.teacherId === account.teacherId));
        imported.substitutionPlans.push(...(Array.isArray(accountRecords.substitutionPlans) ? accountRecords.substitutionPlans : []));
        imported.leaveApplications.push(...(Array.isArray(accountRecords.leaveApplications) ? accountRecords.leaveApplications : []));
      });
    }
  } catch (error) {
    showToast(`Couldn't read old records: ${error.message}`, "error");
    return;
  }

  const hasRecords = Object.values(imported).some((records) => records.length);
  if (!hasRecords) {
    showToast("No old school records were found in this browser.", "error");
    return;
  }
  const mergeById = (cloudRecords, localRecords) => {
    const merged = [...cloudRecords];
    const knownIds = new Set(cloudRecords.map((record) => record.id).filter(Boolean));
    localRecords.forEach((record) => {
      if (!record || typeof record !== "object" || typeof record.id !== "string") {
        throw new Error("An old record is missing its ID.");
      }
      if (!knownIds.has(record.id)) {
        knownIds.add(record.id);
        merged.push(record);
      }
    });
    return merged;
  };
  const previous = {
    teachers: state.teachers,
    loads: state.loads,
    substitutionPlans: state.substitutionPlans,
    leaveApplications: state.leaveApplications,
  };
  try {
    state.teachers = mergeById(previous.teachers, imported.teachers);
    state.loads = mergeById(previous.loads, imported.loads);
    state.substitutionPlans = mergeById(previous.substitutionPlans, imported.substitutionPlans);
    state.leaveApplications = mergeById(previous.leaveApplications, imported.leaveApplications);
  } catch (error) {
    Object.assign(state, previous);
    showToast(`Couldn't prepare old records for import: ${error.message}`, "error");
    return;
  }
  if (!(await saveState())) {
    Object.assign(state, previous);
    return;
  }
  elements.settingsDialog.close();
  render();
  showToast("Old records from this browser were added to the MySQL database. Accounts and passwords must be recreated.");
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " toast-error" : ""}`;
  const mark = document.createElement("span");
  mark.className = "toast-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = type === "error" ? "!" : "✓";
  const text = document.createElement("span");
  text.textContent = message;
  toast.append(mark, text);
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function formatMinutes(value) {
  return `${Number(value) || 0} min`;
}

function formatLoadDays(days) {
  return Array.isArray(days) && days.length ? days.join(", ") : "—";
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

function formatTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = match[2];
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function periodTime(period, groupName) {
  const matchingGroup = Object.keys(state.settings.groupPeriodTimes ?? {})
    .find((name) => name.toLocaleLowerCase() === String(groupName ?? "").toLocaleLowerCase());
  const times = state.settings.groupPeriodTimes?.[groupName]?.[String(period)]
    ?? state.settings.groupPeriodTimes?.[matchingGroup]?.[String(period)]
    ?? state.settings.periodTimes?.[String(period)];
  const start = formatTime(times?.start);
  const end = formatTime(times?.end);
  if (start && end) return `${start}–${end}`;
  return start || end;
}

function scheduleStartMinutes(load) {
  const configuredStart = state.settings.groupPeriodTimes?.[load.groupName]?.[String(load.period)]?.start
    ?? state.settings.periodTimes?.[String(load.period)]?.start;
  const configuredMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(configuredStart ?? "");
  if (configuredMatch) return Number(configuredMatch[1]) * 60 + Number(configuredMatch[2]);

  const scheduleMatch = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)/i.exec(load.schedule ?? "");
  if (!scheduleMatch) return Number.POSITIVE_INFINITY;
  const hour = Number(scheduleMatch[1]) % 12 + (scheduleMatch[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + Number(scheduleMatch[2]);
}

function compareLoadSchedules(a, b) {
  const aDay = Math.min(...(Array.isArray(a.days) ? a.days : [])
    .map((day) => WEEKDAYS.indexOf(day)).filter((index) => index >= 0), WEEKDAYS.length);
  const bDay = Math.min(...(Array.isArray(b.days) ? b.days : [])
    .map((day) => WEEKDAYS.indexOf(day)).filter((index) => index >= 0), WEEKDAYS.length);
  return aDay - bDay
    || scheduleStartMinutes(a) - scheduleStartMinutes(b)
    || (a.groupName ?? "").localeCompare(b.groupName ?? "")
    || Number(a.period || 0) - Number(b.period || 0)
    || (a.subject ?? "").localeCompare(b.subject ?? "");
}

function makePeriodCell(row, period, groupName, schedule) {
  const cell = document.createElement("td");
  const label = document.createElement("span");
  label.className = "table-primary";
  label.textContent = period ? `Period ${period}` : "—";
  cell.append(label);
  const time = schedule || periodTime(period, groupName);
  if (time) {
    const detail = document.createElement("div");
    detail.className = "table-secondary";
    detail.textContent = time;
    cell.append(detail);
  }
  row.append(cell);
}

function renderLoadScheduleOptions({ period = "", selectedGroup = "", selectedSchedule = "" } = {}) {
  const scheduleSelect = document.querySelector("#load-schedule");
  scheduleSelect.replaceChildren();
  scheduleSelect.add(new Option("Select a group, period, and time", ""));
  const groupNames = [...state.settings.groupNames];
  if (selectedGroup && !groupNames.includes(selectedGroup)) groupNames.push(selectedGroup);
  let optionNumber = 0;
  groupNames.forEach((groupName) => {
    for (let periodNumber = 1; periodNumber <= 7; periodNumber += 1) {
      const periodValue = String(periodNumber);
      const time = periodTime(periodValue, groupName);
      const option = new Option(
        `${groupName} · Period ${periodNumber} · ${time || "Time not set"}`,
        `schedule-${optionNumber}`,
      );
      optionNumber += 1;
      option.dataset.groupName = groupName;
      option.dataset.period = periodValue;
      option.dataset.schedule = time;
      scheduleSelect.add(option);

      if (selectedGroup === groupName && period === periodValue && selectedSchedule && selectedSchedule !== time) {
        const savedOption = new Option(
          `${groupName} · Period ${periodNumber} · ${selectedSchedule}`,
          `schedule-${optionNumber}`,
        );
        optionNumber += 1;
        savedOption.dataset.groupName = groupName;
        savedOption.dataset.period = periodValue;
        savedOption.dataset.schedule = selectedSchedule;
        scheduleSelect.add(savedOption);
      }
    }
  });

  const selectedOption = [...scheduleSelect.options].find((option) =>
    option.dataset.groupName === selectedGroup && option.dataset.period === period
    && (!selectedSchedule || option.dataset.schedule === selectedSchedule));
  if (selectedOption) selectedOption.selected = true;
}

function teacherLoads(teacherId) {
  return state.loads.filter((load) => load.teacherId === teacherId);
}

function teacherMinutes(teacherId) {
  return teacherLoads(teacherId).reduce((total, load) => total + Number(load.minutes || 0), 0);
}

function teacherName(teacherId) {
  return state.teachers.find((teacher) => teacher.id === teacherId)?.name ?? "Unknown teacher";
}

function makeCell(row, value, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function makePersonCell(row, name, secondary, index) {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "person-cell";
  const avatar = document.createElement("span");
  avatar.className = `avatar ${AVATAR_COLORS[index % AVATAR_COLORS.length]}`;
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("");
  const info = document.createElement("span");
  info.className = "person-info";
  const primary = document.createElement("strong");
  primary.textContent = name;
  const detail = document.createElement("span");
  detail.textContent = secondary || "No employee ID";
  info.append(primary, detail);
  wrapper.append(avatar, info);
  cell.append(wrapper);
  row.append(cell);
}

function makeMinutesCell(row, minutes) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = "hours-badge";
  badge.textContent = formatMinutes(minutes);
  cell.append(badge);
  row.append(cell);
}

function makeStatusCell(row, status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status-badge${status === "On leave" ? " status-on-leave" : status === "Inactive" ? " status-inactive" : ""}`;
  badge.textContent = status;
  cell.append(badge);
  row.append(cell);
}

function makeActionCell(row, type, id, label, closeLoadPreview = false) {
  const load = type === "load" ? state.loads.find((item) => item.id === id) : null;
  if (isTeacherAccount() && !canManageLoad(load)) {
    row.append(document.createElement("td"));
    return;
  }
  const closeLoadDialogs = () => {
    if (!closeLoadPreview) return;
    if (elements.teacherLoadPreview.open) elements.teacherLoadPreview.close();
    if (elements.loadDialog.open) elements.loadDialog.close();
  };
  const cell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const edit = document.createElement("button");
  edit.className = "row-action";
  edit.type = "button";
  edit.setAttribute("aria-label", `Edit ${label}`);
  edit.title = `Edit ${label}`;
  edit.textContent = type === "load" ? "Edit" : "✎";
  if (type === "load") edit.classList.add("row-action-text");
  edit.addEventListener("click", () => {
    closeLoadDialogs();
    type === "teacher" ? openTeacherDialog(id) : openLoadDialog(id);
  });
  actions.append(edit);
  if (type === "teacher" && isAdminAccount()) {
    const resetPassword = document.createElement("button");
    resetPassword.className = "row-action";
    resetPassword.type = "button";
    resetPassword.setAttribute("aria-label", `Reset password for ${label}`);
    resetPassword.title = "Set a temporary password";
    resetPassword.textContent = "↻";
    resetPassword.addEventListener("click", () => openTeacherPasswordDialog(id));
    actions.append(resetPassword);
  }
  if (!(type === "teacher" && state.currentAccount?.role === "teacher")) {
    const remove = document.createElement("button");
    remove.className = "row-action delete";
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete ${label}`);
    remove.title = `Delete ${label}`;
    remove.textContent = type === "load" ? "Delete" : "×";
    if (type === "load") remove.classList.add("row-action-text");
    remove.addEventListener("click", () => {
      closeLoadDialogs();
      type === "teacher" ? deleteTeacher(id) : deleteLoad(id);
    });
    actions.append(remove);
  }
  cell.append(actions);
  row.append(cell);
}

function openTeacherPasswordDialog(teacherId) {
  if (!isAdminAccount()) {
    showToast("Only the admin can reset teacher passwords.", "error");
    return;
  }
  const teacher = state.teachers.find((item) => item.id === teacherId);
  if (!teacher) {
    showToast("That teacher account could not be found.", "error");
    return;
  }
  document.querySelector("#teacher-password-form").reset();
  document.querySelector("#teacher-password-id").value = teacherId;
  document.querySelector("#teacher-password-name").textContent = teacher.name;
  document.querySelector("#teacher-password-error").hidden = true;
  elements.teacherPasswordDialog.showModal();
  document.querySelector("#teacher-new-password").focus();
}

async function resetTeacherPassword(event) {
  event.preventDefault();
  if (!isAdminAccount()) {
    showToast("Only the admin can reset teacher passwords.", "error");
    return;
  }
  const password = document.querySelector("#teacher-new-password").value;
  const confirmation = document.querySelector("#teacher-confirm-new-password").value;
  const errorElement = document.querySelector("#teacher-password-error");
  errorElement.hidden = true;
  if (password.length < 12 || password.length > 128) {
    errorElement.textContent = "Use a temporary password with 12–128 characters.";
    errorElement.hidden = false;
    document.querySelector("#teacher-new-password").focus();
    return;
  }
  if (password !== confirmation) {
    errorElement.textContent = "The passwords do not match.";
    errorElement.hidden = false;
    document.querySelector("#teacher-confirm-new-password").focus();
    return;
  }

  try {
    await apiRequest("admin/reset-password", {
      teacherId: document.querySelector("#teacher-password-id").value,
      password,
    });
  } catch (error) {
    errorElement.textContent = `Couldn't reset the teacher password: ${error.message}`;
    errorElement.hidden = false;
    return;
  }

  elements.teacherPasswordDialog.close();
  document.querySelector("#teacher-password-form").reset();
  showToast("Password reset. Give the temporary password to the teacher securely; they must change it at next sign-in.");
}

function setEmptyState(tableBody, emptyState, hasRows) {
  tableBody.replaceChildren();
  emptyState.classList.toggle("visible", !hasRows);
}

function isTeacherAccount() {
  return state.currentAccount?.role === "teacher";
}

function isAdminAccount() {
  return state.currentAccount?.role === "admin";
}

function currentTeacherId() {
  return isTeacherAccount() ? state.currentAccount.teacherId : "";
}

function canManageLoad(load) {
  return isAdminAccount() || (isTeacherAccount() && load?.teacherId === currentTeacherId());
}

function visibleLoads() {
  const teacherId = currentTeacherId();
  return state.loads.filter((load) => !teacherId || load.teacherId === teacherId);
}

function visibleSubstitutionPlans() {
  const teacherId = currentTeacherId();
  return state.substitutionPlans.filter((plan) =>
    !teacherId || plan.submittedBy === state.currentAccount.id || plan.leaveTeacherId === teacherId);
}

function canManageSubstitutionPlan(plan) {
  return isAdminAccount() || (isTeacherAccount()
    && plan?.status === "pending"
    && plan.submittedBy === state.currentAccount.id
    && plan.leaveTeacherId === currentTeacherId());
}

function render() {
  renderHeader();
  renderStats();
  renderTeachers();
  renderLoads();
  renderRecentLoads();
  renderLeaveApplications();
  renderSubstitutionPlans();
  renderLoginActivity();
  const teacherAccount = isTeacherAccount();
  document.querySelector("#add-teacher").hidden = teacherAccount;
  document.querySelectorAll("[data-add-teacher]").forEach((button) => { button.hidden = teacherAccount; });
  document.querySelector("#nav-teachers").hidden = teacherAccount;
  document.querySelector("#sidebar-management-label").hidden = teacherAccount;
  document.querySelector("#nav-management").hidden = teacherAccount;
  document.querySelector("#open-groups-periods").hidden = teacherAccount;
  document.querySelector("#open-settings").hidden = teacherAccount;
  document.querySelector("#sidebar-export").hidden = teacherAccount;
  document.querySelector("#sidebar-export").closest(".help-card").hidden = teacherAccount;
  document.querySelector("#add-load").hidden = false;
  document.querySelector("#export-loads").hidden = teacherAccount;
  document.querySelector("#print-overview").hidden = teacherAccount;
  document.querySelector("#teachers-title").textContent = "Teachers";
  document.querySelector("#teacher-page-eyebrow").textContent = "SCHOOL PERSONNEL";
  document.querySelector("#teacher-list-title").textContent = "Teacher directory";
  document.querySelector("#teacher-page-subtitle").textContent = "Manage teacher profiles and review their assigned minutes.";
  document.querySelector("#teacher-search").closest(".search-box").hidden = teacherAccount;
  document.querySelector("#view-teachers").hidden = teacherAccount;
  document.querySelector("#view-overview .stat-card:nth-child(1) .stat-label").textContent =
    teacherAccount ? "Your profile" : "Total teachers";
  document.querySelector("#view-overview #recent-title").textContent =
    teacherAccount ? "Your teaching assignments" : "Teaching assignments";
  document.querySelector("#view-overview .getting-started .setup-step").dataset.go =
    teacherAccount ? "loads" : "teachers";
  if (teacherAccount) {
    document.querySelector("#overview-eyebrow-label").textContent = "MY TEACHING LOAD";
    document.querySelector("#page-title").textContent = "Your dashboard";
    document.querySelector("#view-overview .page-subtitle").textContent =
      "Add your teaching loads and submit leave-coverage proposals for admin review.";
    document.querySelector("#view-overview .stat-card:nth-child(1) .stat-caption").textContent = "Your teacher account";
    document.querySelector("#view-overview .stat-card:nth-child(2) .stat-caption").textContent = "Your saved assignments";
    document.querySelector("#view-overview .stat-card:nth-child(3) .stat-caption").textContent = "Your weekly minutes";
    document.querySelector(".getting-started h2").textContent = "Your teaching loads";
    document.querySelector(".getting-started > p").textContent =
      "Review your teaching loads, then add assignments for your classes.";
    const [profileStep, loadStep] = document.querySelectorAll(".setup-step");
    profileStep.querySelector("strong").textContent = "Review your teaching loads";
    profileStep.querySelector("small").textContent = "See your saved assignments";
    loadStep.querySelector("strong").textContent = "Add a teaching load";
    loadStep.querySelector("small").textContent = "Record your subjects and classes";
  } else {
    document.querySelector("#overview-eyebrow-label").textContent = "SCHOOL PERSONNEL";
    document.querySelector("#page-title").textContent = "Good day. ✳";
    document.querySelector("#view-overview .page-subtitle").textContent =
      "A clear view of your teachers and their teaching assignments.";
    document.querySelector("#view-overview .stat-card:nth-child(1) .stat-caption").textContent =
      "Profiles in your school records";
    document.querySelector("#view-overview .stat-card:nth-child(2) .stat-caption").textContent =
      "Across all teacher profiles";
    document.querySelector("#view-overview .stat-card:nth-child(3) .stat-caption").textContent =
      "Combined minutes per week";
    document.querySelector("#view-overview .stat-card:nth-child(1) .stat-label").textContent = "Total teachers";
    document.querySelector("#view-overview #recent-title").textContent = "Teaching assignments";
    document.querySelector(".getting-started h2").textContent = "Set up your school records";
    document.querySelector(".getting-started > p").textContent =
      "Add your teacher profiles first, then record each learning area and class assignment.";
    const [profileStep, loadStep] = document.querySelectorAll(".setup-step");
    profileStep.querySelector("strong").textContent = "Add teachers";
    profileStep.querySelector("small").textContent = "Create a profile for each teacher";
    loadStep.querySelector("strong").textContent = "Assign teaching loads";
    loadStep.querySelector("small").textContent = "Connect classes and learning areas";
  }
  document.querySelector("#teacher-nav-count").textContent = String(state.teachers.length);
  document.querySelector("#load-nav-count").textContent = String(visibleLoads().length);
  document.querySelector("#teacher-dashboard-load-count").textContent = `${visibleLoads().length} ${visibleLoads().length === 1 ? "assignment" : "assignments"}`;
  document.querySelector("#teacher-dashboard-substitution-count").textContent = `${visibleSubstitutionPlans().length} ${visibleSubstitutionPlans().length === 1 ? "plan" : "plans"}`;
  document.querySelector("#teacher-load-shortcut-copy").textContent = teacherAccount
    ? "View and add your own teaching assignments"
    : "View and manage teacher assignments";
  document.querySelector("#teacher-substitution-shortcut-copy").textContent = teacherAccount
    ? "Submit a proposal for admin review"
    : "Review and manage staff coverage";
}

function renderLoginActivity() {
  const body = document.querySelector("#account-login-body");
  const empty = document.querySelector("#account-login-empty");
  setEmptyState(body, empty, false);
  document.querySelector("#account-login-caption").textContent =
    "Sign-in history is not collected by the MySQL database.";
}

function renderHeader() {
  const settings = state.settings;
  const schoolName = settings.schoolName || DEFAULT_SETTINGS.schoolName;
  document.querySelector("#school-context-name").textContent = schoolName;
  document.querySelector("#school-context-year").textContent = state.settings.schoolYear || DEFAULT_SETTINGS.schoolYear;
  document.querySelectorAll("[data-brand-mark]").forEach((mark) => {
    mark.replaceChildren();
    if (settings.schoolLogo) {
      const logo = document.createElement("img");
      logo.src = settings.schoolLogo;
      logo.alt = "";
      mark.append(logo);
      mark.classList.add("has-school-logo");
    } else {
      mark.textContent = "TL";
      mark.classList.remove("has-school-logo");
    }
  });
  const printLogo = document.querySelector("#print-school-logo");
  printLogo.src = settings.schoolLogo || "";
  printLogo.hidden = !settings.schoolLogo;
  document.querySelector("#print-school-name").textContent = schoolName;
  document.querySelector("#print-school-address").textContent = settings.schoolAddress || "";
  document.querySelector("#print-school-id").textContent = settings.schoolId ? `School ID: ${settings.schoolId}` : "";
  document.querySelector("#print-principal").textContent = settings.principalName
    ? `Principal: ${settings.principalName}${settings.principalDesignation ? ` · ${settings.principalDesignation}` : ""}`
    : "";
  const substitutionLogo = document.querySelector("#substitution-print-logo");
  substitutionLogo.src = settings.schoolLogo || "";
  substitutionLogo.hidden = !settings.schoolLogo;
  document.querySelector("#substitution-print-school-name").textContent = schoolName;
  document.querySelector("#substitution-print-school-address").textContent = settings.schoolAddress || "";
  document.querySelector("#substitution-print-school-id").textContent = settings.schoolId ? `School ID: ${settings.schoolId}` : "";
  document.querySelector("#substitution-print-principal-name").textContent = settings.principalName || "";
  document.querySelector("#substitution-print-principal-designation").textContent = settings.principalDesignation || "";
  document.querySelector("#substitution-print-principal").hidden = !settings.principalName && !settings.principalDesignation;
}

function renderStats() {
  const loads = visibleLoads();
  document.querySelector("#stat-teachers").textContent = String(isTeacherAccount() ? 1 : state.teachers.length);
  document.querySelector("#stat-loads").textContent = String(loads.length);
  const totalMinutes = loads.reduce((total, load) => total + Number(load.minutes || 0), 0);
  const minutesValue = document.querySelector("#stat-minutes");
  minutesValue.replaceChildren(document.createTextNode(String(totalMinutes)));
  const unit = document.createElement("span");
  unit.className = "stat-unit";
  unit.textContent = " min";
  minutesValue.append(unit);
}

function renderTeachers() {
  const tableBody = document.querySelector("#teachers-body");
  const emptyState = document.querySelector("#teachers-empty");
  const query = state.teacherQuery.trim().toLocaleLowerCase();
  const matching = state.teachers
    .filter((teacher) => !isTeacherAccount() || teacher.id === currentTeacherId())
    .filter((teacher) => `${teacher.name} ${teacher.employeeId ?? ""} ${teacher.position ?? ""} ${teacher.status ?? ""}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  setEmptyState(tableBody, emptyState, matching.length > 0);
  document.querySelector("#teacher-list-caption").textContent = `${state.teachers.length} ${state.teachers.length === 1 ? "teacher profile" : "teacher profiles"}`;
  if (!matching.length) {
    const message = emptyState.querySelector("strong");
    const description = emptyState.querySelector("p");
    const addButton = emptyState.querySelector("button");
    message.textContent = state.teachers.length ? "No matching teachers" : "No teachers to show";
    description.textContent = state.teachers.length ? "Try a different name or employee ID." : "Add a teacher profile to get started.";
    addButton.hidden = state.teachers.length > 0;
    return;
  }
  matching.forEach((teacher, index) => {
    const row = document.createElement("tr");
    makePersonCell(row, teacher.name, teacher.employeeId || "No employee ID", index);
    makeCell(row, teacher.employeeId || "—");
    makeCell(row, teacher.position || "—");
    makeCell(row, String(teacherLoads(teacher.id).length));
    makeMinutesCell(row, teacherMinutes(teacher.id));
    makeStatusCell(row, teacher.status || "Active");
    makeActionCell(row, "teacher", teacher.id, teacher.name);
    tableBody.append(row);
  });
}

function renderLoads() {
  const tableBody = document.querySelector("#loads-body");
  const emptyState = document.querySelector("#loads-empty");
  const query = state.loadQuery.trim().toLocaleLowerCase();
  const loads = visibleLoads();
  const matching = loads
    .filter((load) => `${teacherName(load.teacherId)} ${load.subject} ${load.grade} ${load.section ?? ""} ${load.groupName ?? ""} ${load.period ?? ""} ${formatLoadDays(load.days)} ${periodTime(load.period, load.groupName)} ${load.schedule ?? ""}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => teacherName(a.teacherId).localeCompare(teacherName(b.teacherId)) || compareLoadSchedules(a, b));
  setEmptyState(tableBody, emptyState, matching.length > 0);
  document.querySelector("#load-list-caption").textContent = `${loads.length} ${loads.length === 1 ? "teaching assignment" : "teaching assignments"}`;
  if (!matching.length) {
    const message = emptyState.querySelector("strong");
    const description = emptyState.querySelector("p");
    const addButton = emptyState.querySelector("button");
    message.textContent = loads.length ? "No matching assignments" : "No assignments to show";
    description.textContent = loads.length ? "Try another teacher, class, or learning area." : state.teachers.length ? "Add a teaching load to get started." : "Add a teacher profile before creating an assignment.";
    addButton.hidden = state.teachers.length === 0 || loads.length > 0;
    return;
  }
  matching.forEach((load, index) => {
    const teacher = state.teachers.find((item) => item.id === load.teacherId);
    const row = document.createElement("tr");
    makePersonCell(row, teacher?.name ?? "Unknown teacher", teacher?.employeeId || "No employee ID", state.teachers.indexOf(teacher));
    makeCell(row, load.subject, "table-primary");
    makeCell(row, `${load.grade}${load.section ? ` · ${load.section}` : ""}`);
    makeCell(row, load.groupName || "—");
    makePeriodCell(row, load.period, load.groupName, load.schedule);
    makeCell(row, load.schedule || "—", "table-secondary");
    makeCell(row, formatLoadDays(load.days));
    makeMinutesCell(row, load.minutes);
    makeActionCell(row, "load", load.id, `${load.subject} assignment`);
    tableBody.append(row);
  });
}

function renderRecentLoads() {
  const tableBody = document.querySelector("#recent-loads-body");
  const emptyState = document.querySelector("#recent-empty");
  const recent = [...visibleLoads()].slice(-5).reverse();
  setEmptyState(tableBody, emptyState, recent.length > 0);
  if (!recent.length) return;
  recent.forEach((load, index) => {
    const teacher = state.teachers.find((item) => item.id === load.teacherId);
    const row = document.createElement("tr");
    makePersonCell(row, teacher?.name ?? "Unknown teacher", teacher?.employeeId || "No employee ID", index);
    makeCell(row, load.subject, "table-primary");
    makeCell(row, `${load.grade}${load.section ? ` · ${load.section}` : ""}`);
    makeCell(row, load.groupName || "—");
    makePeriodCell(row, load.period, load.groupName, load.schedule);
    makeCell(row, formatLoadDays(load.days));
    makeMinutesCell(row, load.minutes);
    tableBody.append(row);
  });
}

function visibleLeaveApplications() {
  const teacherId = currentTeacherId();
  return state.leaveApplications.filter((application) =>
    !teacherId || application.teacherId === teacherId);
}

function renderLeaveApplications() {
  const tableBody = document.querySelector("#leave-applications-body");
  const emptyState = document.querySelector("#leave-applications-empty");
  const teacherAccount = isTeacherAccount();
  document.querySelector("#apply-for-leave").hidden = !teacherAccount;
  document.querySelector("#leave-applications-panel").hidden =
    !teacherAccount && !isAdminAccount();
  const applications = [...visibleLeaveApplications()].sort((a, b) =>
    String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")));
  tableBody.replaceChildren();
  setEmptyState(tableBody, emptyState, applications.length > 0);
  document.querySelector("#leave-application-caption").textContent =
    `${applications.length} ${applications.length === 1 ? "leave application" : "leave applications"}`;
  document.querySelector("#leave-applications-empty strong").textContent =
    teacherAccount ? "No leave applications yet" : "No leave applications to review";
  document.querySelector("#leave-applications-empty p").textContent = teacherAccount
    ? "Apply for leave by selecting the date range you will be away."
    : "Teacher leave applications will appear here for admin review.";
  applications.forEach((application) => {
    const teacher = state.teachers.find((item) => item.id === application.teacherId);
    const row = document.createElement("tr");
    makeCell(row, teacher?.name ?? "Unknown teacher", "table-primary");
    makeCell(row, `${formatDate(application.startDate)} – ${formatDate(application.endDate)}`);
    makeCell(row, application.submittedAt
      ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" })
        .format(new Date(application.submittedAt))
      : "—");
    const status = application.status === "approved" ? "Approved"
      : application.status === "rejected" ? "Rejected" : "Pending admin review";
    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");
    const statusClass = application.status === "approved" ? "approved"
      : application.status === "rejected" ? "rejected" : "pending";
    statusBadge.className = `status-badge substitution-status-${statusClass}`;
    statusBadge.textContent = status;
    statusCell.append(statusBadge);
    row.append(statusCell);
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (isAdminAccount() && application.status === "pending") {
      actions.append(
        makeLeaveApplicationReviewButton(application, "approved", "Approve leave application", "✓"),
        makeLeaveApplicationReviewButton(application, "rejected", "Reject leave application", "×"),
      );
    }
    actionsCell.append(actions);
    row.append(actionsCell);
    tableBody.append(row);
  });
}

function makeLeaveApplicationReviewButton(application, status, label, mark) {
  const button = document.createElement("button");
  button.className = `row-action${status === "rejected" ? " delete" : ""}`;
  button.type = "button";
  button.setAttribute("aria-label", `${label} for ${teacherName(application.teacherId)}`);
  button.title = label;
  button.textContent = mark;
  button.addEventListener("click", () => reviewLeaveApplication(application.id, status));
  return button;
}

function renderSubstitutionPlans() {
  const tableBody = document.querySelector("#substitution-plans-body");
  const emptyState = document.querySelector("#substitution-plans-empty");
  const teacherAccount = isTeacherAccount();
  document.querySelector("#teacher-substitution-note").hidden = !teacherAccount;
  document.querySelector("#view-substitutions .list-panel").hidden = false;
  document.querySelector("#add-substitution-plan").hidden = false;
  document.querySelectorAll("[data-add-substitution-plan]").forEach((button) => { button.hidden = false; });
  document.querySelector("#add-substitution-plan").textContent = teacherAccount
    ? "＋ Submit coverage proposal"
    : "＋ Create substitution plan";
  document.querySelector("#substitution-plans-empty strong").textContent =
    teacherAccount ? "No coverage proposals yet" : "No substitution plans yet";
  document.querySelector("#substitution-plans-empty p").textContent = teacherAccount
    ? "Submit a coverage proposal after your leave application is approved."
    : "Create a plan to assign teaching loads to an available teacher.";
  document.querySelector("#substitution-plans-empty button").textContent =
    teacherAccount ? "Submit coverage proposal" : "Create substitution plan";
  const plans = [...visibleSubstitutionPlans()].sort((a, b) => a.startDate.localeCompare(b.startDate));
  tableBody.replaceChildren();
  setEmptyState(tableBody, emptyState, plans.length > 0);
  document.querySelector("#substitution-plan-caption").textContent =
    `${plans.length} ${plans.length === 1 ? "substitution plan" : "substitution plans"}`;
  plans.forEach((plan) => {
    const leaveTeacher = state.teachers.find((teacher) => teacher.id === plan.leaveTeacherId);
    const substituteTeacher = state.teachers.find((teacher) => teacher.id === plan.substituteTeacherId);
    const row = document.createElement("tr");
    makeCell(row, leaveTeacher?.name ?? "Unknown teacher", "table-primary");
    makeCell(row, substituteTeacher?.name ?? "Unknown teacher", "table-primary");
    makeCell(row, `${formatDate(plan.startDate)} – ${formatDate(plan.endDate)}`);
    const coveredLoads = (Array.isArray(plan.loadIds) ? plan.loadIds : [])
      .map((id) => state.loads.find((load) => load.id === id))
      .filter(Boolean);
    makeCell(row, coveredLoads.map((load) =>
      `${load.subject} · ${load.grade}${load.section ? ` ${load.section}` : ""} · ${load.groupName || "No group"} · Period ${load.period || "—"}${load.schedule ? ` · ${load.schedule}` : ""} · ${formatLoadDays(load.days)}`,
    ).join("; "));
    const status = plan.status === "rejected" ? "Rejected"
      : plan.status === "pending" ? "Pending admin approval" : "Approved";
    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = `status-badge substitution-status-${plan.status === "pending" ? "pending" : plan.status === "rejected" ? "rejected" : "approved"}`;
    statusBadge.textContent = status;
    statusCell.append(statusBadge);
    row.append(statusCell);
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const preview = document.createElement("button");
    preview.className = "button button-secondary button-small substitution-preview-action";
    preview.type = "button";
    preview.setAttribute("aria-label", `Preview substitution plan for ${leaveTeacher?.name ?? "teacher"}`);
    preview.title = "Open print preview for substitution plan";
    preview.textContent = "Print preview";
    preview.addEventListener("click", () => openSubstitutionPlanPreview(plan.id));
    actions.append(preview);
    if (isAdminAccount() && plan.status === "pending") {
      actions.append(
        makePlanReviewButton(plan, "approved", "Approve proposal", "✓"),
        makePlanReviewButton(plan, "rejected", "Reject proposal", "×"),
      );
    }
    if (canManageSubstitutionPlan(plan)) {
      const editableByTeacher = isTeacherAccount();
      const edit = document.createElement("button");
      edit.className = `row-action${editableByTeacher ? " row-action-text" : ""}`;
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit substitution plan for ${leaveTeacher?.name ?? "teacher"}`);
      edit.title = "Edit substitution plan";
      edit.textContent = editableByTeacher ? "Edit" : "✎";
      edit.addEventListener("click", () => openSubstitutionDialog(plan.id));
      const remove = document.createElement("button");
      remove.className = `row-action delete${editableByTeacher ? " row-action-text" : ""}`;
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete substitution plan for ${leaveTeacher?.name ?? "teacher"}`);
      remove.title = "Delete substitution plan";
      remove.textContent = editableByTeacher ? "Delete" : "×";
      remove.addEventListener("click", () => deleteSubstitutionPlan(plan.id));
      actions.append(edit, remove);
    }
    actionsCell.append(actions);
    row.append(actionsCell);
    tableBody.append(row);
  });
}

function makePlanReviewButton(plan, status, label, mark) {
  const button = document.createElement("button");
  button.className = "row-action";
  button.type = "button";
  button.setAttribute("aria-label", `${label} for substitution plan`);
  button.title = label;
  button.textContent = mark;
  button.addEventListener("click", () => reviewSubstitutionPlan(plan.id, status));
  return button;
}

async function reviewSubstitutionPlan(planId, status) {
  if (!isAdminAccount() || !["approved", "rejected"].includes(status)) {
    showToast("Only the admin can review substitution proposals.", "error");
    return;
  }
  const plan = state.substitutionPlans.find((item) => item.id === planId);
  if (!plan || plan.status !== "pending") return;
  if (status === "approved") {
    const loadIds = Array.isArray(plan.loadIds) ? plan.loadIds : [];
    const coveredLoads = loadIds.map((loadId) =>
      state.loads.find((load) => load.id === loadId && load.teacherId === plan.leaveTeacherId));
    const leaveTeacher = state.teachers.find((teacher) => teacher.id === plan.leaveTeacherId);
    const substituteTeacher = state.teachers.find((teacher) => teacher.id === plan.substituteTeacherId);
    if (leaveTeacher?.status !== "On leave"
      || !substituteTeacher
      || (substituteTeacher.status || "Active") !== "Active"
      || !plan.startDate || !plan.endDate || plan.startDate > plan.endDate
      || !loadIds.length || new Set(loadIds).size !== loadIds.length
      || coveredLoads.some((load) => !load || !loadOccursDuringDates(load, plan.startDate, plan.endDate))) {
      showToast("This proposal is no longer valid. Check teacher status and assignments before approving.", "error");
      return;
    }
    const conflictingLoad = coveredLoads.find((load) =>
      substitutionConflict(load, plan.substituteTeacherId, plan.startDate, plan.endDate, plan.id));
    if (conflictingLoad) {
      showToast(`${conflictingLoad.subject} now conflicts with the substitute's schedule. Edit the proposal before approving.`, "error");
      return;
    }
    for (let index = 0; index < coveredLoads.length; index += 1) {
      if (coveredLoads.slice(0, index).some((load) =>
        loadsOverlap(coveredLoads[index], load, plan.startDate, plan.endDate))) {
        showToast("This proposal contains overlapping assignments. Edit it before approving.", "error");
        return;
      }
    }
  }
  const previousPlans = state.substitutionPlans;
  state.substitutionPlans = previousPlans.map((item) =>
    item.id === planId ? { ...item, status, reviewedAt: new Date().toISOString() } : item);
  if (!(await saveState())) {
    state.substitutionPlans = previousPlans;
    return;
  }
  render();
  showToast(status === "approved" ? "Substitution proposal approved." : "Substitution proposal rejected.");
}

function openLeaveApplicationDialog() {
  if (!isTeacherAccount()) {
    showToast("Only a teacher account can apply for leave.", "error");
    return;
  }
  if (!state.teachers.some((teacher) => teacher.id === currentTeacherId())) {
    showToast("Your teacher profile could not be found. Contact the admin before applying for leave.", "error");
    return;
  }
  document.querySelector("#leave-application-form").reset();
  document.querySelector("#leave-application-end-date").min = "";
  document.querySelector("#leave-application-dialog").showModal();
  document.querySelector("#leave-application-start-date").focus();
}

async function saveLeaveApplication(event) {
  event.preventDefault();
  if (!isTeacherAccount()) {
    showToast("Only a teacher account can apply for leave.", "error");
    return;
  }
  const form = new FormData(event.currentTarget);
  const startDate = String(form.get("startDate") ?? "");
  const endDate = String(form.get("endDate") ?? "");
  const teacherId = currentTeacherId();
  if (!state.teachers.some((teacher) => teacher.id === teacherId)) {
    showToast("Your teacher profile could not be found. Contact the admin before applying for leave.", "error");
    return;
  }
  if (!startDate || !endDate || startDate > endDate) {
    showToast("Enter valid leave dates, with the end date on or after the start date.", "error");
    document.querySelector(startDate ? "#leave-application-end-date" : "#leave-application-start-date").focus();
    return;
  }
  const application = {
    id: createId(),
    teacherId,
    submittedBy: state.currentAccount.id,
    startDate,
    endDate,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  const previousApplications = state.leaveApplications;
  state.leaveApplications = [...previousApplications, application];
  if (!(await saveState())) {
    state.leaveApplications = previousApplications;
    return;
  }
  document.querySelector("#leave-application-dialog").close();
  render();
  showToast("Leave application submitted for admin review.");
}

async function reviewLeaveApplication(applicationId, status) {
  if (!isAdminAccount() || !["approved", "rejected"].includes(status)) {
    showToast("Only the admin can review leave applications.", "error");
    return;
  }
  const application = state.leaveApplications.find((item) => item.id === applicationId);
  if (!application || application.status !== "pending") return;
  const teacher = state.teachers.find((item) => item.id === application.teacherId);
  if (status === "approved" && !teacher) {
    showToast("This application cannot be approved because the teacher profile is missing.", "error");
    return;
  }
  const previousApplications = state.leaveApplications;
  const previousTeachers = state.teachers;
  state.leaveApplications = previousApplications.map((item) =>
    item.id === applicationId ? { ...item, status, reviewedAt: new Date().toISOString() } : item);
  if (status === "approved") {
    state.teachers = previousTeachers.map((item) =>
      item.id === application.teacherId ? { ...item, status: "On leave" } : item);
  }
  if (!(await saveState())) {
    state.leaveApplications = previousApplications;
    state.teachers = previousTeachers;
    return;
  }
  render();
  showToast(status === "approved"
    ? `${teacher.name}'s leave application approved; their status is now On leave.`
    : "Leave application rejected.");
}

function switchView(viewName) {
  if (isTeacherAccount() && !["overview", "loads", "substitutions"].includes(viewName)) {
    showToast("Teacher accounts cannot manage school records or settings.", "error");
    return;
  }
  state.activeView = viewName;
  elements.views.forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  elements.navLinks.forEach((link) => link.classList.toggle("active", Boolean(link.dataset.view) && link.dataset.view === viewName));
  const label = { overview: "Overview", teachers: "Teachers", loads: "Teaching loads", substitutions: "Substitution plans" }[viewName];
  elements.breadcrumb.textContent = label;
  document.title = `${label} · Teacher Load Manager`;
  closeSidebar();
}

function loadWeekdays(load) {
  const selectedDays = Array.isArray(load.days) ? load.days.filter((day) => WEEKDAYS.includes(day)) : [];
  return selectedDays.length ? selectedDays : WEEKDAYS;
}

function timeInMinutes(hourValue, minuteValue, meridiem) {
  let hour = Number(hourValue);
  if (meridiem) {
    hour %= 12;
    if (meridiem.toUpperCase() === "PM") hour += 12;
  }
  return hour * 60 + Number(minuteValue);
}

function loadTimeRange(load) {
  const configured = state.settings.groupPeriodTimes?.[load.groupName]?.[String(load.period)]
    ?? Object.entries(state.settings.groupPeriodTimes ?? {})
      .find(([groupName]) => groupName.toLocaleLowerCase() === String(load.groupName ?? "").toLocaleLowerCase())?.[1]?.[String(load.period)]
    ?? state.settings.periodTimes?.[String(load.period)];
  const configuredStart = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(configured?.start ?? "");
  const configuredEnd = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(configured?.end ?? "");
  if (configuredStart && configuredEnd) {
    return {
      start: Number(configuredStart[1]) * 60 + Number(configuredStart[2]),
      end: Number(configuredEnd[1]) * 60 + Number(configuredEnd[2]),
    };
  }

  const range = /(\d{1,2}):([0-5]\d)\s*(AM|PM)?\s*[–-]\s*(\d{1,2}):([0-5]\d)\s*(AM|PM)?/i.exec(load.schedule ?? "");
  if (range && (range[3] || range[6])) {
    const startMeridiem = range[3] ?? range[6];
    const endMeridiem = range[6] ?? range[3];
    return {
      start: timeInMinutes(range[1], range[2], startMeridiem),
      end: timeInMinutes(range[4], range[5], endMeridiem),
    };
  }

  if (range) {
    return {
      start: timeInMinutes(range[1], range[2], ""),
      end: timeInMinutes(range[4], range[5], ""),
    };
  }
  return null;
}

function hasWeekdayDuringDates(weekday, startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return true;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const targetWeekday = (WEEKDAYS.indexOf(weekday) + 1) % 7;
  for (let date = start; date <= end; date = new Date(date.getTime() + 86400000)) {
    if (date.getUTCDay() === targetWeekday) return true;
  }
  return false;
}

function loadOccursDuringDates(load, startDate, endDate) {
  return loadWeekdays(load).some((day) => hasWeekdayDuringDates(day, startDate, endDate));
}

function loadsOverlap(first, second, startDate = "", endDate = "") {
  const sharedDays = loadWeekdays(first).filter((day) =>
    loadWeekdays(second).includes(day) && hasWeekdayDuringDates(day, startDate, endDate));
  if (!sharedDays.length) return false;

  const firstRange = loadTimeRange(first);
  const secondRange = loadTimeRange(second);
  if (firstRange && secondRange) {
    return firstRange.start < secondRange.end && secondRange.start < firstRange.end;
  }
  return first.groupName === second.groupName && String(first.period) === String(second.period);
}

function substituteCommitments(teacherId, startDate, endDate, excludedPlanId = "") {
  const commitments = teacherLoads(teacherId).map((load) => ({ load, plan: null }));
  state.substitutionPlans
    .filter((plan) => plan.id !== excludedPlanId
      && plan.status !== "rejected"
      && plan.substituteTeacherId === teacherId
      && plan.startDate <= endDate && startDate <= plan.endDate)
    .forEach((plan) => {
      (Array.isArray(plan.loadIds) ? plan.loadIds : []).forEach((id) => {
        const load = state.loads.find((item) => item.id === id);
        if (load) commitments.push({ load, plan });
      });
    });
  return commitments;
}

function substitutionConflict(load, substituteTeacherId, startDate, endDate, excludedPlanId = "") {
  const commitments = substituteCommitments(substituteTeacherId, startDate, endDate, excludedPlanId);
  return commitments.find(({ load: assignedLoad }) =>
    loadsOverlap(load, assignedLoad, startDate, endDate));
}

function populateSubstitutionTeachers(leaveTeacherId, startDate = "", endDate = "") {
  const select = document.querySelector("#substitution-cover-teacher");
  const currentSelection = select.value;
  const selectedGroup = document.querySelector("#substitution-group-filter").value;
  const selectedPeriod = document.querySelector("#substitution-period-filter").value;
  const loads = teacherLoads(leaveTeacherId);
  const selectedLoadIds = new Set([...document.querySelectorAll('#substitution-load-options input[name="loadIds"]:checked')]
    .map((input) => input.value));
  const matchingLoads = loads.filter((load) =>
    (!selectedGroup || load.groupName === selectedGroup)
    && (!selectedPeriod || String(load.period) === selectedPeriod));
  const selectedLoads = matchingLoads.filter((load) => selectedLoadIds.has(load.id));
  const targetLoads = selectedLoads.length ? selectedLoads : matchingLoads;
  const activeTeachers = state.teachers
    .filter((teacher) => teacher.id !== leaveTeacherId && (teacher.status || "Active") === "Active")
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableTeachers = targetLoads.length
    ? activeTeachers.filter((teacher) => selectedLoads.length
      ? targetLoads.every((load) => !substitutionConflict(load, teacher.id, startDate, endDate, state.editingSubstitutionPlanId))
      : targetLoads.some((load) => !substitutionConflict(load, teacher.id, startDate, endDate, state.editingSubstitutionPlanId)))
    : activeTeachers;

  select.replaceChildren(new Option(
    availableTeachers.length ? "Select available teacher" : "No available teachers for this period",
    "",
  ));
  availableTeachers.forEach((teacher) => select.add(new Option(teacher.name, teacher.id)));
  if (availableTeachers.some((teacher) => teacher.id === currentSelection)) {
    select.value = currentSelection;
  }
}

function populateSubstitutionLoads(leaveTeacherId, substituteTeacherId = "", startDate = "", endDate = "") {
  const container = document.querySelector("#substitution-load-options");
  const hint = document.querySelector("#substitution-load-hint");
  const selectedGroup = document.querySelector("#substitution-group-filter").value;
  const selectedPeriod = document.querySelector("#substitution-period-filter").value;
  const selectedLoadIds = new Set([...container.querySelectorAll('input[name="loadIds"]:checked')].map((input) => input.value));
  container.replaceChildren();
  if (!leaveTeacherId) {
    hint.textContent = "Choose a teacher on leave to list their assignments.";
    return;
  }
  const loads = teacherLoads(leaveTeacherId).sort(compareLoadSchedules);
  if (!loads.length) {
    hint.textContent = "This teacher has no teaching assignments to cover.";
    return;
  }
  hint.textContent = "Select one or more assignments. Group and period times sync with Groups & periods; unavailable times are marked against the substitute's current schedule.";
  loads.forEach((load, index) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "loadIds";
    checkbox.value = load.id;
    checkbox.checked = selectedLoadIds.has(load.id);
    const description = document.createElement("span");
    const currentSchedule = periodTime(load.period, load.groupName) || load.schedule || "Time not set";
    description.textContent = `${load.subject} · ${load.grade}${load.section ? ` ${load.section}` : ""} · ${load.groupName || "No group"} · Period ${load.period || "—"} · ${currentSchedule} · ${formatLoadDays(load.days)}`;
    label.hidden = (selectedGroup && load.groupName !== selectedGroup)
      || (selectedPeriod && String(load.period) !== selectedPeriod);
    label.append(checkbox, description);
    const substituteScheduleConflict = substituteTeacherId
      ? substitutionConflict(load, substituteTeacherId, startDate, endDate, state.editingSubstitutionPlanId)
      : null;
    const selectedLoadConflict = loads.slice(0, index).find((selectedLoad) =>
      selectedLoadIds.has(selectedLoad.id) && loadsOverlap(load, selectedLoad, startDate, endDate));
    const conflict = startDate && endDate && !loadOccursDuringDates(load, startDate, endDate)
      ? { load, message: "No selected weekdays fall within these leave dates." }
      : substituteScheduleConflict
      ?? (selectedLoadConflict ? { load: selectedLoadConflict, plan: null } : null);
    if (conflict) {
      checkbox.checked = false;
      checkbox.disabled = true;
      label.classList.add("is-unavailable");
      const reason = document.createElement("small");
      reason.className = "substitution-conflict";
      const conflictingSchedule = periodTime(conflict.load.period, conflict.load.groupName)
        || conflict.load.schedule;
      reason.textContent = conflict.message
        ? `Unavailable: ${conflict.message}`
        : `Unavailable: overlaps ${conflict.load.subject}${conflictingSchedule ? ` at ${conflictingSchedule}` : ""}${formatLoadDays(conflict.load.days) !== "—" ? ` on ${formatLoadDays(conflict.load.days)}` : ""}${conflict.plan ? " in another substitution plan" : ""}.`;
      label.append(reason);
    }
    container.append(label);
  });
}

function populateSubstitutionFilters() {
  const groupSelect = document.querySelector("#substitution-group-filter");
  const periodSelect = document.querySelector("#substitution-period-filter");
  const groups = [...new Set([
    ...state.settings.groupNames,
    ...state.loads.map((load) => load.groupName).filter(Boolean),
  ])];
  groupSelect.replaceChildren(new Option("All groups", ""));
  groups.forEach((groupName) => groupSelect.add(new Option(groupName, groupName)));

  const periods = [...new Set([
    ...Array.from({ length: 7 }, (_, index) => String(index + 1)),
    ...state.loads.map((load) => String(load.period ?? "")).filter((period) => period && !/^[1-7]$/.test(period)),
  ])];
  periodSelect.replaceChildren(new Option("All periods", ""));
  periods.forEach((period) => periodSelect.add(new Option(`Period ${period}`, period)));
}

function openSubstitutionDialog(planId = "") {
  const plan = state.substitutionPlans.find((item) => item.id === planId);
  if (planId && !canManageSubstitutionPlan(plan)) {
    showToast("You can only edit your own pending coverage proposals.", "error");
    return;
  }
  state.editingSubstitutionPlanId = plan?.id ?? "";
  const form = document.querySelector("#substitution-form");
  form.reset();
  const teacherAccount = isTeacherAccount();
  document.querySelector("#substitution-dialog-title").textContent = plan
    ? "Edit substitution plan"
    : teacherAccount ? "Submit coverage proposal" : "Create substitution plan";
  document.querySelector("#substitution-form button[type=\"submit\"]").textContent =
    plan ? "Save changes" : teacherAccount ? "Submit for admin review" : "Save substitution plan";
  const leaveSelect = document.querySelector("#substitution-leave-teacher");
  const substituteSelect = document.querySelector("#substitution-cover-teacher");
  const leaveHelp = document.querySelector("#substitution-leave-help");
  leaveSelect.replaceChildren(new Option("Select teacher on leave", ""));
  substituteSelect.replaceChildren(new Option("Select available teacher", ""));
  populateSubstitutionFilters();
  state.teachers
    .filter((teacher) => teacher.status === "On leave"
      && (!teacherAccount || teacher.id === currentTeacherId()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((teacher) => leaveSelect.add(new Option(teacher.name, teacher.id)));
  leaveHelp.hidden = leaveSelect.options.length > 1;
  if (plan) {
    if (![...leaveSelect.options].some((option) => option.value === plan.leaveTeacherId)) {
      leaveSelect.add(new Option(
        state.teachers.find((teacher) => teacher.id === plan.leaveTeacherId)?.name ?? "Unknown teacher",
        plan.leaveTeacherId,
      ));
    }
    leaveSelect.value = plan.leaveTeacherId;
    document.querySelector("#substitution-start-date").value = plan.startDate;
    document.querySelector("#substitution-end-date").value = plan.endDate;
    populateSubstitutionLoads(plan.leaveTeacherId, "", plan.startDate, plan.endDate);
    document.querySelectorAll('#substitution-load-options input[name="loadIds"]').forEach((input) => {
      input.checked = (Array.isArray(plan.loadIds) ? plan.loadIds : []).includes(input.value);
    });
    populateSubstitutionTeachers(plan.leaveTeacherId, plan.startDate, plan.endDate);
    populateSubstitutionLoads(
      plan.leaveTeacherId,
      plan.substituteTeacherId,
      plan.startDate,
      plan.endDate,
    );
    document.querySelector("#substitution-cover-teacher").value = plan.substituteTeacherId;
  } else if (teacherAccount) {
    const ownTeacher = state.teachers.find((teacher) => teacher.id === currentTeacherId());
    if (ownTeacher?.status === "On leave") {
      leaveSelect.value = ownTeacher.id;
      populateSubstitutionTeachers(ownTeacher.id);
      populateSubstitutionLoads(ownTeacher.id);
    }
  } else {
    populateSubstitutionTeachers("");
    populateSubstitutionLoads("");
  }
  document.querySelector("#substitution-dialog").showModal();
  if (leaveSelect.options.length === 1) {
    showToast("Mark the teacher's status as On leave before creating a substitution plan.", "error");
  }
  if (substituteSelect.options.length === 1) {
    showToast("No Active teachers are available to substitute. Update a teacher's status or add a teacher.", "error");
  }
}

function printSubstitutionPlan() {
  const leaveTeacherId = document.querySelector("#substitution-leave-teacher").value;
  const substituteTeacherId = document.querySelector("#substitution-cover-teacher").value;
  const startDate = document.querySelector("#substitution-start-date").value;
  const endDate = document.querySelector("#substitution-end-date").value;
  const selectedLoadIds = [...document.querySelectorAll('#substitution-load-options input[name="loadIds"]:checked')]
    .map((input) => input.value);
  const leaveTeacher = state.teachers.find((teacher) => teacher.id === leaveTeacherId);
  const substituteTeacher = state.teachers.find((teacher) => teacher.id === substituteTeacherId);
  const selectedLoads = selectedLoadIds
    .map((id) => state.loads.find((load) => load.id === id))
    .filter((load) => load && load.teacherId === leaveTeacherId);

  if (!leaveTeacher || !substituteTeacher || !startDate || !endDate || startDate > endDate || !selectedLoads.length) {
    showToast("Select the leave teacher, available substitute, valid leave dates, and at least one load before printing.", "error");
    return;
  }

  populateSubstitutionPrintSheet(leaveTeacher, substituteTeacher, startDate, endDate, selectedLoads);
  printSubstitutionSheet();
}

function populateSubstitutionPrintSheet(leaveTeacher, substituteTeacher, startDate, endDate, loads) {
  document.querySelector("#substitution-print-summary").textContent =
    `Teacher on leave: ${leaveTeacher.name} | Substitute: ${substituteTeacher.name} | Leave dates: ${formatDate(startDate)} – ${formatDate(endDate)}`;
  const tableBody = document.querySelector("#substitution-print-loads");
  tableBody.replaceChildren();
  loads.forEach((load) => {
    const row = document.createElement("tr");
    [
      load.subject,
      `${load.grade}${load.section ? ` ${load.section}` : ""}`,
      load.groupName || "—",
      [load.period ? `Period ${load.period}` : "", periodTime(load.period, load.groupName) || load.schedule || "Time not set"]
        .filter(Boolean).join(" · "),
      formatLoadDays(load.days),
    ].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    tableBody.append(row);
  });
}

function printSubstitutionSheet() {
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) openDialog.close();
  document.body.classList.add("printing-substitution-plan");
  const finishPrinting = () => {
    document.body.classList.remove("printing-substitution-plan");
    if (openDialog?.isConnected) openDialog.showModal();
  };
  window.addEventListener("afterprint", finishPrinting, { once: true });
  requestAnimationFrame(() => {
    window.print();
  });
}

function openSubstitutionPlanPreview(planId) {
  const plan = visibleSubstitutionPlans().find((item) => item.id === planId);
  if (!plan) {
    showToast("Couldn't find this substitution plan.", "error");
    return;
  }
  const leaveTeacher = state.teachers.find((teacher) => teacher.id === plan.leaveTeacherId);
  const substituteTeacher = state.teachers.find((teacher) => teacher.id === plan.substituteTeacherId);
  if (!leaveTeacher || !substituteTeacher) {
    showToast("This plan's teacher details are missing, so it can't be previewed.", "error");
    return;
  }
  const loads = (Array.isArray(plan.loadIds) ? plan.loadIds : [])
    .map((id) => state.loads.find((load) => load.id === id))
    .filter(Boolean);
  const summary = `Teacher on leave: ${leaveTeacher.name} · Substitute: ${substituteTeacher.name} · Leave dates: ${formatDate(plan.startDate)} – ${formatDate(plan.endDate)}`;
  document.querySelector("#substitution-plan-preview-summary").textContent = summary;
  const tableBody = document.querySelector("#substitution-plan-preview-loads");
  tableBody.replaceChildren();
  loads.forEach((load) => {
    const row = document.createElement("tr");
    [
      load.subject,
      `${load.grade}${load.section ? ` ${load.section}` : ""}`,
      load.groupName || "—",
      [load.period ? `Period ${load.period}` : "", periodTime(load.period, load.groupName) || load.schedule || "Time not set"]
        .filter(Boolean).join(" · "),
      formatLoadDays(load.days),
    ].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    tableBody.append(row);
  });
  const previewDialog = document.querySelector("#substitution-plan-preview");
  document.querySelector("#print-saved-substitution-plan").onclick = () => {
    populateSubstitutionPrintSheet(leaveTeacher, substituteTeacher, plan.startDate, plan.endDate, loads);
    printSubstitutionSheet();
  };
  previewDialog.showModal();
}

async function saveSubstitutionPlan(event) {
  event.preventDefault();
  if (!isAdminAccount() && !isTeacherAccount()) {
    showToast("Sign in with an authorized account to manage substitution plans.", "error");
    return;
  }
  const isEditing = Boolean(state.editingSubstitutionPlanId);
  const existingPlan = state.substitutionPlans.find((item) => item.id === state.editingSubstitutionPlanId);
  if (isEditing && !canManageSubstitutionPlan(existingPlan)) {
    showToast("You can only edit your own pending coverage proposals.", "error");
    return;
  }
  const form = new FormData(event.currentTarget);
  const leaveTeacherId = String(form.get("leaveTeacherId") ?? "");
  const substituteTeacherId = String(form.get("substituteTeacherId") ?? "");
  const startDate = String(form.get("startDate") ?? "");
  const endDate = String(form.get("endDate") ?? "");
  const loadIds = [...new Set(form.getAll("loadIds").map(String))];
  const leaveTeacher = state.teachers.find((teacher) => teacher.id === leaveTeacherId);
  const substituteTeacher = state.teachers.find((teacher) => teacher.id === substituteTeacherId);

  if (isTeacherAccount() && leaveTeacherId !== currentTeacherId()) {
    showToast("You can only submit a coverage proposal for your own leave.", "error");
    return;
  }
  if (leaveTeacher?.status !== "On leave") {
    showToast("Select a teacher whose employment status is On leave.", "error");
    document.querySelector("#substitution-leave-teacher").focus();
    return;
  }
  if (!substituteTeacher || (substituteTeacher.status || "Active") !== "Active") {
    showToast("Select an available teacher whose status is Active.", "error");
    document.querySelector("#substitution-cover-teacher").focus();
    return;
  }
  if (!startDate || !endDate || startDate > endDate) {
    showToast("Enter valid leave dates, with the end date on or after the start date.", "error");
    document.querySelector(startDate ? "#substitution-end-date" : "#substitution-start-date").focus();
    return;
  }
  const leaveLoads = teacherLoads(leaveTeacherId);
  if (!loadIds.length || loadIds.some((id) => !leaveLoads.some((load) => load.id === id))) {
    showToast("Select at least one teaching load belonging to the teacher on leave.", "error");
    return;
  }
  const nonoccurringLoad = loadIds
    .map((id) => leaveLoads.find((load) => load.id === id))
    .find((load) => !loadOccursDuringDates(load, startDate, endDate));
  if (nonoccurringLoad) {
    showToast(`${nonoccurringLoad.subject} has no scheduled weekdays during these leave dates.`, "error");
    return;
  }
  const conflictingLoad = loadIds
    .map((id) => leaveLoads.find((load) => load.id === id))
    .find((load) => substitutionConflict(load, substituteTeacherId, startDate, endDate, state.editingSubstitutionPlanId));
  if (conflictingLoad) {
    populateSubstitutionLoads(leaveTeacherId, substituteTeacherId, startDate, endDate);
    showToast(`${conflictingLoad.subject} cannot be covered because its group, period, time, or weekdays overlap the substitute's schedule.`, "error");
    return;
  }
  const selectedLoads = loadIds.map((id) => leaveLoads.find((load) => load.id === id));
  for (let index = 0; index < selectedLoads.length; index += 1) {
    const overlappingLoad = selectedLoads.slice(0, index).find((load) =>
      loadsOverlap(selectedLoads[index], load, startDate, endDate));
    if (overlappingLoad) {
      showToast("The selected leave assignments overlap each other and cannot both be covered by one substitute at the same time.", "error");
      return;
    }
  }
  const plan = {
    id: state.editingSubstitutionPlanId || createId(),
    leaveTeacherId,
    substituteTeacherId,
    startDate,
    endDate,
    loadIds,
    submittedBy: isTeacherAccount() ? state.currentAccount.id : existingPlan?.submittedBy,
    status: isTeacherAccount() ? "pending" : state.editingSubstitutionPlanId
      ? existingPlan?.status ?? "approved"
      : "approved",
    submittedAt: isTeacherAccount() ? new Date().toISOString() : undefined,
  };
  const previousPlans = state.substitutionPlans;
  if (state.editingSubstitutionPlanId) {
    state.substitutionPlans = previousPlans.map((item) => item.id === plan.id ? plan : item);
  } else {
    state.substitutionPlans = [...previousPlans, plan];
  }
  if (!(await saveState())) {
    state.substitutionPlans = previousPlans;
    return;
  }
  state.editingSubstitutionPlanId = "";
  document.querySelector("#substitution-dialog").close();
  render();
  showToast(isEditing ? "Substitution plan updated."
    : isTeacherAccount() ? "Coverage proposal submitted for admin review."
      : "Substitution plan saved.");
}

async function deleteSubstitutionPlan(id) {
  const plan = state.substitutionPlans.find((item) => item.id === id);
  if (!canManageSubstitutionPlan(plan)) {
    showToast("You can only delete your own pending coverage proposals.", "error");
    return;
  }
  if (!plan || !window.confirm("Delete this substitution plan?")) return;
  const previousPlans = state.substitutionPlans;
  state.substitutionPlans = previousPlans.filter((plan) => plan.id !== id);
  if (!(await saveState())) {
    state.substitutionPlans = previousPlans;
    return;
  }
  renderSubstitutionPlans();
  showToast("Substitution plan deleted.");
}

function openTeacherDialog(teacherId) {
  if (!isAdminAccount()) {
    showToast("Only the admin can manage teacher profiles.", "error");
    return;
  }
  const teacher = state.teachers.find((item) => item.id === teacherId);
  document.querySelector("#teacher-form").reset();
  document.querySelector("#teacher-id").value = teacher?.id ?? "";
  document.querySelector("#teacher-name").value = teacher?.name ?? "";
  document.querySelector("#teacher-employee-id").value = teacher?.employeeId ?? "";
  document.querySelector("#teacher-position").value = teacher?.position ?? "";
  document.querySelector("#teacher-status").value = teacher?.status ?? "Active";
  const editing = Boolean(teacher);
  document.querySelector("#teacher-dialog-title").textContent = editing ? "Edit teacher profile" : "Add teacher user account";
  document.querySelector("#teacher-dialog-description").textContent = editing
    ? "Update the teacher's profile details."
    : "Create a username and profile. Give the username and temporary password to the teacher securely.";
  document.querySelector("#teacher-username-field").hidden = editing;
  document.querySelector("#teacher-temp-password-field").hidden = editing;
  document.querySelector("#teacher-confirm-password-field").hidden = editing;
  document.querySelector("#teacher-status-field").hidden = !editing;
  document.querySelector("#teacher-username").required = !editing;
  document.querySelector("#teacher-temp-password").required = !editing;
  document.querySelector("#teacher-confirm-password").required = !editing;
  document.querySelector("#teacher-form-error").hidden = true;
  document.querySelector("#teacher-form-submit").textContent = editing ? "Save teacher profile" : "Create user account";
  elements.teacherDialog.showModal();
  document.querySelector(editing ? "#teacher-name" : "#teacher-username").focus();
}

function openLoadDialog(loadId, selectedTeacherId = "") {
  const load = state.loads.find((item) => item.id === loadId);
  if (loadId && !canManageLoad(load)) {
    showToast("You can only edit teaching loads assigned to your own profile.", "error");
    return;
  }
  if (!isAdminAccount() && !isTeacherAccount()) {
    showToast("Sign in with an authorized account to manage teaching loads.", "error");
    return;
  }
  if (!state.teachers.length) {
    showToast("Add a teacher profile before creating a teaching assignment.", "error");
    switchView("teachers");
    return;
  }
  const teacherSelect = document.querySelector("#load-teacher");
  teacherSelect.replaceChildren();
  const teachersForLoad = isTeacherAccount()
    ? state.teachers.filter((teacher) => teacher.id === currentTeacherId())
    : state.teachers;
  teachersForLoad.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((teacher) => {
    const option = document.createElement("option");
    option.value = teacher.id;
    option.textContent = teacher.name;
    teacherSelect.append(option);
  });
  const groupSelect = document.querySelector("#load-group-name");
  const selectedGroup = load?.groupName ?? "";
  groupSelect.replaceChildren(new Option("Select group", ""));
  const groupNames = [...state.settings.groupNames];
  if (selectedGroup && !groupNames.includes(selectedGroup)) groupNames.push(selectedGroup);
  groupNames.forEach((groupName) => groupSelect.add(new Option(groupName, groupName)));
  const autoGenerate = !load && state.settings.autoRecordPeriods;
  state.singleLoadFromAutoMode = false;
  const autoGenerateCard = document.querySelector("#auto-generate-card");
  const singleAssignmentFields = document.querySelector("#single-assignment-fields");
  autoGenerateCard.hidden = !autoGenerate;
  singleAssignmentFields.hidden = autoGenerate;
  document.querySelector("#load-period").required = !autoGenerate;
  groupSelect.required = !autoGenerate;
  document.querySelector("#load-form").reset();
  autoGenerateCard.hidden = !autoGenerate;
  singleAssignmentFields.hidden = autoGenerate;
  document.querySelector("#load-period").required = !autoGenerate;
  groupSelect.required = !autoGenerate;
  document.querySelector("#load-id").value = load?.id ?? "";
  document.querySelector("#preview-teacher-load").hidden = !load;
  document.querySelector("#save-add-another-load").hidden = !load;
  if (load) {
    teacherSelect.value = load.teacherId;
    document.querySelector("#load-subject").value = load.subject;
    document.querySelector("#load-grade").value = load.grade;
    document.querySelector("#load-section").value = load.section ?? "";
    const selectedDays = new Set(Array.isArray(load.days) ? load.days : []);
    document.querySelectorAll('input[name="days"]').forEach((checkbox) => {
      checkbox.checked = selectedDays.has(checkbox.value);
    });
    document.querySelector("#load-group-name").value = load.groupName ?? "";
    document.querySelector("#load-period").value = load.period ?? "";
    document.querySelector("#load-minutes").value = load.minutes;
  } else if (selectedTeacherId) {
    teacherSelect.value = selectedTeacherId;
  }
  const selectedPeriod = document.querySelector("#load-period").value;
  const savedSchedule = load?.schedule ?? "";
  renderLoadScheduleOptions({
    period: selectedPeriod,
    selectedGroup: groupSelect.value,
    selectedSchedule: savedSchedule,
  });
  document.querySelector("#load-schedule-hint").textContent = autoGenerate
    ? "Choose a period and time to add one assignment, or leave it unselected to add all groups and periods."
    : "Choose a group, period, and configured time. The group and period fields update automatically.";
  document.querySelector("#load-dialog-title").textContent = load ? "Edit teaching load" : "Add teaching load";
  elements.loadDialog.showModal();
  teacherSelect.focus();
}

async function saveTeacher(event) {
  event.preventDefault();
  if (!isAdminAccount()) {
    showToast("Only the admin can manage teacher profiles.", "error");
    return;
  }
  const form = new FormData(event.currentTarget);
  const id = document.querySelector("#teacher-id").value;
  const employeeId = String(form.get("employeeId") ?? "").trim();
  const profileError = document.querySelector("#teacher-form-error");
  profileError.hidden = true;
  if (employeeId && state.teachers.some((teacher) => teacher.id !== id && teacher.employeeId?.toLocaleLowerCase() === employeeId.toLocaleLowerCase())) {
    showToast("That employee ID is already used by another teacher.", "error");
    document.querySelector("#teacher-employee-id").focus();
    return;
  }
  if (!id) {
    const username = String(form.get("username") ?? "").trim().toLocaleLowerCase();
    const temporaryPassword = String(form.get("temporaryPassword") ?? "");
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
      profileError.textContent = "Use 3–40 letters, numbers, periods, underscores, or hyphens for the username.";
      profileError.hidden = false;
      document.querySelector("#teacher-username").focus();
      return;
    }
    if (temporaryPassword.length < 12) {
      profileError.textContent = "Use a temporary password with at least 12 characters.";
      profileError.hidden = false;
      document.querySelector("#teacher-temp-password").focus();
      return;
    }
    if (temporaryPassword !== String(form.get("confirmPassword") ?? "")) {
      profileError.textContent = "The temporary passwords do not match.";
      profileError.hidden = false;
      document.querySelector("#teacher-confirm-password").focus();
      return;
    }
    try {
      await apiRequest("admin/create-teacher", {
        username,
        password: temporaryPassword,
        fullName: String(form.get("name") ?? "").trim(),
        employeeId,
        position: String(form.get("position") ?? "").trim(),
      });
    } catch (error) {
      profileError.textContent = `Couldn't create the user account: ${error.message}`;
      profileError.hidden = false;
      return;
    }
    elements.teacherDialog.close();
    document.querySelector("#teacher-form").reset();
    try {
      await loadCloudState();
      render();
      showToast("Teacher account created. Give the username and temporary password to the teacher securely.");
    } catch (error) {
      showToast(`Account created, but the directory couldn't refresh: ${error.message}. Reload the page.`, "error");
    }
    return;
  }
  const record = {
    id: id || createId(),
    name: String(form.get("name") ?? "").trim(),
    employeeId,
    position: String(form.get("position") ?? "").trim(),
    status: String(form.get("status") ?? "Active"),
  };
  if (!record.name) return;
  const previousTeachers = [...state.teachers];
  if (id) state.teachers = state.teachers.map((teacher) => teacher.id === id ? record : teacher);
  else state.teachers.push(record);
  if (!(await saveState())) {
    state.teachers = previousTeachers;
    return;
  }
  elements.teacherDialog.close();
  render();
  showToast("Teacher profile updated.");
}

async function saveLoad(event) {
  event.preventDefault();
  if (!isAdminAccount() && !isTeacherAccount()) {
    showToast("Sign in with an authorized account to manage teaching loads.", "error");
    return;
  }
  const addAnother = event.submitter?.value === "add-another";
  const form = new FormData(event.currentTarget);
  const minutes = Number(form.get("minutes"));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    showToast("Enter a whole number of weekly minutes from 1 to 10,080.", "error");
    document.querySelector("#load-minutes").focus();
    return;
  }
  const id = document.querySelector("#load-id").value;
  const record = {
    id: id || createId(),
    teacherId: String(form.get("teacherId") ?? ""),
    subject: String(form.get("subject") ?? "").trim(),
    grade: String(form.get("grade") ?? "").trim(),
    section: String(form.get("section") ?? "").trim(),
    days: form.getAll("days").filter((day) => WEEKDAYS.includes(day)),
    groupName: String(form.get("groupName") ?? "").trim(),
    period: String(form.get("period") ?? "").trim(),
    minutes,
    schedule: String(form.get("schedule") ?? "").trim(),
  };
  if (isTeacherAccount() && (record.teacherId !== currentTeacherId()
    || (id && !canManageLoad(state.loads.find((load) => load.id === id))))) {
    showToast("You can only add or edit teaching loads assigned to your own profile.", "error");
    return;
  }
  const selectedScheduleOption = document.querySelector("#load-schedule").selectedOptions[0];
  if (selectedScheduleOption?.dataset.groupName) {
    record.groupName = selectedScheduleOption.dataset.groupName;
    record.period = selectedScheduleOption.dataset.period;
    record.schedule = selectedScheduleOption.dataset.schedule;
  }
  if (!state.teachers.some((teacher) => teacher.id === record.teacherId)) {
    showToast("Select a teacher profile for this assignment.", "error");
    return;
  }
  const autoGenerate = !id && state.settings.autoRecordPeriods && !state.singleLoadFromAutoMode;
  if (!record.subject || !record.grade || (!autoGenerate && !/^[1-7]$/.test(record.period))) {
    showToast("Enter a learning area and grade level, and select a period from 1 to 7 for a single assignment.", "error");
    return;
  }
  const previousLoads = [...state.loads];
  if (id) {
    state.loads = state.loads.map((load) => load.id === id ? record : load);
  } else if (autoGenerate) {
    const generatedRecords = state.settings.groupNames.flatMap((groupName) =>
      Array.from({ length: 7 }, (_, index) => ({
        ...record,
        id: createId(),
        days: [...record.days],
        groupName,
        period: String(index + 1),
        schedule: periodTime(String(index + 1), groupName),
      })),
    );
    state.loads.push(...generatedRecords);
  } else {
    state.loads.push(record);
  }
  if (!(await saveState())) {
    state.loads = previousLoads;
    return;
  }
  elements.loadDialog.close();
  state.singleLoadFromAutoMode = false;
  render();
  showToast(id ? "Teaching assignment updated." : autoGenerate ? "14 teaching assignments added; the entered minutes apply to each." : "Teaching assignment added.");
  if (addAnother) openLoadDialog(undefined, record.teacherId);
}

function previewTeacherLoads() {
  const teacherId = document.querySelector("#load-teacher").value;
  const teacher = state.teachers.find((item) => item.id === teacherId);
  if (!teacher) {
    showToast("Select a teacher to preview their teaching loads.", "error");
    return;
  }
  const loads = teacherLoads(teacherId).slice().sort(compareLoadSchedules);
  document.querySelector("#teacher-load-preview-title").textContent = teacher.name;
  document.querySelector("#teacher-load-preview-subtitle").textContent = `${loads.length} ${loads.length === 1 ? "teaching assignment" : "teaching assignments"}`;
  document.querySelector("#teacher-load-preview-summary").textContent =
    `Total weekly teaching time: ${formatMinutes(teacherMinutes(teacherId))}`;
  const tableBody = document.querySelector("#teacher-load-preview-body");
  tableBody.replaceChildren();
  loads.forEach((load) => {
    const row = document.createElement("tr");
    makeCell(row, load.subject, "table-primary");
    makeCell(row, `${load.grade}${load.section ? ` · ${load.section}` : ""}`);
    makeCell(row, load.groupName || "—");
    makeCell(row, [load.period ? `Period ${load.period}` : "", load.schedule || periodTime(load.period, load.groupName)].filter(Boolean).join(" · ") || "—");
    makeCell(row, formatLoadDays(load.days));
    makeCell(row, formatMinutes(load.minutes));
    makeActionCell(row, "load", load.id, `${load.subject} assignment`, true);
    tableBody.append(row);
  });
  document.querySelector("#teacher-load-preview-empty").hidden = loads.length > 0;
  elements.teacherLoadPreview.showModal();
}

async function deleteTeacher(id) {
  if (!isAdminAccount()) {
    showToast("Only the admin can manage teacher profiles.", "error");
    return;
  }
  const teacher = state.teachers.find((item) => item.id === id);
  if (!teacher) return;
  if (state.currentAccount?.role === "teacher" && id === state.currentAccount.teacherId) {
    showToast("Your teacher profile cannot be deleted from a teacher account.", "error");
    return;
  }
  const assignedCount = teacherLoads(id).length;
  const message = assignedCount
    ? `${teacher.name} has ${assignedCount} teaching ${assignedCount === 1 ? "assignment" : "assignments"}. Delete the teacher and all of those assignments?`
    : `Delete ${teacher.name}'s teacher profile?`;
  if (!window.confirm(message)) return;
  const previousTeachers = state.teachers;
  const previousLoads = state.loads;
  const previousSubstitutionPlans = state.substitutionPlans;
  const previousLeaveApplications = state.leaveApplications;
  state.teachers = state.teachers.filter((item) => item.id !== id);
  state.loads = state.loads.filter((item) => item.teacherId !== id);
  state.substitutionPlans = state.substitutionPlans.filter((plan) =>
    plan.leaveTeacherId !== id && plan.substituteTeacherId !== id);
  state.leaveApplications = state.leaveApplications.filter((application) => application.teacherId !== id);
  if (!(await saveState())) {
    state.teachers = previousTeachers;
    state.loads = previousLoads;
    state.substitutionPlans = previousSubstitutionPlans;
    state.leaveApplications = previousLeaveApplications;
    render();
    return;
  }
  render();
  showToast("Teacher profile deleted.");
}

async function deleteLoad(id) {
  const load = state.loads.find((item) => item.id === id);
  if (!canManageLoad(load)) {
    showToast("You can only delete teaching loads assigned to your own profile.", "error");
    return;
  }
  if (!load || !window.confirm(`Delete the ${load.subject} assignment for ${teacherName(load.teacherId)}?`)) return;
  const previousLoads = state.loads;
  const previousSubstitutionPlans = state.substitutionPlans;
  state.loads = state.loads.filter((item) => item.id !== id);
  state.substitutionPlans = state.substitutionPlans
    .map((plan) => ({ ...plan, loadIds: (Array.isArray(plan.loadIds) ? plan.loadIds : []).filter((loadId) => loadId !== id) }))
    .filter((plan) => plan.loadIds.length > 0);
  if (!(await saveState())) {
    state.loads = previousLoads;
    state.substitutionPlans = previousSubstitutionPlans;
    render();
    return;
  }
  render();
  showToast("Teaching assignment deleted.");
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!isAdminAccount()) {
    showToast("Only the admin can export schoolwide records.", "error");
    return;
  }
  const columns = ["School", "School Year", "Teacher", "Employee ID", "Position", "Employment Status", "Learning Area", "Grade Level", "Section", "Group Name", "Period", "Period Start Time", "Period End Time", "Days", "Minutes Per Week", "Schedule"];
  const rows = state.loads.map((load) => {
    const teacher = state.teachers.find((item) => item.id === load.teacherId);
    return [
      state.settings.schoolName,
      state.settings.schoolYear,
      teacher?.name ?? "Unknown teacher",
      teacher?.employeeId ?? "",
      teacher?.position ?? "",
      teacher?.status ?? "",
      load.subject,
      load.grade,
      load.section ?? "",
      load.groupName ?? "",
      load.period ? `Period ${load.period}` : "",
      state.settings.groupPeriodTimes?.[load.groupName]?.[String(load.period)]?.start ?? state.settings.periodTimes?.[String(load.period)]?.start ?? "",
      state.settings.groupPeriodTimes?.[load.groupName]?.[String(load.period)]?.end ?? state.settings.periodTimes?.[String(load.period)]?.end ?? "",
      Array.isArray(load.days) ? load.days.join(", ") : "",
      load.minutes,
      load.schedule ?? "",
    ];
  });
  const csv = [columns, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `teacher-loads-${(state.settings.schoolYear || "school-year").replaceAll(/[^a-z0-9-]/gi, "-")}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(state.loads.length ? "Teaching-load CSV exported." : "CSV template exported. Add assignments to include records.");
}

function openSettingsDialog() {
  if (!isAdminAccount()) {
    showToast("Only the admin can manage school settings.", "error");
    return;
  }
  document.querySelector("#setting-school").value = state.settings.schoolName ?? "";
  document.querySelector("#setting-school-address").value = state.settings.schoolAddress ?? "";
  document.querySelector("#setting-school-id").value = state.settings.schoolId ?? "";
  document.querySelector("#setting-year").value = state.settings.schoolYear ?? "";
  document.querySelector("#setting-principal-name").value = state.settings.principalName ?? "";
  document.querySelector("#setting-principal-designation").value = state.settings.principalDesignation ?? "";
  document.querySelector("#setting-school-logo").value = "";
  document.querySelector("#setting-remove-school-logo").checked = false;
  if (schoolLogoPreviewUrl) URL.revokeObjectURL(schoolLogoPreviewUrl);
  schoolLogoPreviewUrl = "";
  updateSchoolLogoPreview(state.settings.schoolLogo ?? "");
  document.querySelector("#setting-auto-record").checked = Boolean(state.settings.autoRecordPeriods);
  const groupNames = state.settings.groupNames ?? DEFAULT_SETTINGS.groupNames;
  state.settingsDraftGroupPeriodTimes = createGroupPeriodTimes(
    groupNames,
    state.settings.groupPeriodTimes ?? {},
    state.settings.periodTimes ?? DEFAULT_PERIOD_TIMES,
  );
  renderGroupNameOptions(groupNames);
  renderPeriodGroupOptions(groupNames, groupNames[0]);
  renderPeriodTimeInputs(groupNames[0]);
  elements.settingsDialog.showModal();
}

let schoolLogoPreviewUrl = "";

function updateSchoolLogoPreview(source) {
  const preview = document.querySelector("#setting-school-logo-preview");
  const removeButton = document.querySelector("#remove-school-logo");
  preview.src = source || "";
  preview.hidden = !source;
  removeButton.hidden = !source;
}

function validateSchoolLogoFile(file) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    showToast("Choose a PNG, JPG, WebP, or GIF image for the school logo.", "error");
    return false;
  }
  if (file.size > 1024 * 1024) {
    showToast("The school logo must be 1 MB or smaller.", "error");
    return false;
  }
  return true;
}

function readSchoolLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The selected school logo could not be read."));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("The selected school logo could not be read.")));
    reader.readAsDataURL(file);
  });
}

function renderGroupNameOptions(groupNames, selectedGroup = "") {
  const select = document.querySelector("#setting-group-names");
  select.replaceChildren();
  groupNames.forEach((groupName) => select.add(new Option(groupName, groupName)));
  if (selectedGroup && groupNames.includes(selectedGroup)) select.value = selectedGroup;
  document.querySelector("#remove-group-name").disabled = groupNames.length <= 1;
}

function capturePeriodTimeInputs(groupName) {
  if (!groupName || !state.settingsDraftGroupPeriodTimes) return;
  state.settingsDraftGroupPeriodTimes[groupName] ??= createGroupPeriodTimes([groupName])[groupName];
  for (let period = 1; period <= 7; period += 1) {
    state.settingsDraftGroupPeriodTimes[groupName][String(period)] = {
      start: document.querySelector(`[data-period-start="${period}"]`).value,
      end: document.querySelector(`[data-period-end="${period}"]`).value,
    };
  }
}

function renderPeriodGroupOptions(groupNames, selectedGroup = "") {
  const select = document.querySelector("#setting-period-group");
  select.replaceChildren();
  groupNames.forEach((groupName) => select.add(new Option(groupName, groupName)));
  if (selectedGroup && groupNames.includes(selectedGroup)) select.value = selectedGroup;
  state.settingsPeriodGroup = select.value;
  if (select.value) renderPeriodTimeInputs(select.value);
}

function renderPeriodTimeInputs(groupName) {
  const timesByPeriod = state.settingsDraftGroupPeriodTimes?.[groupName] ?? {};
  for (let period = 1; period <= 7; period += 1) {
    const times = timesByPeriod[String(period)] ?? { start: "", end: "" };
    document.querySelector(`[data-period-start="${period}"]`).value = times.start ?? "";
    document.querySelector(`[data-period-end="${period}"]`).value = times.end ?? "";
  }
}

function addGroupName() {
  if (!isAdminAccount()) {
    showToast("Only the admin can manage groups and periods.", "error");
    return;
  }
  const input = document.querySelector("#new-group-name");
  const groupName = input.value.trim();
  if (!groupName) {
    showToast("Enter a group name to add.", "error");
    input.focus();
    return;
  }
  const groupNames = [...document.querySelector("#setting-group-names").options].map((option) => option.value);
  const existingGroup = groupNames.find((name) => name.toLocaleLowerCase() === groupName.toLocaleLowerCase());
  if (existingGroup) {
    document.querySelector("#setting-group-names").value = existingGroup;
    capturePeriodTimeInputs(document.querySelector("#setting-period-group").value);
    renderPeriodGroupOptions(
      groupNames,
      existingGroup,
    );
    input.value = "";
    showToast(`${existingGroup} is already in your group list. It is selected in Available groups.`);
    return;
  }
  capturePeriodTimeInputs(document.querySelector("#setting-period-group").value);
  groupNames.push(groupName);
  state.settingsDraftGroupPeriodTimes[groupName] = createGroupPeriodTimes([groupName])[groupName];
  renderGroupNameOptions(groupNames, groupName);
  renderPeriodGroupOptions(groupNames, groupName);
  input.value = "";
}

function removeGroupName() {
  if (!isAdminAccount()) {
    showToast("Only the admin can manage groups and periods.", "error");
    return;
  }
  const select = document.querySelector("#setting-group-names");
  const groupNames = [...select.options].map((option) => option.value);
  if (groupNames.length <= 1) {
    showToast("Keep at least one group name.", "error");
    return;
  }
  capturePeriodTimeInputs(document.querySelector("#setting-period-group").value);
  const removedName = select.value;
  const remainingNames = groupNames.filter((name) => name !== removedName);
  renderGroupNameOptions(remainingNames, remainingNames[0]);
  renderPeriodGroupOptions(remainingNames, remainingNames[0]);
}

async function saveSettings(event) {
  event.preventDefault();
  if (!isAdminAccount()) {
    showToast("Only the admin can manage school settings.", "error");
    return;
  }
  const form = new FormData(event.currentTarget);
  const logoFile = document.querySelector("#setting-school-logo").files[0];
  let schoolLogo = state.settings.schoolLogo ?? "";
  if (logoFile) {
    if (!validateSchoolLogoFile(logoFile)) return;
    try {
      schoolLogo = await readSchoolLogo(logoFile);
    } catch (error) {
      showToast(`Couldn't read the school logo: ${error.message}`, "error");
      return;
    }
  } else if (document.querySelector("#setting-remove-school-logo").checked) {
    schoolLogo = "";
  }
  const groupNames = [...document.querySelector("#setting-group-names").options].map((option) => option.value);
  if (!groupNames.length) {
    showToast("Enter at least one group name.", "error");
    document.querySelector("#setting-group-names").focus();
    return;
  }
  capturePeriodTimeInputs(document.querySelector("#setting-period-group").value);
  const groupPeriodTimes = createGroupPeriodTimes(
    groupNames,
    state.settingsDraftGroupPeriodTimes ?? {},
    DEFAULT_PERIOD_TIMES,
  );
  const previous = state.settings;
  for (const groupName of groupNames) {
    for (let period = 1; period <= 7; period += 1) {
      const periodKey = String(period);
      const times = groupPeriodTimes[groupName][periodKey];
      const previousTimes = previous.groupPeriodTimes?.[groupName]?.[periodKey]
        ?? previous.periodTimes?.[periodKey]
        ?? DEFAULT_PERIOD_TIMES[periodKey];
      if (times.start === previousTimes.start && times.end === previousTimes.end) continue;
      if (Boolean(times.start) !== Boolean(times.end)) {
        showToast(`Enter both a start and end time for ${groupName}, Period ${period}, or leave both blank.`, "error");
        document.querySelector("#setting-period-group").value = groupName;
        state.settingsPeriodGroup = groupName;
        renderPeriodTimeInputs(groupName);
        document.querySelector(`[data-period-${times.start ? "end" : "start"}="${period}"]`).focus();
        return;
      }
      if (times.start && times.start >= times.end) {
        showToast(`${groupName}, Period ${period}: end time must be later than start time.`, "error");
        document.querySelector("#setting-period-group").value = groupName;
        state.settingsPeriodGroup = groupName;
        renderPeriodTimeInputs(groupName);
        document.querySelector(`[data-period-end="${period}"]`).focus();
        return;
      }
    }
  }
  state.settings = {
    ...previous,
    schoolName: String(form.get("schoolName") ?? "").trim() || DEFAULT_SETTINGS.schoolName,
    schoolYear: String(form.get("schoolYear") ?? "").trim() || DEFAULT_SETTINGS.schoolYear,
    schoolAddress: String(form.get("schoolAddress") ?? "").trim(),
    schoolId: String(form.get("schoolId") ?? "").trim(),
    principalName: String(form.get("principalName") ?? "").trim(),
    principalDesignation: String(form.get("principalDesignation") ?? "").trim(),
    schoolLogo,
    groupNames,
    autoRecordPeriods: document.querySelector("#setting-auto-record").checked,
    periodTimes: previous.periodTimes ?? DEFAULT_PERIOD_TIMES,
    groupPeriodTimes,
  };
  if (!(await saveState())) {
    state.settings = previous;
    return;
  }
  elements.settingsDialog.close();
  state.settingsDraftGroupPeriodTimes = null;
  state.settingsPeriodGroup = "";
  render();
  showToast("School branding, group names, and period times updated.");
}

function closeSidebar() {
  document.querySelector("#sidebar").classList.remove("is-open");
  document.querySelector("#sidebar-scrim").classList.remove("is-visible");
}

async function enterApplication(profile, errorElement) {
  if (profile.mustChangePassword) {
    document.querySelector("#login-form").hidden = true;
    document.querySelector("#registration-form").hidden = true;
    document.querySelector("#initial-password-form").hidden = false;
    document.querySelector("#initial-password-error").hidden = true;
    document.querySelector("#login-screen").hidden = false;
    document.querySelector("#app-shell").hidden = true;
    document.querySelector("#initial-new-password").focus();
    return true;
  }
  document.querySelector("#initial-password-form").hidden = true;
  state.currentAccount = {
    id: profile.id,
    email: profile.email,
    username: profile.username,
    role: profile.role,
    teacherId: profile.teacherId,
  };
  if (!appInitialized) {
    if (!initializeApp()) return false;
    appInitialized = true;
  }
  try {
    await loadCloudState();
  } catch (loadError) {
    state.currentAccount = null;
    displayLoginError(errorElement, `Couldn't load shared school records: ${loadError.message}`);
    try {
      await apiRequest("logout", {});
    } catch (logoutError) {
      displayLoginError(errorElement, `Couldn't load shared school records: ${loadError.message}. Sign-out also failed: ${logoutError.message}`);
    }
    return false;
  }
  state.activeView = "overview";
  render();
  switchView("overview");
  document.querySelector("#login-screen").hidden = true;
  document.querySelector("#app-shell").hidden = false;
  return true;
}

function setLoginMode(registering) {
  document.querySelector("#login-form").hidden = registering;
  document.querySelector("#registration-form").hidden = !registering;
  document.querySelector("#initial-password-form").hidden = true;
  document.querySelector("#login-error").hidden = true;
  document.querySelector("#registration-error").hidden = true;
  document.querySelector(registering ? "#registration-name" : "#login-email").focus();
}

async function changeInitialPassword(event) {
  event.preventDefault();
  const errorElement = document.querySelector("#initial-password-error");
  const password = document.querySelector("#initial-new-password").value;
  if (password.length < 12) {
    displayLoginError(errorElement, "Choose a password with at least 12 characters.");
    return;
  }
  if (password !== document.querySelector("#initial-confirm-password").value) {
    displayLoginError(errorElement, "The passwords do not match.");
    document.querySelector("#initial-confirm-password").focus();
    return;
  }
  try {
    const result = await apiRequest("change-password", { password });
    document.querySelector("#initial-password-form").reset();
    if (!(await enterApplication(result.profile, errorElement))) return;
  } catch (error) {
    displayLoginError(errorElement, `Couldn't update your password: ${error.message}`);
  }
}

function displayLoginError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

async function createTeacherAccount(event) {
  event.preventDefault();
  const errorElement = document.querySelector("#registration-error");
  const username = document.querySelector("#registration-username").value.trim();
  const email = document.querySelector("#registration-email").value.trim().toLocaleLowerCase();
  const password = document.querySelector("#registration-password").value;
  const confirmPassword = document.querySelector("#registration-confirm-password").value;
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    displayLoginError(errorElement, "Use 3–40 letters, numbers, periods, underscores, or hyphens for the username.");
    return;
  }
  if (!email) {
    displayLoginError(errorElement, "Enter a valid email address.");
    document.querySelector("#registration-email").focus();
    return;
  }
  if (password.length < 8) {
    displayLoginError(errorElement, "Choose a password with at least 8 characters.");
    return;
  }
  if (password !== confirmPassword) {
    displayLoginError(errorElement, "The passwords do not match.");
    document.querySelector("#registration-confirm-password").focus();
    return;
  }

  const fullName = document.querySelector("#registration-name").value.trim();
  if (!fullName) {
    displayLoginError(errorElement, "Enter your full name.");
    document.querySelector("#registration-name").focus();
    return;
  }
  try {
    const result = await apiRequest("register", {
      username: username.toLocaleLowerCase(),
      email,
      password,
      fullName,
      employeeId: document.querySelector("#registration-employee-id").value.trim(),
      position: document.querySelector("#registration-position").value.trim(),
    });
    document.querySelector("#registration-form").reset();
    await enterApplication(result.profile, errorElement);
  } catch (error) {
    displayLoginError(errorElement, `Couldn't create the account: ${error.message}`);
  }
}

function initialize() {
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const registrationForm = document.querySelector("#registration-form");
  const registrationError = document.querySelector("#registration-error");
  const initialPasswordForm = document.querySelector("#initial-password-form");
  const initialPasswordError = document.querySelector("#initial-password-error");
  window.addEventListener("focus", refreshCloudState);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCloudState();
  });
  cloudRefreshTimer = window.setInterval(() => {
    if (!document.hidden) refreshCloudState();
  }, 30000);
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const identifier = document.querySelector("#login-email").value.trim();
    const password = document.querySelector("#login-password").value;
    try {
      const result = await apiRequest("login", { identifier, password });
      loginError.hidden = true;
      await enterApplication(result.profile, loginError);
    } catch (error) {
      displayLoginError(loginError, `Couldn't sign in: ${error.message}`);
      document.querySelector("#login-password").value = "";
      document.querySelector("#login-password").focus();
    }
  });
  registrationForm.addEventListener("submit", async (event) => {
    registrationError.hidden = true;
    await createTeacherAccount(event);
  });
  initialPasswordForm.addEventListener("submit", changeInitialPassword);
  document.querySelector("#initial-password-signout").addEventListener("click", async () => {
    try {
      await apiRequest("logout", {});
    } catch (error) {
      displayLoginError(initialPasswordError, `Couldn't sign out: ${error.message}`);
      return;
    }
    initialPasswordForm.reset();
    document.querySelector("#initial-password-form").hidden = true;
    document.querySelector("#login-screen").hidden = false;
    setLoginMode(false);
  });
  document.querySelector("#show-registration").addEventListener("click", () => setLoginMode(true));
  document.querySelector("#show-login").addEventListener("click", () => setLoginMode(false));
  document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
      await apiRequest("logout", {});
    } catch (error) {
      showToast(`Couldn't sign out: ${error.message}`, "error");
      return;
    }
    closeSidebar();
    window.clearInterval(cloudRefreshTimer);
    cloudRefreshTimer = 0;
    document.querySelector("#app-shell").hidden = true;
    document.querySelector("#login-screen").hidden = false;
    state.currentAccount = null;
    document.querySelector("#login-form").reset();
    document.querySelector("#registration-form").reset();
    initialPasswordForm.reset();
    document.querySelector("#login-error").hidden = true;
    registrationError.hidden = true;
    initialPasswordError.hidden = true;
    setLoginMode(false);
  });

  apiRequest("session").then((result) => {
    csrfToken = result.csrfToken ?? "";
    if (result.profile) return enterApplication(result.profile, loginError);
    return undefined;
  }).catch((error) => {
    displayLoginError(loginError, `Couldn't connect to the XAMPP database service: ${error.message}`);
  });
}

function initializeApp() {
  elements.navLinks.forEach((link) => {
    if (link.dataset.view) link.addEventListener("click", () => switchView(link.dataset.view));
  });
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.go)));
  document.querySelectorAll("[data-add-teacher]").forEach((button) => button.addEventListener("click", () => openTeacherDialog()));
  document.querySelectorAll("[data-add-load]").forEach((button) => button.addEventListener("click", () => openLoadDialog()));
  document.querySelector("#add-teacher").addEventListener("click", () => openTeacherDialog());
  document.querySelector("#add-load").addEventListener("click", () => openLoadDialog());
  document.querySelector("#quick-add-load").addEventListener("click", () => openLoadDialog());
  document.querySelector("#sidebar-export").addEventListener("click", exportCsv);
  document.querySelector("#export-loads").addEventListener("click", exportCsv);
  document.querySelector("#print-overview").addEventListener("click", () => window.print());
  document.querySelector("#open-settings").addEventListener("click", openSettingsDialog);
  document.querySelector("#sidebar-open-settings").addEventListener("click", openSettingsDialog);
  document.querySelector("#setting-school-logo").addEventListener("change", (event) => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    if (!validateSchoolLogoFile(file)) {
      event.currentTarget.value = "";
      return;
    }
    document.querySelector("#setting-remove-school-logo").checked = false;
    if (schoolLogoPreviewUrl) URL.revokeObjectURL(schoolLogoPreviewUrl);
    schoolLogoPreviewUrl = URL.createObjectURL(file);
    updateSchoolLogoPreview(schoolLogoPreviewUrl);
  });
  document.querySelector("#import-legacy-records").addEventListener("click", importLegacyRecords);
  document.querySelector("#remove-school-logo").addEventListener("click", () => {
    document.querySelector("#setting-school-logo").value = "";
    document.querySelector("#setting-remove-school-logo").checked = true;
    if (schoolLogoPreviewUrl) URL.revokeObjectURL(schoolLogoPreviewUrl);
    schoolLogoPreviewUrl = "";
    updateSchoolLogoPreview("");
  });
  document.querySelector("#add-substitution-plan").addEventListener("click", () => openSubstitutionDialog());
  document.querySelector("#apply-for-leave").addEventListener("click", openLeaveApplicationDialog);
  document.querySelector("#leave-application-form").addEventListener("submit", saveLeaveApplication);
  document.querySelector("#leave-application-start-date").addEventListener("change", (event) => {
    document.querySelector("#leave-application-end-date").min = event.currentTarget.value;
  });
  document.querySelector("#manage-leave-teachers")?.addEventListener("click", () => {
    document.querySelector("#substitution-dialog").close();
    switchView("teachers");
  });
  document.querySelectorAll("[data-add-substitution-plan]").forEach((button) =>
    button.addEventListener("click", () => openSubstitutionDialog()));
  const refreshSubstitutionLoads = () => populateSubstitutionLoads(
    document.querySelector("#substitution-leave-teacher").value,
    document.querySelector("#substitution-cover-teacher").value,
    document.querySelector("#substitution-start-date").value,
    document.querySelector("#substitution-end-date").value,
  );
  const refreshSubstitutionAvailability = () => {
    const leaveTeacherId = document.querySelector("#substitution-leave-teacher").value;
    const startDate = document.querySelector("#substitution-start-date").value;
    const endDate = document.querySelector("#substitution-end-date").value;
    populateSubstitutionTeachers(leaveTeacherId, startDate, endDate);
    refreshSubstitutionLoads();
  };
  document.querySelector("#substitution-leave-teacher").addEventListener("change", refreshSubstitutionAvailability);
  document.querySelector("#substitution-cover-teacher").addEventListener("change", refreshSubstitutionLoads);
  document.querySelector("#substitution-start-date").addEventListener("change", (event) => {
    document.querySelector("#substitution-end-date").min = event.currentTarget.value;
    refreshSubstitutionAvailability();
  });
  document.querySelector("#substitution-end-date").addEventListener("change", refreshSubstitutionAvailability);
  document.querySelector("#substitution-group-filter").addEventListener("change", refreshSubstitutionAvailability);
  document.querySelector("#substitution-period-filter").addEventListener("change", refreshSubstitutionAvailability);
  document.querySelector("#substitution-load-options").addEventListener("change", (event) => {
    if (event.target.matches('input[name="loadIds"]')) refreshSubstitutionAvailability();
  });
  document.querySelector("#substitution-form").addEventListener("submit", saveSubstitutionPlan);
  document.querySelector("#print-substitution-plan").addEventListener("click", printSubstitutionPlan);
  document.querySelector("#add-group-name").addEventListener("click", addGroupName);
  document.querySelector("#new-group-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addGroupName();
    }
  });
  document.querySelector("#remove-group-name").addEventListener("click", removeGroupName);
  document.querySelector("#setting-group-names").addEventListener("change", (event) => {
    const groupNames = [...event.currentTarget.options].map((option) => option.value);
    const selectedGroup = event.currentTarget.value;
    capturePeriodTimeInputs(document.querySelector("#setting-period-group").value);
    renderPeriodGroupOptions(groupNames, selectedGroup);
  });
  document.querySelector("#setting-period-group").addEventListener("change", (event) => {
    capturePeriodTimeInputs(state.settingsPeriodGroup);
    state.settingsPeriodGroup = event.currentTarget.value;
    renderPeriodTimeInputs(event.currentTarget.value);
  });
  document.querySelector("#open-groups-periods").addEventListener("click", () => {
    closeSidebar();
    openSettingsDialog();
  });
  document.querySelector("#teacher-form").addEventListener("submit", saveTeacher);
  document.querySelector("#teacher-password-form").addEventListener("submit", resetTeacherPassword);
  document.querySelector("#load-form").addEventListener("submit", saveLoad);
  document.querySelector("#preview-teacher-load").addEventListener("click", previewTeacherLoads);
  document.querySelector("#load-group-name").addEventListener("change", (event) => {
    renderLoadScheduleOptions({
      period: document.querySelector("#load-period").value,
      selectedGroup: event.currentTarget.value,
    });
  });
  document.querySelector("#load-period").addEventListener("change", (event) => {
    renderLoadScheduleOptions({
      period: event.currentTarget.value,
      selectedGroup: document.querySelector("#load-group-name").value,
    });
  });
  document.querySelector("#load-schedule").addEventListener("change", (event) => {
    const selectedOption = event.currentTarget.selectedOptions[0];
    if (selectedOption?.dataset.groupName) {
      document.querySelector("#load-group-name").value = selectedOption.dataset.groupName;
      document.querySelector("#load-period").value = selectedOption.dataset.period;
      const isNewAutoRecordedLoad = !document.querySelector("#load-id").value && state.settings.autoRecordPeriods;
      if (isNewAutoRecordedLoad) {
        state.singleLoadFromAutoMode = true;
        document.querySelector("#auto-generate-card").hidden = true;
        document.querySelector("#single-assignment-fields").hidden = false;
        document.querySelector("#load-group-name").required = true;
        document.querySelector("#load-period").required = true;
      }
    } else if (!document.querySelector("#load-id").value && state.settings.autoRecordPeriods) {
      state.singleLoadFromAutoMode = false;
      document.querySelector("#auto-generate-card").hidden = false;
      document.querySelector("#single-assignment-fields").hidden = true;
      document.querySelector("#load-group-name").required = false;
      document.querySelector("#load-period").required = false;
    }
  });
  document.querySelector("#settings-form").addEventListener("submit", saveSettings);
  document.querySelector("#teacher-search").addEventListener("input", (event) => {
    state.teacherQuery = event.currentTarget.value;
    renderTeachers();
  });
  document.querySelector("#load-search").addEventListener("input", (event) => {
    state.loadQuery = event.currentTarget.value;
    renderLoads();
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  document.querySelector("#mobile-menu").addEventListener("click", () => {
    document.querySelector("#sidebar").classList.add("is-open");
    document.querySelector("#sidebar-scrim").classList.add("is-visible");
  });
  document.querySelector("#sidebar-scrim").addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
  return true;
}

initialize();
