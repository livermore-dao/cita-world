/**
 * 辞塔 Cita World · Supabase 同步客户端
 *
 * 依赖：页面先加载 supabase-js（CDN）：
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 * 然后：
 *   <script src="supabase-sync.js"></script> → window.SupaSync
 *
 * 接口与 cloud-sync.js（Cloudflare 版）对齐：
 *   configure(url, anonKey) / register(email, pass) / login(email, pass) / logout()
 *   pull() / push(snapshot, force) / upload() / download(overwrite)
 *   collect() / apply(snap) / summary(snap)
 *
 * 差异：账号是邮箱 + 口令（Supabase Auth 托管，不需要自己写哈希/token）；
 *       冲突是「软提示」：上传时若云端比上次拉取新，报 remote_newer，由用户决定是否强推。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SupaSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var URL_KEY = 'wt_sb_url';
  var KEY_KEY = 'wt_sb_key';
  var REV_KEY = 'wt_sb_rev';
  var PULLED_KEY = 'wt_sb_lastpull';
  var PREFIX = 'wordtower_';
  var SKIP = { wordtower_speed_idx: 1, wordtower_speak_v1: 1, wordtower_fullscreen_v1: 1 };

  var client = null;
  var url = '';
  var anonKey = '';

  function hasLS() {
    try {
      return typeof localStorage !== 'undefined' && !!localStorage.setItem;
    } catch (e) {
      return false;
    }
  }
  var store = {
    get: function (k) {
      return hasLS() ? localStorage.getItem(k) : null;
    },
    set: function (k, v) {
      if (hasLS()) localStorage.setItem(k, v);
    },
    del: function (k) {
      if (hasLS()) localStorage.removeItem(k);
    },
    keys: function () {
      if (!hasLS()) return [];
      var out = [];
      for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
      return out;
    },
  };

  // 关键：模块加载时就把上次保存的参数读进来。
  // 之前这里初始化为空串，导致「上个会话保存过参数、刷新后再点注册/登录」时
  // configured() 看本地存储返回 true，但内部 url/anonKey 是空的，getSB 直接抛
  // 「先调用 SupaSync.configure(url, anonKey)」。
  // （注意必须放在 store 定义之后，否则引用未初始化的 store 会直接抛错）
  url = store.get(URL_KEY) || '';
  anonKey = store.get(KEY_KEY) || '';

  function getSB() {
    var lib = (typeof window !== 'undefined' && window.supabase) || null;
    if (!lib || !lib.createClient) throw new Error('未加载 supabase-js：先在页面里引入 CDN 脚本');
    if (!client) {
      if (!url || !anonKey) throw new Error('先调用 SupaSync.configure(url, anonKey)');
      client = lib.createClient(url, anonKey);
    }
    return client;
  }

  function err(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function supaErr(res) {
    if (res && res.error) throw err('supabase_error', res.error.message || String(res.error), { cause: res.error });
    return res;
  }

  async function requireUser() {
    var sb = getSB();
    var res = await sb.auth.getUser();
    var u = res && res.data && res.data.user;
    // supabase-js v2 在「没有会话」时返回 error: Auth session missing!，
    // 这里统一翻译成 not_logged_in，界面才提示得清楚（否则会显示英文原始报错）
    if (!u) throw err('not_logged_in', '未登录或会话已过期，请先登录', { cause: res && res.error });
    supaErr(res);
    return u;
  }

  function markPulled() {
    store.set(PULLED_KEY, String(Date.now()));
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
    configure: function (supaUrl, key) {
      url = String(supaUrl || '').trim().replace(/\/+$/, '');
      anonKey = String(key || '').trim();
      if (!/^https?:\/\//.test(url)) throw err('bad_url', 'Project URL 要以 https:// 开头');
      if (!anonKey) throw err('bad_key', 'anon key 不能为空');
      store.set(URL_KEY, url);
      store.set(KEY_KEY, anonKey);
      client = null; // 重建
      return { url: url };
    },
    configured: function () {
      return !!(url || store.get(URL_KEY)) && !!(anonKey || store.get(KEY_KEY));
    },
    /** 内部是否已就绪（可直接发请求）；与 configured 的区别：后者只看本地存储 */
    credsReady: function () {
      return !!(url && anonKey);
    },
    projectUrl: function () {
      return url || store.get(URL_KEY) || '';
    },
    collect: collect,
    apply: apply,
    summary: function (snap) {
      snap = snap || collect();
      var users = 0;
      var banks = 0;
      try {
        users = Object.keys(JSON.parse(snap.wordtower_users_v1 || '{}') || {}).length;
      } catch (e) {}
      try {
        banks = (JSON.parse(snap.wordtower_banks_v1 || '[]') || []).length;
      } catch (e) {}
      return { keys: Object.keys(snap).length, users: users, banks: banks };
    },

    register: async function (email, pass) {
      var sb = getSB();
      if (!email || email.indexOf('@') < 1) throw err('bad_input', '邮箱格式不对');
      if (!pass || pass.length < 6) throw err('bad_input', '口令至少 6 位');
      var res = supaErr(await sb.auth.signUp({ email: email, password: pass }));
      var u = res.data && res.data.user;
      markPulled();
      return { needsConfirm: !!(u && !res.data.session), user: u };
    },
    login: async function (email, pass) {
      var sb = getSB();
      var res = supaErr(await sb.auth.signInWithPassword({ email: email, password: pass }));
      markPulled();
      return { user: res.data.user };
    },
    logout: async function () {
      var sb = getSB();
      var online = true;
      try {
        await sb.auth.signOut();            // 默认 scope=global：会请求服务器
      } catch (e) {
        online = false;
        // 断网 / 墙 / 服务器 5xx 时 signOut 会抛错且可能不清本机会话 →
        // 再用 scope:'local' 只清本机（不请求服务器）
        try { await sb.auth.signOut({ scope: 'local' }); } catch (e2) {}
      }
      // 最终兜底：直接清掉 supabase-js 存在本机的会话键，保证「退出」在任何情况下都生效
      try {
        if (hasLS()) {
          var kill = [];
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > -1) kill.push(k);
          }
          for (var j = 0; j < kill.length; j++) localStorage.removeItem(kill[j]);
        }
      } catch (e3) {}
      client = null;                        // 丢掉内存里的客户端，下次请求按剩余会话重建
      store.del(REV_KEY);
      store.del(PULLED_KEY);
      return { online: online };
    },
    email: async function () {
      try {
        var u = await requireUser();
        return u.email;
      } catch (e) {
        return null;
      }
    },

    pull: async function () {
      var sb = getSB();
      var u = await requireUser();
      var res = supaErr(
        await sb.from('saves').select('payload,rev,updated_at').eq('user_id', u.id).maybeSingle()
      );
      var row = res.data;
      markPulled();
      if (!row) return { state: null, rev: 0, updatedAt: 0 };
      store.set(REV_KEY, String(row.rev));
      return { state: row.payload || null, rev: Number(row.rev), updatedAt: Date.parse(row.updated_at) || 0 };
    },

    push: async function (snapshot, force) {
      var sb = getSB();
      var u = await requireUser();
      var cur = supaErr(await sb.from('saves').select('payload,rev,updated_at').eq('user_id', u.id).maybeSingle()).data;
      var lastPull = Number(store.get(PULLED_KEY) || 0);
      if (cur && !force && lastPull && Date.parse(cur.updated_at) > lastPull) {
        throw err('remote_newer', '云端存档比本机记录的新', {
          remote: { rev: cur.rev, updatedAt: Date.parse(cur.updated_at), state: cur.payload },
        });
      }
      var rev = (cur ? Number(cur.rev) : 0) + 1;
      var updated_at = new Date().toISOString();
      supaErr(
        await sb.from('saves').upsert(
          { user_id: u.id, payload: snapshot, rev: rev, updated_at: updated_at },
          { onConflict: 'user_id' }
        )
      );
      store.set(REV_KEY, String(rev));
      markPulled();
      return { rev: rev, updatedAt: Date.parse(updated_at) };
    },

    upload: function () {
      return this.push(collect(), false);
    },
    download: async function (overwrite) {
      var res = await this.pull();
      if (!res.state) return { applied: 0, missing: true };
      var local = collect();
      if (!overwrite && Object.keys(local).length) {
        throw err('local_not_empty', '本机已有存档，需确认覆盖', { remote: res });
      }
      return { applied: apply(res.state), rev: res.rev, updatedAt: res.updatedAt };
    },
  };
});
