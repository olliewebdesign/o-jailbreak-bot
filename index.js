'use strict';

const { loadEnv } = require('./env');
loadEnv();

const { Client, DefaultRestOptions, Events, GatewayIntentBits, OAuth2Scopes, Options, Partials } = require('discord.js');
const store = require('./store');
const automod = require('./automod');
const antinuke = require('./antinuke');
const autorole = require('./autorole');
const restrict = require('./restrict');
const banList = require('./banList');
const invites = require('./invites');
const levels = require('./levels');
const giveaway = require('./giveaway');
const commandAccess = require('./commandAccess');
const blockedServers = require('./blockedServers');
const verify = require('./verify');
const messageLog = require('./messageLog');
const nameAds = require('./nameAds');
const nameWatch = require('./nameWatch');
const modGuard = require('./modGuard');
const vipLock = require('./vipLock');
const memberCounter = require('./memberCounter');
const updating = require('./updating');
const updater = require('./updater');
const { BOT_PERMISSIONS, registerCommands } = require('./commands');
const { handleInteraction } = require('./interactions');
const { FATAL, TEMPORARY } = require('./launcher'); // exit codes the launcher understands
const { codeBlock, exitCleanly, retryConnectErrors } = require('./util');
const { version } = require('../package.json');

const token = process.env.DISCORD_TOKEN?.trim();
if (!token || token === 'paste-your-bot-token-here') {
  console.error('\n❌ No bot token found.');
  console.error('   Open the .env file in the O Jailbreak folder and paste your token after DISCORD_TOKEN=\n');
  process.exit(FATAL);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, // audit log events for anti-nuke
    GatewayIntentBits.GuildMembers, // people joining: auto-role, and restricted people rejoining
    GatewayIntentBits.GuildInvites, // which invite link someone joined with (VIP rewards)
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: [] },
  // Keep memory low for small hosting plans: the bot never needs old messages cached.
  makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
  sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 1800, lifetime: 1800 } },
  // Hosting sites sometimes can't open a connection to Discord for a moment: try those requests again.
  rest: { timeout: 30_000, makeRequest: retryConnectErrors(DefaultRestOptions.makeRequest) },
});

function logError(where) {
  return (err) => console.error(`[${where}]`, err);
}

// Tells whoever ran /update how it went. A new version counts as working once it has stayed online for 15 seconds;
// if it stops before then, the launcher puts the old version back and that version reports the failure.
async function reportUpdate(client) {
  const dm = (userId, content) =>
    client.users
      .fetch(userId)
      .then((user) => user.send(content))
      .catch(() => {});

  const failed = updater.takeFailure();
  if (failed) {
    console.error(`[update] v${failed.toVersion} wouldn't start, so v${version} was put back.`);
    await dm(failed.by, `❌ **The update to v${failed.toVersion} wouldn’t start**, so I put v${version} back — everything is as it was.\nWhat went wrong:\n${codeBlock(failed.error, 1500)}`);
  }
  if (!updater.pendingUpdate()) return;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const done = updater.confirmUpdate();
  if (!done) return;

  console.log(`[update] Updated from v${done.fromVersion} to v${version}.`);
  // The watcher process keeps running the code it started with, so one restart on the host finishes the job.
  const restartNote = updater.launcherOutOfDate(version)
    ? '\n\n⚠️ **One more thing:** press **Restart** on your hosting panel when you get a chance. The part that restarts me is still running the older version, so until you do, the next update may say it “wouldn’t start” and you’d have to run `/update` twice.'
    : '';
  if (restartNote) console.warn('[update] Press Restart on the host: the launcher is still running the previous version.');
  await dm(done.by, `✅ **O Jailbreak is updated to v${version}** (was v${done.fromVersion}) and back online.${restartNote}`);
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`\n✅ ${ready.user.tag} is online in ${ready.guilds.cache.size} server(s). (v${version})`);
  reportUpdate(ready).catch(logError('update'));
  const invite = ready.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: BOT_PERMISSIONS,
  });
  console.log(`\n➕ Invite link (add O Jailbreak to a server):\n${invite}\n`);

  // Invite links first, so joins in the first few seconds are credited to the right person.
  await Promise.all(ready.guilds.cache.map((guild) => invites.refresh(guild).catch(() => null)));
  for (const guild of ready.guilds.cache.values()) await registerCommands(guild);
  // Members need "Use Application Commands" to see /invites, /rank and /leaderboard at all.
  for (const guild of ready.guilds.cache.values()) await commandAccess.check(guild).catch(logError('commands'));
  console.log('Slash commands are ready. Leave this window open to keep the bot online.\n');
  giveaway.startTimer(ready);
  verify.startIfNeeded(ready); // the web page Discord sends people back to after they verify

  // Servers that are already set up get everything they need before anyone uses it.
  for (const guild of ready.guilds.cache.values()) {
    // Still updating: the role and hidden channels for anyone or anything that arrived while the bot was off.
    updating.resume(guild).catch(logError('updating'));
    // 👥 Members / 📈 Last 24h channels (if /membercount is on): updated every 10 minutes.
    memberCounter.start(guild);
    if (!store.guild(guild.id).logChannelId) continue;
    await restrict.prepare(guild, { retries: 10 });
    // Restricted people who picked up roles (like VIP) while the bot was off lose them again.
    await restrict.sweepRestrictedRoles(guild).catch(logError('restrict'));
    // Appeal tickets for a blocked server opened before the 🔄 Recheck button existed get it too.
    await require('./appealRecheck').addToOpenTickets(guild).catch(logError('recheck'));
    // Blocked servers: work out which servers the invites belong to, then catch anyone here wearing their tag.
    await blockedServers.prepare(guild).catch(logError('blocked servers'));
    blockedServers.sweep(guild).catch(logError('blocked servers'));
    await banList.prepare(guild, { retries: 10 });
    // Moderators: the mod role's permissions, #mod-watch, and the logs hidden from them.
    await modGuard.prepare(guild).catch(logError('mod watch'));
    // VIP channels hidden from @everyone (not just the member role), so nobody without roles can see them.
    await vipLock.start(guild);
    // Anyone who joined while the bot was off still gets the member role.
    // People who joined while the bot was off still have to verify (done before auto-role so they don't slip past).
    await verify.resume(guild).catch(logError('verify'));
    await autorole.syncMembers(guild, { announce: true }).catch(() => {});
    // Anyone whose name is an advert ("discord.gg/abc", "t.me/abc").
    nameAds.sweep(guild).catch(logError('name ads'));
  }
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`➕ Added to "${guild.name}". Run /setup there.`);
  registerCommands(guild);
  invites.refresh(guild).catch(() => {});
});

client.on(Events.MessageCreate, async (message) => {
  messageLog.remember(message); // so the text can be shown in the logs if it's deleted
  // A message that broke a rule earns no XP.
  const punished = await automod.handleMessage(message).catch(logError('message'));
  if (!punished) await levels.onMessage(message).catch(logError('levels'));
});
client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  messageLog.onUpdate(oldMessage, newMessage).catch(logError('logs'));
  automod.handleEdit(oldMessage, newMessage).catch(logError('edit'));
});
client.on(Events.MessageDelete, (message) => messageLog.onDelete(message).catch(logError('logs')));
client.on(Events.MessageBulkDelete, (messages, channel) => messageLog.onBulkDelete(messages, channel).catch(logError('logs')));
client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction).catch(logError('interaction')));
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  antinuke.handleAuditLogEntry(entry, guild).catch(logError('anti-nuke'));
  restrict.onAuditLogEntry(entry, guild).catch(logError('restrict role'));
  banList.onAuditLogEntry(entry, guild).catch(logError('ban list'));
  modGuard.onAuditLogEntry(entry, guild).catch(logError('mod watch'));
});
client.on(Events.GuildBanAdd, (ban) => {
  banList.onBanAdd(ban).catch(logError('ban list'));
  restrict.onBanAdd(ban).catch(logError('restrict')); // closes their appeal ticket, if they had one open
});
client.on(Events.GuildBanRemove, (ban) => banList.onBanRemove(ban).catch(logError('ban list')));
client.on(Events.InviteCreate, (invite) => invites.onInviteCreate(invite));
client.on(Events.InviteDelete, (invite) => invites.onInviteDelete(invite));
client.on(Events.GuildMemberAdd, (member) => {
  memberCounter.onJoin(member);
  autorole.onMemberAdd(member).catch(logError('member join'));
});
client.on(Events.GuildMemberRemove, (member) => {
  memberCounter.onLeave(member);
  verify.onMemberLeave(member);
  invites.onMemberLeave(member).catch(logError('invites'));
  giveaway.onMemberLeave(member).catch(logError('giveaway'));
});
client.on(Events.UserUpdate, (oldUser, user) => {
  blockedServers.onUserUpdate(client, user).catch(logError('blocked servers'));
  if (oldUser.partial || oldUser.globalName !== user.globalName || oldUser.username !== user.username) nameAds.onUserUpdate(client, user).catch(logError('name ads'));
  if (!oldUser.partial && (oldUser.globalName !== user.globalName || oldUser.username !== user.username)) nameWatch.onUserUpdate(client, user).catch(logError('name watch'));
});
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  autorole.onMemberUpdate(oldMember, newMember).catch(logError('member update'));
  modGuard.onMemberUpdate(oldMember, newMember); // given or lost the mod role: the channels mods can't see
});
client.on(Events.ChannelCreate, (channel) => {
  restrict.onChannelCreate(channel).catch(logError('channel create'));
  verify.onChannelCreate(channel).catch(logError('verify'));
  updating.onChannelChange(channel).catch(logError('updating'));
});
client.on(Events.ChannelUpdate, (oldChannel, channel) => {
  updating.onChannelChange(channel).catch(logError('updating'));
  verify.onChannelUpdate(oldChannel, channel).catch(logError('verify'));
});

client.on(Events.ShardDisconnect, (event) => {
  if (event.code === 4014) {
    console.error('\n❌ Discord blocked the connection because an intent is switched off.');
    console.error('   Developer Portal → your app → Bot → Privileged Gateway Intents → turn on BOTH:');
    console.error('     • SERVER MEMBERS INTENT');
    console.error('     • MESSAGE CONTENT INTENT');
    console.error('   Then press Save Changes and restart the bot.\n');
    exitCleanly(client, FATAL);
  }
});
client.on(Events.Error, logError('client'));
process.on('unhandledRejection', logError('unhandled'));

function shutdown() {
  try {
    store.flush();
    verify.flushTokens();
  } finally {
    exitCleanly(client, 0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // console window closed on Windows

client.login(token).catch((err) => {
  if (err.code === 'TokenInvalid') {
    console.error('\n❌ Discord says the bot token is wrong.');
    console.error('   Developer Portal → your app → Bot → Reset Token, then paste the new token into .env\n');
    return exitCleanly(client, FATAL);
  }
  // Anything else (Discord having an outage, the host's internet dropping) fixes itself, so the launcher tries again.
  console.error(`\n⚠️ Couldn't reach Discord: ${err.message}`);
  console.error('   This is usually Discord having problems (see https://discordstatus.com) — O Jailbreak will keep trying to connect.\n');
  return exitCleanly(client, TEMPORARY);
});
