'use strict';

// The blocklist: user IDs of known members of a blocked server (like a rival scam server). Anyone on it is restricted
// ("Please make a ticket") — straight away if they're already here, or the moment they join. Their appeal ticket asks
// them to leave that server. Staff and trusted users are never restricted (the owner is told instead).

const store = require('./store');
const blockedServers = require('./blockedServers');

const list = (settings) => (settings.blocklist ??= {}); // userId -> { at, by }

/** IDs in pasted text or a file: any format ("1. 1547…", commas, new lines). List numbers are too short to count. */
function parseIds(text) {
  return [...new Set(String(text ?? '').match(/\b\d{17,20}\b/g) ?? [])];
}

const isListed = (guild, userId) => Boolean(list(store.guild(guild.id))[userId]);

/** Adds IDs. Returns how many were new. */
function add(guild, ids, by) {
  const entries = list(store.guild(guild.id));
  let added = 0;
  for (const id of ids) {
    if (entries[id]) continue;
    entries[id] = { at: Date.now(), by };
    added++;
  }
  store.save();
  return added;
}

/** Takes IDs off. Restricted people stay restricted (a mod unrestricts them). Returns how many were removed. */
function remove(guild, ids) {
  const entries = list(store.guild(guild.id));
  let removed = 0;
  for (const id of ids) {
    if (!entries[id]) continue;
    delete entries[id];
    removed++;
  }
  store.save();
  return removed;
}

// So their appeal ticket shows the blocked server's name and icon.
const blockedServerIds = (guild) => Object.keys(blockedServers.blockedList(store.guild(guild.id)));

/** Restricts one member if they're on the list. Returns the result, or null if they're not on it / already restricted. */
async function checkMember(member) {
  if (!member || member.user?.bot || !isListed(member.guild, member.id)) return null;
  if (store.guild(member.guild.id).restricted[member.id]) return null;
  return blockedServers.restrictAssociated(member, 'on the **blocklist** (a known member of a blocked server)', blockedServerIds(member.guild));
}

/**
 * Restricts everyone on the list who's in the server now. `onProgress` is told every 10 people.
 * Returns { here, restricted, skipped }.
 */
async function sweep(guild, { onProgress = null } = {}) {
  const settings = store.guild(guild.id);
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const here = Object.keys(list(settings)).filter((id) => members.has(id) && !settings.restricted[id]);
  const result = { here: here.length, restricted: 0, skipped: 0 };
  for (const id of here) {
    const outcome = await checkMember(members.get(id));
    if (outcome?.ok) result.restricted++;
    else result.skipped++;
    if (onProgress && (result.restricted + result.skipped) % 10 === 0) await onProgress(result).catch(() => {});
  }
  return result;
}

/** Totals for /blocklist list. */
async function summary(guild) {
  const settings = store.guild(guild.id);
  const ids = Object.keys(list(settings));
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  return {
    ids,
    total: ids.length,
    here: ids.filter((id) => members.has(id)).length,
    restricted: ids.filter((id) => settings.restricted[id]).length,
  };
}

module.exports = { parseIds, isListed, add, remove, checkMember, sweep, summary };
