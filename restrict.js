'use strict';

// Restrict: a moderator hides every channel from someone except #restricted, and a private appeal ticket opens for
// them straight away (only they, admins and the owner can see it — not moderators). In #restricted they can't type,
// but can press a button to open a new ticket after one is closed.
// Mods can use /restrict, the Restrict button on a case, or just give someone the Restricted role in Discord.

const {
  ActionRowBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits: P,
} = require('discord.js');
const config = require('../config');
const store = require('./store');
const { fetchLogChannel, postCaseLog, refreshCaseLog } = require('./caseLog');
const { canModerate, exclusive, inBatches, isTemporary, truncate, ts } = require('./util');

const TICKET_PERMISSIONS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

// What the Restricted role can do in #restricted: read it, but not type, react, make threads or use commands.
const IN_RESTRICTED_CHANNEL = {
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: false,
  AddReactions: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  SendMessagesInThreads: false,
  UseApplicationCommands: false,
};
const restrictedChannelFlags = (allowed) =>
  Object.entries(IN_RESTRICTED_CHANNEL)
    .filter(([, value]) => value === allowed)
    .map(([name]) => P[name]);

function reply(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
}

function appealPanel() {
  return {
    embeds: [new EmbedBuilder().setColor(0x747f8d).setTitle('🚷 You have been restricted').setDescription(config.restrict.message)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('oj:appeal-open').setEmoji('📩').setLabel('Open an appeal ticket').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// The Appeals categories (Appeals, then Appeals 2, 3... once one is full).
const appealCategoryIds = (saved) => [saved.categoryId, ...(saved.extraCategoryIds ?? [])].filter(Boolean);

// #restricted, the Appeals categories, and appeal tickets inside them.
function isRestrictSpace(channel, saved) {
  if (channel.id === saved.channelId) return true;
  return appealCategoryIds(saved).some((id) => channel.id === id || channel.parentId === id);
}

function modRoleOverwrite(guild, settings, allow) {
  return settings.modRoleId && guild.roles.cache.has(settings.modRoleId) ? [{ id: settings.modRoleId, type: OverwriteType.Role, allow }] : [];
}

/**
 * Only the person appealing, the owner and Administrators can see appeals. Anyone else let into the Appeals categories
 * or a ticket — a role or person added by hand, or the mod role, Manage Server roles or trusted users an older version
 * let in — loses it (@everyone is shut out again if someone let it in). Runs at startup and every 10 minutes (see
 * modGuard.guardStaffChannels). Returns what was taken away, e.g. ['<@&123> from <#456>'].
 */
async function lockAppeals(guild) {
  const settings = store.guild(guild.id);
  const categories = appealCategoryIds(settings.restrict);
  if (!categories.length) return [];
  const appellants = new Map(); // ticket -> who it's for
  for (const [userId, r] of Object.entries(settings.restricted)) if (r.ticketChannelId) appellants.set(r.ticketChannelId, userId);
  const reason = 'O Jailbreak: appeals are for the owner and admins only';
  const removed = [];
  for (const ch of [...guild.channels.cache.values()]) {
    if (!categories.includes(ch.id) && !categories.includes(ch.parentId)) continue;
    const appellant = appellants.get(ch.id) ?? /\((\d{15,21})\)$/.exec(ch.topic ?? '')?.[1] ?? null;
    for (const o of [...(ch.permissionOverwrites?.cache.values() ?? [])]) {
      if (!o.allow?.has(P.ViewChannel)) continue;
      let label;
      if (o.id === guild.id) {
        label = '@everyone';
      } else if (o.type === OverwriteType.Member) {
        if (o.id === appellant || o.id === guild.client.user.id) continue;
        const m = guild.members.cache.get(o.id);
        if (m && (m.id === guild.ownerId || m.user?.bot || m.permissions?.has(P.Administrator))) continue;
        label = `<@${o.id}>`;
      } else {
        const role = guild.roles.cache.get(o.id);
        if (role && (role.tags?.botId || role.permissions?.has(P.Administrator))) continue;
        label = `<@&${o.id}>`;
      }
      const ok = await ch.permissionOverwrites.edit(o.id, { ViewChannel: o.id === guild.id ? false : null }, { reason, type: o.type }).then(
        () => true,
        () => false,
      );
      if (ok) removed.push(`${label} from ${ch}`);
    }
  }
  return removed;
}

const PERMISSION_FIX = 'Fix: **Server Settings → Roles → O Jailbreak** → turn on **Administrator**, and drag **O Jailbreak** to the top of the list.';

// Turns Discord's errors into something a server owner can act on.
function explain(err) {
  if (err?.friendly) return err.friendly;
  if (err?.code === 50013 || err?.code === 50001) return `I’m missing permissions. ${PERMISSION_FIX}`;
  if (isTemporary(err)) return `Discord didn’t respond (${err.message}). Try again in a minute.`;
  return err?.message ?? String(err);
}

function permissionProblem(guild) {
  const me = guild.members.me;
  if (me?.permissions.has([P.ManageRoles, P.ManageChannels])) return null;
  return `I don’t have permission to make the **${config.restrict.roleName}** role and **#${config.restrict.channelName}** channel. ${PERMISSION_FIX}`;
}

// Someone may have already made a "Restricted" role by hand; use it rather than adding a second one.
function findExistingRole(guild) {
  const name = config.restrict.roleName.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === name && r.id !== guild.id && !r.managed && r.editable && !r.permissions.has(P.Administrator)) ?? null;
}

// True if the channel already says whether the Restricted role can see it (hidden by us, or allowed on purpose by an admin).
function visibilityDecided(channel, roleId) {
  const overwrite = channel.permissionOverwrites.cache.get(roleId);
  return Boolean(overwrite && (overwrite.allow.has(P.ViewChannel) || overwrite.deny.has(P.ViewChannel)));
}

/**
 * Makes sure the Restricted role and #restricted channel exist, and that every other channel is hidden
 * from the Restricted role. Runs at startup, on /setup, and before every restrict (only fixing what's missing).
 */
function ensureSetup(guild) {
  return exclusive(guild.id, async () => {
    const problem = permissionProblem(guild);
    if (problem) throw Object.assign(new Error(problem), { friendly: problem });

    const settings = store.guild(guild.id);
    const saved = settings.restrict;
    const reason = 'O Jailbreak: setting up restrictions';

    let role = saved.roleId ? guild.roles.cache.get(saved.roleId) : null;
    if (!role) {
      const replacingDeleted = Boolean(saved.roleId);
      role = findExistingRole(guild) ?? (await guild.roles.create({ name: config.restrict.roleName, permissions: [], hoist: false, mentionable: false, reason }));
      saved.roleId = role.id;
      store.save();
      // The old role was deleted, which let restricted people see channels again: put them under the new one.
      if (replacingDeleted) {
        for (const userId of Object.keys(settings.restricted)) {
          const member = await guild.members.fetch(userId).catch(() => null);
          await member?.roles.add(role, 'O Jailbreak: still restricted (the Restricted role was re-made)').catch(() => {});
        }
      }
    }

    let channel = saved.channelId ? guild.channels.cache.get(saved.channelId) : null;
    if (!channel) {
      channel = await guild.channels.create({
        name: config.restrict.channelName,
        type: ChannelType.GuildText,
        position: 0,
        topic: 'Restricted members can appeal here.',
        reason,
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
          { id: role.id, type: OverwriteType.Role, allow: restrictedChannelFlags(true), deny: restrictedChannelFlags(false) },
          ...modRoleOverwrite(guild, settings, [P.ViewChannel, P.ReadMessageHistory]),
        ],
      });
      saved.channelId = channel.id;
      saved.messageId = null;
      store.save();
    } else if (!channel.permissionOverwrites.cache.get(role.id)?.allow.has(P.ViewChannel)) {
      // The role was re-made, so #restricted needs to let the new one in.
      await channel.permissionOverwrites.edit(role.id, IN_RESTRICTED_CHANNEL, { reason, type: OverwriteType.Role });
    }

    // Put the appeal button back if it was never posted or someone deleted it.
    const panel = saved.messageId ? await channel.messages.fetch(saved.messageId).catch((err) => (err.code === 10008 ? null : true)) : null;
    if (!panel) {
      saved.messageId = (await channel.send(appealPanel())).id;
      store.save();
    }

    // Also catches channels made while the bot was offline.
    const targets = [...guild.channels.cache.values()].filter(
      (ch) => ch.permissionOverwrites && !isRestrictSpace(ch, saved) && !visibilityDecided(ch, role.id),
    );
    const notHidden = [];
    await inBatches(targets, 5, async (ch) => {
      await ch.permissionOverwrites.edit(role.id, { ViewChannel: false }, { reason, type: OverwriteType.Role }).catch(() => notHidden.push(`#${ch.name}`));
    });
    if (notHidden.length) console.warn(`[restrict] ${guild.name}: couldn't hide ${notHidden.join(', ')} from the Restricted role`);
    saved.sweptAt = Date.now();

    store.save();
    return { role, channel, notHidden };
  });
}

/**
 * Sets up restrictions ahead of time (at startup and on /setup) so the role exists before anyone needs it.
 * If Discord doesn't respond it tries again a bit later (up to `retries` times); if something needs fixing,
 * it says how in the mod log.
 */
async function prepare(guild, { tellModLog = true, retries = 0, retryDelayMs = 60_000 } = {}) {
  try {
    return { ok: true, ...(await ensureSetup(guild)) };
  } catch (err) {
    const text = explain(err);
    if (isTemporary(err)) {
      const again = retries > 0 ? ' Trying again in a minute.' : '';
      console.warn(`[restrict] ${guild.name}: couldn't set up the Restricted role yet, Discord didn't respond (${err.message}).${again}`);
      if (retries > 0) {
        setTimeout(() => prepare(guild, { tellModLog, retries: retries - 1, retryDelayMs }), retryDelayMs).unref?.();
      }
      return { ok: false, text };
    }
    console.warn(`[restrict] ${guild.name}: couldn't set up the Restricted role: ${err.message}`);
    if (tellModLog) {
      const log = await fetchLogChannel(guild);
      await log?.send({ content: `⚠️ **Restrict won’t work yet.** ${text}\nThen restart me or run \`/setup\` again.`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return { ok: false, text };
  }
}

/**
 * Saves and removes the member's roles, gives them the Restricted role, and logs it.
 * `proof` (optional): { excerpt, channelId } — what they posted, shown on the case.
 */
async function restrictMember({ guild, member, moderator, reason, proof = null, appealTicket = true }) {
  const settings = store.guild(guild.id);
  if (settings.restricted[member.id]) return { ok: false, text: `ℹ️ ${member} is already restricted.` };
  if (member.user.bot) return { ok: false, text: '❌ Bots can’t be restricted.' };
  if (member.permissions.has(P.Administrator)) return { ok: false, text: '❌ Admins can’t be restricted — they can see every channel anyway.' };

  let setup;
  try {
    setup = await ensureSetup(guild);
  } catch (err) {
    return { ok: false, text: `❌ Couldn't set up restrictions: ${explain(err)}` };
  }
  const { role, channel } = setup;

  const auditReason = truncate(`O Jailbreak • restricted by ${moderator.tag}: ${reason}`, 512);
  const others = member.roles.cache.filter((r) => r.id !== guild.id && r.id !== role.id);
  const removable = others.filter((r) => !r.managed && r.editable);
  const tooHigh = others.filter((r) => !r.managed && !r.editable);
  const mustKeep = others.filter((r) => !removable.has(r.id)).map((r) => r.id);

  // Saved before their roles change, so auto-role can't hand the Member role straight back.
  const record = { by: moderator.id, reason, at: Date.now(), roles: [...removable.keys()], caseId: null, ticketChannelId: null, lastAppealClosedAt: null };
  settings.restricted[member.id] = record;
  try {
    await member.roles.set([...mustKeep, role.id], auditReason);
  } catch (err) {
    delete settings.restricted[member.id];
    return { ok: false, text: `❌ Couldn't restrict them: ${explain(err)}` };
  }

  const actions = [`🚷 Can only see <#${channel.id}> now`, `🧹 Removed ${removable.size} role(s) (saved for when they're unrestricted)`];
  const warning = tooHigh.size
    ? `⚠️ I couldn't take away ${tooHigh.map((r) => `**${r.name}**`).join(', ')} because it's above my role, so they might still see some channels. Drag **O Jailbreak** to the top in Server Settings → Roles.`
    : null;
  if (warning) actions.push(warning);
  if (member.isCommunicationDisabled()) {
    // A timed-out person couldn't type in their appeal ticket.
    await member.timeout(null, 'O Jailbreak: restricted instead, so they can appeal').then(
      () => actions.push('🔊 Timeout removed so they can appeal'),
      () => {},
    );
  }
  await guild.members.edit(member.id, { channel: null, reason: auditReason }).catch(() => {}); // out of voice chat, if they're in one

  const c = store.createCase(guild.id, {
    type: 'RESTRICT',
    label: 'Restricted',
    trigger: reason,
    userId: member.id,
    userTag: member.user.tag,
    avatarUrl: member.user.displayAvatarURL({ size: 128 }),
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    actionNote: actions.join('\n'),
    accountCreatedAt: member.user.createdTimestamp,
    joinedAt: member.joinedTimestamp,
    ...(proof ? { channelId: proof.channelId ?? null, excerpt: proof.excerpt == null ? null : truncate(proof.excerpt, 1500) } : {}),
  });
  record.caseId = c.id;
  store.save();
  await postCaseLog(guild, c);

  // Their appeal ticket, straight away.
  const ticket = appealTicket ? await openTicketFor(guild, member) : null;
  await member
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x747f8d)
          .setTitle(truncate(`You were restricted in ${guild.name}`, 256))
          .setDescription(
            `**Reason:** ${truncate(reason, 500)}\n\n${ticket ? `If you think this was a mistake, explain in your appeal ticket: ${ticket}` : `You can only see <#${channel.id}> for now. If you think this was a mistake, you can appeal there.`}`,
          ),
      ],
    })
    .catch(() => {});

  const text = [`🚷 Restricted ${member}. They can only see ${channel}${ticket ? ' and their appeal ticket (opened for them)' : ' and can appeal there'}.`, warning].filter(Boolean).join('\n');
  return { ok: true, text, case: c };
}

/**
 * Gives back the saved roles, removes the Restricted role, closes any appeal ticket, and updates the case.
 */
async function unrestrictMember({ guild, userId, moderator, reason = null }) {
  const settings = store.guild(guild.id);
  const record = settings.restricted[userId];
  const auditReason = truncate(`O Jailbreak • unrestricted by ${moderator.tag}${reason ? `: ${reason}` : ''}`, 512);
  const member = await guild.members.fetch(userId).catch(() => null);

  if (!record) {
    // They only have the role (given while I was offline, or before I was set up): just take it off.
    const roleId = settings.restrict.roleId;
    if (!member || !roleId || !member.roles.cache.has(roleId)) return { ok: false, text: `ℹ️ <@${userId}> isn’t restricted.` };
    try {
      await member.roles.remove(roleId, auditReason);
    } catch (err) {
      return { ok: false, text: `❌ Couldn't unrestrict them: ${explain(err)}` };
    }
    return { ok: true, text: `🔓 Took the Restricted role off <@${userId}>.` };
  }

  const lines = [];
  if (member) {
    const giveBack = record.roles.filter((id) => guild.roles.cache.get(id)?.editable);
    const current = member.roles.cache.filter((r) => r.id !== guild.id && r.id !== settings.restrict.roleId).map((r) => r.id);
    try {
      await member.roles.set([...new Set([...current, ...giveBack])], auditReason);
    } catch (err) {
      return { ok: false, text: `❌ Couldn't unrestrict them: ${explain(err)}` };
    }
    lines.push(`🎭 Gave back ${giveBack.length} role(s).`);
    const missing = record.roles.length - giveBack.length;
    if (missing > 0) lines.push(`⚠️ ${missing} role(s) no longer exist or are above my role.`);
  } else {
    lines.push('They’re not in the server right now, so they won’t be restricted if they come back.');
  }

  delete settings.restricted[userId];
  store.save();

  if (record.ticketChannelId) await closeTicket(guild, { channelId: record.ticketChannelId, userId, moderator, outcome: 'Unrestricted' });
  const c = record.caseId ? store.getCase(guild.id, record.caseId) : null;
  if (c) {
    store.updateCase(guild.id, c.id, { status: 'UNRESTRICTED', resolvedBy: moderator.id, resolvedAt: Date.now(), resolutionNote: reason });
    await refreshCaseLog(guild, c);
  }
  if (member) await member.send(`🔓 You’ve been unrestricted in **${guild.name}** — welcome back!`).catch(() => {});

  return { ok: true, text: [`🔓 Unrestricted <@${userId}>.`, ...lines].join('\n') };
}

// ----- appeal tickets -----

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'member';
}

/**
 * An Appeals category with room for another ticket (Discord allows 50 channels per category): Appeals, then
 * Appeals 2, 3... Only the owner and admins can see them — moderators can't see appeals.
 */
async function ensureAppealsCategory(guild, settings) {
  const saved = settings.restrict;
  saved.extraCategoryIds = (saved.extraCategoryIds ?? []).filter((id) => guild.channels.cache.has(id));
  const existing = appealCategoryIds(saved).map((id) => guild.channels.cache.get(id)).filter(Boolean);
  const roomy = existing.find((cat) => guild.channels.cache.filter((c) => c.parentId === cat.id).size < 50);
  if (roomy) return roomy;
  const category = await guild.channels
    .create({
      name: existing.length ? `${config.restrict.appealsCategoryName} ${existing.length + 1}` : config.restrict.appealsCategoryName,
      type: ChannelType.GuildCategory,
      reason: 'O Jailbreak: appeal tickets',
      permissionOverwrites: [{ id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] }],
    })
    .catch(() => null);
  if (category) {
    if (!saved.categoryId || !guild.channels.cache.has(saved.categoryId)) saved.categoryId = category.id;
    else saved.extraCategoryIds.push(category.id);
    store.save();
  }
  return category;
}

async function transcript(channel) {
  const messages = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 }).catch(() => null);
    if (!batch?.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.reverse();

  const lines = [`Appeal transcript — #${channel.name}`, `Saved ${new Date().toISOString()}`, ''];
  for (const m of messages) {
    const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const extras = [
      ...(m.embeds ?? []).map((e) => `[box: ${e.title ?? truncate(e.description ?? '', 60)}]`),
      ...[...(m.attachments?.values() ?? [])].map((a) => `[file: ${a.url}]`),
    ];
    lines.push(`[${time}] ${m.author?.tag ?? 'unknown'}: ${m.content ?? ''} ${extras.join(' ')}`.trimEnd());
  }
  return lines.join('\n');
}

async function closeTicket(guild, { channelId, userId, moderator, outcome }) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const log = await fetchLogChannel(guild);
  await log
    ?.send({
      content: `📩 Appeal from <@${userId}> closed by <@${moderator.id}> — **${outcome}**`,
      files: [new AttachmentBuilder(Buffer.from(await transcript(channel), 'utf8'), { name: `appeal-${userId}.txt` })],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});

  await channel.send(`🔒 This appeal is closed (**${outcome}**) and the channel will be deleted shortly.`).catch(() => {});
  const remove = () => channel.delete(truncate(`O Jailbreak: appeal closed by ${moderator.tag}`, 512)).catch(() => {});
  if (config.restrict.ticketDeleteSeconds > 0) setTimeout(remove, config.restrict.ticketDeleteSeconds * 1000).unref();
  else await remove();
}

async function openAppeal(interaction) {
  const { guild, user } = interaction;
  const settings = store.guild(guild.id);
  let record = settings.restricted[user.id];
  if (!record && settings.restrict.roleId && interaction.member.roles.cache.has(settings.restrict.roleId)) {
    // Given the role while I was offline: still let them appeal.
    record = settings.restricted[user.id] = {
      by: null,
      reason: 'Given the Restricted role',
      at: Date.now(),
      roles: [],
      caseId: null,
      ticketChannelId: null,
      lastAppealClosedAt: null,
    };
    store.save();
  }
  if (!record) return reply(interaction, 'ℹ️ You’re not restricted, so there’s nothing to appeal.');

  const open = record.ticketChannelId ? await reopenTicketFor(interaction.member, record) : null;
  if (open) return reply(interaction, `📩 You already have an appeal open: ${open}`);
  const nextAllowed = (record.lastAppealClosedAt ?? 0) + config.restrict.appealCooldownHours * 3_600_000;
  if (Date.now() < nextAllowed) return reply(interaction, `⏳ Your last appeal was closed. You can open a new one ${ts(nextAllowed)}.`);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let channel;
  try {
    channel = await openTicket(guild, user, record, { opened: 'opened an appeal' });
  } catch (err) {
    return reply(interaction, `❌ Couldn't open a ticket: ${err.message}`);
  }
  return reply(interaction, `✅ Your appeal ticket is open: ${channel} — explain what happened there and someone from the team will reply.`);
}

/**
 * Makes someone's appeal ticket: only they, the owner and Administrators can see it (not moderators). Used when they press
 * "Open an appeal", and straight away when they're restricted. Throws if Discord won't make the channel.
 */
async function openTicket(guild, user, record, { opened = 'was restricted — appeal opened automatically' } = {}) {
  const settings = store.guild(guild.id);
  // One at a time per server, so two restrictions at once can't both make an Appeals category or overfill one.
  const channel = await exclusive(`appeals:${guild.id}`, async () => {
    const category = await ensureAppealsCategory(guild, settings);
    return guild.channels.create({
      name: `appeal-${slug(user.username)}`,
      type: ChannelType.GuildText,
      parent: category?.id ?? null,
      topic: `Appeal from ${user.tag} (${user.id})`,
      reason: `O Jailbreak: appeal from ${user.tag}`,
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        { id: user.id, type: OverwriteType.Member, allow: TICKET_PERMISSIONS },
      ],
    });
  });
  record.ticketChannelId = channel.id;
  store.save();

  await channel
    .send({
      content: `<@${user.id}>`,
      allowedMentions: { users: [user.id] },
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📩 Appeal')
          .setDescription(`Hi <@${user.id}> — explain why you think you shouldn’t be restricted, and someone from the team will reply here.`)
          .addFields(
            { name: 'Restricted by', value: record.by ? `<@${record.by}>` : 'Unknown', inline: true },
            { name: 'When', value: ts(record.at), inline: true },
            { name: 'Reason', value: truncate(record.reason || 'No reason given', 1024) },
          ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`oj:appeal-unrestrict:${user.id}`).setEmoji('🔓').setLabel('Unrestrict').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`oj:appeal-close:${user.id}`).setEmoji('🔒').setLabel('Close appeal (stay restricted)').setStyle(ButtonStyle.Secondary),
        ),
      ],
    })
    .catch(() => {});

  // Restricted for being in a blocked server: tell them to leave it first.
  for (const blocked of blockedServersFor(settings, record)) await channel.send({ embeds: [leaveServerNotice(blocked)] }).catch(() => {});
  // …and a 🔄 Recheck button: are they still in it?
  const recheck = require('./appealRecheck');
  if (recheck.fromBlockedServer(settings, record) && (await channel.send(recheck.recheckMessage(user.id)).then(() => true, () => false))) {
    record.recheckPosted = true;
    store.save();
  }

  const log = await fetchLogChannel(guild);
  await log?.send({ content: `📩 **${user.tag}** ${opened}: ${channel}`, allowedMentions: { parse: [] } }).catch(() => {});
  return channel;
}

/** Opens the appeal ticket for someone just restricted (if they don't have one). Returns the ticket, or null. */
async function openTicketFor(guild, member) {
  const record = store.guild(guild.id).restricted[member.id];
  if (!record || record.ticketChannelId) return null;
  return openTicket(guild, member.user, record).catch((err) => {
    console.warn(`[restrict] ${guild.name}: couldn't open an appeal ticket for ${member.user.tag}: ${err.message}`);
    return null;
  });
}

/**
 * The blocked server(s) someone was restricted for. Restrictions from before this was saved are recognised by their
 * reason ("Please make a ticket") and get every blocked server.
 */
function blockedServersFor(settings, record) {
  if (Array.isArray(record.blockedServers)) return record.blockedServers;
  const reason = config.blockedServers?.restrictReason || 'Please make a ticket';
  if (record.reason !== reason) return [];
  return Object.entries(settings.blockedServers ?? {}).map(([id, e]) => ({ id, name: e.name, icon: e.icon ?? null }));
}

/** In the appeal ticket of someone restricted for being in a blocked server: leave it, then wait for the team. */
function leaveServerNotice({ name, icon }) {
  const server = truncate(name ?? 'a blocked', 100);
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(truncate(`🚫 ${name ?? 'Blocked server'}`, 256))
    .setDescription(
      [
        `**You are restricted because you are in the ${server} server.** Please leave that Discord to be a part of our community.`,
        'When you’ve left, please wait patiently for our team to review and confirm.',
        '',
        `🇷🇺 **Вы ограничены, потому что состоите на сервере ${server}.** Пожалуйста, покиньте этот Discord-сервер, чтобы быть частью нашего сообщества.`,
        'Когда выйдете, пожалуйста, терпеливо подождите, пока наша команда всё проверит и подтвердит.',
      ].join('\n'),
    );
  if (icon) embed.setThumbnail(icon);
  return embed;
}

// Buttons: oj:appeal-open (in #restricted), oj:appeal-unrestrict:<userId> and oj:appeal-close:<userId> (in a ticket).
async function appealButton(interaction, action, userId) {
  if (action === 'appeal-open') return openAppeal(interaction);

  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return reply(interaction, '🚫 Only moderators can do that.');
  const record = settings.restricted[userId];

  if (action === 'appeal-unrestrict') {
    if (!require('./modGuard').isAdmin(interaction.member)) return reply(interaction, '🚫 Only admins and the owner can unrestrict people.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!record) {
      await closeTicket(guild, { channelId: interaction.channelId, userId, moderator: interaction.user, outcome: 'Already unrestricted' });
      return reply(interaction, 'ℹ️ They were already unrestricted, so I closed the ticket.').catch(() => {});
    }
    const result = await unrestrictMember({ guild, userId, moderator: interaction.user, reason: 'Appeal accepted' });
    return reply(interaction, result.text).catch(() => {}); // the ticket channel may already be gone
  }

  if (action === 'appeal-close') {
    if (!require('./modGuard').isAdmin(interaction.member)) return reply(interaction, '🚫 Only admins and the owner can close an appeal.');
    const channelId = record?.ticketChannelId ?? interaction.channelId;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (record) {
      record.ticketChannelId = null;
      record.lastAppealClosedAt = Date.now();
      store.save();
    }
    await closeTicket(guild, { channelId, userId, moderator: interaction.user, outcome: 'Still restricted' });
    const member = await guild.members.fetch(userId).catch(() => null);
    await member
      ?.send(`🔒 Your appeal in **${guild.name}** was closed and you’re still restricted. You can appeal again in ${config.restrict.appealCooldownHours} hours.`)
      .catch(() => {});
    return reply(interaction, `🔒 Appeal closed. They stay restricted and can appeal again in ${config.restrict.appealCooldownHours} hours.`).catch(() => {});
  }
  return null;
}

// ----- restricted people never hold other roles -----

// Discord lets any role that's allowed into a channel beat the Restricted role's "can't see", so a restricted person
// who picked up VIP (or a level reward) would see those channels again. They're only ever meant to have Restricted.

/** Saves roles someone earned while restricted, so they get them when unrestricted. True if they're restricted. */
function saveForLater(guild, userId, roleIds) {
  const record = store.guild(guild.id).restricted[userId];
  if (!record) return false;
  record.roles = [...new Set([...record.roles, ...roleIds])];
  store.save();
  return true;
}

/** Takes any role but Restricted off a restricted member (whoever gave it), and saves it for when they're unrestricted. */
async function holdBackRoles(member) {
  const settings = store.guild(member.guild.id);
  const roleId = settings.restrict.roleId;
  // Only while they actually have the Restricted role, so roles given back by unrestricting are left alone.
  if (!settings.restricted[member.id] || !roleId || !member.roles.cache.has(roleId)) return [];
  const extra = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== roleId && !r.managed && r.editable);
  if (!extra.size) return [];

  saveForLater(member.guild, member.id, [...extra.keys()]);
  const removed = await member.roles.remove([...extra.keys()], 'O Jailbreak: restricted members can’t have other roles (saved for when they’re unrestricted)').then(
    () => true,
    (err) => {
      console.warn(`[restrict] Couldn't take roles off restricted ${member.user.tag}: ${err.message}`);
      return false;
    },
  );
  if (!removed) return [];
  const log = await fetchLogChannel(member.guild);
  await log
    ?.send({
      content: truncate(
        `🚷 <@${member.id}> is restricted, so I took ${extra.map((r) => `**${r.name}**`).join(', ')} back off them. They’ll get it when they’re unrestricted.`,
        2000,
      ),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return [...extra.keys()];
}

/** At startup: anyone restricted who picked up roles while the bot was off has them taken back off. */
async function sweepRestrictedRoles(guild) {
  for (const userId of Object.keys(store.guild(guild.id).restricted)) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) await holdBackRoles(member);
  }
}

// ----- events -----

// Someone who leaves and rejoins while restricted gets the Restricted role straight back.
async function reapplyIfRestricted(member) {
  const settings = store.guild(member.guild.id);
  const record = settings.restricted[member.id];
  if (!record || !settings.restrict.roleId) return false;
  await member.roles.add(settings.restrict.roleId, 'O Jailbreak: still restricted (left and rejoined)').catch((err) => {
    console.warn(`[restrict] Couldn't re-restrict ${member.user.tag}: ${err.message}`);
  });
  // Discord removes their access to their appeal ticket when they leave: give it back.
  const ticket = await reopenTicketFor(member, record);
  const log = await fetchLogChannel(member.guild);
  await log
    ?.send({ content: `🚷 **${member.user.tag}** left and rejoined — they’re still restricted.${ticket ? ` They can see their appeal ${ticket} again.` : ''}`, allowedMentions: { parse: [] } })
    .catch(() => {});
  return true;
}

/**
 * Discord deletes a person's own channel permissions when they leave, so someone who rejoins can't see their appeal
 * ticket any more. This gives it back (and says so in the ticket). Returns the ticket, or null if there isn't one.
 */
async function reopenTicketFor(member, record) {
  if (!record?.ticketChannelId) return null;
  const channel = member.guild.channels.cache.get(record.ticketChannelId);
  if (!channel) {
    record.ticketChannelId = null; // deleted while they were gone: they can open a new one
    store.save();
    return null;
  }
  if (channel.permissionsFor?.(member)?.has(P.ViewChannel)) return channel;
  const allow = Object.fromEntries(TICKET_PERMISSIONS.map((p) => [Object.keys(P).find((k) => P[k] === p), true]));
  await channel.permissionOverwrites
    .edit(member.id, allow, { reason: 'O Jailbreak: rejoined with an appeal open', type: OverwriteType.Member })
    .catch((err) => console.warn(`[restrict] Couldn't give ${member.user.tag} their appeal back: ${err.message}`));
  await channel.send({ content: `↩️ <@${member.id}> rejoined — they can see this appeal again.`, allowedMentions: { users: [member.id] } }).catch(() => {});
  return channel;
}

/** Someone with an open appeal was banned (by the bot, /massban, or in Discord itself): the ticket closes as "Banned". */
async function onBanAdd(ban) {
  const guild = ban.guild;
  const record = store.guild(guild.id).restricted[ban.user.id];
  if (!record?.ticketChannelId) return;
  const channelId = record.ticketChannelId;
  record.ticketChannelId = null;
  store.save();
  // Who banned them, from the audit log (written a moment after the ban).
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const logs = await guild.fetchAuditLogs?.({ type: AuditLogEvent.MemberBanAdd, limit: 5 }).catch(() => null);
  const executor = logs?.entries.find((e) => e.target?.id === ban.user.id)?.executor ?? guild.client.user;
  await closeTicket(guild, { channelId, userId: ban.user.id, moderator: executor, outcome: 'Banned' });
}

// New channels are hidden from the Restricted role automatically.
async function onChannelCreate(channel) {
  if (!channel.guild || !channel.permissionOverwrites) return;
  const { restrict } = store.guild(channel.guild.id);
  if (!restrict.roleId || !channel.guild.roles.cache.has(restrict.roleId)) return;
  if (isRestrictSpace(channel, restrict) || visibilityDecided(channel, restrict.roleId)) return;
  await channel.permissionOverwrites
    .edit(restrict.roleId, { ViewChannel: false }, { reason: 'O Jailbreak: hide new channel from restricted members', type: OverwriteType.Role })
    .catch((err) => console.warn(`[restrict] Couldn't hide #${channel.name} from the Restricted role: ${err.message}`));
}

// Someone gave or took away the Restricted role in Discord itself (not through O Jailbreak).
async function onAuditLogEntry(entry, guild) {
  if (entry.action !== AuditLogEvent.MemberRoleUpdate) return;
  const { executorId, targetId } = entry;
  if (!executorId || !targetId || executorId === guild.client.user.id) return;
  const settings = store.guild(guild.id);
  const roleId = settings.restrict.roleId;
  if (!roleId) return;

  const touched = (key) => (entry.changes.find((c) => c.key === key)?.new ?? []).some((r) => r.id === roleId);
  const added = touched('$add');
  const removed = touched('$remove');
  if (!added && !removed) return;
  const moderator = entry.executor ?? (await guild.client.users.fetch(executorId).catch(() => null));
  if (!moderator) return;
  const reason = entry.reason ?? null;

  // Taking the role off = unrestrict (their saved roles come back).
  if (removed) {
    if (!settings.restricted[targetId]) return;
    const result = await unrestrictMember({ guild, userId: targetId, moderator, reason: reason ?? 'Restricted role taken off' });
    if (!result.ok) console.warn(`[restrict] ${guild.name}: ${result.text}`);
    return;
  }

  // Giving the role = restrict properly (save and remove their other roles, log a case, DM them).
  if (settings.restricted[targetId]) return;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return;
  const giver = await guild.members.fetch(executorId).catch(() => null);
  const everyone = guild.roles.cache.get(guild.id);
  const theirTop = member.roles.cache.filter((r) => r.id !== roleId).reduce((top, r) => (r.comparePositionTo(top) > 0 ? r : top), everyone);

  let result;
  if (executorId !== guild.ownerId && giver && theirTop.comparePositionTo(giver.roles.highest) >= 0) {
    result = { ok: false, text: 'you can only restrict people whose highest role is below yours.' };
  } else {
    result = await restrictMember({ guild, member, moderator, reason: reason ?? 'Given the Restricted role' });
  }
  if (result.ok) return;

  // It couldn't be applied properly, so don't leave a half-restricted person behind.
  await member.roles.remove(roleId, 'O Jailbreak: undoing a Restricted role that couldn’t be applied').catch(() => {});
  const log = await fetchLogChannel(guild);
  await log
    ?.send({
      content: truncate(`↩️ <@${executorId}> gave <@${targetId}> the Restricted role, but I took it off again: ${result.text.replace(/^[❌ℹ️\s]+/u, '')}`, 2000),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

module.exports = {
  leaveServerNotice,
  blockedServersFor,
  ensureSetup,
  prepare,
  restrictMember,
  unrestrictMember,
  appealButton,
  reapplyIfRestricted,
  onChannelCreate,
  onAuditLogEntry,
  onBanAdd,
  reopenTicketFor,
  openTicketFor,
  appealCategoryIds,
  isRestrictSpace,
  lockAppeals,
  saveForLater,
  holdBackRoles,
  sweepRestrictedRoles,
};
