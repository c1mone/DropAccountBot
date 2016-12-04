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
const cache       = new NodeCache({ stdTTL: 3600, checkperiod: 180 });

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
    if(isGroupChatType(chatType) && chat.has(chatId) && chat.get(chatId).get("state") === "DROP"){
        chat.get(chatId).get("ig").add(match[1]);
        logger.debug("got ig account from username: %s userid: %s", username, userId);
        logger.debug("ig: %s", JSON.stringify([...chat.get(chatId).get("ig")]));
    }
});

bot.onText(/!done/, function(msg) {
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    var username = msg.from.username || msg.from.first_name;
    var userId = msg.from.id;
    if(isGroupChatType(chatType) && chat.has(chatId) && (chat.get(chatId).get("state") === "LIKE" || chat.get(chatId).get("state") === "WARN")){
        chat.get(chatId).get("done").add(username);
        bot.sendMessage(chatId, "You're done!",{
            'parse_mode': 'Markdown',
            'selective': 2
        });
        logger.debug("got done from username: %s userid: %s", username, userId);
        logger.debug("done: %s", JSON.stringify([...chat.get(chatId).get("done")]));
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
                date.setMinutes(date.getMinutes());
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
        var response1 = util.format(config.drop.dropStopMsg1.join('\n'), config.drop.likePeriodMin);
        var response2 = config.drop.dropStopMsg2.join('\n');
        bot.sendMessage(chatId, response1)
        .then(bot.sendMessage(chatId, response2));
        logger.debug("send drop stop msg to chat_id: %s", chatId);
        var oldState = cache.get("state"+chatId);
        var newState = config.drop.state.like;
        cache.set("state"+chatId, newState, 0);
        logger.debug("change chat_id: %s state from %s to %s", chatId, oldState, newState);
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 1
        var response = config.drop.warnMsg;
        bot.sendMessage(chatId, response.join('\n'));
        logger.debug("send warn msg1 to chat_id: %s", chatId);
        return chatId;
    })
    .then(delay(config.drop.warnPeriodMin2 - config.drop.warnPeriodMin1))
    .then((chatId) => {
        // Warn msg 2
        var response = config.drop.warnMsg;
        bot.sendMessage(chatId, response.join('\n'));
        logger.debug("send warn msg2 to chat_id: %s", chatId);
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
    .catch((err) => {
        logger.warn("schedule msg to chat_id: %s error", chatId, err.message, err.stack);
    });
}
