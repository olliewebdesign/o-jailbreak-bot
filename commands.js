'use strict';

const {
  ActionRowBuilder,
  ApplicationCommandType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../config');
const store = require('./store');
const lockdown = require('./lockdown');
const updating = require('./updating');
const restrict = require('./restrict');
const banList = require('./banList');
const invitesModule = require('./invites');
const autorole = require('./autorole');
const staffGuard = require('./staffGuard');
const modGuard = require('./modGuard');
const welcome = require('./welcome');
const levels = require('./levels');
const giveaway = require('./giveaway');
const blockedServers = require('./blockedServers');
const blocklist = require('./blocklist');
const vipApply = require('./vipApply');
const verify = require('./verify');
const access = require('./access');
const memberCounter = require('./memberCounter');
const { messageText, muteAndLog } = require('./punish');
const { isClosed, openMuteCase, unmuteCase, unmuteProblem } = require('./caseActions');
const { TYPES, fetchLogChannel } = require('./caseLog');
const { isDefaultWord, normalizeWord } = require('./filters/slurs');
const { splitText } = require('./longText');
const { canModerate, codeBlock, durationText, ephemeral, exitCleanly, isStaff, messageLink, targetProblem, truncate, ts, who } = require('./util');
const updater = require('./updater');
const { RESTART } = require('./launcher');
const { version } = require('../package.json');

const BULK_DELETE_MAX_AGE = 14 * 86_400_000 - 60_000; // Discord can't bulk-delete messages over 14 days old

// Lockdown has to hide and restore every channel's permissions, and Discord only lets a bot set
// permissions it has itself — so O Jailbreak needs Administrator (used for the invite link too).
const BOT_PERMISSIONS = [PermissionFlagsBits.Administrator];

const FILTER_NAMES = {
  slurs: 'Racial slur / blocked word filter',
  selfPromo: 'Self-promotion filter',
  spam: 'Spam filter',
  promptHelp: '“Prompt doesn’t work” → video guide',
  accusations: '“Owner is a scammer” filter',
  newAccounts: 'New accounts can’t chat (first week)',
  unverified: 'People who haven’t verified can’t chat',
};
const MODULE_NAMES = { ...FILTER_NAMES, antiNuke: 'Anti-nuke', nameWatch: 'DM the owner about look-alike names' };

const FILTER_CHOICES = [
  { name: 'Self-promotion filter', value: 'selfPromo' },
  { name: 'Spam filter', value: 'spam' },
  { name: 'Racial slur / blocked word filter', value: 'slurs' },
  { name: '“Prompt doesn’t work” → video guide', value: 'promptHelp' },
  { name: '“Owner is a scammer” filter', value: 'accusations' },
  { name: 'New accounts can’t chat (first week)', value: 'newAccounts' },
  { name: 'People who haven’t verified can’t chat', value: 'unverified' },
  { name: 'Everything — don’t moderate this channel at all', value: 'all' },
];

const POST_COLOURS = [
  { name: 'Blurple', value: '5865f2' },
  { name: 'Green', value: '57f287' },
  { name: 'Yellow', value: 'fee75c' },
  { name: 'Orange', value: 'f39c12' },
  { name: 'Red', value: 'ed4245' },
  { name: 'Pink', value: 'eb459e' },
  { name: 'White', value: 'ffffff' },
];
const TEXT_FILE = /\.(txt|md|markdown|log|csv|json|ya?ml|ini)$/i;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_POST_PARTS = 25;
const MB = 1024 * 1024;

const EXEMPT_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildCategory,
];

const definitions = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Choose the mod log channel and mod role for O Jailbreak')
    .addChannelOption((o) =>
      o
        .setName('log_channel')
        .setDescription('Where mute logs, proof and the Unmute/Ban buttons go (keep it private to mods)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addRoleOption((o) => o.setName('mod_role').setDescription('Role that can use the review buttons and gets pinged for anti-nuke alerts'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Show O Jailbreak settings, or turn a module on/off')
    .addStringOption((o) =>
      o
        .setName('module')
        .setDescription('Module to turn on or off')
        .addChoices(Object.entries(MODULE_NAMES).map(([value, name]) => ({ name, value }))),
    )
    .addBooleanOption((o) => o.setName('enabled').setDescription('True = on, False = off'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('exempt')
    .setDescription('Let a channel or role skip a filter — or leave one channel completely unmoderated')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Let a channel or role skip a filter')
        .addStringOption((o) => o.setName('filter').setDescription('Which filter to skip').setRequired(true).addChoices(FILTER_CHOICES))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').addChannelTypes(EXEMPT_CHANNEL_TYPES))
        .addRoleOption((o) => o.setName('role').setDescription('Role')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove an exemption')
        .addStringOption((o) => o.setName('filter').setDescription('Which filter').setRequired(true).addChoices(FILTER_CHOICES))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').addChannelTypes(EXEMPT_CHANNEL_TYPES))
        .addRoleOption((o) => o.setName('role').setDescription('Role')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show every exemption'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Manage blocked words')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Block a word or phrase (deleted and logged for the mods)')
        .addStringOption((o) => o.setName('word').setDescription('Word or phrase to block').setRequired(true).setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Unblock a word (also works for built-in words that cause false alarms)')
        .addStringOption((o) => o.setName('word').setDescription('Word or phrase to unblock').setRequired(true).setMaxLength(100)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show your blocked words'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('access')
    .setDescription('Who can see the staff channels and appeals — or why one person can see what they can')
    .addUserOption((o) => o.setName('user').setDescription('Leave empty to check the whole server').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Manage who anti-nuke trusts (server owner only)')
    .addSubcommand((s) =>
      s
        .setName('trust')
        .setDescription('Trust a person or bot — anti-nuke will ignore everything they do')
        .addUserOption((o) => o.setName('user').setDescription('Person or bot').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('untrust')
        .setDescription('Stop trusting a person or bot')
        .addUserOption((o) => o.setName('user').setDescription('Person or bot').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show the trusted list'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('server-updating')
    .setDescription('Hide the server from members while you rework it')
    .addSubcommand((s) =>
      s.setName('start').setDescription('Members only see #server-updating and the kept channels; VIPs keep theirs (owner/trusted/admins)'),
    )
    .addSubcommand((s) => s.setName('finish').setDescription('Show the server again, exactly as you left it'))
    .addSubcommand((s) =>
      s
        .setName('keep-visible')
        .setDescription('Let members still see a channel while updating (run again to hide it)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('The channel (picking a thread keeps its whole channel visible)')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
              ChannelType.GuildVoice,
              ChannelType.GuildStageVoice,
              ChannelType.PublicThread,
              ChannelType.AnnouncementThread,
            )
            .setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Hide every channel during a nuke or raid, and control auto-lockdown')
    .addSubcommand((s) =>
      s
        .setName('lock')
        .setDescription('Lock the server right now (hides every channel)')
        .addStringOption((o) => o.setName('reason').setDescription('Why (shown to members)').setMaxLength(300)),
    )
    .addSubcommand((s) => s.setName('unlock').setDescription('Unlock the server and put every channel back (owner/trusted)'))
    .addSubcommand((s) => s.setName('panel').setDescription('DM you buttons to arm or pause auto-lockdown (owner/trusted)'))
    .addSubcommand((s) => s.setName('arm').setDescription('Turn auto-lockdown on — do this before you go offline (owner/trusted)'))
    .addSubcommand((s) =>
      s
        .setName('pause')
        .setDescription('Pause auto-lockdown while you are online (owner/trusted)')
        .addIntegerOption((o) =>
          o
            .setName('hours')
            .setDescription('How long to pause (leave empty = until you arm it)')
            .addChoices(
              { name: '1 hour', value: 1 },
              { name: '2 hours', value: 2 },
              { name: '4 hours', value: 4 },
              { name: '8 hours', value: 8 },
              { name: '12 hours', value: 12 },
              { name: '24 hours', value: 24 },
            ),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Is auto-lockdown armed, paused, or locked right now?'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('restrict')
    .setDescription('Hide every channel from someone except #restricted, where they can appeal')
    .addUserOption((o) => o.setName('user').setDescription('Who to restrict').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why (they will see this)').setRequired(true).setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('unrestrict')
    .setDescription('Give a restricted person their channels and roles back')
    .addUserOption((o) => o.setName('user').setDescription('Who to unrestrict').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Give a role (like @Member) to everyone who joins')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Choose the role new members get')
        .addRoleOption((o) => o.setName('role').setDescription('Role to give people who join').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Stop giving a role to people who join'))
    .addSubcommand((s) => s.setName('sync').setDescription('Give the role to everyone who is missing it right now'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('vip')
    .setDescription('Reward people who bring members in with their invite links')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Choose the role people get for inviting members')
        .addRoleOption((o) => o.setName('role').setDescription('Role to give (e.g. @VIP)').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('goal')
        .setDescription('How many people someone has to bring in to earn the role')
        .addIntegerOption((o) =>
          o.setName('joins').setDescription('Number of joins needed (e.g. 5)').setMinValue(1).setMaxValue(500).setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop giving a role for invites'))
    .addSubcommand((sub) =>
      sub
        .setName('review')
        .setDescription('Where VIP applications go for an admin to approve or deny')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('A channel only admins can see (leave empty to use the mod log)').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('Take joins off someone’s invite count (counts for VIP and running giveaways)')
        .addUserOption((o) => o.setName('user').setDescription('Whose count to lower').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('How many joins to take off').setMinValue(1).setMaxValue(500).setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why (saved in the mod log)').setMaxLength(300)),
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Who has brought the most people in (use /invites user: to look up one person)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('See how many people you’ve brought into the server')
    .addUserOption((o) => o.setName('user').setDescription('Staff only: whose invites to look up (leave empty for your own)'))
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verifying unlocks the new jailbreaks (and checks people aren’t in a blocked server)')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Turn verification on for everyone who joins from now on'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn verification off and let anyone waiting straight in'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Is verification working, and what still needs doing?'))
    .addSubcommand((sub) =>
      sub
        .setName('require-all')
        .setDescription('Server owner: everyone who hasn’t verified (existing members too) only sees the verify channel')
        .addBooleanOption((o) => o.setName('enabled').setDescription('True = everyone must verify · False = only new members, like before').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('split')
        .setDescription('Copy a section for verified members; everyone who hasn’t verified keeps the old one')
        .addChannelOption((o) => o.setName('section').setDescription('The category to split, e.g. your jailbreaks section').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption((o) => o.setName('new_name').setDescription('Name for the new copy (leave empty to keep the same name)').setMaxLength(100)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('verifybutton')
    .setDescription('Post an announcement with a Verify button, to tell members to verify')
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post it (leave empty for here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addStringOption((o) => o.setName('text').setDescription('Your own message (leave empty for the ready-made English + Russian one). \\n = new line').setMaxLength(3500))
    .addStringOption((o) => o.setName('title').setDescription('Title at the top').setMaxLength(200))
    .addStringOption((o) =>
      o
        .setName('ping')
        .setDescription('Who gets notified')
        .addChoices({ name: 'Nobody', value: 'none' }, { name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }),
    )
    .addRoleOption((o) => o.setName('ping_role').setDescription('Ping a role instead'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Add everyone who verified to this server, if something happened to the old one (bot owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('pull')
        .setDescription('Add everyone who verified in your other server to THIS server')
        .addStringOption((o) => o.setName('from_server_id').setDescription('Only people from this server ID (leave empty for all of your other servers)').setMaxLength(25)),
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('How many people could be added to this server right now'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('applyvip')
    .setDescription('Apply for VIP once enough people have joined with your invite links')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('massban')
    .setDescription('Ban a list of user IDs at once, even people who aren’t in the server (owner only)')
    .addStringOption((o) => o.setName('ids').setDescription('User IDs, separated by spaces, commas or new lines (up to 200)').setRequired(true).setMaxLength(6000))
    .addStringOption((o) => o.setName('reason').setDescription('Why (saved in the audit log and ban list)').setMaxLength(300))
    .addIntegerOption((o) => o.setName('delete_hours').setDescription('Delete their messages from the last this-many hours (0-168, default 24)').setMinValue(0).setMaxValue(168))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('blocklist')
    .setDescription('User IDs of known members of a blocked server: restricted now, or as soon as they join (owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add IDs to the blocklist and restrict anyone on it who is in the server')
        .addStringOption((o) => o.setName('ids').setDescription('User IDs, any format (spaces, commas, new lines)').setMaxLength(6000))
        .addAttachmentOption((o) => o.setName('file').setDescription('Or a .txt file with the IDs (for long lists)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Take IDs off the blocklist (anyone already restricted stays restricted)')
        .addStringOption((o) => o.setName('ids').setDescription('User IDs, any format').setMaxLength(6000))
        .addAttachmentOption((o) => o.setName('file').setDescription('Or a .txt file with the IDs')),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('How many are on the blocklist, and how many are in the server'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('blockserver')
    .setDescription('Restrict anyone wearing another server’s tag, posting its invite, or using a blocked name')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Block a server')
        .addStringOption((o) => o.setName('invite').setDescription('An invite link to it, e.g. discord.gg/abc').setRequired(true).setMaxLength(200)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop blocking a server')
        .addStringOption((o) => o.setName('server').setDescription('Its name or server ID (see /blockserver list)').setRequired(true).setMaxLength(100)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('addname')
        .setDescription('Restrict anyone using this name (disguises like an0nym0use count too)')
        .addStringOption((o) => o.setName('name').setDescription('The name, e.g. badserver').setRequired(true).setMinLength(3).setMaxLength(32)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('removename')
        .setDescription('Stop blocking a name')
        .addStringOption((o) => o.setName('name').setDescription('The name (see /blockserver list)').setRequired(true).setMaxLength(32)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the blocked servers and names'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaways people enter by reacting 🎉 (VIPs, or people who brought in new members)')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('What they can win').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duration').setDescription('How long it runs, e.g. 1d, 12h, 1d12h, 1w').setRequired(true).setMaxLength(20))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many winners (default 3)').setMinValue(1).setMaxValue(20))
        .addIntegerOption((o) =>
          o.setName('joins').setDescription('New people someone has to bring in to enter (default 2)').setMinValue(1).setMaxValue(50),
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to post it (leave empty for here)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('End a giveaway now and draw the winners')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number (leave empty for the newest)').setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reroll')
        .setDescription('Draw new winner(s) for a giveaway that has ended')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number (leave empty for the newest)').setMinValue(1))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many new winners (default 1)').setMinValue(1).setMaxValue(20)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Running giveaways, or who has reacted to one and who qualifies')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number to see who is entered').setMinValue(1)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Your level and XP from chatting (or someone else’s)')
    .addUserOption((o) => o.setName('user').setDescription('Whose level to look up'))
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder().setName('leaderboard').setDescription('The top chatters in this server').setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Levels and XP for chatting')
    .addSubcommand((sub) => sub.setName('on').setDescription('Give XP for chatting'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop giving XP (nobody loses what they have)'))
    .addSubcommand((sub) =>
      sub
        .setName('reward')
        .setDescription('Give a role automatically at a level')
        .addIntegerOption((o) => o.setName('level').setDescription('Level they have to reach').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give (leave empty to remove the reward)')),
    )
    .addSubcommand((sub) => sub.setName('rewards').setDescription('Show the level rewards'))
    .addSubcommand((sub) =>
      sub
        .setName('board')
        .setDescription('Keep a live leaderboard in a channel (leave the channel out to stop)')
        .addChannelOption((o) => o.setName('channel').setDescription('Where the live leaderboard lives').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('style')
        .setDescription('How the leaderboard looks')
        .addStringOption((o) => o.setName('title').setDescription('Title — use {server} for the server name').setMaxLength(100))
        .addStringOption((o) => o.setName('colour').setDescription('Colour of the side bar').addChoices(POST_COLOURS))
        .addIntegerOption((o) => o.setName('size').setDescription('How many people to show (5-25)').setMinValue(5).setMaxValue(25))
        .addBooleanOption((o) => o.setName('show_xp').setDescription('Show XP numbers as well as levels')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('announce')
        .setDescription('Where level-ups are announced')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Always announce here (leave empty for the channel they were chatting in)').addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((o) => o.setName('enabled').setDescription('False = never announce level-ups')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set someone’s level by hand')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) => o.setName('level').setDescription('Their new level').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Welcome new members in a channel, and show whose invite link they used')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Choose the welcome channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to say hello').addChannelTypes(ChannelType.GuildText).setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Stop welcoming new members'))
    .addSubcommand((sub) => sub.setName('test').setDescription('Post a welcome for yourself, to see how it looks'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('banlist')
    .setDescription('The private ban list channel (admins only)')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Make the ban list channel (or show where it is)'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Add everyone who is already banned to the list'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('post')
    .setDescription('Post as the bot — upload a .txt file for long writing (any length) or attach any file')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post it')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true),
    )
    .addAttachmentOption((o) => o.setName('file').setDescription('A .txt file with your writing (split into parts), or any file to attach'))
    .addStringOption((o) => o.setName('text').setDescription('Or type the writing here').setMaxLength(4000))
    .addStringOption((o) => o.setName('title').setDescription('Title at the top').setMaxLength(200))
    .addStringOption((o) =>
      o
        .setName('ping')
        .setDescription('Who gets notified')
        .addChoices({ name: 'Nobody', value: 'none' }, { name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }),
    )
    .addRoleOption((o) => o.setName('ping_role').setDescription('Ping a role instead'))
    .addStringOption((o) => o.setName('colour').setDescription('Colour of the side bar').addChoices(POST_COLOURS))
    .addBooleanOption((o) => o.setName('attach_file').setDescription('Also attach your .txt file so people can download it'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription(`Mute someone for ${durationText()}`)
    .addUserOption((o) => o.setName('user').setDescription('Who to mute').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why (moderators will see this)').setRequired(true).setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Unmute someone and close their open case')
    .addUserOption((o) => o.setName('user').setDescription('Who to unmute').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why they are being unmuted').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('applychat')
    .setDescription('New account? Ask the admins to let you chat before your first week is up')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('msgdelete')
    .setDescription('Delete someone’s recent messages in this channel')
    .addUserOption((o) => o.setName('user').setDescription('Whose messages').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Spam: pick which of the latest 15 messages in this channel to delete')
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('membercount')
    .setDescription('Channels at the top showing the member count and the change in the last 24 hours')
    .addSubcommand((s) => s.setName('on').setDescription('Add 👥 Members and 📈 Last 24h at the top of the server'))
    .addSubcommand((s) => s.setName('off').setDescription('Remove the member counter channels'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('modhide')
    .setDescription('Owner: channels moderators can’t see (on top of the logs and #mod-watch)')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Hide a channel (or a whole section) from moderators')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Let moderators see it again')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Every channel moderators can’t see'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('modcooldown')
    .setDescription('Owner: moderators put on cooldown for doing too much at once')
    .addSubcommand((s) =>
      s
        .setName('lift')
        .setDescription('Give a moderator their powers back')
        .addUserOption((o) => o.setName('user').setDescription('Which moderator').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Who is on cooldown'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription("Show someone's past O Jailbreak cases")
    .addUserOption((o) => o.setName('user').setDescription('Who to look up').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Install a new version of O Jailbreak from an update file (bot owner only)')
    .addAttachmentOption((o) => o.setName('file').setDescription('The o-jailbreak-update.zip file').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  new ContextMenuCommandBuilder()
    .setName('Moderate')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),

  new ContextMenuCommandBuilder()
    .setName('Delete Message')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.PrioritySpeaker)
    .setContexts(InteractionContextType.Guild),
];

async function registerCommands(guild) {
  try {
    const registered = await guild.commands.set(definitions.map((d) => d.toJSON()));
    console.log(`[commands] ${registered.size} slash commands are ready in "${guild.name}".`);
  } catch (err) {
    console.error(`[commands] Couldn't register slash commands in "${guild.name}": ${err.message}`);
  }
}

function isOwner(interaction) {
  return interaction.user.id === interaction.guild.ownerId;
}

function permissionNames(bits) {
  return new PermissionsBitField(bits).toArray().join(', ');
}

// ----- /setup -----
async function setup(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);

  if (settings.logChannelId && !store.isTrusted(guild, interaction.user.id)) {
    return ephemeral(interaction, '🚫 O Jailbreak is already set up. Only the server owner (or someone on the trusted list) can change it.');
  }

  const channel = interaction.options.getChannel('log_channel', true);
  const role = interaction.options.getRole('mod_role');
  if (role && (role.id === guild.id || role.managed)) return ephemeral(interaction, '❌ Pick your moderator role — not @everyone or a bot’s own role.');
  const me = guild.members.me;

  const channelPerms = channel.permissionsFor(me);
  const missingInChannel = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
  ].filter((p) => !channelPerms?.has(p));
  if (missingInChannel.length) {
    return ephemeral(interaction, `❌ I can't post properly in ${channel}. Give my role these permissions there: **${permissionNames(missingInChannel)}**`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const firstSetup = !settings.logChannelId;
  settings.logChannelId = channel.id;
  if (role) settings.modRoleId = role.id;

  // Bots already in the server were put there by the owner, so trust them (other mod bots would
  // otherwise look like nukers when they ban raiders).
  const existingBots = guild.roles.cache.map((r) => r.tags?.botId).filter((id) => id && id !== me.id);
  const newlyTrusted = [...new Set(existingBots)].filter((id) => !settings.trusted.includes(id));
  settings.trusted.push(...newlyTrusted);
  store.save();

  const lines = [
    '✅ **O Jailbreak is set up!**',
    `• Mod log: ${channel}`,
    `• Mod role: ${settings.modRoleId ? `<@&${settings.modRoleId}>` : 'none — anyone with **Timeout Members** can review cases'}`,
  ];

  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    lines.push('⚠️ **I need Administrator** for lockdown and anti-nuke: Server Settings → Roles → O Jailbreak → turn on **Administrator**.');
  }

  const topRole = guild.roles.highest;
  if (me.roles.highest.id !== topRole.id) {
    lines.push(
      `⚠️ **Drag my role to the very top** in Server Settings → Roles. Right now **${topRole.name}** is above me, so I can't stop anyone who has it.`,
    );
  }
  if (newlyTrusted.length) {
    lines.push(`🤖 Trusted the bots already here: ${newlyTrusted.map((id) => `<@${id}>`).join(', ')}`);
  }

  // Moderators: the mod role's permissions, #mod-watch, and the logs hidden from them.
  await modGuard.prepare(guild).catch((err) => console.warn(`[mod watch] ${guild.name}: ${err.message}`));

  // The owner gets the arm/pause buttons for auto-lockdown in their DMs.
  if (firstSetup) {
    const owner = await guild.fetchOwner().catch(() => null);
    const sent = owner ? await lockdown.sendPanel(guild, owner.user) : false;
    lines.push(
      sent
        ? '🛡️ Auto-lockdown is **armed**. I DMed the owner buttons to pause it while they’re online.'
        : '🛡️ Auto-lockdown is **armed**. I couldn’t DM the owner — they can use `/lockdown panel` to get the buttons.',
    );
  }

  const restrictions = await restrict.prepare(guild, { tellModLog: false });
  lines.push(
    restrictions.ok
      ? `🚷 Restrict is ready: ${restrictions.channel} and the <@&${restrictions.role.id}> role. Mods can use \`/restrict\`, or just give someone that role.`
      : `⚠️ **Restrict isn’t ready:** ${restrictions.text}`,
  );

  const bans = await banList.prepare(guild, { tellModLog: false });
  lines.push(bans.ok ? `🔨 Ban list: ${bans.channel} (admins only). Run \`/banlist sync\` to add people who are already banned.` : `⚠️ **Ban list isn’t ready:** ${bans.text}`);

  lines.push(
    '',
    '**Next steps**',
    settings.autoroleId ? `• New members get <@&${settings.autoroleId}>.` : '• Give new members a role: `/autorole set role:@Member`',
    settings.vipRoleId ? `• Inviting ${invitesModule.joinsNeeded(settings)} people earns <@&${settings.vipRoleId}>.` : '• Reward people for inviting: `/vip set role:@VIP`',
    '• Server owner: `/antinuke trust` any admins you fully trust.',
    '• Got a self-promo channel? `/exempt add filter:Self-promotion filter channel:#your-channel`',
  );
  await ephemeral(interaction, lines.join('\n'));

  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('👁️ O Jailbreak is watching')
          .setDescription(
            `Cases will show up here with proof and **Unmute / Ban / Keep Muted** buttons.\nPeople who break the rules are timed out for **${durationText()}** until a moderator reviews it.`,
          ),
      ],
    })
    .catch(() => {});
}

// ----- /settings -----
async function settingsCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const moduleKey = interaction.options.getString('module');
  const enabled = interaction.options.getBoolean('enabled');
  let changed = '';

  if ((moduleKey === null) !== (enabled === null)) {
    return ephemeral(interaction, 'Pick both a **module** and **enabled** (true/false) to change a setting.');
  }
  if (moduleKey !== null) {
    if (moduleKey === 'antiNuke' && !enabled && !isOwner(interaction)) {
      return ephemeral(interaction, '🚫 Only the server owner can turn anti-nuke off.');
    }
    settings.modules[moduleKey] = enabled;
    store.save();
    changed = `${enabled ? '✅' : '❌'} **${MODULE_NAMES[moduleKey]}** is now **${enabled ? 'on' : 'off'}**.\n\n`;
  }

  const exemptCount = store.FILTERS.reduce((n, f) => n + settings.exempt[f].channels.length + settings.exempt[f].roles.length, 0);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('O Jailbreak settings')
    .addFields(
      { name: 'Mod log', value: settings.logChannelId ? `<#${settings.logChannelId}>` : '❌ Not set — run `/setup`', inline: true },
      { name: 'Mod role', value: settings.modRoleId ? `<@&${settings.modRoleId}>` : 'None', inline: true },
      { name: 'Mute length', value: durationText(), inline: true },
      {
        name: 'Modules',
        value: Object.entries(MODULE_NAMES)
          .map(([key, name]) => `${settings.modules[key] ? '✅' : '❌'} ${name}`)
          .join('\n'),
      },
      {
        name: 'Exemptions',
        value: `${exemptCount} (see \`/exempt list\`)${settings.freeChannels.length ? `\n🕊️ ${settings.freeChannels.length} channel(s) not moderated at all` : ''}`,
        inline: true,
      },
      { name: 'Custom blocked words', value: `${settings.customWords.length}`, inline: true },
      { name: 'Trusted (anti-nuke)', value: `${settings.trusted.length}`, inline: true },
      { name: 'Auto-role', value: settings.autoroleId ? `<@&${settings.autoroleId}>` : 'Off — `/autorole set`', inline: true },
      {
        name: 'Invite reward',
        value: settings.vipRoleId ? `<@&${settings.vipRoleId}> at ${invitesModule.joinsNeeded(settings)} invite(s)` : 'Off — `/vip set`',
        inline: true,
      },
      { name: 'Ban list', value: settings.banList.channelId ? `<#${settings.banList.channelId}>` : 'Not made yet — `/banlist setup`', inline: true },
      { name: 'Welcome channel', value: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : 'Off — `/welcome set`', inline: true },
      {
        name: 'Levels',
        value: settings.levels.enabled
          ? `On — ${Object.keys(settings.levels.rewards).length} role reward(s)${settings.levels.board.channelId ? `\nBoard: <#${settings.levels.board.channelId}>` : ''}`
          : 'Off — `/levels on`',
        inline: true,
      },
      {
        name: 'Staff watch',
        value: [
          config.staffGuard.enabled === false ? 'Off' : `On — mods get ${config.staffGuard.spamAllowance}× the spam allowance`,
          `Moderators: max ${Object.entries(config.mods?.limits ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')} per ${config.mods?.windowMinutes ?? 5} min, then cooldown`,
        ].join('\n'),
      },
      {
        name: 'Restrict',
        value: interaction.guild.roles.cache.has(settings.restrict.roleId)
          ? `<@&${settings.restrict.roleId}> • ${Object.keys(settings.restricted).length} restricted`
          : '❌ No Restricted role yet — run `/setup`',
        inline: true,
      },
    )
    .setFooter({ text: `O Jailbreak v${version}` });
  await interaction.reply({ content: changed || undefined, embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// ----- /exempt -----
async function exemptCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const free = settings.freeChannels.map((id) => `<#${id}>`).join(', ') || 'none';
    const lines = [
      `**Not moderated at all:** ${free}`,
      ...store.FILTERS.map((f) => {
        const { channels, roles } = settings.exempt[f];
        const items = [...channels.map((id) => `<#${id}>`), ...roles.map((id) => `<@&${id}>`)];
        return `**${FILTER_NAMES[f]}:** ${items.length ? items.join(', ') : 'none'}`;
      }),
    ];
    return ephemeral(interaction, lines.join('\n'));
  }

  const filter = interaction.options.getString('filter', true);
  const channel = interaction.options.getChannel('channel');
  const role = interaction.options.getRole('role');
  if (!channel && !role) return ephemeral(interaction, 'Pick a **channel** and/or a **role**.');

  // "Everything" on a channel means O Jailbreak ignores it completely — filters, spam checks and staff watch.
  if (filter === 'all' && channel) {
    const i = settings.freeChannels.indexOf(channel.id);
    if (sub === 'add' && i === -1) settings.freeChannels.push(channel.id);
    if (sub === 'remove' && i !== -1) settings.freeChannels.splice(i, 1);
  }

  const filters = filter === 'all' ? store.FILTERS : [filter];
  for (const f of filters) {
    const rules = settings.exempt[f];
    for (const [list, item] of [[rules.channels, channel], [rules.roles, role]]) {
      if (!item) continue;
      const i = list.indexOf(item.id);
      if (sub === 'add' && i === -1) list.push(item.id);
      if (sub === 'remove' && i !== -1) list.splice(i, 1);
    }
  }
  store.save();

  const what = [channel && `${channel}`, role && `${role}`].filter(Boolean).join(' and ');
  if (filter === 'all' && channel) {
    return ephemeral(
      interaction,
      sub === 'add'
        ? `✅ ${channel} is now completely free — no filters, no spam checks, no staff watch. Nothing posted there gets deleted or punished.${role ? ` ${role} also skips every filter everywhere.` : ''}`
        : `✅ ${what} is moderated normally again.`,
    );
  }
  const which = filter === 'all' ? 'every filter' : `the ${FILTER_NAMES[filter]}`;
  return ephemeral(interaction, sub === 'add' ? `✅ ${what} will now skip ${which}.` : `✅ ${what} will be checked by ${which} again.`);
}

// ----- /filter -----
async function filterCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const custom = settings.customWords.map((w) => `||${w}||`).join(', ') || 'none';
    const disabled = settings.disabledWords.map((w) => `||${w}||`).join(', ') || 'none';
    return ephemeral(
      interaction,
      `**Your blocked words:** ${custom}\n**Built-in words you turned off:** ${disabled}\n\nThe built-in racial slur list is always on (it isn't shown here). Tricks like l33t speak, s p a c i n g and look-alike letters are caught automatically.`,
    );
  }

  const word = interaction.options.getString('word', true).trim().toLowerCase();
  const key = normalizeWord(word);
  if (key.length < 2) return ephemeral(interaction, '❌ That needs at least 2 letters.');

  if (sub === 'add') {
    const wasDisabled = settings.disabledWords.findIndex((w) => normalizeWord(w) === key);
    if (wasDisabled !== -1) {
      settings.disabledWords.splice(wasDisabled, 1);
      store.save();
      return ephemeral(interaction, `✅ ||${word}|| is blocked again.`);
    }
    if (isDefaultWord(word)) return ephemeral(interaction, `ℹ️ ||${word}|| is already on the built-in list.`);
    if (settings.customWords.some((w) => normalizeWord(w) === key)) return ephemeral(interaction, `ℹ️ ||${word}|| is already blocked.`);
    settings.customWords.push(word);
    store.save();
    return ephemeral(interaction, `✅ Blocked ||${word}||. Messages with it are deleted and logged for the mods (they can press 🔇 Mute on the case).`);
  }

  // remove
  const i = settings.customWords.findIndex((w) => normalizeWord(w) === key);
  if (i !== -1) {
    settings.customWords.splice(i, 1);
    store.save();
    return ephemeral(interaction, `✅ ||${word}|| is no longer blocked.`);
  }
  if (isDefaultWord(word)) {
    if (!settings.disabledWords.some((w) => normalizeWord(w) === key)) settings.disabledWords.push(word);
    store.save();
    return ephemeral(interaction, `✅ Turned off the built-in word ||${word}|| for this server. Use \`/filter add\` to turn it back on.`);
  }
  return ephemeral(interaction, `ℹ️ ||${word}|| isn't on the list.`);
}

// ----- /antinuke -----
async function antinukeCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const people = settings.trusted.map((id) => `<@${id}>`).join('\n') || 'Nobody yet.';
    return ephemeral(interaction, `**Trusted by anti-nuke** (the server owner is always trusted):\n${people}`);
  }

  if (!isOwner(interaction)) {
    return ephemeral(interaction, '🚫 Only the server owner can change who is trusted. (A hacked admin could otherwise trust themselves.)');
  }

  const user = interaction.options.getUser('user', true);
  const i = settings.trusted.indexOf(user.id);
  if (sub === 'trust') {
    if (i === -1) settings.trusted.push(user.id);
    store.save();
    return ephemeral(interaction, `✅ Anti-nuke now trusts ${user}. Nothing they do will set it off — only trust people you'd give the server to.`);
  }
  if (i !== -1) settings.trusted.splice(i, 1);
  store.save();
  return ephemeral(interaction, `✅ ${user} is no longer trusted.`);
}

// ----- /lockdown -----
async function lockdownCommand(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  const sub = interaction.options.getSubcommand();
  const trusted = store.isTrusted(guild, interaction.user.id);

  if (sub === 'status') {
    return ephemeral(interaction, `${lockdown.statusLine(settings)}${settings.lockdown.active ? `\n**Why:** ${truncate(settings.lockdown.reason, 500)}` : ''}`);
  }

  if (sub === 'lock') {
    if (!trusted && !canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can lock the server.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const why = interaction.options.getString('reason') ?? 'Locked by a moderator';
    const result = await lockdown.lockServer(guild, { reason: `${why} (by ${interaction.user.tag})`, lockedBy: interaction.user.id });
    return interaction.editReply(result.text);
  }

  if (!trusted) {
    return ephemeral(interaction, '🚫 Only the server owner (or someone on the trusted list) can do that. Mods can still use `/lockdown lock`.');
  }

  switch (sub) {
    case 'unlock': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await lockdown.unlockServer(guild, interaction.user);
      return interaction.editReply(result.text);
    }
    case 'panel': {
      const sent = await lockdown.sendPanel(guild, interaction.user);
      return ephemeral(interaction, sent ? '📬 Check your DMs — the arm/pause buttons are there.' : "❌ I couldn't DM you. Turn on DMs from server members and try again.");
    }
    case 'arm':
      lockdown.arm(settings);
      return ephemeral(interaction, lockdown.statusLine(settings));
    case 'pause':
      lockdown.pause(settings, interaction.options.getInteger('hours') ?? 0);
      return ephemeral(interaction, lockdown.statusLine(settings));
  }
}

// ----- /server-updating -----
async function serverUpdatingCommand(interaction) {
  const { guild } = interaction;
  if (!store.isTrusted(guild, interaction.user.id) && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return ephemeral(interaction, '🚫 Only the server owner, admins, or someone on the trusted list can do that.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  if (sub === 'keep-visible') {
    const result = await updating.toggleKeepVisible(guild, interaction.options.getChannel('channel', true));
    return interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
  }
  if (sub === 'finish') {
    const result = await updating.finish(guild, interaction.user);
    return interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
  }
  const result = await updating.start(guild, interaction.user);
  return interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
}

// ----- /restrict, /unrestrict -----
async function restrictCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can restrict people.');

  const user = interaction.options.getUser('user', true);
  const member = interaction.options.getMember('user');
  if (!member) return ephemeral(interaction, "❌ They're not in the server.");
  const problem = targetProblem(interaction, user, member, 'restrict');
  if (problem) return ephemeral(interaction, problem);
  if (await modGuard.blocked(interaction, 'restrict', `<@${user.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.options.getString('reason', true);
  const result = await restrict.restrictMember({ guild: interaction.guild, member, moderator: interaction.user, reason });
  if (result.ok) await modGuard.logAction(interaction.guild, interaction.member, `🚷 restricted ${who(user)} — ${truncate(reason, 300)}`);
  return interaction.editReply(result.text);
}

async function unrestrictCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  if (!modGuard.isAdmin(interaction.member)) return ephemeral(interaction, '🚫 Only admins and the owner can unrestrict people.');

  const user = interaction.options.getUser('user', true);
  if (await staffGuard.blocked(interaction, 'unrestrict')) return null;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await restrict.unrestrictMember({
    guild: interaction.guild,
    userId: user.id,
    moderator: interaction.user,
    reason: interaction.options.getString('reason'),
  });
  return interaction.editReply(result.text);
}

// ----- /autorole -----
const RISKY_FOR_EVERYONE = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
];

async function autoroleCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  if (interaction.options.getSubcommand() === 'sync') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await autorole.syncMembers(interaction.guild);
    return ephemeral(interaction, result.text);
  }
  if (interaction.options.getSubcommand() === 'off') {
    settings.autoroleId = null;
    store.save();
    return ephemeral(interaction, '✅ Auto-role is off. People who join won’t get a role automatically.');
  }

  const role = interaction.options.getRole('role', true);
  if (role.id === interaction.guildId || role.managed) return ephemeral(interaction, '❌ Pick a normal role — not @everyone or a bot’s role.');
  if (role.id === settings.restrict.roleId) return ephemeral(interaction, '❌ That’s the Restricted role.');
  if (role.permissions.any(RISKY_FOR_EVERYONE)) {
    return ephemeral(interaction, `❌ ${role} has moderator or admin permissions, so giving it to everyone who joins would be dangerous. Pick a plain member role.`);
  }
  if (!role.editable) return ephemeral(interaction, `❌ I can't give out ${role} — drag my role above it in Server Settings → Roles.`);

  settings.autoroleId = role.id;
  store.save();
  return ephemeral(interaction, `✅ Everyone who joins will get ${role}. (If your server makes new people accept the rules first, they get it right after.)`);
}

// ----- /vip, /invites and /banlist -----
async function vipCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'goal') {
    const joins = interaction.options.getInteger('joins', true);
    settings.vipJoinsNeeded = joins;
    store.save();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const caughtUp = settings.vipRoleId ? await vipApply.notifyAllEligible(interaction.guild) : 0;
    const extra = caughtUp ? ` I’ve DMed ${caughtUp} person/people who now qualify, so they can apply.` : '';
    return ephemeral(
      interaction,
      `✅ VIP now takes **${joins}** join(s) with someone’s own invite links. Anyone who already has the role keeps it.${extra}`,
    );
  }

  if (sub === 'revoke') {
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { before, after } = invitesModule.revokeJoins(settings, user.id, amount);
    const giveaways = giveaway.revokeJoins(interaction.guild, user.id, amount);
    const needed = invitesModule.joinsNeeded(settings);

    const lines = [`✅ Took **${before - after}** join(s) off ${user}. VIP count: **${before} → ${after}** (VIP needs ${needed}).`];
    for (const g of giveaways) lines.push(`🎉 Giveaway #${g.id} (${truncate(g.prize, 60)}): **${g.before} → ${g.after}** of ${g.needed}${g.after < g.needed ? ' — no longer qualifies' : ''}`);
    if (before - after < amount) lines.push(`ℹ️ They only had ${before}, so their count is now 0.`);
    // Below the goal now: VIP comes off (and Verified, if they only had it because of VIP).
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const hadVip = Boolean(settings.vipRoleId && member?.roles.cache.has(settings.vipRoleId));
    const taken = await invitesModule.takeVipIfBelow(interaction.guild, user.id, { why: `invite count lowered by ${interaction.user.tag}` });
    if (taken) lines.push(`📉 Took <@&${settings.vipRoleId}> off them, since they’re below the goal now. They can apply again if they get back to ${needed}.`);
    else if (hadVip && member?.roles.cache.has(settings.vipRoleId) && after < needed && !interaction.guild.roles.cache.get(settings.vipRoleId)?.editable) {
      lines.push(`⚠️ I couldn’t take <@&${settings.vipRoleId}> off them — make sure my role is above it in Server Settings → Roles.`);
    }

    const log = await fetchLogChannel(interaction.guild);
    await log
      ?.send({
        content: `📉 ${interaction.user} took **${before - after}** invite join(s) off ${user} (${before} → ${after})${giveaways.length ? `, and from ${giveaways.length} running giveaway(s)` : ''}.${reason ? `\n**Reason:** ${truncate(reason, 300)}` : ''}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
    return ephemeral(interaction, lines.join('\n'));
  }

  if (sub === 'review') {
    const channel = interaction.options.getChannel('channel');
    settings.vipReviewChannelId = channel?.id ?? null;
    store.save();
    return ephemeral(
      interaction,
      channel
        ? `✅ VIP applications now go to ${channel}. Only admins (Administrator) can press Approve or Deny. Make sure members can’t see that channel.`
        : '✅ VIP applications now go to the mod log. Only admins (Administrator) can press Approve or Deny.',
    );
  }

  if (sub === 'off') {
    settings.vipRoleId = null;
    store.save();
    return ephemeral(interaction, '✅ Invite rewards are off. Nobody gets a role for inviting people now.');
  }

  if (sub === 'status') {
    const top = Object.entries(settings.invites.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([id, count], i) => `**${i + 1}.** <@${id}> — ${count} join(s)`);
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📨 Who has brought the most people in')
      .setDescription(top.join('\n') || 'Nobody has invited anyone yet.')
      .setFooter({ text: `VIP at ${invitesModule.joinsNeeded(settings)} join(s)${settings.vipRoleId ? '' : ' — no VIP role set yet'}` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  const role = interaction.options.getRole('role', true);
  if (role.id === interaction.guildId || role.managed) return ephemeral(interaction, '❌ Pick a normal role — not @everyone or a bot’s role.');
  if (role.id === settings.restrict.roleId) return ephemeral(interaction, '❌ That’s the Restricted role.');
  if (role.permissions.any(RISKY_FOR_EVERYONE)) {
    return ephemeral(interaction, `❌ ${role} has moderator or admin permissions, so handing it out for invites would be dangerous. Pick a plain reward role.`);
  }
  if (!role.editable) return ephemeral(interaction, `❌ I can't give out ${role} — drag my role above it in Server Settings → Roles.`);

  settings.vipRoleId = role.id;
  store.save();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const told = await vipApply.notifyAllEligible(interaction.guild);
  const caughtUp = told ? ` I've DMed ${told} person/people who already qualify, so they can apply.` : '';
  return ephemeral(
    interaction,
    `✅ Anyone who brings **${invitesModule.joinsNeeded(settings)}** people in with their invite links can now **apply** for ${role}. An admin approves each one (applications go to ${settings.vipReviewChannelId ? `<#${settings.vipReviewChannelId}>` : 'the mod log — change it with `/vip review`'}).${caughtUp}`,
  );
}

// "Who they brought in: @a, @b, @c" — the people, not just the number, and which joins counted.
const MAX_INVITED_SHOWN = 25;
function invitedList(settings, userId) {
  const people = invitesModule.broughtBy(settings, userId);
  if (!people.length) return null;
  const shown = people.slice(-MAX_INVITED_SHOWN).map((p) => {
    if (p.counted) return `<@${p.id}>`;
    if (p.reason === 'unverified') return `<@${p.id}> ⏳ (hasn’t verified yet)`;
    if (p.reason === 'left-early') return `~~<@${p.id}>~~ ⚠️ (left within ${config.vip.mustStayHours ?? 24}h — didn’t count)`;
    return `~~<@${p.id}>~~ ⚠️ (${p.accountDays} day${p.accountDays === 1 ? '' : 's'} old — didn’t count)`;
  });
  const more = people.length > MAX_INVITED_SHOWN ? ` …and ${people.length - MAX_INVITED_SHOWN} more` : '';
  return `${truncate(shown.join(', '), 1500)}${more}`;
}

async function invitesCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const user = interaction.options.getUser('user') ?? interaction.user;
  const you = user.id === interaction.user.id;
  const staff = canModerate(interaction, settings) || interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!you && !staff) return ephemeral(interaction, '🚫 You can only see your own invites. Use `/invites` without picking anyone.');
  const counted = invitesModule.joinsBy(settings, user.id);
  const people = invitesModule.broughtBy(settings, user.id);
  const needed = invitesModule.joinsNeeded(settings);
  const role = settings.vipRoleId ? `<@&${settings.vipRoleId}>` : 'the VIP role';
  const minDays = Math.round(invitesModule.minAccountAgeMs() / 86_400_000);

  const lines = [
    counted >= needed && settings.vipRoleId
      ? `📨 ${you ? 'You have' : `${user} has`} brought in **${counted}** people — enough for ${role}.${you && !interaction.member.roles.cache.has(settings.vipRoleId) ? ' Apply with `/applyvip` and an admin will review it.' : ''}`
      : `📨 **${counted}** of **${needed}** towards ${role}${you ? '' : ` for ${user}`}.`,
  ];

  const waiting = people.filter((p) => p.reason === 'unverified').length;
  if (waiting > 0) lines.push(`⏳ ${waiting} ${waiting === 1 ? 'person hasn’t' : 'people haven’t'} verified yet — they count as soon as they do.`);
  const skipped = people.filter((p) => !p.counted && p.reason !== 'unverified').length;
  if (skipped > 0) {
    lines.push(`⚠️ ${skipped} join(s) didn’t count — accounts under ${minDays} days old, and people who leave within ${config.vip.mustStayHours ?? 24} hours, never count towards VIP.`);
  }
  const revoked = invitesModule.revokedFrom(settings, user.id);
  if (revoked > 0) lines.push(`➖ ${revoked} join(s) were taken off by staff.`);
  for (const g of giveaway.progressFor(interaction.guild, user.id)) {
    lines.push(`🎉 **Giveaway #${g.id}** (${truncate(g.prize, 60)}): **${g.joins}** of **${g.needed}** new joins since it started${g.joins >= g.needed ? ' ✅' : ''} — ends ${ts(g.endsAt)}`);
  }

  const list = invitedList(settings, user.id);
  if (list) lines.push(`**Who ${you ? 'you' : 'they'} brought in:** ${list}`);

  const broughtThemIn = invitesModule.invitedBy(settings, user.id);
  if (invitesModule.isVanity(broughtThemIn)) {
    const link = interaction.guild.vanityURLCode ? ` (discord.gg/${interaction.guild.vanityURLCode})` : '';
    lines.push(`🤝 **${you ? 'You' : 'They'} joined with the server’s own link**${link} — that doesn’t count towards anyone’s VIP.`);
  } else if (broughtThemIn) {
    lines.push(`🤝 **${you ? 'You were' : 'They were'} invited by** <@${broughtThemIn}>`);
  }

  return ephemeral(interaction, lines.join('\n'));
}

// ----- /verify -----
async function verifyCommand(interaction) {
  const { guild } = interaction;
  const sub = interaction.options.getSubcommand();

  const todo = (problems, redirect) => {
    const steps = [...problems];
    if (redirect) steps.push(`In the Developer Portal → your app → **OAuth2** → **Redirects**, add exactly \`${redirect}\` and press **Save Changes**.`);
    return steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n');
  };

  if (sub === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let channel;
    let vips = 0;
    try {
      ({ channel, vips } = await verify.enable(guild));
    } catch (err) {
      return ephemeral(interaction, `❌ Couldn’t set up verification: ${truncate(err.message, 300)}. I need **Administrator** and my role at the top.`);
    }
    const s = verify.status(guild);
    const blocked = Object.keys(blockedServers.blockedList(store.guild(guild.id))).length;
    return ephemeral(
      interaction,
      truncate(
        [
          `✅ **Verification is on.** People who join from now on only see ${channel} (English + Russian) and the sections in \`verify.visibleSections\`, and can’t chat, until they verify.`,
          vips ? `💎 Paused VIP for **${vips}** VIP(s) who haven’t verified — VIPs have to verify too, and get VIP back the moment they do.` : '💎 VIPs have to verify too (VIP is paused until they do).',
          blocked
            ? `🚷 Anyone in one of your **${blocked}** blocked server(s) is restricted (“${blockedServers.restrictReason()}”) when they verify, and verified people are checked again every ${config.verify?.scanSeconds ?? 30} seconds.`
            : '⚠️ No servers are blocked yet, so everyone passes. Add some with `/blockserver add`.',
          '',
          '**To finish (one time):**',
          todo(s.problems, s.redirectUri),
          `**${s.problems.length + 2}.** Run \`/verify split section:<your jailbreaks category>\` — it makes the new section, hides both from new joiners, and posts the Verify message under the old jailbreaks.`,
          '',
          'Then run `/verify status` to check it’s all working.',
        ].join('\n'),
        1900,
      ),
    );
  }

  if (sub === 'split') {
    const section = interaction.options.getChannel('section', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let result;
    try {
      result = await verify.splitSection(guild, section, { newName: interaction.options.getString('new_name') });
    } catch (err) {
      return ephemeral(interaction, `❌ ${err.friendly ? err.message : `Couldn’t split the section: ${truncate(err.message, 300)}`}`);
    }
    const lines = [
      `✅ **Done.** Made a copy of **${section.name}** with **${result.copied}** empty channel(s): ${result.newCategory}. Post the updated jailbreaks there.`,
      '• **New section** → only people with **Verified** (they verified, or they’re VIP). VIP-only channels stay VIP-only.',
      `• **Old section** → existing members who haven’t verified, like now. Verified people don’t see it any more. I posted the Verify message (English + Russian) at the bottom of **${result.notices}** old channel(s).`,
      '• **New members** see neither section — only the verify channel and the sections in `verify.visibleSections` — until they verify, then the new section.',
      'Admins see both. The new one is straight below the old one.',
    ];
    if (result.cleared.length) {
      lines.push(`🔧 ${result.cleared.map((id) => `<@&${id}>`).join(', ')} could see the jailbreak channels by their own permission, which would have let people skip verifying. I took that off (they still see the old section like everyone else until they verify).`);
    }
    for (const { channelId, roles } of result.roleOnly) {
      lines.push(`⚠️ <#${channelId}> is only for ${roles.map((id) => `<@&${id}>`).join(', ')}, so people with that role see it **without verifying** (Discord can’t require two roles). Change who can see it if that matters.`);
    }
    if (result.failed.length) lines.push(`⚠️ Couldn’t do some of it: ${truncate(result.failed.join(', '), 600)}`);
    return ephemeral(interaction, truncate(lines.join('\n'), 1900));
  }

  if (sub === 'require-all') return requireAllCommand(interaction);

  if (sub === 'off') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const letIn = await verify.disable(guild);
    return ephemeral(interaction, `✅ Verification is off. New members aren’t given Unverified any more.${letIn ? ` **${letIn}** new member(s) who hadn’t verified now see what existing members see.` : ''}`);
  }

  const s = verify.status(guild);
  const scan = s.lastScan
    ? `🔁 Last check ${ts(s.lastScan.at)}: **${s.lastScan.checked}** server list(s) checked in ${Math.max(1, Math.round(s.lastScan.took / 1000))}s, **${s.lastScan.caught}** restricted.`
    : '🔁 No checks have run yet (they start 10 seconds after I come online).';
  const lines = [
    s.enabled ? `✅ **Verification is on** (new members who joined since ${ts(s.startedAt, 'f')} need it to see the jailbreaks).` : '⏸️ **Verification is off.** Turn it on with `/verify setup`.',
    s.requireAll
      ? `🔒 **Everyone must verify** to use the server: **${s.held}** member(s) waiting${s.gating ? ` (still going: ${s.gating.done + s.gating.failed}/${s.gating.total})` : ''}.`
      : '🔓 Existing members can use the server without verifying (`/verify require-all enabled:True` changes that).',
    `👥 New members waiting to verify: **${s.pending}** · Verified: **${s.verified}** · Being checked every ${config.verify?.scanSeconds ?? 30}s: **${s.checking}**`,
    scan,
    s.split ? `📂 Split: old <#${s.split.oldCategoryId}> → new <#${s.split.newCategoryId}>` : '📂 Not split yet — run `/verify split section:<your jailbreaks category>`.',
    `🌐 Web address: ${s.redirectUri ? `\`${s.redirectUri}\`` : '*not known yet*'} · Web server: ${s.listening ? 'running ✅' : 'not running ❌'}`,
  ];
  if (s.problems.length || !s.redirectUri) lines.push('', '**Still to do:**', todo(s.problems, s.redirectUri));
  else lines.push('', `Make sure \`${s.redirectUri}\` is in the Developer Portal → **OAuth2** → **Redirects**, then try it with an alt account.`);
  return ephemeral(interaction, truncate(lines.join('\n'), 1900));
}

// ----- /verify require-all -----
async function requireAllCommand(interaction) {
  const { guild } = interaction;
  if (!isOwner(interaction)) return ephemeral(interaction, '🚫 Only the server owner can change who has to verify.');
  const enabled = interaction.options.getBoolean('enabled', true);
  const s = verify.status(guild);

  if (!enabled) {
    if (!s.requireAll && !s.held) return ephemeral(interaction, 'ℹ️ It’s already off: only new members have to verify.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const log = await fetchLogChannel(guild);
    // In the background: giving everyone their roles back can take a while on a big server.
    verify
      .requireAllOff(guild)
      .then(({ released, left }) =>
        log?.send({
          content: `🔓 **Everyone must verify is off** (by ${interaction.user}). **${released}** member(s) got their roles back.${left ? ` **${left}** still to go — I’ll keep trying every 30 seconds.` : ''}`,
          allowedMentions: { parse: [] },
        }),
      )
      .catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));
    return ephemeral(interaction, '🔓 **Back to new members only.** Giving everyone their roles back now — I’ll post in the mod log when it’s done.');
  }

  if (s.requireAll) return ephemeral(interaction, `ℹ️ It’s already on: **${s.held}** member(s) are waiting to verify. \`/verify status\` shows more.`);
  // Locking everyone out while the Verify button can't work would leave nobody able to get back in.
  if (!s.enabled) return ephemeral(interaction, '❌ Turn verification on first with `/verify setup`.');
  if (s.problems.length || !s.listening) {
    const fix = s.problems.map((p) => `• ${p}`).join('\n') || '• My web server isn’t running.';
    return ephemeral(interaction, truncate(`❌ Verification isn’t working yet, so nobody would be able to get back in. Fix this first (\`/verify status\`):\n${fix}`, 1900));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let result;
  try {
    result = await verify.requireAllOn(guild);
  } catch (err) {
    return ephemeral(interaction, `❌ Couldn’t turn it on: ${truncate(err.message, 300)}. I need **Administrator** and my role at the top.`);
  }
  const settings = store.guild(guild.id);
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const waiting = [...members.values()].filter((m) => verify.mustVerify(m, settings)).length;
  const oldSection = settings.verify.split?.oldCategoryId;
  const log = await fetchLogChannel(guild);
  await log
    ?.send({ content: `🔒 **Everyone must verify now** (turned on by ${interaction.user}). Taking the server away from **${waiting}** member(s) who haven’t verified — their roles are saved for when they do. I’ll post here when it’s done.`, allowedMentions: { parse: [] } })
    .catch(() => {});

  // In the background: on a big server this takes a while (Discord only lets bots change so many members at a time).
  verify
    .gateEveryone(guild)
    .then(
      (p) =>
        p &&
        log?.send({
          content: [
            `🔒 **Done:** **${p.done}** member(s) now only see ${result.channel} until they verify.`,
            p.failed ? `⚠️ Couldn’t change **${p.failed}** (is their role above mine?) — I’ll keep trying.` : null,
            p.kept ? `⚠️ **${p.kept}** kept a role I can’t take off (Server Booster, or a role above mine). If a channel lets that role in, they can still see it.` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          allowedMentions: { parse: [] },
        }),
    )
    .catch((err) => console.warn(`[verify] ${guild.name}: ${err.message}`));

  return ephemeral(
    interaction,
    truncate(
      [
        `🔒 **Everyone must verify now.** **${waiting}** member(s) who haven’t verified will only see ${result.channel} and the sections in \`verify.visibleSections\` (and can’t chat) until they do. I’m working through them now and will post in the mod log when it’s done.`,
        '• Their roles are **saved** and come straight back when they verify (plus the member role).',
        '• **Staff, VIPs and people who already verified** aren’t affected. New members land in the same place.',
        '• To let someone in without verifying, give them the **Verified** role.',
        '• Want #rules (or another channel) visible before verifying? Allow the **Unverified** role on it in Discord.',
        oldSection ? `• Nobody but staff sees the old jailbreaks (<#${oldSection}>) any more, so you can **delete that section** — then there’s just one.` : null,
        result.notHidden.length ? `⚠️ Couldn’t hide: ${truncate(result.notHidden.join(', '), 300)}` : null,
        '',
        'Undo it any time: `/verify require-all enabled:False` (everyone gets their roles back).',
      ]
        .filter((line) => line !== null)
        .join('\n'),
      1900,
    ),
  );
}

// ----- /msgdelete -----
// Deletes recent messages in the channel (optionally only one person's). Never the owner's, admins', the bot's or
// pinned ones, and moderators can't clear each other's. Everything deleted goes to #mod-watch as a file.
/** A message a moderator may delete: not pinned, not mine, not the owner's or an admin's, and under 14 days old. */
function canBeDeleted(guild, m) {
  if (!m?.author || m.pinned || m.system || m.createdTimestamp < Date.now() - BULK_DELETE_MAX_AGE) return false;
  if (m.author.id === guild.client.user.id || m.author.id === guild.ownerId) return false;
  const author = m.member ?? guild.members.cache.get(m.author.id) ?? null;
  return !(author && modGuard.isAdmin(author));
}

/**
 * Deletes the messages that `wanted` picks (newest first, at most `amount`) from `messages` — or from the latest 100
 * in the channel — never pinned ones, mine, or the owner's and admins', and saves them in #mod-watch as a text file.
 * Returns { gone } (the deleted messages), or { error }.
 */
async function deleteRecent(interaction, { channel = interaction.channel, messages = null, amount, wanted = () => true, fileName, reason = null, logText }) {
  const { guild } = interaction;
  const recent = messages ?? [...((await channel.messages.fetch({ limit: 100 }).catch(() => null))?.values() ?? [null])];
  if (recent[0] === null) return { error: '❌ I couldn’t read the messages here.' };
  const picked = [];
  for (const m of recent) {
    if (picked.length >= amount) break;
    if (canBeDeleted(guild, m) && wanted(m)) picked.push(m);
  }
  if (!picked.length) return { gone: [] };
  let deleted;
  try {
    deleted = await channel.bulkDelete(picked.map((m) => m.id), true);
  } catch (err) {
    return { error: `❌ Couldn’t delete them: ${truncate(err.message, 300)}` };
  }
  const gone = picked.filter((m) => deleted?.has?.(m.id) ?? true);
  const lines = gone
    .slice()
    .reverse()
    .map((m) => `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)}] ${m.author.tag} (${m.author.id}): ${m.content || ''}${m.attachments?.size ? ` [files: ${[...m.attachments.values()].map((a) => a.url).join(' ')}]` : ''}`);
  const file = new AttachmentBuilder(Buffer.from([`Deleted by ${interaction.user.tag} (${interaction.user.id}) in #${channel.name}`, reason ? `Reason: ${reason}` : '', '', ...lines].join('\n'), 'utf8'), {
    name: fileName,
  });
  await modGuard.logAction(guild, interaction.member, `${logText(gone)}${reason ? ` — ${truncate(reason, 300)}` : ''}`, { files: [file] });
  return { gone };
}

async function msgdeleteCommand(interaction) {
  const { guild, channel } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return ephemeral(interaction, '🚫 Only moderators can use this.');
  }
  if (!channel?.messages || typeof channel.bulkDelete !== 'function') return ephemeral(interaction, '❌ I can’t delete messages in this kind of channel.');
  const amount = interaction.options.getInteger('amount', true);
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason');
  if (await modGuard.blocked(interaction, 'msgdelete', `<@${user.id}> in <#${channel.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deleteRecent(interaction, {
    amount,
    wanted: (m) => m.author.id === user.id,
    fileName: `msgdelete-${channel.id}.txt`,
    reason,
    logText: (gone) => `🧹 deleted **${gone.length}** message(s) in <#${channel.id}> from ${who(user)}`,
  });
  if (result.error) return interaction.editReply(result.error);
  const { gone } = result;
  if (!gone.length) {
    return interaction.editReply('ℹ️ Nothing to delete. (I leave pinned messages, mine, and the owner’s and admins’ alone, and Discord can’t bulk-delete messages over 14 days old.)');
  }
  return interaction.editReply(`🧹 Deleted **${gone.length}** message(s).${gone.length < amount ? ' (Some were skipped: pinned, too old, or from the owner, admins or me.)' : ''}`);
}

// ----- /cleanup -----
// Spam: a popup with the latest 15 messages here that a moderator may delete (never the owner's, admins', mine or
// pinned ones), showing who sent each and what it says. They tick the spam and press Submit: those are deleted and
// saved to #mod-watch as a file. Moderators: `mods.limits.cleanup` times per 5 minutes (more and they're on cooldown).

const CLEANUP_SHOWN = 15;

function cleanupOption(m) {
  const name = m.member?.displayName ?? m.author.globalName ?? m.author.username ?? m.author.tag;
  const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
  const extras = [
    m.attachments?.size ? `📎 ${m.attachments.size} file(s)` : null,
    m.stickers?.size ? '🏷️ sticker' : null,
    m.poll ? '📊 poll' : null,
    m.embeds?.length && !text ? '🔗 embed' : null,
  ].filter(Boolean);
  const mins = Math.max(0, Math.round((Date.now() - m.createdTimestamp) / 60_000));
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return {
    label: truncate(`${name}: ${text || extras.join(' ') || '(no text)'}`, 100),
    description: truncate([age, `@${m.author.username ?? m.author.tag}`, ...extras].join(' · '), 100),
    value: m.id,
  };
}

async function cleanupCommand(interaction) {
  const { guild, channel } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return ephemeral(interaction, '🚫 Only moderators can use this.');
  }
  if (!channel?.messages || typeof channel.bulkDelete !== 'function') return ephemeral(interaction, '❌ I can’t delete messages in this kind of channel.');
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return ephemeral(interaction, '❌ I couldn’t read the messages here.');
  const shown = [...recent.values()].filter((m) => canBeDeleted(guild, m)).slice(0, CLEANUP_SHOWN);
  if (!shown.length) return ephemeral(interaction, 'ℹ️ There’s nothing here I can delete. (I leave pinned messages, mine, and the owner’s and admins’ alone.)');
  const modal = new ModalBuilder()
    .setCustomId(`oj:cleanupmodal:${channel.id}`)
    .setTitle(truncate(`Delete messages in #${channel.name}`, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Which messages?')
        .setDescription(`The latest ${shown.length} here, newest first. Tick every one to delete.`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId('messages').setPlaceholder('Pick the spam').setMinValues(1).setMaxValues(shown.length).addOptions(shown.map(cleanupOption)),
        ),
      new LabelBuilder()
        .setLabel('Reason (optional)')
        .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),
    );
  return interaction.showModal(modal);
}

/** The /cleanup popup was sent: the ticked messages are deleted (checked again — none of the protected ones). */
async function cleanupModal(interaction, channelId) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return ephemeral(interaction, '🚫 Only moderators can use this.');
  }
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.messages || typeof channel.bulkDelete !== 'function') return ephemeral(interaction, '❌ I can’t delete messages in that channel.');
  const ids = [...new Set(interaction.fields.getStringSelectValues('messages'))].slice(0, CLEANUP_SHOWN);
  let reason = null;
  try {
    reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
  } catch {
    // left empty
  }
  if (!ids.length) return ephemeral(interaction, 'ℹ️ No messages were picked.');
  if (await modGuard.blocked(interaction, 'cleanup', `${ids.length} message(s) in <#${channel.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = (await Promise.all(ids.map((id) => channel.messages.cache?.get(id) ?? channel.messages.fetch(id).catch(() => null)))).filter(Boolean);
  const result = await deleteRecent(interaction, {
    channel,
    messages,
    amount: ids.length,
    wanted: (m) => ids.includes(m.id),
    fileName: `cleanup-${channel.id}.txt`,
    reason,
    logText: (gone) => `🧹 deleted **${gone.length}** message(s) from **${new Set(gone.map((m) => m.author.id)).size}** people in <#${channel.id}> (picked with /cleanup)`,
  });
  if (result.error) return interaction.editReply(result.error);
  if (!result.gone.length) return interaction.editReply('ℹ️ Those messages are already gone.');
  const missing = ids.length - result.gone.length;
  return interaction.editReply(`🧹 Deleted **${result.gone.length}** message(s).${missing ? ` (${missing} were already gone.)` : ''}`);
}

// ----- /membercount -----
async function membercountCommand(interaction) {
  const { guild } = interaction;
  if (!modGuard.isAdmin(interaction.member)) return ephemeral(interaction, '🚫 Only admins and the owner can do this.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.options.getSubcommand() === 'off') {
    await memberCounter.turnOff(guild);
    return ephemeral(interaction, '🗑️ Member counter removed.');
  }
  const names = await memberCounter.turnOn(guild);
  return ephemeral(
    interaction,
    `✅ Added at the top of the server: **${names?.join('** and **') ?? 'the counters'}**. Everyone can see them, nobody can join them, and they update every 10 minutes (Discord only allows renaming a channel twice in 10 minutes). Drag them wherever you like.`,
  );
}

// ----- /modhide -----
async function modhideCommand(interaction) {
  const { guild } = interaction;
  if (!store.isTrusted(guild, interaction.user.id)) return ephemeral(interaction, '🚫 Only the server owner (or someone they trust) can do this.');
  const settings = store.guild(guild.id);
  if (!settings.modRoleId) return ephemeral(interaction, '⚠️ There’s no mod role yet (`mods.roleId` in config.js, or `/setup`).');
  const m = modGuard.modsSettings(settings);
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const builtIn = [settings.logChannelId, config.logs?.channelId, m.watchChannelId, settings.banList?.channelId].filter(Boolean);
    return ephemeral(
      interaction,
      [
        '🙈 **Moderators can’t see:**',
        ...m.hiddenChannels.map((id) => `• <#${id}>`),
        m.hiddenChannels.length ? '' : '• (nothing added yet)',
        `Always hidden too: ${builtIn.map((id) => `<#${id}>`).join(', ') || 'the logs once they exist'}`,
      ].join('\n'),
    );
  }
  const channel = interaction.options.getChannel('channel', true);
  if (sub === 'add' && !m.hiddenChannels.includes(channel.id)) m.hiddenChannels.push(channel.id);
  if (sub === 'remove') m.hiddenChannels = m.hiddenChannels.filter((id) => id !== channel.id);
  store.save();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await modGuard.hideLogsFromMods(guild);
  return ephemeral(
    interaction,
    sub === 'add'
      ? `🙈 Moderators can’t see ${channel}${channel.type === ChannelType.GuildCategory ? ' (or anything in it)' : ''} now — blocked for the mod role and for each moderator.`
      : `👀 Moderators can see ${channel} again (unless something else stops them).`,
  );
}

// ----- /modcooldown -----
async function modcooldownCommand(interaction) {
  const { guild } = interaction;
  if (!store.isTrusted(guild, interaction.user.id)) return ephemeral(interaction, '🚫 Only the server owner (or someone they trust) can do this.');
  const sub = interaction.options.getSubcommand();
  if (sub === 'lift') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await modGuard.liftCooldown(guild, interaction.options.getUser('user', true).id, interaction.user);
    return ephemeral(interaction, result.text);
  }
  const cooldowns = Object.entries(modGuard.modsSettings(store.guild(guild.id)).cooldowns);
  if (!cooldowns.length) return ephemeral(interaction, '✅ No moderators are on cooldown.');
  return ephemeral(interaction, ['🛑 **On cooldown:**', ...cooldowns.map(([id, c]) => `• <@${id}> — too many ${c.kind}s, ${ts(c.at)}`), '', 'Lift one with `/modcooldown lift user:`'].join('\n'));
}

// ----- /verifybutton -----
async function verifyButtonCommand(interaction) {
  const { guild, member } = interaction;
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const ping = interaction.options.getString('ping') ?? 'none';
  const role = interaction.options.getRole('ping_role');
  const pingsEveryone = ping === 'everyone' || ping === 'here';

  if (!channel?.isTextBased()) return ephemeral(interaction, '❌ Pick a text channel.');
  const me = guild.members.me;
  if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return ephemeral(interaction, `❌ I can’t post in ${channel}. Check my permissions there.`);
  }
  // Nobody can use the bot to reach channels or pings they couldn't use themselves.
  if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.SendMessages)) {
    return ephemeral(interaction, `🚫 You can’t post in ${channel} yourself, so I won’t post there for you.`);
  }
  if (pingsEveryone && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return ephemeral(interaction, '🚫 You don’t have permission to ping @everyone or @here.');
  }
  if (role && !role.mentionable && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return ephemeral(interaction, `🚫 You can’t ping ${role} — it isn’t pingable and you don’t have Mention Everyone.`);
  }

  const panel = verify.announcementPanel({ text: interaction.options.getString('text'), title: interaction.options.getString('title') });
  const content = [pingsEveryone ? `@${ping}` : null, role ? `<@&${role.id}>` : null].filter(Boolean).join(' ') || undefined;
  const sent = await channel
    .send({ content, ...panel, allowedMentions: { parse: pingsEveryone ? ['everyone'] : [], roles: role ? [role.id] : [] } })
    .catch((err) => err);
  if (sent instanceof Error) return ephemeral(interaction, `❌ Couldn’t post it: ${truncate(sent.message, 300)}`);

  // The button only works once verification is set up: say so now rather than when members press it.
  const s = verify.status(guild);
  const warning = !s.enabled
    ? '\n⚠️ Verification isn’t on yet — run `/verify setup` or the button won’t work.'
    : s.problems.length
      ? `\n⚠️ Verification isn’t fully set up yet, so the button won’t work until it is: ${s.problems[0]}`
      : '';
  return ephemeral(interaction, `✅ Posted in ${channel}: ${sent.url}${warning}`);
}

// ----- /backup -----
async function backupCommand(interaction) {
  if (!(await isBotOwner(interaction))) {
    return ephemeral(interaction, '🚫 Only the owner of the O Jailbreak bot (the account that created it in the Developer Portal) can use /backup.');
  }
  const { guild } = interaction;
  const sub = interaction.options.getSubcommand();
  const fromGuildId = interaction.options.getString('from_server_id')?.trim() || null;
  if (fromGuildId && !/^\d{17,20}$/.test(fromGuildId)) return ephemeral(interaction, '❌ That isn’t a server ID (a long number).');
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
    return ephemeral(interaction, '❌ I need the **Create Invite** permission in this server to add people to it (Administrator covers it).');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (sub === 'status') {
    const { candidates, left, restricted } = await verify.pullCandidates(interaction.client, guild, { fromGuildId });
    const already = candidates.filter((r) => guild.members.cache.has(r.userId)).length;
    return ephemeral(
      interaction,
      [
        `🛟 **${candidates.length}** verified people could be added to **${truncate(guild.name, 80)}** (${already} are already here).`,
        left ? `↩️ ${left} left the old server on purpose, so they’d be skipped.` : null,
        restricted ? `🚷 ${restricted} are restricted, so they’d be skipped.` : null,
        'Run `/backup pull` here to add them.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  await ephemeral(interaction, '🛟 Adding everyone who verified to this server… I’ll update this as I go and DM you when it’s done.');
  const summary = (r, done) =>
    [
      `${done ? '✅ **Done.**' : '⏳ Working…'} Added **${r.added}** of ${r.total} to **${truncate(guild.name, 80)}** (${r.already} were already here).`,
      r.noAccess ? `🔒 ${r.noAccess} removed the bot’s access, so they couldn’t be added.` : null,
      r.failed ? `⚠️ ${r.failed} failed (they may be in too many servers, or banned here).` : null,
      r.left ? `↩️ Skipped ${r.left} who left the old server on purpose.` : null,
      r.restricted ? `🚷 Skipped ${r.restricted} restricted people.` : null,
    ]
      .filter(Boolean)
      .join('\n');
  const startedAt = Date.now();
  // A reply can only be edited for 15 minutes; after that the DM has the result.
  const update = (r, done) => (Date.now() - startedAt < 14 * 60_000 ? interaction.editReply({ content: summary(r, done) }).catch(() => {}) : Promise.resolve());
  const result = await verify.pullMembers(interaction.client, guild, { fromGuildId, onProgress: (r) => update(r, false) });
  await update(result, true);
  await interaction.user.send(summary(result, true)).catch(() => {});
  console.log(`[backup] ${interaction.user.tag} pulled ${result.added} verified people into ${guild.name}.`);
  return null;
}

// ----- /massban -----
const MAX_MASSBAN = 200; // Discord's limit for one bulk ban

/** User IDs in pasted text ("1. 8000000000000000002", commas, new lines…). List numbers are too short to count. */
function parseUserIds(text) {
  return [...new Set(String(text ?? '').match(/\b\d{17,20}\b/g) ?? [])];
}

async function massbanCommand(interaction) {
  const { guild } = interaction;
  if (!isOwner(interaction)) return ephemeral(interaction, '🚫 Only the server owner can use /massban.');

  const ids = parseUserIds(interaction.options.getString('ids', true));
  if (!ids.length) return ephemeral(interaction, '❌ I couldn’t find any user IDs in that. Paste the long numbers (17–20 digits).');
  if (ids.length > MAX_MASSBAN) return ephemeral(interaction, `❌ That’s ${ids.length} IDs. Discord allows ${MAX_MASSBAN} at a time, so split the list up.`);

  // Never the owner, whoever is running it, the bot itself, or trusted people.
  const protectedIds = new Set([guild.ownerId, interaction.user.id, interaction.client.user.id, ...store.guild(guild.id).trusted]);
  const skipped = ids.filter((id) => protectedIds.has(id));
  const toBan = ids.filter((id) => !protectedIds.has(id));
  if (!toBan.length) return ephemeral(interaction, '❌ Everyone on that list is the owner, you, me or a trusted user, so nobody was banned.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.options.getString('reason') ?? 'Mass ban';
  const hours = interaction.options.getInteger('delete_hours') ?? 24;
  let result;
  try {
    result = await guild.bans.bulkCreate(toBan, {
      reason: truncate(`${reason} — mass ban by ${interaction.user.tag}`, 512),
      deleteMessageSeconds: hours * 3600,
    });
  } catch (err) {
    return ephemeral(interaction, `❌ Discord refused the ban: ${truncate(err.message, 300)}`);
  }

  const banned = result.bannedUsers ?? [];
  const failed = result.failedUsers ?? [];
  const lines = [`🔨 **Banned ${banned.length} of ${ids.length}.**`];
  if (failed.length) lines.push(`⚠️ ${failed.length} couldn’t be banned (already banned, not a real user, or their role is above mine): ${failed.map((id) => `\`${id}\``).join(', ')}`);
  if (skipped.length) lines.push(`ℹ️ Skipped ${skipped.length} (the owner, you, me or a trusted user).`);

  const log = await fetchLogChannel(guild);
  await log
    ?.send({
      content: truncate(`🔨 ${interaction.user} mass-banned **${banned.length}** user(s). **Reason:** ${reason}\n${banned.map((id) => `<@${id}> \`${id}\``).join('\n')}`, 2000),
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return ephemeral(interaction, truncate(lines.join('\n'), 1900));
}

// ----- /blocklist -----
const MAX_LIST_FILE = 2 * MB;

async function blocklistCommand(interaction) {
  const { guild } = interaction;
  if (!isOwner(interaction)) return ephemeral(interaction, '🚫 Only the server owner can use /blocklist.');
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const s = await blocklist.summary(guild);
    const file = s.total ? [new AttachmentBuilder(Buffer.from(s.ids.join('\n'), 'utf8'), { name: 'blocklist.txt' })] : [];
    return interaction.editReply({
      content: s.total
        ? `🚫 **${s.total}** IDs on the blocklist. **${s.here}** of them are in the server (**${s.restricted}** restricted). The full list is attached.`
        : 'The blocklist is empty. Add IDs with `/blocklist add`.',
      files: file,
      allowedMentions: { parse: [] },
    });
  }

  // add / remove: IDs from the text box and/or a file
  const file = interaction.options.getAttachment('file');
  if (file && file.size > MAX_LIST_FILE) return ephemeral(interaction, '❌ That file is too big. Split it up (2 MB at most).');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let fileText = '';
  if (file) {
    const data = await download(file.url);
    if (!data) return ephemeral(interaction, '❌ I couldn’t download that file. Try again.');
    fileText = data.toString('utf8');
  }
  const ids = blocklist.parseIds(`${interaction.options.getString('ids') ?? ''}\n${fileText}`);
  if (!ids.length) return ephemeral(interaction, '❌ I couldn’t find any user IDs. Paste the long numbers (17–20 digits), or attach a .txt file of them.');

  if (sub === 'remove') {
    const removed = blocklist.remove(guild, ids);
    return ephemeral(interaction, `✅ Took **${removed}** ID(s) off the blocklist.${removed ? ' Anyone already restricted stays restricted — use `/unrestrict` if they should be let back in.' : ''}`);
  }

  // Never the owner, the bot, or trusted users.
  const protectedIds = new Set([guild.ownerId, interaction.client.user.id, ...store.guild(guild.id).trusted]);
  const toAdd = ids.filter((id) => !protectedIds.has(id));
  const added = blocklist.add(guild, toAdd, interaction.user.id);
  const skipped = ids.length - toAdd.length;
  const head = `✅ Added **${added}** ID(s) to the blocklist${toAdd.length - added ? ` (${toAdd.length - added} were already on it)` : ''}${skipped ? `, skipped ${skipped} (you, the bot or trusted users)` : ''}. Anyone on it who joins later is restricted straight away.`;
  await ephemeral(interaction, `${head}\n⏳ Restricting the ones who are in the server now…`);

  const startedAt = Date.now();
  const progress = (r, done) =>
    `${head}\n${done ? '✅' : '⏳'} ${r.here ? `Restricted **${r.restricted}** of the **${r.here}** in the server${r.skipped ? ` (${r.skipped} skipped — staff, or I couldn’t; see the mod log)` : ''}.` : 'None of them are in the server right now.'}`;
  const update = (r, done) => (Date.now() - startedAt < 14 * 60_000 ? interaction.editReply({ content: progress(r, done) }).catch(() => {}) : Promise.resolve());
  const result = await blocklist.sweep(guild, { onProgress: (r) => update(r, false) });
  await update(result, true);
  if (result.here > 10) await interaction.user.send(progress(result, true)).catch(() => {});
  return null;
}

// ----- /blockserver -----
async function blockserverCommand(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  const list = blockedServers.blockedList(settings);
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await blockedServers.addInvite(guild, interaction.options.getString('invite', true));
    if (!result.ok) return ephemeral(interaction, result.text);
    const caught = await blockedServers.sweep(guild);
    return ephemeral(interaction, `${result.text} Anyone wearing its tag or posting its invite is restricted.${caught ? ` I’ve restricted **${caught}** member(s) wearing its tag already.` : ''}`);
  }

  if (sub === 'remove') {
    const wanted = interaction.options.getString('server', true).trim().toLowerCase();
    const found = Object.entries(list).find(([id, e]) => id === wanted || e.name.toLowerCase() === wanted || e.invites.some((c) => c.toLowerCase() === wanted));
    if (!found) return ephemeral(interaction, '❌ That server isn’t blocked. `/blockserver list` shows the ones that are.');
    delete list[found[0]];
    store.save();
    const inConfig = found[1].invites.some((c) => (config.blockedServers?.invites ?? []).some((x) => x.toLowerCase() === c.toLowerCase()));
    const note = inConfig ? '\n⚠️ It’s also in `blockedServers` in config.js, so it comes back when I restart unless you take it out there.' : '';
    return ephemeral(interaction, `✅ **${found[1].name}** isn’t blocked any more. People already restricted for it stay restricted (use \`/unrestrict\`).${note}`);
  }

  if (sub === 'addname') {
    const name = interaction.options.getString('name', true).trim();
    const folded = normalizeWord(name);
    if (folded.length < blockedServers.MIN_NAME_LETTERS) {
      return ephemeral(interaction, `❌ Use at least ${blockedServers.MIN_NAME_LETTERS} letters — a short name like “anon” would restrict everyone called “Anonymous”.`);
    }
    if (blockedServers.blockedNames(settings).some((n) => normalizeWord(n) === folded)) return ephemeral(interaction, `ℹ️ **${name}** is already blocked.`);
    settings.blockedNames.push(name);
    store.save();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const caught = await blockedServers.sweep(guild);
    return ephemeral(interaction, `✅ Anyone using the name **${name}** (or a disguise of it) is restricted.${caught ? ` I’ve restricted **${caught}** member(s) already.` : ''}`);
  }

  if (sub === 'removename') {
    const folded = normalizeWord(interaction.options.getString('name', true));
    if ((config.blockedServers?.names ?? []).some((n) => normalizeWord(n) === folded)) {
      return ephemeral(interaction, '❌ That name is in `blockedServers` → `names` in config.js, so it can only be taken off there.');
    }
    const before = settings.blockedNames.length;
    settings.blockedNames = settings.blockedNames.filter((n) => normalizeWord(n) !== folded);
    if (settings.blockedNames.length === before) return ephemeral(interaction, '❌ That name isn’t blocked. `/blockserver list` shows the ones that are.');
    store.save();
    return ephemeral(interaction, '✅ That name isn’t blocked any more. People already restricted for it stay restricted (use `/unrestrict`).');
  }

  const lines = Object.entries(list).map(([id, e]) => `• **${e.name}** \`${id}\` — ${e.invites.map((c) => `discord.gg/${c}`).join(', ')}`);
  const names = blockedServers.blockedNames(settings);
  return ephemeral(
    interaction,
    truncate(
      [
        lines.length
          ? `🚷 **Blocked servers** (anyone wearing their tag or posting their invite is restricted):\n${lines.join('\n')}`
          : 'No servers are blocked. Add one with `/blockserver add invite:discord.gg/...`',
        names.length
          ? `🚷 **Blocked names** (anyone using one, even disguised, is restricted): ${names.map((n) => `**${n}**`).join(', ')}`
          : 'No names are blocked. Add one with `/blockserver addname`.',
      ].join('\n\n'),
      2000,
    ),
  );
}

// ----- /giveaway -----
async function giveawayCommand(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  const sub = interaction.options.getSubcommand();
  const id = interaction.options.getInteger('id');

  if (sub === 'start') {
    const durationMs = giveaway.parseDuration(interaction.options.getString('duration', true));
    if (!durationMs || durationMs < giveaway.MIN_DURATION_MS || durationMs > giveaway.MAX_DURATION_MS) {
      return ephemeral(interaction, '❌ Give a duration between 1 minute and 60 days, like `30m`, `12h`, `1d`, `1d12h` or `1w`.');
    }
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const me = guild.members.me;
    if (!channel?.isTextBased() || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return ephemeral(interaction, `❌ I can’t post in ${channel ?? 'that channel'}. Pick a text channel I can send messages in.`);
    }
    if (!channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.SendMessages)) {
      return ephemeral(interaction, `❌ You can’t post in ${channel} yourself, so I won’t post there for you.`);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { giveaway: g, message } = await giveaway.start({
      guild,
      channel,
      host: interaction.user,
      prize: interaction.options.getString('prize', true),
      durationMs,
      winners: interaction.options.getInteger('winners') ?? giveaway.DEFAULT_WINNERS,
      joinsNeeded: interaction.options.getInteger('joins') ?? giveaway.DEFAULT_JOINS,
    });
    const noVipRole = settings.vipRoleId || config.updating?.vipRoleId ? '' : '\n⚠️ No VIP role is set (`/vip set`), so nobody gets in free.';
    return ephemeral(
      interaction,
      `✅ Giveaway **#${g.id}** is up: ${message.url}\nIt ends ${ts(g.endsAt)} and draws **${g.winners}** winner(s) from the ${giveaway.EMOJI} reactions. A reaction only counts for VIPs, or members who brought in **${g.joinsNeeded}** new people with their invite links.${noVipRole}`,
    );
  }

  if (sub === 'list') {
    if (id) {
      const g = giveaway.findGiveaway(settings, id);
      if (!g) return ephemeral(interaction, `❌ There’s no giveaway #${id}.`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { qualified, notQualified } = await giveaway.entries(guild, g);
      const how = (userId) => (giveaway.isVip(guild.members.cache.get(userId), settings) ? '🌟 VIP' : `📨 ${g.joins[userId]?.length ?? 0}/${g.joinsNeeded} joins`);
      const lines = [
        `🎉 **Giveaway #${g.id}: ${g.prize}**: ${qualified.length} of ${qualified.length + notQualified.length} reactions qualify`,
        ...qualified.map((userId) => `✅ <@${userId}> — ${how(userId)}`),
      ];
      if (notQualified.length) lines.push('', `**Reacted but don’t qualify yet:** ${notQualified.map((userId) => `<@${userId}> (${how(userId)})`).join(', ')}`);
      return ephemeral(interaction, truncate(lines.join('\n'), 1900));
    }
    const running = giveaway.activeGiveaways(settings);
    if (!running.length) return ephemeral(interaction, 'There are no giveaways running. Start one with `/giveaway start`.');
    const lines = running.map((g) => `**#${g.id}** ${truncate(g.prize, 80)} — ends ${ts(g.endsAt)}, ${g.winners} winner(s)`);
    lines.push('', 'Use `/giveaway list id:<number>` to see who has reacted and who qualifies.');
    return ephemeral(interaction, lines.join('\n'));
  }

  if (sub === 'end') {
    const g = giveaway.findGiveaway(settings, id, { ended: id ? undefined : false });
    if (!g) return ephemeral(interaction, id ? `❌ There’s no giveaway #${id}.` : 'There are no giveaways running.');
    if (g.ended) return ephemeral(interaction, `ℹ️ Giveaway #${g.id} has already ended. Use \`/giveaway reroll\` to draw someone else.`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const winners = await giveaway.end(guild, g);
    if (winners === null) return ephemeral(interaction, `⏳ Giveaway #${g.id} is already ending — the winners will be posted under it in a moment.`);
    return ephemeral(interaction, winners.length ? `✅ Ended giveaway #${g.id}. Winner(s): ${winners.map((w) => `<@${w}>`).join(', ')}` : `✅ Ended giveaway #${g.id}. Nobody qualified.`);
  }

  // reroll
  const g = giveaway.findGiveaway(settings, id, { ended: id ? undefined : true });
  if (!g) return ephemeral(interaction, id ? `❌ There’s no giveaway #${id}.` : 'No giveaway has ended yet.');
  if (!g.ended) return ephemeral(interaction, `ℹ️ Giveaway #${g.id} is still running. End it first with \`/giveaway end\`.`);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const winners = await giveaway.reroll(guild, g, interaction.options.getInteger('winners') ?? 1);
  return ephemeral(
    interaction,
    winners.length ? `✅ New winner(s) for #${g.id}: ${winners.map((w) => `<@${w}>`).join(', ')}` : `😕 Everyone who qualified for #${g.id} has already won.`,
  );
}

// ----- /rank, /leaderboard and /levels -----
async function rankCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const user = interaction.options.getUser('user') ?? interaction.user;
  if (!settings.levels.enabled && !levels.xpOf(settings, user.id)) {
    return ephemeral(interaction, 'ℹ️ Levels are switched off in this server. An admin can turn them on with `/levels on`.');
  }
  return interaction.reply({ embeds: [levels.rankEmbed(interaction.guild, user, settings)], allowedMentions: { parse: [] } });
}

async function leaderboardCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  return interaction.reply({ embeds: [levels.leaderboardEmbed(interaction.guild, settings, interaction.user.id)], allowedMentions: { parse: [] } });
}

async function levelsCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'on' || sub === 'off') {
    settings.levels.enabled = sub === 'on';
    store.save();
    return ephemeral(
      interaction,
      sub === 'on' ? '✅ People now earn XP for chatting. `/rank` and `/leaderboard` show how everyone is doing.' : '✅ XP is off. Nobody loses the XP they already have.',
    );
  }

  if (sub === 'rewards') {
    const rows = Object.entries(settings.levels.rewards)
      .map(([level, roleId]) => [Number(level), roleId])
      .sort((a, b) => a[0] - b[0])
      .map(([level, roleId]) => `**Level ${level}** → <@&${roleId}>`);
    return ephemeral(interaction, rows.length ? `🎖️ **Level rewards**\n${rows.join('\n')}` : 'No level rewards yet. Add one with `/levels reward level:5 role:@Regular`.');
  }

  if (sub === 'announce') {
    const channel = interaction.options.getChannel('channel');
    const enabled = interaction.options.getBoolean('enabled');
    if (enabled !== null) settings.levels.announce = enabled;
    if (channel) settings.levels.announceChannelId = channel.id;
    if (enabled === null && !channel) settings.levels.announceChannelId = null;
    store.save();
    if (!settings.levels.announce) return ephemeral(interaction, '✅ Level-ups won’t be announced any more.');
    return ephemeral(
      interaction,
      settings.levels.announceChannelId
        ? `✅ Level-ups will be announced in <#${settings.levels.announceChannelId}>.`
        : '✅ Level-ups will be announced in whichever channel they were chatting in.',
    );
  }

  if (sub === 'board') {
    const channel = interaction.options.getChannel('channel');
    if (!channel) {
      settings.levels.board.channelId = null;
      settings.levels.board.messageId = null;
      store.save();
      return ephemeral(interaction, '✅ The live leaderboard is off. `/leaderboard` still works anywhere.');
    }
    const canPost = channel.permissionsFor(interaction.guild.members.me);
    const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].filter((perm) => !canPost?.has(perm));
    if (missing.length) return ephemeral(interaction, `❌ I can't post in ${channel}. Give my role these permissions there: **${permissionNames(missing)}**`);

    settings.levels.board.channelId = channel.id;
    settings.levels.board.messageId = null;
    store.save();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const posted = await levels.updateBoard(interaction.guild, { force: true });
    return ephemeral(
      interaction,
      posted
        ? `✅ The leaderboard now lives in ${channel} and updates itself as people chat. Pin it so everyone can find it.`
        : `❌ I couldn't post it in ${channel} — check I can see and send messages there.`,
    );
  }

  if (sub === 'style') {
    const board = settings.levels.board;
    const title = interaction.options.getString('title');
    const colour = interaction.options.getString('colour');
    const size = interaction.options.getInteger('size');
    const showXp = interaction.options.getBoolean('show_xp');
    if (title === null && colour === null && size === null && showXp === null) {
      return ephemeral(
        interaction,
        [
          '🎨 **Leaderboard style**',
          `• Title: ${board.title ? `\`${board.title}\`` : `\`${levels.DEFAULT_TITLE}\` (default)`}`,
          `• Colour: ${board.colour ? `#${board.colour.toString(16).padStart(6, '0')}` : 'yellow (default)'}`,
          `• Showing: top ${board.size || 10}`,
          `• XP numbers: ${board.showXp === false ? 'hidden' : 'shown'}`,
          '',
          'Change any of them: `/levels style title:🏆 {server} legends colour:Pink size:15 show_xp:False`',
        ].join('\n'),
      );
    }
    if (title !== null) board.title = title;
    if (colour !== null) board.colour = Number.parseInt(colour, 16);
    if (size !== null) board.size = size;
    if (showXp !== null) board.showXp = showXp;
    store.save();
    await levels.updateBoard(interaction.guild, { force: true }).catch(() => {});
    return interaction.reply({
      content: '✅ Leaderboard style saved — here it is:',
      embeds: [levels.leaderboardEmbed(interaction.guild, settings, interaction.user.id)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'set') {
    const user = interaction.options.getUser('user', true);
    const level = interaction.options.getInteger('level', true);
    settings.levels.xp[user.id] = levels.xpForLevel(level);
    store.save();
    const member = interaction.options.getMember('user');
    if (member) await levels.giveRewards(member, settings, level);
    return ephemeral(interaction, `✅ ${user} is now level **${level}**.`);
  }

  const level = interaction.options.getInteger('level', true);
  const role = interaction.options.getRole('role');
  if (!role) {
    delete settings.levels.rewards[level];
    store.save();
    return ephemeral(interaction, `✅ Level ${level} doesn’t give a role any more.`);
  }
  if (role.id === interaction.guildId || role.managed) return ephemeral(interaction, '❌ Pick a normal role — not @everyone or a bot’s role.');
  if (role.permissions.any(RISKY_FOR_EVERYONE)) return ephemeral(interaction, `❌ ${role} has moderator or admin permissions. Level rewards should be plain roles.`);
  if (!role.editable) return ephemeral(interaction, `❌ I can't give out ${role} — drag my role above it in Server Settings → Roles.`);

  settings.levels.rewards[level] = role.id;
  store.save();
  return ephemeral(interaction, `✅ Everyone who reaches **level ${level}** gets ${role}. Rewards stack, so they keep the earlier ones too.`);
}

async function welcomeCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'off') {
    settings.welcomeChannelId = null;
    store.save();
    return ephemeral(interaction, '✅ New members won’t be welcomed any more.');
  }

  if (sub === 'test') {
    if (!settings.welcomeChannelId) return ephemeral(interaction, '⚠️ No welcome channel yet. Run `/welcome set channel:#welcome` first.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sent = await welcome.welcome(interaction.member, null, { force: true });
    return ephemeral(interaction, sent ? `✅ Posted a test welcome in <#${settings.welcomeChannelId}>.` : `❌ I couldn't post in <#${settings.welcomeChannelId}> — check I can see and send messages there.`);
  }

  const channel = interaction.options.getChannel('channel', true);
  const canPost = channel.permissionsFor(interaction.guild.members.me);
  const missing = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].filter((perm) => !canPost?.has(perm));
  if (missing.length) return ephemeral(interaction, `❌ I can't post in ${channel}. Give my role these permissions there: **${permissionNames(missing)}**`);

  settings.welcomeChannelId = channel.id;
  store.save();
  return ephemeral(
    interaction,
    `✅ New members will be welcomed in ${channel}, with whose invite link they used. Try it with \`/welcome test\`, and change the wording under \`welcome\` in \`config.js\`.`,
  );
}

async function banlistCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ready = await banList.prepare(interaction.guild, { tellModLog: false });
  if (!ready.ok) return ephemeral(interaction, `❌ ${ready.text}`);
  if (sub === 'setup') return ephemeral(interaction, `✅ The ban list is ${ready.channel}. Only admins can see it.`);

  const result = await banList.syncBans(interaction.guild);
  return ephemeral(interaction, `${result.text} They're listed in ${ready.channel}.`);
}

// ----- /post -----
const UPLOAD_LIMIT_MB = [10, 10, 50, 100]; // by server boost level

async function download(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function postCommand(interaction) {
  const { guild, member } = interaction;
  const settings = store.guild(guild.id);
  const staff = isOwner(interaction) || (settings.modRoleId && member.roles.cache.has(settings.modRoleId)) || member.permissions.has(PermissionFlagsBits.ManageMessages);
  if (!staff) return ephemeral(interaction, '🚫 Only staff can post as the bot.');

  const channel = interaction.options.getChannel('channel', true);
  const file = interaction.options.getAttachment('file');
  const typed = interaction.options.getString('text') ?? '';
  const title = interaction.options.getString('title') ?? '';
  const ping = interaction.options.getString('ping') ?? 'none';
  const role = interaction.options.getRole('ping_role');
  const colour = parseInt(interaction.options.getString('colour') ?? '5865f2', 16);
  const attachOriginal = interaction.options.getBoolean('attach_file') ?? false;
  const pingsEveryone = ping === 'everyone' || ping === 'here';

  if (!file && !typed.trim()) return ephemeral(interaction, 'Add a **file** (like a .txt) or some **text** to post.');
  // Staff can't use the bot to reach channels or pings they couldn't use themselves.
  if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.SendMessages)) {
    return ephemeral(interaction, `🚫 You can't post in ${channel} yourself, so I won't post there for you.`);
  }
  if (pingsEveryone && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return ephemeral(interaction, "🚫 You don't have permission to ping @everyone or @here.");
  }
  if (role && !role.mentionable && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return ephemeral(interaction, `🚫 You can't ping ${role} — it isn't pingable and you don't have Mention Everyone.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let text = typed;
  const files = [];
  if (file) {
    const isText = TEXT_FILE.test(file.name) || Boolean(file.contentType?.startsWith('text/'));
    const limit = (UPLOAD_LIMIT_MB[guild.premiumTier] ?? 10) * MB;
    if (isText && file.size > MAX_TEXT_BYTES) return interaction.editReply('❌ That text file is bigger than 1 MB. Split it into smaller files.');
    if (!isText && file.size > limit) return interaction.editReply(`❌ That file is too big for this server (the limit here is ${limit / MB} MB).`);

    const data = await download(file.url);
    if (!data) return interaction.editReply("❌ Couldn't download your file from Discord. Try again.");
    if (isText) {
      text = [typed, data.toString('utf8')].filter((t) => t.trim()).join('\n\n');
      if (attachOriginal) files.push(new AttachmentBuilder(data, { name: file.name }));
    } else {
      files.push(new AttachmentBuilder(data, { name: file.name }));
    }
  }

  const parts = splitText(text);
  if (parts.length > MAX_POST_PARTS) {
    return interaction.editReply(`❌ That's too long — it would be ${parts.length} messages (the limit is ${MAX_POST_PARTS}). Split it into a few posts.`);
  }

  const mention = ping === 'everyone' ? '@everyone' : ping === 'here' ? '@here' : role ? `<@&${role.id}>` : null;
  const allowedMentions = pingsEveryone ? { parse: ['everyone'] } : role ? { roles: [role.id] } : { parse: [] };
  const sent = [];
  try {
    if (!parts.length) {
      // Only a file (plus maybe a title): no box needed.
      const content = [mention, title && `**${title}**`].filter(Boolean).join('\n');
      sent.push(await channel.send({ content: content || undefined, files, allowedMentions }));
    } else {
      for (const [i, part] of parts.entries()) {
        const embed = new EmbedBuilder().setColor(colour).setDescription(part);
        if (i === 0 && title) embed.setTitle(title);
        if (parts.length > 1) embed.setFooter({ text: `Part ${i + 1} of ${parts.length}` });
        sent.push(
          await channel.send({
            content: i === 0 && mention ? mention : undefined,
            embeds: [embed],
            allowedMentions: i === 0 ? allowedMentions : { parse: [] },
          }),
        );
      }
      // Files go last, so they sit underneath the post instead of above it.
      if (files.length) sent.push(await channel.send({ files, allowedMentions: { parse: [] } }));
    }
  } catch (err) {
    const partial = sent.length ? ` (${sent.length} of ${parts.length} part(s) went up before it failed)` : '';
    return interaction.editReply(`❌ Couldn't post in ${channel}: ${err.message}${partial}`);
  }

  const many = sent.length > 1 ? ` as ${sent.length} messages` : '';
  return interaction.editReply(`✅ Posted in ${channel}${many}. [Jump to it](${sent[0].url})`);
}

// ----- /mute -----
async function muteCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  if (!settings.logChannelId) return ephemeral(interaction, '⚠️ Run `/setup` first so I know where to send the mod log.');
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');

  const user = interaction.options.getUser('user', true);
  const member = interaction.options.getMember('user');
  const problem = targetProblem(interaction, user, member);
  if (problem) return ephemeral(interaction, problem);
  if (await modGuard.blocked(interaction, 'mute', `<@${user.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.options.getString('reason', true);
  const result = await muteAndLog({ guild: interaction.guild, user, member, type: 'MANUAL', label: 'Manual mute', trigger: reason, moderator: interaction.user });
  await modGuard.logAction(interaction.guild, interaction.member, `🔇 muted ${who(user)} — ${truncate(reason, 300)} (case #${result.case.id}${result.timedOut ? '' : ', not timed out'})`);
  const where = result.logged && !modGuard.isLimitedMod(interaction.member) ? ` in <#${settings.logChannelId}>` : '';
  return interaction.editReply(
    result.timedOut
      ? `🔇 Muted ${user} for ${durationText()}.${modGuard.isLimitedMod(interaction.member) ? '' : ` Case #${result.case.id} is${where}.`}`
      : `${result.note}\nCase #${result.case.id} was still logged${where}.`,
  );
}

/**
 * Why a moderator can't delete (or Moderate) this message, or null. Nobody can touch the owner's, admins' or the
 * bot's messages through these. Moderators can delete each other's (in case one goes rogue) — it's all in #mod-watch —
 * but muting or restricting another moderator is for admins (the rank check stops it).
 */
function protectedMessageProblem(interaction, message, author) {
  if (!message.author || message.author.id === interaction.client.user.id) return '🚫 That’s one of my messages.';
  if (message.author.id === interaction.guild.ownerId || (author && modGuard.isAdmin(author))) return '🚫 You can’t delete the owner’s or an admin’s messages.';
  return null;
}

// ----- Right-click a message → Apps → Delete Message -----
// Moderators delete single messages through the bot (they don't have Discord's own Delete Message). Counted towards
// their limit and copied into #mod-watch.
async function deleteMessageMenu(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');
  const target = interaction.targetMessage;
  const author = target.member ?? (await guild.members.fetch(target.author.id).catch(() => null));
  const problem = protectedMessageProblem(interaction, target, author, settings);
  if (problem) return ephemeral(interaction, problem);
  if (target.pinned) return ephemeral(interaction, '🚫 That message is pinned — ask an admin.');
  if (await modGuard.blocked(interaction, 'delete', `<@${target.author.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = target.content || '';
  const files = [...(target.attachments?.values() ?? [])].map((a) => a.url);
  try {
    await target.delete();
  } catch (err) {
    if (err.code !== 10008) return interaction.editReply(`❌ Couldn’t delete it: ${truncate(err.message, 300)}`);
  }
  await modGuard.logAction(
    guild,
    interaction.member,
    `🗑️ deleted a message by ${who(target.author)} in <#${target.channelId}>:\n${codeBlock(text || '(no text)', 1200)}${files.length ? `\nFiles: ${truncate(files.join(' '), 400)}` : ''}`,
  );
  return interaction.editReply('🗑️ Deleted.');
}

// ----- Right-click a message → Apps → Moderate -----
// A panel only the moderator can see, under the message they picked: 🗑️ Delete, 🔇 Mute, 🚷 Restrict. Mute and
// Restrict ask for a reason first. Every action goes through the same checks and limits as the commands.

function reasonForm(customId, title, description) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(truncate(title, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Reason')
        .setDescription(truncate(description, 100))
        .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400)),
    );
}

function moderatePanel(message, { done = null, cases = 0 } = {}) {
  const ids = `${message.channelId}:${message.id}`;
  const embed = new EmbedBuilder()
    .setColor(done ? 0x22c55e : 0x5865f2)
    .setTitle(truncate(`🛡️ Moderate ${message.author.username}’s message`, 256))
    .setDescription(`in <#${message.channelId}>${cases ? ` · ${cases} past case${cases === 1 ? '' : 's'}` : ''}\n${codeBlock(message.content || '(no text)', 900)}${done ? `\n${done}` : ''}`);
  const button = (action, emoji, label, style) => new ButtonBuilder().setCustomId(`oj:mod-${action}:${ids}`).setEmoji(emoji).setLabel(label).setStyle(style).setDisabled(Boolean(done));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button('delete', '🗑️', 'Delete', ButtonStyle.Danger), button('mute', '🔇', 'Mute', ButtonStyle.Secondary), button('restrict', '🚷', 'Restrict', ButtonStyle.Secondary))],
  };
}

async function moderateMenu(interaction) {
  const settings = store.guild(interaction.guildId);
  if (!settings.logChannelId) return ephemeral(interaction, '⚠️ Run `/setup` first so I know where to send the mod log.');
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');
  const target = interaction.targetMessage;
  const member = target.member ?? (await interaction.guild.members.fetch(target.author.id).catch(() => null));
  const problem = protectedMessageProblem(interaction, target, member, settings);
  if (problem) return ephemeral(interaction, problem);
  const cases = store.casesForUser(interaction.guildId, target.author.id).length;
  return interaction.reply({ ...moderatePanel(target, { cases }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

/** The message a panel button or form is about, with who wrote it. Null if it's gone. */
async function panelMessage(guild, channelId, messageId) {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const message = await channel?.messages?.fetch(messageId).catch(() => null);
  if (!message) return null;
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  return { message, member };
}

/** 🗑️ / 🔇 / 🚷 on the panel. */
async function moderatePanelButton(interaction, action, channelId, messageId) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');
  const found = await panelMessage(guild, channelId, messageId);
  if (!found) return interaction.update({ content: 'ℹ️ That message is already gone.', embeds: [], components: [] }).catch(() => ephemeral(interaction, 'ℹ️ That message is already gone.'));
  const { message, member } = found;
  const problem = protectedMessageProblem(interaction, message, member, settings) ?? (action === 'delete' ? null : targetProblem(interaction, message.author, member, action === 'mute' ? 'mute' : 'restrict'));
  if (problem) return ephemeral(interaction, problem);

  if (action === 'mute') return interaction.showModal(reasonForm(`oj:mutemodal:${channelId}:${messageId}`, `Mute ${message.author.username}`, `Muted for ${durationText()}; the message is saved as proof and deleted`));
  if (action === 'restrict') return interaction.showModal(reasonForm(`oj:restrictmsgmodal:${channelId}:${messageId}`, `Restrict ${message.author.username}`, 'They’ll see this and can appeal; the message is saved as proof and deleted'));

  // 🗑️ Delete: straight away.
  if (message.pinned) return ephemeral(interaction, '🚫 That message is pinned — ask an admin.');
  if (await modGuard.blocked(interaction, 'delete', `<@${message.author.id}>`)) return null;
  const text = message.content || '';
  const files = [...(message.attachments?.values() ?? [])].map((a) => a.url);
  const gone = await message.delete().then(
    () => true,
    (err) => err.code === 10008,
  );
  if (!gone) return ephemeral(interaction, '❌ I couldn’t delete it.');
  await modGuard.logAction(guild, interaction.member, `🗑️ deleted a message by ${who(message.author)} in <#${channelId}>:\n${codeBlock(text || '(no text)', 1200)}${files.length ? `\nFiles: ${truncate(files.join(' '), 400)}` : ''}`);
  return interaction.update(moderatePanel(message, { done: '🗑️ **Deleted.**' })).catch(() => ephemeral(interaction, '🗑️ Deleted.'));
}

/** The Restrict form on the panel was sent. */
async function restrictMessageModal(interaction, channelId, messageId) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');
  const found = await panelMessage(guild, channelId, messageId);
  if (!found?.member) return ephemeral(interaction, '❌ That message (or its author) is gone. Use `/restrict` instead.');
  const { message, member } = found;
  const problem = protectedMessageProblem(interaction, message, member, settings) ?? targetProblem(interaction, message.author, member, 'restrict');
  if (problem) return ephemeral(interaction, problem);
  if (await modGuard.blocked(interaction, 'restrict', `<@${message.author.id}>`)) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const result = await restrict.restrictMember({ guild, member, moderator: interaction.user, reason, proof: { excerpt: messageText(message) || null, channelId } });
  if (result.ok) {
    await message.delete().catch(() => {});
    await modGuard.logAction(guild, interaction.member, `🚷 restricted ${who(message.author)} for a message in <#${channelId}> — ${truncate(reason, 300)}`);
  }
  return interaction.editReply(result.text);
}

async function muteMessageModal(interaction, channelId, messageId) {
  const settings = store.guild(interaction.guildId);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');
  if (await modGuard.blocked(interaction, 'mute')) return null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  const message = await channel?.messages?.fetch(messageId).catch(() => null);
  if (!message) {
    return interaction.editReply('❌ That message was already deleted, so there is nothing to save as proof. Use `/mute` instead.');
  }

  const member = await interaction.guild.members.fetch(message.author.id).catch(() => null);
  const problem = targetProblem(interaction, message.author, member) ?? protectedMessageProblem(interaction, message, member, settings);
  if (problem) return interaction.editReply(problem);

  const result = await muteAndLog({
    guild: interaction.guild,
    user: message.author,
    member,
    message,
    type: 'MANUAL',
    label: 'Manual mute',
    trigger: interaction.fields.getTextInputValue('reason'),
    moderator: interaction.user,
  });
  await modGuard.logAction(interaction.guild, interaction.member, `🔇 muted ${who(message.author)} for a message in <#${channelId}> — ${truncate(interaction.fields.getTextInputValue('reason'), 300)} (case #${result.case.id})`);
  return interaction.editReply(
    result.timedOut
      ? `🔇 Muted ${message.author} for ${durationText()}.${modGuard.isLimitedMod(interaction.member) ? '' : ` Their message is saved as proof (Case #${result.case.id}).`}`
      : `${result.note}\nThe message was still saved as proof (Case #${result.case.id}).`,
  );
}

// ----- /unmute -----
async function unmuteCommand(interaction) {
  const { guild } = interaction;
  const settings = store.guild(guild.id);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason');
  const problem = unmuteProblem(guild, user.id, interaction.user.id) ?? (await modGuard.unmuteModProblem(guild, interaction.member, user.id));
  if (problem) return ephemeral(interaction, problem);
  if (await modGuard.blocked(interaction, 'unmute', `<@${user.id}>`)) return null;
  const openCase = openMuteCase(guild.id, user.id);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await modGuard.logAction(guild, interaction.member, `🔊 unmuted ${who(user)}${reason ? ` — ${truncate(reason, 300)}` : ''}`);

  if (openCase) {
    const result = await unmuteCase(guild, openCase, interaction.user, reason ? `Reason: ${reason}` : null);
    return interaction.editReply(result.text);
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member?.isCommunicationDisabled()) return interaction.editReply(`ℹ️ ${user} isn't muted.`);
  try {
    await member.timeout(null, truncate(`Unmuted by ${interaction.user.tag}${reason ? `: ${reason}` : ''}`, 512));
    return interaction.editReply(`🔊 Unmuted ${user}.`);
  } catch (err) {
    return interaction.editReply(`❌ Couldn't unmute them: ${err.message}`);
  }
}

// ----- /history -----
async function historyCommand(interaction) {
  const settings = store.guild(interaction.guildId);
  if (!canModerate(interaction, settings)) return ephemeral(interaction, '🚫 Only moderators can use this.');

  const user = interaction.options.getUser('user', true);
  const cases = store.casesForUser(interaction.guildId, user.id);
  if (!cases.length) return ephemeral(interaction, `✨ ${user} has no cases.`);

  const status = { OPEN: '⏳ Open', KEPT: '🔒 Mute kept', UNMUTED: '🔊 Unmuted', BANNED: '🔨 Banned', RESTRICTED: '🚷 Restricted instead', UNRESTRICTED: '🔓 Unrestricted' };
  const lines = cases.slice(0, 15).map((c) => {
    const link = c.logMessageId ? ` — [view](${messageLink(interaction.guildId, c.logChannelId, c.logMessageId)})` : '';
    return `**#${c.id}** ${TYPES[c.type]?.emoji ?? ''} ${c.label} · ${status[c.status] ?? c.status} · ${ts(c.createdAt)}${link}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${user.tag} — ${cases.length} case(s)`, iconURL: user.displayAvatarURL() })
    .setDescription(truncate(lines.join('\n'), 4000));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ----- /update -----
// Only the owner of the bot application (Developer Portal) may install code — not just any server owner,
// since anyone can add the bot to a server of their own.
async function isBotOwner(interaction) {
  const app = await interaction.client.application.fetch().catch(() => null);
  const owner = app?.owner;
  if (!owner) return false;
  return owner.members ? owner.members.has(interaction.user.id) : owner.id === interaction.user.id;
}

async function updateCommand(interaction) {
  if (!(await isBotOwner(interaction))) {
    return ephemeral(interaction, '🚫 Only the owner of the O Jailbreak bot (the Discord account that created it in the Developer Portal) can install updates.');
  }
  if (updater.pendingUpdate()) {
    return ephemeral(interaction, '⏳ The last update is still starting up. Try again in a minute.');
  }
  const file = interaction.options.getAttachment('file', true);
  if (!file.name.toLowerCase().endsWith('.zip')) return ephemeral(interaction, '❌ Attach the **o-jailbreak-update.zip** file.');
  if (file.size > 10 * 1024 * 1024) return ephemeral(interaction, '❌ That file is far too big to be an O Jailbreak update.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const data = await download(file.url);
  if (!data) return ephemeral(interaction, "❌ I couldn't download that file from Discord. Try again in a moment.");

  let result;
  try {
    result = updater.installUpdate(updater.planUpdate(updater.readZip(data)), { by: interaction.user.id });
  } catch (err) {
    if (!(err instanceof updater.UpdateError)) console.error('[update]', err);
    return ephemeral(interaction, `❌ ${truncate(err instanceof updater.UpdateError ? err.message : `The update failed: ${err.message}`, 1900)}`);
  }
  if (result.upToDate) return ephemeral(interaction, `✅ Already up to date — this is v${result.version}.`);

  const lines = [`📦 **Installed v${result.toVersion}** (was v${result.fromVersion}) — ${result.replaced.length + result.added.length} file(s) changed.`];
  if (result.configReplaced) lines.push('⚙️ `config.js` was updated too. The previous one is saved as `config.backup.js`, in case you had changed it.');
  if (!process.env.OJ_SUPERVISED) {
    lines.push('🔁 Now press **Restart** on your hosting panel (or close and reopen start.bat) to switch to it.');
    return ephemeral(interaction, lines.join('\n'));
  }
  lines.push('🔁 Restarting now. I’ll DM you when I’m back online (about 15 seconds). If the new version won’t start, I’ll put this one back automatically.');
  await ephemeral(interaction, lines.join('\n'));

  console.log(`[update] v${result.toVersion} installed by ${interaction.user.tag}. Restarting...`);
  store.flush();
  verify.flushTokens();
  await exitCleanly(interaction.client, RESTART);
}

const handlers = {
  setup,
  settings: settingsCommand,
  exempt: exemptCommand,
  filter: filterCommand,
  antinuke: antinukeCommand,
  lockdown: lockdownCommand,
  'server-updating': serverUpdatingCommand,
  restrict: restrictCommand,
  unrestrict: unrestrictCommand,
  autorole: autoroleCommand,
  vip: vipCommand,
  invites: invitesCommand,
  giveaway: giveawayCommand,
  blockserver: blockserverCommand,
  blocklist: blocklistCommand,
  massban: massbanCommand,
  applyvip: vipApply.applyCommand,
  verify: verifyCommand,
  backup: backupCommand,
  verifybutton: verifyButtonCommand,
  welcome: welcomeCommand,
  rank: rankCommand,
  leaderboard: leaderboardCommand,
  levels: levelsCommand,
  banlist: banlistCommand,
  post: postCommand,
  mute: muteCommand,
  unmute: unmuteCommand,
  history: historyCommand,
  msgdelete: msgdeleteCommand,
  cleanup: cleanupCommand,
  applychat: (interaction) => require('./chatRequest').openForm(interaction, interaction.guildId),
  modcooldown: modcooldownCommand,
  modhide: modhideCommand,
  membercount: membercountCommand,
  access: access.command,
  update: updateCommand,
  Moderate: moderateMenu,
  'Delete Message': deleteMessageMenu,
};

async function runCommand(interaction) {
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  // Moderators only get the mod commands (and nothing while they're on cooldown).
  const problem = interaction.member ? modGuard.commandProblem(interaction) : null;
  if (problem) return ephemeral(interaction, problem);
  await handler(interaction);
}

module.exports = { BOT_PERMISSIONS, definitions, registerCommands, runCommand, muteMessageModal, moderatePanelButton, restrictMessageModal, cleanupModal };
