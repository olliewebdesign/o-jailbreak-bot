'use strict';

// Look-alikes of the owner: someone who joins (or changes their name) to something like "ellie" or "eliot" — usually
// the first step in pretending to be the owner to scam people. The owner (config.js → nameWatch) gets a DM saying who
// it is, and the mod log is told. Nothing is done to them: that's the owner's call.
// Disguises count ("3llie", "e1lie", "real_ellie", "ellie.fx", Russian letters); names that only contain the letters
// ("Kellie", "Nellie", "Belly") don't. The owner, staff and bots are never reported.

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { normalizeWord } = require('./filters/normalize');
const { isStaff, truncate, ts, who } = require('./util');

const DAY_MS = 86_400_000;
const options = () => ({ names: [], namesRussian: [], notifyUserIds: [], ...config.nameWatch });

// Words people put in front of a name they're copying: "real_ellie", "itsellie", "the eliot".
const PREFIXES = /^(?:the|real|official|its|itz|im|iam|not|mr|xx|x|ttv|yt)+/;
const TO_CYRILLIC = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', 0: 'о' };

/** The part of a name that looks like the owner's ("3llie"), or null. */
function looksLikeOwner(name) {
  if (!name) return null;
  const { names, namesRussian } = options();
  const latin = names.map((n) => normalizeWord(n)).filter(Boolean);
  const russian = namesRussian.map((n) => n.toLowerCase());
  const raw = String(name);
  // Each word, plus the whole name run together ("ell.fx" → "ellfx", "e l l i e" → "ellie").
  const pieces = [...raw.split(/[^\p{L}\p{N}@$!|]+/u).filter(Boolean), raw.replace(/[^\p{L}\p{N}@$!|]+/gu, '')];
  for (const piece of pieces) {
    // 1, | and a capital I can be an l ("e1lie", "Eiiie") or an i ("el1ie"): try both.
    for (const form of [normalizeWord(piece), normalizeWord(piece.replace(/[1|I]/g, 'l'))]) {
      if (form && latin.some((n) => form.startsWith(n) || form.replace(PREFIXES, '').startsWith(n))) return piece;
    }
    if (/\p{Script=Cyrillic}/u.test(piece)) {
      const ru = piece.toLowerCase().replace(/ё/g, 'е').replace(/[a-z0-9]/g, (ch) => TO_CYRILLIC[ch] ?? ch);
      if (russian.some((n) => ru.startsWith(n))) return piece;
    }
  }
  return null;
}

/** Every name someone shows under: their username, display name and nickname here. */
const namesOf = (member) => [member.user.username, member.user.globalName, member.nickname].filter(Boolean);

const reported = new Map(); // `${guildId}:${userId}` -> the names last reported (so a name is only reported once)
setInterval(() => {
  for (const [key, at] of reported) if (Date.now() - at.at > 7 * DAY_MS) reported.delete(key);
}, 3_600_000).unref();

/**
 * Checks someone. `how` is 'joined' or 'renamed'. Returns the matching name if the owner was told, otherwise null.
 */
async function check(member, how = 'joined') {
  if (!member?.guild || !member.user || member.user.bot) return null;
  const settings = store.guild(member.guild.id);
  if (settings.modules.nameWatch === false) return null;
  const { notifyUserIds } = options();
  const notify = (notifyUserIds?.length ? notifyUserIds : [member.guild.ownerId]).filter(Boolean);
  if (member.id === member.guild.ownerId || notify.includes(member.id) || store.isTrusted(member.guild, member.id) || isStaff(member, settings)) return null;

  const match = namesOf(member).map(looksLikeOwner).find(Boolean);
  if (!match) return null;
  const key = `${member.guild.id}:${member.id}`;
  const names = namesOf(member).join(' / ');
  if (how === 'renamed' && reported.get(key)?.names === names) return null; // nothing new to tell
  reported.set(key, { names, at: Date.now() });

  const created = member.user.createdTimestamp ?? null;
  const ageDays = created ? Math.floor((Date.now() - created) / DAY_MS) : null;
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle(how === 'joined' ? '👀 Someone joined with a name like yours' : '👀 Someone changed their name to look like yours')
    .setDescription(`${who(member)} in **${truncate(member.guild.name, 100)}**\nMatched: **${truncate(match, 100)}**`)
    .addFields(
      { name: 'Username', value: truncate(`@${member.user.username}`, 1024), inline: true },
      { name: 'Display name', value: truncate(member.user.globalName ?? '—', 1024), inline: true },
      { name: 'Nickname here', value: truncate(member.nickname ?? '—', 1024), inline: true },
      { name: 'Account made', value: created ? `${ts(created, 'D')} (${ts(created)})${ageDays < 30 ? '\n⚠️ **New account**' : ''}` : 'Unknown', inline: true },
      { name: 'Joined', value: member.joinedTimestamp ? ts(member.joinedTimestamp) : 'Just now', inline: true },
      { name: 'User ID', value: `\`${member.id}\``, inline: true },
    )
    .setFooter({ text: 'Nothing has been done to them. Right-click their name in the server to act.' })
    .setTimestamp();
  const avatar = member.user.displayAvatarURL?.({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);

  let told = 0;
  for (const userId of notify) {
    const user = await member.client?.users?.fetch(userId).catch(() => null);
    if (await user?.send({ embeds: [embed] }).then(() => true, () => false)) told++;
  }
  const log = await fetchLogChannel(member.guild);
  await log
    ?.send({
      content: truncate(
        `👀 ${who(member)} ${how === 'joined' ? 'joined with' : 'changed their name to'} a name like the owner’s (**${match}**). Account made ${created ? ts(created) : 'unknown'}.${told ? '' : ' ⚠️ I couldn’t DM the owner (DMs closed?).'}`,
        2000,
      ),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return match;
}

/** They changed their name on Discord itself (not just in this server). */
async function onUserUpdate(client, user) {
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(user.id);
    if (member) await check(member, 'renamed');
  }
}

module.exports = { looksLikeOwner, check, onUserUpdate, _reported: reported };
