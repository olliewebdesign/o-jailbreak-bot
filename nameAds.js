'use strict';

// Names that advertise: someone whose display name or nickname is "discord.gg/abc", ".gg/abc" or "t.me/abc" shows it to
// everyone in the member list and on every message. Their nickname in this server is changed to their plain username,
// and the mod log is told. Checked when they join, when they change their name, and at startup. Staff are left alone.
// Part of the self-promotion filter (turn it off with /settings).

const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { findNameAd } = require('./filters/selfPromo');
const { isStaff, truncate, who } = require('./util');

const cantRename = new Set(); // `${guildId}:${userId}`: already told the mod log their role is too high

/** Checks someone's name. Returns what was found ({ trigger }), or null if their name is fine (or can't be changed). */
async function check(member) {
  if (!member?.guild || !member.user || member.user.bot) return null;
  const settings = store.guild(member.guild.id);
  if (!settings.modules.selfPromo || !settings.logChannelId || isStaff(member, settings)) return null;
  const name = member.nickname ?? member.user.globalName ?? member.user.username;
  const ad = await findNameAd(name, member.guild).catch(() => null);
  if (!ad) return null;

  // Their username can't hold a link (Discord only allows letters, numbers, _ and . in it), so it's a safe name.
  const plain = (await findNameAd(member.user.username, member.guild).catch(() => null)) ? 'Renamed by O Jailbreak' : member.user.username;
  const log = await fetchLogChannel(member.guild);
  if (!member.manageable) {
    if (cantRename.has(`${member.guild.id}:${member.id}`)) return null;
    cantRename.add(`${member.guild.id}:${member.id}`);
    await log?.send({ content: truncate(`🏷️ ${who(member)}’s name advertises (${ad.trigger}), but their role is above mine so I can’t change it.`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
    return null;
  }
  const changed = await member.setNickname(plain.slice(0, 32), 'O Jailbreak: their name was advertising').then(
    () => true,
    (err) => {
      console.warn(`[name ads] Couldn't rename ${member.user.tag}: ${err.message}`);
      return false;
    },
  );
  if (!changed) return null;
  await log
    ?.send({ content: truncate(`🏷️ ${who(member)}’s name was advertising, so I changed their nickname here to **${plain}**. ${ad.trigger}`, 2000), allowedMentions: { parse: [] } })
    .catch(() => {});
  return ad;
}

/** They changed their name on Discord (not just in this server): check it in every server they share with the bot. */
async function onUserUpdate(client, user) {
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(user.id);
    if (member) await check(member);
  }
}

/** At startup: anyone already in the server with an advertising name. */
async function sweep(guild) {
  let renamed = 0;
  for (const member of guild.members.cache.values()) if (await check(member)) renamed++;
  return renamed;
}

module.exports = { check, onUserUpdate, sweep };
