'use strict';

// Saves per-server settings and moderation cases to data/database.json.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.OJ_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const MAX_CASES_PER_GUILD = 5000;

const FILTERS = ['slurs', 'selfPromo', 'spam', 'promptHelp', 'accusations', 'newAccounts', 'unverified'];

function freshGuild() {
  return {
    logChannelId: null,
    modRoleId: null,
    modules: { slurs: true, selfPromo: true, spam: true, promptHelp: true, accusations: true, newAccounts: true, unverified: true, antiNuke: true, nameWatch: true },
    exempt: Object.fromEntries(FILTERS.map((f) => [f, { channels: [], roles: [] }])),
    freeChannels: [], // channels O Jailbreak ignores completely
    customWords: [],
    disabledWords: [],
    trusted: [],
    autoroleId: null, // role given to everyone who joins
    vipRoleId: null, // role given for bringing people in with invite links
    vipJoinsNeeded: null, // how many joins that takes (null = the number in config.js), set with /vip goal
    vipReviewChannelId: null, // where VIP applications go for an admin to approve (null = the mod log)
    vipApplications: {}, // userId -> { status: eligible/pending/approved/denied, ... }
    welcomeChannelId: null, // where new members are welcomed
    levels: {
      enabled: true,
      announce: true,
      announceChannelId: null,
      xp: {}, // userId -> XP
      rewards: {}, // level -> roleId
      board: { channelId: null, messageId: null, title: null, colour: null, size: 10, showXp: true, updatedAt: 0 },
    },
    banList: { channelId: null, entries: {} }, // userId -> { messageId, unbanned }
    invites: { counts: {}, credited: {}, uncounted: {}, revoked: {}, joinedAt: {} }, // who brought each member in, which joins didn't count, joins staff took off
    verify: { enabled: false, startedAt: null, roleId: null, verifiedRoleId: null, channelId: null, messageId: null, verified: {}, pending: {}, requireAll: false, held: {} }, // new members verify first (everyone, with require-all); Verified unlocks the new section
    blockedServers: {}, // guildId -> { name, invites }: anyone showing they're part of one is restricted
    blockedNames: [], // names nobody can use (as well as config.js → blockedServers.names), added with /blockserver addname
    blocklist: {}, // userId -> { at, by }: known members of a blocked server, restricted when here or when they join
    newAccounts: { allowed: {}, requests: {} }, // new accounts an admin let chat early, and their requests
    giveaways: { nextId: 1, list: {} }, // giveawayId -> { prize, endsAt, winners, joinsNeeded, vipEntries, joins, ... }
    restrict: { roleId: null, channelId: null, messageId: null, categoryId: null, sweptAt: null },
    restricted: {}, // userId -> { by, reason, at, roles, caseId, ticketChannelId, lastAppealClosedAt }
    lockdown: {
      pausedUntil: null, // null = armed, -1 = paused until armed again, otherwise a timestamp
      active: false,
      reason: null,
      startedAt: null,
      lockedBy: null,
      snapshot: null, // every channel's permissions from before the lockdown
      alertChannelId: null,
      failed: [],
      dm: null,
    },
    updating: {
      active: false,
      channelId: null, // #server-updating, kept hidden between updates and reused
      startedAt: null,
      startedBy: null,
      saved: {}, // channelId -> the view settings it had before it was hidden: { everyone, roles, added }
      keepVisible: [], // channel IDs members can still see while updating (set with /server-updating keep-visible)
      roleId: null, // v1.8.0 gave everyone a role; cleaned up if it's still there
      stripped: {}, // v1.8.0's saved changes, also cleaned up
    },
    nextCaseId: 1,
    cases: {},
  };
}

let db = { version: 1, guilds: {} };
let saveTimer = null;
const checkedGuilds = new Set();

function load() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.guilds ??= {};
  } catch (err) {
    // Keep the unreadable file rather than silently overwriting someone's cases.
    const backup = `${DB_FILE}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(DB_FILE, backup);
    } catch {}
    console.error(`[store] Could not read the database (${err.message}). A copy was saved to ${backup}; starting fresh.`);
    db = { version: 1, guilds: {} };
  }
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const json = JSON.stringify(db, null, 2);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
  } catch {
    // Renaming can fail on Windows while antivirus or OneDrive has the file open.
    fs.writeFileSync(DB_FILE, json);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch (err) {
      console.error('[store] Failed to save:', err);
    }
  }, 500);
}

function fillDefaults(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) target[key] = structuredClone(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && key !== 'cases' && key !== 'restricted') fillDefaults(target[key], value);
  }
}

function guild(guildId) {
  let settings = db.guilds[guildId];
  if (!settings) {
    settings = db.guilds[guildId] = freshGuild();
    save();
  } else if (!checkedGuilds.has(guildId)) {
    // Older database files may be missing settings added in newer versions.
    fillDefaults(settings, freshGuild());
  }
  checkedGuilds.add(guildId);
  return settings;
}

function createCase(guildId, data) {
  const settings = guild(guildId);
  const id = settings.nextCaseId++;
  const record = { id, status: 'OPEN', createdAt: Date.now(), ...data };
  settings.cases[id] = record;

  const ids = Object.keys(settings.cases).map(Number).sort((a, b) => a - b);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_CASES_PER_GUILD))) delete settings.cases[old];

  save();
  return record;
}

function getCase(guildId, caseId) {
  return guild(guildId).cases[caseId] ?? null;
}

function updateCase(guildId, caseId, patch) {
  const record = getCase(guildId, caseId);
  if (!record) return null;
  Object.assign(record, patch);
  save();
  return record;
}

function casesForUser(guildId, userId) {
  return Object.values(guild(guildId).cases)
    .filter((c) => c.userId === userId)
    .sort((a, b) => b.id - a.id);
}

function isTrusted(guildObj, userId) {
  return userId === guildObj.ownerId || guild(guildObj.id).trusted.includes(userId);
}

load();

module.exports = { FILTERS, guild, save, flush, createCase, getCase, updateCase, casesForUser, isTrusted };
