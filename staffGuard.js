'use strict';

// Moderators are ignored by the normal filters so they can do their job. Staff watch is the safety net for a
// mod who goes rogue: flooding the chat, mass-pinging, or firing off punishments one after another.
// The owner is always told, and never watched themselves (nor is anyone on the anti-nuke trusted list).

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const store = require('./store');
const { checkSpam, forgetUser } = require('./filters/spam');
const { fetchLogChannel } = require('./caseLog');
const { deleteEntries, muteAndLog } = require('./punish');
const { durationText, ephemeral, truncate, ts } = require('./util');

const STRIKE_WINDOW_MS = 60 * 60_000;
const strikes = new Map(); // `${guildId}:${userId}` -> { count, at }
const actions = new Map(); // `${guildId}:${userId}` -> timestamps
const told = new Map(); // so the owner isn't pinged over and over for the same burst

const enabled = () => config.staffGuard.enabled !== false;
const keyFor = (guildId, userId) => `${guildId}:${userId}`;
const timeoutMs = () => Math.max(1, config.staffGuard.timeoutMinutes) * 60_000;
const actionWindowMs = () => Math.max(1, config.staffGuard.actionMinutes) * 60_000;

// The owner and the people they've trusted with the server are left alone.
function watched(guild, member) {
  if (!enabled() || !member || member.id === guild.ownerId || member.user?.bot) return false;
  return !store.isTrusted(guild, member.id);
}

function addStrike(guildId, userId) {
  const key = keyFor(guildId, userId);
  const previous = strikes.get(key);
  const count = previous && Date.now() - previous.at < STRIKE_WINDOW_MS ? previous.count + 1 : 1;
  strikes.set(key, { count, at: Date.now() });
  return count;
}

async function alert(guild, { member, title, lines, quiet = false }) {
  const key = keyFor(guild.id, member.id);
  if (quiet && Date.now() - (told.get(key) ?? 0) < 60_000) return;
  told.set(key, Date.now());

  const embed = new EmbedBuilder()
    .setColor(0x991b1b)
    .setTitle(truncate(title, 256))
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Moderator ID ${member.id}` })
    .setTimestamp();

  const log = await fetchLogChannel(guild);
  await log?.send({ content: `🛑 **Staff watch** — <@${guild.ownerId}>`, embeds: [embed], allowedMentions: { users: [guild.ownerId] } }).catch(() => {});
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ content: `🛑 **Staff watch in ${truncate(guild.name, 80)}**`, embeds: [embed] }).catch(() => {});
}

/**
 * Called instead of the filters when a moderator posts. They get a bigger allowance than members; go past it
 * and the messages are cleaned up and the owner is told. Do it again within the hour and they're timed out.
 */
async function checkMessage(message, member) {
  const guild = message.guild;
  if (!watched(guild, member)) return null;

  const spam = checkSpam(message, { allowance: Math.max(1, config.staffGuard.spamAllowance) });
  if (!spam) return null;
  forgetUser(guild.id, member.id);

  const strike = addStrike(guild.id, member.id);
  const limit = Math.max(1, config.staffGuard.strikesBeforeTimeout);
  const when = ts(Date.now());

  if (strike < limit) {
    const cleaned = await deleteEntries(guild, spam.entries, null);
    await member
      .send(`⚠️ **Slow down** — that looked like spam in **${truncate(guild.name, 80)}** (${spam.trigger}). Do it again within the hour and you'll be timed out, even as a moderator.`)
      .catch(() => {});
    await alert(guild, {
      member,
      title: `⚠️ Moderator spam — ${member.user.tag}`,
      lines: [
        `<@${member.id}> tripped the spam filter ${when}.`,
        `**What happened:** ${truncate(spam.trigger, 400)}`,
        `🗑️ ${cleaned} message(s) removed. They've been warned — the next one within an hour is a ${durationText(timeoutMs())} timeout.`,
      ],
    });
    return { warned: true, strike };
  }

  const result = await muteAndLog({
    guild,
    user: member.user,
    member,
    type: 'STAFF',
    label: 'Moderator spam',
    trigger: spam.trigger,
    message,
    entries: spam.entries,
    timeoutMs: timeoutMs(),
    summary: `🛑 **A moderator was stopped by staff watch** (warning number ${strike} within an hour).`,
  });
  await alert(guild, {
    member,
    title: `🛑 Moderator timed out — ${member.user.tag}`,
    lines: [
      `<@${member.id}> kept spamming ${when}, so they've been timed out for **${durationText(timeoutMs())}**.`,
      `**What happened:** ${truncate(spam.trigger, 400)}`,
      result ? `The case with the proof is above. Press **🔊 Unmute** if this was a mistake.` : 'Set up a mod log channel with `/setup` to get the proof.',
      `If they shouldn't be a moderator any more, take the role off them in **Server Settings → Roles**.`,
    ],
  });
  return { timedOut: true, strike, case: result?.case ?? null };
}

/**
 * Called before a moderator punishes someone. Too many in a few minutes and the rest are refused until they
 * slow down, so one rogue (or hacked) moderator can't clear the server out.
 * @returns {string | null} what to tell them, or null when they're fine to carry on
 */
function recordAction(guild, member, what) {
  if (!watched(guild, member)) return null;
  const key = keyFor(guild.id, member.id);
  const now = Date.now();
  const recent = (actions.get(key) ?? []).filter((at) => now - at < actionWindowMs());
  recent.push(now);
  actions.set(key, recent);

  const limit = Math.max(1, config.staffGuard.actionLimit);
  if (recent.length <= limit) return null;

  alert(guild, {
    member,
    quiet: true,
    title: `🛑 Moderator doing a lot at once — ${member.user.tag}`,
    lines: [
      `<@${member.id}> tried to ${what} ${recent.length} people in ${config.staffGuard.actionMinutes} minutes, so I've paused their moderation actions.`,
      'They can carry on once things calm down. If this wasn’t them, their account may be hacked — take their roles off.',
      'Dealing with a real raid? Use `/lockdown lock` instead of punishing people one by one.',
    ],
  }).catch(() => {});

  return [
    `🛑 That's **${recent.length} punishments in ${config.staffGuard.actionMinutes} minutes**, so I've paused your moderation actions for a few minutes and told the server owner.`,
    'If a raid is going on, use `/lockdown lock` instead.',
  ].join('\n');
}

/** Wrapper for slash commands and buttons: replies and returns true when the moderator has been paused. */
async function blocked(interaction, what) {
  const problem = recordAction(interaction.guild, interaction.member, what);
  if (!problem) return false;
  await ephemeral(interaction, problem);
  return true;
}

module.exports = { checkMessage, recordAction, blocked };
