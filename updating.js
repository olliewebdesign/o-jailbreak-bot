'use strict';

// Server updating mode: while the owner reworks the server, members can only see #server-updating and the channels
// on the keep-visible list. VIPs also keep their VIP channels, and staff keep everything.
//
// It works on channels, not people: each hidden channel gets "can't see" for @everyone and the member roles, in one
// change per channel, so it's quick however many members there are, and new joins are covered automatically.
// Only the view setting of those roles is saved and changed. Finishing puts back exactly those settings, so anything
// else the owner changed during the update stays.

const { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { exclusive, inBatches, truncate } = require('./util');

const REASON = 'O Jailbreak: server updating';
const VIEW = P.ViewChannel;

function options() {
  return {
    channelName: '🔧︱server-updating',
    startMessage: '🔧 **The server is being updated.** Everything else is hidden for a little while. Updates will be posted here.',
    memberRoleIds: [],
    vipRoleId: null,
    keepVisibleChannelIds: [],
    vipChannelIds: [],
    ...config.updating,
  };
}

function isActive(guild) {
  return Boolean(store.guild(guild.id).updating.active);
}

// ----- which roles and channels -----

// Roles regular members have: the ones in config.js, plus the auto-role.
function memberRoleIds(guild, settings) {
  return [...new Set([...options().memberRoleIds, settings.autoroleId])].filter((id) => id && guild.roles.cache.has(id));
}

// The VIP role: from config.js, or the one set with /vip set, or else the first role with "VIP" in its name.
function vipRoleId(guild, settings) {
  const role =
    guild.roles.cache.get(options().vipRoleId) ??
    guild.roles.cache.get(settings.vipRoleId) ??
    guild.roles.cache.find((r) => /vip/i.test(r.name) && !r.managed && r.id !== guild.id);
  return role?.id ?? null;
}

function modRoleId(guild, settings) {
  return settings.modRoleId && guild.roles.cache.has(settings.modRoleId) ? settings.modRoleId : null;
}

// Channels members can still see: the ones in config.js plus any added with /server-updating keep-visible.
function keptIds(settings) {
  return new Set([...options().keepVisibleChannelIds, ...settings.updating.keepVisible]);
}

// Left alone completely: the updates channel itself, and lockdown's alert channel.
function leaveAlone(channel, settings) {
  return channel.id === settings.updating.channelId || channel.id === settings.lockdown.alertChannelId;
}

// ----- one channel -----

// A channel's overwrites as plain data we can change and send back in one go. Roles that were just deleted are
// left out, because Discord refuses permissions for a role that doesn't exist.
function plain(channel) {
  const { guild } = channel;
  return new Map(
    channel.permissionOverwrites.cache
      .filter((o) => o.type !== OverwriteType.Role || guild.roles.cache.has(o.id))
      .map((o) => [o.id, { id: o.id, type: o.type, allow: BigInt(o.allow.bitfield), deny: BigInt(o.deny.bitfield) }]),
  );
}

function setView(list, id, value, type = OverwriteType.Role) {
  const o = list.get(id) ?? { id, type, allow: 0n, deny: 0n };
  o.allow &= ~VIEW;
  o.deny &= ~VIEW;
  if (value === 'allow') o.allow |= VIEW;
  if (value === 'deny') o.deny |= VIEW;
  list.set(id, o);
}

function viewIn(list, id) {
  const o = list.get(id);
  return !o ? 'none' : o.allow & VIEW ? 'allow' : o.deny & VIEW ? 'deny' : 'none';
}

async function save(channel, list, reason) {
  await channel.permissionOverwrites.set([...list.values()], reason);
}

/**
 * Hides one channel from members (or shows it again if it's kept visible). Returns a problem to report, or null.
 * Does nothing if the channel is already right, so it's safe to run on every channel change.
 */
async function hideChannel(guild, channel, settings = store.guild(guild.id)) {
  const up = settings.updating;
  if (!up.active || !channel.permissionOverwrites || channel.isThread?.() || leaveAlone(channel, settings)) return null;
  if (keptIds(settings).has(channel.id)) return restoreChannel(guild, channel, settings);

  const members = memberRoleIds(guild, settings);
  const saved = (up.saved[channel.id] ??= { everyone: null, roles: {}, added: [] });
  const list = plain(channel);
  const before = JSON.stringify([...list.values()], (k, v) => (typeof v === 'bigint' ? v.toString() : v));

  // Write down what the view settings were. A setting that isn't "can't see" was set by the owner (or is how it
  // was before), so that's what to go back to.
  const everyone = viewIn(list, guild.id);
  if (everyone !== 'deny' || saved.everyone === null) saved.everyone = everyone;
  for (const id of members) if (viewIn(list, id) === 'allow') saved.roles[id] = 'allow';
  const membersCouldSee = saved.everyone !== 'deny' || Object.keys(saved.roles).length > 0;

  // Hide it from everyone and the member roles.
  setView(list, guild.id, 'deny');
  for (const id of members) if (viewIn(list, id) === 'allow') setView(list, id, 'none');

  // Staff who only got in as members keep it; VIPs keep their VIP channels.
  const letIn = (roleId) => {
    if (!roleId || viewIn(list, roleId) === 'allow') return;
    setView(list, roleId, 'allow');
    if (!saved.added.includes(roleId)) saved.added.push(roleId);
  };
  if (membersCouldSee) letIn(modRoleId(guild, settings));
  if (options().vipChannelIds.includes(channel.id)) letIn(vipRoleId(guild, settings));

  const after = JSON.stringify([...list.values()], (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (after === before) return null;
  store.flush(); // written down before the change, so it can always be put back
  try {
    await save(channel, list, REASON);
    return null;
  } catch (err) {
    return `#${channel.name} (${err.message})`;
  }
}

/** Puts back the view settings hideChannel changed on this channel. Returns a problem to report, or null. */
async function restoreChannel(guild, channel, settings) {
  const up = settings.updating;
  const saved = up.saved[channel.id];
  if (!saved) return null;
  if (!channel.permissionOverwrites) {
    delete up.saved[channel.id];
    return null;
  }
  const list = plain(channel);
  if (saved.everyone !== null) setView(list, guild.id, saved.everyone);
  for (const [id, value] of Object.entries(saved.roles)) if (guild.roles.cache.has(id)) setView(list, id, value);
  for (const id of saved.added) if (list.has(id)) setView(list, id, 'none');
  // Overwrites left with nothing in them are removed, like Discord does when you clear one by hand.
  for (const [id, o] of list) if (!o.allow && !o.deny) list.delete(id);
  try {
    await save(channel, list, `${REASON} finished`);
    delete up.saved[channel.id];
    store.save();
    return null;
  } catch (err) {
    return `#${channel.name} (${err.message})`;
  }
}

// ----- the updates channel -----

function updatesChannelOverwrites(guild, settings) {
  const readOnly = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads];
  const list = [{ id: guild.id, type: OverwriteType.Role, allow: [VIEW, P.ReadMessageHistory], deny: readOnly }];
  const mod = modRoleId(guild, settings);
  if (mod) list.push({ id: mod, type: OverwriteType.Role, allow: [VIEW, P.ReadMessageHistory, P.SendMessages] });
  return list;
}

async function ensureChannel(guild, settings) {
  const up = settings.updating;
  const { channelName } = options();
  const existing = (up.channelId && guild.channels.cache.get(up.channelId)) || guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === channelName);
  const overwrites = updatesChannelOverwrites(guild, settings);
  if (!existing) {
    return guild.channels.create({ name: channelName, type: ChannelType.GuildText, position: 0, topic: 'Server updates while the server is being worked on.', permissionOverwrites: overwrites, reason: REASON });
  }
  await existing.permissionOverwrites.set(overwrites, REASON); // kept hidden since last time: open it up again
  return existing;
}

// ----- the older version gave everyone a role; clean that up if it's still around -----

async function removeOldRole(guild, up) {
  if (!up.roleId && !Object.keys(up.stripped ?? {}).length) return;
  for (const [channelId, entries] of Object.entries(up.stripped ?? {})) {
    const channel = guild.channels.cache.get(channelId);
    for (const { id, type, added } of entries) {
      if (!channel?.permissionOverwrites?.cache.has(id)) continue;
      await channel.permissionOverwrites.edit(id, { ViewChannel: added ? null : true }, { reason: REASON, type }).catch(() => {});
    }
  }
  up.stripped = {};
  const role = up.roleId && guild.roles.cache.get(up.roleId);
  if (role) await role.delete(`${REASON}: no longer needed`).catch((err) => console.warn(`[updating] Couldn't delete the old Updating role: ${err.message}`));
  up.roleId = null;
  store.save();
}

// ----- turning it on and off -----

async function modLog(guild, content) {
  const log = await fetchLogChannel(guild);
  await log?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

/** Turns updating mode on (or re-applies it if it's already on). */
async function start(guild, user, { quiet = false } = {}) {
  if (!guild.members.me?.permissions.has([P.ManageRoles, P.ManageChannels])) {
    return { ok: false, text: '❌ I need **Administrator** (or Manage Roles and Manage Channels) to do this. Server Settings → Roles → O Jailbreak.' };
  }
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const up = settings.updating;
    const already = up.active;
    await removeOldRole(guild, up);
    Object.assign(up, { active: true, startedAt: already ? up.startedAt : Date.now(), startedBy: already ? up.startedBy : user.id });
    store.flush();

    const channel = await ensureChannel(guild, settings);
    up.channelId = channel.id;
    store.save();
    if (!already) await channel.send({ embeds: [new EmbedBuilder().setColor(0x6b7280).setDescription(options().startMessage)] }).catch(() => {});

    const failed = [];
    await inBatches([...guild.channels.cache.values()], 5, async (ch) => {
      const problem = await hideChannel(guild, ch, settings);
      if (problem) failed.push(problem);
    });

    const seen = [channel, ...[...keptIds(settings)].filter((id) => guild.channels.cache.has(id)).map((id) => `<#${id}>`)].join(', ');
    const lines = [
      `🔧 **The server is ${already ? 'still' : 'now'} updating.** Members can only see ${seen}. Post your updates in ${channel}.`,
      'VIPs keep their VIP channels, new joins only see the same as members, and mods and admins can still see everything.',
    ];
    if (!memberRoleIds(guild, settings).length) lines.push('⚠️ No member roles found. Put their IDs in `memberRoleIds` in config.js, or members may still see channels.');
    if (failed.length) lines.push(`⚠️ Couldn’t hide: ${truncate(failed.join(', '), 800)}. Run \`/server-updating start\` again to retry.`);
    lines.push('When you’re done: `/server-updating finish`.');
    if (!quiet) await modLog(guild, `🔧 **Server updating mode is on** (by <@${user.id}>). Members can only see ${seen}.`);
    return { ok: !failed.length, text: lines.join('\n') };
  });
}

/** Turns updating mode off: every hidden channel goes back how it was. */
function finish(guild, user) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const up = settings.updating;
    if (!up.active) return { ok: false, text: 'ℹ️ The server isn’t in updating mode.' };
    up.active = false;
    store.flush();

    const failed = [];
    await inBatches(Object.keys(up.saved), 5, async (channelId) => {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return void delete up.saved[channelId]; // deleted during the update
      const problem = await restoreChannel(guild, channel, settings);
      if (problem) failed.push(problem);
    });
    await removeOldRole(guild, up);

    // Hide the updates channel from members again; it's reused next time.
    const updates = up.channelId && guild.channels.cache.get(up.channelId);
    await updates?.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: `${REASON} finished`, type: OverwriteType.Role }).catch(() => {});

    Object.assign(up, { startedAt: null, startedBy: null });
    store.save();
    const lines = ['✅ **The server is back.** Everyone can see the channels again.'];
    if (updates) lines.push(`${updates} is hidden again; I’ll reuse it next time.`);
    if (failed.length) lines.push(`⚠️ Couldn’t put back: ${truncate(failed.join(', '), 800)}. Run \`/server-updating finish\` again after \`/server-updating start\` to retry.`);
    await modLog(guild, `${lines[0]} (by <@${user.id}>)`);
    return { ok: !failed.length, text: lines.join('\n') };
  });
}

/**
 * Adds or removes a channel from the list members can still see while updating (applied straight away if
 * updating mode is on). A thread can't be shown on its own, so its channel is used instead.
 */
async function toggleKeepVisible(guild, picked) {
  const settings = store.guild(guild.id);
  const up = settings.updating;
  const channel = picked.isThread?.() ? picked.parent : picked;
  if (!channel?.permissionOverwrites) return { ok: false, text: '❌ That channel can’t be kept visible.' };
  if (options().keepVisibleChannelIds.includes(channel.id)) {
    return { ok: false, text: `ℹ️ ${channel} is always kept visible: it’s in \`keepVisibleChannelIds\` in config.js.` };
  }
  const i = up.keepVisible.indexOf(channel.id);
  const adding = i === -1;
  if (adding) up.keepVisible.push(channel.id);
  else up.keepVisible.splice(i, 1);
  store.save();

  const problem = await hideChannel(guild, channel, settings);
  const viaThread = channel !== picked ? ` (${picked} is a thread, so its channel ${channel} is what stays visible — with all its threads)` : '';
  const text = [
    adding ? `✅ Members will still see ${channel} while the server is updating${viaThread}.` : `✅ ${channel} will be hidden while the server is updating.`,
    up.active ? '(Applied now.)' : '',
    `**Kept visible:** ${[...keptIds(settings)].map((id) => `<#${id}>`).join(', ') || 'none'}`,
    problem ? `⚠️ Couldn’t change ${problem}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { ok: !problem, text };
}

// ----- events -----

// Channels made or changed during the update (including by setup tools resetting permissions) get hidden too.
async function onChannelChange(channel) {
  if (!channel.guild || !isActive(channel.guild)) return;
  const problem = await hideChannel(channel.guild, channel);
  if (problem) console.warn(`[updating] ${channel.guild.name}: couldn't hide ${problem}`);
}

// After a restart (or an /update): hide anything made while the bot was off, and clean up the old role if needed.
async function resume(guild) {
  if (!isActive(guild)) return;
  const user = await guild.client.users.fetch(store.guild(guild.id).updating.startedBy ?? guild.ownerId).catch(() => guild.client.user);
  const result = await start(guild, user, { quiet: true });
  console.log(`[updating] ${guild.name}: still in updating mode — ${result.ok ? 'caught up' : result.text}`);
}

module.exports = { isActive, start, finish, hideChannel, toggleKeepVisible, onChannelChange, resume };
