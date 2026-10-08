# O Jailbreak

A Discord moderation + anti-nuke bot.

## Is the Verify button a scam?

No — and you don't have to take anyone's word for it: this is the bot's full source code.

When you press **Verify**, Discord's own page asks you to let the bot:

- **Access your username and avatar** — so it knows who you are.
- **Know what servers you're in** — to check you're not in a server that scams this community. The list is checked and then thrown away: only the result is kept (passed, or which blocked server you're in). While you're verified it's checked again every 30 seconds, so joining one later is caught too.
- **Join servers for you** — used for one thing only, `/backup`: if this server is ever deleted, the bot's owner can add everyone who verified to the new one.

What it **can't** do: see your password, email, DMs or messages, post as you, or change anything on your account — Discord never gives a bot any of that through this button. The bot only ever talks to Discord itself; no other website is sent anything.

You can undo it any time: Discord → **User Settings → Authorized Apps** → remove the bot. You're unverified straight away.

Check it yourself — all of it is in [`src/verify.js`](src/verify.js): `authorizeUrl` (exactly what's asked for), `finish` (the check), `scanOnce` (the 30-second re-check) and `pullMembers` (the backup).

## Running your own copy

1. Install [Node.js](https://nodejs.org) 18.17 or newer, then run `npm install`.
2. Copy `.env.example` to `.env` and put your bot token in it. **Never share or commit `.env`.**
3. Fill in the IDs in `config.js` for your server (Discord → Settings → Advanced → Developer Mode, then right-click → Copy ID). Anything left empty is simply switched off.
4. `npm start` (or `start.bat` on Windows). `npm test` runs the tests.

MIT licensed (see `LICENSE`). The rest of this README is the full guide.

- **Racial slurs** (and your own blocked words) → message deleted and a case sent to the mod log, **but no automatic mute**. Mods press **🔇 Mute** on the case if they want to
- **Self-promotion** → message deleted, **muted for 7 days**, and a case sent to the mod log with review buttons. Invites to your own server are always allowed. It catches:
  - invites to other servers, even disguised (`d1scord.gg/…`, `discord dot gg slash …`, `.gg/…`), server-list sites and Discord's own server-discovery pages
  - **other chat apps**: Telegram (`t.me/…`, `t . me / …`, `tg: @channel`), WhatsApp, Guilded, Revolt, Signal
  - **selling and "DM me for it"**: "selling jailbreaks", "dm me for working prompts", "i have a private jb hmu", "jailbreak for $5" (but not "anyone selling prompts?" or "selling prompts is scummy")
  - **the same in Russian**: "продаю промпты", "у меня есть рабочий джб, пишите в лс", "подписывайтесь на мой канал", "заходите на наш сервер", "тг: @канал"
  - shop and payment links (sellix, gumroad, whop, paypal.me, boosty…), bio links, "sub to my channel", channel/profile links
  - **fake Discord / Steam links** (`dlscord-nitro.com`, `steamcommunlty.com`, a Russian letter in "discord") → logged as **Scam link**
- **Names that advertise** (a display name or nickname like `discord.gg/abc` or `t.me/abc`) → their nickname in your server is changed to their plain username and the mod log is told. Checked when they join, when they change their name, and at startup. Part of the self-promotion filter.
- **Look-alike names** → someone joins (or changes their name) to something like **ellie** or **eliot** — the usual first step in pretending to be you. You get a **DM** with who it is (username, display name, ID, avatar, account age — flagged if it's new) and the mod log is told. Nothing is done to them. Disguises count (`3llie`, `e1lie`, `real_ellie`, `ellie.fx`, `Элли`); "Kellie", "Nellie" or "Eliza" don't. You, staff and bots are never reported. Names and who gets the DM: `nameWatch` in `config.js`. Turn it off with `/settings`.
- **Spam** (flooding, repeating the same message, mass pings, `@everyone` scam links) → message deleted, muted for 7 days, case in the mod log
- **Server logs** → in the logs channel (`logs.channelId` in `config.js`): 🗑️ deleted messages (what they said, even if Discord has forgotten them, and who deleted them when it was a mod or bot), ✏️ edits (before/after), and 🧹 bulk deletes (as a .txt file). The bot remembers the last day of messages in memory to do this (never saved to disk); messages from before it started up show without their text.
- **Leaking VIP content** → forwarding a message (Discord's Forward button) from a VIP-only channel into a channel ordinary members can see: the forward is deleted and they're **restricted** (“Leaking VIP content”, change it under `vipLeak` in `config.js`). They can appeal. VIP-only channels are worked out from permissions (the VIP role can see it, @everyone and the member roles can't) plus `vipChannelIds`. Forwards between VIP channels, into staff channels, and by staff are fine. Copy-paste, screenshots and forwards to DMs can't be detected.
- **Image scams** (the fake MrBeast giveaway screenshots) → **4 images in one message, or 4 in a row**, are deleted and the person gets a DM saying why. No mute. A normal text message in between, or 2 minutes passing, resets the count. Follows the spam filter's on/off and exemptions.
- **"The opencode prompt doesn't work" / "is grok patched?"** → an auto-reply: *"Please follow the How to use video step by step in #opencode"* (that jailbreak's channel). **"The jb doesn't work"** without saying which → *"Which one isn't working?"*, and their answer gets the right channel. Nobody is muted. Each reply at most once per channel every 10 minutes (per jailbreak). See *"Prompt doesn't work" → video guide* below.
- **Anti-nuke** → anyone who isn't trusted and starts deleting channels/roles, mass-banning, spamming webhooks or handing out Administrator has **all their roles removed and is timed out**, and the mods + owner get pinged
- **Server updating mode** → `/server-updating start` hides every channel from members except **#server-updating** (where you post updates) and the ones you choose to keep open. VIPs keep their VIP channels, and new joins see the same as members. `/server-updating finish` puts it all back.
- **Lockdown** → when a nuke or raid is caught, **every channel is hidden**, a locked channel with an **Alert the Owner** button appears, and the owner gets a DM with an **Unlock** button. Pause it while you're online, arm it when you're offline.
- **Restrict** → mods can't ban, but they can restrict someone: every channel is hidden except **#restricted**, and a private **appeal ticket** opens for them straight away (only they, you and Administrators can see it — not moderators).
- **Auto-role** → everyone who joins gets your Member role (and `/autorole sync` catches up anyone who missed it).
- **Staff watch** → moderators skip the filters so they can do their job, but a mod who floods the chat or fires off punishment after punishment is stopped and the owner is told.
- **Ban list** → a private **#ban-list** channel only admins can see: one line per ban with their Discord ID, the reason, and an **Unban** button that asks you to confirm.
- **Invite rewards** → bring 5 people into the server with your invite links and you can **apply** for the VIP role (`/vip goal` changes the number). An admin reviews every application and presses **Approve** or **Deny**. `/invites` shows exactly who anyone brought in.
- **Giveaways** → `/giveaway start` posts a giveaway people enter by reacting 🎉. A reaction counts for **VIPs**, or members who brought **2 new people** in with their invite links. 3 winners are drawn automatically when it ends.
- **Welcome channel** → everyone who joins gets a hello, with **whose invite link they used**.
- **Levels** → people earn XP for chatting, climb levels and get roles you choose. `/rank`, `/leaderboard`, and a live leaderboard you can park in its own channel.
- **It never bans anyone by itself.** Every case goes to your mod log channel with the **proof** (what they said, a text file with the chat around it, and copies of any images) and three buttons:
  **🔊 Unmute** · **🔨 Ban** · **🔒 Keep Muted**

Disguised slurs are caught too: `n1gg3r`, `n i g g e r`, fancy fonts, look-alike letters from other alphabets, emoji letters, invisible characters, spoilers, and words split in half.

---

## Setup (one time, about 10 minutes)

### 1. Create the bot on Discord
1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it **O Jailbreak**.
2. Open the **Bot** tab.
3. Scroll to **Privileged Gateway Intents** and turn on **both** **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT**. Click **Save Changes**.
4. Scroll up and click **Reset Token**, then **Copy**. This token is the bot's password — never share it.

### 2. Run the bot — pick ONE place

#### Option A: a bot hosting site (online 24/7) — Bot-Hosting.net and other panel hosts
1. Create a **Node.js** server. If it asks for a Node.js version, pick the newest one (it needs 18 or higher).
2. Open the **Files** tab and upload **`o-jailbreak.zip`**. Click the **⋮** next to it → **Unarchive**, then delete the zip.
   You should now see files like `index.js`, `config.js`, `.env` and a `src` folder. Don't upload a `node_modules` folder — the host installs that itself.
3. Click the **`.env`** file. Replace the words `paste-your-bot-token-here` with your token (keep `DISCORD_TOKEN=` in front of it), then click **Save Content**.
4. Open the **Startup** tab. The main file box (it may be called "Bot JS file" or "Main file") should say **`index.js`** — it usually already does.
5. Open **Console** and press **Start**. The first start installs packages (takes a minute). When you see **`✅ O Jailbreak is online`**, it's working, and the invite link is printed right under it.

To change settings later, edit `config.js` in the Files tab and press **Restart**.

#### Option B: your own PC (only online while your PC is on)
1. Install the **LTS** version of Node.js from <https://nodejs.org>.
2. Double-click **`start.bat`**. Notepad opens a file called `.env` — replace `paste-your-bot-token-here` with your token, save, close Notepad, and double-click **`start.bat`** again.
3. When you see **`✅ O Jailbreak is online`**, it's working. Leave that window open — closing it turns the bot off.

> ⚠️ Don't run it in both places at once. Two copies with the same token would both act on every message (double mutes, double logs).

### 3. Add it to your server
Copy the **invite link** from the console into your browser, pick your server, and click **Authorize**. Leave **Administrator** ticked — lockdown needs it to hide and restore every channel.

### 4. Move its role to the top ⚠️ important
**Server Settings → Roles** → drag **O Jailbreak** above every other role. It can't mute or stop anyone whose role is higher than its own, so this is what makes anti-nuke work.

### 5. Make a private mod log channel
Create a channel like `#mod-logs` that only your mods can see (make sure O Jailbreak can see it too).

### 6. Run setup in Discord
```
/setup log_channel:#mod-logs mod_role:@Moderators
```
`mod_role` is the role that can press Unmute / Ban / Keep Muted, and gets pinged for anti-nuke alerts.

### 7. Trust your admins (server owner only)
```
/antinuke trust user:@YourCoOwner
```
Trusted people are completely ignored by anti-nuke. Only trust people you'd hand the server to. Bots already in the server are trusted automatically when you run `/setup`.

### 8. Pin your lockdown control panel
After `/setup`, the owner gets a DM from O Jailbreak with **Arm / Pause** buttons. Pin it. Tap **Pause** while you're online and **Arm** before you go offline. (Lost it? `/lockdown panel` sends a new one.)

### 9. Auto-role, rewards and ban permissions
- Give new members your Member role: `/autorole set role:@Member` (then `/autorole sync` for people who are already here)
- Reward people who bring friends in: `/vip set role:@VIP`, and pick how many joins it takes: `/vip goal joins:5`
- Say hello to new members: `/welcome set channel:#welcome`
- Give the leaderboard a home: `/levels board channel:#leaderboard`, and roles for levels: `/levels reward level:5 role:@Regular`
- **Take "Ban Members" off your mod role** (Server Settings → Roles → your mod role). O Jailbreak only lets admins with Ban Members press Ban — moderators restrict people instead — but Discord's own ban option follows that permission too.

### 10. Optional
- Leave one channel completely alone (a spam/off-topic channel): `/exempt add filter:Everything channel:#spam` — no filters, no spam checks, no staff watch, no XP, nothing deleted
- Allow promo in one channel: `/exempt add filter:Self-promotion filter channel:#self-promo`
- Let a role advertise anywhere: `/exempt add filter:Self-promotion filter role:@Content Creator`
- Block extra words (like homophobic slurs): `/filter add word:...`

---

## What happens when someone breaks a rule

1. O Jailbreak saves the proof: their message, any images, and the last 15 messages in the channel.
2. It deletes the message and times them out for **7 days** (except slurs and blocked words: those are deleted and logged without a mute, and the case has a **🔇 Mute** button instead of Unmute).
3. It DMs them the reason, and posts a short note in the channel (it disappears after 10 seconds).
4. The case appears in your mod log with the proof, their account age, when they joined, their previous cases, and the buttons:
   - **🔊 Unmute** — removes the timeout (for anti-nuke cases it also gives their roles back — owner/trusted only)
   - **🚷 Restrict** — asks for a reason, then restricts them instead (see *Restrict & appeals* below)
   - **🔨 Ban (admins)** — only for admins with the Ban Members permission. Asks for a reason and how many hours of their messages to delete, then bans
   - **🔒 Keep Muted** — marks it as reviewed so other mods know it's handled

The log updates to show which mod handled it, and the buttons lock so two mods can't act on the same case. If nobody presses anything, the timeout just ends after 7 days.

**The owner and admins are ignored by the filters** (staff watch still catches them flooding the chat). **Moderators aren't** — and in case one goes rogue, a moderator who calls the owner a scammer, spams (past their lighter limit), self-promotes, posts a scam link or a slur is **restricted on the spot**: the message is deleted, every role comes off (saved — `/unrestrict` gives them all back) and **you're DMed straight away**. Tickets are left alone (mods quote people there). They're left out of the "prompt doesn't work" filter (they say that while helping people), the 4-images rule (screenshots) and the new-account / unverified locks. Only admins and the owner can unmute a moderator.

### New accounts can't chat for their first week

Discord accounts made **less than 7 days ago** can read everything and verify, but anything they post is deleted straight away. They're DMed (once a day, English + Russian) with the exact time they'll be able to chat, and their first try each day goes in the mod log with what they wrote.

If what they posted **breaks the rules** — calling the owner a scammer, a slur or blocked word, an advert or invite to another server, 4+ images, or @everyone with a link (the free-nitro scam) — they're **restricted** instead (with the message as proof on the case), and get an appeal ticket like anyone else.

**Asking to chat early:** the DM has a **📝 Ask to chat early** button (or they can use `/applychat`). They write why, and it goes to the mod log with **✅ Let them chat** / **❌ Deny** — only admins and the owner can press those. Let in = they can chat straight away; denied = they're told when they can chat anyway, and can ask again in 24 hours. They have to verify first, and can only have one request waiting.

Their **appeal ticket** and tickets from other ticket bots always work. To let a channel or role skip it: `/exempt add filter:New accounts`. Turn it off with `/settings module:New accounts enabled:False`. Change the 7 days in `config.js` → `newAccounts`.

### "The owner is a scammer"

Messages calling the owner a scammer are caught in English and Russian — the owner's name (`config.js` → `accusations`), their @mention, or "the owner", a few words before *scammer, scam, fraud, thief, liar, мошенник, скам, кидала, обманщик, вор…* Disguised spellings are caught too (`sc4mm3r`, `s c a m m e r`, Russian letters mixed into English words).

- **New account:** restricted (see above).
- **Anyone else:** deleted and logged for the mods, not muted. The case has **🔇 Mute**, **🚷 Restrict**, **🔨 Ban** and **No action** buttons.

Left alone: people reporting a scammer to you ("ellie there's a scammer in general", "ellie can you ban the scammer"), "ellie **isn't** a scammer", "ellie **got** scammed", "anti-scam", "anons owner is a scammer", the words far apart, and anything in a ticket (so people can still complain to the staff). Turn it off with `/settings module:“Ellie is a scammer” filter enabled:False`.

**Want a free-for-all channel?** `/exempt add filter:Everything channel:#your-channel` makes O Jailbreak ignore it completely: nothing there is filtered, deleted, punished or worth XP, and it doesn't count towards anyone's spam limit. `/exempt remove` with the same options turns moderation back on, and `/exempt list` shows which channels are free.

### "Prompt doesn't work" → video guide

An **auto-reply** — nobody is deleted or muted:

- **A jailbreak is named** — "opencode prompt not working", "claude doesnt work", "is grok patched?", "cant get qwen to work", "клод не работает" — the bot replies: *"Please follow the How to use video step by step in #opencode"* (that jailbreak's channel; two named → both channels).
- **None is named** — "the jb doesn't work", "prompt not working" — it asks *"Which one isn't working?"*. Their next message naming one (within 5 minutes), or anyone's reply to that question, gets the right channel. Said inside one of the jailbreaks' own channels, that's the one they mean.
- Each reply goes out **at most once per channel every 10 minutes, per jailbreak**, so a busy chat isn't spammed (a different jailbreak still gets its answer). Edits don't trigger it.

Jailbreaks it knows (and their channels): opencode, claude, freebuff, chatgpt ("gpt", "chat gpt"), deepseek, muse, grok, nemotron, mimo, qwen — Russian spellings too. Add or change them under `promptHelp → models` in `config.js`, with the reply wording (`modelReply`, `whichReply`) and the 10 minutes (`replyCooldownMinutes`).

- Let your helpers say it (e.g. "if it doesn't work, watch the video"): `/exempt add filter:“Prompt doesn’t work” → video guide role:@Helper`
- Turn it off or on: `/settings module:“Prompt doesn’t work” → video guide enabled:false`

---

## Commands

| Command | Who | What it does |
|---|---|---|
| `/setup` | Manage Server | Set the mod log channel and mod role. After the first time, only the owner or trusted users can change it. |
| `/settings` | Manage Server | Show settings, or turn a module on/off. Only the owner can turn anti-nuke off. |
| `/exempt add` / `remove` / `list` | Manage Server | Let a channel, category or role skip a filter. Pick **Everything** with a channel to leave that channel completely unmoderated. |
| `/filter add` / `remove` / `list` | Manage Server | Block your own words. `remove` also turns off a built-in word if it causes false alarms in your server. |
| `/antinuke trust` / `untrust` / `list` | Owner | Who anti-nuke ignores. Trusted people (not moderators) also count as admins: they see #mod-watch and can use the admin buttons. |
| `/access [user]` | Admins / owner | **Who can see what.** With a user: every private channel they can see and *why* — Administrator through a role, a role that's let into the channel, or a permission given to them personally — with the staff channels marked ⚠️, and a 🧹 button to take their personal access away. Without: who has Administrator or Manage Server, who's on the trusted list, and which roles or people are let into the staff channels without being admins. |
| `/membercount on` / `off` | Admins / owner | **Member counter**: two locked voice channels at the top of the server — **👥 Members: 5,231** (people, not bots) and **📈 Last 24h: +105** (joined minus left in the last 24 hours; 📉 when it's down). Everyone can see them (even people who haven't verified), nobody can join them. They update every 10 minutes — Discord only allows renaming a channel twice in 10 minutes. If one is deleted it's made again; drag them wherever you like. |
| `/lockdown lock` | Admins | Hide every channel right now (e.g. during a raid). |
| `/lockdown unlock` | Owner / trusted | Put every channel back exactly how it was. |
| `/lockdown panel` | Owner / trusted | DM yourself the Arm / Pause buttons. |
| `/lockdown arm` / `pause` | Owner / trusted | Turn auto-lockdown on, or pause it (for a few hours or until you arm it). |
| `/lockdown status` | Mods | Armed, paused, or locked? |
| `/server-updating start` | Owner / trusted / admins | Hide the server from members while you rework it (takes seconds). |
| `/server-updating finish` | Owner / trusted / admins | Show the server again, exactly as you left it. |
| `/server-updating keep-visible` | Owner / trusted / admins | Let members still see a channel while updating (run again to hide it). |
| `/post channel file` | Admins | Post as the bot. Upload a **.txt file** and any length of writing is posted as neat boxes marked *Part 1 of 3* etc. Other files (PDFs, pictures…) are attached. Files are posted underneath the boxes, so the writing comes first. Options: `title`, `ping`, `ping_role`, `colour`, `attach_file` (also attach the .txt so people can download it). You can only ping and post where you're allowed to yourself. |
| `/massban ids [reason] [delete_hours]` | Owner only | Paste a list of user IDs (any format, up to 200) and they are all banned at once, even people who aren’t in the server, so they can never join. Never bans the owner, you, the bot or trusted users. Logged in the mod log. |
| `/verify setup` / `split` / `status` / `off` | Manage Server | Verification: verifying unlocks the new jailbreaks and checks people aren’t in a blocked server. See *Verification* below. |
| `/verify require-all enabled` | Owner only | **True:** everyone who hasn't verified — existing members too — only sees #✅︱verify until they do (their roles are saved and come back when they verify). **False:** back to new members only. See *Everyone must verify* below. |
| `/verifybutton [channel] [text] [title] [ping] [ping_role]` | Manage Server | Post an announcement with a **✅ Verify** button, to tell members to verify. Leave `text` empty for the ready-made English + Russian one; type `\n` for a new line in your own. |
| `/backup pull` / `status` | Bot owner | If something happens to the server: run it in your new server to add everyone who verified. See *Backup server* below. |
| `/blocklist add [ids] [file]` / `remove` / `list` | Owner only | User IDs of known members of a blocked server. Anyone on it who's in the server is restricted (“Please make a ticket”) straight away, and anyone on it who joins later is restricted the moment they join. Paste IDs in any format, or attach a .txt file for long lists. Staff and trusted users are never restricted. |
| `/blockserver add invite` / `remove` / `list` | Manage Server | Servers whose members are restricted (“Please make a ticket”): anyone who verifies while in one, anyone verified who joins one later (checked every 30 seconds), anyone wearing its tag, and anyone posting its invite. The servers in `blockedServers` in `config.js` are always blocked. |
| `/blockserver addname name` / `removename` | Manage Server | **Blocked names**: anyone whose username, display name or nickname contains one is restricted straight away (“Please make a ticket”) — when they join, rename, chat, and every 30 seconds for everyone already in the server. Disguises count (`an0nym0use`, `ANONYMOUSE`, Russian look-alike letters, fancy fonts, `anon.ymouse`, `a n o n y m o u s e`); plain “Anonymous” doesn't. **badserver** is always blocked (`blockedServers.names` in `config.js`). At least 5 letters, so a short name can't catch everyone. Staff are never restricted. |
| `/restrict user reason` | Mods | Hide every channel from them except #restricted, and open their appeal ticket. Their roles are saved. Mods: max 4 in 5 minutes. |
| `/unrestrict user` | Admins / owner | Give them their channels and roles back (and close any open appeal). Moderators can't. |
| `/autorole set role` / `off` / `sync` | Manage Server | Give a role to everyone who joins. `sync` gives it to anyone missing it right now. Roles with mod/admin powers are refused. |
| `/vip set role` / `goal` / `off` / `status` | Manage Server | The role for bringing people in, how many joins it takes, and the invite leaderboard (`/invites user:` looks up one person). |
| `/vip review [channel]` | Manage Server | Where VIP applications go (leave empty for the mod log). Only admins (Administrator) and the owner can press Approve / Deny. |
| `/applyvip` | Everyone | Apply for VIP once you've brought in enough people. |
| `/vip revoke user amount [reason]` | Manage Server | Take joins off someone's count (e.g. they cheated). Lowers their VIP count **and** their joins in running giveaways. If that takes them below the goal, **VIP is taken off them**. Noted in the mod log. |
| `/invites` | Everyone | Your own invites: who you brought in, which didn't count, and your progress in running giveaways. Staff can add `user:` to look up anyone. |
| `/giveaway start prize duration` | Manage Server | Start a giveaway (e.g. `duration:1d`). Options: `winners` (default 3), `joins` (default 2), `channel`. |
| `/giveaway end` / `reroll` / `list` | Manage Server | End one early and draw the winners, draw someone new, or see what's running and who's entered. |
| `/welcome set channel` / `off` / `test` | Manage Server | Welcome new members in a channel, showing whose invite link they used. |
| `/rank [user]` | Everyone | Level, XP, progress bar and place on the leaderboard. |
| `/leaderboard` | Everyone | The top chatters, posted wherever you type it. |
| `/levels on` / `off` / `reward` / `rewards` / `board` / `style` / `announce` / `set` | Manage Server | XP on or off, roles at levels, a live leaderboard in its own channel, how it looks, where level-ups are announced, or fix someone's level. |
| `/banlist setup` / `sync` | Ban Members | Make the ban list channel, or add everyone who is already banned. |
| `/mute user reason` | Mods | Mute someone for 7 days and log it with review buttons. Mods: max 6 in 5 minutes. |
| **Right-click a message → Apps → Moderate** | Mods | A panel only you can see, with that message and **🗑️ Delete**, **🔇 Mute** and **🚷 Restrict** buttons. Delete is instant; Mute and Restrict ask for a reason, save the message as proof and delete it. Same limits and logging as the commands. |
| **Right-click a message → Apps → Delete Message** | Mods | Delete one message through the bot (mods don't have Discord's own Delete Message). Copied into #mod-watch. Never the owner's or admins' messages (mods can delete each other's, in case one goes rogue). Mods: max 15 in 5 minutes. |
| `/unmute user` | Mods | Unmute someone and close their open case. (If they break the rules again, the filters mute them again as normal.) |
| `/msgdelete user amount [reason]` | Mods | Delete up to 100 of that person's recent messages in the channel. Never the owner's, admins', the bot's or pinned ones (other mods' are fine, in case one goes rogue). The deleted messages go to #mod-watch as a file. Mods: max 5 in 5 minutes. |
| `/cleanup` | Mods | **Spam from lots of people at once**: opens a popup with the **latest 15 messages** in the channel — who sent each, what it says, how long ago. Tick the spam (as many as you like), add a reason if you want, press **Submit**: those are deleted. The owner's, admins', the bot's and pinned messages are never listed (and checked again when deleting). Every deleted message goes to #mod-watch as a file. Mods: 4 times in 5 minutes. |
| `/modhide add` / `remove` / `list` | Owner / trusted | Channels (or whole sections) moderators can't see, on top of the logs and #mod-watch. |
| `/modcooldown lift user` / `list` | Owner / trusted | Give a moderator on cooldown their powers back, or see who's on cooldown. |
| `/history user` | Admins | Someone's past cases with links to each log. |
| `/update file` | Bot owner | Install a new version from an **o-jailbreak-update.zip** — see *Updating* below. |

---

## Anti-nuke

Anyone who is **not** the owner or on the trusted list gets stopped if they:

| Does this | Within 30 seconds |
|---|---|
| Deletes channels | 3 |
| Deletes roles | 3 |
| Creates webhooks | 3 (the webhooks are deleted too) |
| Bans / kicks people | 5 |
| Creates channels / roles, deletes emojis | 6 |
| Prunes members, gives a role **Administrator**, gives **@everyone** dangerous permissions, changes the vanity invite link | 1 (instantly) — permission changes are undone |

When that happens, all their roles are removed, they're timed out for 7 days, and your mod role + the owner are pinged in the mod log. If it was a mistake, the owner presses **Unmute + Give Roles Back**.

Bots added by someone who isn't trusted are **kicked** right away (nuke bots usually get in this way). If a mod is fixing a raid and bans lots of people fast, they could set off anti-nuke — trust your head mods, or raise the limits in `config.js`.

---

## Lockdown

**When it locks by itself** (only while it's armed):
- Anti-nuke catches someone, or
- 5 different people are caught by the filters within 60 seconds (a raid). Slurs count even though they aren't muted; “the prompt doesn't work” doesn't.

Mods can also lock the server any time with `/lockdown lock`.

**What happens:**
1. Every channel's permissions are saved first, then every channel is hidden from members. Admins still see everything, the mod log stays as it was, and staff channels your mod role could already see stay visible to mods.
2. A channel called `🔒-server-locked` appears for everyone, explaining what's going on, with an **🚨 Alert the Owner** button (it can be pressed once every 2 minutes).
3. The owner gets a DM with a **🔓 Unlock Server** button, and the mod log gets pinged.

**Unlocking** (owner or trusted only — the DM button, the button in the locked channel, or `/lockdown unlock`) puts every channel back exactly how it was and removes the locked channel. Even if the bot restarts during a lockdown, it still remembers how to put everything back.

**Paused?** Nukes are still stopped and logged, but channels aren't hidden. The owner gets a DM with a **🔒 Lock Server Now** button instead.

---

## Server updating mode

For when you're reworking the server and don't want members watching channels appear, move and disappear.

**`/server-updating start`** makes a **#🔧︱server-updating** channel at the top and hides every other channel from members. It changes each channel once rather than each member, so it takes seconds, and people who join while it's on see the same as members.

**What people can see while it's on:**
- **Everyone:** #server-updating (read-only), plus the channels in `keepVisibleChannelIds` in `config.js`, used as normal (for example chat and the community channel). Add more without editing the file: `/server-updating keep-visible channel:#…`. Run it again to take one off. Picking a thread keeps its whole channel visible.
- **VIPs:** also the channels in `vipChannelIds`, and any channel their role is specifically let into.
- **Mods and admins:** everything they could see before. Your mod role can post in #server-updating, so use it for updates and announcements while you work.

Hidden channels are hidden from @everyone and the roles in `memberRoleIds` (and your auto-role). A channel that some other role is specifically let into (VIP, Booster, a level reward) stays open to that role.

While it's on you can change anything. New channels are hidden automatically, and so is any channel whose permissions get reset (for example by a setup tool).

**`/server-updating finish`** puts back exactly the view settings it changed on each channel. Everything else you changed is kept, and nothing is rolled back. #server-updating is hidden again (mods can still see it) and gets reused next time.

If the bot restarts while updating mode is on, it carries on and hides any channel made while it was off. Change the channel name, first message, roles or channel lists in the `updating` section of `config.js`.

## Verification

Verifying unlocks the **new** jailbreaks, and checks people aren't in a blocked server (`/blockserver`).

| Who | Sees |
|---|---|
| **Existing members** who haven't verified | The whole server and the **old** jailbreaks. Under the old jailbreaks there's a message (English + Russian) with a **✅ Verify** button explaining how to get the new ones. (With `/verify require-all` on, they're treated like new members.) |
| **New members** (joined after `/verify setup`) who haven't verified | Only **#✅︱verify** (English + Russian: how to verify) and the two sections in `verify.visibleSections` in `config.js` (VIP-only channels in them stay VIP-only). **They can't chat**: anything they type is deleted and they're DMed *"Please verify to message in the Discord. You will also get access to the jailbreak prompts. If you have any issues or questions please message @you"* (once a day). They hold only the Unverified role; their other roles (and the member role) come when they verify. |
| **Anyone with no roles at all** (just joined, still on the rules screen, roles taken off) | The same as new members: only #✅︱verify and the two sections, and they can't chat until they verify. |
| **Verified** | Everything, including the **new** jailbreaks. The old ones and #✅︱verify disappear. |

**VIP channels are hidden from @everyone**, not just the member role, so nobody without roles can see them even for a moment. At startup and every 10 minutes the bot checks the VIP channels (`updating.vipChannelIds` in `config.js`, plus any channel the VIP role is let into while the member role is blocked) and fixes any that were only hidden from the member role. VIPs and bots keep access, and the mod log says what changed. It waits while a lockdown or server-updating is on.

**Verifying:** press **✅ Verify** → **Authorize** on Discord's own page. Discord asks for two things: *know what servers you're in* (the blocked-server check) and *join servers for you* (the backup server, below).
- In a blocked server → **restricted** with the reason **“Please make a ticket”**. They can open a ticket from #restricted.
- Otherwise → the **Verified** role.

**Every 30 seconds** the bot checks every verified person's server list again, so someone who joins a blocked server later is restricted too. Only the result is kept, never anyone's server list, and the bot can't see messages or DMs. The logins are kept in `data/verify-tokens.json` (never in the mod log). Anyone who removes O Jailbreak under *Settings → Authorized Apps* is unverified again (a Discord hiccup never unverifies anyone). `/verify status` shows when the last check ran.

**VIPs have to verify too** (some were in blocked servers). **VIPs who pressed Verify themselves keep VIP** (there's a record of them passing, from any version). Every other VIP — including the ones older versions gave Verified for free (marked as free since v1.12.0, and with no record at all in v1.11.2) — has **VIP paused**, and loses the free Verified too: the VIP role is saved and taken off (so the VIP channels are hidden; they keep the member role), and they get the **VIP — verify** role, which only shows **#💎︱vip-verify**: *"VIPs need to verify now — your VIP isn't gone, it comes back the moment you verify… Any issues? DM @you"* (English + Russian) with a **Verify** button. Each paused VIP is also **DMed once** (English + Russian: VIP isn't gone, verify in #💎︱vip-verify — with a button to it — any issues, DM @you), one DM every 3 seconds so Discord doesn't take the bot for a spammer (`verify.vipDmSeconds`); the mod log says how many were sent and how many have DMs closed. Verifying gives VIP straight back; anyone in a blocked server is restricted instead. Someone given VIP later who hasn't verified is paused the same way. Staff are never paused. Once every paused VIP has verified (or left), the channel and its role are deleted. `/vip revoke` on a paused VIP means they don't get it back; turning verification off gives everyone paused their VIP back. Anyone holding the VIP role has verified — and their saved login means `/backup` can add them too.

**Setting it up on Bot-Hosting.net (one time):**
1. **Your web address.** On the panel, open **Network** and note your server's **IP and port** (like `123.45.67.89:25565`).
2. **`.env`.** On the **Files** tab, open `.env` and add two lines (updates never touch this file):
   ```
   DISCORD_CLIENT_SECRET=paste-the-secret-here
   VERIFY_URL=http://123.45.67.89:25565
   ```
   The secret is in the Developer Portal → your app → **OAuth2** → **Client Secret** (press **Reset Secret** if it's hidden). Keep it private, like the token.
3. **Developer Portal → OAuth2 → Redirects → Add Redirect**: `http://123.45.67.89:25565/callback` (your IP and port) → **Save Changes**.
4. Press **Restart** on the panel, then run **`/verify setup`** in Discord. It makes the **Unverified** and **Verified** roles and **#✅︱verify**, and pauses VIP for VIPs who haven't verified.
5. Run **`/verify split section:<your jailbreaks category>`**. It makes an empty copy of the category for the new jailbreaks, hides both from new members, and posts the Verify message under the old jailbreaks. Then post the updated jailbreaks in the copy.
6. Test it with an alt account. `/verify status` shows whether everything is working.

To tell everyone, post an announcement with a Verify button: `/verifybutton channel:#announcements ping:@everyone`.

**Appeals from members of a blocked server:** in the appeal ticket of someone restricted for being in a blocked server, the bot posts that server's icon and tells them (English + Russian) *“You are restricted because you are in the … server. Please leave that Discord to be a part of our community”*, then to wait patiently for the team to review and confirm. Ordinary appeals don't get this.

**🔄 Recheck** (under that message): they or an admin press it to see if they're **still in the server**. If they've let the bot see their server list (a saved login), it checks straight away; people caught when they verified had theirs thrown away, so when *they* press it they get a one-time link to let the bot look again (an admin pressing it is told to ask them). It also checks their profile for the server's tag and a blocked name. The result is posted in the ticket for both to see — e.g. *❌ Still in badserver* or *✅ Not in badserver any more — looks like they've left, an admin can press 🔓 Unrestrict*. Once every 30 seconds at most. Tickets opened before this version get the button when the bot starts. **The bot can't see anything inside the other server** (its messages or members) — Discord only ever tells it which servers someone is in.

`/verify off` stops giving new members Unverified (new members who hadn't verified then see what existing members see).

### Everyone must verify (`/verify require-all`)

Two jailbreak sections get confusing, so when you're ready: **`/verify require-all enabled:True`** (server owner only).

- **Everyone who hasn't verified** — existing members too — only sees **#✅︱verify** until they verify. Its message changes to *“Verify to use the server”*.
- Their roles (Member, level roles…) are **saved** and come straight back when they verify. It works like Restricted, because in Discord a role that's *allowed* into a channel beats one that's *blocked*, so they can't keep the Member role while they wait.
- **Staff, people who already verified, bots and restricted people** aren't affected (VIPs have to verify too — see above). New members land in the same place.
- On a big server it takes a while to get through everyone (Discord only lets bots change so many members at a time). The mod log says when it starts and when it's done.
- Then **nobody but staff sees the old jailbreaks any more, so you can delete the old section**, leaving just one.
- **Let someone in by hand:** give them the **Verified** role (they get their roles back).
- **A channel people should see before verifying** (like #rules): allow the **Unverified** role on it in Discord, and the bot leaves it alone.
- Roles given to someone who hasn't verified (by a mod or another bot) are taken back off and saved for when they verify.
- It refuses to turn on while verification isn't working (no Client Secret, web page not running), so nobody gets locked out with no way back in.
- **Undo:** `/verify require-all enabled:False`. Everyone gets their roles back and the server opens up again; only new members have to verify, like before.

**About the split:** Discord lets a role that's *allowed* into a channel beat one that's *blocked*, so for verified people to stop seeing the old section it's opened through @everyone instead of your Member role (the same people still see it). VIP-only channels stay VIP-only in the copy. If another role is let into old channels by its own permission, `/verify split` tells you so you can take it off.

## Backup server

If something ever happens to the server, the bot can add **everyone who verified** to a new one:

1. Make the new server and add O Jailbreak to it (the same invite link as before, with Administrator).
2. In the **new** server, run **`/backup status`** to see how many people can be added, then **`/backup pull`**.
3. It adds them one by one, updates its reply as it goes, and DMs you the result.

Only **the bot's owner** (the account that created it in the Developer Portal) can use `/backup`. It never adds people who left your server on purpose (while it still exists), restricted people, or anyone who removed the bot under *Authorized Apps*. People who never verified can't be added — Discord only allows it with their permission. If the old server is gone completely, add `from_server_id:` with its ID if you want only its members.

## Restrict & appeals

Moderators can't ban. Instead they **restrict** — with `/restrict`, the 🚷 Restrict button on a mute case, or by simply **giving someone the Restricted role** in Discord (taking the role off unrestricts them):

1. When you run `/setup` (and every time the bot starts), O Jailbreak makes sure there's a **Restricted** role and a **#restricted** channel, and hides every channel from the Restricted role (new channels get hidden automatically too). If it can't, it tells you how to fix it in the mod log.
2. The person's roles are saved and removed, and they get the Restricted role. Any timeout is lifted so they can type in an appeal.
3. A private **appeal ticket** opens for them **straight away** (in an *Appeals* category), and they're pinged in it and DMed a link. Only they, you and **Administrators** can see it — **not moderators, Manage Server roles or trusted users**, and nobody is pinged but them. Anyone else let into an appeal (by hand, or by an older version) loses it at start-up and within 10 minutes. The ticket has two buttons (admins and the owner only):
   - **🔓 Unrestrict** — gives them their roles back and closes the ticket
   - **🔒 Close appeal** — they stay restricted and can appeal again after 24 hours
   Every closed ticket's chat is saved to the mod log as a text file. Discord allows 50 channels in a category, so when *Appeals* is full the bot makes *Appeals 2*, *Appeals 3*…
4. Apart from their ticket they can only see **#restricted**. They can't type there — they see *"You have been restricted by one of our moderation team…"* and a **📩 Open an appeal ticket** button, for a new ticket once one is closed (or if the automatic one couldn't be made).
5. Leaving and rejoining doesn't get them out of it — and if they had an appeal open, they can see it again when they come back.
   Banning someone with an open appeal closes the ticket as **Banned** (the chat is saved to the mod log).
6. **They can't pick up other roles while restricted.** If they earn VIP from invites or a level reward, it's saved and given to them when they're unrestricted. If anyone (a mod, another bot) gives them a role, O Jailbreak takes it straight back off, saves it, and says so in the mod log. Otherwise a role like VIP would let them see the VIP channels again.

Want restricted people to still see a channel (like #rules)? Edit that channel's permissions and give the **Restricted** role a green tick on **View Channel** — O Jailbreak leaves it alone after that.

Admins, the owner, and people ranked above the moderator can't be restricted (if someone gives them the role anyway, the bot takes it back off and says why in the mod log). Appeal tickets from before v1.29.0 let the mod role, Manage Server roles or trusted users in — on start-up the bot takes that away.

---

## Moderators

Moderators (the role in `mods.roleId` in `config.js`) can **only** use `/mute`, `/unmute`, `/restrict`, `/msgdelete`, `/cleanup` and right-click → **Moderate** / **Delete Message**. Everything else is refused, and **everything they do goes through the bot**. They **can't**:
- unrestrict or unban anyone, or see or close appeal tickets (admins and the owner only). **Someone with the mod role is always a moderator** unless they have Administrator: Manage Server through another role, or being on the trusted list, doesn't make them an admin.
- see the mod log, the message logs, #ban-list, **#mod-watch**, the **Appeals** categories, or any channel added with **`/modhide add`** (owner only; `/modhide list` shows them all). The mod role is blocked from them **and so is each moderator personally**, so another role they have (like a shared Staff role) can't let them back in. Someone who stops being a mod has their personal blocks taken off. **Nobody but admins keeps personal access to a staff channel either**: if a regular member (or a mod) has been given it by name, the bot takes it away and says so in the mod log (checked at start-up and every 10 minutes). Access through a *role* is left alone, as you may have set that up on purpose — `/access` shows it.
- delete the owner's or admins' messages (they **can** delete each other's, in case one goes rogue — it all shows in #mod-watch), or mute / restrict another moderator (admins only)
- use Discord's own Timeout, Delete Message, Pin, Ban or Kick, add bots, or change channels, roles or server settings: the bot takes **every moderation permission** off the mod role, whoever adds it (it says so in #mod-watch). It gives the role **Priority Speaker** instead — a harmless voice permission that's only there because Discord shows a command to people with a certain permission, and that's the one the mod commands use. (Admins with Administrator see them too.) The same powers are taken off the mod role (and any moderator personally) in **each channel's own settings** too, straight away when someone changes them.
- **add bots or make webhooks.** The mod role never has Manage Server or Manage Webhooks. If a moderator gets one through another role and uses it anyway, the bot is kicked / the webhook deleted straight away, it's posted in #mod-watch and you're DMed (`/access user:@them` shows which role gave it). Anti-nuke never trusts a moderator either, even one on the trusted list.

**#mod-watch** (made by the bot; only you and admins can see it — **mods are never told they're logged**: nothing they can see mentions #mod-watch, the owner being told, or the exact limits) shows everything moderators do: mutes, unmutes, restricts, `/msgdelete` and `/cleanup` (with the deleted messages as a file) and **Delete Message** (with the message). If a moderator somehow still has Discord's own powers through another role, the bot warns you there, and any timeouts or deletes they do with them are logged and counted too.

**Doing too much at once** — more than **4 restricts**, **6 mutes**, **5 `/msgdelete`s** or **4 `/cleanup`s in 5 minutes** (timeouts in Discord itself count as mutes): that action isn't done, and they're put **on cooldown**:
- their mod role comes off and their mod commands are blocked
- **@everyone** is pinged in #mod-watch — only you and admins can see it, so only you and admins are pinged — with a list of what they did, and you're DMed
- it stays like that **until you lift it**: the **✅ Lift cooldown** button, or `/modcooldown lift user:@them`

**Rogue moderators:** a moderator who calls the owner a scammer, spams (past their lighter limit — twice a member's), self-promotes, posts a scam link or a slur is **restricted straight away**: message deleted, **every role taken off** (saved, including the mod role — `/unrestrict` gives them all back), and **you're DMed** with what they posted. It's also in #mod-watch and the mod log. Tickets are left alone (mods quote people there); outside them, a mod pasting another server's invite or a scam link — even as a warning — counts as self-promo. Only admins and the owner can unmute a moderator. Change the numbers under `mods` in `config.js`.

---

## Staff watch (rogue moderators)

Moderators, admins and anyone with **Manage Messages** or **Timeout Members** are ignored by the filters — they need to quote what someone said and post links. Staff watch is the safety net for a mod who goes rogue, or whose account gets hacked:

| What a mod does | What happens |
|---|---|
| Floods the chat or mass-pings (twice what a member is allowed) | The messages are deleted, they get a DM telling them to slow down, and the owner is pinged in the mod log and DMed |
| Does it again within an hour | They're **timed out for 30 minutes** with a case in the mod log (with an **Unmute** button), and the owner is told |
| Punishes more than 6 people in 10 minutes | The rest of their punishments are **refused** until they slow down, and the owner is told. For a real raid, `/lockdown lock` is the tool |
| Deletes channels/roles, mass-bans, hands out Administrator | Anti-nuke strips their roles and times them out (see above) |

The **server owner** and anyone on the `/antinuke trust` list are never watched. All the numbers live under `staffGuard` in `config.js`.

---

## Ban list

`/setup` makes a private **#ban-list** channel that only admins (and anyone who can ban) can see. Every ban — whether O Jailbreak did it or you banned someone in Discord yourself — adds one line:

> 🔨 **someone** `123456789012345678` • **Scam links** • banned by @you · 2 minutes ago — with an **Unban** button on the right.

Pressing **Unban** asks *"Unban them?"* first, and only unbans after you press **Yes, unban them**. The line is then crossed out and the button goes grey, so the list stays a complete history. Unbans done in Discord itself get crossed out too.

Already had people banned before adding O Jailbreak? Run `/banlist sync` to list them.

---

## Invite rewards (VIP)

Pick the reward role once:

```
/vip set role:@VIP
```

After that, O Jailbreak works out which invite link each new member used and counts it for whoever made that link. When someone reaches **5 people**, they **don't** get the role straight away. Instead:

1. They get a DM with an **🌟 Apply for VIP** button (or they can type `/applyvip` in the server).
2. Their application is posted in your review channel (`/vip review channel:#vip-applications`, or the mod log if you haven't picked one), showing **everyone they brought in** with each account's age, which ones counted, and who has **left** since. It also shows their invite count, joins staff took off, account age and past cases.
3. An admin (Administrator) or the owner presses **✅ Approve**, which gives them VIP and DMs them, or **❌ Deny**, which asks for an optional reason and DMs them. Moderators without Administrator can't press either.
4. Someone who's denied can apply again after 24 hours.

```
/vip goal joins:5
```

changes how many joins it takes, without touching any files. Raising it never takes the role off anyone who already has it; lowering it DMs everyone who now qualifies so they can apply.

- `/invites` lists everyone you brought in, and your progress in any running giveaway. Members only see their own; staff can use `/invites user:@someone` to check a claim — and it shows who invited *them*.
- Caught someone cheating? `/vip revoke user:@them amount:3 reason:alts` takes 3 joins off their count. It counts for VIP **and** any running giveaway (their newest giveaway joins go first), and it's logged in the mod log. If that takes them below the VIP goal, **VIP is taken off them** (and they're DMed). They can apply again once they're back at the goal.
- `/vip status` shows the leaderboard, or one person's total and who they invited.
- **Accounts under 30 days old don't count towards VIP** (or giveaways), so nobody can farm it with throwaways. They still show up in `/invites`, crossed out, so you can see what happened. Change it with `vip.minAccountAgeDays` in `config.js`.
- Bots and people who invite themselves never count, and someone who leaves and rejoins only ever counts once.
- **7 days in the server before applying.** Reaching the goal isn't enough on its own: they can only apply once they've been in the server for **7 days** (so nobody can join, invite a crowd, grab VIP and leave with the prompts). They're still DMed when they reach the goal, with the date they can apply from. Leaving and rejoining starts the 7 days again. Change it with `vip.minDaysInServer` in `config.js`.
- **People have to verify.** While verification is on (`/verify setup`), someone who joins through an invite only counts — for VIP and giveaways — once they've **verified**. Until then they show in `/invites` as *⏳ hasn't verified yet*. People who never verify never count.
- **People have to stay.** Anyone who leaves within **24 hours** of joining comes back off their inviter's count (they show crossed out in `/invites`). Change it with `vip.mustStayHours` in `config.js`. If that takes someone who was **approved** for VIP below the goal, VIP comes off them (a VIP you gave out by hand is never taken away automatically). In a running giveaway, leaving at *any* point before the end stops them counting.
- **Your server's own custom link** (the `discord.gg/yourname` one that boost level 3 unlocks) belongs to the server, not to a person, so joins through it count for nobody. O Jailbreak recognises them: the welcome message says *"Joined with the server's own link"*, and `/invites user:@them` says the same. Everyone's personal invite links keep working exactly as before.

---

## Giveaways

```
/giveaway start prize:Discord Nitro duration:3d
```

posts a short giveaway message (the prize, how many winners, when it ends) and reacts 🎉 to it. People enter by reacting 🎉. Explain the rules in your own words. It runs for 3 days and draws **3 winners** (`winners:` changes that).

**Whose reaction counts** (checked when the winners are drawn):
- **VIPs**: always.
- **Members** who brought **2 new people** into the server with their own invite links (`joins:` changes the number). They get a DM when the second one joins, reminding them to react.
  - Only joins **after the giveaway started** count. Invites from before don't use up anything.
  - The people they invite need accounts **at least 30 days old**, and someone who has been in the server before doesn't count.
  - **If someone they invited leaves before the end, that join stops counting** (and they're DMed if that takes them under 2). Anyone who left while the bot was offline is caught when the winners are drawn.
  - These joins count towards VIP too, as normal.

Anyone else can react, but they can't win.

When time is up, the winners are picked at random, pinged under the giveaway, and noted in the mod log. Even if the bot was off when it was meant to end, it draws them as soon as it's back.

- `/giveaway list`: what's running. `/giveaway list id:1` shows who has reacted to #1, who qualifies, and who's still short.
- `/giveaway end`: end the newest one now (or `id:` for a particular one).
- `/giveaway reroll`: draw a new winner if one doesn't claim the prize (`winners:` for more than one).

Restricted members can't enter. The VIP role is the one from `/vip set` (or `updating.vipRoleId` in `config.js`).

---

## Welcome channel

```
/welcome set channel:#welcome
```

Everyone who joins gets a message there with their avatar, and underneath:

- 📨 **Invited by** whoever's invite link they used — or *"Joined with the server's own link"* for your `discord.gg/yourname` link, or *"I couldn't tell which link they used"* for a link made before O Jailbreak arrived — and a note when that join doesn't count towards VIP
- 👥 which member number they are
- 🗓️ how old their Discord account is

Only the new member is pinged. If your server makes people accept rules first, they're welcomed once they've accepted — and never twice. `/welcome test` posts one for you to look at, `/welcome off` stops it, and the wording (`{user}`, `{name}`, `{server}`, `{count}`, `{inviter}`) lives under `welcome` in `config.js`.

---

## Levels

Everyone earns **15–25 XP** per message, at most once a minute, and climbs the usual Discord curve (level 5 is about an hour of chatting, level 10 a few days). It's on from the start.

- `/rank` — their level, a progress bar, total XP and their place in the server
- `/leaderboard` — the top chatters, posted wherever you type it
- `/levels board channel:#leaderboard` — gives the leaderboard a **home**: one message in that channel that the bot keeps up to date by itself as people chat (at most once a minute). Pin it. Run `/levels board` with no channel to stop.
- `/levels style title:🔥 {server} legends colour:Pink size:15 show_xp:False` — your own title (`{server}` becomes the server name), colour, how many people to show, and whether XP numbers appear. It changes the live board *and* `/leaderboard`. Run `/levels style` on its own to see the current look.
- `/levels reward level:5 role:@Regular` — the role is given the moment someone reaches level 5, and rewards stack
- `/levels announce channel:#general` — always announce there, or leave the channel out to announce wherever they were chatting (`enabled:False` turns announcements off)
- `/levels set user:@someone level:10` — fix someone's level by hand

No XP for bots, for a message that broke a rule, or in a channel you've told O Jailbreak to ignore. Change the XP per message under `levels` in `config.js`.

---

## Auto-role

`/autorole set role:@Member` gives that role to everyone who joins. `/autorole sync` gives it to everyone who is missing it right now (people who joined while the bot was offline). If your server makes new people accept the rules first, they get it right after accepting. Bots and restricted people don't get it. O Jailbreak refuses roles with moderator or admin permissions.

---

## Updating

**The easy way** (O Jailbreak v1.1.0 or newer):
1. Download the new **o-jailbreak-update.zip**.
2. In your server, type `/update` and attach the zip. Only the bot's owner — the Discord account that created it in the Developer Portal — can do this.
3. O Jailbreak installs it, restarts itself, and DMs you when it's back online (about 15 seconds). If the new version won't start, it automatically puts the old one back and DMs you what went wrong.

Your token (`.env`) and your settings and cases (`data/`) are never touched. `/settings` shows which version is running.

**The manual way:** on your host's **Files** tab, upload **o-jailbreak-update.zip** → **⋮** → **Unarchive** (replace the old files) → delete the zip → **Restart**. Use the *update* zip, not `o-jailbreak.zip` — that one contains a blank `.env` and you'd have to paste your token in again.

## Changing settings

Open **`config.js`** (in Notepad, or the Files tab on your host). You can change the mute length, turn off the DM or channel note, and tune the spam and anti-nuke limits. Save it and restart the bot.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No bot token found" | Paste the token into `.env` (step 2). |
| "Discord says the bot token is wrong" | Developer Portal → Bot → **Reset Token**, paste the new one into `.env`. |
| "an intent is switched off" | Developer Portal → Bot → turn on **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** → Save → restart the bot. |
| New people don't get the Member role | Check `/settings` — if **Auto-role** says *Off*, run `/autorole set role:@Member`. Then `/autorole sync` gives it to everyone who missed it. O Jailbreak's role must be above the Member role. |
| Nobody is getting VIP for invites | `/vip set role:@VIP` chooses the role and `/vip goal joins:5` sets the target. O Jailbreak needs **Manage Server** (Administrator covers it) to read invite links. Joins from accounts under 30 days old, people who leave within 24 hours, people who've been in the server before, and joins through the server's own `discord.gg/yourname` link never count. Reaching the goal DMs them an **Apply** button — an admin then approves it. |
| A mod got timed out by mistake | Press **🔊 Unmute** on their case in the mod log. Raise `staffGuard.spamAllowance` in `config.js`, or trust them with `/antinuke trust` so staff watch ignores them. |
| Mods can't see `/mute`, `/restrict` etc. | Discord only shows those to people with **Timeout Members** (and `/post` to **Manage Messages**). Give your mod role those permissions in Server Settings → Roles. |
| Slash commands don't show up | Press **Ctrl+R** in Discord. Make sure you invited the bot with the link from the console. Every time it starts, O Jailbreak switches on **Use Application Commands** for @everyone and your member roles (`memberRoleIds` in `config.js`), and posts in the mod log if anything else is hiding its commands from members (like Server Settings → Integrations → O Jailbreak). |
| Someone wasn't muted | Their role is above O Jailbreak's (step 4), or they're staff. |
| A normal word got flagged | `/filter remove word:thatword`, then unmute them with the button. |
| "the mod log channel is missing" | Run `/setup` again. Until then, bad messages are only deleted (no mutes). |
| Host says "Cannot find module" | The files ended up inside a folder. Open that folder, select everything, choose **Move**, type `..`, then press **Restart**. |
| Host console says "needs Node.js 18.17 or newer" (or "Unexpected token") | Startup tab → set **Docker Image** to the newest Node.js → **Restart**. |
| No **Restricted** role, or restricting does nothing | O Jailbreak needs **Administrator** and its role at the top (Server Settings → Roles). Then press **Restart** on your host (or run `/setup` again) and it makes the role and #restricted. |
| Someone posted an invite and nothing happened | Staff are ignored by automod — test with an account that has no mod roles. Invites to your own server are allowed on purpose. |
| An update says it "wouldn't start" and went back | Run `/update` again — it works on the second go. Then press **Restart** on your host once so the newest launcher is the one running, and it stops happening. |
| `/update` says only the bot owner can use it | It has to be the Discord account that created the bot in the Developer Portal. Anyone else can use the manual way (see *Updating*). |
| Every rule break gets two cases / two DMs | The bot is running in two places. Close `start.bat` on your PC. |

Cases and settings are saved in `data/database.json`.
