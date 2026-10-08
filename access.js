'use strict';

// /access: who can see what most members can't, and why.
//   /access user:@someone → every private channel they can see, grouped by the reason (Administrator through a role,
//     a role that's let into the channel, or a permission given to them personally). Staff channels (the logs, the mod
//     log, #mod-watch, #ban-list, appeals and /modhide channels) are marked ⚠️. A button takes away their personal
//     access; access through a role has to be fixed by taking the role off them, or off the channel.
//   /access → the whole server: who has Administrator or Manage Server, who's on the trusted list, and who has been
//     let into the staff channels without being an admin.
// Owner and admins only.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const store = require('./store');
const { fetchLogChannel } = require('./caseLog');
const { ephemeral, truncate, who } = require('./util');

const modGuard = () => require('./modGuard');
const NOT_CHANNELS = new Set([ChannelType.GuildCategory, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
const isBotRole = (role) => Boolean(role?.tags?.botId);
const allowsView = (overwrite) => Boolean(overwrite?.allow?.has(P.ViewChannel));

/** Channels @everyone can't see, in the order Discord lists them. */
function privateChannels(guild) {
  const everyone = guild.roles.cache.get(guild.id);
  const order = (ch) => [guild.channels.cache.get(ch.parentId)?.rawPosition ?? ch.rawPosition ?? 0, ch.parentId ? 1 : 0, ch.rawPosition ?? 0];
  return [...guild.channels.cache.values()]
    .filter((ch) => !NOT_CHANNELS.has(ch.type) && ch.permissionsFor && everyone && !ch.permissionsFor(everyone)?.has(P.ViewChannel))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
}

/** Why they can see this channel: a list of { kind: 'personal' | 'role' | 'other', role? }, or null if they can't. */
function reasonsFor(channel, member) {
  if (!channel.permissionsFor(member)?.has(P.ViewChannel)) return null;
  const reasons = [];
  if (allowsView(channel.permissionOverwrites.cache.get(member.id))) reasons.push({ kind: 'personal' });
  for (const role of member.roles.cache.values()) {
    if (role.id !== member.guild.id && allowsView(channel.permissionOverwrites.cache.get(role.id))) reasons.push({ kind: 'role', role });
  }
  return reasons.length ? reasons : [{ kind: 'other' }];
}

const membersWith = (guild, role) => [...guild.members.cache.values()].filter((m) => m.roles.cache.has(role.id) && !m.user?.bot);
const mentionList = (ids, max = 15) => `${ids.slice(0, max).join(', ')}${ids.length > max ? ` +${ids.length - max} more` : ''}`;

/** Their own appeal ticket (they're meant to see it). */
const ownTicket = (settings, userId) => settings.restricted?.[userId]?.ticketChannelId ?? null;

/** Private channels someone was let into personally (not counting their own appeal ticket). */
function personalAccess(guild, member) {
  const ticket = ownTicket(store.guild(guild.id), member.id);
  return privateChannels(guild).filter((ch) => ch.id !== ticket && allowsView(ch.permissionOverwrites.cache.get(member.id)));
}

function memberReport(guild, member) {
  const settings = store.guild(guild.id);
  const staff = new Set(modGuard().hiddenChannelIds(guild));
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(truncate(`🔎 What ${member.user.tag} can see`, 256));
  const lines = [];
  const isOwner = member.id === guild.ownerId;
  const status = isOwner ? 'the server owner' : modGuard().isAdmin(member) ? 'an admin' : modGuard().isLimitedMod(member, settings) ? 'a moderator' : 'a regular member';
  lines.push(`${who(member)} — I treat them as **${status}**.`);
  const adminRoles = [...member.roles.cache.values()].filter((r) => r.id !== guild.id && r.permissions?.has(P.Administrator));
  if (adminRoles.length) {
    lines.push(`⚠️ **Administrator** through ${adminRoles.map((r) => `<@&${r.id}>`).join(', ')}: they can see every channel and do anything, and no bot can stop them. Take that role off them, or turn Administrator off for it in Server Settings → Roles.`);
  }
  const manageRoles = [...member.roles.cache.values()].filter((r) => r.id !== guild.id && !r.permissions?.has(P.Administrator) && r.permissions?.has(P.ManageGuild));
  if (manageRoles.length) lines.push(`⚠️ **Manage Server** through ${manageRoles.map((r) => `<@&${r.id}>`).join(', ')}${status === 'an admin' ? ', so I treat them as an admin' : ''}.`);
  if (!isOwner && store.guild(guild.id).trusted.includes(member.id)) {
    lines.push(`⚠️ They're on the anti-nuke **trusted list**${status === 'a moderator' ? '' : ' — that counts as an admin (they can see #mod-watch and use admin buttons)'}. \`/antinuke untrust\` to undo.`);
  }
  if (isOwner || adminRoles.length) {
    embed.setDescription(truncate(lines.join('\n'), 4096));
    return { embeds: [embed], components: [] };
  }

  const groups = new Map(); // reason -> { name, channels }
  let staffSeen = 0;
  for (const ch of privateChannels(guild)) {
    const reasons = reasonsFor(ch, member);
    if (!reasons) continue;
    if (staff.has(ch.id)) staffSeen++;
    const mark = staff.has(ch.id) ? `⚠️${ch}` : `${ch}`;
    for (const r of reasons) {
      const key = r.kind === 'role' ? r.role.id : r.kind;
      const name = r.kind === 'role' ? `🎭 Through the ${r.role.name} role` : r.kind === 'personal' ? '👤 Given to them personally' : '❔ Through a section’s default';
      if (!groups.has(key)) groups.set(key, { name, channels: [] });
      groups.get(key).channels.push(ch.id === ownTicket(settings, member.id) ? `${mark} (their appeal)` : mark);
    }
  }
  if (!groups.size) lines.push('They can only see what everyone can see.');
  else if (staffSeen) lines.push(`🚨 They can see **${staffSeen} staff channel(s)** (marked ⚠️ — the logs, mod log, #mod-watch, #ban-list, appeals or /modhide channels). Fix a role below by taking it off them, or taking it off those channels.`);
  embed.setDescription(truncate(lines.join('\n'), 4096));
  for (const g of [...groups.values()].slice(0, 25)) embed.addFields({ name: truncate(g.name, 256), value: truncate(mentionList(g.channels, 40), 1024) });

  const personal = personalAccess(guild, member);
  const components = personal.length
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`oj:access-clear:${member.id}`).setEmoji('🧹').setLabel(`Remove their personal access (${personal.length})`).setStyle(ButtonStyle.Danger))]
    : [];
  return { embeds: [embed], components };
}

function serverReport(guild) {
  const settings = store.guild(guild.id);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔎 Who can see the staff side of the server');
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !isBotRole(r)).sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const describe = (list) =>
    list.length ? list.map((r) => `<@&${r.id}> — ${mentionList(membersWith(guild, r).map((m) => `<@${m.id}>`), 10) || 'nobody'}`).join('\n') : 'None.';
  embed.addFields(
    { name: '👑 Administrator (can see and do everything)', value: truncate(describe(roles.filter((r) => r.permissions?.has(P.Administrator))), 1024) },
    { name: '🛠️ Manage Server (I treat them as admins, unless they’re moderators)', value: truncate(describe(roles.filter((r) => !r.permissions?.has(P.Administrator) && r.permissions?.has(P.ManageGuild))), 1024) },
  );
  const people = (settings.trusted ?? []).filter((id) => id !== guild.ownerId && !guild.members.cache.get(id)?.user?.bot);
  embed.addFields({ name: '🛡️ Trusted list (people, not bots)', value: truncate(people.length ? mentionList(people.map((id) => `<@${id}>`)) : 'Nobody.', 1024) });

  // Roles and people let into the staff channels who aren't admins.
  const extra = new Map(); // mention -> channel mentions
  for (const id of modGuard().hiddenChannelIds(guild)) {
    const ch = guild.channels.cache.get(id);
    if (!ch?.permissionOverwrites || NOT_CHANNELS.has(ch.type)) continue;
    const ticket = Object.values(settings.restricted ?? {}).some((r) => r.ticketChannelId === ch.id);
    for (const o of ch.permissionOverwrites.cache.values()) {
      if (!allowsView(o)) continue;
      let label;
      if (o.type === OverwriteType.Member) {
        const m = guild.members.cache.get(o.id);
        if (o.id === guild.client.user.id || m?.user?.bot || (m && modGuard().isAdmin(m)) || ticket) continue;
        label = `<@${o.id}>`;
      } else {
        const role = guild.roles.cache.get(o.id);
        if (!role || isBotRole(role) || role.permissions?.has(P.Administrator)) continue;
        label = o.id === guild.id ? '@everyone' : `<@&${o.id}>`;
      }
      if (!extra.has(label)) extra.set(label, []);
      extra.get(label).push(`${ch}`);
    }
  }
  embed.addFields({
    name: '⚠️ Let into staff channels without being an admin',
    value: truncate(extra.size ? [...extra].map(([label, chs]) => `${label}: ${mentionList(chs, 8)}`).join('\n') : 'Nobody — only admins can see them.', 1024),
  });
  embed.setFooter({ text: 'Use /access user:@someone to see why one person can see something.' });
  return { embeds: [embed], components: [] };
}

async function command(interaction) {
  if (!modGuard().isAdmin(interaction.member)) return ephemeral(interaction, '🚫 Only admins and the owner can use this.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('user');
  const { guild } = interaction;
  if (!user) return interaction.editReply({ ...serverReport(guild), allowedMentions: { parse: [] } });
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.editReply({ content: 'ℹ️ They’re not in the server.' });
  return interaction.editReply({ ...memberReport(guild, member), allowedMentions: { parse: [] } });
}

/** The 🧹 button: takes away the private channels they were let into personally (not their own appeal ticket). */
async function clearButton(interaction, userId) {
  if (!modGuard().isAdmin(interaction.member)) return ephemeral(interaction, '🚫 Only admins and the owner can do that.');
  const { guild } = interaction;
  if (userId === guild.ownerId) return ephemeral(interaction, 'ℹ️ That’s the server owner.');
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return ephemeral(interaction, 'ℹ️ They’re not in the server any more.');
  const removed = [];
  for (const ch of personalAccess(guild, member)) {
    const ok = await ch.permissionOverwrites.edit(userId, { ViewChannel: null }, { reason: `O Jailbreak: personal access removed by ${interaction.user.tag}`, type: OverwriteType.Member }).then(
      () => true,
      () => false,
    );
    if (ok) removed.push(`${ch}`);
  }
  const log = await fetchLogChannel(guild);
  if (removed.length) {
    await log?.send({ content: truncate(`🧹 ${who(interaction.member)} took away ${who(member)}’s personal access to ${removed.join(', ')}.`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  }
  const trusted = store.guild(guild.id).trusted.includes(userId) ? ' They’re on the trusted list, so they’ll see #mod-watch again — `/antinuke untrust` them too.' : '';
  return ephemeral(interaction, removed.length ? `🧹 Took away their personal access to ${removed.length} channel(s).${trusted} Run \`/access\` again to check what’s left (roles).` : 'ℹ️ They had no personal access left.');
}

module.exports = { command, clearButton, memberReport, serverReport, privateChannels, reasonsFor };
