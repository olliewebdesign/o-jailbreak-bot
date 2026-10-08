'use strict';

// What happens when a moderator presses Unmute / Ban / Keep Muted (or uses /unmute).

const store = require('./store');
const { CLOSED_STATUSES, refreshCaseLog } = require('./caseLog');
const { timeoutMember } = require('./punish');
const { truncate } = require('./util');

function isClosed(c) {
  return CLOSED_STATUSES.includes(c.status);
}

/**
 * Why this moderator can't unmute this person, or null if they can. Nobody reviews their own case, and while someone
 * has an open anti-nuke or staff-watch case only the owner or trusted users can unmute them — whichever case or
 * command is used (so a second case can't be used to lift the first one's timeout).
 */
function unmuteProblem(guild, userId, moderatorId) {
  if (userId === moderatorId) return '🚫 You can’t review your own case.';
  if (store.isTrusted(guild, moderatorId)) return null;
  const serious = store
    .casesForUser(guild.id, userId)
    .find((c) => !isClosed(c) && (c.type === 'ANTINUKE' || c.type === 'STAFF' || c.strippedRoles?.length));
  if (!serious) return null;
  return `🚫 They have an open ${serious.type === 'STAFF' ? 'staff-watch' : 'anti-nuke'} case (#${serious.id}). Only the server owner or trusted users can unmute them.`;
}

/** The case /unmute should close: their newest open case where they were actually muted. */
function openMuteCase(guildId, userId) {
  return store.casesForUser(guildId, userId).find((c) => !isClosed(c) && c.type !== 'RESTRICT' && c.timedOut);
}

async function unmuteCase(guild, c, moderator, note = null) {
  const reason = truncate(`O Jailbreak • Case #${c.id} reviewed: unmuted by ${moderator.tag}`, 512);
  const member = await guild.members.fetch(c.userId).catch(() => null);
  const lines = [];

  if (!member) {
    lines.push('They are not in the server right now, so there was no timeout to remove.');
  } else {
    if (member.isCommunicationDisabled()) {
      try {
        await member.timeout(null, reason);
        lines.push('🔊 Timeout removed.');
      } catch (err) {
        return { ok: false, text: `❌ Couldn't remove the timeout: ${err.message}` };
      }
    } else {
      lines.push('Their timeout had already ended.');
    }

    if (c.strippedRoles?.length) {
      const giveBack = c.strippedRoles.filter((id) => guild.roles.cache.get(id)?.editable);
      if (giveBack.length) {
        try {
          await member.roles.add(giveBack, reason);
          lines.push(`🎭 Gave back ${giveBack.length} role(s).`);
        } catch (err) {
          lines.push(`⚠️ Couldn't give their roles back: ${err.message}`);
        }
      }
      const missing = c.strippedRoles.length - giveBack.length;
      if (missing > 0) lines.push(`⚠️ ${missing} role(s) couldn't be given back (deleted, or now above my role).`);
    }
  }

  store.updateCase(guild.id, c.id, { status: 'UNMUTED', resolvedBy: moderator.id, resolvedAt: Date.now(), resolutionNote: note });
  await refreshCaseLog(guild, c);
  return { ok: true, text: [`✅ Case #${c.id}: **${c.userTag}** unmuted.`, ...lines].join('\n') };
}

async function keepCase(guild, c, moderator) {
  store.updateCase(guild.id, c.id, { status: 'KEPT', resolvedBy: moderator.id, resolvedAt: Date.now() });
  await refreshCaseLog(guild, c);
  if (c.noMute) return { ok: true, text: `✅ Case #${c.id}: reviewed, **${c.userTag}** isn’t muted.` };
  return { ok: true, text: `🔒 Case #${c.id}: the mute on **${c.userTag}** stays.` };
}

/** 🔇 Mute on a case that was only deleted and logged: times them out, and the case becomes a normal mute case. */
async function muteCase(guild, c, moderator, member) {
  const timeout = await timeoutMember(member, `Case #${c.id}: muted by ${moderator.tag} (${c.label})`);
  if (!timeout.timedOut) return { ok: false, text: timeout.note.replace(/^⚠️ /, '❌ ') };
  store.updateCase(guild.id, c.id, {
    noMute: false,
    timedOut: true,
    timeoutUntil: timeout.until,
    actionNote: [timeout.note.replace('Timed out', `Timed out by <@${moderator.id}>`), ...(c.actionNote ?? '').split('\n').filter((l) => !l.startsWith('💬'))].join('\n'),
  });
  await refreshCaseLog(guild, c);
  await member
    .send(`🔇 **You were muted in ${guild.name}** for ${c.label.toLowerCase()} (case #${c.id}). ${timeout.note.replace(/^🔇 /, '')}.`)
    .catch(() => {});
  return { ok: true, text: `🔇 Case #${c.id}: **${c.userTag}** muted. ${timeout.note}` };
}

async function banCase(guild, c, moderator, reason, deleteHours) {
  const member = await guild.members.fetch(c.userId).catch(() => null);
  if (member && !member.bannable) {
    return { ok: false, text: "❌ I can't ban them — they're the owner/an admin, or their role is above mine." };
  }
  try {
    await guild.members.ban(c.userId, {
      reason: truncate(`${reason} — banned by ${moderator.tag} after reviewing O Jailbreak case #${c.id}`, 512),
      deleteMessageSeconds: deleteHours * 3600,
    });
  } catch (err) {
    return { ok: false, text: `❌ Ban failed: ${err.message}` };
  }

  store.updateCase(guild.id, c.id, { status: 'BANNED', resolvedBy: moderator.id, resolvedAt: Date.now(), resolutionNote: reason });
  await refreshCaseLog(guild, c);
  const cleanup = deleteHours ? ` and deleted their messages from the last ${deleteHours}h` : '';
  return { ok: true, text: `🔨 Case #${c.id}: banned **${c.userTag}**${cleanup}.` };
}

module.exports = { isClosed, unmuteProblem, openMuteCase, unmuteCase, keepCase, banCase, muteCase };
