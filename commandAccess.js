'use strict';

// Makes sure members can actually use the slash commands meant for everyone (/invites, /rank, /leaderboard).
// Discord hides every one of a bot's commands from someone without "Use Application Commands", so the member roles
// and @everyone get that permission switched on. Anything the bot isn't allowed to change itself (the Integrations
// page, channel overrides) is reported in the mod log and the console with exactly what to click.

const { PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { truncate } = require('./util');

const FOR_EVERYONE = ['invites', 'applyvip', 'rank', 'leaderboard'];

/** @everyone plus the member roles from config.js (memberRoleIds), that still exist. */
function memberRoles(guild) {
  const ids = [guild.id, ...(config.updating?.memberRoleIds ?? []), store.guild(guild.id).autoroleId];
  return [...new Set(ids)].map((id) => guild.roles.cache.get(id)).filter(Boolean);
}

const roleName = (guild, role) => (role.id === guild.id ? '@everyone' : `@${role.name}`);

/** Turns "Use Application Commands" on for @everyone and the member roles. Returns the roles it fixed. */
async function fixRolePermissions(guild) {
  const fixed = [];
  const problems = [];
  for (const role of memberRoles(guild)) {
    if (role.permissions.has(P.UseApplicationCommands)) continue;
    if (!role.editable) {
      problems.push(`**${roleName(guild, role)}** has **Use Application Commands** off and is above my role, so I can’t switch it on. Server Settings → Roles → ${roleName(guild, role)} → turn on **Use Application Commands**.`);
      continue;
    }
    try {
      await role.setPermissions(role.permissions.add(P.UseApplicationCommands), 'O Jailbreak: let members use /invites, /rank and /leaderboard');
      fixed.push(roleName(guild, role));
    } catch (err) {
      problems.push(`Couldn’t switch on **Use Application Commands** for **${roleName(guild, role)}**: ${err.message}`);
    }
  }
  return { fixed, problems };
}

/**
 * Channels where a channel override takes "Use Application Commands" away from members. Left alone (it might be on
 * purpose, like #restricted), but listed so you can decide.
 */
function blockedChannels(guild) {
  const settings = store.guild(guild.id);
  const roles = memberRoles(guild).map((r) => r.id);
  return [...guild.channels.cache.values()]
    .filter((channel) => channel.permissionOverwrites && channel.id !== settings.restrict.channelId && channel.parentId !== settings.restrict.categoryId)
    .filter((channel) => roles.some((id) => channel.permissionOverwrites.cache.get(id)?.deny.has(P.UseApplicationCommands)))
    .filter((channel) => {
      // Only matters where members can see the channel at all.
      const everyone = channel.permissionsFor(guild.roles.everyone);
      return everyone?.has(P.ViewChannel) || roles.some((id) => channel.permissionOverwrites.cache.get(id)?.allow.has(P.ViewChannel));
    });
}

/**
 * Server Settings → Integrations → O Jailbreak: anything there that hides the bot's commands from members.
 * (Bots can read these, but only a person can change them.)
 */
async function integrationBlocks(guild) {
  const all = await guild.commands.permissions.fetch({}).catch(() => null);
  if (!all) return [];
  const appId = guild.client.application?.id ?? guild.client.user.id;
  const allChannels = String(BigInt(guild.id) - 1n);
  const roleIds = new Set(memberRoles(guild).map((r) => r.id));
  const commands = await guild.commands.fetch().catch(() => null);
  const name = (id) => (id === appId ? 'O Jailbreak (all commands)' : `/${commands?.get(id)?.name ?? 'a command'}`);
  const wanted = new Set([appId, ...[...(commands?.values() ?? [])].filter((c) => FOR_EVERYONE.includes(c.name)).map((c) => c.id)]);

  const blocks = [];
  for (const [commandId, perms] of all) {
    if (!wanted.has(commandId)) continue;
    for (const p of perms) {
      if (p.permission) continue;
      if (p.id === allChannels) blocks.push(`**${name(commandId)}** is switched off for **All Channels**`);
      else if (roleIds.has(p.id)) blocks.push(`**${name(commandId)}** is switched off for **${roleName(guild, guild.roles.cache.get(p.id))}**`);
    }
  }
  return blocks;
}

/** Checks everything, fixes what it can, and reports the rest. Returns the report lines (empty when all is well). */
async function check(guild, { report = true } = {}) {
  const lines = [];
  const { fixed, problems } = await fixRolePermissions(guild);
  if (fixed.length) lines.push(`✅ Switched on **Use Application Commands** for ${fixed.join(', ')}. Members can use /invites, /rank and /leaderboard now (they may need to press Ctrl+R).`);
  lines.push(...problems.map((p) => `⚠️ ${p}`));

  const integrations = await integrationBlocks(guild);
  if (integrations.length) {
    lines.push(
      `⚠️ **Discord is hiding my commands from members.** Server Settings → **Integrations** → **O Jailbreak**, and change these to ✅ (I’m not allowed to change them myself):\n${integrations.map((b) => `• ${b}`).join('\n')}`,
    );
  }

  const channels = blockedChannels(guild);
  if (channels.length) {
    lines.push(
      `ℹ️ Members can’t use slash commands in ${channels.slice(0, 15).map((c) => `<#${c.id}>`).join(', ')}${channels.length > 15 ? ` and ${channels.length - 15} more` : ''} (a channel setting takes **Use Application Commands** away). If that’s not on purpose: Edit Channel → Permissions → the member role → **Use Application Commands** ✅.`,
    );
  }

  if (report && lines.length) {
    console.log(`[commands] ${guild.name}:\n${lines.join('\n').replace(/\*\*/g, '')}`);
    // The mod log only hears about it when something is new, not on every restart (a channel may be like that on purpose).
    const settings = store.guild(guild.id);
    const summary = lines.join('\n');
    if (settings.lastCommandAccessReport !== summary) {
      settings.lastCommandAccessReport = summary;
      store.save();
      const log = await fetchLogChannel(guild);
      await log?.send({ content: truncate(`🔧 **Slash command access**\n${summary}`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
  return lines;
}

module.exports = { check, memberRoles, blockedChannels, FOR_EVERYONE };
