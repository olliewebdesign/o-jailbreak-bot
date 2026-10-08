// O Jailbreak settings.
// Change a value, save the file, then restart the bot (close the window and run start.bat again).
// Fill in the IDs below for your server (Developer Mode → right-click → Copy ID).
// Per-server settings (log channel, mod role, exemptions, blocked words) are set with slash commands instead.

module.exports = {
  // How long people are timed out for. Discord's maximum is 28 days.
  timeoutDays: 7,

  // DM the person to tell them why they were muted.
  dmUser: true,

  // Post a short "@user was muted" note in the channel, then delete it after this many seconds (0 = keep it).
  publicNotice: true,
  publicNoticeSeconds: 10,

  // How many earlier messages from the same channel go into the evidence file, so mods can see the context.
  contextMessages: 15,

  selfPromo: {
    // Count YouTube / Twitch / TikTok / Kick / Instagram / X channel or profile links as advertising
    // when the message is mostly just the link, or says things like "follow me" / "check out my".
    flagChannelLinks: true,

    // Server IDs whose invite links are allowed (partner servers). Invites to your own server are always allowed.
    // Also caught (no settings needed): Telegram / WhatsApp / Guilded links, selling or "dm me for prompts", the same
    // in Russian, shop and payment links, fake Discord/Steam links, and display names that advertise.
    allowedInviteServerIds: [],
  },

  promptHelp: {
    // Auto-replies (nobody is muted). "opencode prompt not working", "claude doesnt work", "is grok patched?" → the bot
    // replies with modelReply, linking that jailbreak's channel below. "the jb doesnt work" (not saying which) → it asks
    // whichReply, and their answer ("claude") gets the right channel. Turn it off with /settings.
    // Each jailbreak and the channel with its How to use video. Add more as name: 'channel ID'.
    models: {
      // e.g. claude: 'channel ID', grok: 'channel ID' — the channel with each one's How to use video
    },
    modelReply: 'Please follow the How to use video step by step in {channel}',
    whichReply: 'Which one isn’t working?',

    // Each reply goes out at most once per channel in this many minutes (per jailbreak), so a busy chat isn't spammed.
    replyCooldownMinutes: 10,

    // Used when a jailbreak has no channel above.
    guideChannelId: null,

    // The owner (also counts as "the owner" for the scammer filter).
    supportUserId: null,
  },

  updating: {
    // /server-updating start hides every channel from members except this one and the kept ones below.
    // /server-updating finish puts every channel back. It changes channels, not people, so it's quick.
    channelName: '🔧︱server-updating',

    // Roles regular members have. Hidden channels are hidden from @everyone and these roles.
    memberRoleIds: [],

    // The VIP role. VIPs can still see the vipChannelIds below.
    vipRoleId: null,

    // Posted in the updating channel when you start. You and your mods can post more there yourselves.
    startMessage: '🔧 **The server is being updated.** Everything else is hidden for a little while. Updates will be posted here.',

    // Channels everyone can still see (and use as normal) while updating.
    // Add more without editing this file: /server-updating keep-visible channel:#…
    keepVisibleChannelIds: [],

    // Channels VIPs can still see while updating (everyone else can't).
    vipChannelIds: [],
  },

  spam: {
    // Flood: this many messages within this many seconds.
    maxMessages: 8,
    perSeconds: 6,

    // The same message sent this many times within this many seconds.
    maxDuplicates: 5,
    duplicateSeconds: 30,

    // Mentioning this many different people/roles in one message.
    maxMentions: 6,
  },

  antiNuke: {
    // Someone who isn't trusted doing any of these this many times within `windowSeconds` gets stopped:
    // all their roles are removed and they are timed out, then the mods are pinged.
    windowSeconds: 30,
    limits: {
      channelDelete: 3,
      channelCreate: 6,
      roleDelete: 3,
      roleCreate: 6,
      ban: 5,
      kick: 5,
      webhookCreate: 3,
      emojiDelete: 6,
    },

    // Kick bots added by someone who isn't on the trusted list (the server owner can /antinuke trust people).
    kickUnauthorizedBots: true,
  },

  lockdown: {
    // While auto-lockdown is armed, hide every channel when anti-nuke catches someone.
    onNuke: true,

    // While armed, also lock when this many different people get muted by the filters within this many seconds.
    raid: { enabled: true, people: 5, seconds: 60 },

    // Name of the channel that appears during a lockdown.
    alertChannelName: '🔒-server-locked',

    // How often members can press "Alert the Owner" (seconds).
    alertOwnerCooldownSeconds: 120,
  },

  restrict: {
    // Names used when O Jailbreak creates these the first time someone is restricted.
    roleName: 'Restricted',
    channelName: 'restricted',
    appealsCategoryName: 'Appeals',

    // What restricted people see in #restricted, above the appeal button.
    message:
      'You have been restricted by one of our moderation team, if you believe they made a mistake or you would like to appeal you can do so here',

    // After an appeal is closed, how long before they can open another one (hours).
    appealCooldownHours: 24,

    // After an appeal ticket is closed, wait this long before deleting the channel (seconds).
    ticketDeleteSeconds: 5,
  },

  levels: {
    // XP for chatting: a random amount per message, at most once every so many seconds.
    minXp: 15,
    maxXp: 25,
    cooldownSeconds: 60,
  },

  welcome: {
    // What the welcome channel says. {user} {name} {server} {count} {inviter} are filled in.
    message: '👋 **Welcome to {server}, {user}!** Have a look around and enjoy yourself.',

    // Extra lines under the message.
    showInviter: true,
    showMemberCount: true,
    showAccountAge: true,
  },

  staffGuard: {
    // Moderators are ignored by the filters so they can do their job. This is the safety net if one goes rogue.
    enabled: true,

    // How much more than a normal member a mod may post before it counts as spam (2 = twice as much).
    spamAllowance: 2,

    // Caught spamming this many times in an hour = timed out for this long.
    strikesBeforeTimeout: 2,
    timeoutMinutes: 30,

    // How many people one mod can punish in this many minutes before the rest are paused.
    actionLimit: 6,
    actionMinutes: 10,
  },

  banList: {
    // A private channel only admins can see, listing everyone who is banned with an Unban button.
    enabled: true,
    channelName: 'ban-list',
  },

  verify: {
    // Verifying (authorizing O Jailbreak to see your server list) unlocks the new jailbreaks. Existing members see
    // the old ones until they verify; new members see no jailbreaks until they verify. Anyone in a blocked server
    // (below) is restricted. See "Verification" in README.md.
    // Your web address goes in .env as VERIFY_URL=http://IP:PORT (from Bot-Hosting.net's Network tab), because
    // updates replace this file. /verify status shows what I'm using.
    publicUrl: '',

    // How often verified people's server lists are checked again (seconds).
    scanSeconds: 30,

    // Who people should message if verifying doesn't work (shown in the verify channel and under the old jailbreaks,
    // and in the DM paused VIPs get).
    contact: '', // e.g. '<@your user ID>' (empty = "the server owner"),

    // VIPs who haven't verified are DMed once to say so — one DM every this many seconds, so Discord doesn't take the
    // bot for a spammer.
    vipDmSeconds: 3,

    // The channel people who haven't verified are sent to (it's renamed to this if it's called something else).
    channelName: '✅︱verify',

    // Sections (category IDs) people who haven't verified can see, as well as #please-read. They can read them but
    // not chat: what they post is deleted and they're DMed to verify. Everything else is hidden until they verify.
    // (VIP-only channels in these sections stay VIP-only.)
    visibleSections: [],
  },

  blockedServers: {
    // Anyone wearing one of these servers' tags on their profile, or posting an invite to them, is restricted.
    // (Discord never tells bots which servers someone is in, so those are the signs that can be seen.)
    // Add more without editing this file: /blockserver add invite:discord.gg/...
    invites: [],

    // Anyone using one of these names (username, display name or nickname) is restricted straight away. Disguises
    // count: "b4dserver", "BADSERVER", Russian look-alike letters, "the_badserver", "b a d s e r v e r".
    // Add more without editing this file: /blockserver addname
    names: [],

    // What people restricted for this are told. They can open a ticket from #restricted.
    restrictReason: 'Please make a ticket',
  },

  logs: {
    // Deleted messages (with what they said and who deleted them), edits and bulk deletes go here.
    // Set it to null to turn the logs off.
    channelId: null,
  },

  newAccounts: {
    // Discord accounts made less than this many days ago can read everything and verify, but can't chat: what they
    // post is deleted and they're DMed (once a day, English + Russian) when they can. If what they posted breaks the
    // rules (calling the owner a scammer, a slur, an advert or invite, 4+ images, @everyone with a link) they're restricted
    // instead. Their appeal ticket and other tickets are always open to them.
    // Turn it off with /settings; let a channel or role skip it with /exempt (filter: New accounts).
    minAccountAgeDays: 7,
  },

  accusations: {
    // "ellie is a scammer" and the like (English and Russian, disguised spellings too): the owner's name, their
    // @mention, or "the owner" a few words before scammer / scam / fraud / thief / liar / мошенник / скам / кидала...
    // From a new account: restricted. From anyone else: deleted and logged for the mods (🔇 Mute / 🚷 Restrict
    // buttons). Tickets are left alone. Turn it off with /settings.
    names: [], // e.g. ['alex', 'alexander'] — your name and nicknames
    namesRussian: [], // e.g. ['алекс']
  },

  mods: {
    // The moderator role. Moderators can only use /mute, /unmute, /restrict and /msgdelete (and right-click → Mute &
    // Log Message / Delete Message (logged)) — everything through the bot. The bot takes every moderation permission
    // off this role (Timeout, Delete Message, Ban...), whoever adds it, and gives it Priority Speaker instead: a harmless
    // voice permission that's how Discord knows to show moderators the bot's mod commands. They can't unrestrict, unban,
    // see the logs, add bots, change the server, or delete the owner's or admins' messages (they can delete each
    // other's, in case one goes rogue).
    // Everything they do is posted in #mod-watch (only you and admins can see it).
    roleId: null,

    // More than this many in `windowMinutes` and a moderator is put on cooldown: that action isn't done, their mod role
    // comes off until you lift it (/modcooldown lift, or the button), and @everyone in #mod-watch is pinged.
    // ("delete" = right-click → Delete Message (logged), one message at a time.)
    // ("cleanup" = /cleanup: a popup with the latest 15 messages to pick the spam from.)
    limits: { restrict: 4, mute: 6, msgdelete: 5, cleanup: 4, delete: 15 },
    windowMinutes: 5,

    watchChannelName: 'mod-watch',

    // Channels (or whole sections) moderators can't see, on top of the logs, the mod log, #mod-watch and #ban-list.
    // Added the first time the bot starts; after that use /modhide add / remove / list.
    hiddenChannelIds: [],
  },

  nameWatch: {
    // Someone joins (or changes their name) to something like these — usually the first step in pretending to be you
    // to scam people. You get a DM with who it is (and the mod log is told); nothing is done to them. Disguises count
    // ("3llie", "e1lie", "real_ellie", "ellie.fx", Russian letters); "Kellie", "Nellie" or "Belly" don't. You, staff
    // and bots are never reported. Turn it off with /settings.
    names: [], // e.g. ['alex', 'alexander']
    namesRussian: [], // e.g. ['алекс']

    // Who gets the DM (user IDs).
    notifyUserIds: [], // user IDs; empty = the server owner,
  },

  vipLeak: {
    // Forwarding a message from a VIP-only channel into a channel ordinary members can see: the forward is deleted
    // and they're restricted with this reason (they can appeal). Staff are never touched.
    reason: 'Leaking VIP content',
  },

  vip: {
    // Bring this many people into the server with your invite links and you get the VIP role
    // (set which role with /vip set). Change it without touching this file: /vip goal joins:5
    joinsNeeded: 5,

    // Joins from accounts younger than this don't count towards VIP or giveaways, so nobody can farm them with
    // throwaways (0 = count everyone). They still show in /invites, marked as not counting.
    minAccountAgeDays: 30,

    // How long someone has to have been in the server before they can apply for VIP, so nobody can join, invite a
    // crowd, grab VIP and leave with the prompts. Leaving and rejoining starts it again.
    minDaysInServer: 7,

    // Someone who leaves within this many hours of joining doesn't count: they come back off the inviter's count.
    mustStayHours: 24,
  },
};
