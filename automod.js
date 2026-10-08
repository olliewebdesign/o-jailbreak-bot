'use strict';

// Checks every new or edited message against the filters.

const config = require('../config');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { findSlur } = require('./filters/slurs');
const { findSelfPromo } = require('./filters/selfPromo');
const { checkSpam, forgetUser } = require('./filters/spam');
const { checkImages } = require('./filters/imageSpam');
const { autoReply, promptHelpSettings } = require('./filters/promptHelp');
const lockdown = require('./lockdown');
const { deleteMessage, muteAndLog, messageText } = require('./punish');
const staffGuard = require('./staffGuard');
const blockedServers = require('./blockedServers');
const vipLeak = require('./vipLeak');
const newAccounts = require('./newAccounts');
const unverifiedChat = require('./unverifiedChat');
const verify = require('./verify');
const { findAccusation } = require('./filters/accusations');
const modGuard = require('./modGuard');
const { durationText, isStaff } = require('./util');

const warnedGuilds = new Set();
const warnedMissingLog = new Set();

// Mutes are only handed out when the mods can review them. If the log channel was deleted,
// just remove the message and tell the owner once.
async function punish(opts) {
  if (await fetchLogChannel(opts.guild)) {
    const result = await muteAndLog(opts);
    // A wave of "the prompt doesn't work" after a patch isn't a raid, and nor is a wave of "ellie is a scammer" (the
    // new-account lock deals with those), so neither counts towards auto-lockdown.
    if (result && opts.type !== 'PROMPT' && opts.type !== 'ACCUSE') lockdown.recordRuleBreak(opts.guild, opts.user.id);
    return result ?? 'handled';
  }

  await deleteMessage(opts.message);
  if (warnedMissingLog.has(opts.guild.id)) return 'handled';
  warnedMissingLog.add(opts.guild.id);
  console.warn(`[automod] "${opts.guild.name}": the mod log channel is missing, so rule breakers are not being muted. Run /setup again.`);
  const owner = await opts.guild.fetchOwner().catch(() => null);
  await owner
    ?.send(`⚠️ O Jailbreak can't find the mod log channel in **${opts.guild.name}**, so I'm only deleting bad messages (no mutes) until someone runs \`/setup\` again.`)
    .catch(() => {});
  return 'handled';
}

// Channels the owner has told O Jailbreak to leave alone completely (threads and categories count too).
function isFreeChannel(message, settings) {
  const ids = [message.channelId, message.channel?.parentId, message.channel?.parent?.parentId];
  return ids.some((id) => id && settings.freeChannels.includes(id));
}

function isExempt(message, member, settings, filter) {
  const rules = settings.exempt[filter];
  // Threads inherit their channel's exemption, and channels inherit their category's.
  const channelIds = [message.channelId, message.channel?.parentId, message.channel?.parent?.parentId];
  if (channelIds.some((id) => id && rules.channels.includes(id))) return true;
  return rules.roles.some((id) => member.roles.cache.has(id));
}

async function handleMessage(message, { edited = false } = {}) {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;

  const settings = store.guild(message.guildId);
  if (!settings.logChannelId) {
    if (!warnedGuilds.has(message.guildId)) {
      warnedGuilds.add(message.guildId);
      console.warn(`[automod] "${message.guild.name}" isn't set up yet. Run /setup there so O Jailbreak knows where to send mod logs.`);
    }
    return;
  }

  // Forwarding a VIP-only message into a public channel (checked even in unmoderated channels: they're still public).
  if (!edited && message.reference) {
    const leaked = await vipLeak.check(message).catch((err) => console.warn(`[vip leak] ${err.message}`));
    if (leaked) return leaked;
  }

  if (isFreeChannel(message, settings)) return 'free-channel'; // not moderated, and no XP either

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;
  // The owner and admins skip the filters (staff watch still catches them flooding the chat). Moderators don't: they're
  // held to the same rules as everyone (with a lighter spam limit), and anything they break also goes in #mod-watch.
  const isMod = isStaff(member, settings);
  if (isMod && !modGuard.isLimitedMod(member, settings)) return edited ? null : staffGuard.checkMessage(message, member);
  if (isMod && newAccounts.isTicket(message.channel, member, settings)) return null; // moderators quote people in tickets

  const text = messageText(message);
  // Part of a blocked server (wearing its tag, using a blocked name, or posting its invite): restricted, message deleted.
  if ((await blockedServers.checkMember(member))?.ok) {
    await deleteMessage(message);
    return 'blocked-server';
  }
  if (await blockedServers.checkMessage(message, member, text)) return 'blocked-server';
  const editNote = edited ? ' (added by editing their message)' : '';
  const base = { guild: message.guild, user: message.author, member, message };
  const exempt = (filter) => isExempt(message, member, settings, filter);
  const inTicket = newAccounts.isTicket(message.channel, member, settings);
  // A moderator breaking a rule (in case one goes rogue): their message goes, every role comes off (saved) and they're
  // restricted, and the owner is DMed straight away. If they can't be restricted, they're dealt with like anyone else.
  const punishAndWatch = async (opts) => {
    if (isMod) {
      const restricted = await modGuard.rogueModerator(message, member, { label: opts.label, trigger: opts.trigger, text, entries: opts.entries });
      if (restricted) return restricted;
    }
    return punish(opts);
  };

  // People who haven't verified can't chat yet: deleted, and DMed to verify.
  if (!isMod && settings.modules.unverified && !inTicket && !exempt('unverified') && verify.mustVerify(member, settings)) {
    return unverifiedChat.handle(message, member, { text, settings, edited, exempt });
  }

  // Accounts under a week old can't chat yet: deleted (and restricted if what they posted breaks the rules).
  if (!isMod && settings.modules.newAccounts && !inTicket && !exempt('newAccounts') && newAccounts.canChatFrom(member)) {
    return newAccounts.handle(message, member, { text, settings, edited, exempt });
  }

  // Every new message counts towards spam limits, even if another rule catches it first. (Moderators have their own,
  // lighter limit: staff watch, at the end.)
  const spamChecked = !isMod && !edited && settings.modules.spam && !isExempt(message, member, settings, 'spam');
  const spam = spamChecked ? checkSpam(message) : null;
  const images = spamChecked ? checkImages(message) : null;

  if (settings.modules.slurs && !isExempt(message, member, settings, 'slurs')) {
    const hit = findSlur(text, settings);
    if (hit) {
      const label = hit.source === 'default' ? 'Racial slur' : 'Blocked word';
      // Deleted and logged for the mods, but not muted: they can press 🔇 Mute on the case.
      return punishAndWatch({ ...base, type: hit.source === 'default' ? 'SLUR' : 'WORD', label, trigger: `${label} detected: \`${hit.censored}\`${editNote}`, mute: false });
    }
  }

  // "ellie is a scammer": deleted and logged for the mods (a new account is restricted). Tickets are left alone,
  // so people can still complain to the staff there.
  if (settings.modules.accusations && !inTicket && !exempt('accusations')) {
    const said = findAccusation(text, message.guild);
    if (said && !isMod && newAccounts.canChatFrom(member)) return newAccounts.handle(message, member, { text, settings, edited, exempt });
    if (said) return punishAndWatch({ ...base, type: 'ACCUSE', label: 'Scam accusation', trigger: `Called the owner a scammer: “${said.shown}”${editNote}`, mute: false });
  }

  if (settings.modules.selfPromo && !isExempt(message, member, settings, 'selfPromo')) {
    const promo = await findSelfPromo(text, message.guild);
    if (promo) return punishAndWatch({ ...base, type: 'PROMO', label: promo.kind === 'scam' ? 'Scam link' : 'Self-promotion', trigger: `${promo.trigger}${editNote}` });
  }

  // Moderators: their lighter spam limit (staff watch), and nothing else — they often say "that prompt doesn't work
  // any more" while helping someone, and share screenshots.
  if (isMod) {
    if (edited || !settings.modules.spam || exempt('spam')) return null;
    // Their lighter spam limit (twice a member's): going over it is treated like any other rule they break.
    const modSpam = checkSpam(message, { allowance: Math.max(1, config.staffGuard?.spamAllowance ?? 2) });
    if (!modSpam) return null;
    forgetUser(message.guildId, message.author.id);
    return punishAndWatch({ ...base, type: 'SPAM', label: 'Spam', trigger: modSpam.trigger, entries: modSpam.entries });
  }

  const { guideChannelId } = promptHelpSettings();
  if (settings.modules.promptHelp && !edited && message.channelId !== guideChannelId && !isExempt(message, member, settings, 'promptHelp')) {
    // "the prompt doesn't work": an auto-reply pointing to that jailbreak's How to use video, or "Which one isn't
    // working?" (nobody is muted). Not for edits, so fixing a typo doesn't trigger it again.
    await autoReply(message, text);
  }

  if (spam) {
    forgetUser(message.guildId, message.author.id);
    return punish({ ...base, type: 'SPAM', label: 'Spam', trigger: spam.trigger, entries: spam.entries });
  }

  if (images) return removeImageSpam(message, images);
}

// 4 images at once or in a row (the MrBeast giveaway scam): the messages are deleted and they're told why. No mute.
async function removeImageSpam(message, { images, entries }) {
  for (const entry of entries) {
    const channel = message.guild.channels.cache.get(entry.channelId);
    if (entry.id === message.id) await deleteMessage(message);
    else await channel?.messages?.delete(entry.id).catch(() => {});
  }
  const sent = entries.length === 1 ? `${images} images in one message` : `${images} images in a row`;
  await message.author
    .send(
      `🖼️ **Your message${entries.length === 1 ? ' was' : 's were'} deleted in ${message.guild.name}** because you sent ${sent}. ` +
        'Hacked accounts use this to spread fake giveaway scams, so O Jailbreak removes 4 or more images sent at once or back to back. ' +
        'If you need to share them, send a few at a time with some text, or ask a moderator.',
    )
    .catch(() => {});
  console.log(`[automod] ${message.guild.name}: deleted ${sent} from ${message.author.tag}.`);
  return 'image-spam';
}

async function handleEdit(oldMessage, newMessage) {
  // Skip updates that didn't change the text (link previews loading, pins, etc).
  if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message) return;
  // An old message the bot doesn't remember: only a real edit just now counts (not a pin, a thread or a poll ending).
  if (oldMessage.partial && (!message.editedTimestamp || Date.now() - message.editedTimestamp > 60_000)) return;
  await handleMessage(message, { edited: true });
}

module.exports = { handleMessage, handleEdit, isFreeChannel };
