'use strict';

// Routes slash commands, the case buttons (Unmute / Restrict / Ban / Keep Muted), appeal buttons, and modal forms.

const { LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const store = require('./store');
const lockdown = require('./lockdown');
const restrict = require('./restrict');
const banList = require('./banList');
const modGuard = require('./modGuard');
const chatRequest = require('./chatRequest');
const giveaway = require('./giveaway');
const vipApply = require('./vipApply');
const verify = require('./verify');
const { banCase, isClosed, keepCase, muteCase, unmuteCase, unmuteProblem } = require('./caseActions');
const { refreshCaseLog } = require('./caseLog');
const { cleanupModal, moderatePanelButton, muteMessageModal, restrictMessageModal, runCommand } = require('./commands');
const { canBan, canModerate, ephemeral, targetProblem, truncate } = require('./util');

function reasonModal(customId, title, description, value) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(truncate(title, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Reason')
        .setDescription(description)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400).setValue(truncate(value, 400)),
        ),
    );
}

function banModal(c) {
  return reasonModal(`oj:banmodal:${c.id}`, `Ban ${c.userTag}`, 'Saved in the case and the server audit log', `Case #${c.id}: ${c.label}`).addLabelComponents(
    new LabelBuilder()
      .setLabel('Delete their recent messages (hours)')
      .setDescription('0 to 168. Use 0 to keep their messages.')
      .setTextInputComponent(
        new TextInputBuilder().setCustomId('delete_hours').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3).setValue('24'),
      ),
  );
}

async function handleButton(interaction) {
  const [, action, rawId] = interaction.customId.split(':');
  if (action === 'lockdown-alert') return lockdown.alertOwnerButton(interaction);
  if (action === 'lockdown-unlock') return lockdown.unlockButton(interaction);
  if (action === 'appeal-recheck') return require('./appealRecheck').recheckButton(interaction, rawId);
  if (action.startsWith('appeal-')) return restrict.appealButton(interaction, action, rawId);
  if (action === 'unban' || action.startsWith('unban-')) return banList.unbanButton(interaction, action, rawId);
  if (action === 'verify-start') return verify.startButton(interaction);
  if (action === 'access-clear') return require('./access').clearButton(interaction, rawId);
  if (action === 'vip-approve' || action === 'vip-deny') return vipApply.reviewButton(interaction, action, rawId);
  if (action === 'chat-allow' || action === 'chat-deny') return chatRequest.reviewButton(interaction, action, rawId);
  // The Moderate panel (right-click a message → Apps → Moderate).
  if (action === 'mod-delete' || action === 'mod-mute' || action === 'mod-restrict') {
    const [, , channelId, messageId] = interaction.customId.split(':');
    return moderatePanelButton(interaction, action.slice(4), channelId, messageId);
  }
  if (action === 'giveaway-enter') return ephemeral(interaction, `${giveaway.EMOJI} Giveaways are entered by reacting ${giveaway.EMOJI} on the message now.`);

  const { guild } = interaction;
  const settings = store.guild(guild.id);
  const c = store.getCase(guild.id, Number(rawId));
  if (!c) return ephemeral(interaction, "❌ I can't find that case any more.");

  if (action === 'ban' && (!canBan(interaction) || modGuard.isLimitedMod(interaction.member))) {
    return ephemeral(interaction, '🚫 Only admins (with the Ban Members permission) can ban. Moderators can use 🚷 Restrict instead.');
  }
  if (action !== 'ban' && !canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can review cases.');
  if (action === 'unrestrict' && !modGuard.isAdmin(interaction.member)) return ephemeral(interaction, '🚫 Only admins and the owner can unrestrict people.');
  if (c.userId === interaction.user.id) return ephemeral(interaction, '🚫 You can’t review your own case.');

  if (isClosed(c)) {
    await refreshCaseLog(guild, c);
    return ephemeral(interaction, `ℹ️ Case #${c.id} was already handled by <@${c.resolvedBy}>.`);
  }

  // Moderators have limits (and are logged in #mod-watch); admins go through staff watch.
  if (action !== 'keep' && (await modGuard.blocked(interaction, action, `<@${c.userId}>`))) return null;
  if (action !== 'keep' && modGuard.isLimitedMod(interaction.member)) await modGuard.logAction(guild, interaction.member, `pressed **${action}** on case #${c.id} (<@${c.userId}>)`);

  switch (action) {
    case 'ban':
      return interaction.showModal(banModal(c));

    case 'restrict':
      return interaction.showModal(
        reasonModal(`oj:restrictmodal:${c.id}`, `Restrict ${c.userTag}`, 'They will see this and can appeal it', `Case #${c.id}: ${c.label}`),
      );

    case 'unrestrict': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await restrict.unrestrictMember({ guild, userId: c.userId, moderator: interaction.user });
      return interaction.editReply(result.text);
    }

    case 'unmute': {
      const problem = unmuteProblem(guild, c.userId, interaction.user.id) ?? (await modGuard.unmuteModProblem(guild, interaction.member, c.userId));
      if (problem) return ephemeral(interaction, problem);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await unmuteCase(guild, c, interaction.user);
      return interaction.editReply(result.text);
    }

    case 'mute': {
      const member = await guild.members.fetch(c.userId).catch(() => null);
      if (!member) return ephemeral(interaction, "❌ They're not in the server any more.");
      const problem = targetProblem(interaction, member.user, member, 'mute');
      if (problem) return ephemeral(interaction, problem);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await muteCase(guild, c, interaction.user, member);
      return interaction.editReply(result.text);
    }

    case 'keep': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await keepCase(guild, c, interaction.user);
      return interaction.editReply(result.text);
    }
  }
  return null;
}

async function handleBanModal(interaction, caseId) {
  const { guild } = interaction;
  if (!canBan(interaction) || modGuard.isLimitedMod(interaction.member)) return ephemeral(interaction, '🚫 Only admins (with the Ban Members permission) can ban.');

  const c = store.getCase(guild.id, caseId);
  if (!c) return ephemeral(interaction, "❌ I can't find that case any more.");
  if (isClosed(c)) return ephemeral(interaction, `ℹ️ Case #${c.id} was already handled by <@${c.resolvedBy}>.`);
  // Same rank rules as everywhere else: no banning yourself, the owner, or anyone ranked at or above you.
  // (Unapproved-bot cases are about a bot, which is exactly what should be banned there.)
  if (c.type !== 'BOT') {
    const target = await guild.members.fetch(c.userId).catch(() => null);
    const problem = targetProblem(interaction, target?.user ?? { id: c.userId, bot: false }, target, 'ban');
    if (problem) return ephemeral(interaction, problem);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason').trim() || `Case #${c.id}`;
  const hours = Number.parseInt(interaction.fields.getTextInputValue('delete_hours'), 10);
  const deleteHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 0), 168) : 0;

  const result = await banCase(guild, c, interaction.user, reason, deleteHours);
  return interaction.editReply(result.text);
}

// "Restrict" on a mute case: restrict them instead, and close the mute case.
async function handleRestrictModal(interaction, caseId) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can restrict people.');
  if (modGuard.onCooldown(guild, interaction.user.id) && !modGuard.isAdmin(interaction.member)) return ephemeral(interaction, '🛑 You’re on cooldown, so your moderator powers are off.');

  const c = store.getCase(guild.id, caseId);
  if (!c) return ephemeral(interaction, "❌ I can't find that case any more.");
  if (isClosed(c)) return ephemeral(interaction, `ℹ️ Case #${c.id} was already handled by <@${c.resolvedBy}>.`);

  const member = await guild.members.fetch(c.userId).catch(() => null);
  if (!member) return ephemeral(interaction, "❌ They're not in the server any more.");
  const problem = targetProblem(interaction, member.user, member, 'restrict');
  if (problem) return ephemeral(interaction, problem);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason').trim() || `Case #${c.id}`;
  const result = await restrict.restrictMember({ guild, member, moderator: interaction.user, reason });
  if (result.ok) {
    store.updateCase(guild.id, c.id, { status: 'RESTRICTED', resolvedBy: interaction.user.id, resolvedAt: Date.now(), resolutionNote: `See case #${result.case.id}` });
    await refreshCaseLog(guild, c);
  }
  return interaction.editReply(result.text);
}

async function handleInteraction(interaction) {
  const fromOwnerDm = interaction.isButton() && interaction.customId.startsWith('ojdm:');
  const vipApplyDm = interaction.isButton() && interaction.customId.startsWith('ojvip:apply:');
  const modLift = interaction.isButton() && interaction.customId.startsWith('ojmod:lift:');
  // "Ask to chat early": the button is in their DMs, the form can be sent from there or the server.
  const chatAsk = (interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith('ojnew:');
  if (!fromOwnerDm && !vipApplyDm && !modLift && !chatAsk && !interaction.inCachedGuild()) return;
  try {
    if (modLift) return await modGuard.liftButtonPressed(interaction);
    if (chatAsk) {
      const [, kind, guildId] = interaction.customId.split(':');
      return kind === 'askmodal' ? await chatRequest.formSent(interaction, guildId) : await chatRequest.openForm(interaction, guildId);
    }
    if (fromOwnerDm) return await lockdown.dmButton(interaction);
    if (vipApplyDm) return await vipApply.dmApplyButton(interaction, interaction.customId.split(':')[2]);
    if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
      return await runCommand(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('oj:')) {
      return await handleButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('oj:')) {
      const [, kind, a, b] = interaction.customId.split(':');
      if (kind === 'banmodal') return await handleBanModal(interaction, Number(a));
      if (kind === 'restrictmodal') return await handleRestrictModal(interaction, Number(a));
      if (kind === 'mutemodal') return await muteMessageModal(interaction, a, b);
      if (kind === 'restrictmsgmodal') return await restrictMessageModal(interaction, a, b);
      if (kind === 'vipdenymodal') return await vipApply.denyModal(interaction, a);
      if (kind === 'cleanupmodal') return await cleanupModal(interaction, a);
    }
  } catch (err) {
    console.error(`[interaction] ${interaction.customId ?? interaction.commandName}:`, err);
    const content = `❌ Something went wrong: ${truncate(err.message, 300)}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
    else if (interaction.isRepliable()) await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

module.exports = { handleInteraction };
