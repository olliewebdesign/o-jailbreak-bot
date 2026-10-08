'use strict';

// VIP applications. Reaching the invite goal no longer hands out VIP: the person is DMed an "Apply for VIP" button
// (or uses /applyvip), their application goes to a review channel with everyone they brought in, and an admin
// presses Approve or Deny. Only the owner and people with Administrator can decide.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits: P,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../config');
const store = require('./store');
const invites = require('./invites');
const { fetchLogChannel } = require('./caseLog');
const { truncate, ts } = require('./util');

const REAPPLY_HOURS = 24; // after a denial
const MAX_LISTED = 40;

function applications(settings) {
  settings.vipApplications ??= {};
  return settings.vipApplications;
}

/** Admin+: the owner, or anyone with Administrator. */
function isAdmin(interaction) {
  return interaction.user.id === interaction.guild.ownerId || Boolean(interaction.member?.permissions.has(P.Administrator));
}

const hasVip = (member, settings) => Boolean(settings.vipRoleId && member.roles.cache.has(settings.vipRoleId));

async function reviewChannel(guild, settings) {
  if (settings.vipReviewChannelId) {
    const channel = guild.channels.cache.get(settings.vipReviewChannelId) ?? (await guild.channels.fetch(settings.vipReviewChannelId).catch(() => null));
    if (channel?.isTextBased()) return channel;
  }
  return fetchLogChannel(guild);
}

/** Why this member can't apply right now, or null if they can. */
// How long someone has to have been in the server before they can apply (config.js → vip.minDaysInServer), so nobody
// can join, invite a crowd, grab VIP and leave with the prompts. Leaving and rejoining starts it again.
const minDaysInServer = () => Math.max(0, Number(config.vip?.minDaysInServer ?? 7));

/** When they'll have been here long enough to apply, or null if they already have. */
function canApplyFrom(member) {
  const days = minDaysInServer();
  const joinedAt = member.joinedTimestamp;
  if (!days || !joinedAt) return null;
  const from = joinedAt + days * 86_400_000;
  return Date.now() < from ? from : null;
}

function cannotApply(member, settings, { ignoreTime = false } = {}) {
  if (!settings.vipRoleId) return '❌ VIP isn’t set up in this server.';
  if (hasVip(member, settings)) return '🌟 You already have VIP!';
  if (settings.restricted[member.id]) return '🚫 Restricted members can’t apply for VIP.';
  const count = invites.joinsBy(settings, member.id);
  const needed = invites.joinsNeeded(settings);
  if (count < needed) return `📨 You’ve brought in **${count}** of **${needed}** people. Come back when you reach ${needed}. (\`/invites\` shows your progress.)`;
  const from = ignoreTime ? null : canApplyFrom(member);
  if (from) return `⏳ You’ve reached the goal, but you need to have been in the server for **${minDaysInServer()} days** before you can apply for VIP. You can apply ${ts(from)}.`;
  const app = applications(settings)[member.id];
  if (app?.status === 'pending' || app?.status === 'deciding') return '⏳ Your application is already waiting for an admin to review it.';
  if (app?.status === 'denied' && Date.now() - app.decidedAt < REAPPLY_HOURS * 3_600_000) {
    return `❌ Your last application was denied. You can apply again ${ts(app.decidedAt + REAPPLY_HOURS * 3_600_000)}.`;
  }
  return null;
}

// ----- the application admins review -----

function invitedLines(guild, settings, userId) {
  const people = invites.broughtBy(settings, userId);
  const lines = people.slice(-MAX_LISTED).map((p) => {
    const here = guild.members.cache.has(p.id) ? '' : ' 🚪 left';
    const age = `${p.accountDays}d old`;
    if (p.counted) return `✅ <@${p.id}> · ${age}${here}`;
    if (p.reason === 'unverified') return `⏳ <@${p.id}> · ${age} · hasn’t verified yet${here}`;
    const why = p.reason === 'left-early' ? 'left within a day' : p.reason === 'new-account' ? 'account too new' : 'didn’t count';
    return `❌ <@${p.id}> · ${age} · ${why}${here}`;
  });
  if (people.length > MAX_LISTED) lines.unshift(`…and ${people.length - MAX_LISTED} earlier`);
  return lines;
}

function buildApplication(guild, member, settings) {
  const count = invites.joinsBy(settings, member.id);
  const revoked = invites.revokedFrom(settings, member.id);
  const cases = store.casesForUser(guild.id, member.id);
  const people = invitedLines(guild, settings, member.id);
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(truncate(`🌟 VIP application — ${member.user.tag}`, 256))
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setDescription(truncate(`**Who they brought in** (✅ counted, ❌ didn’t, 🚪 has left):\n${people.join('\n') || 'Nobody listed.'}`, 4000))
    .addFields(
      { name: 'Applicant', value: `<@${member.id}>\n\`${member.id}\``, inline: true },
      { name: 'Invites', value: `**${count}** (VIP needs ${invites.joinsNeeded(settings)})${revoked ? `\n➖ ${revoked} taken off by staff` : ''}`, inline: true },
      { name: 'Account created', value: ts(member.user.createdTimestamp), inline: true },
      { name: 'Joined server', value: member.joinedTimestamp ? ts(member.joinedTimestamp) : 'Unknown', inline: true },
      { name: 'Previous cases', value: cases.length ? truncate(cases.slice(0, 5).map((c) => `#${c.id} ${c.label}`).join('\n'), 1024) : 'None', inline: true },
      { name: 'Status', value: '⏳ Waiting for an admin (Administrator) to review' },
    )
    .setFooter({ text: `Applied` })
    .setTimestamp();
}

function reviewButtons(userId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`oj:vip-approve:${userId}`).setStyle(ButtonStyle.Success).setEmoji('✅').setLabel('Approve').setDisabled(disabled),
      new ButtonBuilder().setCustomId(`oj:vip-deny:${userId}`).setStyle(ButtonStyle.Danger).setEmoji('❌').setLabel('Deny').setDisabled(disabled),
    ),
  ];
}

/** Sends the application for review. Returns what to tell the applicant. */
async function apply(guild, member) {
  const settings = store.guild(guild.id);
  const problem = cannotApply(member, settings);
  if (problem) return { ok: false, text: problem };

  const channel = await reviewChannel(guild, settings);
  if (!channel) return { ok: false, text: '❌ There’s nowhere to send applications yet. Ask an admin to run `/vip review`.' };
  const sent = await channel
    .send({ embeds: [buildApplication(guild, member, settings)], components: reviewButtons(member.id), allowedMentions: { parse: [] } })
    .catch(() => null);
  if (!sent) return { ok: false, text: '❌ I couldn’t post your application. Please tell an admin.' };

  applications(settings)[member.id] = { status: 'pending', at: Date.now(), channelId: channel.id, messageId: sent.id, count: invites.joinsBy(settings, member.id) };
  store.save();
  return { ok: true, text: '✅ **Your VIP application has been sent.** An admin will check the people you invited and get back to you by DM.' };
}

// ----- telling people they qualify -----

function applyButton(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ojvip:apply:${guildId}`).setStyle(ButtonStyle.Success).setEmoji('🌟').setLabel('Apply for VIP'),
  );
}

/** Someone reached the goal: DM them once to apply (they can also use /applyvip). */
async function notifyEligible(guild, userId) {
  const settings = store.guild(guild.id);
  const member = await guild.members.fetch(userId).catch(() => null);
  // (Someone who hasn't been here long enough yet is still told, with the date they can apply from.)
  if (!member || cannotApply(member, settings, { ignoreTime: true })) return false;
  const app = (applications(settings)[userId] ??= { status: 'eligible' });
  if (app.notifiedAt) return false;
  app.notifiedAt = Date.now();
  store.save();
  const from = canApplyFrom(member);
  const when = from
    ? `You can apply ${ts(from)} (you need to have been in the server for ${minDaysInServer()} days) — press the button then, and an admin will review it.`
    : 'Press the button and an admin will review it.';
  await member
    .send({
      content: `🌟 **You’ve reached the VIP goal in ${truncate(guild.name, 80)}!** ${invites.joinsBy(settings, userId)} people have joined with your invite links. ${when} (Or type \`/applyvip\` in the server.)`,
      components: [applyButton(guild.id)],
    })
    .catch(() => {});
  return true;
}

/** Everyone who already qualifies (after /vip set or /vip goal). Returns how many were told. */
async function notifyAllEligible(guild) {
  const settings = store.guild(guild.id);
  if (!settings.vipRoleId) return 0;
  let told = 0;
  for (const [userId, count] of Object.entries(settings.invites.counts)) {
    if (count >= invites.joinsNeeded(settings) && (await notifyEligible(guild, userId))) told++;
  }
  return told;
}

// ----- buttons -----

/** 🌟 Apply for VIP, pressed in their DMs. */
async function dmApplyButton(interaction, guildId) {
  const guild = interaction.client.guilds.cache.get(guildId);
  const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
  if (!member) return interaction.reply({ content: '❌ You’re not in that server any more.' });
  await interaction.deferReply();
  const result = await apply(guild, member);
  return interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
}

/** /applyvip in the server. */
async function applyCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await apply(interaction.guild, interaction.member);
  return interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
}

async function markDecided(interaction, app, { approved, by, reason = null }) {
  const message = interaction.message ?? (await interaction.guild.channels.cache.get(app.channelId)?.messages.fetch(app.messageId).catch(() => null));
  if (!message?.embeds?.[0]) return;
  const embed = EmbedBuilder.from(message.embeds[0]).setColor(approved ? 0x22c55e : 0xed4245);
  const fields = (embed.data.fields ?? []).filter((f) => f.name !== 'Status');
  const status = approved ? `✅ **Approved** by <@${by}> ${ts(Date.now())}` : `❌ **Denied** by <@${by}> ${ts(Date.now())}${reason ? `\n**Reason:** ${truncate(reason, 400)}` : ''}`;
  embed.setFields([...fields, { name: 'Status', value: status }]);
  await message.edit({ embeds: [embed], components: reviewButtons(app.userId ?? 'x', true) }).catch(() => {});
}

/** ✅ Approve / ❌ Deny on an application. Admins only. */
async function reviewButton(interaction, action, userId) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '🚫 Only admins (Administrator) can approve or deny VIP applications.', flags: MessageFlags.Ephemeral });
  const settings = store.guild(interaction.guild.id);
  const app = applications(settings)[userId];
  if (!app || app.status !== 'pending') return interaction.reply({ content: 'ℹ️ This application has already been decided.', flags: MessageFlags.Ephemeral });

  if (action === 'vip-deny') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`oj:vipdenymodal:${userId}`)
        .setTitle('Deny VIP application')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Reason (optional)')
            .setDescription('They’ll see this in a DM')
            .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)),
        ),
    );
  }

  // Claimed straight away, so two admins pressing Approve at the same time can't both go through.
  app.status = 'deciding';
  try {
    return await approve(interaction, settings, app, userId);
  } finally {
    if (app.status === 'deciding') app.status = 'pending'; // something went wrong: it can be pressed again
  }
}

async function approve(interaction, settings, app, userId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const count = invites.joinsBy(settings, userId);
  const needed = invites.joinsNeeded(settings);
  const stillPending = (text) => {
    app.status = 'pending';
    return interaction.editReply(text);
  };
  if (!member) return stillPending('❌ They’re not in the server any more.');
  // Their count can drop while the application waits (people they invited left, or /vip revoke).
  if (count < needed) return stillPending(`❌ They don’t qualify any more: **${count}** of **${needed}** joins now. Deny it, or wait until they’re back at ${needed}.`);
  const given = await invites.giveVip(interaction.guild, member, settings, count, { approvedBy: interaction.user });
  if (!given) return stillPending('❌ I couldn’t give them VIP. Check that the VIP role still exists and is below my role.');

  Object.assign(app, { status: 'approved', decidedAt: Date.now(), decidedBy: interaction.user.id, userId, goal: needed });
  store.save();
  await markDecided(interaction, app, { approved: true, by: interaction.user.id });
  return interaction.editReply(given === 'saved' ? `✅ Approved. <@${userId}> is restricted, so they’ll get VIP when they’re unrestricted.` : `✅ Approved. <@${userId}> now has VIP.`);
}

/** The Deny form was sent. */
async function denyModal(interaction, userId) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '🚫 Only admins (Administrator) can deny VIP applications.', flags: MessageFlags.Ephemeral });
  const settings = store.guild(interaction.guild.id);
  const app = applications(settings)[userId];
  if (!app || app.status !== 'pending') return interaction.reply({ content: 'ℹ️ This application has already been decided.', flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;

  Object.assign(app, { status: 'denied', decidedAt: Date.now(), decidedBy: interaction.user.id, reason, userId });
  store.save();
  await interaction.deferUpdate?.().catch(() => {});
  await markDecided(interaction, app, { approved: false, by: interaction.user.id, reason });

  const user = await interaction.client.users.fetch(userId).catch(() => null);
  await user
    ?.send(
      `❌ **Your VIP application in ${truncate(interaction.guild.name, 80)} was denied.**${reason ? `\n**Reason:** ${truncate(reason, 400)}` : ''}\nYou can apply again ${ts(Date.now() + REAPPLY_HOURS * 3_600_000)}.`,
    )
    .catch(() => {});
  return null;
}

module.exports = { apply, applyCommand, notifyEligible, notifyAllEligible, dmApplyButton, reviewButton, denyModal, cannotApply, isAdmin, REAPPLY_HOURS };
