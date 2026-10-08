'use strict';

// The welcome channel: says hello to everyone who joins and, when it can work it out, whose invite link brought
// them in. People who have to accept the rules first are welcomed once they've accepted.

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const store = require('./store');
const invites = require('./invites');
const { truncate, ts } = require('./util');

const recent = new Map(); // so nobody is welcomed twice (join + accepting the rules)
const WELCOME_ONCE_MS = 10 * 60_000;

function alreadyWelcomed(member) {
  const key = `${member.guild.id}:${member.id}`;
  const at = recent.get(key);
  if (at && Date.now() - at < WELCOME_ONCE_MS) return true;
  recent.set(key, Date.now());
  if (recent.size > 500) {
    for (const [k, when] of recent) if (Date.now() - when > WELCOME_ONCE_MS) recent.delete(k);
  }
  return false;
}

function fill(text, member, inviterId) {
  return String(text ?? '')
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{name}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', String(member.guild.memberCount ?? '?'))
    .replaceAll('{inviter}', inviterId ? `<@${inviterId}>` : 'someone');
}

/**
 * Posts the welcome message. `invite` is what the invite tracker worked out ({ inviterId, count }), if anything.
 */
async function welcome(member, invite = null, { force = false } = {}) {
  const settings = store.guild(member.guild.id);
  if (!settings.welcomeChannelId || member.user.bot) return null;
  if (!force && alreadyWelcomed(member)) return null;

  const channel = member.guild.channels.cache.get(settings.welcomeChannelId);
  if (!channel?.isTextBased()) return null;

  const credited = invite?.inviterId ?? invites.invitedBy(settings, member.id);
  // The server's own custom link (discord.gg/yourname) belongs to the server, not to a person.
  const viaVanity = Boolean(invite?.vanity) || invites.isVanity(credited);
  const inviterId = viaVanity ? null : credited;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setDescription(truncate(fill(config.welcome.message, member, inviterId), 3000))
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setTimestamp();

  const lines = [];
  if (config.welcome.showInviter) {
    if (viaVanity) {
      const code = member.guild.vanityURLCode;
      lines.push(`📨 **Joined with the server’s own link**${code ? ` (discord.gg/${code})` : ''} — nobody gets VIP credit for it`);
    } else if (!inviterId) {
      lines.push('📨 **Invited by** — I couldn’t tell which link they used');
    } else {
      const note =
        invite && invite.counted === false
          ? invite.reason === 'rejoin'
            ? ' — doesn’t count towards VIP (they’d already joined before)'
            : invite.reason === 'unverified'
              ? ' — counts towards VIP once they verify'
              : ` — doesn’t count towards VIP (account under ${config.vip.minAccountAgeDays} days old)`
          : invite?.count
            ? ` — that's ${invite.count} people they've brought in`
            : '';
      lines.push(`📨 **Invited by** <@${inviterId}>${note}`);
    }
  }
  if (config.welcome.showMemberCount && member.guild.memberCount) lines.push(`👥 **Member #${member.guild.memberCount}**`);
  if (config.welcome.showAccountAge) lines.push(`🗓️ **Account made** ${ts(member.user.createdTimestamp)}`);
  if (lines.length) embed.addFields({ name: '​', value: lines.join('\n') });

  return channel
    .send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } })
    .catch((err) => {
      console.warn(`[welcome] ${member.guild.name}: couldn't post the welcome for ${member.user.tag}: ${err.message}`);
      return null;
    });
}

module.exports = { welcome, fill };
