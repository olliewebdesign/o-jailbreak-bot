'use strict';

// config.js ships with every server-specific setting empty. The tests need example values (made-up IDs, an example
// owner name, an example blocked server), so every test file loads this first.

const config = require('../config');

Object.assign(config.promptHelp, { guideChannelId: '8000000000000000031', supportUserId: '100000000000000001', models: { opencode: '8000000000000000021', claude: '8000000000000000022', freebuff: '8000000000000000024', chatgpt: '8000000000000000025', deepseek: '8000000000000000026', muse: '8000000000000000027', grok: '8000000000000000023', nemotron: '8000000000000000028', mimo: '8000000000000000029', qwen: '8000000000000000030' } });
Object.assign(config.updating, { memberRoleIds: ['8000000000000000003', '8000000000000000032'], vipRoleId: '8000000000000000033', keepVisibleChannelIds: ['8000000000000000034', '8000000000000000035', '8000000000000000036'], vipChannelIds: ['8000000000000000037', '8000000000000000038', '8000000000000000039', '8000000000000000040'] });
Object.assign(config.verify, { contact: '<@100000000000000001>', visibleSections: ['8000000000000000041', '8000000000000000042'] });
Object.assign(config.blockedServers, { invites: ['VFQkDSb5rq', 'anonymouse'], names: ['anonymouse', 'анонимаус', 'анонимоус'] });
config.logs.channelId = '8000000000000000043';
Object.assign(config.accusations, { names: ['ellie', 'elly', 'elli', 'ell', 'ellfx'], namesRussian: ['элли', 'эллі', 'элл'] });
Object.assign(config.mods, { roleId: '8000000000000000020', hiddenChannelIds: ['8000000000000000044', '8000000000000000045'] });
Object.assign(config.nameWatch, { names: ['ellie', 'eliot', 'elly', 'elli', 'ellfx'], namesRussian: ['элли', 'элиот', 'эллі'], notifyUserIds: ['100000000000000001'] });
