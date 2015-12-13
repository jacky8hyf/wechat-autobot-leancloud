var router = require('express').Router();
var AV = require('leanengine');
var sha1 = require('js-sha1');
var Promise = require('promise');
var xmlBuilder = new (require('xml2js').Builder)({
  headless: true,
  rootName: 'xml',
  cdata: true,
});
var sprintf = require("sprintf-js").sprintf,
    vsprintf = require("sprintf-js").vsprintf;
var isArray = require('./lib/utils').isArray;

var SIGN_UP_ACTIVITY_SUFFIX = require('./lib/constants').SIGN_UP_ACTIVITY_SUFFIX;

/** 
 * 创建微信文本消息对象。稍后可以通过xmljs.Builder.buildObject来创建XML。
 * @param msg 消息文本字符串
 */
var textMessage = function(from, to, msg) {
  return {
    ToUserName: to,
    FromUserName: from,
    CreateTime: parseInt(Date.now() / 1000),
    Content: msg,
    MsgType: 'text'
  }
}

/** 
 * 创建微信图文消息对象。稍后可以通过xmljs.Builder.buildObject来创建XML。
 * @param articles array of {"Title":"...","Description":"...",...}
 */
var newsMessage = function(from, to, articles) {
  return {
    ToUserName: to,
    FromUserName: from,
    CreateTime: parseInt(Date.now() / 1000),
    MsgType: 'news',
    ArticleCount: articles.length,
    Articles: articles.map(function(e){return{"item":e};}),
  }
}

/** Return an AV.Promise that will resolve to the object*/
AV.queryObject = function(cls, objectId) {
  return new AV.Query(cls).get(objectId);
}

var Activity = AV.Object.extend('Activity', {
  name: function(){return this.get('name');},
  capacity: function(){return this.get('capacity');},
  startDate: function(){return this.get('startDate');}, 
  endDate: function(){return this.get('endDate');}, 
  allowJoin: function(wechatOpenId) {
    var today = new Date();
    var activity = this;
    if(today < activity.startDate())
      return Promise.reject("_activityNotOpen");
    if(today > activity.endDate())
      return Promise.reject("_activityClosed");
    return Promise.all([
      Participant.countForActivity(activity), 
      Participant.find(wechatOpenId, activity)
    ]).then(function(results) {
      var count = results[0], foundParticipant = results[1];
      if(foundParticipant)
        return Promise.reject("_activityDuplicatedJoin");
      if(count >= activity.capacity())
        return Promise.reject("_activityFull");
      return Promise.resolve(count);
    });
  },
}, {
  find: function(keyword) {
    return new AV.Query(this)
      .equalTo('keywords', keyword)
      .descending('endDate')
      .limit(2)
      .find().toPromise()
      .then(function(activities) {
        if (activities.length == 0) return Promise.resolve(null); // 如果没有活动，返回null。
        return activities[0];
      });
  },

  createResponse: function(keyword, oldMessage) {
    return this.find(keyword).then(function(activity) {
      if(!activity)
        return Promise.resolve(null);
      return activity.allowJoin(oldMessage.FromUserName).then(function(){
        return Template.createResponse("_activityEnterInfoPrompt", oldMessage, [activity.name()]) 
      }, function(key) {
        return Template.createResponse(key, oldMessage);
      });
    })
  },
});
var Participant = AV.Object.extend('Participant', {
}, {
  find: function(wechatOpenId, activity) {
    return new AV.Query(this)
      .equalTo('wechatOpenId', wechatOpenId)
      .equalTo('activity', activity)
      .find().toPromise()
      .then(function(participants) {return participants[0];});
  },
  countForActivity: function(activity) {
    return new AV.Query(this).equalTo('activity', activity).count().toPromise();
  },
});
var Template = AV.Object.extend('Template', {
  msgType: function(){return this.get('msgType');},
  content: function(args) {
    return vsprintf(this.get('content'), args);
  },
  // http://mp.weixin.qq.com/wiki/4/b3546879f07623cb30df9ca0e420a5d0.html
  /**
   * Resolves to a list of:
    {
      "title":TITLE,
      "thumb_media_id":THUMB_MEDIA_ID,
      "show_cover_pic":SHOW_COVER_PIC(0/1),
      "author":AUTHOR,
      "digest":DIGEST,
      "content":CONTENT,
      "url":URL,
      "content_source_url":CONTENT_SOURCE_URL
    },
   */
  fetchArticles: function() {
    // FIXME
    return Promise.resolve([]);
  },
  /**生成一个微信消息的对象（包括FromUserName, ToUserName, CreateTime等）。若创建失败返回null。*/
  toMessage: function(from, to, args) {
    if(this.msgType() === 'text')
      return Promise.resolve(textMessage(from, to, this.content(args)));
    if(this.msgType() === 'news')
      return Promise.resolve(null);
      // return this.fetchArticles().then(function(articles) {

      // })
      // TODO hanlde other message types for templates here
    return Promise.resolve(null);
  },
}, {
  /**
   * 查找对应关键字的模板并创建对应的消息对象。如果有多个，以更新时间排序。若没有找到模板或创建失败，返回null。
   * @param keyword 模板查找关键字
   * @param oldMessage 来自用户的消息。新创建的消息对象的接收者与发送者与oldMessage相反。
   * @param args 若
   */
  createResponse: function(keyword, oldMessage, args) {
    return new AV.Query(this)
      .equalTo('keywords', keyword) // as per https://leancloud.cn/docs/js_guide.html#对数组值做查询
      .descending('updatedAt')
      .limit(2)
      .find().toPromise()
      .then(function(templates) {
        if (templates.length == 0) return Promise.resolve(null); // 如果没有模板，返回null。
        if (templates.length >= 2) console.warn('对于关键字' + keyword + '有多个消息模板；请检查。');
        return templates[0].toMessage(oldMessage.ToUserName, oldMessage.FromUserName, args);
    });
  },
})
var Message = AV.Object.extend('Message', {
  Content: function() {return this.get('Content');},
  setResponse: function(responseStr) {
    this.set('response', responseStr);
    return this;
  },
  response: function() {
    return this.get('response');
  },
  setError: function(errorObj) {
    this.set('error', errorObj.toJSON());
    this.error = errorObj;
    return this;
  },
  findActivity: function() {
    return this.Content().endsWith(SIGN_UP_ACTIVITY_SUFFIX)
      ? Activity.find(this.Content().slice(0, -SIGN_UP_ACTIVITY_SUFFIX.length))
      : Promise.resolve(null);
  },
}, {
  findLastMessageFrom: function(from) {
    return new AV.Query(this)
      .equalTo('FromUserName', from)
      .descending('CreateTime')
      .limit(1)
      .find().toPromise()
      .then(function(messages) {
        return messages[0]; // prevents reject if not found, as opposed to .first()
      });
  },

});

module.exports = {
  Activity:Activity,
  Template:Template,
  Message:Message,
  Participant:Participant
}