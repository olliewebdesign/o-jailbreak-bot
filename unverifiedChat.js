'use strict';

// People who haven't verified can read #please-read and the sections in config.js (verify.visibleSections), but can't
// chat: what they post is deleted and they're DMed (at most once a day, English + Russian) to verify. A new account
// posting something against the rules (calling the owner a scammer, adverts, slurs...) is restricted, the same as the
// new-account lock. Their appeal ticket and other tickets still work. Turn it off with /settings.

const config = require('../config');
const store = require('./store');
const newAccounts = require('./newAccounts');
const { fetchLogChannel } = require('./caseLog');
const { truncate, who } = require('./util');

const DAY_MS = 86_400_000;
const contact = () => config.verify?.contact || 'the server owner';

function dmText(guild) {
  const channelId = store.guild(guild.id).verify?.channelId;
  const where = channelId ? `<#${channelId}>` : '#verify';
  return [
    `🔒 **Please verify to message in ${truncate(guild.name, 80)}.** You will also get access to the jailbreak prompts.`,
    `Go to ${where} and press **Verify**.`,
    `If you have any issues or questions please message ${contact()}.`,
    '',
    `🇷🇺 **Пожалуйста, пройдите верификацию, чтобы писать на сервере ${truncate(guild.name, 80)}.** Вы также получите доступ к джейлбрейк-промптам.`,
    `Зайдите в ${where} и нажмите **Verify**.`,
    `Если есть вопросы или проблемы, напишите ${contact()}.`,
  ].join('\n');
}

// At most one mod-log line per person an hour, and 10 per server every 5 minutes (a raid can't flood the mod log).
const loggedAt = new Map(); // `${guildId}:${userId}` -> when
const guildLogs = new Map(); // guildId -> timestamps
function shouldLog(guildId, userId) {
  const now = Date.now();
  if (now - (loggedAt.get(`${guildId}:${userId}`) ?? 0) < 3_600_000) return false;
  const recent = (guildLogs.get(guildId) ?? []).filter((at) => now - at < 300_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  guildLogs.set(guildId, recent);
  loggedAt.set(`${guildId}:${userId}`, now);
  return true;
}

const toldAt = new Map(); // `${guildId}:${userId}` -> when they were last DMed
setInterval(() => {
  for (const [key, at] of toldAt) if (Date.now() - at > DAY_MS) toldAt.delete(key);
  for (const [key, at] of loggedAt) if (Date.now() - at > 3_600_000) loggedAt.delete(key);
}, 3_600_000).unref();

/** A message from someone who hasn't verified yet. Always deleted. Returns 'unverified' or 'new-account-restricted'. */
async function handle(message, member, { text, settings, edited = false, exempt = () => false }) {
  const { guild } = message;
  await newAccounts.removePost(message, member, 'has to verify before chatting');

  if (newAccounts.canChatFrom(member)) {
    // A brand-new account breaking the rules: restricted, like the new-account lock.
    if ((await newAccounts.restrictIfBroken(message, member, { text, settings, exempt })) === 'restricted') return 'new-account-restricted';
  } else {
    const broken = await newAccounts.ruleBroken(message, text, settings, exempt).catch(() => null);
    if (broken && shouldLog(guild.id, member.id)) {
      const log = await fetchLogChannel(guild);
      await log
        ?.send({ content: truncate(`🔒 ${who(member)} (hasn’t verified) posted ${broken.label} in <#${message.channelId}> — deleted.${broken.shown ? ` ${broken.shown}` : ''}`, 2000), allowedMentions: { parse: [] } })
        .catch(() => {});
    }
  }

  const key = `${guild.id}:${member.id}`;
  if (edited || Date.now() - (toldAt.get(key) ?? 0) < DAY_MS) return 'unverified';
  toldAt.set(key, Date.now());
  await member.send(dmText(guild)).catch(() => {});
  return 'unverified';
}

module.exports = { handle, dmText, _toldAt: toldAt };
