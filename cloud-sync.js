/**
 * 词塔 Word Tower · 远程同步客户端
 *
 * 浏览器与微信小程序通用（同一份文件）：
 *   浏览器：<script src="cloud-sync.js"></script> → window.WordTowerSync
 *   小程序：const WordTowerSync = require('../../远程同步/cloud-sync.js')
 *
 * 设计：整份存档快照 + 版本号。上传时带 baseRev，云端版本变了会返回 409，
 * 由 UI 让用户选「用云端」还是「用本机覆盖」——不做字段级自动合并，行为可预期。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WordTowerSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API_KEY = 'wt_sync_api';
  var TOKEN_KEY = 'wt_sync_token';
  var REV_KEY = 'wt_sync_rev';
  var USER_KEY = 'wt_sync_user';
  var PREFIX = 'wordtower_';
  // 设备本地偏好，不参与同步
  var SKIP = { wordtower_speed_idx: 1, wordtower_speak_v1: 1, wordtower_fullscreen_v1: 1 };

  var apiBase = '';

  function hasLS() {
    try {
      return typeof localStorage !== 'undefined' && !!localStorage.setItem;
    } catch (e) {
      return false;
    }
  }
  function hasWX() {
    return typeof wx !== 'undefined' && !!wx.getStorageSync;
  }

  var store = {
    get: function (k) {
      if (hasLS()) return localStorage.getItem(k);
      if (hasWX()) {
        try {
          var v = wx.getStorageSync(k);
          return v === '' || v === undefined || v === null ? null : v;
        } catch (e) {
          return null;
        }
      }
      return null;
    },
    set: function (k, v) {
      if (hasLS()) localStorage.setItem(k, v);
      else if (hasWX()) {
        try {
          wx.setStorageSync(k, v);
        } catch (e) {}
      }
    },
    del: function (k) {
      if (hasLS()) localStorage.removeItem(k);
      else if (hasWX()) {
        try {
          wx.removeStorageSync(k);
        } catch (e) {}
      }
    },
    keys: function () {
      if (hasLS()) {
        var out = [];
        for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
        return out;
      }
      if (hasWX()) {
        try {
          return wx.getStorageInfoSync().keys || [];
        } catch (e) {
          return [];
        }
      }
      return [];
    },
  };

  function request(path, opts) {
    opts = opts || {};
    var base = apiBase || store.get(API_KEY) || '';
    if (!base) return Promise.reject(new Error('尚未配置 API 地址：先调用 WordTowerSync.configure(url)'));
    var url = base.replace(/\/+$/, '') + path;
    var headers = { 'content-type': 'application/json' };
    var token = store.get(TOKEN_KEY);
    if (token && opts.auth !== false) headers.authorization = 'Bearer ' + token;
    var method = opts.method || 'GET';
    var body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    return new Promise(function (resolve, reject) {
      var onOk = function (status, text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {}
        if (status >= 200 && status < 300) resolve(data);
        else {
          var err = new Error((data && data.message) || 'HTTP ' + status);
          err.status = status;
          err.data = data;
          reject(err);
        }
      };
      if (typeof fetch === 'function') {
        fetch(url, { method: method, headers: headers, body: body })
          .then(function (r) {
            return r.text().then(function (t) {
              onOk(r.status, t);
            });
          })
          .catch(reject);
      } else if (hasWX()) {
        wx.request({
          url: url,
          method: method,
          header: headers,
          data: body || '',
          success: function (r) {
            onOk(r.statusCode, typeof r.data === 'string' ? r.data : JSON.stringify(r.data || null));
          },
          fail: function (e) {
            reject(new Error((e && e.errMsg) || '网络请求失败'));
          },
        });
      } else {
        reject(new Error('当前环境没有 fetch / wx.request'));
      }
    });
  }

  function afterAuth(res) {
    if (!res || !res.token) throw new Error('服务器没有返回 token');
    store.set(TOKEN_KEY, res.token);
    store.set(USER_KEY, JSON.stringify(res.user || {}));
    if (!store.get(REV_KEY)) store.set(REV_KEY, '0');
    return res;
  }

  function collect() {
    var snap = {};
    var keys = store.keys();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k || k.indexOf(PREFIX) !== 0 || SKIP[k]) continue;
      var v = store.get(k);
      if (typeof v === 'string') snap[k] = v;
    }
    return snap;
  }

  function apply(snap) {
    if (!snap) return 0;
    var n = 0;
    Object.keys(snap).forEach(function (k) {
      if (k.indexOf(PREFIX) !== 0 || SKIP[k]) return;
      store.set(k, snap[k]);
      n++;
    });
    return n;
  }

  return {
    configure: function (base) {
      apiBase = String(base || '').trim();
      store.set(API_KEY, apiBase);
      return apiBase;
    },
    apiBase: function () {
      return apiBase || store.get(API_KEY) || '';
    },
    token: function () {
      return store.get(TOKEN_KEY);
    },
    user: function () {
      try {
        return JSON.parse(store.get(USER_KEY) || 'null');
      } catch (e) {
        return null;
      }
    },
    loggedIn: function () {
      return !!store.get(TOKEN_KEY);
    },
    health: function () {
      return request('/api/health', { auth: false });
    },
    register: function (name, pass) {
      return request('/api/register', { method: 'POST', body: { name: name, pass: pass }, auth: false }).then(afterAuth);
    },
    login: function (name, pass) {
      return request('/api/login', { method: 'POST', body: { name: name, pass: pass }, auth: false }).then(afterAuth);
    },
    logout: function () {
      var p = this.loggedIn()
        ? request('/api/logout', { method: 'POST', body: {} }).catch(function () {})
        : Promise.resolve();
      var self = this;
      return p.then(function () {
        store.del(TOKEN_KEY);
        store.del(USER_KEY);
        store.set(REV_KEY, '0');
        return true;
      });
    },
    pull: function () {
      return request('/api/state', { method: 'GET' }).then(function (res) {
        store.set(REV_KEY, String((res && res.rev) || 0));
        return res || { state: null, rev: 0, updatedAt: 0 };
      });
    },
    push: function (snapshot, baseRev, force) {
      var rev = baseRev === undefined ? Number(store.get(REV_KEY) || 0) : Number(baseRev);
      var path = '/api/state' + (force ? '?force=1' : '');
      return request(path, { method: 'PUT', body: { state: snapshot, baseRev: rev } }).then(function (res) {
        store.set(REV_KEY, String((res && res.rev) || 0));
        return res;
      });
    },
    collect: collect,
    apply: apply,
    // 常用动作：把本机存档推上去（冲突时 reject，err.status === 409 且 err.data.state 是云端副本）
    upload: function () {
      return this.push(collect());
    },
    // 常用动作：把云端存档拉下来并写回本机
    download: function (overwrite) {
      return this.pull().then(function (res) {
        if (!res.state) return { applied: 0, missing: true };
        var local = collect();
        var keys = Object.keys(local);
        if (!overwrite && keys.length) {
          var err = new Error('本机已有存档，需确认覆盖');
          err.code = 'local_not_empty';
          err.localKeys = keys;
          err.remote = res;
          throw err;
        }
        return { applied: apply(res.state), rev: res.rev, updatedAt: res.updatedAt };
      });
    },
    summary: function (snap) {
      snap = snap || collect();
      var users = 0;
      var banks = 0;
      try {
        var u = JSON.parse(snap.wordtower_users_v1 || '{}');
        users = Object.keys(u || {}).length;
      } catch (e) {}
      try {
        var b = JSON.parse(snap.wordtower_banks_v1 || '[]');
        banks = (b || []).length;
      } catch (e) {}
      return { keys: Object.keys(snap).length, users: users, banks: banks };
    },
  };
});
