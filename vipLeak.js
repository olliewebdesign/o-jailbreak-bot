'use strict';

// Leaking VIP content: someone uses Discord's Forward button to post a message from a VIP-only channel into a channel
// ordinary members can see. The forward is deleted and they're restricted (they can appeal from #restricted).
// Staff are never touched. Copy-paste, screenshots and forwards to DMs can't be seen by a bot.

const { MessageReferenceType, PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const store = require('./store');
const restrict = require('./restrict');
const { fetchLogChannel } = require('./caseLog');
const { deleteMessage, messageText } = require('./punish');
const { isStaff, truncate, who } = require('./util');

const reason = () => config.vipLeak?.reason || 'Leaking VIP content';

const vipRoleIds = (guild, settings) => [settings.vipRoleId, config.updating?.vipRoleId].filter((id) => id && guild.roles.cache.has(id));
const memberRoleIds = (guild, settings) =>
  [...new Set([guild.id, ...(config.updating?.memberRoleIds ?? []), settings.autoroleId])].filter((id) => id && guild.roles.cache.has(id));

const canView = (channel, roleId) => Boolean(channel.permissionsFor?.(roleId)?.has(P.ViewChannel));

/** Ordinary members can see it: @everyone, the member roles or the auto-role can view it. */
function isPublic(guild, settings, channel) {
  return memberRoleIds(guild, settings).some((id) => canView(channel, id));
}

/** VIP-only: listed in config.js (vipChannelIds), or the VIP role can see it and ordinary members can't. */
function isVipOnly(guild, settings, channel) {
  const listed = config.updating?.vipChannelIds ?? [];
  if ([channel.id, channel.parentId].some((id) => id && listed.includes(id))) return true;
  return vipRoleIds(guild, settings).some((id) => canView(channel, id)) && !isPublic(guild, settings, channel);
}

/**
 * Checks a new message. Returns 'vip-leak' if it was a forward from a VIP-only channel into a public one (deleted,
 * and the person restricted), or null.
 */
async function check(message) {
  const ref = message.reference;
  if (ref?.type !== MessageReferenceType.Forward || !ref.channelId || ref.guildId !== message.guildId) return null;
  const guild = message.guild;
  const settings = store.guild(guild.id);
  const from = guild.channels.cache.get(ref.channelId) ?? (await guild.channels.fetch(ref.channelId).catch(() => null));
  const to = message.channel;
  if (!from || !to || !isVipOnly(guild, settings, from) || !isPublic(guild, settings, to)) return null;

  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member || member.user.bot || store.isTrusted(guild, member.id) || isStaff(member, settings)) return null;

  // Gone from the public channel straight away, whatever else happens.
  await deleteMessage(message);
  const forwarded = messageText(message);
  const log = await fetchLogChannel(guild);

  if (!settings.restricted[member.id]) {
    const result = await restrict.restrictMember({ guild, member, moderator: guild.client.user, reason: reason() });
    if (!result.ok) {
      await log?.send({ content: truncate(`⚠️ ${who(member)} forwarded VIP content from <#${from.id}> to <#${to.id}> (deleted), but I couldn’t restrict them: ${result.text}`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
      return 'vip-leak';
    }
  }
  await log
    ?.send({
      content: truncate(
        `🚷 Restricted ${who(member)} for **forwarding VIP content**: from <#${from.id}> into <#${to.id}> (the forward was deleted).${forwarded ? `\n> ${truncate(forwarded.replace(/\n+/g, ' '), 300)}` : ''}`,
        2000,
      ),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return 'vip-leak';
}

module.exports = { check, isVipOnly, isPublic };
