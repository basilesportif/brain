// @ts-nocheck
import * as crypto from "node:crypto";
import { createStateStore } from "./state-stores.js";

const SCHEMA_VERSION = 1;

const DAYS_OF_WEEK = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Tolerance window in minutes — if the check runs a bit late, still fire. */
const TOLERANCE_MINUTES = 15;

function generateId() {
  return `rm_${crypto.randomBytes(8).toString("hex")}`;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    reminders: [],
  };
}

function getReminderStore(options = {}) {
  return createStateStore("reminders", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next =
        store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.reminders)) next.reminders = [];
      return next;
    },
  });
}

function loadStore(options = {}) {
  return getReminderStore(options).load();
}

function saveStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getReminderStore(options).save(store);
}

function addReminder(title, schedule, options = {}) {
  const normalizedTitle = (title || "").trim();
  if (!normalizedTitle) throw new Error("Title is required");
  return getReminderStore(options).transaction((store) => {
    const now = new Date().toISOString();
    const reminder = {
      id: generateId(),
      title: normalizedTitle,
      schedule,
      enabled: true,
      lastTriggeredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.reminders.push(reminder);
    store.updatedAt = now;
    return reminder;
  });
}

function updateReminder(id, fields, options = {}) {
  return getReminderStore(options).transaction((store, tx) => {
    const reminder = store.reminders.find((r) => r.id === id);
    if (!reminder) {
      tx.skipSave();
      return { found: false };
    }
    const allowed = ["title", "schedule", "enabled"];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        reminder[key] = fields[key];
      }
    }
    const now = new Date().toISOString();
    reminder.updatedAt = now;
    store.updatedAt = now;
    return { found: true, reminder };
  });
}

function removeReminder(id, options = {}) {
  return getReminderStore(options).transaction((store, tx) => {
    const index = store.reminders.findIndex((r) => r.id === id);
    if (index === -1) {
      tx.skipSave();
      return { found: false };
    }
    const [removed] = store.reminders.splice(index, 1);
    store.updatedAt = new Date().toISOString();
    return { found: true, deleted: { id: removed.id, title: removed.title } };
  });
}

function removeReminderByTitle(titleQuery, options = {}) {
  return getReminderStore(options).transaction((store, tx) => {
    const lowerQuery = titleQuery.toLowerCase();
    const matches = store.reminders.filter((r) =>
      r.title.toLowerCase().includes(lowerQuery)
    );
    if (matches.length === 0) {
      tx.skipSave();
      return { found: false, matches: [] };
    }
    if (matches.length > 1) {
      tx.skipSave();
      return { found: false, ambiguous: true, matches };
    }
    const target = matches[0];
    const index = store.reminders.findIndex((r) => r.id === target.id);
    store.reminders.splice(index, 1);
    store.updatedAt = new Date().toISOString();
    return { found: true, deleted: { id: target.id, title: target.title } };
  });
}

function listReminders({ enabled, query } = {}, options = {}) {
  const store = loadStore(options);
  let reminders = store.reminders;
  if (enabled !== undefined) {
    reminders = reminders.filter((r) => r.enabled === enabled);
  }
  if (query) {
    const lowerQuery = query.toLowerCase();
    reminders = reminders.filter((r) =>
      r.title.toLowerCase().includes(lowerQuery)
    );
  }
  return reminders;
}

/**
 * Get current time in a given timezone as {hour, minute, dayOfWeek, dateObj}.
 */
function getTimeInTz(tz) {
  const now = new Date();
  // Use Intl to get components in the target timezone
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    weekday: "long",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => {
    const p = parts.find((p) => p.type === type);
    return p ? p.value : null;
  };
  return {
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    dayOfWeek: (get("weekday") || "").toLowerCase(),
    now,
  };
}

/**
 * Parse "HH:MM" string to {hour, minute}.
 */
function parseTime(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return { hour: h, minute: m };
}

/**
 * Get the scheduled Date for today (or a specific day) in the given timezone.
 * Returns a Date object representing when the reminder should fire.
 */
function getScheduledDateForToday(timeStr, tz) {
  const { hour, minute } = parseTime(timeStr);
  // Build a date string for today in the target timezone
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  // Create a date at the scheduled time in the target timezone
  // Use a temporary approach: find offset and compute
  const scheduled = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
  // Get the timezone offset for this date
  const utcStr = scheduled.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = scheduled.toLocaleString("en-US", { timeZone: tz });
  // This is approximate but works for isDue checks
  return { dateStr, hour, minute };
}

/**
 * Check if a reminder is due now.
 * Returns true if the reminder should fire.
 */
function isDue(reminder) {
  if (!reminder.enabled) return false;
  const schedule = reminder.schedule;
  const tz = schedule.timezone || "America/New_York";
  const now = new Date();

  if (schedule.type === "once") {
    const targetTime = new Date(schedule.datetime);
    if (now < targetTime) return false;
    // Check if already triggered
    if (reminder.lastTriggeredAt) return false;
    // Within tolerance window (don't fire if it's way past)
    const diffMs = now - targetTime;
    const diffMin = diffMs / 60000;
    if (diffMin > TOLERANCE_MINUTES * 4) return false; // 1 hour max for one-time
    return true;
  }

  if (schedule.type === "daily" || schedule.type === "weekly") {
    const tzInfo = getTimeInTz(tz);
    const { hour: schedH, minute: schedM } = parseTime(schedule.time);

    // For weekly, check day
    if (schedule.type === "weekly") {
      const schedDay = schedule.day.toLowerCase();
      if (tzInfo.dayOfWeek !== schedDay) return false;
    }

    // Current time in minutes since midnight
    const currentMinutes = tzInfo.hour * 60 + tzInfo.minute;
    const schedMinutes = schedH * 60 + schedM;

    // Must be at or past scheduled time, within tolerance
    if (currentMinutes < schedMinutes) return false;
    if (currentMinutes > schedMinutes + TOLERANCE_MINUTES) return false;

    // Check lastTriggeredAt — must not have been triggered in this window
    if (reminder.lastTriggeredAt) {
      const lastTriggered = new Date(reminder.lastTriggeredAt);
      // Get today's date string in the timezone
      const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
      const lastTriggeredDayStr = lastTriggered.toLocaleDateString("en-CA", {
        timeZone: tz,
      });
      if (todayStr === lastTriggeredDayStr) return false; // Already triggered today
    }

    return true;
  }

  if (schedule.type === "cron") {
    return isCronDue(schedule.expression, reminder.lastTriggeredAt, tz);
  }

  return false;
}

/**
 * Simple cron matcher for "min hour dom month dow" format.
 * Only handles: numbers, *, lists (1,3,5), ranges (1-5), and step (star/N).
 */
function isCronDue(expression, lastTriggeredAt, tz) {
  const tzInfo = getTimeInTz(tz);
  const now = new Date();

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;

  // Get current values in the timezone
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);

  const getNum = (type) => {
    const p = dateParts.find((p) => p.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };

  const currentMin = tzInfo.minute;
  const currentHour = tzInfo.hour;
  const currentDom = getNum("day");
  const currentMon = getNum("month");
  // JS: 0=Sunday. Cron: 0=Sunday too.
  const currentDow = DAYS_OF_WEEK.indexOf(tzInfo.dayOfWeek);

  if (!matchesCronField(minExpr, currentMin, 0, 59)) return false;
  if (!matchesCronField(hourExpr, currentHour, 0, 23)) return false;
  if (!matchesCronField(domExpr, currentDom, 1, 31)) return false;
  if (!matchesCronField(monExpr, currentMon, 1, 12)) return false;
  if (!matchesCronField(dowExpr, currentDow, 0, 6)) return false;

  // Check we haven't already triggered in this minute
  if (lastTriggeredAt) {
    const last = new Date(lastTriggeredAt);
    const diffMs = now - last;
    if (diffMs < 60000) return false; // Triggered less than a minute ago
  }

  return true;
}

function matchesCronField(expr, value, min, max) {
  // Handle comma-separated list
  if (expr.includes(",")) {
    return expr.split(",").some((part) => matchesCronField(part, value, min, max));
  }
  // Handle */N
  if (expr.startsWith("*/")) {
    const step = parseInt(expr.slice(2), 10);
    return value % step === 0;
  }
  // Handle *
  if (expr === "*") return true;
  // Handle range N-M
  if (expr.includes("-")) {
    const [start, end] = expr.split("-").map(Number);
    return value >= start && value <= end;
  }
  // Handle plain number
  return parseInt(expr, 10) === value;
}

function markTriggered(id, options = {}) {
  return getReminderStore(options).transaction((store, tx) => {
    const reminder = store.reminders.find((r) => r.id === id);
    if (!reminder) {
      tx.skipSave();
      return { found: false };
    }
    const now = new Date().toISOString();
    reminder.lastTriggeredAt = now;
    // Auto-disable one-time reminders
    if (reminder.schedule.type === "once") {
      reminder.enabled = false;
    }
    store.updatedAt = now;
    return { found: true, reminder };
  });
}

/**
 * Get a human-readable description of a schedule.
 */
function describeSchedule(schedule) {
  const tz = schedule.timezone || "America/New_York";
  const tzShort = tz.split("/").pop().replace(/_/g, " ");

  if (schedule.type === "daily") {
    return `daily at ${formatTime12h(schedule.time)} (${tzShort})`;
  }
  if (schedule.type === "weekly") {
    const day = schedule.day.charAt(0).toUpperCase() + schedule.day.slice(1);
    return `every ${day} at ${formatTime12h(schedule.time)} (${tzShort})`;
  }
  if (schedule.type === "once") {
    const d = new Date(schedule.datetime);
    return `once on ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}`;
  }
  if (schedule.type === "cron") {
    return `cron: ${schedule.expression}`;
  }
  return "unknown schedule";
}

function formatTime12h(timeStr) {
  const { hour, minute } = parseTime(timeStr);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export {
  getReminderStore,
  loadStore,
  saveStore,
  addReminder,
  updateReminder,
  removeReminder,
  removeReminderByTitle,
  listReminders,
  isDue,
  markTriggered,
  describeSchedule,

};
