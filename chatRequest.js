'use strict';

// New accounts (under a week old, see newAccounts.js) can ask to chat early. The DM they get when they try to chat has
// a 📝 button (or they use /applychat): they say why, and it goes to the mod log with ✅ Let them chat / ❌ Deny, which
// only admins and the owner can press. They have to verify first (if verification is on). One request at a time;
// after a Deny they can ask again in 24 hours.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { truncate, ts, who } = require('./util');

const REASK_HOURS = 24;

function chatSettings(settings) {
  settings.newAccounts ??= {};
  settings.newAccounts.allowed ??= {}; // userId -> { at, by }: let in before their account is a week old
  settings.newAccounts.requests ??= {}; // userId -> { status, at, why, channelId, messageId, decidedAt, decidedBy }
  return settings.newAccounts;
}

/** Has an admin let them chat before their account is a week old? */
const isAllowed = (guildId, userId) => Boolean(store.guild(guildId).newAccounts?.allowed?.[userId]);

const askButton = (guildId) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ojnew:ask:${guildId}`).setStyle(ButtonStyle.Primary).setEmoji('📝').setLabel('Ask to chat early'));

const reviewButtons = (userId, disabled = false) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`oj:chat-allow:${userId}`).setStyle(ButtonStyle.Success).setEmoji('✅').setLabel('Let them chat').setDisabled(disabled),
    new ButtonBuilder().setCustomId(`oj:chat-deny:${userId}`).setStyle(ButtonStyle.Danger).setEmoji('❌').setLabel('Deny').setDisabled(disabled),
  ),
];

/** Why they can't ask right now, or null. */
function cannotAsk(member, settings) {
  const newAccounts = require('./newAccounts');
  const verify = require('./verify');
  if (!newAccounts.canChatFrom(member)) return '✅ You can already chat.';
  if (settings.restricted[member.id]) return '🚫 You’re restricted, so you can’t ask right now. You can appeal in #restricted.';
  if (verify.mustVerify(member, settings)) return `🔒 Verify first — press **Verify** in ${settings.verify?.channelId ? `<#${settings.verify.channelId}>` : '#verify'} — then ask again.`;
  const request = chatSettings(settings).requests[member.id];
  if (request?.status === 'pending') return '⏳ You’ve already asked. An admin will look at it soon.';
  const again = (request?.decidedAt ?? 0) + REASK_HOURS * 3_600_000;
  if (request?.status === 'denied' && Date.now() < again) return `⏳ Your last request was turned down. You can ask again ${ts(again)}.`;
  return null;
}

function askModal(guildId) {
  return new ModalBuilder()
    .setCustomId(`ojnew:askmodal:${guildId}`)
    .setTitle('Ask to chat early')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Why should you be able to chat now?')
        .setDescription('An admin will read this')
        .setTextInputComponent(new TextInputBuilder().setCustomId('why').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(300)),
    );
}

async function memberFor(interaction, guildId) {
  const guild = interaction.client.guilds.cache.get(guildId);
  const member = guild ? (guild.members.cache.get(interaction.user.id) ?? (await guild.members.fetch(interaction.user.id).catch(() => null))) : null;
  return { guild, member };
}

const reply = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});

/** 📝 in their DMs, or /applychat in the server: opens the form (or says why they can't). */
async function openForm(interaction, guildId) {
  const { guild, member } = await memberFor(interaction, guildId);
  if (!member) return reply(interaction, '❌ You’re not in that server any more.');
  const problem = cannotAsk(member, store.guild(guild.id));
  if (problem) return reply(interaction, problem);
  return interaction.showModal(askModal(guild.id));
}

/** The form was sent: the request goes to the mod log for an admin. */
async function formSent(interaction, guildId) {
  const { guild, member } = await memberFor(interaction, guildId);
  if (!member) return reply(interaction, '❌ You’re not in that server any more.');
  const settings = store.guild(guild.id);
  const problem = cannotAsk(member, settings);
  if (problem) return reply(interaction, problem);
  const log = await fetchLogChannel(guild);
  if (!log) return reply(interaction, '⚠️ Requests can’t be sent right now. Please try again later.');

  const why = interaction.fields.getTextInputValue('why').trim();
  const newAccounts = require('./newAccounts');
  const from = newAccounts.canChatFrom(member);
  const verified = settings.verify?.verifiedRoleId && member.roles.cache.has(settings.verify.verifiedRoleId);
  const cases = store.casesForUser(guild.id, member.id).length;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(truncate(`📝 Asking to chat early — ${member.user.tag}`, 256))
    .setDescription(`${who(member)}\n\n**Why:**\n${truncate(why, 1000)}`)
    .addFields(
      { name: 'Account made', value: ts(member.user.createdTimestamp), inline: true },
      { name: 'Joined', value: member.joinedTimestamp ? ts(member.joinedTimestamp) : 'Unknown', inline: true },
      { name: 'Can chat anyway', value: from ? ts(from) : 'now', inline: true },
      { name: 'Verified', value: settings.verify?.enabled ? (verified ? '✅ Yes' : '❌ No') : 'Verification is off', inline: true },
      { name: 'Past cases', value: String(cases), inline: true },
      { name: 'Status', value: '⏳ Waiting for an admin' },
    )
    .setFooter({ text: `User ID ${member.id}` })
    .setTimestamp();
  const avatar = member.user.displayAvatarURL?.({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);
  const sent = await log.send({ embeds: [embed], components: reviewButtons(member.id), allowedMentions: { parse: [] } }).catch(() => null);
  if (!sent) return reply(interaction, '⚠️ Your request couldn’t be sent. Please try again later.');

  chatSettings(settings).requests[member.id] = { status: 'pending', at: Date.now(), why, channelId: log.id, messageId: sent.id };
  store.save();
  return reply(interaction, '📨 Sent! An admin will look at it, and I’ll DM you when they decide.');
}

async function markDecided(interaction, request, text) {
  const message = interaction.message;
  if (!message?.embeds?.[0]) return;
  const embed = EmbedBuilder.from(message.embeds[0]).setColor(request.status === 'approved' ? 0x22c55e : 0xed4245);
  embed.setFields([...(embed.data.fields ?? []).filter((f) => f.name !== 'Status'), { name: 'Status', value: text }]);
  await message.edit({ embeds: [embed], components: reviewButtons(request.userId ?? 'x', true) }).catch(() => {});
}

/** ✅ Let them chat / ❌ Deny in the mod log. Admins and the owner only. */
async function reviewButton(interaction, action, userId) {
  const { guild } = interaction;
  if (!require('./modGuard').isAdmin(interaction.member)) return reply(interaction, '🚫 Only admins and the owner can decide these.');
  const settings = store.guild(guild.id);
  const n = chatSettings(settings);
  const request = n.requests[userId];
  if (!request || request.status !== 'pending') return reply(interaction, 'ℹ️ This has already been decided.');
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  request.userId = userId;
  request.decidedAt = Date.now();
  request.decidedBy = interaction.user.id;

  if (action === 'chat-allow') {
    request.status = 'approved';
    n.allowed[userId] = { at: Date.now(), by: interaction.user.id };
    store.save();
    await markDecided(interaction, request, `✅ **Let in** by <@${interaction.user.id}> ${ts(Date.now())}`);
    await user?.send(`✅ **You can chat in ${truncate(guild.name, 80)} now!** An admin let you in early.`).catch(() => {});
    return reply(interaction, `✅ <@${userId}> can chat now.`);
  }

  request.status = 'denied';
  store.save();
  await markDecided(interaction, request, `❌ **Denied** by <@${interaction.user.id}> ${ts(Date.now())}`);
  const from = await guild.members.fetch(userId).then((m) => require('./newAccounts').canChatFrom(m), () => null);
  await user
    ?.send(
      `❌ **Your request to chat early in ${truncate(guild.name, 80)} was turned down.**${from ? ` You’ll be able to chat ${ts(from, 'F')}.` : ''} You can ask again ${ts(Date.now() + REASK_HOURS * 3_600_000)}.`,
    )
    .catch(() => {});
  return reply(interaction, `❌ Denied. <@${userId}> has been told.`);
}

module.exports = { isAllowed, askButton, cannotAsk, openForm, formSent, reviewButton, REASK_HOURS };
