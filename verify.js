'use strict';

// Verification unlocks chatting and the new jailbreaks.
//
// • Existing members see the OLD jailbreak section. Under the old jailbreaks the bot posts a message (English and
//   Russian) with a Verify button explaining how to see the new ones.
// • New joiners (after /verify setup) only see #please-read, which explains (English and Russian) how to verify, and the
//   sections in config.js (verify.visibleSections). They can't chat until they verify. They hold only the Unverified
//   role meanwhile (their other roles are saved). When they verify, #please-read disappears and everything opens up.
// • Verifying = authorizing O Jailbreak on Discord's own page ("know what servers you're in"). Anyone in a blocked
//   server (/blockserver) is restricted ("Please make a ticket"); everyone else gets the Verified role, which shows the
//   NEW section and hides the old one.
// • VIPs have to verify too (some were in blocked servers). Until they do, their VIP is paused — saved and taken off,
//   so the VIP channels are hidden — and they see #💎︱vip-verify instead, which says VIP comes back the moment they
//   verify. Anyone holding the VIP role has verified.
// • While someone is verified, their server list is checked again every 30 seconds, so joining a blocked server later
//   gets them restricted too. Only the result is kept, never the list. Removing the bot under Settings → Authorized
//   Apps undoes their verification.
// • /verify require-all: EVERYONE who hasn't verified (existing members too) only sees #please-read until they do.
//
// Discord sends people back to a web page after they authorize, so the bot runs a tiny web server on the port
// Bot-Hosting.net gives it (the IP:port on the panel's Network tab).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const {
  ActionRowBuilder,
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
const blockedServers = require('./blockedServers');
const { fetchLogChannel } = require('./caseLog');
const { exclusive, inBatches, isStaff, truncate, who } = require('./util');

const API = 'https://discord.com/api/v10';
const STATE_TTL_MS = 15 * 60_000; // how long a Verify link works
const SCAN_AT_ONCE = 4; // server lists checked at the same time during a scan

const options = () => ({ roleName: 'Unverified', verifiedRoleName: 'Verified', channelName: '✅︱verify', publicUrl: '', port: null, scanSeconds: 30, ...config.verify });

// ----- where Discord sends people back to -----

/** The bot's web address: VERIFY_URL in .env, config.js, or worked out from the IP and port Bot-Hosting.net gives. */
function publicUrl(env = process.env) {
  const chosen = (env.VERIFY_URL || options().publicUrl || '').trim().replace(/\/+$/, '');
  if (chosen) return /^https?:\/\//i.test(chosen) ? chosen : `http://${chosen}`;
  if (env.SERVER_IP && env.SERVER_IP !== '0.0.0.0' && env.SERVER_PORT) return `http://${env.SERVER_IP}:${env.SERVER_PORT}`;
  return null;
}

const redirectUri = () => (publicUrl() ? `${publicUrl()}/callback` : null);
const listenPort = (env = process.env) => Number(options().port || env.SERVER_PORT || 3000);
const clientSecret = () => process.env.DISCORD_CLIENT_SECRET?.trim() || null;

let server = null;
let listening = false;
let listenError = null;

/** What still needs doing before verification can work (empty when it's ready). */
function setupProblems() {
  const problems = [];
  if (!clientSecret()) {
    problems.push(
      'The bot’s **Client Secret** isn’t in `.env`. Developer Portal → your app → **OAuth2** → **Reset Secret** → copy it, then add a line `DISCORD_CLIENT_SECRET=paste-it-here` to `.env` on your host and press Restart.',
    );
  }
  if (!publicUrl()) {
    problems.push('I don’t know my web address. Add a line `VERIFY_URL=http://IP:PORT` to `.env`, with the IP and port from your host’s **Network** tab, and press Restart.');
  }
  if (listenError) problems.push(`My web server couldn’t start on port ${listenPort()}: ${listenError}`);
  else if (server && !listening) problems.push(`My web server is still starting on port ${listenPort()}.`);
  return problems;
}

// ----- saved logins (for the 30-second checks) -----
// Kept in their own file, not the main database, so they never end up in a log or a backup someone shares.

const tokensFile = () => path.join(process.env.OJ_DATA_DIR || path.join(__dirname, '..', 'data'), 'verify-tokens.json');
let tokens = null; // `${guildId}:${userId}` -> { guildId, userId, access, refresh, expiresAt, scope, lastScan, goneSince }
let tokensTimer = null;
let tokensBroken = false; // the file couldn't be read: never overwrite it (it's backed up and the checks pause)

function loadTokens() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensFile(), 'utf8'));
  } catch (err) {
    tokens = {};
    if (err.code !== 'ENOENT') {
      // Locked or damaged: keep a copy, and don't save over it (that would lose everyone's login).
      tokensBroken = true;
      try {
        fs.copyFileSync(tokensFile(), `${tokensFile()}.broken-${Date.now()}`);
      } catch {}
      console.error(`[verify] Couldn’t read ${tokensFile()} (${err.message}). Verified people won’t be checked until this is fixed and the bot restarts.`);
    }
  }
  return tokens;
}

/** Writes the logins to disk now: to a temporary file first, then swapped in, so a crash can't leave half a file. */
function flushTokens() {
  if (tokensTimer) {
    clearTimeout(tokensTimer);
    tokensTimer = null;
  }
  if (tokensBroken || !tokens) return;
  const file = tokensFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(tokens), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    try {
      fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 }); // renaming can fail on Windows while the file is open
    } catch {
      console.error('[verify] Couldn’t save logins:', err.message);
    }
  }
}

function saveTokens() {
  if (tokensTimer) return;
  tokensTimer = setTimeout(flushTokens, 500);
  tokensTimer.unref?.();
}

const tokenKey = (guildId, userId) => `${guildId}:${userId}`;

function keepToken(guildId, userId, token) {
  loadTokens()[tokenKey(guildId, userId)] = {
    guildId,
    userId,
    access: token.access_token,
    refresh: token.refresh_token ?? null,
    expiresAt: Date.now() + (token.expires_in ?? 604_800) * 1000,
    scope: token.scope ?? '',
    lastScan: Date.now(),
  };
  saveTokens();
}

function forgetToken(guildId, userId) {
  delete loadTokens()[tokenKey(guildId, userId)];
  saveTokens();
}

// ----- the roles, #please-read and the messages -----

function verifySettings(settings) {
  settings.verify ??= {};
  const v = settings.verify;
  v.enabled ??= false;
  v.startedAt ??= null;
  v.verified ??= {};
  v.pending ??= {};
  v.requireAll ??= false; // /verify require-all: everyone who hasn't verified only sees #please-read
  v.held ??= {}; // userId -> { roles, existing, at }: roles saved while they wait behind require-all
  v.vipHeld ??= {}; // userId -> { roles, at }: VIP paused until they verify
  v.vipRoom ??= { roleId: null, channelId: null, messageId: null }; // #💎︱vip-verify and the role that sees it
  return v;
}

const verifyButton = () => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('oj:verify-start').setStyle(ButtonStyle.Success).setEmoji('✅').setLabel('Verify'));

// Who to message about problems (config.js → verify.contact).
const contact = () => options().contact || 'the server owner';

const STEPS_EN = ['1️⃣ Press **Verify** below', '2️⃣ Press **Authorize** on the page that opens', '3️⃣ Done — the jailbreaks appear straight away'];
const STEPS_RU = ['1️⃣ Нажмите **Verify** ниже', '2️⃣ Нажмите **Authorize** на открывшейся странице', '3️⃣ Готово — джейлбрейки появятся сразу'];
const GATE_STEPS_EN = [...STEPS_EN.slice(0, 2), '3️⃣ Done — you can chat and see the jailbreaks straight away'];
const GATE_STEPS_RU = [...STEPS_RU.slice(0, 2), '3️⃣ Готово — можно сразу писать и смотреть джейлбрейки'];

/** #please-read: people who haven't verified can't chat or see the jailbreaks; this says how to fix that. */
function verifyChannelPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🔒 Verify to chat and see the jailbreaks')
        .setDescription(
          [
            '🇬🇧 Due to recent events, we require our users to **verify** before they can chat in the server. Verifying also unlocks our jailbreak prompts.',
            '',
            ...GATE_STEPS_EN,
            '',
            `Any issues? Message **${contact()}**`,
            '',
            '🇷🇺 В связи с недавними событиями мы просим пользователей пройти **верификацию**, прежде чем писать на сервере. Верификация также открывает доступ к нашим джейлбрейк-промптам.',
            '',
            ...GATE_STEPS_RU,
            '',
            `Есть проблемы? Напишите **${contact()}**`,
          ].join('\n'),
        ),
    ],
    components: [verifyButton()],
  };
}

/** Under the old jailbreaks, for existing members: the new ones are for verified members. */
function oldSectionNotice() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('🆕 New jailbreaks are out!')
        .setDescription(
          [
            '🇬🇧 These are the **old** jailbreaks. Due to recent events, the new, updated jailbreak prompts are only for **verified** members.',
            '',
            ...STEPS_EN,
            '',
            `Any issues? Message **${contact()}**`,
            '',
            '🇷🇺 Это **старые** джейлбрейки. В связи с недавними событиями новые, обновлённые джейлбрейк-промпты доступны только **верифицированным** участникам.',
            '',
            ...STEPS_RU,
            '',
            `Есть проблемы? Напишите **${contact()}**`,
          ].join('\n'),
        ),
    ],
    components: [verifyButton()],
  };
}

/**
 * An announcement with a Verify button, for /verifybutton: the ready-made English + Russian one, or your own text
 * (a typed "\n" starts a new line).
 */
function announcementPanel({ text = null, title = null } = {}) {
  const own = text?.trim() ? text.replace(/\\n/g, '\n').trim() : null;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title?.trim() || '📢 Verify to see the new jailbreaks')
    .setDescription(
      own ??
        [
          '🇬🇧 Due to recent events, our jailbreak prompts are now only for **verified** members. It only takes a few seconds:',
          '',
          ...STEPS_EN,
          '',
          `Any issues? Message **${contact()}**`,
          '',
          '🇷🇺 В связи с недавними событиями наши джейлбрейк-промпты теперь доступны только **верифицированным** участникам. Это займёт всего пару секунд:',
          '',
          ...STEPS_RU,
          '',
          `Есть проблемы? Напишите **${contact()}**`,
        ].join('\n'),
    );
  return { embeds: [embed], components: [verifyButton()] };
}

const READ_ONLY = { ViewChannel: true, ReadMessageHistory: true, SendMessages: false, AddReactions: false, CreatePublicThreads: false, CreatePrivateThreads: false };

const sectionIds = (v) => [v.split?.oldCategoryId, v.split?.newCategoryId].filter(Boolean);
const inSection = (v, channel) => sectionIds(v).some((id) => channel.id === id || channel.parentId === id);

/**
 * Makes sure the Unverified and Verified roles and #please-read exist. #please-read is only for Unverified (new joiners who
 * haven't verified). Unverified is hidden from the jailbreak sections only — the rest of the server is open to them.
 */
function ensureSetup(guild) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const v = verifySettings(settings);
    const reason = 'O Jailbreak: setting up verification';

    let remade = false;
    let role = v.roleId ? guild.roles.cache.get(v.roleId) : null;
    if (!role) {
      remade ||= Boolean(v.roleId);
      role = await guild.roles.create({ name: options().roleName, permissions: [], hoist: false, mentionable: false, reason });
      v.roleId = role.id;
      store.save();
    }
    let verifiedRole = v.verifiedRoleId ? guild.roles.cache.get(v.verifiedRoleId) : null;
    const verifiedRemade = !verifiedRole && Boolean(v.verifiedRoleId);
    if (!verifiedRole) {
      remade ||= Boolean(v.verifiedRoleId);
      verifiedRole = await guild.roles.create({ name: options().verifiedRoleName, permissions: [], hoist: false, mentionable: false, reason });
      v.verifiedRoleId = verifiedRole.id;
      store.save();
    }
    // Someone deleted one of the roles: the new one needs the jailbreak sections set up for it again.
    if (remade) await applySectionRoles(guild, v);
    // The Verified role was deleted: everyone who verified gets the new one, so nobody has to verify again.
    if (verifiedRemade) {
      const ids = Object.entries(v.verified).filter(([, r]) => !r.blocked?.length).map(([id]) => id);
      await inBatches(ids, 5, async (id) => {
        const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
        await member?.roles.add(verifiedRole, 'O Jailbreak: the Verified role was re-made').catch(() => {});
      });
    }

    let channel = v.channelId ? guild.channels.cache.get(v.channelId) : null;
    if (!channel) {
      channel = await guild.channels.create({ name: options().channelName, type: ChannelType.GuildText, position: 0, topic: 'Verify to chat and see the jailbreaks · Пройдите верификацию', reason });
      v.channelId = channel.id;
      v.messageId = null;
      store.save();
    } else if (channel.name !== options().channelName) {
      await channel.setName(options().channelName, reason).catch(() => {}); // e.g. the old #please-read → ✅︱verify
    }
    // #please-read: only new joiners who haven't verified (and staff) see it.
    await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason, type: OverwriteType.Role }).catch(() => {});
    await channel.permissionOverwrites.edit(role.id, READ_ONLY, { reason, type: OverwriteType.Role }).catch(() => {});
    await channel.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: false }, { reason, type: OverwriteType.Role }).catch(() => {});

    const panel = v.messageId ? await channel.messages.fetch(v.messageId).catch((err) => (err.code === 10008 ? null : true)) : null;
    const wording = verifyChannelPanel();
    if (!panel) {
      v.messageId = (await channel.send(wording)).id;
      store.save();
    } else if (panel !== true) {
      await panel.edit(wording).catch(() => {}); // keep the wording up to date
    }

    // People who haven't verified see #please-read and the sections in config.js (verify.visibleSections) only
    // (also catches channels made while the bot was off).
    const notHidden = v.enabled ? await applyUnverifiedLayout(guild, v) : [];
    return { role, verifiedRole, channel, notHidden };
  });
}

/**
 * Who sees which jailbreak section, for the Unverified and Verified roles: neither section for Unverified, the new
 * one (the channels everyone could see) for Verified, never the old one for Verified. Used after a split and when
 * one of the roles had to be made again.
 */
async function applySectionRoles(guild, v) {
  if (!v.split) return;
  const reason = 'O Jailbreak: who sees the jailbreak sections';
  const inCategory = (id) => [...guild.channels.cache.values()].filter((ch) => ch.id === id || ch.parentId === id);
  const edit = (ch, roleId, perms) => ch.permissionOverwrites.edit(roleId, perms, { reason, type: OverwriteType.Role }).catch(() => {});
  for (const ch of inCategory(v.split.oldCategoryId)) {
    await edit(ch, v.roleId, { ViewChannel: false });
    await edit(ch, v.verifiedRoleId, { ViewChannel: false });
  }
  const forVerified = new Set(v.split.verifiedChannels ?? []);
  for (const ch of inCategory(v.split.newCategoryId)) {
    await edit(ch, v.roleId, { ViewChannel: false });
    if (forVerified.has(ch.id)) await edit(ch, v.verifiedRoleId, { ViewChannel: true, ReadMessageHistory: true });
  }
}

const hasVerified = (member, settings = store.guild(member.guild.id)) => Boolean(settings.verify?.verifiedRoleId && member.roles?.cache.has(settings.verify.verifiedRoleId));
const isUnverified = (member, settings = store.guild(member.guild.id)) => Boolean(settings.verify?.roleId && member.roles?.cache.has(settings.verify.roleId));

function vipRoleIds(settings) {
  return [settings.vipRoleId, config.updating?.vipRoleId].filter(Boolean);
}

/**
 * Gives someone the Verified role (the new section). New joiners lose Unverified, so #please-read disappears, and
 * anyone held back by require-all gets their roles back (and the auto-role).
 */
async function markVerified(member, why) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  const held = v.held[member.id];
  const vip = isRestricted(member, settings) ? null : v.vipHeld[member.id]; // paused VIP comes back too
  if (held || vip) {
    const back = [...(held ? heldRoles(member, settings, held) : []), ...(vip ? pausedVipRoles(member, vip) : [])];
    const room = v.vipRoom.roleId;
    const current = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== v.roleId && r.id !== room).map((r) => r.id);
    const ok = await member.roles.set([...new Set([...current, ...back, v.verifiedRoleId].filter(Boolean))], `O Jailbreak: ${why}`).then(
      () => true,
      (err) => {
        console.warn(`[verify] Couldn't give ${member.user.tag} their roles back: ${err.message}`);
        return false;
      },
    );
    if (!ok) return false; // their saved roles stay saved for the next try
    // Only forgotten once they actually have them back.
    if (held && v.held[member.id] === held) delete v.held[member.id];
    if (vip && v.vipHeld[member.id] === vip) delete v.vipHeld[member.id];
    store.save();
    if (vip) await closeVipRoomIfDone(member.guild);
  } else {
    if (v.roleId && isUnverified(member, settings)) await member.roles.remove(v.roleId, `O Jailbreak: ${why}`).catch(() => {});
    if (v.verifiedRoleId && !hasVerified(member, settings)) await member.roles.add(v.verifiedRoleId, `O Jailbreak: ${why}`).catch(() => {});
  }
  delete v.pending[member.id];
  store.save();
  // Joined through someone's invite: that join counts now they've verified.
  await require('./invites')
    .onVerified(member)
    .catch((err) => console.warn(`[invites] ${err.message}`));
  return true;
}

/** Takes verification away (they removed the bot's access): back to what they saw before they verified. */
async function unverify(member, why) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  const wasNew = Boolean(v.verified[member.id]?.newJoiner);
  if (v.verifiedRoleId) await member.roles.remove(v.verifiedRoleId, `O Jailbreak: ${why}`).catch(() => {});
  if (wasNew) await backToUnverified(member, v, why);
  delete v.verified[member.id];
  store.save();
  forgetToken(member.guild.id, member.id);
  await holdBack(member, 'no longer verified, and everyone must verify');
  await member
    .send(`🔒 You’re no longer verified in **${truncate(member.guild.name, 80)}** because ${why}. To see the new jailbreaks again, press **Verify** in the server.`)
    .catch(() => {});
}

const isVipMember = (member, settings) => vipRoleIds(settings).some((id) => member.roles?.cache.has(id));

// ----- VIPs verify too -----
// VIPs have to verify like everyone else (some were in blocked servers). Until they do, VIP is paused: the VIP role is
// saved and taken off — so the VIP channels are hidden — and they get the "VIP — verify" role, which shows only
// #💎︱vip-verify: VIP comes back the moment they verify (English + Russian), a Verify button, and who to message about
// problems. Verifying gives VIP straight back; being in a blocked server gets them restricted instead. Staff are never
// paused. The channel and its role are deleted once every paused VIP has verified (or left).

const VIP_ROOM = { roleName: 'VIP — verify', channelName: '💎︱vip-verify' };

/**
 * Verified for real: there's a record of them pressing Verify and passing (from any version — saved logins only exist
 * since v1.12.0, so the record is what counts), or staff let them in by hand ('manual'). Having the Verified role isn't
 * enough: older versions gave it to VIPs for free — marked 'vip' since v1.12.0, and with no record at all in v1.11.2.
 */
function verifiedForReal(member, v) {
  const record = v.verified[member.id];
  return hasVerified(member, store.guild(member.guild.id)) && Boolean(record) && !record.blocked?.length && record.via !== 'vip';
}

/** The paused VIP roles that still exist and that the bot can give. */
const pausedVipRoles = (member, record) => record.roles.filter((id) => member.guild.roles.cache.get(id) && member.guild.roles.cache.get(id).editable !== false);

function vipRoomPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('💎 VIPs need to verify now')
        .setDescription(
          [
            'Your **VIP isn’t gone** — it’s paused until you verify, and comes back the moment you do (with all the VIP channels).',
            '',
            '1️⃣ Press **Verify** below',
            '2️⃣ Press **Authorize** on the page that opens',
            '3️⃣ Done — your VIP comes straight back',
            '',
            `Any issues? DM ${contact()}.`,
            '',
            '🇷🇺 **VIP теперь тоже должны пройти верификацию**',
            'Ваш **VIP никуда не делся** — он приостановлен до верификации и вернётся сразу после неё (вместе со всеми VIP-каналами).',
            '1️⃣ Нажмите **Verify** ниже',
            '2️⃣ Нажмите **Authorize** на открывшейся странице',
            '3️⃣ Готово — VIP сразу вернётся',
            `Есть проблемы? Напишите в ЛС ${contact()}.`,
          ].join('\n'),
        ),
    ],
    components: [verifyButton()],
  };
}

/** Makes the "VIP — verify" role and #💎︱vip-verify (only that role can see it, read-only) if they're missing. */
function ensureVipRoom(guild) {
  return exclusive(`viproom:${guild.id}`, async () => {
    const v = verifySettings(store.guild(guild.id));
    const room = v.vipRoom;
    const reason = 'O Jailbreak: VIPs verify first';
    let role = room.roleId ? guild.roles.cache.get(room.roleId) : null;
    if (!role) {
      role = await guild.roles.create({ name: VIP_ROOM.roleName, permissions: [], hoist: false, mentionable: false, reason });
      room.roleId = role.id;
      store.save();
    }
    let channel = room.channelId ? guild.channels.cache.get(room.channelId) : null;
    if (!channel) {
      channel = await guild.channels.create({
        name: VIP_ROOM.channelName,
        type: ChannelType.GuildText,
        position: 0,
        topic: 'VIPs: verify to get VIP back · VIP: пройдите верификацию, чтобы вернуть VIP',
        reason,
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
          { id: role.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads] },
          { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] },
        ],
      });
      room.channelId = channel.id;
      room.messageId = null;
      store.save();
    }
    const panel = room.messageId ? await channel.messages.fetch(room.messageId).catch((err) => (err.code === 10008 ? null : true)) : null;
    if (!panel) {
      room.messageId = (await channel.send(vipRoomPanel())).id;
      store.save();
    }
    return { role, channel };
  });
}

/** The DM a paused VIP gets (English + Russian), with a button to #💎︱vip-verify. */
function vipDm(guild, v) {
  const name = truncate(guild.name, 80);
  const where = v.vipRoom.channelId ? `<#${v.vipRoom.channelId}>` : 'the server';
  return {
    content: [
      `💎 **VIPs in ${name} need to verify now.**`,
      'Your **VIP isn’t gone** — it’s paused until you verify, and comes back the moment you do (with all the VIP channels).',
      `Go to ${where}, press **Verify**, then **Authorize** — it takes a few seconds.`,
      `Any issues? DM ${contact()}.`,
      '',
      `🇷🇺 **VIP на сервере ${name} теперь тоже должны пройти верификацию.**`,
      'Ваш **VIP никуда не делся** — он приостановлен до верификации и вернётся сразу после неё (вместе со всеми VIP-каналами).',
      `Откройте ${where}, нажмите **Verify**, затем **Authorize** — это займёт пару секунд.`,
      `Есть проблемы? Напишите в ЛС ${contact()}.`,
    ].join('\n'),
    components: v.vipRoom.channelId
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('💎').setLabel('Go to #vip-verify').setURL(`https://discord.com/channels/${guild.id}/${v.vipRoom.channelId}`))]
      : [],
  };
}

const vipDms = new Map(); // guildId -> the DM round in progress

/**
 * DMs every paused VIP who hasn't been DMed yet, one every `verify.vipDmSeconds` seconds (3) so Discord doesn't take the
 * bot for a spammer. Each person is only ever DMed once (remembered across restarts). Runs in the background; returns
 * the round in progress. The mod log gets a summary at the end.
 */
function queueVipDms(guild) {
  if (vipDms.has(guild.id)) return vipDms.get(guild.id);
  const gapMs = Math.max(0, Number(options().vipDmSeconds ?? 3)) * 1000;
  const round = (async () => {
    let sent = 0;
    let closed = 0;
    for (;;) {
      const v = verifySettings(store.guild(guild.id));
      const next = Object.entries(v.vipHeld).find(([, r]) => !r.dmedAt);
      if (!next) break;
      const [userId, record] = next;
      record.dmedAt = Date.now(); // before sending, so nobody is ever DMed twice
      store.save();
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) continue;
      if (await member.send(vipDm(guild, v)).then(() => true, () => false)) sent++;
      else closed++;
      if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    if (sent + closed) {
      const log = await fetchLogChannel(guild);
      await log
        ?.send({
          content: `💎 DMed **${sent}** paused VIP(s) that they need to verify (any issues → ${contact()}).${closed ? ` **${closed}** have their DMs closed — they’ll still see the channel.` : ''}`,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
    return { sent, closed };
  })().finally(() => vipDms.delete(guild.id));
  vipDms.set(guild.id, round);
  return round;
}

/** Every paused VIP has verified (or left): #💎︱vip-verify and its role are deleted. */
async function closeVipRoomIfDone(guild) {
  const v = verifySettings(store.guild(guild.id));
  if (Object.keys(v.vipHeld).length || (!v.vipRoom.roleId && !v.vipRoom.channelId)) return false;
  return exclusive(`viproom:${guild.id}`, async () => {
    if (Object.keys(v.vipHeld).length) return false;
    const reason = 'O Jailbreak: every VIP has verified';
    await guild.channels.cache.get(v.vipRoom.channelId)?.delete(reason).catch(() => {});
    await guild.roles.cache.get(v.vipRoom.roleId)?.delete(reason).catch(() => {});
    v.vipRoom = { roleId: null, channelId: null, messageId: null };
    store.save();
    const log = await fetchLogChannel(guild);
    await log?.send({ content: '💎 Every paused VIP has verified, so I deleted #💎︱vip-verify and its role.', allowedMentions: { parse: [] } }).catch(() => {});
    return true;
  });
}

/**
 * A VIP who hasn't verified: VIP is paused until they do (saved and taken off, plus the "VIP — verify" role). Verified
 * that only came free with VIP goes too. True if they were paused.
 */
async function holdVip(member) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  if (!v.enabled || !v.verifiedRoleId || member.user?.bot || isRestricted(member, settings) || verifiedForReal(member, v)) return false;
  if (member.id === member.guild.ownerId || store.isTrusted(member.guild, member.id) || isStaff(member, settings) || member.permissions?.any?.(STAFF_POWERS)) return false;
  const vipRoles = vipRoleIds(settings).filter((id) => member.roles.cache.has(id) && member.guild.roles.cache.get(id)?.editable !== false);
  if (!vipRoles.length) return false;
  const key = `${member.guild.id}:${member.id}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < PAUSE_MS || (noPermissionUntil.get(member.guild.id) ?? 0) > Date.now()) return false;
  let room;
  try {
    room = await ensureVipRoom(member.guild);
  } catch (err) {
    failedAt.set(key, Date.now());
    console.warn(`[verify] ${member.guild.name}: couldn't make #${VIP_ROOM.channelName}: ${err.message}`);
    return false;
  }
  const record = (v.vipHeld[member.id] ??= { roles: [], at: Date.now() });
  record.roles = [...new Set([...record.roles, ...vipRoles])];
  // Verified they didn't earn goes too: free with VIP — marked 'vip' (v1.12.0 on), or no record of verifying at all
  // (v1.11.2) — or a record that found them in a blocked server.
  const old = v.verified[member.id];
  const freeVerified = hasVerified(member, settings) && (!old || old.via === 'vip' || Boolean(old.blocked?.length));
  const newJoiner = old ? Boolean(old.newJoiner) : (member.joinedTimestamp ?? 0) >= (v.startedAt ?? Infinity);
  // Forgotten before the roles change, so losing VIP doesn't look like "lost VIP" to onVipLost.
  const free = old?.via === 'vip' ? old : null;
  if (free) delete v.verified[member.id];
  store.flush(); // written down before VIP comes off, so a crash can't lose it
  const keep = member.roles.cache.filter((r) => r.id !== member.guild.id && !vipRoles.includes(r.id) && !(freeVerified && r.id === v.verifiedRoleId)).map((r) => r.id);
  try {
    await member.roles.set([...new Set([...keep, room.role.id])], 'O Jailbreak: VIPs verify first (VIP saved until they do)');
  } catch (err) {
    failedAt.set(key, Date.now());
    if (free) v.verified[member.id] = free;
    store.save();
    if (err.code === 50013) await noPermission(member.guild);
    else console.warn(`[verify] Couldn't pause ${member.user.tag}'s VIP: ${err.message}`);
    return false;
  }
  failedAt.delete(key);
  // Verified only came with VIP and they joined after verification started: back to waiting to verify.
  if (freeVerified && newJoiner) {
    await backToUnverified(member, v, 'VIP no longer verifies them');
    await holdBack(member, 'VIPs verify first');
  }
  return true;
}

/** VIP was taken away (below the invite goal) while paused: it isn't given back when they verify. */
async function dropPausedVip(guild, userId, roleId) {
  const v = verifySettings(store.guild(guild.id));
  const record = v.vipHeld[userId];
  if (!record?.roles.includes(roleId)) return false;
  record.roles = record.roles.filter((id) => id !== roleId);
  if (!record.roles.length) {
    delete v.vipHeld[userId];
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    const room = v.vipRoom.roleId;
    if (room && member?.roles.cache.has(room)) await member.roles.remove(room, 'O Jailbreak: no longer VIP').catch(() => {});
  }
  store.save();
  await closeVipRoomIfDone(guild);
  return true;
}

/** Verification turned off: there's nothing to verify with, so every paused VIP gets VIP back. */
async function releasePausedVips(guild) {
  const v = verifySettings(store.guild(guild.id));
  let released = 0;
  for (const [userId, record] of Object.entries(v.vipHeld)) {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch((err) => (err.code === 10007 ? 'left' : null)));
    if (!member) continue;
    if (member !== 'left') {
      const current = member.roles.cache.filter((r) => r.id !== guild.id && r.id !== v.vipRoom.roleId).map((r) => r.id);
      const ok = await member.roles.set([...new Set([...current, ...pausedVipRoles(member, record)])], 'O Jailbreak: verification turned off, VIP back').then(() => true, () => false);
      if (!ok) continue;
      released++;
    }
    delete v.vipHeld[userId];
  }
  store.save();
  await closeVipRoomIfDone(guild);
  return released;
}

/**
 * Lost VIP: if Verified only came free with VIP (they never verified themselves), it goes too, and a new joiner goes
 * back to Unverified. People who verified properly keep it.
 */
async function onVipLost(member) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  const record = v.verified[member.id];
  if (record?.via !== 'vip') return false;
  delete v.verified[member.id];
  store.save();
  if (v.verifiedRoleId) await member.roles.remove(v.verifiedRoleId, 'O Jailbreak: lost VIP (Verified came with it)').catch(() => {});
  if (record.newJoiner) await backToUnverified(member, v, 'lost VIP (Verified came with it)');
  await holdBack(member, 'lost VIP (Verified came with it), and everyone must verify');
  return true;
}

/** A new joiner goes back to not seeing the jailbreaks (only while verification is on), and is waiting again. */
async function backToUnverified(member, v, why) {
  if (!v.enabled || !v.roleId) return;
  v.pending[member.id] = Date.now();
  store.save();
  await member.roles.add(v.roleId, `O Jailbreak: ${why}`).catch(() => {});
}

/**
 * Given VIP without having verified: VIP is paused until they do. A moderator giving someone Verified lets them in
 * (their roles and any paused VIP back). While everyone must verify, any other role given to someone who hasn't
 * verified (by a mod or another bot) is taken back off and saved for when they do.
 */
async function onMemberUpdate(oldMember, member) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  if (!v.verifiedRoleId || isRestricted(member, settings)) return;
  if (isVipMember(member, settings) && (await holdVip(member))) {
    queueVipDms(member.guild).catch(() => {}); // tell them by DM (in the background)
    return;
  }
  const isVip = isVipMember(member, settings);
  const wasVip = !oldMember.partial && isVipMember(oldMember, settings);
  if (!isVip && (wasVip || oldMember.partial) && hasVerified(member, settings) && (await onVipLost(member))) return;
  if ((v.held[member.id] || v.vipHeld[member.id]) && hasVerified(member, settings) && v.verified[member.id]?.via !== 'vip') {
    v.verified[member.id] ??= { at: Date.now(), blocked: [], newJoiner: v.held[member.id] ? !v.held[member.id].existing : false, via: 'manual' };
    return markVerified(member, 'given Verified by a moderator');
  }
  if (mustVerify(member, settings)) return holdBack(member);
  if (shouldLetIn(member, settings)) return letIn(member, 'staff don’t have to verify');
}

/**
 * Someone left: anything saved while they waited to verify is dropped (Discord took their roles anyway), so if they
 * come back they're a new member waiting to verify, not someone owed their old roles.
 */
function onMemberLeave(member) {
  const v = store.guild(member.guild.id).verify;
  const vip = v?.vipHeld?.[member.id];
  if (!v || (!v.held?.[member.id] && !v.pending?.[member.id] && !vip)) return;
  delete v.held[member.id];
  delete v.pending[member.id];
  if (vip) delete v.vipHeld[member.id];
  store.save();
  if (vip) closeVipRoomIfDone(member.guild).catch(() => {});
}

/**
 * At startup, on /verify setup and every 30 seconds (`fromCache`): VIPs who haven't verified — including the ones older
 * versions verified for free — have VIP paused until they do; anyone paused who has been given Verified since gets it
 * back. Returns how many VIPs were paused this time.
 */
async function verifyVips(guild, { fromCache = false } = {}) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  if (!v.verifiedRoleId) return 0;
  const members = fromCache ? guild.members.cache : await guild.members.fetch().catch(() => null);
  let paused = 0;
  let kept = 0;
  for (const member of members?.values() ?? []) {
    if (member.user?.bot || settings.restricted[member.id]) continue;
    if (isVipMember(member, settings)) {
      if (await holdVip(member)) paused++;
      else if (verifiedForReal(member, v)) kept++;
    } else if (v.vipHeld[member.id] && verifiedForReal(member, v)) {
      await markVerified(member, 'verified');
    } else if (v.verified[member.id]?.via === 'vip') {
      await onVipLost(member);
    }
  }
  // Paused VIPs who left are forgotten (Discord took their roles anyway).
  if (!fromCache && members) for (const id of Object.keys(v.vipHeld)) if (!members.has(id)) delete v.vipHeld[id];
  store.save();
  if (paused) {
    const log = await fetchLogChannel(guild);
    await log
      ?.send({
        content: `💎 VIPs have to verify now: paused VIP for **${paused}** VIP(s) who never verified themselves (kept it for **${kept}** who did). They can see <#${v.vipRoom.channelId}> until they verify, and get VIP straight back when they do.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  // Anyone paused who hasn't been DMed yet (paused by an earlier version, or a round cut short by a restart).
  if (Object.values(v.vipHeld).some((r) => !r.dmedAt)) queueVipDms(guild).catch(() => {});
  await closeVipRoomIfDone(guild);
  return paused;
}

// ----- joining -----

/**
 * Someone joined. They get into the server as normal; if verification is on they also get Unverified (no jailbreak
 * sections, but #please-read). Someone who verified before and still has a saved login gets Verified straight back (the
 * 30-second checks carry on for them). Returns true if they still have to verify.
 */
async function onJoin(member) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  if (!v.enabled || member.user.bot || !v.roleId || hasVerified(member, settings)) return false;
  if (v.verified[member.id] && !v.verified[member.id].blocked?.length && loadTokens()[tokenKey(member.guild.id, member.id)]) {
    if (v.verifiedRoleId) await member.roles.add(v.verifiedRoleId, 'O Jailbreak: verified before').catch(() => {});
    return false;
  }
  if (!isUnverified(member, settings)) {
    v.pending[member.id] = Date.now();
    store.save();
    await member.roles.add(v.roleId, 'O Jailbreak: new member, verifies to see the jailbreaks').catch((err) => console.warn(`[verify] couldn't give Unverified to ${member.user.tag}: ${err.message}`));
  }
  // Everyone must verify: no member role (or anything else) until they do.
  await holdBack(member, 'new member, everyone must verify');
  return true;
}

/** At startup: catch up on anyone who joined while the bot was off, VIPs, and the notices under the old jailbreaks. */
async function resume(guild) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  // Require-all was turned off but the bot stopped before everyone had their roles back. (The full member list is
  // loaded first, so nobody who still has to verify is mistaken for someone who doesn't.)
  await guild.members.fetch().catch(() => null);
  await releaseLeftovers(guild).catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));
  if (!v.enabled) return;
  await ensureSetup(guild).catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));
  const members = await guild.members.fetch().catch(() => null);
  for (const member of members?.values() ?? []) {
    const joinedSince = (member.joinedTimestamp ?? 0) >= (v.startedAt ?? Infinity);
    if (!joinedSince || member.user.bot || hasVerified(member, settings) || settings.restricted[member.id] || isUnverified(member, settings)) continue;
    if (!mustVerify(member, settings)) continue; // staff, VIPs, trusted
    await onJoin(member);
  }
  await verifyVips(guild);
  await postOldSectionNotices(guild).catch(() => {});
  // Everyone must verify: anyone who got roles (or joined) while the bot was off.
  await gateEveryone(guild).catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));
}

/** A channel moved to another section: shown to or hidden from Unverified to match. */
async function onChannelUpdate(oldChannel, channel) {
  if (oldChannel?.parentId === channel.parentId) return;
  await onChannelCreate(channel);
}

// A new channel is hidden from people who haven't verified, unless it's in one of the sections they can see.
async function onChannelCreate(channel) {
  const v = channel.guild ? store.guild(channel.guild.id).verify : null;
  if (!v?.enabled || !v.roleId || !channel.permissionOverwrites) return;
  await applyUnverifiedView(channel.guild, v, channel).catch(() => {});
}

// ----- the Verify button and Discord's login page -----

const states = new Map(); // state -> { guildId, userId, at }

function authorizeUrl(client, state) {
  // guilds = their server list (the blocked-server check); guilds.join = the backup server (/backup pull).
  const params = new URLSearchParams({ client_id: client.application?.id ?? client.user.id, response_type: 'code', redirect_uri: redirectUri(), scope: 'identify guilds guilds.join', state, prompt: 'consent' });
  return `https://discord.com/oauth2/authorize?${params}`;
}

const setupWarnedAt = new Map(); // guildId -> when the mod log was last told verification isn't set up

async function startButton(interaction) {
  const { guild, member } = interaction;
  const settings = store.guild(guild.id);
  // Already verified with their own login (which includes the backup-server permission): nothing to do. People who
  // only have Verified because of VIP, or who verified before backups existed, can authorize again.
  const login = loadTokens()[tokenKey(guild.id, member.id)];
  if (hasVerified(member, settings) && login && canJoin(login)) {
    return interaction.reply({ content: '✅ You’re already verified. · Вы уже верифицированы.', flags: MessageFlags.Ephemeral });
  }
  if (settings.restricted[member.id]) return interaction.reply({ content: '🚫 Restricted members can’t verify.', flags: MessageFlags.Ephemeral });
  const problems = setupProblems();
  if (problems.length) {
    // Reply first (Discord only waits 3 seconds), and tell the mod log at most once an hour.
    await interaction.reply({ content: '⚠️ Verification isn’t working right now. The staff have been told — please try again later.', flags: MessageFlags.Ephemeral });
    if (Date.now() - (setupWarnedAt.get(guild.id) ?? 0) > 3_600_000) {
      setupWarnedAt.set(guild.id, Date.now());
      const log = await fetchLogChannel(guild);
      await log?.send({ content: truncate(`⚠️ **Someone tried to verify, but verification isn’t set up properly:**\n${problems.map((p) => `• ${p}`).join('\n')}`, 2000), allowedMentions: { parse: [] } }).catch(() => {});
    }
    return null;
  }
  const state = randomBytes(18).toString('hex');
  states.set(state, { guildId: guild.id, userId: member.id, at: Date.now() });
  for (const [key, s] of states) if (Date.now() - s.at > STATE_TTL_MS) states.delete(key);
  return interaction.reply({
    content: 'Press the button, then **Authorize**. This link works for 15 minutes and only for you.\nНажмите кнопку, затем **Authorize**. Ссылка работает 15 минут и только для вас.',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Verify with Discord').setURL(authorizeUrl(interaction.client, state)))],
    flags: MessageFlags.Ephemeral,
  });
}

async function discordApi(pathname, token, init = {}) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.json?.().catch(() => ({}));
    throw Object.assign(new Error(`Discord said ${res.status} for ${pathname}`), { status: res.status, body });
  }
  return res.json();
}

function formRequest(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() };
}

const clientIdOf = (client) => client.application?.id ?? client.user.id;

async function revokeToken(client, accessToken) {
  await fetch(`${API}/oauth2/token/revoke`, formRequest({ client_id: clientIdOf(client), client_secret: clientSecret(), token: accessToken })).catch(() => {});
}

/** Swaps Discord's code for a login, and reads who they are and their server list. */
async function fetchServers(client, code) {
  const token = await discordApi('/oauth2/token', null, formRequest({ client_id: clientIdOf(client), client_secret: clientSecret(), grant_type: 'authorization_code', code, redirect_uri: redirectUri() }));
  try {
    const [me, guilds] = await Promise.all([discordApi('/users/@me', token.access_token), discordApi('/users/@me/guilds', token.access_token)]);
    return { userId: me.id, guildIds: guilds.map((g) => g.id), token };
  } catch (err) {
    await revokeToken(client, token.access_token);
    throw err;
  }
}

// The blocked servers in someone's server list, by name (for messages) and ID.
const blockedIdsIn = (settings, guildIds) => {
  const list = blockedServers.blockedList(settings);
  return guildIds.filter((id) => list[id]);
};
const blockedHits = (settings, guildIds) => {
  const list = blockedServers.blockedList(settings);
  return blockedIdsIn(settings, guildIds).map((id) => list[id].name);
};

/** The check itself: blocked server → restricted ("Please make a ticket"); otherwise → Verified. */
async function finish(guild, member, guildIds, token = null) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  const hits = blockedHits(settings, guildIds);
  const held = v.held[member.id];
  const newJoiner = held ? !held.existing : isUnverified(member, settings) || Boolean(v.pending[member.id]);

  // Restricted while their Verify link was open: nothing changes.
  if (settings.restricted[member.id]) {
    if (token) await revokeToken(guild.client, token.access_token);
    return { ok: false, restricted: true, blocked: [] };
  }

  if (hits.length) {
    if (token) await revokeToken(guild.client, token.access_token);
    v.verified[member.id] = { at: Date.now(), blocked: hits, newJoiner };
    store.save();
    // Unverified stays on (and is saved with their roles), so if they're ever unrestricted they still can't see
    // the jailbreaks until they verify properly. If restricting fails they're simply left as they were.
    const result = await blockedServers.restrictAssociated(member, `in **${hits.join(', ')}** (found when they verified)`, blockedIdsIn(settings, guildIds));
    if (result?.ok) delete v.pending[member.id];
    store.save();
    return { ok: Boolean(result?.ok), blocked: hits };
  }

  v.verified[member.id] = { at: Date.now(), blocked: [], newJoiner };
  store.save();
  if (token) keepToken(guild.id, member.id, token);
  // Their roles couldn't be given back (Discord busy, or my role is too low): nothing is lost, they can press Verify again.
  if (!(await markVerified(member, 'verified'))) return { ok: false, blocked: [], failed: true };
  const log = await fetchLogChannel(guild);
  await log?.send({ content: `✅ ${who(member)} verified (not in any blocked server).`, allowedMentions: { parse: [] } }).catch(() => {});
  return { ok: true, blocked: [] };
}

function page(title, text, ok = true) {
  const color = ok ? '#22c55e' : '#ed4245';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:440px;background:#2b2d31;border-radius:12px;padding:28px;border-top:4px solid ${color}}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 10px;color:#b5bac1}</style></head>
<body><main><h1>${esc(title)}</h1>${[].concat(text).map((t) => `<p>${esc(t)}</p>`).join('')}</main></body></html>`;
}

/** Discord sent someone back after they pressed Authorize (or Cancel). */
async function handleCallback(client, url) {
  const state = states.get(url.searchParams.get('state') ?? '');
  if (url.searchParams.get('error')) {
    return { status: 200, body: page('Verification cancelled', ['Go back to Discord and press Verify again whenever you’re ready.', 'Вернитесь в Discord и нажмите Verify, когда будете готовы.'], false) };
  }
  if (!state || Date.now() - state.at > STATE_TTL_MS) {
    return { status: 400, body: page('That link has expired', ['Go back to Discord and press Verify again to get a new one.', 'Вернитесь в Discord и снова нажмите Verify.'], false) };
  }
  states.delete(url.searchParams.get('state'));

  const guild = client.guilds.cache.get(state.guildId);
  const member = guild ? await guild.members.fetch(state.userId).catch(() => null) : null;
  if (!member) return { status: 400, body: page('You’re not in the server', ['Join the server again, then press Verify.'], false) };

  let servers;
  try {
    servers = await fetchServers(client, url.searchParams.get('code'));
  } catch (err) {
    console.warn(`[verify] ${guild.name}: couldn't check ${member.user.tag}: ${err.message}`);
    return { status: 502, body: page('Something went wrong', ['Discord didn’t answer properly. Go back to Discord and press Verify again.', 'Discord не ответил. Вернитесь в Discord и снова нажмите Verify.'], false) };
  }
  if (servers.userId !== member.id) {
    await revokeToken(client, servers.token.access_token);
    return {
      status: 400,
      body: page('Wrong account', ['You authorized with a different Discord account than the one in the server. Log into the right account in your browser and press Verify again.', 'Вы вошли в другой аккаунт Discord. Войдите в нужный аккаунт в браузере и снова нажмите Verify.'], false),
    };
  }

  // From the 🔄 Recheck button in their appeal ticket: kept for later rechecks, and the result goes in the ticket.
  if (state.purpose === 'recheck') {
    keepToken(guild.id, member.id, servers.token);
    await require('./appealRecheck')
      .afterLogin(guild, member.id, servers.guildIds)
      .catch((err) => console.warn(`[recheck] ${err.message}`));
    return { status: 200, body: page('Checked ✅', ['The result is in your appeal ticket. You can close this tab.', 'Результат — в вашем тикете. Эту вкладку можно закрыть.']) };
  }

  const result = await finish(guild, member, servers.guildIds, servers.token);
  if (result.restricted) return { status: 200, body: page('You’re restricted', ['Restricted members can’t verify. Please make a ticket in the restricted channel.'], false) };
  if (result.failed) {
    return { status: 502, body: page('Almost there', ['Discord didn’t let me give you your roles just now. Go back to Discord and press Verify again in a minute.', 'Discord не дал выдать вам роли. Вернитесь в Discord и снова нажмите Verify через минуту.'], false) };
  }
  if (result.blocked.length && !result.ok) {
    return { status: 200, body: page('You can’t verify', ['Your account is in a server that isn’t allowed here. The staff have been told.', 'Ваш аккаунт состоит в запрещённом сервере. Персонал уведомлён.'], false) };
  }
  return result.blocked.length
    ? { status: 200, body: page('You’ve been restricted', [`Please make a ticket in the restricted channel in ${guild.name}.`, 'Пожалуйста, создайте тикет в канале restricted.'], false) }
    : { status: 200, body: page('You’re verified ✅', [`The new jailbreaks are unlocked in ${guild.name}. You can close this tab.`, 'Новые джейлбрейки открыты. Эту вкладку можно закрыть.']) };
}

/** Starts the little web server Discord sends people back to. */
function startServer(client) {
  if (server) return server;
  server = http.createServer(async (req, res) => {
    let reply = { status: 200, body: page('O Jailbreak', ['Nothing to see here.']) };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/callback') reply = await handleCallback(client, url);
    } catch (err) {
      console.warn(`[verify] Web page error: ${err.message}`);
      reply = { status: 400, body: page('Something went wrong', ['Go back to Discord and press Verify again.'], false) };
    }
    if (res.headersSent) return;
    res.writeHead(reply.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(reply.body);
  });
  // Nobody gets to hold a connection open forever.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (err, socket) => socket.destroy());
  server.on('error', (err) => {
    listenError = err.code === 'EADDRINUSE' ? 'something else is already using it' : err.message;
    console.warn(`[verify] Web server couldn't start on port ${listenPort()}: ${listenError}`);
  });
  server.listen(listenPort(), '0.0.0.0', () => {
    listening = true;
    listenError = null;
    console.log(`[verify] Listening for verifications on port ${listenPort()}${redirectUri() ? ` (${redirectUri()})` : ''}.`);
  });
  server.unref();
  return server;
}

// ----- the 30-second checks -----

let lastScan = null; // { at, checked, caught, took, paused }
let scanning = false;
let secretWarned = 0;
const membersLoaded = new Set(); // servers whose full member list has been loaded since the bot started
const GONE_FOR_MS = 30 * 86_400_000; // logins of people who left are deleted after this long away

/**
 * True only when Discord says the person themselves took the bot's access away: a refresh refused with invalid_grant,
 * or their server list refused even with a freshly refreshed login. A wrong Client Secret (invalid_client), Discord
 * being down, rate limits and timeouts never count — nobody is unverified because of a problem on our side.
 */
const deauthorized = (err) => Boolean(err?.deauthorized) || (err?.status === 400 && err?.body?.error === 'invalid_grant');
const badSecret = (err) => err?.body?.error === 'invalid_client' || (err?.status === 401 && err?.refreshing);

/** Their server list, using their saved login (refreshed when it runs out). */
/** Whether they've a saved login the bot can use to look at their server list. */
async function hasSavedLogin(guild, userId) {
  return Boolean(loadTokens()[tokenKey(guild.id, userId)]);
}

/** Their server list now, from their saved login — or null if there isn't one (or they took it back). */
async function serverListOf(guild, userId) {
  const rec = loadTokens()[tokenKey(guild.id, userId)];
  if (!rec) return null;
  try {
    return await serversFor(guild.client, rec);
  } catch (err) {
    if (err.deauthorized) forgetToken(guild.id, userId);
    return null;
  }
}

/** A one-time link for someone restricted to let the bot look at their server list again (the 🔄 Recheck button). */
function recheckLink(guild, userId) {
  if (setupProblems().length) return null;
  const state = randomBytes(18).toString('hex');
  states.set(state, { guildId: guild.id, userId, at: Date.now(), purpose: 'recheck' });
  return authorizeUrl(guild.client, state);
}

async function serversFor(client, rec) {
  if (rec.expiresAt - Date.now() < 60_000) await refreshLogin(client, rec);
  try {
    return (await discordApi('/users/@me/guilds', rec.access)).map((g) => g.id);
  } catch (err) {
    if (err.status !== 401) throw err;
    if (!rec.refresh) throw Object.assign(err, { deauthorized: true }); // can't be renewed: it's gone
    await refreshLogin(client, rec);
    try {
      return (await discordApi('/users/@me/guilds', rec.access)).map((g) => g.id);
    } catch (again) {
      // Refused even with a brand-new login: they removed the bot's access.
      throw again.status === 401 ? Object.assign(again, { deauthorized: true }) : again;
    }
  }
}

// One refresh per login at a time (the checks and /backup pull can both need one). Discord replaces the refresh
// token every time, so two at once would make the second one fail.
const refreshing = new Map();
function refreshLogin(client, rec) {
  const key = tokenKey(rec.guildId, rec.userId);
  if (refreshing.has(key)) return refreshing.get(key);
  const run = (async () => {
    if (!rec.refresh) throw Object.assign(new Error('login ran out'), { status: 401, deauthorized: true });
    if (!clientSecret()) throw Object.assign(new Error('no Client Secret'), { body: { error: 'invalid_client' } });
    let token;
    try {
      token = await discordApi('/oauth2/token', null, formRequest({ client_id: clientIdOf(client), client_secret: clientSecret(), grant_type: 'refresh_token', refresh_token: rec.refresh }));
    } catch (err) {
      throw Object.assign(err, { refreshing: true });
    }
    Object.assign(rec, { access: token.access_token, refresh: token.refresh_token ?? rec.refresh, expiresAt: Date.now() + (token.expires_in ?? 604_800) * 1000 });
    flushTokens(); // saved straight away: the old refresh token no longer works
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, run);
  return run;
}

async function warnBadSecret(client) {
  if (Date.now() - secretWarned < 6 * 3_600_000) return;
  secretWarned = Date.now();
  const text = '⚠️ **The 30-second checks are paused:** Discord says the Client Secret in `.env` is wrong (or missing). Developer Portal → your app → **OAuth2** → copy the **Client Secret** into `DISCORD_CLIENT_SECRET=` in `.env`, then press Restart. Nobody has been unverified because of this.';
  console.warn(`[verify] ${text.replace(/\*\*|`/g, '')}`);
  for (const guild of client.guilds.cache.values()) {
    if (!store.guild(guild.id).verify?.enabled) continue;
    const log = await fetchLogChannel(guild);
    await log?.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

/**
 * One round: every verified person's server list (anyone now in a blocked server is restricted), and every member's
 * profile tag. Nothing is saved apart from "checked at".
 */
async function scanOnce(client) {
  const started = Date.now();
  let checked = 0;
  let caught = 0;
  let paused = false;
  const all = tokensBroken ? [] : Object.entries(loadTokens());
  if (all.length && !clientSecret()) {
    paused = true;
    await warnBadSecret(client);
  }
  // The first round loads each server's full member list once; after that Discord keeps it up to date.
  for (const guildId of new Set(all.map(([, rec]) => rec.guildId))) {
    const guild = client.guilds.cache.get(guildId);
    if (guild && !membersLoaded.has(guildId) && (await guild.members.fetch().then(() => true, () => false))) membersLoaded.add(guildId);
  }
  await inBatches(paused ? [] : all, SCAN_AT_ONCE, async ([key, rec]) => {
    if (paused) return;
    const guild = client.guilds.cache.get(rec.guildId);
    if (!guild) return;
    const settings = store.guild(guild.id);
    if (settings.restricted[rec.userId]) return;
    // The bot keeps the member list up to date by itself, so someone missing from it has left.
    if (!membersLoaded.has(guild.id)) return; // couldn't load the list yet: try next round
    const member = guild.members.cache.get(rec.userId);
    if (!member) {
      rec.goneSince ??= Date.now();
      if (Date.now() - rec.goneSince > GONE_FOR_MS) {
        await revokeToken(client, rec.access);
        delete loadTokens()[key];
      }
      return;
    }
    delete rec.goneSince;
    let ids;
    try {
      ids = await serversFor(client, rec);
    } catch (err) {
      if (badSecret(err)) {
        paused = true;
        await warnBadSecret(client);
      } else if (deauthorized(err)) {
        await unverify(member, 'you removed O Jailbreak’s access');
      }
      return; // anything else (Discord busy, rate limits) is just tried again next round
    }
    checked++;
    rec.lastScan = Date.now();
    const hits = blockedHits(settings, ids);
    if (hits.length && (await blockedServers.restrictAssociated(member, `in **${hits.join(', ')}** (found by the 30-second check)`, blockedIdsIn(settings, ids)))?.ok) caught++;
  });
  saveTokens();
  for (const guild of client.guilds.cache.values()) caught += await blockedServers.sweep(guild, { fromCache: true }).catch(() => 0);
  // Everyone must verify: anyone who slipped past (unrestricted, lost Verified, given roles while the bot was busy).
  // Turned off: anyone still waiting for their roles back gets them.
  for (const guild of client.guilds.cache.values()) {
    await gateEveryone(guild, { fromCache: true }).catch(() => null);
    await verifyVips(guild, { fromCache: true }).catch(() => 0);
    await releaseLeftovers(guild, { fromCache: true }).catch(() => 0);
  }
  lastScan = { at: Date.now(), checked, caught, took: Date.now() - started, paused };
  return lastScan;
}

/** Runs the checks forever: each round starts 30 seconds after the last one finished. */
function startScanner(client) {
  if (scanning) return;
  scanning = true;
  const loop = async () => {
    await scanOnce(client).catch((err) => console.warn(`[verify] Check failed: ${err.message}`));
    setTimeout(loop, Math.max(5, options().scanSeconds) * 1000).unref?.();
  };
  setTimeout(loop, 10_000).unref?.();
}

/**
 * The web page has to be running whenever a Verify button can be pressed: verification is on, or a split's Verify
 * messages are posted. The checks always run.
 */
function startIfNeeded(client) {
  const needed = client.guilds.cache.some((g) => store.guild(g.id).verify?.enabled || store.guild(g.id).verify?.split);
  if (needed) startServer(client);
  startScanner(client);
}

// ----- backup server: add everyone who verified to a new server if something happens to this one -----

const canJoin = (rec) => (rec.scope ?? '').split(' ').includes('guilds.join');

/**
 * Who would be added to `targetGuild`: everyone who verified (with the "join servers" permission) in another server,
 * once each. Restricted people are left out, and so is anyone who left the old server on purpose (while it still
 * exists). If the old server is gone, everyone who verified there is included.
 */
async function pullCandidates(client, targetGuild, { fromGuildId = null } = {}) {
  const seen = new Set();
  const candidates = [];
  let left = 0;
  let restricted = 0;
  for (const rec of Object.values(loadTokens())) {
    if (rec.guildId === targetGuild.id || (fromGuildId && rec.guildId !== fromGuildId) || !canJoin(rec) || seen.has(rec.userId)) continue;
    if (store.guild(rec.guildId).restricted[rec.userId]) {
      restricted++;
      continue;
    }
    const source = client.guilds.cache.get(rec.guildId);
    if (source && !source.members.cache.has(rec.userId) && !(await source.members.fetch(rec.userId).catch(() => null))) {
      left++;
      continue;
    }
    seen.add(rec.userId);
    candidates.push(rec);
  }
  return { candidates, left, restricted };
}

/** Adds everyone who verified to the backup server. Owner of the bot only (checked by the command). */
async function pullMembers(client, targetGuild, { fromGuildId = null, onProgress = null } = {}) {
  const { candidates, left, restricted } = await pullCandidates(client, targetGuild, { fromGuildId });
  const result = { total: candidates.length, added: 0, already: 0, noAccess: 0, failed: 0, left, restricted };
  for (const rec of candidates) {
    if (targetGuild.members.cache.has(rec.userId)) {
      result.already++;
      continue;
    }
    const add = () => targetGuild.members.add(rec.userId, { accessToken: rec.access, force: true, fetchWhenExisting: false });
    try {
      if (rec.expiresAt - Date.now() < 60_000) await refreshLogin(client, rec);
      let member;
      try {
        member = await add();
      } catch (err) {
        if (err.code !== 50025 || !rec.refresh) throw err; // 50025 = their login ran out: refresh it and try once more
        await refreshLogin(client, rec);
        member = await add();
      }
      if (member) result.added++;
      else result.already++;
    } catch (err) {
      if (deauthorized(err) || err.code === 50025) result.noAccess++;
      else {
        result.failed++;
        console.warn(`[backup] Couldn't add ${rec.userId} to ${targetGuild.name}: ${err.message}`);
      }
    }
    if (onProgress && (result.added + result.already + result.noAccess + result.failed) % 25 === 0) await onProgress(result).catch(() => {});
  }
  saveTokens();
  return result;
}

// ----- splitting a section: old for people who haven't verified, a fresh copy for Verified -----

/** The member roles in config.js and the auto-role (not @everyone). */
function memberRoleIds(guild, settings) {
  return [...new Set([...(config.updating?.memberRoleIds ?? []), settings.autoroleId])].filter((id) => id && id !== guild.id && guild.roles.cache.has(id));
}

// What a channel's own settings say about View Channel for a role: true, false, or null (not set).
function viewSetting(channel, roleId) {
  const o = channel.permissionOverwrites.cache.get(roleId);
  if (o?.allow.has(P.ViewChannel)) return true;
  if (o?.deny.has(P.ViewChannel)) return false;
  return null;
}

const postable = (ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement;

/** The Verify message at the bottom of each old jailbreak channel (put back if someone deleted it). */
async function postOldSectionNotices(guild) {
  const v = verifySettings(store.guild(guild.id));
  if (!v.split?.oldCategoryId) return 0;
  v.split.notices ??= {};
  let posted = 0;
  for (const ch of guild.channels.cache.values()) {
    if (ch.parentId !== v.split.oldCategoryId || !postable(ch)) continue;
    const existing = v.split.notices[ch.id] ? await ch.messages.fetch(v.split.notices[ch.id]).catch((err) => (err.code === 10008 ? null : true)) : null;
    if (existing === true) continue;
    if (existing) {
      await existing.edit(oldSectionNotice()).catch(() => {});
      continue;
    }
    const sent = await ch.send(oldSectionNotice()).catch(() => null);
    if (sent) {
      v.split.notices[ch.id] = sent.id;
      posted++;
    }
  }
  store.save();
  return posted;
}

/**
 * Splits a section: a copy (empty) for Verified members, while the old one stays for existing members who haven't
 * verified. New joiners (Unverified) see neither.
 *
 * Discord lets a role that's *allowed* into a channel beat a role that's *blocked*, so "verified people stop seeing
 * the old section" only works if the old section is open through @everyone. Channels open to the member roles are
 * switched to @everyone (the same people still see them), and VIP roles' own "can see" is cleared (VIPs are verified,
 * so they see the copies instead). Channels only some roles could see (like a VIP-only channel) stay that way in the copy.
 */
function splitSection(guild, oldCategory, { newName = null } = {}) {
  return exclusive(guild.id, async () => {
    const settings = store.guild(guild.id);
    const v = verifySettings(settings);
    if (!v.verifiedRoleId || !guild.roles.cache.has(v.verifiedRoleId)) throw Object.assign(new Error('Run `/verify setup` first.'), { friendly: true });
    if (oldCategory.type !== ChannelType.GuildCategory) throw Object.assign(new Error('Pick a category (a section), not a single channel.'), { friendly: true });
    // Once is enough: a second split would leave the first new section unprotected.
    if (v.split && guild.channels.cache.has(v.split.oldCategoryId) && guild.channels.cache.has(v.split.newCategoryId)) {
      throw Object.assign(new Error(`It’s already split: old <#${v.split.oldCategoryId}> → new <#${v.split.newCategoryId}>. Delete the new one first if you want to start again.`), { friendly: true });
    }
    const reason = 'O Jailbreak: new section for verified members';
    const memberRoles = memberRoleIds(guild, settings);
    const vipRoles = vipRoleIds(settings).filter((id) => guild.roles.cache.has(id));
    const edit = (ch, roleId, perms, why) => ch.permissionOverwrites.edit(roleId, perms, { reason: why, type: OverwriteType.Role });

    // Which old channels everyone (members) could see, worked out before anything changes.
    const children = [...guild.channels.cache.values()].filter((c) => c.parentId === oldCategory.id).sort((a, b) => a.rawPosition - b.rawPosition);
    const isGeneral = (ch) => viewSetting(ch, guild.id) !== false || memberRoles.some((id) => viewSetting(ch, id) === true);
    const general = new Map([oldCategory, ...children].map((ch) => [ch.id, isGeneral(ch)]));

    // 1. The copy, straight below the old one, with the same permissions to start with.
    const newCategory = await oldCategory.clone({ name: newName ?? oldCategory.name, reason });
    await newCategory.setPosition(oldCategory.position + 1).catch(() => {});
    const pairs = [[oldCategory, newCategory]];
    const failed = [];
    for (const child of children) {
      try {
        pairs.push([child, await child.clone({ parent: newCategory.id, reason })]);
      } catch (err) {
        failed.push(`#${child.name} (${err.message})`);
      }
    }

    // Roles that can see a channel by their own permission. In Discord one role's "allowed" beats another's "blocked",
    // so these would let people past verification. Staff, VIPs (always verified), the Restricted role and the bot's
    // own roles are fine.
    const fine = new Set([guild.id, v.roleId, v.verifiedRoleId, settings.modRoleId, settings.restrict?.roleId, ...vipRoles, ...memberRoles].filter(Boolean));
    const isStaffRole = (id) => Boolean(guild.roles.cache.get(id)?.permissions?.has?.(P.ManageMessages) || guild.roles.cache.get(id)?.permissions?.has?.(P.Administrator));
    const otherRolesIn = (ch) =>
      [...ch.permissionOverwrites.cache.values()].filter((o) => o.type === OverwriteType.Role && o.allow.has(P.ViewChannel) && !fine.has(o.id) && !isStaffRole(o.id)).map((o) => o.id);
    const cleared = new Set();
    const roleOnly = [];
    const verifiedChannels = [];

    for (const [old, copy] of pairs) {
      const why = (what) => `O Jailbreak: ${what}`;
      try {
        // New joiners (Unverified) see neither section.
        await edit(copy, v.roleId, { ViewChannel: false }, why('jailbreaks are hidden until people verify'));
        await edit(old, v.roleId, { ViewChannel: false }, why('jailbreaks are hidden until people verify'));
        if (general.get(old.id)) {
          // New copy: only Verified (not @everyone or the member roles).
          await edit(copy, guild.id, { ViewChannel: false }, why('new section is for verified members'));
          for (const id of memberRoles) await edit(copy, id, { ViewChannel: null }, why('new section is for verified members'));
          await edit(copy, v.verifiedRoleId, { ViewChannel: true, ReadMessageHistory: true }, why('new section is for verified members'));
          verifiedChannels.push(copy.id);
          // Any other role's own access would let people see the new section without verifying, so it goes. (In the
          // old one it's not needed either — @everyone already lets them in — and it would stop Verified hiding it.)
          for (const id of otherRolesIn(copy)) {
            await edit(copy, id, { ViewChannel: null }, why('new section is for verified members'));
            cleared.add(id);
          }
          for (const id of otherRolesIn(old)) {
            await edit(old, id, { ViewChannel: null }, why('old section, for members who haven’t verified'));
            cleared.add(id);
          }

          // Old one: open through @everyone, closed to Verified.
          if (memberRoles.some((id) => viewSetting(old, id) === true)) {
            await edit(old, guild.id, { ViewChannel: true }, why('old section, for members who haven’t verified'));
            for (const id of memberRoles) await edit(old, id, { ViewChannel: null }, why('old section, for members who haven’t verified'));
          }
        } else {
          // A channel only some roles can see (like VIP-only) stays that way. VIPs are always verified; any other role
          // (e.g. Boosters) can't be made to verify too — Discord can't require two roles — so it's reported.
          const others = otherRolesIn(copy);
          if (others.length) roleOnly.push({ channelId: copy.id, roles: others });
        }
        // VIPs are verified, so they see the new copies rather than the old channels.
        for (const id of vipRoles) if (viewSetting(old, id) === true) await edit(old, id, { ViewChannel: null }, why('VIPs see the new section'));
        await edit(old, v.verifiedRoleId, { ViewChannel: false }, why('verified members see the new section'));
      } catch (err) {
        failed.push(`#${old.name} (${err.message})`);
      }
    }

    v.split = { oldCategoryId: oldCategory.id, newCategoryId: newCategory.id, at: Date.now(), notices: {}, verifiedChannels };
    store.save();
    return { newCategory, copied: pairs.length - 1, failed, cleared: [...cleared], roleOnly };
  }).then(async (result) => ({ ...result, notices: await postOldSectionNotices(guild).catch(() => 0) }));
}

// ----- waiting to verify -----
// Someone who hasn't verified — new joiners, or everyone with /verify require-all — only sees #please-read and the
// sections in config.js (verify.visibleSections), and can't chat (automod deletes it and DMs them). They hold only
// Unverified, with their other roles saved until they verify: Discord lets a role that's *allowed* into a channel beat
// one that's *blocked*, so they can't keep the member role while they wait — the same as Restricted. Staff, VIPs, bots
// and restricted people are never touched. To let someone in by hand, give them Verified.
// Saved roles are only ever forgotten once the person has them back (or has left the server).

// Anyone with one of these is staff and never has to wait to verify.
const STAFF_POWERS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages];

// Restricted by the bot, or just given the Restricted role (the record follows a moment later).
const isRestricted = (member, settings) => Boolean(settings.restricted[member.id] || (settings.restrict?.roleId && member.roles?.cache.has(settings.restrict.roleId)));

/** No roles at all (only @everyone). */
const hasNoRoles = (member) => !member.roles?.cache.some((r) => r.id !== member.guild.id);

/** Joined after verification started (or is otherwise a new member who never verified). */
function isNewJoiner(member, v, settings) {
  const held = v.held[member.id];
  if (held) return !held.existing;
  return isUnverified(member, settings) || Boolean(v.pending[member.id]) || (member.joinedTimestamp ?? 0) >= (v.startedAt ?? Infinity);
}

/**
 * Has to verify before they can use the server: verification is on, they're a new member (or require-all is on), and
 * they aren't verified, staff, VIP or restricted.
 */
function mustVerify(member, settings = store.guild(member.guild.id)) {
  const v = verifySettings(settings);
  if (!v.enabled || !member?.user || member.user.bot || member.id === member.guild.ownerId) return false;
  if (hasVerified(member, settings) || isRestricted(member, settings) || isVipMember(member, settings)) return false;
  if (store.isTrusted(member.guild, member.id) || isStaff(member, settings) || member.permissions?.any?.(STAFF_POWERS)) return false;
  // Someone with no roles at all (they'd see whatever @everyone can) is treated like a new member too.
  return Boolean(v.requireAll) || isNewJoiner(member, v, settings) || hasNoRoles(member) || Boolean(v.held[member.id]?.noRoles);
}

// The bot's own roles never go in someone's saved roles: they're handled separately.
const ownRoles = (settings) => new Set([settings.verify?.roleId, settings.verify?.verifiedRoleId, settings.verify?.vipRoom?.roleId, settings.restrict?.roleId].filter(Boolean));

// Roles the bot can take off and give back (not @everyone, its own roles, Booster-type roles or roles above the bot's).
function extraRoles(member, settings) {
  const own = ownRoles(settings);
  return member.roles.cache.filter((r) => r.id !== member.guild.id && !own.has(r.id) && !r.managed && r.editable !== false);
}

function heldRoles(member, settings, held) {
  const own = ownRoles(settings);
  const ids = [...(held?.roles ?? []), ...(settings.autoroleId && !member.pending ? [settings.autoroleId] : [])];
  return [...new Set(ids)].filter((id) => {
    const role = member.guild.roles.cache.get(id);
    return role && !own.has(id) && !role.managed && role.editable !== false;
  });
}

const failedAt = new Map(); // `${guildId}:${userId}` -> when holding someone back last failed (tried again after 10 min)
const noPermissionUntil = new Map(); // guildId -> Discord said "missing permissions": don't keep asking (it can ban the bot)
const PAUSE_MS = 600_000;

async function noPermission(guild) {
  const already = (noPermissionUntil.get(guild.id) ?? 0) > Date.now();
  noPermissionUntil.set(guild.id, Date.now() + PAUSE_MS);
  if (already) return;
  const log = await fetchLogChannel(guild);
  await log
    ?.send({
      content: '⚠️ **Verification:** Discord won’t let me change people’s roles. Drag **O Jailbreak** to the top of Server Settings → Roles (above **Unverified** and your member roles). I’ll try again in 10 minutes.',
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

/** Puts someone who hasn't verified behind the gate: Unverified only, their other roles saved. True if anything changed. */
async function holdBack(member, why = 'has to verify first') {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  if (!v.roleId || !mustVerify(member, settings)) return false;
  const held = (v.held[member.id] ??= { roles: [], existing: !isNewJoiner(member, v, settings), noRoles: hasNoRoles(member), at: Date.now() });
  const extra = extraRoles(member, settings);
  if (isUnverified(member, settings) && !extra.size) {
    store.save();
    return false;
  }
  const key = `${member.guild.id}:${member.id}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < PAUSE_MS || (noPermissionUntil.get(member.guild.id) ?? 0) > Date.now()) return false;
  held.roles = [...new Set([...held.roles, ...extra.keys()])];
  store.flush(); // written down before the roles come off, so a crash can't lose them
  const keep = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== v.roleId && !extra.has(r.id)).map((r) => r.id);
  try {
    await member.roles.set([...keep, v.roleId], `O Jailbreak: ${why} (roles saved until they verify)`);
  } catch (err) {
    failedAt.set(key, Date.now());
    if (err.code === 50013) await noPermission(member.guild);
    else console.warn(`[verify] Couldn't hold back ${member.user.tag} until they verify: ${err.message}`);
    return false;
  }
  failedAt.delete(key);
  return true;
}

/** Someone with Unverified (or saved roles) who doesn't have to verify after all — staff or trusted. */
function shouldLetIn(member, settings) {
  const v = verifySettings(settings);
  if (!v.enabled || member.user?.bot || isRestricted(member, settings) || mustVerify(member, settings)) return false;
  return Boolean(v.held[member.id] || isUnverified(member, settings));
}

/** Their saved roles back and Unverified off (Unverified hides nearly the whole server from them). */
async function letIn(member, why) {
  const settings = store.guild(member.guild.id);
  const v = verifySettings(settings);
  const key = `${member.guild.id}:${member.id}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < PAUSE_MS || (noPermissionUntil.get(member.guild.id) ?? 0) > Date.now()) return false;
  const held = v.held[member.id];
  const back = heldRoles(member, settings, held);
  const current = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== v.roleId).map((r) => r.id);
  const ok = await member.roles.set([...new Set([...current, ...back])], `O Jailbreak: ${why}`).then(
    () => true,
    async (err) => {
      failedAt.set(key, Date.now());
      if (err.code === 50013) await noPermission(member.guild);
      return false;
    },
  );
  if (ok && held && v.held[member.id] === held) delete v.held[member.id];
  delete v.pending[member.id];
  store.save();
  return ok;
}

/**
 * Gives someone who no longer has to wait (require-all turned off, verification turned off) their saved roles back.
 * Existing members lose Unverified. Someone restricted gets them added to what they get back when unrestricted.
 * Returns 'released', 'gone' (left the server — Discord took their roles anyway) or false (try again later).
 */
async function release(guild, settings, userId) {
  const v = verifySettings(settings);
  const record = v.held[userId];
  if (!record) return 'gone';
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch((err) => (err.code === 10007 ? 'left' : null)));
  if (member === 'left') {
    delete v.held[userId];
    store.save();
    return 'gone';
  }
  if (!member) return false;
  if (mustVerify(member, settings)) return false; // still has to verify: keeps waiting
  const restricted = settings.restricted[userId];
  if (restricted) {
    const saved = (restricted.roles ?? []).filter((id) => !(record.existing && id === v.roleId));
    restricted.roles = [...new Set([...saved, ...record.roles, ...(settings.autoroleId ? [settings.autoroleId] : [])])];
    delete v.held[userId];
    store.save();
    return 'released';
  }
  const back = heldRoles(member, settings, record);
  const dropUnverified = record.existing || hasVerified(member, settings);
  const current = member.roles.cache.filter((r) => r.id !== guild.id && (!dropUnverified || r.id !== v.roleId)).map((r) => r.id);
  const ok = await member.roles.set([...new Set([...current, ...back])], 'O Jailbreak: doesn’t have to wait to verify any more').then(
    () => true,
    async (err) => {
      if (err.code === 50013) await noPermission(guild);
      return false;
    },
  );
  if (!ok) return false;
  if (v.held[userId] === record) delete v.held[userId];
  store.save();
  return 'released';
}

/**
 * Anyone with saved roles who no longer has to wait gets them back (also after a restart or Discord hiccup).
 * `fromCache`: only people already in the member list (the 30-second round: no looking people up one by one).
 */
async function releaseLeftovers(guild, { fromCache = false } = {}) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  if (!Object.keys(v.held).length || releasing.has(guild.id)) return 0;
  releasing.add(guild.id);
  try {
    let released = 0;
    for (const userId of Object.keys(v.held)) {
      if ((noPermissionUntil.get(guild.id) ?? 0) > Date.now()) break; // Discord said no
      const member = guild.members.cache.get(userId);
      if (member && mustVerify(member, settings)) continue; // still has to verify
      if (!member && fromCache) continue;
      if ((await release(guild, settings, userId)) === 'released') released++;
    }
    return released;
  } finally {
    releasing.delete(guild.id);
  }
}
const releasing = new Set();

// #restricted and the Appeals category (restricted people never hold Unverified, but they're left alone anyway).
function isRestrictSpace(channel, settings) {
  const r = settings.restrict ?? {};
  return [r.channelId, r.categoryId, ...(r.extraCategoryIds ?? [])].filter(Boolean).some((id) => channel.id === id || channel.parentId === id);
}

// The sections people who haven't verified can see (config.js → verify.visibleSections).
const visibleSectionIds = () => (options().visibleSections ?? []).filter(Boolean);
const inVisibleSection = (channel) => visibleSectionIds().some((id) => channel.id === id || channel.parentId === id);

/**
 * A channel ordinary members can see (someone with just @everyone and the member roles), worked out the way Discord
 * does: the server-wide permissions, then @everyone's setting on the channel, then the member roles' (allow beats deny).
 */
function isGeneral(guild, settings, channel) {
  const memberRoles = memberRoleIds(guild, settings);
  const roleCan = (id) => guild.roles.cache.get(id)?.permissions?.has?.(P.ViewChannel) ?? id === guild.id;
  let can = roleCan(guild.id) || memberRoles.some(roleCan);
  const everyone = viewSetting(channel, guild.id);
  if (everyone !== null) can = everyone;
  const roles = memberRoles.map((id) => viewSetting(channel, id));
  if (roles.includes(false)) can = false;
  if (roles.includes(true)) can = true;
  return can;
}

/** What Unverified should have for View Channel here: true, false, or null (leave it alone). */
function wantedView(guild, settings, v, channel) {
  if (!channel.permissionOverwrites || channel.id === v.channelId || isRestrictSpace(channel, settings)) return null;
  if (inSection(v, channel)) return false; // the jailbreaks
  if (inVisibleSection(channel)) return isGeneral(guild, settings, channel);
  // An admin let Unverified into a channel on purpose (say #rules): left that way.
  if (viewSetting(channel, v.roleId) === true && !(v.visibleApplied ?? []).includes(channel.id)) return null;
  return false;
}

const hideFailedAt = new Map(); // channelId -> when changing it for Unverified last failed (tried again after an hour)

// In the sections they can see: read, and type (it's deleted with a "please verify" DM), but no reactions or threads.
const VISIBLE = { ViewChannel: true, ReadMessageHistory: true, AddReactions: false, CreatePublicThreads: false, CreatePrivateThreads: false };
const VISIBLE_DENIED = [P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads];

function hasWanted(channel, roleId, wanted) {
  const o = channel.permissionOverwrites?.cache.get(roleId);
  if (!o) return false;
  return wanted ? o.allow.has(P.ViewChannel) && VISIBLE_DENIED.every((p) => o.deny.has(p)) : o.deny.has(P.ViewChannel);
}

/** Shows or hides one channel for people who haven't verified. Returns false if Discord wouldn't let it change. */
async function applyUnverifiedView(guild, v, channel) {
  const settings = store.guild(guild.id);
  const wanted = wantedView(guild, settings, v, channel);
  // Remembered whenever it's meant to be visible (even if the allow came from its category), so moving it out of the
  // section hides it again.
  if (wanted === true && !(v.visibleApplied ?? []).includes(channel.id)) {
    v.visibleApplied = [...(v.visibleApplied ?? []), channel.id];
    store.save();
  }
  if (wanted === null || hasWanted(channel, v.roleId, wanted) || Date.now() - (hideFailedAt.get(channel.id) ?? 0) < 3_600_000) return true;
  const perms = wanted ? VISIBLE : { ViewChannel: false };
  const reason = wanted ? 'O Jailbreak: people who haven’t verified can read this section' : 'O Jailbreak: hidden until people verify';
  const ok = await channel.permissionOverwrites.edit(v.roleId, perms, { reason, type: OverwriteType.Role }).then(
    () => true,
    () => false,
  );
  if (!ok) {
    hideFailedAt.set(channel.id, Date.now());
    return false;
  }
  hideFailedAt.delete(channel.id);
  const applied = new Set(v.visibleApplied ?? []);
  if (wanted) applied.add(channel.id);
  else applied.delete(channel.id);
  v.visibleApplied = [...applied];
  store.save();
  return true;
}

/**
 * Every channel: hidden from Unverified, except #please-read and the visible sections. Also puts things back after
 * something (like ending a lockdown) resets a channel. Returns the channels it couldn't change.
 */
async function applyUnverifiedLayout(guild, v) {
  const failed = [];
  await inBatches([...guild.channels.cache.values()], 5, async (ch) => {
    if (!(await applyUnverifiedView(guild, v, ch).catch(() => false))) failed.push(`#${ch.name}`);
  });
  return failed;
}

const gating = new Map(); // guildId -> { total, done, failed, kept } while people are being held back
const repairAt = new Map(); // guildId -> when a deleted role or #please-read was last put back

/**
 * Holds back everyone who has to verify and isn't yet (the first time can take a while on a big server), lets in staff
 * who were stuck with Unverified, and fixes any channel that lost its setting. `kept` counts people left holding a role
 * the bot can't remove (Server Booster, or above the bot's role): a channel that lets that role in, they still see.
 */
async function gateEveryone(guild, { fromCache = false, onProgress = null } = {}) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  if (!v.enabled || !v.roleId || gating.has(guild.id)) return null;
  const progress = { total: 0, done: 0, failed: 0, kept: 0 };
  gating.set(guild.id, progress);
  try {
    // A role or #please-read was deleted: put them back first (at most every 10 minutes). Without the Verified role
    // nobody would count as verified, so nobody is touched until it's back.
    if (!guild.roles.cache.has(v.roleId) || !guild.roles.cache.has(v.verifiedRoleId) || !guild.channels.cache.has(v.channelId)) {
      if (Date.now() - (repairAt.get(guild.id) ?? 0) > PAUSE_MS) {
        repairAt.set(guild.id, Date.now());
        await ensureSetup(guild).catch((err) => console.warn(`[verify] ${guild.name}: couldn't put verification back: ${err.message}`));
      }
      return progress;
    }
    await applyUnverifiedLayout(guild, v);
    const members = fromCache ? guild.members.cache : await guild.members.fetch().catch(() => guild.members.cache);
    for (const member of members.values()) if (shouldLetIn(member, settings)) await letIn(member, 'doesn’t have to verify (staff or trusted)');
    const own = ownRoles(settings);
    const todo = [...members.values()].filter((m) => mustVerify(m, settings) && (!isUnverified(m, settings) || extraRoles(m, settings).size));
    progress.total = todo.length;
    for (const member of todo) {
      if (!v.enabled || (noPermissionUntil.get(guild.id) ?? 0) > Date.now()) break; // turned off, or Discord said no
      if (await holdBack(member)) progress.done++;
      else progress.failed++;
      if (member.roles.cache.some((r) => r.id !== guild.id && !own.has(r.id) && (r.managed || r.editable === false))) progress.kept++;
      if (onProgress && (progress.done + progress.failed) % 100 === 0) await onProgress(progress).catch(() => {});
    }
    return progress;
  } finally {
    gating.delete(guild.id);
  }
}

/** Everyone must verify from now on, existing members too (verification has to be on and working — the command checks). */
async function requireAllOn(guild) {
  const v = verifySettings(store.guild(guild.id));
  v.requireAll = true;
  store.save();
  noPermissionUntil.delete(guild.id);
  let channel;
  let notHidden;
  try {
    ({ channel, notHidden } = await ensureSetup(guild));
  } catch (err) {
    v.requireAll = false; // couldn't set it up: left off, so nobody is locked out behind a #please-read that isn't there
    store.save();
    throw err;
  }
  await verifyVips(guild);
  return { channel, notHidden };
}

/**
 * Back to only new members verifying: existing members held back get their roles back and lose Unverified. Anyone it
 * couldn't do yet keeps their saved roles, and is tried again every 30 seconds and at startup.
 */
async function requireAllOff(guild) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  v.requireAll = false;
  store.flush();
  while (gating.has(guild.id)) await new Promise((resolve) => setTimeout(resolve, 200)); // let a round in progress stop
  const released = await releaseLeftovers(guild);
  const left = Object.entries(v.held).filter(([, record]) => record.existing && !record.noRoles).length;
  return { released, left };
}

// ----- turning it on and off -----

async function enable(guild) {
  const v = verifySettings(store.guild(guild.id));
  const wasOn = v.enabled;
  v.enabled = true;
  v.startedAt ??= Date.now(); // only people who join from now on get Unverified
  let channel;
  try {
    ({ channel } = await ensureSetup(guild));
  } catch (err) {
    v.enabled = wasOn;
    store.save();
    throw err;
  }
  store.save();
  startServer(guild.client);
  startScanner(guild.client);
  const vips = await verifyVips(guild);
  gateEveryone(guild).catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));
  return { channel, vips };
}

/** Turns verification off: everyone waiting gets their roles back and loses Unverified. */
async function disable(guild) {
  const settings = store.guild(guild.id);
  const v = verifySettings(settings);
  v.enabled = false;
  v.requireAll = false;
  v.startedAt = null;
  store.save();
  while (gating.has(guild.id)) await new Promise((resolve) => setTimeout(resolve, 200)); // let a round in progress stop
  await releaseLeftovers(guild);
  await releasePausedVips(guild);
  let letIn = 0;
  const everyone = v.roleId ? await guild.members.fetch().catch(() => guild.members.cache) : new Map();
  for (const member of everyone.values()) {
    if (!member.roles.cache.has(v.roleId)) continue;
    if (await member.roles.remove(v.roleId, 'O Jailbreak: verification turned off').then(() => true, () => false)) letIn++;
  }
  v.pending = {};
  store.save();
  return letIn;
}

function status(guild) {
  const v = verifySettings(store.guild(guild.id));
  return {
    enabled: v.enabled,
    requireAll: Boolean(v.enabled && v.requireAll),
    held: Object.keys(v.held).filter((id) => guild.members.cache.has(id)).length,
    gating: gating.get(guild.id) ?? null,
    startedAt: v.startedAt,
    pending: Object.keys(v.pending).length,
    verified: Object.keys(v.verified).filter((id) => !v.verified[id].blocked?.length).length,
    checking: Object.values(loadTokens()).filter((t) => t.guildId === guild.id).length,
    lastScan,
    split: v.split ?? null,
    channelId: v.channelId,
    redirectUri: redirectUri(),
    listening,
    problems: setupProblems(),
  };
}

module.exports = {
  publicUrl,
  redirectUri,
  listenPort,
  setupProblems,
  ensureSetup,
  isUnverified,
  hasVerified,
  mustVerify,
  onMemberLeave,
  holdBack,
  gateEveryone,
  requireAllOn,
  requireAllOff,
  markVerified,
  unverify,
  onVipLost,
  onMemberUpdate,
  verifyVips,
  holdVip,
  queueVipDms,
  dropPausedVip,
  releasePausedVips,
  onJoin,
  resume,
  onChannelCreate,
  onChannelUpdate,
  flushTokens,
  startButton,
  handleCallback,
  hasSavedLogin,
  serverListOf,
  recheckLink,
  finish,
  startServer,
  startScanner,
  startIfNeeded,
  scanOnce,
  enable,
  disable,
  status,
  splitSection,
  postOldSectionNotices,
  pullCandidates,
  pullMembers,
  verifyChannelPanel,
  oldSectionNotice,
  announcementPanel,
  _states: states,
  _internals: { refreshLogin, deauthorized, badSecret },
  _tokens: loadTokens,
};
