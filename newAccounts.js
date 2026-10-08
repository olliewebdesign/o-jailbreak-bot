'use strict';

// Brand-new Discord accounts can't chat. Accounts made less than a week ago (config.js → newAccounts) can read
// everything and verify, but anything they post is deleted, and they're DMed (at most once a day, English + Russian)
// when they'll be able to chat. The first try each day goes in the mod log.
// Posting something that breaks the rules — calling the owner a scammer, a slur or blocked word, an advert or invite,
// a pile of images, pinging @everyone — gets them restricted instead (they can appeal like anyone else).
// Their appeal ticket, tickets from other bots, and channels let off with /exempt (filter: New accounts) stay open.

const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const config = require('../config');
const restrict = require('./restrict');
const { fetchLogChannel } = require('./caseLog');
const { deleteMessage } = require('./punish');
const { findAccusation } = require('./filters/accusations');
const { findSlur } = require('./filters/slurs');
const { findSelfPromo } = require('./filters/selfPromo');
const { countImages } = require('./filters/imageSpam');
const { codeBlock, truncate, ts, who } = require('./util');

const DAY_MS = 86_400_000;
const options = () => ({ minAccountAgeDays: 7, ...config.newAccounts });
const minDays = () => Math.max(0, Number(options().minAccountAgeDays) || 0);

/** When this member's account will be old enough to chat (ms), or null if it already is. */
function canChatFrom(member) {
  const created = member?.user?.createdTimestamp;
  if (!minDays() || !created) return null;
  if (member.guild && require('./chatRequest').isAllowed(member.guild.id, member.id)) return null; // an admin let them in early
  const from = created + minDays() * DAY_MS;
  return from > Date.now() ? from : null;
}

/**
 * A ticket: their appeal (or anything in the Appeals category), a private thread a bot made (how some ticket bots
 * work), or a channel they were let into by name (how most ticket bots work). Only they and the staff can see those.
 * A private thread a member made themselves doesn't count — anyone can make one and invite people in.
 */
function isTicket(channel, member, settings) {
  if (!channel) return false;
  const appeals = [settings.restrict?.categoryId, ...(settings.restrict?.extraCategoryIds ?? [])].filter(Boolean);
  if ([channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && appeals.includes(id))) return true;
  if (settings.restricted?.[member.id]?.ticketChannelId === channel.id) return true;
  if (channel.type === ChannelType.PrivateThread) {
    const owner = channel.guild?.members?.cache?.get(channel.ownerId);
    return Boolean(owner?.user?.bot || (channel.ownerId && channel.ownerId === channel.client?.user?.id));
  }
  if (channel.isThread?.()) return false;
  const own = channel.permissionOverwrites?.cache?.get(member.id);
  return Boolean(own?.allow?.has(P.ViewChannel));
}

/** What they posted that's against the rules: { label, shown }, or null. */
async function ruleBroken(message, text, settings, exempt) {
  const { guild } = message;
  if (settings.modules.accusations !== false && !exempt('accusations')) {
    const said = findAccusation(text, guild);
    if (said) return { label: 'calling the owner a scammer', shown: said.shown };
  }
  if (settings.modules.slurs && !exempt('slurs')) {
    const hit = findSlur(text, settings);
    if (hit) return { label: hit.source === 'default' ? 'a racial slur' : 'a blocked word', shown: hit.censored };
  }
  if (settings.modules.selfPromo && !exempt('selfPromo')) {
    const promo = await findSelfPromo(text, guild).catch(() => null);
    if (promo) return { label: promo.kind === 'scam' ? 'a scam link' : 'advertising', shown: promo.trigger };
  }
  const images = countImages(message);
  if (images >= (config.imageSpam?.maxImages ?? 4)) return { label: `${images} images at once (the giveaway scam)`, shown: null };
  // "@everyone free nitro https://…" is the classic scam. Just "hi @everyone" is only deleted.
  const content = message.content ?? '';
  if (/@(?:everyone|here)\b/i.test(content) && /https?:\/\/|discord\.gift|\.(?:gg|com|ru|xyz|io)\//i.test(content)) {
    return { label: 'pinging @everyone with a link (scam)', shown: null };
  }
  return null;
}

const ruDays = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'дня' : 'дней');

function dmText(guild, from) {
  const name = truncate(guild.name, 80);
  const days = minDays();
  return [
    `🐣 **Your message in ${name} was removed.** New Discord accounts can’t chat there for their first ${days} day${days === 1 ? '' : 's'} — it stops scam and spam accounts. You can still read everything.`,
    `You’ll be able to chat ${ts(from, 'F')} (${ts(from)}). **Want to chat sooner?** Press the button below (or use \`/applychat\` in the server) and an admin will look at it.`,
    '',
    `🇷🇺 **Ваше сообщение на сервере ${name} удалено.** Новые аккаунты Discord не могут писать там первые ${days} ${ruDays(days)} — это защита от скам- и спам-аккаунтов. Читать всё можно уже сейчас.`,
    `Писать можно будет ${ts(from, 'F')} (${ts(from)}). **Хотите писать раньше?** Нажмите кнопку ниже (или \`/applychat\` на сервере), и администратор рассмотрит запрос.`,
  ].join('\n');
}

const toldAt = new Map(); // `${guildId}:${userId}` -> when they were last DMed (and the mod log told)

// At most 10 new-account lines in the mod log per server every 5 minutes, so a raid can't flood it.
const guildLogs = new Map(); // guildId -> timestamps
function roomInLog(guildId) {
  const recent = (guildLogs.get(guildId) ?? []).filter((at) => Date.now() - at < 300_000);
  if (recent.length >= 10) return false;
  recent.push(Date.now());
  guildLogs.set(guildId, recent);
  return true;
}
setInterval(() => {
  for (const [key, at] of toldAt) if (Date.now() - at > DAY_MS) toldAt.delete(key);
}, 3_600_000).unref();

/**
 * A message from a new account, somewhere they can't chat yet. Always deleted; restricted if it broke the rules.
 * Returns 'new-account-restricted' or 'new-account'.
 */
/** Deletes a post from someone who can't chat yet (a forum post they started goes with its thread). */
async function removePost(message, member, why) {
  const thread = message.channel;
  if (thread?.isThread?.() && thread.id === message.id && thread.ownerId === member.id) {
    await thread.delete(`O Jailbreak: ${why}`).catch(() => deleteMessage(message));
  } else {
    await deleteMessage(message);
  }
}

/**
 * A new account posted something against the rules: restricted, with the message as proof.
 * Returns 'restricted', 'failed' (logged), or null if it wasn't against the rules.
 */
async function restrictIfBroken(message, member, { text, settings, exempt = () => false }) {
  const { guild } = message;
  const broken = await ruleBroken(message, text, settings, exempt);
  if (!broken || settings.restricted[member.id]) return null;
  const result = await restrict.restrictMember({
    guild,
    member,
    moderator: guild.client.user,
    reason: `New account breaking the rules: ${broken.label}`,
    proof: { excerpt: text || null, channelId: message.channelId },
  });
  if (result.ok) {
    console.log(`[new accounts] ${guild.name}: restricted ${member.user.tag} (${broken.label}).`);
    return 'restricted';
  }
  const log = roomInLog(guild.id) ? await fetchLogChannel(guild) : null;
  await log
    ?.send({ content: truncate(`⚠️ New account ${who(member)} posted ${broken.label} in <#${message.channelId}> (deleted), but I couldn’t restrict them: ${result.text}`, 2000), allowedMentions: { parse: [] } })
    .catch(() => {});
  return 'failed';
}

async function handle(message, member, { text, settings, edited = false, exempt = () => false }) {
  const { guild } = message;
  const from = canChatFrom(member);
  await removePost(message, member, 'new accounts can’t post yet');
  const restricted = await restrictIfBroken(message, member, { text, settings, exempt });
  if (restricted === 'restricted') return 'new-account-restricted';
  if (restricted) return 'new-account';
  const log = await fetchLogChannel(guild);

  // Told once a day at most, however many times they try.
  const key = `${guild.id}:${member.id}`;
  if (edited || Date.now() - (toldAt.get(key) ?? 0) < DAY_MS) return 'new-account';
  toldAt.set(key, Date.now());
  const dmed = await member.send({ content: dmText(guild, from), components: [require('./chatRequest').askButton(guild.id)] }).then(
    () => true,
    () => false,
  );
  if (!roomInLog(guild.id)) return 'new-account';
  await log
    ?.send({
      content: truncate(
        `🐣 New account ${who(member)} (made ${ts(member.user.createdTimestamp)}) tried to chat in <#${message.channelId}> — deleted${dmed ? ' and DMed' : ' (their DMs are closed)'}. They can chat ${ts(from)}.\n${codeBlock(text, 600)}`,
        2000,
      ),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return 'new-account';
}

module.exports = { canChatFrom, isTicket, handle, removePost, restrictIfBroken, ruleBroken, _toldAt: toldAt };
