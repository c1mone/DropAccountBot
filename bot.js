'use strict';

var _               = require('lodash');
var Bot             = require('node-telegram-bot-api');
var schedule        = require('node-schedule');

const config = require('./config.json');
var logger = require(__dirname + '/lib/logger');
var bot = new Bot(config.telegram.botToken, { polling: true });

logger.info('bot server started...');

bot.onText(/^\/say_hello (.+)$/, function (msg, match) {
  var name = match[1];
  bot.sendMessage(msg.chat.id, 'Hello ' + name + '!').then(function () {

  });
});

var chat = new Map();

bot.onText(/^\/start$/, function (msg){
    var username = msg.from.username;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;

    if(isGroupChatType(chatType) && isAdmin(username)){
        logger.info("user %s with chat type %s and chat id %s", username, chatId, chatType);
        var response = ["Hello " + username + "!"];
        response.push("Now start auto-drop game in this chat :)")

        bot.sendMessage(chatId, response.join('\n'),{
            'parse_mode': 'Markdown',
            'selective': 2
        });

        chat.set(chatId, new Map().set("state", "IDLE").set("ig", new Set()));
        console.log(chat);
        chat.get(chatId).set("rule", createDefaultScheduleArray(chatId));

    }

})

bot.onText(/^(@.+)$/, function (msg, match){
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;
    if(isGroupChatType(chatType) && chat.has(chatId) && chat.get(chatId).get("state") === "DROP"){
        chat.get(chatId).get("ig").add(match[1]);
    }
});

bot.onText(/^\/stop$/, function (msg){
    var username = msg.from.username;
    var chatId = msg.chat.id;
    var chatType = msg.chat.type;

    if(isGroupChatType(chatType) && isAdmin(username)){
        var response = ["Hello " + username + "!"];
        response.push("Now stop auto-drop game in this chat :)")

        bot.sendMessage(chatId, response.join('\n'),{
            'parse_mode': 'Markdown',
            'selective': 2
        });
    }

});

function createDefaultScheduleArray(chatId){
    var ruleArray = [];
    _.forEach(config.drop.dropStartTime.hour, function(configHour){
        var configMinute = config.drop.dropStartTime.minute;
        var j = schedule.scheduleJob({hour: configHour, minute: configMinute}, function dropStartFunction(){
            bot.sendMessage(chatId, config.drop.dropStartMsg, {
                'parse_mode': 'Markdown',
                'selective': 2
            });
            chat.get(chatId).set("state", "DROP");
            logger.info("drop start time");
            setTimeout(dropStopFunction, config.drop.dropPeriodMin * 60 * 1000, chatId);
        });
        ruleArray.push(j);
    });
    return ruleArray;
}

function dropStopFunction(chatId){
    var response = [config.drop.dropStopMsg].concat([...chat.get(chatId).get("ig")]);

    bot.sendMessage(chatId, response.join('\n'), {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "LIKE");
    logger.info("chatId : %s, drop stop time", chatId);
    setTimeout(warnFunction, config.drop.likePeriodMin * 60 * 1000, chatId);
}

function warnFunction(chatId){
    bot.sendMessage(chatId, config.drop.warnMsg, {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "WARN");
    logger.info("chatId : %s, warn time", chatId);
    setTimeout(banFunction, config.drop.warnPeriodMin * 60 * 1000, chatId);
}

function banFunction(chatId){
    bot.sendMessage(chatId, config.drop.banMsg, {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "IDLE");
    logger.info("ban time");
}


function replyWithError(userName, chatId, err) {
    logger.warn('user: %s, message: %s', userName, err.message);

    bot.sendMessage(chatId, 'QQ Something wrong! ' + err, {
        'parse_mode': 'Markdown',
        'reply_markup': {
            'hide_keyboard': true
        }
    })
}

function isAdmin(username) {
    if(config.bot.adminUserName === username)
        return true;
    else
        return false;
}

/*
 * Restrict chat type to group
 */

function isGroupChatType(chatType) {
    if(chatType === "group")
        return true;
    else
        return false;
}