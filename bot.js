'use strict';

var _               = require('lodash');
var Bot             = require('node-telegram-bot-api');


const config = require('./config.json');
var logger = require(__dirname + '/lib/logger');
var bot = new Bot(config.telegram.botToken, { polling: true });

logger.info('bot server started...');

bot.onText(/^\/say_hello (.+)$/, function (msg, match) {
  var name = match[1];
  bot.sendMessage(msg.chat.id, 'Hello ' + name + '!').then(function () {

  });
});

var chat = {};

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
    }

})

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
