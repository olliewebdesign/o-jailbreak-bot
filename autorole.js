'use strict';

// Gives the auto-role (e.g. @Member) to people who join. Restricted people who rejoin get the Restricted role instead.

const store = require('./store');
const restrict = require('./restrict');
const invites = require('./invites');
const welcome = require('./welcome');
const giveaway = require('./giveaway');
const blockedServers = require('./blockedServers');
const blocklist = require('./blocklist');
const verify = require('./verify');
const nameAds = require('./nameAds');
const nameWatch = require('./nameWatch');
const { fetchLogChannel } = require('./caseLog');

const MAX_CATCH_UP = 500;

const warned = new Set();
async function warnOnce(guild, key, text) {
  if (warned.has(`${guild.id}:${key}`)) return;
  warned.add(`${guild.id}:${key}`);
  console.warn(`[auto-role] ${guild.name}: ${text}`);
  const log = await fetchLogChannel(guild);
  await log?.send({ content: `⚠️ **Auto-role isn’t working:** ${text}`, allowedMentions: { parse: [] } }).catch(() => {});
}

// Why the auto-role can't be given right now, or null if all is well.
function autoroleProblem(guild, settings) {
  if (!settings.autoroleId) return 'No role is set yet. Run `/autorole set role:@Member`.';
  const role = guild.roles.cache.get(settings.autoroleId);
  if (!role) return 'the role I was told to give was deleted. Run `/autorole set` again.';
  if (!role.editable) return `I can't give **@${role.name}** — drag **O Jailbreak** above it in Server Settings → Roles.`;
  return null;
}

async function giveAutorole(member) {
  const settings = store.guild(member.guild.id);
  if (!settings.autoroleId || member.user.bot || settings.restricted[member.id]) return false;
  // Everyone must verify: they get it (with the rest of their roles) when they do.
  if (verify.mustVerify(member, settings)) return false;

  const problem = autoroleProblem(member.guild, settings);
  if (problem) {
    await warnOnce(member.guild, 'problem', problem);
    return false;
  }
  const role = member.guild.roles.cache.get(settings.autoroleId);
  if (member.roles.cache.has(role.id)) return false;
  return member.roles.add(role, 'O Jailbreak auto-role').then(
    () => true,
    async (err) => {
      await warnOnce(member.guild, 'add', `couldn't give **@${role.name}** to ${member.user.tag} (${err.message}).`);
      return false;
    },
  );
}

async function onMemberAdd(member) {
  // Verification is on: Unverified goes on first, so there's no moment where they could see the jailbreaks.
  await verify.onJoin(member).catch(() => false);
  // A name like the owner's ("ellie", "eliot"): the owner gets a DM.
  await nameWatch.check(member, 'joined').catch((err) => console.warn(`[name watch] ${err.message}`));
  const invite = await invites.onMemberJoin(member).catch((err) => {
    console.warn(`[invites] ${member.guild.name}: ${err.message}`);
    return null;
  });
  if (invite?.counted && invite.inviterId) {
    await giveaway.onCountedJoin(member.guild, invite.inviterId, member.id).catch((err) => console.warn(`[giveaway] ${err.message}`));
  }
  if (await restrict.reapplyIfRestricted(member)) return;
  // Wearing a blocked server's tag: restricted straight away (no welcome, no member role).
  if ((await blockedServers.checkMember(member, { fresh: true }).catch(() => null))?.ok) return;
  // On the blocklist (a known member of a blocked server): restricted straight away too.
  if ((await blocklist.checkMember(member).catch(() => null))?.ok) return;
  // A name like "discord.gg/abc": their nickname here is changed before anyone is welcomed by it.
  await nameAds.check(member).catch((err) => console.warn(`[name ads] ${err.message}`));
  // Servers with rules screening: wait until they've accepted the rules.
  if (member.pending) return;
  await welcome.welcome(member, invite).catch((err) => console.warn(`[welcome] ${err.message}`));
  await giveAutorole(member);
}

async function onMemberUpdate(oldMember, newMember) {
  // Changed their nickname here to a blocked name (like "anonymouse"): restricted straight away.
  if (oldMember.partial || oldMember.nickname !== newMember.nickname) {
    if ((await blockedServers.checkMember(newMember).catch(() => null))?.ok) return;
  }
  // Changed their nickname to an advert: changed back.
  if (oldMember.partial || oldMember.nickname !== newMember.nickname) await nameAds.check(newMember).catch((err) => console.warn(`[name ads] ${err.message}`));
  // Changed their nickname to look like the owner's.
  if (!oldMember.partial && oldMember.nickname !== newMember.nickname) await nameWatch.check(newMember, 'renamed').catch((err) => console.warn(`[name watch] ${err.message}`));
  // Whoever gave a restricted person a role (a mod, another bot), it's taken back off and saved for later.
  if (store.guild(newMember.guild.id).restricted[newMember.id]) {
    await restrict.holdBackRoles(newMember);
    return;
  }
  // Got VIP: verified automatically.
  await verify.onMemberUpdate(oldMember, newMember).catch((err) => console.warn(`[verify] ${err.message}`));
  const acceptedRules = oldMember.pending === true && newMember.pending === false;
  // After a restart we may not know their old state; still give the role to recent joiners who don't have it.
  const recentJoinerAfterRestart = oldMember.partial && !newMember.pending && Date.now() - (newMember.joinedTimestamp ?? 0) < 86_400_000;
  if (!acceptedRules && !recentJoinerAfterRestart) return;
  // In case Discord didn't let the Unverified role on while they were still accepting the rules.
  if (acceptedRules) await verify.onJoin(newMember).catch(() => false);
  if (acceptedRules) await welcome.welcome(newMember).catch((err) => console.warn(`[welcome] ${err.message}`));
  await giveAutorole(newMember);
}

/**
 * Gives the auto-role to everyone who is missing it — people who joined while the bot was offline, or before
 * the role was set up. Runs at startup and from /autorole sync.
 */
async function syncMembers(guild, { announce = false } = {}) {
  const settings = store.guild(guild.id);
  const problem = autoroleProblem(guild, settings);
  if (problem) return { ok: false, given: 0, text: `⚠️ ${problem}` };

  const role = guild.roles.cache.get(settings.autoroleId);
  const everyone = await guild.members.fetch().catch(() => null);
  if (!everyone) {
    return {
      ok: false,
      given: 0,
      text: '⚠️ Discord wouldn’t send me the member list. Turn on **SERVER MEMBERS INTENT** in the Developer Portal → your app → Bot, then restart me.',
    };
  }

  const missing = [...everyone.values()].filter(
    (m) => !m.user.bot && !m.pending && !settings.restricted[m.id] && !m.roles.cache.has(role.id) && !verify.mustVerify(m, settings),
  );
  let given = 0;
  for (const member of missing.slice(0, MAX_CATCH_UP)) {
    if (await member.roles.add(role, 'O Jailbreak auto-role (catching up)').then(() => true, () => false)) given++;
  }

  const more = missing.length > MAX_CATCH_UP ? ` ${missing.length - MAX_CATCH_UP} left — run \`/autorole sync\` again.` : '';
  const text = given ? `✅ Gave **@${role.name}** to ${given} member(s) who didn’t have it.${more}` : `✅ Everyone already has **@${role.name}**.`;
  if (given && announce) {
    const log = await fetchLogChannel(guild);
    await log?.send({ content: `🎭 Gave **@${role.name}** to ${given} member(s) who joined without it.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  return { ok: true, given, text };
}

module.exports = { onMemberAdd, onMemberUpdate, giveAutorole, syncMembers };
