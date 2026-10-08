'use strict';

// VIP channels have to be hidden from @everyone, not just from the member role. A VIP channel that only blocks the
// member role can be seen by anyone without it: someone who has just joined, someone still on the "accept the rules"
// screen, or someone whose roles were taken off. At startup and every 10 minutes, each VIP channel (config.js →
// updating.vipChannelIds, plus any channel the VIP role is let into while the member role is blocked) is hidden from
// @everyone too. VIPs, and bots that could see it, keep seeing it. The mod log says what changed.
// Skipped while a lockdown or server-updating is on (they put channels back exactly as they were afterwards).

const { OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');

const has = (channel, id, kind) => Boolean(channel.permissionOverwrites?.cache.get(id)?.[kind]?.has(P.ViewChannel));

/** The VIP channels in this server, and the VIP roles. */
function vipChannels(guild) {
  const settings = store.guild(guild.id);
  const vipRoles = [...new Set([settings.vipRoleId, config.updating?.vipRoleId])].filter((id) => id && guild.roles.cache.has(id));
  const memberRoles = [...new Set([...(config.updating?.memberRoleIds ?? []), settings.autoroleId])].filter((id) => id && id !== guild.id && guild.roles.cache.has(id));
  const listed = new Set(config.updating?.vipChannelIds ?? []);
  const channels = [...guild.channels.cache.values()].filter((ch) => {
    if (!ch.permissionOverwrites) return false;
    if (listed.has(ch.id) || (ch.parentId && listed.has(ch.parentId))) return true;
    return vipRoles.some((id) => has(ch, id, 'allow')) && memberRoles.some((id) => has(ch, id, 'deny'));
  });
  return { channels, vipRoles };
}

/** Hides every VIP channel from @everyone (keeping VIPs and bots in). Returns the channels it changed. */
async function lockVipChannels(guild) {
  const settings = store.guild(guild.id);
  if (settings.lockdown?.active || settings.updating?.active) return [];
  const { channels, vipRoles } = vipChannels(guild);
  if (!vipRoles.length) return [];
  const reason = 'O Jailbreak: VIP channels are hidden from everyone without the VIP role';
  const fixed = [];
  for (const channel of channels) {
    if (has(channel, guild.id, 'deny')) continue; // already hidden from @everyone
    // Everyone who's meant to keep seeing it: the VIP roles, and bots that can see it now.
    const bots = guild.roles.cache.filter((r) => r.managed && channel.permissionsFor?.(r)?.has(P.ViewChannel)).map((r) => r.id);
    try {
      for (const id of [...vipRoles, ...bots]) {
        if (!has(channel, id, 'allow')) await channel.permissionOverwrites.edit(id, { ViewChannel: true }, { reason, type: OverwriteType.Role });
      }
      await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason, type: OverwriteType.Role });
      fixed.push(channel);
    } catch (err) {
      console.warn(`[vip lock] ${guild.name}: couldn't hide #${channel.name} from @everyone: ${err.message}`);
    }
  }
  if (fixed.length) {
    const log = await fetchLogChannel(guild);
    await log
      ?.send({
        content: `🔒 **VIP channels:** ${fixed.map((c) => `<#${c.id}>`).join(', ')} ${fixed.length === 1 ? 'was' : 'were'} only hidden from the member role, so anyone without roles (someone who just joined, or hasn’t accepted the rules) could see ${fixed.length === 1 ? 'it' : 'them'}. Now hidden from @everyone too — VIPs still see them.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return fixed;
}

const watching = new Set();
/** At startup, then every 10 minutes. */
async function start(guild) {
  await lockVipChannels(guild).catch((err) => console.warn(`[vip lock] ${guild.name}: ${err.message}`));
  if (watching.has(guild.id)) return;
  watching.add(guild.id);
  setInterval(() => lockVipChannels(guild).catch(() => {}), 600_000).unref();
}

module.exports = { vipChannels, lockVipChannels, start };
