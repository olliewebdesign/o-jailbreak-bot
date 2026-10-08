'use strict';

const { MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const config = require('../config');

const DAY_MS = 24 * 60 * 60 * 1000;
// Discord rejects timeouts of 28 days or more, so stay just under the limit.
const TIMEOUT_MS = Math.min(Math.max(config.timeoutDays, 0.001) * DAY_MS, 28 * DAY_MS - 60_000);

function durationText(ms = TIMEOUT_MS) {
  const days = ms / DAY_MS;
  if (days >= 1) return Math.round(days) === 1 ? '1 day' : `${Math.round(days)} days`;
  const hours = ms / 3_600_000;
  if (hours >= 1) return Math.round(hours) === 1 ? '1 hour' : `${Math.round(hours)} hours`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function truncate(text, max) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Put user text in a code block so their markdown and mentions can't mess up the log.
function codeBlock(text, max = 1000) {
  const safe = truncate(text || '(no text)', max).replace(/```/g, '`​``');
  return `\`\`\`\n${safe}\n\`\`\``;
}

// Discord timestamp that shows in each viewer's own timezone.
function ts(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function censor(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return `${word[0]}${'*'.repeat(word.length - 2)}${word[word.length - 1]}`;
}

function isStaff(member, settings) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (settings.modRoleId && member.roles.cache.has(settings.modRoleId)) return true;
  return Boolean(member.permissions?.any([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers]));
}

// Who may use the Unmute / Keep Muted buttons and /mute.
function canModerate(interaction, settings) {
  const { member } = interaction;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (settings.modRoleId && member.roles.cache.has(settings.modRoleId)) return true;
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}

// Who may use the Ban button: admins only (the owner, or anyone with Ban Members).
// Moderators restrict people instead.
function canBan(interaction) {
  if (interaction.user.id === interaction.guild.ownerId) return true;
  return interaction.member.permissions.has(PermissionFlagsBits.BanMembers);
}

// Stops moderators using the bot on the owner, bots, themselves, or people ranked above them.
const PAST = { mute: 'muted', ban: 'banned', restrict: 'restricted' };

function targetProblem(interaction, user, member, action = 'mute') {
  const done = PAST[action] ?? `${action}ed`;
  if (user.id === interaction.user.id) return `❌ You can't ${action} yourself.`;
  if (user.id === interaction.client.user.id) return `❌ I can't ${action} myself.`;
  if (user.bot) return `❌ Bots can’t be ${done} this way.`;
  if (user.id === interaction.guild.ownerId) return `❌ The server owner can’t be ${done}.`;
  const isOwner = interaction.user.id === interaction.guild.ownerId;
  if (member && !isOwner && member.roles.highest.comparePositionTo(interaction.member.roles.highest) >= 0) {
    return `❌ You can only ${action} people whose highest role is below yours.`;
  }
  return null;
}

function ephemeral(interaction, content) {
  const payload = { content: truncate(content, 2000), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

/**
 * Someone in the mod log: their mention, plus their username and ID as plain text. Discord shows a mention as
 * "@unknown-user" when it hasn't loaded that member on your screen, but the name and ID always show.
 */
function who(memberOrUser) {
  const user = memberOrUser?.user ?? memberOrUser;
  const id = user?.id ?? String(memberOrUser);
  const name = user?.username ? ` **${escapeMarkdown(user.username)}**` : '';
  return `<@${id}>${name} (\`${id}\`)`;
}

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// One big permission change per server at a time (lockdown, restrict setup), so they never overlap.
const serverQueues = new Map();
function exclusive(guildId, task) {
  const run = (serverQueues.get(guildId) ?? Promise.resolve()).then(task, task);
  serverQueues.set(guildId, run.catch(() => {}));
  return run;
}

// Discord didn't answer or had a problem on its side (an outage, a timeout): trying again later can work.
function isTemporary(err) {
  if (err?.friendly) return false;
  if (typeof err?.status === 'number') return err.status >= 500 || err.status === 429;
  return err?.name === 'AbortError' || typeof err?.code === 'string' || typeof err?.cause?.code === 'string';
}

// Errors from opening a connection, before anything is sent to Discord, so a request can always be tried again.
const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

// discord.js gives up at once when it can't connect, which happens now and then on hosting sites. This wraps its
// request function so those requests are tried a couple more times first.
function retryConnectErrors(makeRequest, { attempts = 3, delayMs = 500 } = {}) {
  return async (url, init) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await makeRequest(url, init);
      } catch (err) {
        const code = err?.code ?? err?.cause?.code;
        if (!CONNECT_ERRORS.has(code) || attempt >= attempts || init?.signal?.aborted) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  };
}

// Stops the bot with an exit code the launcher understands. The Discord connection is closed first, because
// exiting in the middle of a network request can crash Node on Windows (and the exit code would be lost).
async function exitCleanly(client, code) {
  process.exitCode = code;
  await Promise.resolve()
    .then(() => client.destroy())
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(code);
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

module.exports = {
  TIMEOUT_MS,
  durationText,
  truncate,
  codeBlock,
  ts,
  censor,
  isStaff,
  canModerate,
  canBan,
  targetProblem,
  ephemeral,
  messageLink,
  who,
  exclusive,
  exitCleanly,
  inBatches,
  isTemporary,
  retryConnectErrors,
};
