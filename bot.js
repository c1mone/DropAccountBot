'use strict';

var _               = require('lodash');
var Bot             = require('node-telegram-bot-api');
var schedule        = require('node-schedule');
var util            = require('util');

const config = require('./config.json');
var logger = require(__dirname + '/lib/logger');
var bot = new Bot(config.telegram.botToken, { polling: true });

/*
 * Set up node cache
 */
const NodeCache     = require("node-cache");
const cache       = new NodeCache({ stdTTL: 4800, checkperiod: 180 });

/*
 * Postgres connection pool settings
 */

const Pool          = require('pg-pool');
const url           = require('url');
console.log(process.env.DATABASE_URL);
const params        = url.parse(process.env.DATABASE_URL);
const auth          = params.auth.split(':');
const herokuPgConfig = {
  user: auth[0],
  password: auth[1],
  host: params.hostname,
  port: params.port,
  database: params.pathname.split('/')[1],
  ssl: true
};
const pool = new Pool(herokuPgConfig);

logger.info('bot server started...');

bot.onText(/^\/say_hello (.+)$/, function (msg, match) {
  var name = match[1];
  var chatId = msg.chat.id;
  console.log(isChatIdExist(chatId));
  bot.sendMessage(msg.chat.id, 'Hello ' + name + '!').then(function () {

  });
});

var chat = new Map();

bot.onText(/^\/start$/, function (msg){
    var username = msg.from.username;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var chatTitle = msg.chat.title;
    if(isGroupChatType(chatType) && isAdmin(username)){
        getChatIdExistPromise(chatId).then((isExist) => {
            if(isExist){
                throw new Error("Auto-Drop game is already starting!");
            }else{
                return pool.query("INSERT INTO chatgroup(chat_id, chat_title) values($1, $2)", [chatId, chatTitle]).then((res) => {
                    logger.debug("Insert chat_id: %s, chat_title: %s success",chatId, chatTitle);
                }).catch((err) => {
                    logger.error("Insert chat_id: %s, chat_title: %s error", chatId, chatTitle);
                    logger.error('Insert error: ', err.message, err.stack);
                    throw new Error("could not connect to db, try again.");
                });
            }
        }).then(() => {
            logger.info("Admin: %s start drop game in chat id %s", username, chatId);
            var response = ["OK " + username + "!"];
            response.push("Now start auto-drop game in this chat :)");
            bot.sendMessage(chatId, response.join('\n'),{
                'parse_mode': 'Markdown',
                'selective': 2
            });
        }).catch((err) => {
            replyWithError(chatId, err);
        });
    }
})

bot.onText(/^\/pin$/, function (msg){
    var username = msg.from.username;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var response = util.format(config.drop.pinnedMsg.join("\n"), "\u{2757} \u{2757} \u{2757}","\u{2757} \u{2757} \u{2757}");
    if(isGroupChatType(chatType) && isAdmin(username)){
        getChatIdExistPromise(chatId)
        .then((isExist) => {
            if(isExist){
                return bot.sendMessage(chatId, response,{
                    'parse_mode': 'Markdown',
                    'selective': 2
                });
            }
        }).catch((err) => {
            logger.warn("send pinned msg to chat_id: %s error", chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^(@.+)$/, function (msg, match){
    var userId = msg.from.id;
    var username = msg.from.username || msg.from.first_name;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var account = match[0];
    if(isGroupChatType(chatType)){
        getChatIdExistPromise(chatId)
        .then((isExist) => {
            var state = cache.get("state" + chatId);
            var response = "";
            if(isExist){
                if(state === "DROP"){
                    var accountArr = cache.get("account" + chatId);
                    var userArr = cache.get("user" + chatId);
                    if(accountArr === undefined){
                        cache.set("account" + chatId, [account]);
                        cache.set("user" + chatId, [userId + account + "@" + username]);
                        logger.debug("not found account cache, create new one with account: " + cache.get("account" + chatId));
                    }else{
                        if(!accountArr.some((elem) => {return (elem === account)})){
                            cache.set("account" + chatId, accountArr.concat(account));
                            cache.set("user" + chatId, userArr.concat(userId + account + "@" + username));
                            logger.debug("add account: %s to account cache, now it has: %s", account, cache.get("account" + chatId));
                            return bot.sendMessage(chatId, "You're done with " + account + "!");
                        }else
                            logger.debug("account already exists in accout cache");
                    }
                }else{
                    response = "It's not time to drop ＠username";
                    return bot.sendMessage(chatId, response);
                }
            }
        }).catch((err) => {
            logger.warn("get drop account from chat_id: %s error", chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^D (@.+)$/, function(msg, match) {
    var userId = msg.from.id;
    var username = msg.from.username || msg.from.first_name;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var account = match[1];
    if(isGroupChatType(chatType)){
        getChatIdExistPromise(chatId)
        .then((isExist) => {
            var state = cache.get("state" + chatId);
            var response = "";
            if(isExist){
                if(state === "LIKE"){
                    var userArr = cache.get("user" + chatId);
                    var userIdT = userId + account + "@" + username;
                    logger.debug("new done user: %s, user cache: %s", userIdT, userArr);
                    if(userArr !== undefined && userArr.some((elem) => {return (elem === userIdT)})){
                        var userArrF = userArr.filter((elem) => {
                            return (elem !== userIdT);
                        });
                        cache.set("user"+chatId, userArrF);
                        logger.debug("remove userId: %s, username: %s, account: %s, now it has %s", userId, username, account, userArrF);
                    }
                }else{
                    response = "It's not time to send done D ＠username";
                    return bot.sendMessage(chatId, response);
                }
            }
        }).catch((err) => {
            logger.warn("get done account from chat_id: %s error", chatId, err.message, err.stack);
        });
    }
});

bot.onText(/^\/stop$/, function (msg){
    var username = msg.from.username;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var chatTitle = msg.chat.title;

    if(isGroupChatType(chatType) && isAdmin(username)){
        getChatIdExistPromise(chatId).then((isExist) => {
            if(!isExist){
                throw new Error("Auto-Drop game is not starting!");
            }else{
                return pool.query("DELETE FROM chatgroup where chat_id = $1",[chatId]).then((res) => {
                    logger.debug("Delete chat_id: %s, chat_title: %s success",chatId, chatTitle);
                }).catch((err) => {
                    logger.error("Delete chat_id: %s, chat_title: %s error", chatId, chatTitle);
                    logger.error('Delete error: ', err.message, err.stack);
                    throw new Error("could not connect to db!, try again.")
                })
            }
        }).then(() => {
            logger.info("user: %s stop drop game in chat id: %s", username, chatId);
            var response = ["OK " + username + "!"];
            response.push("Now stop auto-drop game in this chat :)")
            bot.sendMessage(chatId, response.join('\n'),{
                'parse_mode': 'Markdown',
                'selective': 2
            });
            cache.del(chatId);

        }).catch((err) => {
            replyWithError(chatId, err);
        });
    }

});

bot.on('message', function(msg) {
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    if(isGroupChatType(chatType) && chat.has(chatId)){
        if(msg.new_chat_member !== undefined){
            var username = msg.new_chat_member.username || msg.new_chat_member.first_name;
            var userId = msg.new_chat_member.id;
            chat.get(chatId).get("user").add(username);
            logger.debug("new member chatId: %s username: %s userid: %s", chatId, username, userId);
            logger.debug("chatId: %s member list %s", chatId, JSON.stringify([...chat.get(chatId).get("user")]));
        }
        if(msg.left_chat_member !== undefined){
            var username = msg.left_chat_member.username || msg.left_chat_member.first_name;
            var userId = msg.left_chat_member.id;
            chat.get(chatId).get("user").delete(username);
            logger.debug("left member chatId: %s username: %s userid: %s", chatId, username, userId);
            logger.debug("chatId: %s member list %s", chatId, JSON.stringify([...chat.get(chatId).get("user")]));
        }
    }
});

function replyWithError(chatId, err) {
    logger.warn('chat id: %s, message: %s', chatId, err.message);

    bot.sendMessage(chatId, 'Oops! ' + err, {
        'parse_mode': 'Markdown',
        'reply_markup': {
            'hide_keyboard': true
        }
    })
}

function getChatIdExistPromise(chatId){
    return new Promise((resolve, reject) => {
        if(cache.get(chatId))
            resolve(true);
        else{
            resolve(pool.query("SELECT * FROM chatgroup where chat_id = $1", [chatId]).then((res) => {
                if(res.rowCount > 0){
                    cache.set(chatId, true);
                    return true;
                }else{
                    return false;
                }
            }).catch(err => {
                logger.error("Query chat id %s from postgres error", chatId);
                logger.error('query error', err.message, err.stack);
                throw new Error("Could not connect to db, try again.")
            }));
        }
    });
}

function isAdmin(username) {
    if(config.bot.adminUserName === username)
        return true;
    else
        return false;
}

function isGroupChatType(chatType) {
    if(chatType === "group" || chatType === "supergroup")
        return true;
    else
        return false;
}

pool.query("SELECT chat_id, drop_hour_array FROM chatgroup").then((res) => {
    if(res.rowCount > 0){
        return _.map(res.rows, row => {
            var time_array = _.map(row.drop_hour_array.replace(/{|}/g,"").split(","), cstTime => {
                var date = new Date('2016/01/01 ' + cstTime);
                date.setMinutes(date.getMinutes() + config.drop.timeOffset);
                return {"hour": date.getHours(), "minute": date.getMinutes()};
            });
            return {"chat_id": row.chat_id, "time_array": time_array};
        });
    }else
        throw new Error("no starting group.");
}).then(rows => {
    logger.debug("schedule time with chat_id ", rows);
    _.forEach(rows, row => {
        var scheduleArr = _.map(row.time_array, time => {
            var j = schedule.scheduleJob(time, function(){
                getSchedulePromise(row.chat_id);
            });
            return j;
        });
        cache.set('schedule' + row.chat_id, scheduleArr, 0);
        cache.set('state' + row.chat_id, config.drop.state.idle, 0);
        cache.set(row.chat_id, true, 0);
    });
}).catch((err) => {
    logger.warn("load stored time schedule error", err.message, err.stack);
});

function delay(min){
    return function(chatId){
        return new Promise( resolve => {
            setTimeout( () => {
                resolve(chatId);
            }, min * 60 * 1000);
        });
    }
}
function getSchedulePromise(chatId){
    var link = "QQ";
    return Promise.resolve(chatId)
    .then((chatId) => {
        // Round start msg
        var response = util.format(config.drop.roundStartMsg.join('\n'), config.drop.roundStartPeriodMin, link);
        bot.sendMessage(chatId, response);
        logger.debug("send round start msg to chat_id: %s", chatId);
        return chatId;
    })
    .then(delay(config.drop.roundStartPeriodMin))
    .then((chatId) => {
        // Drop start msg
        var response = util.format(config.drop.dropStartMsg.join('\n'), "\u{1f4b0} \u{1f4b0} \u{1f4b0} \u{1f4b0}", config.drop.dropPeriodMin, link);
        bot.sendMessage(chatId, response);
        logger.debug("send drop start msg to chat_id: %s", chatId);
        var oldState = cache.get("state"+chatId);
        var newState = config.drop.state.drop;
        cache.set("state"+chatId, newState, 0);
        logger.debug("change chat_id: %s state from %s to %s", chatId, oldState, newState);
        return chatId;
    })
    .then(delay(config.drop.remindPeriodMin))
    .then((chatId) => {
        // Remind drop msg
        var response = util.format(config.drop.remindMsg.join('\n'), "\u{2757} \u{2757} \u{2757} \u{2757}", "\u{1f4b0} \u{1f4b0} \u{1f4b0} \u{1f4b0}", link, link, link);
        bot.sendMessage(chatId, response);
        logger.debug("send remind drop msg to chat_id: %s", chatId);
        return chatId;
    })
    .then(delay(config.drop.dropPeriodMin - config.drop.remindPeriodMin))
    .then((chatId) => {
        // Drop stop msg
        var accountArr = cache.get("account" + chatId);
        if(accountArr === undefined){
            bot.sendMessage(chatId, "No one join this round! Skip!");
            throw new Error("no one join, skip this round");
        }
        var accountArrLen = accountArr.length;
        logger.debug("account receive: " + accountArr);
        var defaultAccountArr = config.drop.defaultAccount;
        var mergeAccountArr = mergeArray(accountArr, defaultAccountArr);
        logger.debug("merge account: " + mergeAccountArr);
        var accountListResponse = [];
        while(mergeAccountArr.length) {
            accountListResponse.push(mergeAccountArr.splice(0,config.drop.accountListLength).join('\n'));
        }
        var response1 = util.format(config.drop.dropStopMsg1.join('\n'), config.drop.likePeriodMin);
        var response2 = config.drop.dropStopMsg2.join('\n');
        bot.sendMessage(chatId, response1)
        .then(() => {return bot.sendMessage(chatId, response2)})
        .then(() => {
            return Promise.all(accountListResponse.map((accountListStr) => {
                logger.debug("send list %s to chat_id: %s", accountListStr.replace(/\n/, ","), chatId);
                return bot.sendMessage(chatId, accountListStr);
            }));
        });
        logger.debug("send drop stop msg to chat_id: %s", chatId);
        var oldState = cache.get("state"+chatId);
        var newState = config.drop.state.like;
        cache.set("state"+chatId, newState, 0);
        cache.del("account"+chatId);
        logger.debug("change chat_id: %s state from %s to %s", chatId, oldState, newState);
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 1
        var userArr = cache.get("user" + chatId);
        if(userArr !== undefined && userArr.length > 0){
            // get username with account from cache
            var userNameArr = userArr.map((elem) => {
                var elemSplit = elem.split("@");
                var userId = elemSplit.splice(0, 1);
                var account = elemSplit.splice(0, 1);
                var username = elemSplit.join("@");
                return username + " with @" + account;
            }).join("\n");
            var response = config.drop.warnMsg.concat(userNameArr);
            bot.sendMessage(chatId, response.join('\n'));
            logger.debug("send warn msg1 to chat_id: %s", chatId);
        }
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin2 - config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 2
        var userArr = cache.get("user" + chatId);
        if(userArr !== undefined && userArr.length > 0){
            // get username with account from cache
            var userNameArr = userArr.map((elem) => {
                var elemSplit = elem.split("@");
                var userId = elemSplit.splice(0, 1);
                var account = elemSplit.splice(0, 1);
                var username = elemSplit.join("@");
                return username + " with @" + account;
            }).join("\n");
            var response = config.drop.warnMsg.concat(userNameArr);
            bot.sendMessage(chatId, response.join('\n'));
            logger.debug("send warn msg2 to chat_id: %s", chatId);
        }
        return chatId;
    })
    .then(delay(config.drop.likePeriodMin - config.drop.warnPeriodMin2))
    .then((chatId) => {
        // Drop stop msg
        var response = util.format(config.drop.roundStopMsg.join('\n'), link);
        bot.sendMessage(chatId, response);
        logger.debug("send round stop msg to chat_id: %s", chatId);
        var oldState = cache.get("state"+chatId);
        var newState = config.drop.state.idle;
        cache.set("state"+chatId, newState, 0);
        logger.debug("change chat_id: %s state from %s to %s", chatId, oldState, newState);
        return chatId;
    })
    .then((chatId) => {
        // Send warn msg
        // get username with account from cache
        var userArr = cache.get("user" + chatId);
        if(userArr !== undefined && userArr.length > 0){
            // one user may have duplicate undone account, but we only calculate once.
            var seen = {};
            userArr = userArr.filter((elem) => {
                var elemSplit = elem.split("@");
                var userId = elemSplit.splice(0, 1).toString();
                var account = elemSplit.splice(0, 1).toString();
                var username = elemSplit.join("@");
                return seen.hasOwnProperty(userId) ? false : (seen[userId] = true);
            });
            return Promise.all(userArr.map((elem) => {
                var elemSplit = elem.split("@");
                var userId = elemSplit.splice(0, 1).toString();
                var account = elemSplit.splice(0, 1).toString();
                var username = elemSplit.join("@");
                return pool.query("INSERT INTO chatuser(chatuser_id, chat_id, user_id, username, warn_status) \
                 values($1, $2, $3, $4, $5) ON CONFLICT (chatuser_id) \
                 DO UPDATE SET warn_status = chatuser.warn_status + 1", [chatId + userId, chatId, userId, username, 1])
                 .then((res) => logger.debug("insert not done user %s to db success", [chatId + userId, chatId, userId, username, 1]))
                 .catch((err) => logger.warn("insert chat_id: %s not done user to db error", chatId, err.message, err.stack))
                 .then(() => {return pool.query("SELECT warn_status from chatuser where chat_id = $1 and user_id = $2", [chatId, userId])})
                 .then((res) => {
                     var warnStatus = res.rows[0].warn_status;
                     var warnResponse = "user: " + username + " has been warned (" + warnStatus + "/3)";
                     var banResponse = "user: " + username + " got banned!";
                     if(warnStatus >= 3)
                         return bot.sendMessage(chatId, warnResponse).then(() => {
                             bot.sendMessage(chatId,banResponse);
                         });
                     else
                        return bot.sendMessage(chatId, warnResponse);
                 })
                 .catch((err) => {
                     logger.warn("send user_id: %s in chat_id: %s warn msg error", chatId, err.message, err.stack);
                 });
            }));
        }
    })
    .catch((err) => {
        if(err.message !== "no one join, skip this round"){
            logger.warn("schedule msg to chat_id: %s error", chatId, err.message, err.stack);
        }
    });
}

function mergeArray(arr1, arr2){
    arr2.forEach((elem, index, array) => {
        if( index === 0 )
            arr1.splice(0, 0, elem);
        else if (index === (array.length -1))
            arr1.splice(arr1.length, 0, elem);
        else
            arr1.splice(Math.floor(arr1.length / 2), 0, elem);
    });
    return arr1;
}
