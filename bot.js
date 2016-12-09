const Bot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const util = require('util');
const config = require('./config.json');
const logger = require('./lib/logger');
const NodeCache = require('node-cache');

let bot;
if (process.env.NODE_ENV === 'production') {
    bot = new Bot(process.env.TOKEN, { polling: true });
} else {
    bot = new Bot(config.telegram.botToken, { polling: true });
}

/*
 * Set up node cache
 */
const cache = new NodeCache({ stdTTL: 4800, checkperiod: 180 });

/*
 * Postgres connection pool settings
 */

const Pool = require('pg').Pool;
const url = require('url');

const params = url.parse(process.env.DATABASE_URL);
const auth = params.auth.split(':');
const herokuPgConfig = {
    user: auth[0],
    password: auth[1],
    host: params.hostname,
    port: params.port,
    database: params.pathname.split('/')[1],
    ssl: true
};
const pool = new Pool(herokuPgConfig);
let botId;
bot.getMe()
    .then((msg) => {
        botId = msg.id;
        logger.info('%s bot server started...', msg.username);
    })
    .catch((err) => {
        throw new Error(err);
    });

bot.onText(/^\/echo (.+)$/, (msg, match) => {
    const name = match[1];
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `Hello ${name} !`);
});

bot.onText(/^\/start$/, (msg) => {
    const username = msg.from.username;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title;
    if (isGroupChatType(chatType) && isAdmin(username)) {
        isChatIdExist(chatId).then((isExist) => {
            if (isExist) {
                throw new Error('Auto-Drop game is already starting!');
            } else {
                return pool.query('INSERT INTO chatgroup(chat_id, chat_title) values($1, $2)', [chatId, chatTitle]).then(() => {
                    logger.debug('Insert chat_id: %s, chat_title: %s success', chatId, chatTitle);
                    submitDropScheduleFromDB(chatId);
                }).catch((err) => {
                    logger.error('Insert chat_id: %s, chat_title: %s error', chatId, chatTitle);
                    logger.error('Insert error: ', err.message, err.stack);
                    throw new Error('could not connect to db, try again.');
                });
            }
        }).then(() => {
            logger.info('Admin: %s start drop game in chat id %s', username, chatId);
            const response = [`OK ${username} !`];
            response.push('Now start auto-drop game in this chat :)');
            bot.sendMessage(chatId, response.join('\n'), {
                parse_mod: 'Markdown',
                selective: 2
            });
        }).catch((err) => {
            replyWithError(chatId, err);
        });
    }
});

bot.onText(/^\/pin$/, (msg) => {
    const username = msg.from.username;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const response = util.format(config.drop.pinnedMsg.join('\n'), '\u{2757} \u{2757} \u{2757}', '\u{2757} \u{2757} \u{2757}');
    if (isGroupChatType(chatType) && isAdmin(username)) {
        isChatIdExist(chatId)
        .then((isExist) => {
            if (isExist) {
                return bot.sendMessage(chatId, response, {
                    parse_mode: 'Markdown',
                    selective: 2
                });
            }
        }).catch((err) => {
            logger.warn('send pinned msg to chat_id: %s error', chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^\/link https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)$/, (msg, match) => {
    const chatId = msg.chat.id;
    const link = match[0].split(/\s+/)[1];
    pool.query('UPDATE chatgroup SET link = $1 where chat_id = $2', [link, chatId])
    .then(() => bot.sendMessage(chatId, 'done!'))
    .catch(() => bot.sendMessage(chatId, 'set link failed, try again.'));
});

bot.onText(/^(@[\w.]+)$/, (msg, match) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const account = match[0];
    if (isGroupChatType(chatType)) {
        isChatIdExist(chatId)
        .then((isExist) => {
            const state = cache.get('state' + chatId);
            const accountArr = cache.get('account' + chatId);
            const userArr = cache.get('user' + chatId);
            let response = config.drop.dropSuccessMsg;
            if (isExist) {
                if (state === 'DROP') {
                    if (accountArr === undefined) {
                        cache.set('account' + chatId, [userId + account]);
                        cache.set('user' + chatId, [userId + account + '@' + username]);
                        logger.debug('not found account cache, create new one with account: ' + cache.get('account' + chatId));
                    } else if (!accountArr.some(elem => (elem === (userId + account)))) {
                        cache.set('account' + chatId, accountArr.concat(userId + account));
                        cache.set('user' + chatId, userArr.concat(userId + account + '@' + username));
                        logger.debug('add account: %s to account cache, now it has: %s', userId + account, cache.get('account' + chatId));
                    } else {
                        response = config.drop.dropExistMsg;
                        logger.debug('account already exists in accout cache');
                    }
                } else {
                    response = config.drop.dropWrongTimeMsg;
                }
                return bot.sendMessage(chatId, response);
            }
        }).catch((err) => {
            logger.warn('get drop account from chat_id: %s error', chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^\/remove$/, (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    if (isGroupChatType(chatType)) {
        isChatIdExist(chatId)
        .then((isExist) => {
            const state = cache.get('state' + chatId);
            if (isExist && state === 'DROP') {
                let userArr = cache.get('user' + chatId);
                let accountArr = cache.get('account' + chatId);
                accountArr = accountArr.filter((elem) => {
                    const elemSplit = elem.split('@');
                    const userIdCache = elemSplit.splice(0, 1);
                    if (userIdCache === userId) {
                        logger.debug('remove chatId: %s, username: %s from account cache success', chatId, username);
                        return false;
                    }
                    return true;
                });
                logger.debug('account cache now has %s', accountArr);
                cache.set('account' + chatId, accountArr);
                userArr = userArr.filter((elem) => {
                    const elemSplit = elem.split('@');
                    const userIdCache = elemSplit.splice(0, 1);
                    if (userIdCache === userId) {
                        logger.debug('remove chatId: %s, username: %s from user cache success', chatId, username);
                        return false;
                    }
                    return true;
                });
                logger.debug('user cache now has %s', userArr);
                cache.set('user' + chatId, userArr);
            }
        });
    }
});

bot.onText(/^D (@[\w.]+)$/, (msg, match) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const account = match[1];
    if (isGroupChatType(chatType)) {
        isChatIdExist(chatId)
        .then((isExist) => {
            const state = cache.get('state' + chatId);
            let response = util.format(config.drop.doneSuccessMsg, account);
            if (isExist) {
                if (state === 'LIKE') {
                    const userArr = cache.get('user' + chatId);
                    const userIdT = userId + account + '@' + username;
                    logger.debug('new done user: %s, user cache: %s', userIdT, userArr);
                    if (userArr !== undefined && userArr.some(elem => (elem === userIdT))) {
                        const userArrF = userArr.filter(elem => (elem !== userIdT));
                        cache.set('user' + chatId, userArrF);
                        logger.debug('remove userId: %s, username: %s, account: %s, now it has %s', userId, username, account, userArrF);
                    } else {
                        response = config.drop.doneFailMsg;
                    }
                } else {
                    response = config.drop.doneWrongTimeMsg;
                }
                return bot.sendMessage(chatId, response);
            }
        }).catch((err) => {
            logger.warn('get done account from chat_id: %s error', chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^\/stop$/, (msg) => {
    const username = msg.from.username;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title;
    logger.debug('before ' + cache.get('schedule' + chatId));

    if (isGroupChatType(chatType) && isAdmin(username)) {
        isChatIdExist(chatId).then((isExist) => {
            if (!isExist) {
                throw new Error('Auto-Drop game is not starting!');
            } else {
                return pool.query('DELETE FROM chatgroup where chat_id = $1', [chatId]).then(() => {
                    logger.debug('delete chat_id: %s, chat_title: %s success', chatId, chatTitle);
                }).catch((err) => {
                    logger.error('Delete chat_id: %s, chat_title: %s error', chatId, chatTitle);
                    logger.error('Delete error: ', err.message, err.stack);
                    throw new Error('could not connect to db!, try again.');
                });
            }
        })
        .then(cancelScheduleJob(chatId))
        .then(() => {
            logger.info('user: %s stop drop game in chat id: %s', username, chatId);
            const response = ['OK ' + username + '!'];
            response.push('Now stop auto-drop game in this chat :)');
            bot.sendMessage(chatId, response.join('\n'), {
                parse_mode: 'Markdown',
                selective: 2
            });
            cache.del(chatId);
        })
        .catch((err) => {
            replyWithError(chatId, err);
        });
    }
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    if (isGroupChatType(chatType)) {
        isChatIdExist(chatId).then((isExist) => {
            if (isExist) {
                if (msg.new_chat_member !== undefined) {
                    const username = msg.new_chat_member.username || msg.new_chat_member.first_name;
                    const response = util.format(config.drop.newMemberMsg.join('\n'), username);
                    return bot.sendMessage(chatId, response);
                }
                if (msg.left_chat_member !== undefined) {
                    if (msg.left_chat_member.id === botId) {
                        return pool.query('DELETE FROM chatgroup where chat_id = $1', [chatId])
                        .then(
                            () => pool.query('DELETE FROM chatuser where chat_id = $1', [chatId])
                            .catch((err) => {
                                logger.warn('delete chatuser table because bot left chat_id: %s error', chatId, err.message, err.stack);
                                throw new Error('delete chatuser failed');
                            })
                        )
                        .then(cancelScheduleJob(chatId))
                        .catch((err) => {
                            logger.warn('delete chatgroup table because bot left chat_id: %s error', chatId, err.message, err.stack);
                        });
                    }
                    const userId = msg.left_chat_member.id;
                    return pool.query('DELETE FROM chatuser where chat_id = $1 and user_id = $2', [chatId, userId]).catch((err) => {
                        logger.warn('delete user_id: %s chat_id: %s left member from db error', userId, chatId, err.message, err.stack);
                    });
                }
            }
        }).catch((err) => {
            logger.warn('get new/left member from chat_id: %s error', chatId, err.message, err.stack);
        });
    }
});

function replyWithError(chatId, err) {
    logger.warn('chat id: %s, message: %s', chatId, err.message);
    bot.sendMessage(chatId, 'Oops! ' + err, {
        parse_mode: 'Markdown',
        reply_markup: {
            hide_keyboard: true
        }
    });
}

function isAdmin(username) {
    if (config.bot.adminUserName === username) {
        return true;
    }
    return false;
}

function isGroupChatType(chatType) {
    if (chatType === 'group' || chatType === 'supergroup') {
        return true;
    }
    return false;
}

const delay = min => chatId => new Promise(
    (resolve) => { setTimeout(() => resolve(chatId), min * 60 * 1000); });

const isChatIdExist = chatId => new Promise((resolve) => {
    if (cache.get(chatId)) {
        resolve(true);
    } else {
        resolve(pool.query('SELECT * FROM chatgroup where chat_id = $1', [chatId]).then((res) => {
            if (res.rowCount > 0) {
                cache.set(chatId, true);
                return true;
            }
            return false;
        }).catch((err) => {
            logger.error('Query chat id %s from postgres error', chatId);
            logger.error('query error', err.message, err.stack);
            throw new Error('Could not connect to db, try again.');
        }));
    }
});


const cancelScheduleJob = chatId => () => {
    const scheduleJobArr = cache.get('schedule' + chatId);
    logger.debug('delete schedule job in chat_id: %s', chatId);
    return Promise.all(scheduleJobArr.map(scheduleJob => scheduleJob.cancel()))
    .then(() => cache.del('schedule' + chatId))
    .catch((err) => { throw new Error('cancel schedule job in chat_id: %s failed', chatId); });
};

const submitDropScheduleFromDB = (chatIdQueryParam) => {
    let queryStatement = 'SELECT chat_id, drop_hour_array FROM chatgroup';
    if (chatIdQueryParam !== undefined) {
        queryStatement = queryStatement + ' WHERE chat_id = ' + chatIdQueryParam;
    }
    pool.query(queryStatement)
    .then((res) => {
        if (res.rowCount > 0) {
            return Promise.all(res.rows.map(row => {
                const chatId = row.chat_id;
                const dropTimeArr = row.drop_hour_array.replace(/{|}/g, '').split(',');
                const dropScheduleTimeArr = dropTimeArr.map((dbTime) => {
                    const date = new Date('2016/01/01 ' + dbTime);
                    date.setMinutes(date.getMinutes() + config.drop.timeOffset);
                    return { hour: date.getHours(), minute: date.getMinutes() };
                });
                const dropScheduleJobArr = dropScheduleTimeArr.map((dropTime) => {
                    return schedule.scheduleJob(dropTime, () => getScheduleJobPromise(chatId));
                });
                cache.set('schedule' + chatId, dropScheduleJobArr, 0);
                cache.set('state' + chatId, config.drop.state.idle, 0);
                cache.set(chatId, true, 0);
                logger.debug('schedule time wit chat_id', { 'chatId': chatId, 'dropScheduleTime': dropScheduleTimeArr});
            }));
        }
        throw new Error('no starting group.');
    }).catch((err) => {
        logger.warn('load stored time schedule error', err.message, err.stack);
    });
};

submitDropScheduleFromDB();

function getScheduleJobPromise(chatId) {
    let link = '';
    return Promise.resolve(chatId)
    .then((chatId) => pool.query('SELECT link FROM chatgroup where chat_id = $1', [chatId])
        .then((res) => {
            link = res.rows[0].link;
        })
        .then(() => chatId)
    )
    .then((chatId) => {
        // Round start msg
        const response = util.format(config.drop.roundStartMsg.join('\n'), config.drop.roundStartPeriodMin, link);
        bot.sendMessage(chatId, response);
        logger.debug('send round start msg to chat_id: %s', chatId);
        return chatId;
    })
    .then(delay(config.drop.roundStartPeriodMin))
    .then((chatId) => {
        // Drop start msg
        const response = util.format(config.drop.dropStartMsg.join('\n'), '\u{1f4b0} \u{1f4b0} \u{1f4b0} \u{1f4b0}', config.drop.dropPeriodMin, link);
        bot.sendMessage(chatId, response);
        logger.debug('send drop start msg to chat_id: %s', chatId);
        const oldState = cache.get('state' + chatId);
        const newState = config.drop.state.drop;
        cache.set('state' + chatId, newState, 0);
        logger.debug('change chat_id: %s state from %s to %s', chatId, oldState, newState);
        return chatId;
    })
    .then(delay(config.drop.remindPeriodMin))
    .then((chatId) => {
        // Remind drop msg
        const response = util.format(config.drop.remindMsg.join('\n'), '\u{2757} \u{2757} \u{2757} \u{2757}', '\u{1f4b0} \u{1f4b0} \u{1f4b0} \u{1f4b0}', link, link, link);
        bot.sendMessage(chatId, response);
        logger.debug('send remind drop msg to chat_id: %s', chatId);
        return chatId;
    })
    .then(delay(config.drop.dropPeriodMin - config.drop.remindPeriodMin))
    .then((chatId) => {
        // Drop stop msg
        let accountArr = cache.get('account' + chatId);
        if (accountArr === undefined) {
            bot.sendMessage(chatId, 'No one join this round! Skip!');
            throw new Error('no one join, skip this round');
        }
        accountArr = accountArr.map((elem) => {
            const elemSplit = elem.split('@');
            const account = elemSplit[1];
            return account;
        });
        logger.debug('account receive: ' + accountArr);
        const defaultAccountArr = config.drop.defaultAccount;
        const mergeAccountArr = mergeArray(accountArr, defaultAccountArr);
        logger.debug('merge account: ' + mergeAccountArr);
        const accountListResponse = [];
        while (mergeAccountArr.length) {
            accountListResponse.push(mergeAccountArr.splice(0, config.drop.accountListLength).join('\n'));
        }
        const response1 = util.format(config.drop.dropStopMsg1.join('\n'), config.drop.likePeriodMin);
        const response2 = config.drop.dropStopMsg2.join('\n');
        bot.sendMessage(chatId, response1)
        .then(() => bot.sendMessage(chatId, response2))
        .then(() => Promise.all(accountListResponse.map((accountListStr) => {
            logger.debug('send list %s to chat_id: %s', accountListStr.replace(/\n/g, ','), chatId);
            return bot.sendMessage(chatId, accountListStr);
        }))
        );
        logger.debug('send drop stop msg to chat_id: %s', chatId);
        const oldState = cache.get('state' + chatId);
        const newState = config.drop.state.like;
        cache.set('state' + chatId, newState, 0);
        cache.del('account' + chatId);
        logger.debug('change chat_id: %s state from %s to %s', chatId, oldState, newState);
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 1
        const userArr = cache.get('user' + chatId);
        if (userArr !== undefined && userArr.length > 0) {
            // get username with account from cache
            const userNameArr = userArr.map((elem) => {
                const elemSplit = elem.split('@');
                const userId = elemSplit.splice(0, 1);
                const account = elemSplit.splice(0, 1);
                const username = elemSplit.join('@');
                return username + ' with @' + account;
            }).join('\n');
            const response = config.drop.warnMsg.concat(userNameArr);
            bot.sendMessage(chatId, response.join('\n'));
            logger.debug('send warn msg1 to chat_id: %s', chatId);
        }
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin2 - config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 2
        const userArr = cache.get('user' + chatId);
        if (userArr !== undefined && userArr.length > 0) {
            // get username with account from cache
            const userNameArr = userArr.map((elem) => {
                const elemSplit = elem.split('@');
                const userId = elemSplit.splice(0, 1);
                const account = elemSplit.splice(0, 1);
                const username = elemSplit.join('@');
                return username + ' with @' + account;
            }).join('\n');
            const response = config.drop.warnMsg.concat(userNameArr);
            bot.sendMessage(chatId, response.join('\n'));
            logger.debug('send warn msg2 to chat_id: %s', chatId);
        }
        return chatId;
    })
    .then(delay(config.drop.likePeriodMin - config.drop.warnPeriodMin2))
    .then((chatId) => {
        // Drop stop msg
        const response = util.format(config.drop.roundStopMsg.join('\n'), link);
        bot.sendMessage(chatId, response);
        logger.debug('send round stop msg to chat_id: %s', chatId);
        const oldState = cache.get('state' + chatId);
        const newState = config.drop.state.idle;
        cache.set('state' + chatId, newState, 0);
        logger.debug('change chat_id: %s state from %s to %s', chatId, oldState, newState);
        return chatId;
    })
    .then((chatId) => {
        // Send warn msg
        // get username with account from cache
        const userArr = cache.get('user' + chatId);
        if (userArr !== undefined && userArr.length > 0) {
            // one user may have duplicate undone account, but we only calculate once.
            const mergeMap = userArr.reduce((pv, cv) => {
                const elemSplit = cv.split('@');
                const userId = elemSplit.splice(0, 1).toString();
                const account = elemSplit.splice(0, 1).toString();
                const username = elemSplit.join('@');
                pv.hasOwnProperty(userId) ? pv[userId].warnStatus += 1 : pv[userId] = { 'username': username, 'warnStatus': 1 };
                return pv;
            }, {});

            return Promise.all(Object.keys(mergeMap).map((key) => {
                const userId = key;
                const username = mergeMap[key].username;
                const warnStatus = mergeMap[key].warnStatus;
                return pool.query('INSERT INTO chatuser(chatuser_id, chat_id, user_id, username, warn_status) \
                 values($1, $2, $3, $4, $5) ON CONFLICT (chatuser_id) \
                 DO UPDATE SET warn_status = chatuser.warn_status + $5', [chatId + userId, chatId, userId, username, warnStatus])
                 .then(() => logger.debug('insert not done user %s to db success', [chatId + userId, chatId, userId, username, warnStatus]))
                 .catch(err => logger.warn('insert chat_id: %s not done user to db error', chatId, err.message, err.stack))
                 .then(() => pool.query('SELECT warn_status from chatuser where chat_id = $1 and user_id = $2', [chatId, userId]))
                 .then((res) => {
                     const warnStatusDB = res.rows[0].warn_status;
                     const warnResponse = 'user: ' + username + ' has been warned (' + warnStatusDB + '/3)';
                     const banResponse = 'user: ' + username + ' got banned!';
                     if (warnStatus >= 3) {
                         return bot.sendMessage(chatId, warnResponse)
                         .then(() => bot.sendMessage(chatId, banResponse))
                         .then(() => bot.kickChatMember(chatId, userId))
                         .then(() => {
                             logger.log('username: %s, user_id: %s in chat_id: %s is banned', username, userId, chatId);
                         })
                         .catch(() => bot.sendMessage(chatId, 'Not enough rights to kick chat member'));
                     }
                     return bot.sendMessage(chatId, warnResponse);
                 })
                 .catch((err) => {
                     logger.warn('send user_id: %s in chat_id: %s warn msg error', chatId, err.message, err.stack);
                 });
            }));
        }
    })
    .then(chatId => cache.del('user' + chatId))
    .catch((err) => {
        const oldState = cache.get(`state${chatId}`);
        const newState = config.drop.state.idle;
        cache.set('state' + chatId, newState, 0);
        logger.debug('change chat_id: %s state from %s to %s', chatId, oldState, newState);
        if (err.message !== 'no one join, skip this round') {
            logger.warn('schedule msg to chat_id: %s error', chatId, err.message, err.stack);
        }
    });
}

function mergeArray(arr1, arr2) {
    arr2.forEach((elem, index, array) => {
        if (index === 0) {
            arr1.splice(0, 0, elem);
        } else if (index === (array.length - 1)) {
            arr1.splice(arr1.length, 0, elem);
        } else {
            arr1.splice(Math.floor(arr1.length / 2), 0, elem);
        }
    });
    return arr1;
}
