'use strict';

var _               = require('lodash');
var Bot             = require('node-telegram-bot-api');
var schedule        = require('node-schedule');
var util            = require('util');

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
        logger.info("user: %s start drop game in chat id %s", username, chatId);
        var response = ["Hello " + username + "!"];
        response.push("Now start auto-drop game in this chat :)");

        bot.sendMessage(chatId, response.join('\n'),{
            'parse_mode': 'Markdown',
            'selective': 2
        });

        chat.set(chatId, new Map().set("state", "IDLE").set("ig", new Set()).set("done", new Set()).set("user", new Set()));
        chat.get(chatId).set("rule", createDefaultScheduleArray(chatId));

    }

})

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

    if(isGroupChatType(chatType) && isAdmin(username)){
        var response = ["Hello " + username + "!"];
        response.push("Now stop auto-drop game in this chat :)")
        bot.sendMessage(chatId, response.join('\n'),{
            'parse_mode': 'Markdown',
            'selective': 2
        });
        _.forEach(chat.get(chatId).get("rule"), function(rule){
            rule.cancel();
        });
        chat.delete(chatId);
        logger.debug("user: %s stop drop game in chat id: %s", username, chatId);
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

function createDefaultScheduleArray(chatId){
    var ruleArray = [];
    _.forEach(config.drop.dropStartTime.hour, function(configHour){
        var configMinute = config.drop.dropStartTime.minute;
        var j = schedule.scheduleJob({hour: configHour, minute: configMinute}, function dropStartFunction(){
            var respone = util.format(config.drop.dropStartMsg, config.drop.dropPeriodMin);
            bot.sendMessage(chatId, respone, {
                'parse_mode': 'Markdown',
                'selective': 2
            });
            chat.get(chatId).set("state", "DROP");
            logger.debug("chatId : %s at drop start time, change state to : %s", chatId, chat.get(chatId).get("state"));
            setTimeout(dropStopFunction, config.drop.dropPeriodMin * 60 * 1000, chatId);
        });
        ruleArray.push(j);
    });
    return ruleArray;
}

function dropStopFunction(chatId){
    var response = [util.format(config.drop.dropStopMsg, config.drop.likePeriodMin)].concat([...chat.get(chatId).get("ig")]);

    bot.sendMessage(chatId, response.join('\n'), {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "LIKE");
    chat.get(chatId).get("ig").clear();
    chat.get(chatId).set("ig", new Set());
    logger.debug("chatId : %s at drop stop time, change state to : %s", chatId, chat.get(chatId).get("state"));
    setTimeout(warnFunction, config.drop.likePeriodMin * 60 * 1000, chatId);
}

function warnFunction(chatId){
    var response = [util.format(config.drop.warnMsg, config.drop.warnPeriodMin)]
    .concat([...chat.get(chatId).get("user")].filter( x => !chat.get(chatId).get("done").has(x)));

    bot.sendMessage(chatId, response.join("\n"), {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "WARN");
    logger.debug("chatId : %s at warn time, change state to : %s", chatId, chat.get(chatId).get("state"));
    setTimeout(banFunction, config.drop.warnPeriodMin * 60 * 1000, chatId);
}

function banFunction(chatId){
    var response = [config.drop.banMsg]
    .concat([...chat.get(chatId).get("user")].filter( x => !chat.get(chatId).get("done").has(x)));
    bot.sendMessage(chatId, response.join("\n"), {
        'parse_mode': 'Markdown',
        'selective': 2
    });
    chat.get(chatId).set("state", "IDLE");
    chat.get(chatId).get("done").clear();
    chat.get(chatId).set("done", new Set());
    logger.debug("chatId : %s at ban time, change state to : %s", chatId, chat.get(chatId).get("state"));
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
