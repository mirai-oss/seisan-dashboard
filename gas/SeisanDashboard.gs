/**********************************************************************
 * 精算ダッシュボード バックエンド（GAS = JSON APIのみ）
 *
 * 画面（UI）はこのプロジェクトの外、GitHub Pagesで配信される静的サイトです。
 * このファイルは「データを読み書きするAPI」としてのみ動作します。
 * doGet/doPost が fn（関数名）と args（引数配列）を受け取り、
 * SD_API_WHITELIST に載っている sd_ 関数だけを呼び出してJSONを返します。
 *
 * こうしている理由: GASのHtmlServiceでUIごと配信すると、Google Workspace
 * 管理者の「Apps Scriptサービス制限」等でスマホから開けなくなることがある。
 * UIを外部の静的サイトにして、データ取得だけを軽いfetch(JSON)にすることで
 * この制約を回避する（参考: 売上ダッシュボード tori-dashboard と同じ構成）。
 *
 * 全関数 sd_ プレフィックス（doGet/doPost のみ例外）。
 *
 * ★「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」でデプロイしてください。
 * ★ 初回は sd_authorize を一度実行して権限を承認してください。
 **********************************************************************/

var SD_VERSION = 'v5.16-pl-category';

// 統合アカウント（N-Styleポータル / 日報Supabase）でのログイン用。
// キーは公開用publishableキー（秘密情報ではない）。トークン検証はSupabase側で行う。
// ※業務委託先は統合アカウントを持たない方針のため、SSOで入れるのは本部・マスターのみ。
var SD_SSO_SUPA_URL = 'https://uuvsxzhpxtghojoubjcc.supabase.co';
var SD_SSO_SUPA_KEY = 'sb_publishable_MrwPJAx_Ws_fdRutprKCiQ_dg3wCiTr';
var SD_START_MONTH = '2026-03'; // これより前の月はプルダウンに出さない
var SD_PAID_SHEET = '振込管理_精算ダッシュボード';
var SD_NO_CLIENT_LABEL = '（委託先未設定）'; // 委託先（法人）が未設定の店舗をグルーピングする際の仮キー
var SD_CORP_SHEET = '法人設定_精算ダッシュボード';
var SD_CONFIG_SHEET = '設定_精算ダッシュボード';
var SD_EXT_SHEET = '設定_外部連携';
var SD_AUTH_SHEET = '権限_精算ダッシュボード';
var SD_RECUR_SHEET = '定期費目_精算ダッシュボード';
var SD_LOG_SHEET = '発行ログ_精算ダッシュボード';
var SD_CHECK_SHEET = '✅入力チェック表';
var SD_TZ = 'Asia/Tokyo';
var SD_TAX_OPTIONS = ['10%', '8%', '対象外'];
var SD_KUBUN_OPTIONS = ['売上', '変動費', '固定ロイヤリティ', '変動ロイヤリティ', '固定調整'];

/* ---------- Webアプリ入口（JSON APIのみ） ----------
 * 呼べる関数はここに明示的に列挙したものだけ（それ以外は拒否）。
 * sd_login 以外は全て第1引数がtoken（内部の sd_auth_ が権限検証する）。 */
var SD_API_WHITELIST = [
  'sd_login', 'sd_supaLogin', 'sd_getDashboard', 'sd_addRows', 'sd_updateRow', 'sd_deleteRow', 'sd_setPaid',
  'sd_pdfPreview', 'sd_issueAndSend', 'sd_cashPreview', 'sd_cashApply',
  'sd_prepareMonth', 'sd_setupAutoPrep', 'sd_uploadAttachment', 'sd_listAttachments',
  'sd_getPdfB64', 'sd_updateCheckSheet', 'sd_bulkAdd', 'sd_getSettings',
  'sd_saveAccount', 'sd_saveCorp', 'sd_testChatwork', 'sd_apiTransferEx',
  'sd_saveStoreRate', 'sd_saveRecurStatus', 'sd_saveOpsSettings', 'sd_getOpsSettings',
  'sd_suggestAccount', 'sd_bulkCategorize', 'sd_apiCategorizedLines'
];

function sd_apiFnMap_() {
  return {
    sd_login: sd_login, sd_supaLogin: sd_supaLogin, sd_getDashboard: sd_getDashboard, sd_addRows: sd_addRows,
    sd_updateRow: sd_updateRow, sd_deleteRow: sd_deleteRow, sd_setPaid: sd_setPaid, sd_pdfPreview: sd_pdfPreview,
    sd_issueAndSend: sd_issueAndSend, sd_cashPreview: sd_cashPreview, sd_cashApply: sd_cashApply,
    sd_prepareMonth: sd_prepareMonth, sd_setupAutoPrep: sd_setupAutoPrep,
    sd_uploadAttachment: sd_uploadAttachment, sd_listAttachments: sd_listAttachments,
    sd_getPdfB64: sd_getPdfB64, sd_updateCheckSheet: sd_updateCheckSheet,
    sd_bulkAdd: sd_bulkAdd, sd_getSettings: sd_getSettings,
    sd_saveAccount: sd_saveAccount, sd_saveCorp: sd_saveCorp, sd_testChatwork: sd_testChatwork,
    sd_apiTransferEx: sd_apiTransferEx,
    sd_saveStoreRate: sd_saveStoreRate, sd_saveRecurStatus: sd_saveRecurStatus,
    sd_saveOpsSettings: sd_saveOpsSettings, sd_getOpsSettings: sd_getOpsSettings,
    sd_suggestAccount: sd_suggestAccount, sd_bulkCategorize: sd_bulkCategorize,
    sd_apiCategorizedLines: sd_apiCategorizedLines
  };
}

function sd_jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sd_handleApi_(fn, args) {
  if (SD_API_WHITELIST.indexOf(fn) < 0) return { ok: false, error: '許可されていない呼び出しです: ' + fn };
  var f = sd_apiFnMap_()[fn];
  try {
    var result = f.apply(null, args || []);
    return { ok: true, result: result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return sd_jsonOut_({ ok: true, ver: SD_VERSION });
  if (p.fn) {
    var args = [];
    try { args = JSON.parse(p.args || '[]'); } catch (err) { /* 空配列のまま */ }
    return sd_jsonOut_(sd_handleApi_(p.fn, args));
  }
  return sd_jsonOut_({ ok: false, error: 'このエンドポイントはJSON APIです。画面はGitHub Pages側をご利用ください。' });
}

function doPost(e) {
  var payload = {};
  try { payload = JSON.parse(e.postData.contents); } catch (err) {
    return sd_jsonOut_({ ok: false, error: 'リクエストの解析に失敗しました' });
  }
  return sd_jsonOut_(sd_handleApi_(payload.fn, payload.args));
}

/* ---------- 業務委託費の外部連携（PL自動連携用・2026-08-23追加、2026-08-24: paid判定を追加） ----------
 * 経営ダッシュボードのPLタブへ「運営委託費（自動）」として反映するため、指定店舗・月の
 * 業務委託費（税抜）だけを返す軽量API。ログインセッションとは別の専用トークン認証
 * （tori-dashboard側のBQ_LOAD_TOKENと同じ考え方）。既存のsd_settle_・
 * sd_buildSeisanHtml_と同じ計算ロジックを流用するだけで、書き込みは一切行わない。
 * paid: 振込済み（sd_isLocked_）かどうか。呼び出し側（tori-dashboard）は
 * paid===falseの店舗をPL反映から除外する（未確定の金額をPLに載せないため）。
 * 呼び出し例: POST {fn:'sd_apiTransferEx', args:[token, '秋葉原 肉寿司', '2026-07']}
 */
function sd_apiTransferEx(token, store, monthKey) {
  var tk = PropertiesService.getScriptProperties().getProperty('PL_SYNC_TOKEN');
  var got = String(token || '').trim(), want = String(tk || '').trim();
  if (!tk || got !== want) {
    // 値そのものは出さず、文字数だけ比較してどちら側の設定が怪しいか分かるようにする（一時的な診断用）
    throw new Error('unauthorized（診断: 受信した長さ=' + got.length + ' / 期待する長さ=' + want.length +
      ' / PL_SYNC_TOKEN未設定=' + (!tk));
  }
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var st = null;
  cfg.forEach(function (s) { if (s.name === store) st = s; });
  // 「見つからない理由」を区別して返す（一時的な診断用）: 店舗マスタに無い／DBシートが特定できない／
  // 見つかったが対象月の売上行が0件、のどれかで原因が全く違うため。
  if (!st) return { found: false, reason: '店舗マスタに「' + store + '」という名前が見つかりません（表記ゆれの可能性）', masterNames: cfg.map(function (s) { return s.name; }) };
  if (!st.db) return { found: false, reason: '店舗は見つかったが、データシートが自動特定できていません（設定シートでDBシート名の紐付けが必要）' };
  var rows = sd_readRowsCached_(st.db);
  var s = sd_settle_(rows, monthKey, st.rate, st.fixed);
  if (!s.hasSales) return { found: true, hasSales: false, reason: monthKey + '分の売上行が0件でした（' + st.db.sheet + 'シート）', rowCountAllMonths: rows.length };
  var paid = sd_isLocked_(store, monthKey);
  if (!paid) return { found: true, hasSales: true, paid: false, reason: monthKey + '分はまだ振込済みではありません（未確定のためPL反映対象外）', transferEx: s.transferEx, transfer: s.transfer };
  return { found: true, hasSales: true, paid: true, transferEx: s.transferEx, transfer: s.transfer };
}

/* ---------- 初回承認用（エディタから一度実行） ---------- */

function sd_authorize() {
  SpreadsheetApp.getActive().getName();
  DriveApp.getRootFolder().getName();
  GmailApp.getAliases();
  ScriptApp.getOAuthToken();
  var ext = sd_extConfig_();
  if (ext['売上スプレッドシートID']) {
    try { SpreadsheetApp.openById(ext['売上スプレッドシートID']).getName(); }
    catch (err) { Logger.log('売上シートを開けません: ' + err.message); }
  }
  Logger.log('承認OK（' + SD_VERSION + '）');
}

/* ---------- ユーティリティ ---------- */

function sd_norm_(s) {
  return String(s == null ? '' : s).replace(/[\s　]+/g, '').replace(/％/g, '%');
}
function sd_fmtMonth_(d) { return Utilities.formatDate(d, SD_TZ, 'yyyy-MM'); }
function sd_monthKeyToDate_(key) {
  var m = String(key).match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error('対象月の形式が不正です: ' + key);
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}
function sd_addMonths_(key, n) {
  var d = sd_monthKeyToDate_(key);
  return sd_fmtMonth_(new Date(d.getFullYear(), d.getMonth() + n, 1));
}
function sd_monthLabel_(key) {
  var d = sd_monthKeyToDate_(key);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
}
function sd_monthDot_(key) { // '2026-06' -> '2026.06'
  return key.replace('-', '.');
}
function sd_thisMonthKey_() { return sd_fmtMonth_(new Date()); }
/* プルダウン・マトリクス用の月リスト。
 * SD_START_MONTH から、max(対象月, 今月)+6ヶ月先まで（先の月も選べる）。 */
function sd_monthList_(anchorKey) {
  var start = SD_START_MONTH;
  var thisM = sd_thisMonthKey_();
  var endBase = (anchorKey && anchorKey > thisM) ? anchorKey : thisM;
  var end = sd_addMonths_(endBase, 6);
  var out = [], k = start, guard = 0;
  if (start > end) return [start];
  while (k <= end && guard < 240) { out.push(k); k = sd_addMonths_(k, 1); guard++; }
  return out;
}
function sd_colLetterToNum_(letter) {
  var s = String(letter || '').toUpperCase().replace(/[^A-Z]/g, '');
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n || 0;
}

/* ---------- シート構造の自動検出（v1と同じ） ---------- */

/* 全シートを毎回スキャンするsd_detectRaw_は重い（実測で秒単位）。
 * 店舗構成が変わるのは稀なので10分キャッシュする（店舗追加直後は最大10分反映が遅れる）。 */
function sd_detect_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sd_detect_v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 壊れていたら作り直す */ } }
  var res = sd_detectRaw_();
  try { cache.put('sd_detect_v1', JSON.stringify(res), 600); } catch (e) { /* 100KB超なら諦めてキャッシュしない */ }
  return res;
}

function sd_detectRaw_() {
  var ss = SpreadsheetApp.getActive();
  var res = { master: null, dbs: [], statusSheet: null, mailSheet: null, sendSheet: null };
  var own = [SD_CONFIG_SHEET, SD_EXT_SHEET, SD_AUTH_SHEET, SD_RECUR_SHEET, SD_LOG_SHEET, SD_CHECK_SHEET];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (own.indexOf(name) > -1) return;
    var rows = Math.min(sh.getLastRow(), 12);
    var cols = Math.min(sh.getLastColumn(), 25);
    if (rows < 1 || cols < 2) return;
    var vals = sh.getRange(1, 1, rows, cols).getDisplayValues();
    for (var r = 0; r < rows; r++) {
      var line = vals[r].map(sd_norm_);
      if (!res.master && line.indexOf('店舗名') > -1 &&
          line.some(function (v) { return v.indexOf('ロイヤリティ率') > -1; })) {
        res.master = { sheet: name, headerRow: r + 1 };
      }
      if (!res.statusSheet && line.indexOf('店舗名') > -1 &&
          line.some(function (v) { return v.indexOf('未発行月数') > -1; })) {
        res.statusSheet = { sheet: name, headerRow: r + 1 };
      }
      if (!res.mailSheet && line.indexOf('店舗名') > -1 &&
          line.some(function (v) { return v.indexOf('To（') === 0 || v === 'To'; })) {
        res.mailSheet = { sheet: name, headerRow: r + 1 };
      }
      if (!res.sendSheet && line.some(function (v) { return v.indexOf('★店舗を選択') > -1; })) {
        res.sendSheet = { sheet: name };
      }
      if (line.indexOf('年月') > -1 && line.indexOf('区分') > -1 && line.indexOf('費目名') > -1) {
        var colMap = {};
        vals[r].forEach(function (v, i) {
          var n = sd_norm_(v);
          if (n === '年月') colMap.ym = i + 1;
          else if (n === '区分') colMap.kubun = i + 1;
          else if (n === '費目名') colMap.item = i + 1;
          else if (!colMap.amount && n.indexOf('金額') === 0) colMap.amount = i + 1;
          else if (n === '税率') colMap.tax = i + 1;
          else if (!colMap.note && n.indexOf('備考') === 0) colMap.note = i + 1;
          else if (n === '入力者') colMap.editor = i + 1;
          else if (n === '入力日時') colMap.at = i + 1;
          else if (n === '支払済') colMap.paid = i + 1;
          else if (n === 'リンク') colMap.link = i + 1;
          else if (n === '修正日') colMap.edited = i + 1;
          else if (n === '勘定科目') colMap.account = i + 1;
          else if (n === '補助科目') colMap.subAccount = i + 1;
        });
        if (colMap.ym && colMap.kubun && colMap.item && colMap.amount) {
          var title = name;
          for (var rr = 0; rr < Math.min(rows, 6) && title === name; rr++) {
            for (var c = 0; c < cols; c++) {
              if (String(vals[rr][c]).indexOf('精算入力DB') > -1) { title = String(vals[rr][c]); break; }
            }
          }
          res.dbs.push({ sheet: name, title: title, headerRow: r + 1, colMap: colMap });
        }
        break;
      }
    }
  });
  return res;
}

function sd_masterStores_(det) {
  if (!det.master) throw new Error('「店舗設定マスター」が見つかりません');
  var sh = SpreadsheetApp.getActive().getSheetByName(det.master.sheet);
  var hr = det.master.headerRow;
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR <= hr) return [];
  var header = sh.getRange(hr, 1, 1, lastC).getDisplayValues()[0].map(sd_norm_);
  var iName = header.indexOf('店舗名');
  var iClient = header.indexOf('委託先');
  var iCorp = header.indexOf('法人');
  var iInv = -1, iRep = -1;
  var iRate = -1, iRent = -1, iIns = -1, iSss = -1, iF4 = -1, iF5 = -1;
  header.forEach(function (h, i) {
    if (iInv < 0 && (h.indexOf('インボイス') > -1 || h.indexOf('登録番号') > -1)) iInv = i;
    if (iRep < 0 && h.indexOf('代表者') > -1) iRep = i;
    if (iRate < 0 && h.indexOf('ロイヤリティ率') > -1) iRate = i;
    if (iRent < 0 && h === '家賃') iRent = i;
    if (iIns < 0 && h.indexOf('物件保険') > -1) iIns = i;
    if (iSss < 0 && (h.indexOf('SSS') > -1 || h.indexOf('経理手数料') > -1)) iSss = i;
    if (iF4 < 0 && h.indexOf('固定④') > -1) iF4 = i;
    if (iF5 < 0 && h.indexOf('固定⑤') > -1) iF5 = i;
  });
  function num(row, idx) {
    if (idx < 0) return 0;
    return Number(String(row[idx] || '').replace(/[¥￥,，\s]/g, '')) || 0;
  }
  var vals = sh.getRange(hr + 1, 1, lastR - hr, lastC).getDisplayValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var nm = String(vals[i][iName] || '').trim();
    if (!nm) break;
    var fixed = {
      rent: num(vals[i], iRent), ins: num(vals[i], iIns), sss: num(vals[i], iSss),
      f4: num(vals[i], iF4), f5: num(vals[i], iF5)
    };
    fixed.total = fixed.rent + fixed.ins + fixed.sss + fixed.f4 + fixed.f5;
    out.push({
      name: nm,
      client: iClient > -1 ? String(vals[i][iClient] || '').trim() : '',
      corp: iCorp > -1 ? String(vals[i][iCorp] || '').trim() : '',
      invoice: iInv > -1 ? String(vals[i][iInv] || '').trim() : '',
      rep: iRep > -1 ? String(vals[i][iRep] || '').trim() : '',
      rate: iRate > -1 ? String(vals[i][iRate] || '').trim() : '',
      fixed: fixed
    });
  }
  return out;
}

function sd_autoMap_(storeName, dbs) {
  var tokens = String(storeName).split(/[\s　]+/).filter(String).map(sd_norm_);
  for (var i = 0; i < dbs.length; i++) {
    var t = sd_norm_(dbs[i].title) + '|' + sd_norm_(dbs[i].sheet);
    var ok = tokens.every(function (tok) { return t.indexOf(tok) > -1; });
    if (ok) return dbs[i];
  }
  return null;
}

/* ---------- 設定シート群 ---------- */

/* 店舗マッピング（列を4本に拡張。既存v1シートには不足列を自動追加） */
function sd_config_(master, det) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_CONFIG_SHEET);
  var HEAD = ['店舗名', 'DBシート名（自動検出・変更可）', '必須費目（カンマ区切り・任意）', '売上シート店舗名（現金売上取込用）'];
  if (!sh) {
    sh = ss.insertSheet(SD_CONFIG_SHEET);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
    sh.setFrozenRows(1);
    var rows = master.map(function (st) {
      var db = sd_autoMap_(st.name, det.dbs);
      return [st.name, db ? db.sheet : '', '', sd_defaultSalesName_(st.name)];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
    sh.autoResizeColumns(1, HEAD.length);
  } else if (sh.getLastColumn() < 4) {
    sh.getRange(1, 4).setValue(HEAD[3]);
    var lastR0 = sh.getLastRow();
    for (var r0 = 2; r0 <= lastR0; r0++) {
      var nm0 = String(sh.getRange(r0, 1).getValue() || '').trim();
      if (nm0) sh.getRange(r0, 4).setValue(sd_defaultSalesName_(nm0));
    }
  }
  var lastR = sh.getLastRow();
  var data = lastR > 1 ? sh.getRange(2, 1, lastR - 1, 4).getDisplayValues() : [];
  return master.map(function (st) {
    var row = null;
    for (var i = 0; i < data.length; i++) {
      if (sd_norm_(data[i][0]) === sd_norm_(st.name)) { row = data[i]; break; }
    }
    var db = null;
    if (row && row[1]) {
      for (var j = 0; j < det.dbs.length; j++) {
        if (det.dbs[j].sheet === String(row[1]).trim()) { db = det.dbs[j]; break; }
      }
    }
    if (!db) db = sd_autoMap_(st.name, det.dbs);
    var required = row ? String(row[2] || '').split(/[,、，]/).map(function (s) { return s.trim(); }).filter(String) : [];
    var salesName = row && row[3] ? String(row[3]).trim() : sd_defaultSalesName_(st.name);
    return {
      name: st.name, client: st.client, corp: st.corp, invoice: st.invoice, rep: st.rep,
      rate: st.rate, fixed: st.fixed, db: db, required: required, salesName: salesName
    };
  });
}

/* ---------- 精算計算（共通ロジック：ダッシュボード表示・PDF生成で共用） ---------- */

function sd_settle_(rows, monthKey, rateStr, fixed) {
  var rate = (parseFloat(String(rateStr).replace(/[%％]/g, '')) || 0) / 100;
  fixed = fixed || { rent: 0, ins: 0, sss: 0, f4: 0, f5: 0, total: 0 };
  var mrows = rows.filter(function (r) { return r.ym === monthKey; });
  var salesRows = [], varRows = [];
  var sales = 0, varCost = 0, royF = 0, royVarDb = 0, adj = 0;
  mrows.forEach(function (r) {
    var k = sd_norm_(r.kubun);
    if (k === '売上') { sales += r.amount; salesRows.push(r); }
    else if (k === '固定ロイヤリティ') royF += r.amount;
    else if (k === '変動ロイヤリティ') { royVarDb += r.amount; varRows.push(r); }
    else if (k === '固定調整') adj += r.amount;
    else { varCost += r.amount; varRows.push(r); }
  });
  var royV = Math.round(sales * rate);
  var fixedSub = fixed.total + adj;
  var costTotal = fixedSub + varCost + royF + royV;
  var transfer = sales - costTotal;
  var ex = Math.round(transfer / 1.1);
  return {
    sales: sales, varCost: varCost, royF: royF, royV: royV, royVarDb: royVarDb,
    adj: adj, fixedSub: fixedSub, costTotal: costTotal,
    transfer: transfer, transferEx: ex, tax: transfer - ex,
    ns: royF + royV, hasSales: sales > 0, count: mrows.length,
    salesRows: salesRows, varRows: varRows
  };
}

/* ---------- 振込管理・法人設定 ---------- */

function sd_paidSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_PAID_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_PAID_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['対象（法人名）', '対象月', '振込済み', '日付', '記録者', '振込金額']]);
    sh.setFrozenRows(1);
  } else if (String(sh.getRange(1, 6).getValue()) !== '振込金額') {
    sh.getRange(1, 6).setValue('振込金額'); // 旧シート（5列）を6列に拡張
  }
  return sh;
}

/* 振込済みシートは「1行=1状態」ではなく「操作イベントの履歴」として積み上げる。
 * 振込済みにする操作のたびに1行追加され、振込金額はそのイベントごとの入力額。
 * 解除操作には金額が付かず、累計（total）はリセットしない
 * （精算修正→再振込のときに差額分だけ追加入力できるようにするため）。
 * v5.8以降は列Aに「法人名」を書き込む（振込は法人単位でまとめて行われるため）。
 * v5.7以前の店舗名で書かれた行も、後方互換のため引き続き読み取る（sd_paidStatusMap_参照）。 */
function sd_paidMap_() {
  var sh = sd_paidSheet_();
  var lastR = sh.getLastRow();
  var out = {};
  if (lastR < 2) return out;
  sh.getRange(2, 1, lastR - 1, 6).getDisplayValues().forEach(function (r) {
    var key = sd_norm_(r[0]), mk = String(r[1]).trim();
    if (!key || !mk) return;
    out[key] = out[key] || {};
    var cur = out[key][mk] || { done: false, date: '', by: '', total: 0 };
    var isPaidEvent = sd_norm_(r[2]).toUpperCase() === 'TRUE' || r[2] === '✅';
    cur.done = isPaidEvent; // 行は時系列順に並ぶため、最後に読んだ行が現在の状態
    cur.date = r[3];
    cur.by = r[4];
    if (isPaidEvent) {
      var amt = Number(String(r[5]).replace(/[^0-9.\-]/g, ''));
      if (amt) cur.total += amt;
    }
    out[key][mk] = cur;
  });
  return out;
}

/* 店舗名 → 委託先（法人名）。未設定はSD_NO_CLIENT_LABELに丸める。
 * 店舗設定マスターの全件走査（sd_detect_+sd_masterStores_）が必要なため、10分キャッシュする。 */
function sd_clientOfMap_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sd_clientOfMap');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 壊れていたら作り直す */ } }
  var det = sd_detect_();
  var map = {};
  sd_masterStores_(det).forEach(function (s) { map[sd_norm_(s.name)] = s.client ? s.client : SD_NO_CLIENT_LABEL; });
  cache.put('sd_clientOfMap', JSON.stringify(map), 600);
  return map;
}
function sd_clientOf_(store) {
  return sd_clientOfMap_()[sd_norm_(store)] || SD_NO_CLIENT_LABEL;
}

/* 振込状態は法人（委託先）単位が正。旧・店舗単位の記録（v5.7以前）もフォールバックとして見る。 */
function sd_paidStatusMap_(store, client, paidAll) {
  var byClient = (paidAll[sd_norm_(client || SD_NO_CLIENT_LABEL)] || {});
  var byStore = (paidAll[sd_norm_(store)] || {});
  var months = {};
  Object.keys(byStore).forEach(function (mk) { months[mk] = true; });
  Object.keys(byClient).forEach(function (mk) { months[mk] = true; });
  var out = {};
  Object.keys(months).forEach(function (mk) {
    // 法人単位の記録が一度でもあればそれが正（true/falseどちらでも優先）。
    // 旧・店舗単位の記録（v5.7以前）は、その月に法人単位の記録が一切無いときだけフォールバックで見る。
    out[mk] = byClient[mk] || byStore[mk];
  });
  return out;
}

/* client: 法人名（委託先未設定の店舗群はSD_NO_CLIENT_LABEL）。振込はその法人配下の全店舗分をまとめて記録する。 */
function sd_setPaid(token, client, monthKey, done, sendMail, amount) {
  var user = sd_auth_(token, true);
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var members = cfg.filter(function (s) { return sd_norm_(s.client ? s.client : SD_NO_CLIENT_LABEL) === sd_norm_(client); });
  if (!members.length) throw new Error('「' + client + '」に該当する店舗が見つかりません');

  // 振込済み→未振込に戻す（ロック解除）操作はマスターのみ許可。振込済みにする操作（ロック開始）は本部でも可。
  if (!done && members.some(function (s) { return sd_isLocked_(s.name, monthKey); })) sd_requireMaster_(user);

  var amt = 0;
  if (done) {
    amt = Number(amount);
    if (!isFinite(amt)) throw new Error('振込金額を入力してください');
  }

  var sh = sd_paidSheet_();
  var rec = [client, monthKey, done ? 'TRUE' : 'FALSE',
    done ? Utilities.formatDate(new Date(), SD_TZ, 'yyyy-MM-dd') : '', user.name,
    done ? amt : ''];
  sh.appendRow(rec); // 履歴として毎回追加（上書きしない）

  var result = { ok: true, client: client, month: monthKey, done: !!done, mailed: false, amount: done ? amt : null, mailedStores: [] };
  if (done && sendMail) {
    var ext = sd_extConfig_();
    var d = sd_monthKeyToDate_(monthKey);
    var mLabel = (d.getMonth() + 1) + '月';
    var sender = ext['メール送信者名'] || '株式会社N-Style';
    members.forEach(function (st) {
      try {
        var ms = sd_mailSettings_(det, st.name);
        if (!ms || !ms.to) return; // 宛先未登録の店舗はスキップ（法人内の他店舗は続行）
        var settle = st.db ? sd_settle_(sd_readRowsCached_(st.db), monthKey, st.rate, st.fixed) : null;
        var amountLine = (settle && settle.hasSales) ? '■振込金額（税込）：' + sd_yen_(settle.transfer) + '\n' : '';
        var subject = '【お知らせ】' + mLabel + '分業務委託料 お振込完了のご連絡（' + st.name + '）';
        var body = 'ご担当者様\n\nいつも大変お世話になっております。\n' + sender + 'です。\n\n'
          + mLabel + '分の業務委託料につきまして、お振込が完了いたしましたのでご連絡申し上げます。\n\n'
          + '■対象店舗：' + st.name + '\n'
          + amountLine
          + '\nご査収のほど、よろしくお願い申し上げます。';
        if (ext['ダッシュボードURL']) {
          body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + ext['ダッシュボードURL'] + '\n※ スマホで開けない場合は、リンクを長押しして「Safari/Chromeで開く」を選ぶか、ブラウザにURLを貼り付けてお開きください。';
        }
        var opts = { name: sender };
        if (ms.cc) opts.cc = ms.cc;
        GmailApp.sendEmail(ms.to, subject, body, opts);
        sd_log_('振込完了メール', st.name, monthKey, subject, '', '', user.name, ms.to);
        result.mailedStores.push(st.name);
      } catch (e) {
        sd_log_('振込完了メールエラー', st.name, monthKey, String((e && e.message) || e), '', '', user.name, '');
      }
    });
    result.mailed = result.mailedStores.length > 0;
  }
  // 全店舗の振込が完了したらLarkに月次完了報告（この月で初めて完了したときだけ送信）
  if (done) {
    try {
      var n = sd_maybeNotifyComplete_(monthKey);
      if (n && n.sent) result.larkNotified = true;
    } catch (e) { sd_log_('Lark完了報告エラー', '全店舗', monthKey, String((e && e.message) || e), '', '', user.name, ''); }
  }
  return result;
}

/* 対象月の「精算対象の全店舗（＝売上入力済みの店舗）」が全て振込済みになったら
 * Larkに完了報告を送る。既にこの月の報告を送っていれば何もしない（二重送信防止）。 */
function sd_maybeNotifyComplete_(monthKey) {
  // 既送信チェック
  var already = sd_logRows_().some(function (r) {
    return r.action === 'Lark完了報告' && r.month === monthKey;
  });
  if (already) return { sent: false, reason: '送信済み' };

  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var paid = sd_paidMap_();

  var targets = []; // 精算対象（売上入力あり）の店舗
  var allPaid = true;
  cfg.forEach(function (st) {
    if (!st.db) return;
    var settle = sd_settle_(sd_readRowsCached_(st.db), monthKey, st.rate, st.fixed);
    if (!settle.hasSales) return; // 売上未入力＝まだ精算対象でない
    var status = sd_paidStatusMap_(st.name, st.client, paid)[monthKey];
    var isPaid = !!(status && status.done);
    targets.push({ name: st.name, transfer: settle.transfer, paid: isPaid });
    if (!isPaid) allPaid = false;
  });

  if (targets.length === 0 || !allPaid) return { sent: false, reason: '未完了' };

  var total = targets.reduce(function (a, t) { return a + t.transfer; }, 0);
  return sd_notifyLarkComplete_(monthKey, targets, total);
}

function sd_notifyLarkComplete_(monthKey, targets, total) {
  var ext = sd_extConfig_();
  var url = ext['Lark完了報告Webhook'];
  if (!url) { Logger.log('Lark完了報告Webhookが未設定のため送信をスキップしました'); return { sent: false, reason: 'Webhook未設定' }; }
  var kw = ext['Larkキーワード'] || '';
  var lines = targets.map(function (t) { return '・' + t.name + '：' + sd_yen_(t.transfer); });
  var text = (kw ? kw + '\n' : '') // カスタムキーワード設定がある場合は先頭に含める
    + '✅【精算完了報告】' + sd_monthLabel_(monthKey) + '分\n'
    + '全' + targets.length + '店舗の精算書発行・お振込が完了しました。\n\n'
    + lines.join('\n') + '\n\n'
    + '合計振込額（税込）：' + sd_yen_(total);
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ msg_type: 'text', content: { text: text } }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var bodyText = res.getContentText();
  var okFlag = false;
  try { okFlag = (JSON.parse(bodyText).code === 0) || (JSON.parse(bodyText).StatusCode === 0); } catch (e) { /* 解析不可 */ }
  if (code === 200 && okFlag) {
    sd_log_('Lark完了報告', '全店舗', monthKey, '全' + targets.length + '店舗完了 合計' + sd_yen_(total), '', '', '自動', '');
    return { sent: true };
  }
  sd_log_('Lark完了報告エラー', '全店舗', monthKey, 'HTTP' + code + ' ' + bodyText, '', '', '自動', '');
  return { sent: false, reason: 'Lark送信失敗: ' + bodyText };
}

/* エディタから手動でLark送信をテストする用（強制送信・二重送信チェックなし） */
function sd_testLarkComplete() {
  var now = new Date();
  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  var r = sd_notifyLarkComplete_(monthKey, [{ name: 'テスト店舗', transfer: 1000000 }], 1000000);
  Logger.log(JSON.stringify(r));
}

function sd_corpMap_(cfg) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_CORP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_CORP_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['委託先（法人名）', '振込先口座', '備考']]);
    sh.setFrozenRows(1);
    var seen = {}, rows = [];
    cfg.forEach(function (st) {
      if (st.client && !seen[sd_norm_(st.client)]) { seen[sd_norm_(st.client)] = true; rows.push([st.client, '', '']); }
    });
    if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
    sh.autoResizeColumns(1, 3);
  }
  var out = {};
  var lastR = sh.getLastRow();
  if (lastR > 1) {
    sh.getRange(2, 1, lastR - 1, 3).getDisplayValues().forEach(function (r) {
      if (r[0]) out[sd_norm_(r[0])] = { account: String(r[1]).trim(), note: String(r[2]).trim() };
    });
  }
  return out;
}

function sd_defaultSalesName_(storeName) {
  var map = {
    '秋葉原肉寿司': '秋葉原 肉寿司',
    '川崎じんべぇ': 'じんべえ 川崎店',
    '新横浜じんべぇ': 'じんべえ 新横浜店',
    '新横浜黒霧屋': '黒霧屋 新横浜',
    '本厚木エース': '横濱ホルモン会館　エース　本厚木店'
  };
  return map[sd_norm_(storeName)] || storeName;
}

/* 外部連携設定（キー・値） */
function sd_extConfig_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_EXT_SHEET);
  var DEFAULTS = [
    ['売上スプレッドシートID', ''],
    ['売上シート名', '分析_日別店舗'],
    ['売上_日付列', 'A'],
    ['売上_店舗名列', 'J'],
    ['売上_現金列', 'T'],
    ['売上_支払合計列', 'S'],
    ['添付親フォルダID', ''],
    ['メール送信者名', ''],
    ['発行元_会社名', ''],
    ['発行元_郵便番号', ''],
    ['発行元_住所', ''],
    ['発行元_電話', ''],
    ['発行元_登録番号', ''],
    ['発行元_振込先', ''],
    ['リマインド送信先', ''],
    ['ダッシュボードURL', ''],
    ['Lark完了報告Webhook', ''],
    ['Larkキーワード', ''],
    ['ChatWork APIトークン', ''],
    ['ChatWorkルームID（振込リマインド用）', '']
  ];
  if (!sh) {
    sh = ss.insertSheet(SD_EXT_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([['設定キー', '値']]);
    sh.getRange(2, 1, DEFAULTS.length, 2).setValues(DEFAULTS);
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, 2);
  }
  var out = {};
  var lastR = sh.getLastRow();
  if (lastR > 1) {
    sh.getRange(2, 1, lastR - 1, 2).getDisplayValues().forEach(function (r) {
      if (r[0]) out[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  // 既存シートに不足している設定キーを追記（発行元情報など後から追加した項目）
  var missing = DEFAULTS.filter(function (d) { return !(d[0] in out); });
  if (missing.length) {
    sh.getRange(sh.getLastRow() + 1, 1, missing.length, 2).setValues(missing);
    missing.forEach(function (d) { out[d[0]] = d[1]; });
  }
  return out;
}

/* 権限（アカウント）シート */
function sd_authSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_AUTH_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_AUTH_SHEET);
    sh.getRange(1, 1, 1, 7).setValues([['ログインID', 'パスワード', '表示名', '権限（マスター/本部/委託先）', '担当店舗（カンマ区切り／全店）', '有効（TRUE/FALSE）', 'メール（統合ログイン用）']]);
    var initPw = Utilities.getUuid().split('-')[0];       // ランダムな初期パスワード（実行ログに1回だけ出力）
    var initPwM = Utilities.getUuid().split('-')[0];
    sh.getRange(2, 1, 3, 6).setValues([
      ['master', initPwM, 'マスター', 'マスター', '全店', 'TRUE'],
      ['honbu', initPw, '本部', '本部', '全店', 'TRUE'],
      ['（例）委託先ID', '（例）パスワード', '委託先の表示名', '委託先', '担当店舗名をカンマ区切りで', 'FALSE']
    ]);
    Logger.log('マスターアカウントの初期パスワードを発行しました: master / ' + initPwM + '（必ずログイン後に変更してください）');
    Logger.log('本部アカウントの初期パスワードを発行しました: honbu / ' + initPw + '（必ずログイン後に変更してください）');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, 7);
  } else if (String(sh.getRange(1, 7).getDisplayValue()).trim() === '') {
    // 既存シートにG列「メール」が無ければ見出しを追加（統合ログインの突き合わせ用）
    sh.getRange(1, 7).setValue('メール（統合ログイン用）');
    sh.getRange(1, 7).setNote('N-Styleポータル／日報と共通のメールアドレス。\nここに入れると「統合アカウントでログイン」でこの行の権限が使えます。\n空欄＝統合ログイン不可（従来のID/パスワードのみ）。\n※業務委託先は統合アカウントの対象外です。');
  }
  return sh;
}

/* 権限（本部）シートの生の役職文字列を正規化。マスター > 本部 > 委託先 の3段階。 */
function sd_normRole_(raw) {
  var n = sd_norm_(raw);
  if (n === 'マスター' || n === 'ﾏｽﾀｰ') return 'マスター';
  if (n === '本部') return '本部';
  return '委託先';
}

function sd_findAccount_(id) {
  var sh = sd_authSheet_();
  var lastR = sh.getLastRow();
  if (lastR < 2) return null;
  var vals = sh.getRange(2, 1, lastR - 1, 7).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === String(id).trim()) {
      return {
        id: String(vals[i][0]).trim(),
        pw: String(vals[i][1]),
        name: String(vals[i][2]).trim() || String(vals[i][0]).trim(),
        role: sd_normRole_(vals[i][3]),
        storesRaw: String(vals[i][4]).trim(),
        enabled: sd_norm_(vals[i][5]).toUpperCase() !== 'FALSE',
        email: String(vals[i][6] || '').trim().toLowerCase()
      };
    }
  }
  return null;
}

/* メールから権限行を探す（統合ログイン用） */
function sd_findAccountByEmail_(email) {
  var sh = sd_authSheet_();
  var lastR = sh.getLastRow();
  if (lastR < 2) return null;
  var target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  var vals = sh.getRange(2, 1, lastR - 1, 7).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][6] || '').trim().toLowerCase() === target) {
      return {
        id: String(vals[i][0]).trim(),
        name: String(vals[i][2]).trim() || String(vals[i][0]).trim(),
        role: sd_normRole_(vals[i][3]),
        storesRaw: String(vals[i][4]).trim(),
        enabled: sd_norm_(vals[i][5]).toUpperCase() !== 'FALSE',
        email: target
      };
    }
  }
  return null;
}

/* ---------- ログイン／セッション ---------- */

function sd_login(id, pw) {
  var acc = sd_findAccount_(id);
  if (!acc || !acc.enabled || String(acc.pw) !== String(pw)) {
    Utilities.sleep(500);
    throw new Error('IDまたはパスワードが違います');
  }
  var token = Utilities.getUuid();
  var user = { id: acc.id, name: acc.name, role: acc.role, storesRaw: acc.storesRaw };
  CacheService.getScriptCache().put('sdtk_' + token, JSON.stringify(user), 21600); // 6時間
  return { token: token, name: acc.name, role: acc.role };
}

/* 統合アカウント（N-Styleポータル／日報Supabase）でログイン。
 * ブラウザ側がSupabaseにメール+パスワードでログインして得た access_token を受け取り、
 * Supabaseの /auth/v1/user で検証する（＝パスワードはこのGASを通らない）。
 * 検証OKなら権限シートG列「メール」と突き合わせて、通常と同じセッションを発行する。
 * 業務委託先は統合アカウントの対象外（本部・マスターのみ）。 */
function sd_supaLogin(stoken) {
  if (!stoken) throw new Error('統合アカウントのトークンがありません');
  var res;
  try {
    res = UrlFetchApp.fetch(SD_SSO_SUPA_URL + '/auth/v1/user', {
      headers: { apikey: SD_SSO_SUPA_KEY, Authorization: 'Bearer ' + stoken },
      muteHttpExceptions: true
    });
  } catch (e) {
    throw new Error('統合アカウントの確認に失敗しました: ' + e.message);
  }
  if (res.getResponseCode() !== 200) throw new Error('統合アカウントの認証が無効です。もう一度ログインしてください');
  var email = '';
  try { email = String(JSON.parse(res.getContentText()).email || '').trim().toLowerCase(); } catch (e) { /* 下で弾く */ }
  if (!email) throw new Error('統合アカウントのメールアドレスを取得できませんでした');

  var acc = sd_findAccountByEmail_(email);
  if (!acc) throw new Error('このメール（' + email + '）に対応する精算ダッシュボードのアカウントがありません。設定タブの「メール」欄に登録してください');
  if (!acc.enabled) throw new Error('このアカウントは無効化されています');
  if (acc.role === '委託先') throw new Error('業務委託先アカウントは統合ログインの対象外です。従来のIDとパスワードでログインしてください');

  var token = Utilities.getUuid();
  var user = { id: acc.id, name: acc.name, role: acc.role, storesRaw: acc.storesRaw };
  CacheService.getScriptCache().put('sdtk_' + token, JSON.stringify(user), 21600); // 6時間
  return { token: token, name: acc.name, role: acc.role };
}

function sd_auth_(token, needHonbu) {
  var raw = token ? CacheService.getScriptCache().get('sdtk_' + token) : null;
  if (!raw) throw new Error('AUTH'); // クライアント側で再ログイン誘導
  var user = JSON.parse(raw);
  if (needHonbu && user.role !== '本部' && user.role !== 'マスター') throw new Error('この操作は本部アカウントのみ実行できます');
  return user;
}

function sd_requireMaster_(user) {
  if (user.role !== 'マスター') throw new Error('この操作はマスターアカウントのみ実行できます');
}

/* 振込済みロック: 対象店舗の属する法人・月が振込済みだと、マスター以外は編集不可
 * （振込は法人単位でまとめて行われるため、ロックも法人配下の全店舗にかかる） */
function sd_isLocked_(store, monthKey) {
  var paid = sd_paidMap_();
  var client = sd_clientOf_(store);
  var rec = sd_paidStatusMap_(store, client, paid)[monthKey];
  return !!(rec && rec.done);
}
/* 振込済み後の編集権限レベル。既定は「マスターのみ」。設定タブ（sd_saveOpsSettings）で
 * 'admin'（本部以上）に変更できる。マスターへの昇格や振込ロックそのものの解除
 * （sd_requireMaster_系）はここには含めない＝権限昇格の抜け道にしない。 */
function sd_lockLevel_() {
  var v = PropertiesService.getScriptProperties().getProperty('SD_LOCK_LEVEL');
  return (v === 'admin') ? 'admin' : 'master';
}
function sd_canEditLocked_(user) {
  if (user.role === 'マスター') return true;
  if (sd_lockLevel_() === 'admin' && user.role === '本部') return true;
  return false;
}
function sd_requireUnlocked_(user, store, monthKey) {
  if (sd_canEditLocked_(user)) return;
  if (sd_isLocked_(store, monthKey)) {
    var need = sd_lockLevel_() === 'admin' ? '本部以上の' : 'マスター';
    throw new Error('🔒「' + store + '」' + sd_monthLabel_(monthKey) + '分は振込済みでロックされています。編集には' + need + 'アカウントが必要です。');
  }
}

function sd_allowedStores_(user, cfg) {
  if (user.role === '本部' || sd_norm_(user.storesRaw) === '全店' || !user.storesRaw) return cfg;
  var names = user.storesRaw.split(/[,、，]/).map(function (s) { return sd_norm_(s); }).filter(String);
  return cfg.filter(function (st) { return names.indexOf(sd_norm_(st.name)) > -1; });
}

/* ---------- DB読み取り／入力漏れ判定（v1と同じ） ---------- */

/* DB読み取りのキャッシュ版（月切替の高速化用・10分）。
 * 明細を変更したら sd_clearRowsCache_ で必ずクリアすること。
 *
 * CacheServiceは1キーあたり100KBまでしか保存できない。以前は95KBを超える
 * 店舗（明細が多い・運用が長い店舗）は「キャッシュに入らない」まま黙って
 * 素通りしていたため、その店舗だけ毎回シートを丸ごと読み直して常に遅く
 * なっていた。ここでは複数キーに分割して保存することで上限を回避する。 */
var SD_ROWS_CACHE_TTL = 600; // 秒
var SD_ROWS_CACHE_CHUNK = 90000; // 1キーあたりの文字数（100KB上限に余裕を持たせる）

function sd_readRowsCached_(db) {
  var cache = CacheService.getScriptCache();
  var metaKey = 'sdrows_' + db.sheet + '_n';
  var n = Number(cache.get(metaKey) || 0);
  if (n > 0) {
    try {
      var keys = [];
      for (var i = 0; i < n; i++) keys.push('sdrows_' + db.sheet + '_' + i);
      var parts = cache.getAll(keys);
      var ok = keys.every(function (k) { return parts[k] != null; });
      if (ok) return JSON.parse(keys.map(function (k) { return parts[k]; }).join(''));
    } catch (e) { /* 壊れていたら読み直す */ }
  }
  var rows = sd_readRows_(db);
  try {
    var s = JSON.stringify(rows);
    var count = Math.max(1, Math.ceil(s.length / SD_ROWS_CACHE_CHUNK));
    var toPut = {};
    for (var c = 0; c < count; c++) toPut['sdrows_' + db.sheet + '_' + c] = s.substr(c * SD_ROWS_CACHE_CHUNK, SD_ROWS_CACHE_CHUNK);
    toPut[metaKey] = String(count);
    cache.putAll(toPut, SD_ROWS_CACHE_TTL);
  } catch (e) { /* キャッシュ失敗（極端に大きい等）は無視して素通り */ }
  return rows;
}
function sd_clearRowsCache_(sheetName) {
  try {
    var cache = CacheService.getScriptCache();
    var metaKey = 'sdrows_' + sheetName + '_n';
    var n = Number(cache.get(metaKey) || 0);
    var keys = [metaKey, 'sdrows_' + sheetName]; // 旧形式キーも念のため掃除
    for (var i = 0; i < n; i++) keys.push('sdrows_' + sheetName + '_' + i);
    cache.removeAll(keys);
  } catch (e) { /* 無視 */ }
}
function sd_clearAllRowsCache_(det) {
  try {
    (det || sd_detect_()).dbs.forEach(function (db) { sd_clearRowsCache_(db.sheet); });
  } catch (e) { /* 無視 */ }
}

function sd_readRows_(db) {
  var sh = SpreadsheetApp.getActive().getSheetByName(db.sheet);
  var hr = db.headerRow, cm = db.colMap;
  var lastR = sh.getLastRow();
  if (lastR <= hr) return [];
  var width = 0;
  Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
  var rng = sh.getRange(hr + 1, 1, lastR - hr, width);
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i], d = disp[i];
    var item = String(d[cm.item - 1] || '').trim();
    var ymRaw = v[cm.ym - 1];
    if (!item && !ymRaw) continue;
    var key = '';
    if (ymRaw instanceof Date) key = sd_fmtMonth_(ymRaw);
    else {
      var m = String(d[cm.ym - 1]).match(/(\d{4})[\/\-年.](\d{1,2})/);
      if (m) key = m[1] + '-' + ('0' + m[2]).slice(-2);
    }
    if (!key) continue;
    var amt = v[cm.amount - 1];
    if (typeof amt !== 'number') amt = Number(String(d[cm.amount - 1]).replace(/[¥￥,，\s]/g, '')) || 0;
    rows.push({
      row: hr + 1 + i, ym: key,
      kubun: String(d[cm.kubun - 1] || '').trim(),
      item: item, amount: amt,
      tax: sd_norm_(d[cm.tax - 1] || ''),
      note: cm.note ? String(d[cm.note - 1] || '') : '',
      editor: cm.editor ? String(d[cm.editor - 1] || '') : '',
      at: cm.at ? String(d[cm.at - 1] || '') : '',
      paid: cm.paid ? String(d[cm.paid - 1] || '') : '',
      edited: cm.edited ? String(d[cm.edited - 1] || '') : '',
      account: cm.account ? String(d[cm.account - 1] || '').trim() : '',
      subAccount: cm.subAccount ? String(d[cm.subAccount - 1] || '').trim() : ''
    });
  }
  return rows;
}

function sd_issuedMap_(det) {
  var out = {};
  if (!det.statusSheet) return out;
  var sh = SpreadsheetApp.getActive().getSheetByName(det.statusSheet.sheet);
  var hr = det.statusSheet.headerRow;
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR <= hr) return out;
  var hVals = sh.getRange(hr, 1, 1, lastC).getValues()[0];
  var hDisp = sh.getRange(hr, 1, 1, lastC).getDisplayValues()[0];
  var monthCols = [];
  var nameCol = -1;
  hDisp.forEach(function (h, i) {
    if (nameCol < 0 && sd_norm_(h) === '店舗名') nameCol = i;
    var key = '';
    if (hVals[i] instanceof Date) key = sd_fmtMonth_(hVals[i]);
    else if (/^\d{4}[-\/]\d{1,2}$/.test(String(h).trim())) {
      var p = String(h).trim().split(/[-\/]/);
      key = p[0] + '-' + ('0' + p[1]).slice(-2);
    }
    if (key) monthCols.push({ i: i, key: key });
  });
  if (nameCol < 0) return out;
  var vals = sh.getRange(hr + 1, 1, lastR - hr, lastC).getDisplayValues();
  vals.forEach(function (row) {
    var nm = String(row[nameCol] || '').trim();
    if (!nm) return;
    out[sd_norm_(nm)] = monthCols.reduce(function (acc, mc) {
      acc[mc.key] = String(row[mc.i]).indexOf('✅') > -1;
      return acc;
    }, {});
  });
  return out;
}

function sd_missing_(byMonth, monthKey, required) {
  var curRows = byMonth[monthKey] || [];
  var cur = {}, curKubun = {};
  curRows.forEach(function (r) { cur[sd_norm_(r.item)] = true; curKubun[sd_norm_(r.kubun)] = true; });
  var prevKeys = [sd_addMonths_(monthKey, -1), sd_addMonths_(monthKey, -2), sd_addMonths_(monthKey, -3)];
  var cnt = {}, label = {};
  prevKeys.forEach(function (pk) {
    var seen = {};
    (byMonth[pk] || []).forEach(function (r) {
      var n = sd_norm_(r.item);
      if (!n || seen[n]) return;
      seen[n] = true;
      cnt[n] = (cnt[n] || 0) + 1;
      label[n] = r.item;
    });
  });
  var missing = [];
  Object.keys(cnt).forEach(function (n) { if (cnt[n] >= 2 && !cur[n]) missing.push(label[n]); });
  (required || []).forEach(function (x) {
    var n = sd_norm_(x);
    if (!n || cur[n]) return;
    var lb = label[n] || x;
    if (missing.indexOf(lb) < 0) missing.push(lb);
  });
  var catWarn = [];
  ['売上', '固定ロイヤリティ'].forEach(function (k) {
    var had = prevKeys.some(function (pk) {
      return (byMonth[pk] || []).some(function (r) { return sd_norm_(r.kubun) === k; });
    });
    if (had && !curKubun[k]) catWarn.push('区分「' + k + '」が未入力');
  });
  missing.sort();
  return { missing: missing, catWarn: catWarn };
}

/* ---------- API: ダッシュボード ---------- */

function sd_getDashboard(token, monthKey) {
  var timer = sd_timer_();
  var user = sd_auth_(token, false);
  timer.mark('auth');
  var ss = SpreadsheetApp.getActive();
  var det = sd_detect_();
  var master = sd_masterStores_(det);
  var cfg = sd_allowedStores_(user, sd_config_(master, det));
  timer.mark('detectSheets');
  var issued = sd_issuedMap_(det);
  var sentLog = sd_sentMap_();
  timer.mark('issuedSent');

  if (!monthKey) {
    var now = new Date();
    monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  }
  if (monthKey < SD_START_MONTH) monthKey = SD_START_MONTH;
  var months = sd_monthList_(monthKey);

  var kubunSet = {};
  SD_KUBUN_OPTIONS.forEach(function (k) { kubunSet[k] = true; });
  var paidAll = sd_paidMap_();
  var corps = sd_corpMap_(cfg);
  var ext = sd_extConfig_();
  var payMap = sd_paySumsCached_(ext, monthKey, cfg); // 売上シートS列の対象月合計（未設定ならnull）
  timer.mark('paidCorpsPayMap');

  var stores = cfg.map(function (st) {
    var rows = st.db ? sd_readRowsCached_(st.db) : [];
    timer.mark('店舗:' + st.name);
    var byMonth = {};
    rows.forEach(function (r) {
      (byMonth[r.ym] = byMonth[r.ym] || []).push(r);
      if (r.kubun) kubunSet[r.kubun] = true;
    });
    var fixed = st.fixed || { rent: 0, ins: 0, sss: 0, f4: 0, f5: 0, total: 0 };

    // 精算計算（共通関数 sd_settle_ を使用）
    function settleFor(mk) {
      return sd_settle_(byMonth[mk] || [], mk, st.rate, fixed);
    }

    var paidByMonth = sd_paidStatusMap_(st.name, st.client, paidAll); // 法人単位（同じ法人の店舗は同じ状態を共有）
    var matrix = {};
    months.forEach(function (mk) {
      var s = settleFor(mk);
      var sent = (sentLog[sd_norm_(st.name)] || {})[mk];
      matrix[mk] = {
        count: s.count, cost: s.varCost + s.royF,
        sales: s.sales, transfer: s.hasSales ? s.transfer : null,
        ns: s.hasSales ? s.ns : null,
        sent: !!sent, paid: !!(paidByMonth[mk] && paidByMonth[mk].done),
        paidTotal: (paidByMonth[mk] && paidByMonth[mk].total) || 0 // 振込済み累計額（差額アラート用）
      };
    });
    var chk = st.db ? sd_missing_(byMonth, monthKey, st.required) : { missing: [], catWarn: ['DBシート未検出'] };
    var curRows = (byMonth[monthKey] || []).map(function (r) {
      return { row: r.row, kubun: r.kubun, item: r.item, amount: r.amount, tax: r.tax, note: r.note, editor: r.editor, at: r.at, edited: r.edited, account: r.account, subAccount: r.subAccount };
    });
    var settleFull = settleFor(monthKey);
    var settle = {
      sales: settleFull.sales, varCost: settleFull.varCost, royF: settleFull.royF,
      royV: settleFull.royV, royVarDb: settleFull.royVarDb, adj: settleFull.adj,
      fixedSub: settleFull.fixedSub, costTotal: settleFull.costTotal,
      transfer: settleFull.transfer, transferEx: settleFull.transferEx, tax: settleFull.tax,
      ns: settleFull.ns, hasSales: settleFull.hasSales, count: settleFull.count
    };
    var sentInfo = (sentLog[sd_norm_(st.name)] || {})[monthKey] || null;
    var isIssued = (issued[sd_norm_(st.name)] || {})[monthKey] === true || !!sentInfo;

    // 売上照合: 売上シートの支払合計（実売上）と、精算書に入力された売上合計を突き合わせる
    var salesCheck = null;
    if (payMap) {
      var src = payMap[sd_norm_(st.salesName)];
      if (src != null) {
        salesCheck = {
          source: src,               // 売上シート S列 支払合計（実売上）
          entered: settle.sales,     // 精算書に入力された売上合計
          diff: settle.sales - src,  // ＋=精算書が多い ／ −=精算書が少ない（入力漏れの可能性）
          salesName: st.salesName
        };
      }
    }

    return {
      name: st.name, client: st.client, rate: st.rate,
      fixed: fixed,
      dbSheet: st.db ? st.db.sheet : '', hasDb: !!st.db,
      matrix: matrix,
      issued: (issued[sd_norm_(st.name)] || {}),
      detail: {
        rows: curRows, sales: settle.sales, cost: settle.costTotal, count: curRows.length,
        settle: settle,
        missing: chk.missing, catWarn: chk.catWarn,
        issuedThis: isIssued,
        sent: sentInfo, // {at, fileId, fileName, to} or null
        paid: paidByMonth[monthKey] || null, // {done, date, by} or null
        locked: !!(paidByMonth[monthKey] && paidByMonth[monthKey].done), // 振込済み＝編集ロック中
        salesCheck: salesCheck // {source, entered, diff, salesName} or null
      }
    };
  });

  timer.mark('storesLoop（' + stores.length + '店舗）');
  return {
    ver: SD_VERSION,
    user: { name: user.name, role: user.role },
    month: monthKey,
    monthLabel: sd_monthLabel_(monthKey),
    months: months,
    stores: stores,
    corps: corps, // 法人名(正規化) → {account, note}
    kubunOptions: Object.keys(kubunSet),
    taxOptions: SD_TAX_OPTIONS,
    accountOptions: SD_ACCOUNT_LIST, // A-9: 勘定科目の選択肢（明細を入力タブの科目列で使用）
    sheetUrl: user.role === '本部' ? ss.getUrl() : '',
    updatedAt: Utilities.formatDate(new Date(), SD_TZ, 'yyyy-MM-dd HH:mm'),
    _ms: timer.breakdown()
  };
}

/* ---------- API: 明細追加（本部のみ） ---------- */

/* 簡易タイマー: どの処理に時間がかかっているか計測してレスポンスに含める（速度計測用）。
 * 本番運用の妨げにならないよう、計算コストはほぼゼロ（Date.now()呼び出しのみ）。 */
function sd_timer_() {
  var t0 = Date.now(), last = t0, marks = [];
  return {
    mark: function (label) { var now = Date.now(); marks.push([label, now - last]); last = now; },
    breakdown: function () {
      var obj = {}; marks.forEach(function (m) { obj[m[0]] = m[1]; });
      obj.total = Date.now() - t0; return obj;
    }
  };
}

function sd_addRows(token, payload) {
  var timer = sd_timer_();
  var user = sd_auth_(token, true);
  timer.mark('auth');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  timer.mark('lockWait');
  try {
    var det = sd_detect_();
    var master = sd_masterStores_(det);
    var cfg = sd_config_(master, det);
    timer.mark('detectSheets');
    var st = null;
    cfg.forEach(function (s) { if (s.name === payload.store) st = s; });
    if (!st) throw new Error('店舗が見つかりません: ' + payload.store);
    if (!st.db) throw new Error('店舗「' + payload.store + '」のDBシートが見つかりません。「' + SD_CONFIG_SHEET + '」で指定してください。');
    sd_requireUnlocked_(user, payload.store, payload.month);

    var ymDate = sd_monthKeyToDate_(payload.month);
    var rows = (payload.rows || []).filter(function (r) { return String(r.item || '').trim(); });
    if (!rows.length) throw new Error('明細が入力されていません');
    rows.forEach(function (r) {
      if (r.amount === '' || r.amount == null || isNaN(Number(r.amount))) {
        throw new Error('金額が数値ではありません: ' + r.item);
      }
    });

    if (!payload.force) {
      var existing = sd_readRows_(st.db).filter(function (r) { return r.ym === payload.month; });
      timer.mark('dupCheckRead');
      var dups = [];
      rows.forEach(function (r) {
        var hit = existing.some(function (e) {
          return sd_norm_(e.item) === sd_norm_(r.item) && Number(e.amount) === Number(r.amount);
        });
        if (hit) dups.push(r.item + '（¥' + Number(r.amount).toLocaleString() + '）');
      });
      if (dups.length) return { ok: false, dup: dups, _ms: timer.breakdown() };
    }

    sd_ensureCategoryCols_(st.db);
    var added = sd_appendRows_(st.db, ymDate, rows, payload.editor || user.name);
    timer.mark('write');
    sd_clearRowsCache_(st.db.sheet);
    timer.mark('cacheClear');
    return { ok: true, added: added, sheet: st.db.sheet, month: payload.month, _ms: timer.breakdown() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- API: 明細修正（本部のみ） ----------
 * 誤修正防止のため、元の費目名・金額が一致するかをサーバー側でも検証してから上書きする。
 * 修正日はDBの「修正日」列（無ければ自動作成）に記録される。 */
function sd_updateRow(token, payload) {
  // payload = { store, row, orig:{item, amount}, kubun, item, amount, tax, note }
  var timer = sd_timer_();
  var user = sd_auth_(token, true);
  timer.mark('auth');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  timer.mark('lockWait');
  try {
    var det = sd_detect_();
    var cfg = sd_config_(sd_masterStores_(det), det);
    var st = null;
    cfg.forEach(function (s) { if (s.name === payload.store) st = s; });
    if (!st || !st.db) throw new Error('店舗のDBシートが見つかりません: ' + payload.store);
    var sh = SpreadsheetApp.getActive().getSheetByName(st.db.sheet);
    var cm = st.db.colMap;
    var row = Number(payload.row);
    if (!row || row <= st.db.headerRow) throw new Error('行番号が不正です');
    timer.mark('detectSheets');

    // 修正日列が無ければヘッダー行に自動作成（列幅が変わるので、行の一括読み込みより先に確定させる）
    if (!cm.edited) {
      var width0 = 0;
      Object.keys(cm).forEach(function (k) { if (cm[k] > width0) width0 = cm[k]; });
      sh.getRange(st.db.headerRow, width0 + 1).setValue('修正日');
      cm.edited = width0 + 1;
    }
    sd_ensureCategoryCols_(st.db); // 勘定科目・補助科目列も同様に自動作成（A-9）
    var width = 0;
    Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });

    // 行全体を1回で読み込む（セルごとに読むと通信回数が増えて遅くなるため）
    var rowRange = sh.getRange(row, 1, 1, width);
    var vals = rowRange.getValues()[0];
    var disp = rowRange.getDisplayValues()[0];
    timer.mark('readRow');

    // 元データの一致確認（他の人が同時に編集した場合の誤上書き防止）
    var curItem = String(disp[cm.item - 1]).trim();
    var curAmtRaw = vals[cm.amount - 1];
    var curAmt = (typeof curAmtRaw === 'number') ? curAmtRaw
      : Number(String(curAmtRaw).replace(/[¥￥,，\s]/g, '')) || 0;
    if (sd_norm_(curItem) !== sd_norm_(payload.orig.item) || Math.round(curAmt) !== Math.round(Number(payload.orig.amount))) {
      throw new Error('この行は別の場所で変更されています。再読込してからもう一度修正してください（現在: ' + curItem + ' ¥' + curAmt.toLocaleString() + '）');
    }
    // 対象行の年月を読み、その月が振込済みならマスター以外は編集不可
    var rowYm = '';
    var ymRaw = vals[cm.ym - 1];
    if (ymRaw instanceof Date) rowYm = sd_fmtMonth_(ymRaw);
    else {
      var mm = String(disp[cm.ym - 1]).match(/(\d{4})[\/\-年.](\d{1,2})/);
      if (mm) rowYm = mm[1] + '-' + ('0' + mm[2]).slice(-2);
    }
    if (rowYm) sd_requireUnlocked_(user, payload.store, rowYm);
    var newItem = String(payload.item || '').trim();
    if (!newItem) throw new Error('費目名が空です');
    var newAmt = Number(String(payload.amount).replace(/[¥￥,，\s]/g, ''));
    if (isNaN(newAmt)) throw new Error('金額が数値ではありません');

    // 変更するセルだけ書き換えて、行全体を1回で書き戻す
    vals[cm.kubun - 1] = payload.kubun || '変動費';
    vals[cm.item - 1] = newItem;
    vals[cm.amount - 1] = newAmt;
    if (cm.tax) vals[cm.tax - 1] = payload.tax || '10%';
    if (cm.note) vals[cm.note - 1] = String(payload.note || '');
    if (cm.account) vals[cm.account - 1] = String(payload.account || '');
    if (cm.subAccount) vals[cm.subAccount - 1] = String(payload.subAccount || '');
    vals[cm.edited - 1] = Utilities.formatDate(new Date(), SD_TZ, 'M/d') + ' ' + user.name;
    rowRange.setValues([vals]);
    timer.mark('write');
    sd_clearRowsCache_(st.db.sheet);
    timer.mark('cacheClear');
    return { ok: true, row: row, item: newItem, _ms: timer.breakdown() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- API: 明細削除（本部/マスター。振込済みロック中はマスターのみ） ----------
 * 誤削除防止のため、削除前に元の費目名・金額が一致するかをサーバー側でも検証する。 */
function sd_deleteRow(token, payload) {
  // payload = { store, row, orig:{item, amount} }
  var timer = sd_timer_();
  var user = sd_auth_(token, true);
  timer.mark('auth');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  timer.mark('lockWait');
  try {
    var det = sd_detect_();
    var cfg = sd_config_(sd_masterStores_(det), det);
    var st = null;
    cfg.forEach(function (s) { if (s.name === payload.store) st = s; });
    if (!st || !st.db) throw new Error('店舗のDBシートが見つかりません: ' + payload.store);
    var sh = SpreadsheetApp.getActive().getSheetByName(st.db.sheet);
    var cm = st.db.colMap;
    var row = Number(payload.row);
    if (!row || row <= st.db.headerRow) throw new Error('行番号が不正です');
    timer.mark('detectSheets');

    // 行全体を1回で読み込む（セルごとに読むと通信回数が増えて遅くなるため）
    var width = 0;
    Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
    var rowRange = sh.getRange(row, 1, 1, width);
    var vals = rowRange.getValues()[0];
    var disp = rowRange.getDisplayValues()[0];
    timer.mark('readRow');

    // 元データの一致確認（他の人が同時に編集した場合の誤削除防止）
    var curItem = String(disp[cm.item - 1]).trim();
    var curAmtRaw = vals[cm.amount - 1];
    var curAmt = (typeof curAmtRaw === 'number') ? curAmtRaw
      : Number(String(curAmtRaw).replace(/[¥￥,，\s]/g, '')) || 0;
    if (sd_norm_(curItem) !== sd_norm_(payload.orig.item) || Math.round(curAmt) !== Math.round(Number(payload.orig.amount))) {
      throw new Error('この行は別の場所で変更されています。再読込してからもう一度削除してください（現在: ' + curItem + ' ¥' + curAmt.toLocaleString() + '）');
    }
    // 対象行の年月を読み、その月が振込済みならマスター以外は削除不可
    var rowYm = '';
    var ymRaw = vals[cm.ym - 1];
    if (ymRaw instanceof Date) rowYm = sd_fmtMonth_(ymRaw);
    else {
      var mm = String(disp[cm.ym - 1]).match(/(\d{4})[\/\-年.](\d{1,2})/);
      if (mm) rowYm = mm[1] + '-' + ('0' + mm[2]).slice(-2);
    }
    if (rowYm) sd_requireUnlocked_(user, payload.store, rowYm);

    sh.deleteRow(row);
    timer.mark('deleteRow');
    sd_clearRowsCache_(st.db.sheet);
    sd_log_('明細削除', payload.store, rowYm, curItem + '（¥' + curAmt.toLocaleString() + '）', '', '', user.name, '');
    timer.mark('log');
    return { ok: true, item: curItem, amount: curAmt, _ms: timer.breakdown() };
  } finally {
    lock.releaseLock();
  }
}

/* ================== A-9: 勘定科目・補助科目→PL自動連携（2026-08-31追加） ==================
 * 設計書_広告費自動連携と精算書PL科目連携_2026-08-31.md §2・§4。
 * 精算書の明細に勘定科目・補助科目を付け、tori-dashboard側のsyncSeisanCategoriesToPl
 * （PL_SYNC_TOKEN認証・sd_apiCategorizedLinesを呼ぶ）がDB_PLへ自動計上する。
 * 科目リストはtori-dashboard/app.jsのPL_ITEM_CATと同じ24科目（勘定科目の区分＝S/F/L/A/R/O/Xの
 * 判定はtori-dashboard側が担当するため、こちら側は科目名の一覧だけ持てば十分）。
 * 「対象外」はPLに送らない明細（固定ロイヤリティ等）用の特別値。「運営委託費」は既存の
 * syncSeisanFeeToPl（業務委託費の自動連携）と役割が重なるため、一覧には残すが同期側で除外される。
 * ※ tori-dashboard/app.jsのPL_ITEM_CATを変更した場合はこちらも手動で合わせること（自動同期はしない
 * ＝ほぼ変わらない固定リストのため、常時同期の仕組みを作るのは過剰実装と判断）。 */
var SD_ACCOUNT_LIST = [
  '対象外',
  '役員報酬', '法定福利費', '通勤手当', '旅費交通費', '賞与積立', '退職金等',
  '家賃', 'リース料', '家賃更新按分', '広告宣伝費', '販売促進費',
  '水道光熱費', '通信費', '消耗品・備品費', '修繕費', '衛生管理費', 'カード手数料', '支払手数料',
  '支払報酬料', '採用教育費', '接待交際費', '会議費', '慶弔見舞費', '保険料', '租税公課',
  '減価償却費', '福利厚生費', '諸会費', '雑費', '本部経費（按分）',
  'その他売上', '銀行返済', '仕入（食材・飲料）', '運営委託費'
];
/* 費目名からの科目推定（「既定値の自動提案」①項目名からの推定）。よくある表記のキーワード一致のみ。
 * ここに無ければ提案なし（空欄のまま・人が選ぶ）＝過剰な誤爆推定はしない。 */
var SD_ACCOUNT_GUESS_ = [
  [/電気|ガス|水道/, '水道光熱費'], [/インターネット|電話|通信|プロバイダ/, '通信費'],
  [/家賃|賃料/, '家賃'], [/リース/, 'リース料'],
  [/広告|求人|採用媒体/, '広告宣伝費'], [/販促|クーポン|チラシ/, '販売促進費'],
  [/仕入|食材|飲料|GOSSO/, '仕入（食材・飲料）'], [/清掃|衛生|害虫/, '衛生管理費'],
  [/修繕|修理/, '修繕費'], [/カード手数料|決済手数料/, 'カード手数料'], [/振込手数料|銀行手数料/, '支払手数料'],
  [/税理士|社労士|顧問料|報酬/, '支払報酬料'], [/研修|教育/, '採用教育費'],
  [/接待|交際/, '接待交際費'], [/会議|打合せ/, '会議費'], [/保険/, '保険料'],
  [/租税|税金|印紙/, '租税公課'], [/福利厚生/, '福利厚生費'], [/会費/, '諸会費'],
  [/消耗品|備品/, '消耗品・備品費']
];
function sd_guessAccount_(item) {
  var s = String(item || '');
  for (var i = 0; i < SD_ACCOUNT_GUESS_.length; i++) if (SD_ACCOUNT_GUESS_[i][0].test(s)) return SD_ACCOUNT_GUESS_[i][1];
  return '';
}
/* 勘定科目・補助科目列（無ければヘッダー行の末尾に自動作成）。sd_updateRowの「修正日列が無ければ
 * 自動作成」と同じ自己修復パターン。書き込み系API（sd_addRows/sd_updateRow/sd_bulkAdd/
 * sd_bulkCategorize）から呼ぶこと。 */
function sd_ensureCategoryCols_(db) {
  var cm = db.colMap;
  if (cm.account && cm.subAccount) return;
  var sh = SpreadsheetApp.getActive().getSheetByName(db.sheet);
  var width = 0;
  Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
  if (!cm.account) { width++; sh.getRange(db.headerRow, width).setValue('勘定科目'); cm.account = width; }
  if (!cm.subAccount) { width++; sh.getRange(db.headerRow, width).setValue('補助科目'); cm.subAccount = width; }
}
/* 「既定値の自動提案」②前月の同項目の科目を引き継ぐ。直近で同じ費目名に付けた科目・補助科目を
 * そのDBシートの全行から探す（月をまたいでも一番新しい行を優先＝実質「前回選んだもの」）。 */
function sd_suggestAccount(token, store, item) {
  sd_auth_(token, true);
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var st = null;
  cfg.forEach(function (s) { if (s.name === store) st = s; });
  if (!st || !st.db) return { account: sd_guessAccount_(item), subAccount: '', source: 'guess' };
  var rows = sd_readRows_(st.db).filter(function (r) { return sd_norm_(r.item) === sd_norm_(item) && r.account && r.account !== '対象外'; });
  if (rows.length) {
    // rowはシート上の行番号順（＝入力順）で並んでいるはずなので、末尾＝最新とみなす
    var last = rows[rows.length - 1];
    return { account: last.account, subAccount: last.subAccount || '', source: 'history' };
  }
  var guess = sd_guessAccount_(item);
  return { account: guess, subAccount: '', source: guess ? 'guess' : 'none' };
}
/* さかのぼり付与モード（Q4確定仕様）: 指定店舗・期間内の「勘定科目が空の行」に、既定値の自動提案
 * （履歴引き継ぎ→キーワード推定の順）をまとめて書き込む。判定に迷う行（提案が無い行）は空欄のまま
 * 残し、人が「明細を入力」画面の✏修正から確認・修正する（＝全自動で確定させない）。 */
function sd_bulkCategorize(token, payload) {
  var user = sd_auth_(token, true);
  var storeName = String((payload || {}).store || '').trim();
  var fromMonth = String((payload || {}).fromMonth || '').trim();
  var toMonth = String((payload || {}).toMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) throw new Error('対象期間が不正です');
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var targets = storeName ? cfg.filter(function (s) { return s.name === storeName; }) : cfg;
  if (storeName && !targets.length) throw new Error('店舗が見つかりません: ' + storeName);
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var results = [];
    targets.forEach(function (st) {
      if (!st.db) { results.push(st.name + ': DBシート未検出のためスキップ'); return; }
      sd_ensureCategoryCols_(st.db);
      var sh = SpreadsheetApp.getActive().getSheetByName(st.db.sheet);
      var cm = st.db.colMap;
      var rows = sd_readRows_(st.db).filter(function (r) { return r.ym >= fromMonth && r.ym <= toMonth; });
      // 履歴引き継ぎは「その時点までに確定している一番新しい科目」を使う（月の並び順どおりに処理）。
      var lastAccountByItem = {};
      // 期間より前の既存の科目も引き継ぎ元にする
      sd_readRows_(st.db).filter(function (r) { return r.ym < fromMonth && r.account && r.account !== '対象外'; })
        .forEach(function (r) { lastAccountByItem[sd_norm_(r.item)] = { account: r.account, subAccount: r.subAccount }; });
      var filled = 0, skipped = 0;
      rows.sort(function (a, b) { return a.row - b.row; }).forEach(function (r) {
        if (r.account) { // 既に付いている行は履歴の元として使うだけ・上書きしない
          if (r.account !== '対象外') lastAccountByItem[sd_norm_(r.item)] = { account: r.account, subAccount: r.subAccount };
          skipped++; return;
        }
        var key = sd_norm_(r.item);
        var pick = lastAccountByItem[key] || (sd_guessAccount_(r.item) ? { account: sd_guessAccount_(r.item), subAccount: '' } : null);
        if (!pick) { skipped++; return; }
        sh.getRange(r.row, cm.account).setValue(pick.account);
        if (pick.subAccount) sh.getRange(r.row, cm.subAccount).setValue(pick.subAccount);
        lastAccountByItem[key] = pick;
        filled++;
      });
      if (filled) sd_clearRowsCache_(st.db.sheet);
      results.push(st.name + ': ' + filled + '件に科目を付与（' + skipped + '件はスキップ＝既に科目あり or 提案なし）');
    });
    sd_log_('さかのぼり科目付与', storeName || '全店', fromMonth + '〜' + toMonth, results.join(' / '), '', '', user.name, '');
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}
/* tori-dashboardのsyncSeisanCategoriesToPlから呼ばれる専用API（PL_SYNC_TOKEN認証・
 * sd_apiTransferExと同じ方式）。指定店舗・月の明細を勘定科目×補助科目で集計して返す。
 * 「対象外」「運営委託費」（＝既存のsyncSeisanFeeToPl連携と役割が重複）は除外する
 * （設計書§4「新連携は対象外・運営委託費以外の科目のみを送る」）。
 * 未確定の金額を送らないよう、sd_apiTransferExと同じく振込済み（sd_isLocked_）の月だけを対象にする。 */
function sd_apiCategorizedLines(token, store, monthKey) {
  var tk = PropertiesService.getScriptProperties().getProperty('PL_SYNC_TOKEN');
  var got = String(token || '').trim(), want = String(tk || '').trim();
  if (!tk || got !== want) throw new Error('unauthorized');
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var st = null;
  cfg.forEach(function (s) { if (s.name === store) st = s; });
  if (!st) return { found: false, reason: '店舗マスタに「' + store + '」という名前が見つかりません' };
  if (!st.db) return { found: false, reason: 'データシートが自動特定できていません' };
  var rows = sd_readRows_(st.db).filter(function (r) { return r.ym === monthKey; });
  if (!rows.length) return { found: true, hasSales: false, reason: monthKey + '分の明細が0件でした' };
  var paid = sd_isLocked_(store, monthKey);
  if (!paid) return { found: true, hasSales: true, paid: false, reason: monthKey + '分はまだ振込済みではありません（未確定のためPL反映対象外）', lines: [] };
  var taxRate = { '10%': 1.1, '8%': 1.08, '非課税': 1 };
  var agg = {};
  rows.forEach(function (r) {
    var account = String(r.account || '').trim();
    if (!account || account === '対象外' || account === '運営委託費') return;
    var sub = String(r.subAccount || '').trim();
    var rate = taxRate[sd_norm_(r.tax)] || 1.1;
    var key = account + '\t' + sub;
    agg[key] = (agg[key] || 0) + (Number(r.amount) || 0) / rate;
  });
  var lines = Object.keys(agg).map(function (k) {
    var p = k.split('\t');
    return { account: p[0], subAccount: p[1], amountEx: Math.round(agg[k]) };
  });
  return { found: true, hasSales: true, paid: true, lines: lines };
}

/* DBシートへの行追加（共通） */
function sd_appendRows_(db, ymDate, rows, editor) {
  var sh = SpreadsheetApp.getActive().getSheetByName(db.sheet);
  var cm = db.colMap, hr = db.headerRow;
  var width = 0;
  Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
  var lastR = sh.getLastRow();
  var lastData = hr;
  if (lastR > hr) {
    var vals = sh.getRange(hr + 1, 1, lastR - hr, width).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var v = vals[i];
      if (v[cm.ym - 1] || String(v[cm.item - 1]).trim() || String(v[cm.kubun - 1]).trim()) {
        lastData = hr + 1 + i;
        break;
      }
    }
  }
  var atStr = Utilities.formatDate(new Date(), SD_TZ, 'M/d');
  var out = rows.map(function (r) {
    var arr = [];
    for (var c = 0; c < width; c++) arr.push('');
    arr[cm.ym - 1] = ymDate;
    arr[cm.kubun - 1] = r.kubun || '変動費';
    arr[cm.item - 1] = String(r.item).trim();
    arr[cm.amount - 1] = Number(r.amount);
    if (cm.tax) arr[cm.tax - 1] = r.tax || '10%';
    if (cm.note) arr[cm.note - 1] = String(r.note || '');
    if (cm.editor) arr[cm.editor - 1] = String(editor || '');
    if (cm.at) arr[cm.at - 1] = atStr;
    if (cm.account) arr[cm.account - 1] = String(r.account || '');
    if (cm.subAccount) arr[cm.subAccount - 1] = String(r.subAccount || '');
    return arr;
  });
  sh.getRange(lastData + 1, 1, out.length, width).setValues(out);
  return out.length;
}

/* ---------- ① 現金売上の自動取込 ---------- */

function sd_cashPreview(token, monthKey) {
  var user = sd_auth_(token, true);
  var ext = sd_extConfig_();
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var sums = sd_cashSums_(ext, monthKey, cfg);
  var out = cfg.map(function (st) {
    var rows = st.db ? sd_readRows_(st.db).filter(function (r) {
      return r.ym === monthKey && sd_norm_(r.kubun) === '売上' && sd_norm_(r.item).indexOf('現金売上') > -1;
    }) : [];
    return {
      store: st.name,
      salesName: st.salesName,
      amount: sums[sd_norm_(st.salesName)] != null ? sums[sd_norm_(st.salesName)] : null,
      days: sums['days_' + sd_norm_(st.salesName)] || 0,
      already: rows.length ? rows.map(function (r) { return r.item + '（¥' + r.amount.toLocaleString() + '）'; }) : []
    };
  });
  return { month: monthKey, monthLabel: sd_monthLabel_(monthKey), items: out };
}

function sd_cashApply(token, monthKey, storeNames) {
  var user = sd_auth_(token, true);
  // 振込済みの店舗はマスター以外は対象外にする（エラーにせずスキップ）
  var skipped = [];
  if (user.role !== 'マスター') {
    var allowed = [];
    (storeNames || []).forEach(function (nm) {
      if (sd_isLocked_(nm, monthKey)) skipped.push(nm + ': 🔒振込済みのためスキップ');
      else allowed.push(nm);
    });
    storeNames = allowed;
    if (!storeNames.length) return { ok: true, results: skipped.length ? skipped : ['対象店舗がありません'] };
  }
  var res = sd_cashApplyCore_(monthKey, storeNames, user.name, false);
  res.results = skipped.concat(res.results);
  return res;
}

/* 現金売上の取込コア（手動API・自動トリガーの両方から使用）。
 * storeNames が null の場合は全店舗を対象にする。
 * skipIfExists=true のときは、既に現金売上が入っている月・店舗はスキップ（自動取込の二重登録防止）。 */
function sd_cashApplyCore_(monthKey, storeNames, editorName, skipIfExists) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ext = sd_extConfig_();
    var det = sd_detect_();
    var cfg = sd_config_(sd_masterStores_(det), det);
    var sums = sd_cashSums_(ext, monthKey, cfg);
    var d = sd_monthKeyToDate_(monthKey);
    var results = [];
    cfg.forEach(function (st) {
      if (storeNames && storeNames.indexOf(st.name) < 0) return;
      if (!st.db) { results.push(st.name + ': DBシート未検出'); return; }
      var existingCashRows = sd_readRows_(st.db).filter(function (r) {
        return r.ym === monthKey && sd_norm_(r.kubun) === '売上' && sd_norm_(r.item).indexOf('現金売上') > -1;
      });
      if (skipIfExists) {
        if (existingCashRows.length) { results.push(st.name + ': 既に現金売上あり（スキップ）'); return; }
      }
      var amt = sums[sd_norm_(st.salesName)];
      if (amt == null) { results.push(st.name + ': 売上シートにデータなし'); return; }
      var item = (d.getMonth() + 1) + '月現金売上';
      if (existingCashRows.length) {
        // 既に現金売上の行があれば、新規追加せず上書き更新する（重複防止）
        sd_updateCashRow_(st.db, existingCashRows[0].row, item, amt, editorName);
        sd_clearRowsCache_(st.db.sheet);
        var dupNote = existingCashRows.length > 1 ? '　※他に' + (existingCashRows.length - 1) + '件の重複行あり・要確認' : '';
        results.push(st.name + ': ¥' + amt.toLocaleString() + ' に更新' + dupNote);
        return;
      }
      sd_appendRows_(st.db, d, [{
        kubun: '売上', item: item, amount: amt, tax: '10%',
        note: '分析_日別店舗より自動取込'
      }], editorName);
      sd_clearRowsCache_(st.db.sheet);
      results.push(st.name + ': ¥' + amt.toLocaleString() + ' を登録');
    });
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

/* 既存の現金売上行を上書き更新（現金取込の再実行で重複行が増えないようにするため） */
function sd_updateCashRow_(db, row, item, amt, editorName) {
  var sh = SpreadsheetApp.getActive().getSheetByName(db.sheet);
  var cm = db.colMap;
  if (!cm.edited) {
    var width = 0;
    Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
    sh.getRange(db.headerRow, width + 1).setValue('修正日');
    cm.edited = width + 1;
  }
  sh.getRange(row, cm.item).setValue(item);
  sh.getRange(row, cm.amount).setValue(amt);
  if (cm.note) sh.getRange(row, cm.note).setValue('分析_日別店舗より自動取込（更新）');
  if (cm.editor) sh.getRange(row, cm.editor).setValue(String(editorName || ''));
  if (cm.at) sh.getRange(row, cm.at).setValue(Utilities.formatDate(new Date(), SD_TZ, 'M/d'));
  sh.getRange(row, cm.edited).setValue(Utilities.formatDate(new Date(), SD_TZ, 'M/d') + ' ' + (editorName || ''));
}

function sd_cashSums_(ext, monthKey, cfg) {
  var sid = ext['売上スプレッドシートID'];
  if (!sid) throw new Error('設定_外部連携 に売上スプレッドシートIDがありません');
  var ss;
  try { ss = SpreadsheetApp.openById(sid); }
  catch (e) { throw new Error('売上スプレッドシートを開けません。共有設定を確認してください（' + e.message + '）'); }
  var sh = ss.getSheetByName(ext['売上シート名'] || '分析_日別店舗');
  if (!sh) throw new Error('売上シート「' + (ext['売上シート名'] || '分析_日別店舗') + '」が見つかりません');
  var cDate = sd_colLetterToNum_(ext['売上_日付列'] || 'A');
  var cStore = sd_colLetterToNum_(ext['売上_店舗名列'] || 'J');
  var cCash = sd_colLetterToNum_(ext['売上_現金列'] || 'T');
  var lastR = sh.getLastRow();
  var width = Math.max(cDate, cStore, cCash);
  var wanted = {};
  cfg.forEach(function (st) { wanted[sd_norm_(st.salesName)] = true; });
  var mDate = sd_monthKeyToDate_(monthKey);
  var y = mDate.getFullYear(), mo = mDate.getMonth();
  var sums = {};
  var CHUNK = 5000;
  for (var start = 2; start <= lastR; start += CHUNK) {
    var n = Math.min(CHUNK, lastR - start + 1);
    var vals = sh.getRange(start, 1, n, width).getValues();
    for (var i = 0; i < vals.length; i++) {
      var dt = vals[i][cDate - 1];
      if (!(dt instanceof Date) || dt.getFullYear() !== y || dt.getMonth() !== mo) continue;
      var nm = sd_norm_(vals[i][cStore - 1]);
      if (!wanted[nm]) continue;
      var v = Number(vals[i][cCash - 1]) || 0;
      sums[nm] = (sums[nm] || 0) + v;
      sums['days_' + nm] = (sums['days_' + nm] || 0) + (v !== 0 ? 1 : 0);
    }
  }
  Object.keys(sums).forEach(function (k) {
    if (k.indexOf('days_') !== 0) sums[k] = Math.round(sums[k]);
  });
  return sums;
}

/* ---------- 売上照合（S列 支払合計 の月合計を店舗別に集計） ----------
 * 精算書に入力された売上合計と、売上シート側の実売上（支払合計）を突き合わせる指標。
 * 月切替のたびに呼ばれるので CacheService に10分キャッシュ。 */
function sd_paySums_(ext, monthKey, cfg) {
  var sid = ext['売上スプレッドシートID'];
  if (!sid) return null; // 売上シート未設定なら照合しない
  var ss;
  try { ss = SpreadsheetApp.openById(sid); } catch (e) { return null; }
  var sh = ss.getSheetByName(ext['売上シート名'] || '分析_日別店舗');
  if (!sh) return null;
  var cDate = sd_colLetterToNum_(ext['売上_日付列'] || 'A');
  var cStore = sd_colLetterToNum_(ext['売上_店舗名列'] || 'J');
  var cPay = sd_colLetterToNum_(ext['売上_支払合計列'] || 'S');
  var lastR = sh.getLastRow();
  var width = Math.max(cDate, cStore, cPay);
  var wanted = {};
  cfg.forEach(function (st) { wanted[sd_norm_(st.salesName)] = true; });
  var mDate = sd_monthKeyToDate_(monthKey);
  var y = mDate.getFullYear(), mo = mDate.getMonth();
  var sums = {};
  var CHUNK = 5000;
  for (var start = 2; start <= lastR; start += CHUNK) {
    var n = Math.min(CHUNK, lastR - start + 1);
    var vals = sh.getRange(start, 1, n, width).getValues();
    for (var i = 0; i < vals.length; i++) {
      var dt = vals[i][cDate - 1];
      if (!(dt instanceof Date) || dt.getFullYear() !== y || dt.getMonth() !== mo) continue;
      var nm = sd_norm_(vals[i][cStore - 1]);
      if (!wanted[nm]) continue;
      sums[nm] = (sums[nm] || 0) + (Number(vals[i][cPay - 1]) || 0);
    }
  }
  Object.keys(sums).forEach(function (k) { sums[k] = Math.round(sums[k]); });
  return sums;
}

function sd_paySumsCached_(ext, monthKey, cfg) {
  if (!ext['売上スプレッドシートID']) return null;
  var cache = CacheService.getScriptCache();
  var key = 'sdpay_' + monthKey;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 読み直す */ } }
  var sums = sd_paySums_(ext, monthKey, cfg);
  if (sums) { try { cache.put(key, JSON.stringify(sums), 600); } catch (e) { /* 無視 */ } }
  return sums;
}

/* ---------- ② PDFプレビュー／メール送信／翌月準備 ---------- */

function sd_sendSheetInfo_(det) {
  if (!det.sendSheet) throw new Error('精算書の送付シート（「★ 店舗を選択」があるシート）が見つかりません');
  var sh = SpreadsheetApp.getActive().getSheetByName(det.sendSheet.sheet);
  var rows = Math.min(sh.getLastRow(), 15);
  var cols = Math.min(sh.getLastColumn(), 12);
  var vals = sh.getRange(1, 1, rows, cols).getDisplayValues();
  var info = { sheet: sh, gid: sh.getSheetId(), storeCell: null, monthCell: null, titleRow: 0 };
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var t = sd_norm_(vals[r][c]);
      if (!info.storeCell && t.indexOf('★店舗を選択') > -1) info.storeCell = [r + 1, c + 2];
      if (!info.monthCell && t.indexOf('★対象月を選択') > -1) info.monthCell = [r + 1, c + 2];
      if (!info.titleRow && String(vals[r][c]).indexOf('業務委託精算書') > -1) info.titleRow = r + 1;
    }
  }
  if (!info.storeCell || !info.monthCell) throw new Error('送付シートの「★ 店舗を選択」「★ 対象月を選択」セルが見つかりません');
  if (!info.titleRow) info.titleRow = Math.max(info.monthCell[0] + 2, 7);
  return info;
}

/* ---------- 精算書PDFの自前生成（ダッシュボードの正しい計算から） ----------
 * 既存の「精算書 送付」シートの数式に依存せず、DBを直接集計してHTML→PDF化。
 * これにより売上明細が何件でも正確に反映され、空欄も出ない。
 */
function sd_escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function sd_yen_(n) { return '¥' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

function sd_buildSeisanHtml_(store, monthKey) {
  var det = sd_detect_();
  var ext = sd_extConfig_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var st = null;
  cfg.forEach(function (s) { if (s.name === store) st = s; });
  if (!st) throw new Error('店舗が見つかりません: ' + store);
  if (!st.db) throw new Error('店舗「' + store + '」のDBシートが見つかりません');

  var rows = sd_readRowsCached_(st.db);
  var s = sd_settle_(rows, monthKey, st.rate, st.fixed);
  var d = sd_monthKeyToDate_(monthKey);
  var monthLabel = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
  var today = Utilities.formatDate(new Date(), SD_TZ, 'yyyy/M/d');

  function taxDisp(t) { t = sd_norm_(t); return t || '10%'; }
  function rowsHtml(list) {
    return list.map(function (r) {
      return '<tr><td>' + sd_escHtml_(r.item) + '</td>'
        + '<td class="num">' + sd_yen_(r.amount) + '</td>'
        + '<td class="c">' + sd_escHtml_(taxDisp(r.tax)) + '</td>'
        + '<td>' + sd_escHtml_(r.note || '') + '</td></tr>';
    }).join('');
  }
  var f = st.fixed || {};
  var fixedRows = '';
  function fr(label, v) { return v ? '<tr><td>' + label + '</td><td class="num">' + sd_yen_(v) + '</td></tr>' : ''; }
  fixedRows += fr('家賃', f.rent);
  fixedRows += fr('物件保険料', f.ins);
  fixedRows += fr('SSS経理処理手数料', f.sss);
  fixedRows += fr('固定④', f.f4);
  fixedRows += fr('固定⑤', f.f5);
  if (s.adj) fixedRows += '<tr><td>固定調整額</td><td class="num">' + sd_yen_(s.adj) + '</td></tr>';

  var html =
  '<html><head><meta charset="utf-8"><style>'
  + '@page{size:A4 portrait;margin:8mm;}'
  + '*{box-sizing:border-box;}'
  + 'body{font-family:"Noto Sans JP","Hiragino Sans",sans-serif;color:#1a1a1a;background:#ffffff;font-size:9.5px;margin:0;padding:0;}'
  + '.sheet{width:100%;}'
  + 'h1{font-size:16px;text-align:center;margin:0 0 3px;letter-spacing:2px;}'
  + '.sub{text-align:center;color:#555;font-size:11px;margin-bottom:8px;}'
  + '.parties{width:100%;border-collapse:collapse;margin-bottom:8px;}'
  + '.parties td{vertical-align:top;width:50%;padding:0 6px;font-size:9.5px;line-height:1.5;}'
  + '.parties .to{font-size:12px;font-weight:700;border-bottom:1px solid #333;padding-bottom:2px;margin-bottom:3px;}'
  + '.headline{background:#f0f4fb;border:1.5px solid #2f6fed;border-radius:5px;text-align:center;padding:7px;margin:6px 0 10px;}'
  + '.headline .lab{font-size:10px;color:#333;}'
  + '.headline .amt{font-size:22px;font-weight:800;color:#12336e;letter-spacing:1px;}'
  + '.cols{display:flex;gap:10px;align-items:flex-start;}'
  + '.cols>div{flex:1;min-width:0;}'
  + 'h2{font-size:10px;background:#2f3a4d;color:#fff;padding:3px 6px;margin:8px 0 0;border-radius:3px 3px 0 0;}'
  + 'table.detail{width:100%;border-collapse:collapse;margin-bottom:2px;}'
  + 'table.detail th{background:#eef1f5;font-size:8.5px;text-align:left;padding:2px 5px;border:1px solid #d7dce4;}'
  + 'table.detail td{padding:2px 5px;border:1px solid #e3e6ec;font-size:9px;}'
  + 'table.detail td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}'
  + 'table.detail td.c{text-align:center;}'
  + 'tr.sum td{font-weight:700;background:#f7f9fc;}'
  + '.summary{width:100%;border-collapse:collapse;margin-top:2px;}'
  + '.summary td{padding:3px 6px;border-bottom:1px solid #e3e6ec;}'
  + '.summary td.num{text-align:right;font-variant-numeric:tabular-nums;}'
  + '.summary tr.grand td{font-size:13px;font-weight:800;color:#12336e;border-top:2px solid #2f3a4d;border-bottom:none;background:#f0f4fb;}'
  + '.note{color:#888;font-size:8px;margin-top:10px;text-align:right;}'
  + '</style></head><body><div class="sheet">'
  + '<h1>業 務 委 託 精 算 書</h1>'
  + '<div class="sub">' + sd_escHtml_(store) + '　' + monthLabel + '分</div>'
  + '<table class="parties"><tr><td>'
  +   '<div class="to">' + sd_escHtml_(st.client || '') + '　御中</div>'
  +   (st.name ? sd_escHtml_(st.name) + '<br>' : '')
  +   (st.rep ? sd_escHtml_(st.rep) + '　様<br>' : '')
  +   (st.invoice ? sd_escHtml_(st.invoice) : '')
  + '</td><td>'
  +   '<div style="text-align:right">発行日：' + today + '</div>'
  +   '<b>' + sd_escHtml_(ext['発行元_会社名'] || '株式会社N-style') + '</b><br>'
  +   (ext['発行元_郵便番号'] ? '〒' + sd_escHtml_(ext['発行元_郵便番号']) + '<br>' : '')
  +   (ext['発行元_住所'] ? sd_escHtml_(ext['発行元_住所']) + '<br>' : '')
  +   (ext['発行元_電話'] ? '電話：' + sd_escHtml_(ext['発行元_電話']) + '<br>' : '')
  +   (ext['発行元_登録番号'] ? '登録番号：' + sd_escHtml_(ext['発行元_登録番号']) : '')
  + '</td></tr></table>'
  + '<div style="font-size:9.5px;margin-bottom:4px">下記のとおり清算のご報告を申し上げます。</div>'
  + '<div class="headline"><span class="lab">業務委託費（消費税込）　振込金額</span><br>'
  +   '<span class="amt">' + sd_yen_(s.transfer) + '</span></div>'
  + '<h2>売上（預かり金）</h2>'
  + '<table class="detail"><tr><th>費目名</th><th style="text-align:right">金額（税込）</th><th style="text-align:center">税率</th><th>備考</th></tr>'
  +   rowsHtml(s.salesRows)
  +   '<tr class="sum"><td>売上合計</td><td class="num">' + sd_yen_(s.sales) + '</td><td></td><td></td></tr>'
  + '</table>'
  + '<h2>変動費明細（入力データから自動）</h2>'
  + '<table class="detail"><tr><th>費目名</th><th style="text-align:right">金額（税込）</th><th style="text-align:center">税率</th><th>備考</th></tr>'
  +   (s.varRows.length ? rowsHtml(s.varRows) : '<tr><td colspan="4">なし</td></tr>')
  +   '<tr class="sum"><td>変動費 合計</td><td class="num">' + sd_yen_(s.varCost + s.royVarDb) + '</td><td></td><td></td></tr>'
  + '</table>'
  + '<div class="cols"><div>'
  +   '<h2>固定経費（店舗設定マスターから自動）</h2>'
  +   '<table class="detail">' + (fixedRows || '<tr><td colspan="2">なし</td></tr>')
  +     '<tr class="sum"><td>固定経費 小計</td><td class="num">' + sd_yen_(s.fixedSub) + '</td></tr>'
  +   '</table>'
  + '</div><div>'
  +   '<h2>精算集計</h2>'
  +   '<table class="summary">'
  +     '<tr><td>売上（預かり金）</td><td class="num">' + sd_yen_(s.sales) + '</td></tr>'
  +     '<tr><td>固定経費 小計</td><td class="num">' + sd_yen_(s.fixedSub) + '</td></tr>'
  +     '<tr><td>変動費 合計</td><td class="num">' + sd_yen_(s.varCost + s.royVarDb) + '</td></tr>'
  +     '<tr><td>固定ロイヤリティ</td><td class="num">' + sd_yen_(s.royF) + '</td></tr>'
  +     '<tr><td>ロイヤリティ（変動 ' + sd_escHtml_(st.rate) + '）</td><td class="num">' + sd_yen_(s.royV) + '</td></tr>'
  +     '<tr><td>経費合計</td><td class="num">' + sd_yen_(s.costTotal) + '</td></tr>'
  +     '<tr><td>業務委託費（税抜）</td><td class="num">' + sd_yen_(s.transferEx) + '</td></tr>'
  +     '<tr><td>消費税（10%）</td><td class="num">' + sd_yen_(s.tax) + '</td></tr>'
  +     '<tr class="grand"><td>振込金額（税込）</td><td class="num">' + sd_yen_(s.transfer) + '</td></tr>'
  +   '</table>'
  + '</div></div>'
  + (ext['発行元_振込先'] ? '<div style="margin-top:6px;font-size:9.5px">お振込先：' + sd_escHtml_(ext['発行元_振込先']) + '</div>' : '')
  + '<div class="note">本精算書は精算ダッシュボードから自動発行されました（' + today + '）</div>'
  + '</div></body></html>';
  return { html: html, settle: s };
}

function sd_renderPdf_(store, monthKey) {
  var built = sd_buildSeisanHtml_(store, monthKey);
  var fileName = '精算書_' + sd_monthDot_(monthKey) + '_' + store + '.pdf';
  var blob = Utilities.newBlob(built.html, 'text/html', 'seisan.html').getAs('application/pdf');
  return blob.setName(fileName);
}

function sd_pdfPreview(token, store, monthKey) {
  var user = sd_auth_(token, false);
  var det = sd_detect_();
  var cfg = sd_allowedStores_(user, sd_config_(sd_masterStores_(det), det));
  if (!cfg.some(function (s) { return s.name === store; })) throw new Error('この店舗の閲覧権限がありません');
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var blob = sd_renderPdf_(store, monthKey);
    return { fileName: blob.getName(), b64: Utilities.base64Encode(blob.getBytes()) };
  } finally {
    lock.releaseLock();
  }
}

function sd_mailSettings_(det, store) {
  if (!det.mailSheet) return null;
  var sh = SpreadsheetApp.getActive().getSheetByName(det.mailSheet.sheet);
  var hr = det.mailSheet.headerRow;
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  var header = sh.getRange(hr, 1, 1, lastC).getDisplayValues()[0].map(sd_norm_);
  var iName = header.indexOf('店舗名');
  var iTo = -1, iCc = -1, iSubj = -1, iBody = -1;
  header.forEach(function (h, i) {
    if (iTo < 0 && h.indexOf('To') === 0) iTo = i;
    if (iCc < 0 && h.indexOf('CC') === 0) iCc = i;
    if (iSubj < 0 && h.indexOf('件名') > -1) iSubj = i;
    if (iBody < 0 && h.indexOf('本文') > -1) iBody = i;
  });
  if (iName < 0 || iTo < 0) return null;
  var vals = sh.getRange(hr + 1, 1, lastR - hr, lastC).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (sd_norm_(vals[i][iName]) === sd_norm_(store)) {
      return {
        to: String(vals[i][iTo]).trim(),
        cc: iCc > -1 ? String(vals[i][iCc]).trim() : '',
        subject: iSubj > -1 ? String(vals[i][iSubj]).trim() : '',
        body: iBody > -1 ? String(vals[i][iBody]).trim() : ''
      };
    }
  }
  return null;
}

function sd_issueAndSend(token, store, monthKey, sendMail) {
  var user = sd_auth_(token, true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var det = sd_detect_();
    var ext = sd_extConfig_();

    // 既にメール送信済みなら「再送信」扱い（件名・PDF名に明記）
    var prev = (sd_sentMap_()[sd_norm_(store)] || {})[monthKey];
    var isResend = !!(sendMail && prev && prev.action === 'メール送信');

    var blob = sd_renderPdf_(store, monthKey);
    if (isResend) {
      blob.setName('精算書_' + sd_monthDot_(monthKey) + '_' + store + '_再送信.pdf');
    }

    // Driveへ保存: 親フォルダ/2026年6月/店舗名/
    var folder = sd_folderFor_(ext, monthKey, store);
    var file = folder.createFile(blob);
    var result = { ok: true, fileName: blob.getName(), fileId: file.getId(), url: file.getUrl(), mailed: false, resend: isResend };

    if (sendMail) {
      var ms = sd_mailSettings_(det, store);
      if (!ms || !ms.to) throw new Error('メール設定シートに「' + store + '」の宛先(To)がありません');
      var d = sd_monthKeyToDate_(monthKey);
      var mLabel = (d.getMonth() + 1) + '月';
      var subject = (ms.subject || '【重要】 〇月分業務委託料精算書のご送付').replace(/〇月/g, mLabel);
      var body = (ms.body || '').replace(/〇月/g, mLabel);
      if (isResend) {
        subject = '【再送信】' + subject;
        body = '※本メールは、内容修正に伴う精算書の再送信です。お手数ですが最新版（添付）をご確認ください。\n\n' + body;
      }
      // 精算書PDF＋その月・店舗の添付ファイルを全て添付（Gmail上限25MBを超えない範囲）
      var attachments = [blob];
      var attachNames = [];
      var totalSize = blob.getBytes().length;
      var it2 = folder.getFiles();
      while (it2.hasNext()) {
        var af = it2.next();
        if (af.getId() === file.getId()) continue; // 今作った精算書自身は除外
        if (String(af.getName()).indexOf('精算書_') === 0) continue; // 過去に保存した精算書PDFは除外
        var sz = af.getSize();
        if (totalSize + sz > 24 * 1024 * 1024) { attachNames.push('（容量超過のため未添付: ' + af.getName() + '）'); continue; }
        attachments.push(af.getBlob());
        attachNames.push(af.getName());
        totalSize += sz;
      }
      if (attachNames.length) {
        body += '\n\n■添付書類\n・' + blob.getName() + '（精算書）\n・' + attachNames.join('\n・');
      }
      if (ext['ダッシュボードURL']) {
        body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + ext['ダッシュボードURL'] + '\n※ スマホで開けない場合は、リンクを長押しして「Safari/Chromeで開く」を選ぶか、ブラウザにURLを貼り付けてお開きください。';
      }
      var opts = { attachments: attachments, name: ext['メール送信者名'] || '株式会社N-Style' };
      if (ms.cc) opts.cc = ms.cc;
      GmailApp.sendEmail(ms.to, subject, body, opts);
      result.mailed = true;
      result.to = ms.to;
      result.attachCount = attachments.length;
      sd_markIssued_(det, store, monthKey);
    }
    sd_log_(sendMail ? 'メール送信' : 'PDF保存', store, monthKey, blob.getName(), file.getId(), file.getUrl(), user.name, sendMail ? (result.to || '') : '');
    return result;
  } finally {
    lock.releaseLock();
  }
}

function sd_markIssued_(det, store, monthKey) {
  try {
    if (!det.statusSheet) return;
    var sh = SpreadsheetApp.getActive().getSheetByName(det.statusSheet.sheet);
    var hr = det.statusSheet.headerRow;
    var lastC = sh.getLastColumn(), lastR = sh.getLastRow();
    var hVals = sh.getRange(hr, 1, 1, lastC).getValues()[0];
    var hDisp = sh.getRange(hr, 1, 1, lastC).getDisplayValues()[0];
    var nameCol = -1, mCol = -1;
    hDisp.forEach(function (h, i) {
      if (nameCol < 0 && sd_norm_(h) === '店舗名') nameCol = i;
      var key = '';
      if (hVals[i] instanceof Date) key = sd_fmtMonth_(hVals[i]);
      else if (/^\d{4}[-\/]\d{1,2}$/.test(String(h).trim())) {
        var p = String(h).trim().split(/[-\/]/);
        key = p[0] + '-' + ('0' + p[1]).slice(-2);
      }
      if (key === monthKey) mCol = i;
    });
    if (nameCol < 0 || mCol < 0) return;
    for (var r = hr + 1; r <= lastR; r++) {
      if (sd_norm_(sh.getRange(r, nameCol + 1).getDisplayValue()) === sd_norm_(store)) {
        var cell = sh.getRange(r, mCol + 1);
        if (!cell.getFormula()) cell.setValue('✅');
        return;
      }
    }
  } catch (e) { /* 発行状況の更新失敗は致命的でないため握りつぶす */ }
}

/* 定期費目のセット（前月の固定ロイヤリティ＋定期費目シート） */
function sd_prepareMonth(token, monthKey) {
  var user = sd_auth_(token, true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    return sd_prepareMonthCore_(monthKey, user.name, user.role !== 'マスター');
  } finally {
    lock.releaseLock();
  }
}

/* skipLocked=true のとき、振込済み（ロック中）の店舗はスキップする */
function sd_prepareMonthCore_(monthKey, editorName, skipLocked) {
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var recur = sd_recurRows_();
  var d = sd_monthKeyToDate_(monthKey);
  var prevKey = sd_addMonths_(monthKey, -1);
  var results = [];
  cfg.forEach(function (st) {
    if (!st.db) return;
    if (skipLocked && sd_isLocked_(st.name, monthKey)) { results.push(st.name + ': 🔒振込済みのためスキップ'); return; }
    var rows = sd_readRows_(st.db);
    var cur = {}, toAdd = [];
    rows.forEach(function (r) { if (r.ym === monthKey) cur[sd_norm_(r.kubun) + '|' + sd_norm_(r.item)] = true; });
    // 前月の固定ロイヤリティを引き継ぐ
    rows.forEach(function (r) {
      if (r.ym !== prevKey || sd_norm_(r.kubun) !== '固定ロイヤリティ') return;
      var key = sd_norm_(r.kubun) + '|' + sd_norm_(r.item);
      if (cur[key]) return;
      cur[key] = true;
      toAdd.push({ kubun: r.kubun, item: r.item, amount: r.amount, tax: r.tax || '10%', note: r.note });
    });
    // 定期費目シート（状態=停止の行はスキップ）
    recur.forEach(function (rc) {
      if (sd_norm_(rc.store) !== sd_norm_(st.name)) return;
      if (rc.status === '停止') return;
      var key = sd_norm_(rc.kubun) + '|' + sd_norm_(rc.item);
      if (cur[key]) return;
      cur[key] = true;
      toAdd.push({ kubun: rc.kubun, item: rc.item, amount: rc.amount, tax: rc.tax || '10%', note: rc.note || '定期費目（自動）' });
    });
    if (toAdd.length) {
      sd_appendRows_(st.db, d, toAdd, editorName || '自動');
      sd_clearRowsCache_(st.db.sheet);
      results.push(st.name + ': ' + toAdd.map(function (r) { return r.item; }).join('、') + ' を追加');
    }
  });
  if (!results.length) results.push('追加する定期費目はありませんでした（すべて入力済み）');
  return { ok: true, results: results };
}

/* 状態列（7列目・有効/停止・既定=有効）を持たない旧シートには自動でヘッダーを追加する。
 * v3.x UI刷新で「定期費目の毎月／停止」切替を追加するために2026-08-31導入。 */
function sd_recurEnsureStatusCol_(sh) {
  var header = sh.getRange(1, 1, 1, Math.max(7, sh.getLastColumn())).getDisplayValues()[0];
  if (sd_norm_(header[6]) !== '状態') {
    sh.getRange(1, 7).setValue('状態');
  }
}

function sd_recurRows_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_RECUR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_RECUR_SHEET);
    sh.getRange(1, 1, 1, 7).setValues([['店舗名', '区分', '費目名', '金額（税込）', '税率', '備考', '状態']]);
    sh.setFrozenRows(1);
    sh.getRange(2, 1, 1, 7).setValues([['（例）秋葉原 肉寿司', '固定ロイヤリティ', '固定ロイヤリティ', 440000, '10%', '新契約に伴う委託料　※行頭の（例）を消すと有効', '有効']]);
    sh.autoResizeColumns(1, 7);
    return [];
  }
  sd_recurEnsureStatusCol_(sh);
  var lastR = sh.getLastRow();
  if (lastR < 2) return [];
  var out = [];
  sh.getRange(2, 1, lastR - 1, 7).getDisplayValues().forEach(function (r, i) {
    var store = String(r[0]).trim();
    if (!store || store.indexOf('（例）') === 0) return;
    out.push({
      row: i + 2,
      store: store, kubun: String(r[1]).trim() || '変動費', item: String(r[2]).trim(),
      amount: Number(String(r[3]).replace(/[¥￥,，\s]/g, '')) || 0,
      tax: sd_norm_(r[4]) || '10%', note: String(r[5]).trim(),
      status: sd_norm_(r[6]) === '停止' ? '停止' : '有効'
    });
  });
  return out.filter(function (r) { return r.item; });
}

/* 定期費目の「毎月／停止」切替（設定タブ）。マスター/本部のみ。行が無ければ何もしない
 * （新規追加はスプレッドシートを直接編集する既存フローのまま＝過剰実装を避ける）。 */
function sd_saveRecurStatus(token, store, item, status) {
  sd_auth_(token, true);
  var st = sd_norm_(status) === '停止' ? '停止' : '有効';
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_RECUR_SHEET);
  if (!sh) throw new Error('「' + SD_RECUR_SHEET + '」シートが見つかりません');
  sd_recurEnsureStatusCol_(sh);
  var lastR = sh.getLastRow();
  if (lastR < 2) throw new Error('該当する定期費目が見つかりません: ' + store + ' / ' + item);
  var vals = sh.getRange(2, 1, lastR - 1, 3).getDisplayValues();
  var row = 0;
  for (var i = 0; i < vals.length; i++) {
    if (sd_norm_(vals[i][0]) === sd_norm_(store) && sd_norm_(vals[i][2]) === sd_norm_(item)) { row = i + 2; break; }
  }
  if (!row) throw new Error('該当する定期費目が見つかりません: ' + store + ' / ' + item);
  sh.getRange(row, 7).setValue(st);
  return { ok: true, store: store, item: item, status: st };
}

/* 自動処理のセットアップ:
 *  - 毎月1日 9時: 精算対象月（＝前月）の定期費目を自動セット
 *  - 毎月5日 9時: 前月分の現金売上を自動取込
 *  - 毎日9時: 振込期限（20日）の3日前・当日・超過後は毎日、ChatWorkへリマインド（判定はsd_remindTick内） */
function sd_setupAutoPrep(token) {
  sd_auth_(token, true);
  var triggers = ScriptApp.getProjectTriggers();
  var hasPrep = triggers.some(function (t) { return t.getHandlerFunction() === 'sd_autoPrepTick'; });
  var hasCash = triggers.some(function (t) { return t.getHandlerFunction() === 'sd_cashAutoTick'; });
  var made = [];
  if (!hasPrep) {
    ScriptApp.newTrigger('sd_autoPrepTick').timeBased().onMonthDay(1).atHour(9).create();
    made.push('毎月1日9時 定期費目セット');
  }
  if (!hasCash) {
    ScriptApp.newTrigger('sd_cashAutoTick').timeBased().onMonthDay(5).atHour(9).create();
    made.push('毎月5日9時 現金売上の自動取込');
  }
  // 期限リマインドは日付・未対応店舗の有無をsd_remindTick内で毎日判定する方式に変更したため、
  // トリガー自体は「毎日9時」に統一する。GAS側にはトリガーの詳細スケジュールを取得するAPIが無く
  // 「旧バージョン（毎月18日のみ）が残っているか」を判別できないため、毎回作り直して確実に揃える。
  var remindTriggers = triggers.filter(function (t) { return t.getHandlerFunction() === 'sd_remindTick'; });
  remindTriggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sd_remindTick').timeBased().everyDays(1).atHour(9).create();
  made.push('毎日9時 振込期限リマインド（17日・20日・21日以降は未対応があれば毎日ChatWorkへ通知）');
  return { ok: true, message: made.length ? made.join('＋') + ' を設定しました' : '自動処理は設定済みです（毎月1日 定期費目セット／毎月5日 現金売上取込／毎日 期限リマインド判定）' };
}

function sd_autoPrepTick() {
  var now = new Date();
  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  var res = sd_prepareMonthCore_(monthKey, '自動(毎月1日)');
  sd_log_('定期費目自動セット', '全店舗', monthKey, res.results.join(' / '), '', '', '自動', '');
}

/* 毎月5日: 前月分の現金売上を全店舗に自動取込（既に現金売上が入っている店舗はスキップ） */
function sd_cashAutoTick() {
  var now = new Date();
  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  try {
    var res = sd_cashApplyCore_(monthKey, null, '自動(毎月5日)', true);
    sd_log_('現金売上自動取込', '全店舗', monthKey, res.results.join(' / '), '', '', '自動', '');
  } catch (e) {
    sd_log_('現金売上自動取込エラー', '全店舗', monthKey, String((e && e.message) || e), '', '', '自動', '');
  }
}

/* ChatWorkへメッセージ送信（APIトークン・ルームIDは設定_外部連携シートで管理） */
function sd_notifyChatwork_(message) {
  var ext = sd_extConfig_();
  var token = ext['ChatWork APIトークン'];
  var roomId = ext['ChatWorkルームID（振込リマインド用）'];
  if (!token || !roomId) {
    return { sent: false, reason: 'ChatWork未設定（設定_外部連携シートで「ChatWork APIトークン」「ChatWorkルームID（振込リマインド用）」を設定してください）' };
  }
  var res = UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + roomId + '/messages', {
    method: 'post',
    headers: { 'X-ChatWorkToken': token },
    payload: { body: message },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200) return { sent: true };
  return { sent: false, reason: 'ChatWork送信失敗: HTTP' + code + ' ' + res.getContentText() };
}

/* ⚙️設定タブの「ChatWorkテスト送信」ボタンから呼ばれる。設定が正しいかその場で確認できるようにする。 */
function sd_testChatwork(token) {
  sd_auth_(token, true);
  var result = sd_notifyChatwork_('[info][title]🔔 ChatWork連携テスト[/title]この通知が届いていれば、精算ダッシュボードからのChatWork連携設定は正常です。[/info]');
  return { ok: result.sent, reason: result.reason };
}

/* 毎日9時に実行（トリガーはsd_setupAutoPrepで作成）。
 * 振込期限（毎月20日）の3日前（17日）・当日（20日）・超過後（21日以降）は毎日、未対応店舗があればChatWorkへ通知する。
 * それ以外の日、および対応が必要な店舗が0件のときは何もしない（送信しない）。 */
function sd_remindTick() {
  var now = new Date();
  var day = now.getDate();
  var overdue = day > 20;
  if (!(day === 17 || day === 20 || overdue)) return { ok: true, message: '対象日ではないためスキップ（17日・20日・21日以降のみ）' };

  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1)); // 精算対象月＝前月
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var issued = sd_issuedMap_(det);
  var sent = sd_sentMap_();
  var paid = sd_paidMap_();
  var d = sd_monthKeyToDate_(monthKey);
  var mLabel = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';

  var lines = [];
  var needCount = 0;
  cfg.forEach(function (st) {
    if (!st.db) { lines.push('■ ' + st.name + '：⚠ DBシート未検出'); needCount++; return; }
    var rows = sd_readRows_(st.db);
    var byMonth = {};
    rows.forEach(function (r) { (byMonth[r.ym] = byMonth[r.ym] || []).push(r); });
    var s = sd_settle_(rows, monthKey, st.rate, st.fixed);
    var chk = sd_missing_(byMonth, monthKey, st.required);
    var isSent = !!((sent[sd_norm_(st.name)] || {})[monthKey]) || (issued[sd_norm_(st.name)] || {})[monthKey] === true;
    var paidStatus = sd_paidStatusMap_(st.name, st.client, paid)[monthKey];
    var isPaid = !!(paidStatus && paidStatus.done);
    var status = isPaid ? '💰振込済み' : (isSent ? '✅発行済み（振込待ち）' : (s.count > 0 ? '🟡入力中 ' + s.count + '件' : '❌未入力'));
    var warns = chk.catWarn.concat(chk.missing);
    if (isPaid && !warns.length) return; // 完了店舗は省略
    var line = '■ ' + st.name + '：' + status;
    if (s.hasSales) line += '　振込金額(税込) ' + sd_yen_(s.transfer);
    if (warns.length) { line += '\n　└ 入力漏れの疑い: ' + warns.join('、'); }
    if (!isPaid) needCount++;
    lines.push(line);
  });

  if (needCount === 0) return { ok: true, message: '対応が必要な店舗はありません（送信スキップ）' };

  var headline = overdue
    ? '🚨 ' + mLabel + '分の振込期限（20日）を過ぎています！至急ご対応ください。'
    : (day === 20 ? '⏰ 本日が' + mLabel + '分の振込期限（20日）です。' : '📅 ' + mLabel + '分の振込期限（20日）まであと3日です。');
  var message = '[info][title]💰 業務委託料 振込リマインド（対応必要: ' + needCount + '店舗）[/title]'
    + headline + '\n\n'
    + lines.join('\n\n')
    + '[/info]';
  var result = sd_notifyChatwork_(message);
  sd_log_('期限リマインド', '全店舗', monthKey, message, '', '', '自動', result.sent ? 'ChatWork' : ('送信失敗: ' + result.reason));
  return { ok: result.sent, needCount: needCount, reason: result.reason };
}

/* ---------- ③ 添付ファイル ---------- */

/* 月・店舗フォルダのIDを10分キャッシュ（毎回2段階のフォルダ検索をするとDrive APIの往復が
 * 積み重なって遅くなるため。フォルダ自体を作り直した場合は最大10分古い情報を見る可能性あり）。 */
function sd_folderFor_(ext, monthKey, store) {
  var cacheKey = 'sdfolder_' + monthKey + '_' + store;
  var cache = CacheService.getScriptCache();
  var cachedId = cache.get(cacheKey);
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* フォルダが消えていたら通常経路へ */ }
  }
  var parent;
  try {
    parent = DriveApp.getFolderById(ext['添付親フォルダID']);
  } catch (e) {
    throw new Error('添付親フォルダにアクセスできません。「' + SD_EXT_SHEET + '」シートの添付親フォルダIDを確認してください');
  }
  var mName = sd_monthLabel_(monthKey); // 例: 2026年6月
  var mFolder = sd_childFolder_(parent, mName);
  var storeFolder = sd_childFolder_(mFolder, store);
  try { cache.put(cacheKey, storeFolder.getId(), 600); } catch (e) { /* キャッシュ失敗は無視 */ }
  return storeFolder;
}

function sd_childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sd_uploadAttachment(token, payload) {
  // payload = { store, month, kind, fileName, mimeType, b64, revised }
  // revised=true のときは、同名ファイルが既にあれば上書きせず「【再】費目名_…」で保存する
  var timer = sd_timer_();
  var user = sd_auth_(token, true);
  sd_requireUnlocked_(user, payload.store, payload.month);
  timer.mark('auth');
  var ext = sd_extConfig_();
  var kind = String(payload.kind || '').trim();
  if (!kind) throw new Error('何の書類か（例: カード売上）を入力してください');
  var extMatch = String(payload.fileName || '').match(/\.[A-Za-z0-9]+$/);
  var extension = extMatch ? extMatch[0] : '';
  var folder = sd_folderFor_(ext, payload.month, payload.store);
  timer.mark('folderLookup');

  var baseName = kind + '_' + sd_monthDot_(payload.month) + '_' + payload.store;
  var newName = baseName + extension;
  if (payload.revised && folder.getFilesByName(newName).hasNext()) {
    // 既存があれば 【再】→【再2】→… と接頭辞を付けて修正版とわかるようにする
    var prefix = '【再】', n = 2;
    while (folder.getFilesByName(prefix + baseName + extension).hasNext()) {
      prefix = '【再' + n + '】'; n++;
    }
    newName = prefix + baseName + extension;
  }
  timer.mark('dupCheck');
  var bytes = Utilities.base64Decode(payload.b64);
  var blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', newName);
  timer.mark('decode');
  var file = folder.createFile(blob);
  timer.mark('driveCreate');
  sd_log_(payload.revised ? '添付（修正版）' : '添付アップロード', payload.store, payload.month, newName, file.getId(), file.getUrl(), user.name, '');
  timer.mark('log');
  return { ok: true, name: newName, url: file.getUrl(), folder: sd_monthLabel_(payload.month) + '／' + payload.store, _ms: timer.breakdown() };
}

function sd_listAttachments(token, store, monthKey) {
  var user = sd_auth_(token, false);
  var det = sd_detect_();
  var cfg = sd_allowedStores_(user, sd_config_(sd_masterStores_(det), det));
  if (!cfg.some(function (s) { return s.name === store; })) throw new Error('この店舗の閲覧権限がありません');
  var ext = sd_extConfig_();
  var out = [];
  try {
    var folder = sd_folderFor_(ext, monthKey, store);
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      out.push({ name: f.getName(), url: f.getUrl(), id: f.getId(), date: Utilities.formatDate(f.getDateCreated(), SD_TZ, 'M/d HH:mm') });
    }
  } catch (e) { /* フォルダ未作成なら空 */ }
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out;
}

/* 委託先向け: 発行済みPDFのダウンロード（権限チェック付き） */
function sd_getPdfB64(token, fileId) {
  var user = sd_auth_(token, false);
  var log = sd_logRows_().filter(function (r) { return r.fileId === fileId; });
  if (!log.length) throw new Error('ファイルが見つかりません');
  var det = sd_detect_();
  var cfg = sd_allowedStores_(user, sd_config_(sd_masterStores_(det), det));
  if (!cfg.some(function (s) { return sd_norm_(s.name) === sd_norm_(log[0].store); })) {
    throw new Error('この店舗の閲覧権限がありません');
  }
  var file = DriveApp.getFileById(fileId);
  return { fileName: file.getName(), b64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

/* ---------- 発行ログ ---------- */

function sd_logSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_LOG_SHEET);
    sh.getRange(1, 1, 1, 9).setValues([['日時', '操作', '店舗', '対象月', 'ファイル名', 'fileId', 'URL', '実行者', '送信先']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sd_log_(action, store, monthKey, fileName, fileId, url, who, to) {
  sd_logSheet_().appendRow([
    Utilities.formatDate(new Date(), SD_TZ, 'yyyy-MM-dd HH:mm:ss'),
    action, store, monthKey, fileName, fileId, url, who, to
  ]);
}

function sd_logRows_() {
  var sh = sd_logSheet_();
  var lastR = sh.getLastRow();
  if (lastR < 2) return [];
  return sh.getRange(2, 1, lastR - 1, 9).getDisplayValues().map(function (r) {
    return { at: r[0], action: r[1], store: r[2], month: r[3], fileName: r[4], fileId: r[5], url: r[6], who: r[7], to: r[8] };
  });
}

/* 店舗×月 → 最新の送信/保存記録 */
function sd_sentMap_() {
  var out = {};
  sd_logRows_().forEach(function (r) {
    if (r.action !== 'メール送信' && r.action !== 'PDF保存') return;
    var k = sd_norm_(r.store);
    out[k] = out[k] || {};
    var prev = out[k][r.month];
    if (!prev || r.at > prev.at || (r.action === 'メール送信' && prev.action !== 'メール送信')) {
      out[k][r.month] = { at: r.at, action: r.action, fileId: r.fileId, fileName: r.fileName, to: r.to };
    }
  });
  return out;
}

/* ---------- ⑤ 先の月への一括計上（本部のみ） ---------- */

function sd_bulkAdd(token, payload) {
  // payload = { store, kubun, item, amount, tax, note, fromMonth, toMonth }
  var user = sd_auth_(token, true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var det = sd_detect_();
    var cfg = sd_config_(sd_masterStores_(det), det);
    var st = null;
    cfg.forEach(function (s) { if (s.name === payload.store) st = s; });
    if (!st) throw new Error('店舗が見つかりません: ' + payload.store);
    if (!st.db) throw new Error('店舗「' + payload.store + '」のDBシートが見つかりません');
    var item = String(payload.item || '').trim();
    if (!item) throw new Error('費目名を入力してください');
    var amt = Number(String(payload.amount).replace(/[¥￥,，\s]/g, ''));
    if (isNaN(amt)) throw new Error('金額が数値ではありません');
    if (payload.fromMonth > payload.toMonth) throw new Error('開始月が終了月より後になっています');

    var months = [];
    var k = payload.fromMonth, guard = 0;
    while (k <= payload.toMonth && guard < 60) { months.push(k); k = sd_addMonths_(k, 1); guard++; }
    if (!months.length) throw new Error('対象月がありません');

    // 振込済みの月はマスター以外スキップ
    var lockedMonths = [];
    if (user.role !== 'マスター') {
      var open = [];
      months.forEach(function (mk) {
        if (sd_isLocked_(payload.store, mk)) lockedMonths.push(mk); else open.push(mk);
      });
      months = open;
      if (!months.length) throw new Error('🔒 指定された月はすべて振込済みでロックされています（マスターアカウントが必要です）');
    }

    sd_ensureCategoryCols_(st.db);
    var row = { kubun: payload.kubun || '変動費', item: item, amount: amt, tax: payload.tax || '10%', note: payload.note || '一括計上', account: payload.account || '', subAccount: payload.subAccount || '' };
    months.forEach(function (mk) {
      sd_appendRows_(st.db, sd_monthKeyToDate_(mk), [row], user.name);
    });
    sd_clearRowsCache_(st.db.sheet);
    sd_log_('一括計上', payload.store, months[0] + '〜' + months[months.length - 1], item + ' ¥' + amt + ' ×' + months.length + 'ヶ月', '', '', user.name, '');
    return { ok: true, months: months, item: item, amount: amt, store: payload.store, lockedSkipped: lockedMonths };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- ③ アカウント・法人の管理（本部のみ、設定タブ） ---------- */

function sd_getSettings(token) {
  var user = sd_auth_(token, true);
  var det = sd_detect_();
  var master = sd_masterStores_(det);
  var cfg = sd_config_(master, det);

  var accSh = sd_authSheet_();
  var accounts = [];
  var lastR = accSh.getLastRow();
  if (lastR > 1) {
    accSh.getRange(2, 1, lastR - 1, 7).getDisplayValues().forEach(function (r) {
      if (String(r[0]).trim()) accounts.push({
        id: String(r[0]).trim(), pw: String(r[1]), name: String(r[2]).trim(),
        role: sd_normRole_(r[3]),
        stores: String(r[4]).trim(), enabled: sd_norm_(r[5]).toUpperCase() !== 'FALSE',
        email: String(r[6] || '').trim().toLowerCase()
      });
    });
  }
  var corps = sd_corpMap_(cfg);
  var corpList = [];
  var seen = {};
  cfg.forEach(function (st) {
    var c = st.client || '';
    if (c && !seen[sd_norm_(c)]) {
      seen[sd_norm_(c)] = true;
      var info = corps[sd_norm_(c)] || {};
      corpList.push({ client: c, account: info.account || '', note: info.note || '' });
    }
  });
  // 定期費目（🔁設定タブ用。店舗×費目の一覧に状態(有効/停止)を添えて返す。書き込みはsd_saveRecurStatus）
  var recur = sd_recurRows_().map(function (r) {
    return { store: r.store, kubun: r.kubun, item: r.item, amount: r.amount, status: r.status };
  });
  return {
    accounts: accounts,
    corps: corpList,
    stores: cfg.map(function (s) { return { name: s.name, client: s.client, rate: s.rate, hasDb: !!s.db }; }),
    recur: recur,
    ops: { lockLevel: sd_lockLevel_(), autoSendMode: sd_autoSendMode_() },
    masterSheetUrl: SpreadsheetApp.getActive().getUrl()
  };
}

function sd_saveAccount(token, acc) {
  var user = sd_auth_(token, true);
  if (!acc || !String(acc.id || '').trim()) throw new Error('ログインIDを入力してください');
  if (!String(acc.pw || '').trim()) throw new Error('パスワードを入力してください');
  var newRole = sd_normRole_(acc.role);
  // マスター権限の付与・既存マスターの編集はマスターのみ
  var existing = sd_findAccount_(String(acc.id).trim());
  if (newRole === 'マスター' || (existing && existing.role === 'マスター')) sd_requireMaster_(user);

  var sh = sd_authSheet_();
  var lastR = sh.getLastRow();
  var row = 0;
  if (lastR > 1) {
    var ids = sh.getRange(2, 1, lastR - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === String(acc.id).trim()) { row = i + 2; break; }
    }
  }
  // 委託先は統合アカウントの対象外なのでメールは保存しない
  var email = newRole === '委託先' ? '' : String(acc.email || '').trim().toLowerCase();
  var rec = [
    String(acc.id).trim(), String(acc.pw), String(acc.name || acc.id).trim(),
    newRole,
    String(acc.stores || '').trim() || (newRole !== '委託先' ? '全店' : ''),
    acc.enabled === false ? 'FALSE' : 'TRUE',
    email
  ];
  if (row) sh.getRange(row, 1, 1, 7).setValues([rec]);
  else sh.appendRow(rec);
  return { ok: true, id: rec[0], updated: !!row };
}

function sd_saveCorp(token, corp) {
  var user = sd_auth_(token, true);
  var client = String(corp.client || '').trim();
  if (!client) throw new Error('法人名が空です');
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_CORP_SHEET);
  if (!sh) { sd_corpMap_(sd_config_(sd_masterStores_(sd_detect_()), sd_detect_())); sh = ss.getSheetByName(SD_CORP_SHEET); }
  var lastR = sh.getLastRow();
  var row = 0;
  if (lastR > 1) {
    var names = sh.getRange(2, 1, lastR - 1, 1).getDisplayValues();
    for (var i = 0; i < names.length; i++) {
      if (sd_norm_(names[i][0]) === sd_norm_(client)) { row = i + 2; break; }
    }
  }
  var rec = [client, String(corp.account || '').trim(), String(corp.note || '').trim()];
  if (row) sh.getRange(row, 1, 1, 3).setValues([rec]);
  else sh.appendRow(rec);
  return { ok: true, client: client, updated: !!row };
}

/* ロイヤリティ率設定（設定タブ）。「店舗設定マスター」シートの該当行・ロイヤリティ率列を直接
 * 書き換える。従来は本シートを手で開いて編集していたのをUIから可能にする。マスター/本部のみ。 */
function sd_saveStoreRate(token, store, rate) {
  sd_auth_(token, true);
  var det = sd_detect_();
  if (!det.master) throw new Error('「店舗設定マスター」が見つかりません');
  var sh = SpreadsheetApp.getActive().getSheetByName(det.master.sheet);
  var hr = det.master.headerRow;
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR <= hr) throw new Error('店舗設定マスターにデータがありません');
  var header = sh.getRange(hr, 1, 1, lastC).getDisplayValues()[0].map(sd_norm_);
  var iName = header.indexOf('店舗名');
  var iRate = -1;
  header.forEach(function (h, i) { if (iRate < 0 && h.indexOf('ロイヤリティ率') > -1) iRate = i; });
  if (iName < 0 || iRate < 0) throw new Error('店舗設定マスターに「店舗名」または「ロイヤリティ率」列が見つかりません');
  var vals = sh.getRange(hr + 1, 1, lastR - hr, lastC).getDisplayValues();
  var row = 0;
  for (var i = 0; i < vals.length; i++) {
    var nm = String(vals[i][iName] || '').trim();
    if (!nm) break;
    if (sd_norm_(nm) === sd_norm_(store)) { row = hr + 1 + i; break; }
  }
  if (!row) throw new Error('店舗設定マスターに「' + store + '」が見つかりません');
  sh.getRange(row, iRate + 1).setValue(String(rate));
  return { ok: true, store: store, rate: String(rate) };
}

/* ⚙自動処理・権限（設定タブ）。SD_LOCK_LEVEL（振込済み後の編集権限。master=マスターのみ／
 * admin=本部以上）とSD_AUTOSEND_MODE（発行モーダルの送信チェックボックスの既定値。manual/auto）
 * をScript Propertiesに保存するだけの軽量設定。承認フローや自動送信そのものを新設するものではない。 */
function sd_saveOpsSettings(token, settings) {
  var user = sd_auth_(token, true);
  sd_requireMaster_(user);
  var s = settings || {};
  var lockLevel = s.lockLevel === 'admin' ? 'admin' : 'master';
  var autoSendMode = s.autoSendMode === 'auto' ? 'auto' : 'manual';
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SD_LOCK_LEVEL', lockLevel);
  props.setProperty('SD_AUTOSEND_MODE', autoSendMode);
  return { ok: true, lockLevel: lockLevel, autoSendMode: autoSendMode };
}

function sd_getOpsSettings(token) {
  sd_auth_(token, true);
  return { ok: true, lockLevel: sd_lockLevel_(), autoSendMode: sd_autoSendMode_() };
}
function sd_autoSendMode_() {
  var v = PropertiesService.getScriptProperties().getProperty('SD_AUTOSEND_MODE');
  return (v === 'auto') ? 'auto' : 'manual';
}

/* ---------- シート版チェック表（本部） ---------- */

function sd_updateCheckSheet(token, monthKey) {
  var data = sd_getDashboard(token, monthKey || null);
  sd_auth_(token, true);
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_CHECK_SHEET);
  if (!sh) sh = ss.insertSheet(SD_CHECK_SHEET, 0);
  sh.clear();
  var rows = [];
  rows.push(['精算 入力チェック表', '', '', '', '', '']);
  rows.push(['対象月: ' + data.monthLabel + '　（更新: ' + data.updatedAt + '）', '', '', '', '', '']);
  rows.push(['', '', '', '', '', '']);
  rows.push(['店舗', '状態', '明細件数', '売上合計', '経費合計', '入力漏れの疑い']);
  data.stores.forEach(function (st) {
    var d = st.detail;
    var state = d.issuedThis ? '✅ 発行済み' : (d.count > 0 ? '🟡 入力中' : '❌ 未入力');
    var warn = d.missing.concat(d.catWarn).join('、 ') || '－';
    rows.push([st.name, state, d.count, d.sales, d.cost, warn]);
  });
  rows.push(['', '', '', '', '', '']);
  rows.push(['※「入力漏れの疑い」= 直近3ヶ月のうち2ヶ月以上入力があるのに、対象月にまだ無い費目', '', '', '', '', '']);
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.getRange(4, 1, 1, 6).setFontWeight('bold').setBackground('#efefef');
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.setColumnWidth(1, 160);
  sh.setColumnWidths(2, 4, 110);
  sh.setColumnWidth(6, 480);
  sh.getRange(5, 4, data.stores.length, 2).setNumberFormat('¥#,##0');
  return SD_CHECK_SHEET + ' を更新しました（' + data.monthLabel + '）';
}

/* ---------- 動作確認 ---------- */

/* 既に権限シートがある環境にマスターアカウントを追加する（エディタから1回実行）。
 * 既に master がいる場合は何もしない。パスワードは実行ログに出力。 */
function sd_createMasterAccount() {
  var sh = sd_authSheet_();
  var existing = sd_findAccount_('master');
  if (existing) {
    Logger.log('master アカウントは既に存在します（権限: ' + existing.role + '）。パスワードは権限_精算ダッシュボードシートで確認・変更してください。');
    return;
  }
  var pw = Utilities.getUuid().split('-')[0];
  sh.appendRow(['master', pw, 'マスター', 'マスター', '全店', 'TRUE']);
  Logger.log('マスターアカウントを作成しました: master / ' + pw + '（必ずログイン後に変更してください）');
}

function sd_diagnose() {
  var det = sd_detect_();
  var master = sd_masterStores_(det);
  var cfg = sd_config_(master, det);
  var ext = sd_extConfig_();
  sd_authSheet_(); sd_recurRows_(); sd_logSheet_();
  Logger.log('バージョン: %s', SD_VERSION);
  Logger.log('店舗設定マスター: %s', det.master && det.master.sheet);
  Logger.log('発行状況: %s / メール設定: %s / 送付シート: %s',
    det.statusSheet && det.statusSheet.sheet,
    det.mailSheet && det.mailSheet.sheet,
    det.sendSheet && det.sendSheet.sheet);
  cfg.forEach(function (st) {
    Logger.log('店舗「%s」 → DB: %s ／ 売上シート名: %s', st.name, st.db ? st.db.sheet : '（未検出）', st.salesName);
  });
  Logger.log('売上スプレッドシートID: %s', ext['売上スプレッドシートID']);
  Logger.log('添付親フォルダID: %s', ext['添付親フォルダID']);
}

/* 「精算書 送付」シートの売上一覧の数式を調べる（PDFの金額とDBの金額が
 * 合わない原因調査用）。エディタで実行し、ログを確認してください。 */
function sd_diagnoseSalesFormula(store, monthKey) {
  var det = sd_detect_();
  var info = sd_sendSheetInfo_(det);
  if (store) {
    info.sheet.getRange(info.storeCell[0], info.storeCell[1]).setValue(store);
  }
  if (monthKey) {
    var d = sd_monthKeyToDate_(monthKey);
    info.sheet.getRange(info.monthCell[0], info.monthCell[1]).setValue(d.getFullYear() + '/' + (d.getMonth() + 1));
  }
  SpreadsheetApp.flush();
  Utilities.sleep(500);

  var sh = info.sheet;
  var lastR = Math.min(sh.getLastRow(), 200);
  var lastC = Math.min(sh.getLastColumn(), 8);
  var vals = sh.getRange(1, 1, lastR, lastC).getDisplayValues();
  var formulas = sh.getRange(1, 1, lastR, lastC).getFormulas();

  var salesRow = -1, sumRow = -1;
  for (var r = 0; r < lastR; r++) {
    for (var c = 0; c < lastC; c++) {
      var t = sd_norm_(vals[r][c]);
      if (salesRow < 0 && t.indexOf('売上（預かり金）') > -1) salesRow = r;
      if (salesRow > -1 && sumRow < 0 && t === '売上合計') { sumRow = r; break; }
    }
    if (sumRow > -1) break;
  }
  if (salesRow < 0) { Logger.log('「売上（預かり金）」ブロックが見つかりません'); return; }
  if (sumRow < 0) sumRow = Math.min(salesRow + 12, lastR - 1);

  Logger.log('===== 売上（預かり金）ブロック 行%s〜%s =====', salesRow + 1, sumRow + 1);
  for (var rr = salesRow; rr <= sumRow; rr++) {
    var rowVals = vals[rr].join(' | ');
    var rowFormulas = formulas[rr].filter(function (f) { return f; }).join(' , ');
    Logger.log('行%s: 値=[%s] 数式=[%s]', rr + 1, rowVals, rowFormulas || '(数式なし・静的値)');
  }

  Logger.log('===== 対応する精算入力DBの「売上」区分・対象月ぶん =====');
  var cfgAll = sd_config_(sd_masterStores_(det), det);
  var target = null;
  cfgAll.forEach(function (s) { if (!store || sd_norm_(s.name) === sd_norm_(store)) if (!target) target = s; });
  if (target && target.db) {
    var mk = monthKey || sd_fmtMonth_(new Date());
    var rows = sd_readRows_(target.db).filter(function (r) { return r.ym === mk && sd_norm_(r.kubun) === '売上'; });
    var total = 0;
    rows.forEach(function (r) {
      total += r.amount;
      Logger.log('DB行%s: %s ¥%s（税率%s）', r.row, r.item, r.amount, r.tax);
    });
    Logger.log('DB上の売上合計: ¥%s（%s件）', total, rows.length);
  }
}
