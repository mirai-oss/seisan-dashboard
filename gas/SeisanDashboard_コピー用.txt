/**********************************************************************
 * 精算ダッシュボード v2
 *
 * 機能:
 *  1. 現金売上の自動取込（【サーバー】ダッシュボード「分析_日別店舗」T列から）
 *  2. PDFプレビュー・メール送信・翌月分の定期費目自動セット
 *  3. 添付ファイルのアップロード（自動リネーム＋月・店舗フォルダへ格納）
 *  4. ログインアカウント制（本部 / 委託先、店舗単位の閲覧制限）
 *
 * 既存の精算書スクリプトには一切手を加えません。
 * 全関数 sd_ プレフィックス（doGet のみ例外）。
 *
 * ★ v2 は「次のユーザーとして実行: 自分」でデプロイしてください。
 *   （委託先アカウントがスプレッドシート共有なしで使えるようにするため）
 * ★ 初回は sd_authorize を一度実行して権限を承認してください。
 **********************************************************************/

var SD_VERSION = 'v4.4';
var SD_START_MONTH = '2026-03'; // これより前の月はプルダウンに出さない
var SD_PAID_SHEET = '振込管理_精算ダッシュボード';
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

/* ---------- Webアプリ入口 ---------- */

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'ping') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, ver: SD_VERSION }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createTemplateFromFile('dashboard')
    .evaluate()
    .setTitle('精算ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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

function sd_detect_() {
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
    sh.getRange(1, 1, 1, 5).setValues([['店舗名', '対象月', '振込済み', '日付', '記録者']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sd_paidMap_() {
  var sh = sd_paidSheet_();
  var lastR = sh.getLastRow();
  var out = {};
  if (lastR < 2) return out;
  sh.getRange(2, 1, lastR - 1, 5).getDisplayValues().forEach(function (r) {
    var store = sd_norm_(r[0]), mk = String(r[1]).trim();
    if (!store || !mk) return;
    out[store] = out[store] || {};
    out[store][mk] = { done: sd_norm_(r[2]).toUpperCase() === 'TRUE' || r[2] === '✅', date: r[3], by: r[4] };
  });
  return out;
}

function sd_setPaid(token, store, monthKey, done, sendMail) {
  var user = sd_auth_(token, true);
  var sh = sd_paidSheet_();
  var lastR = sh.getLastRow();
  var row = 0;
  if (lastR > 1) {
    var vals = sh.getRange(2, 1, lastR - 1, 2).getDisplayValues();
    for (var i = 0; i < vals.length; i++) {
      if (sd_norm_(vals[i][0]) === sd_norm_(store) && String(vals[i][1]).trim() === monthKey) { row = i + 2; break; }
    }
  }
  var rec = [store, monthKey, done ? 'TRUE' : 'FALSE',
    done ? Utilities.formatDate(new Date(), SD_TZ, 'yyyy-MM-dd') : '', user.name];
  if (row) sh.getRange(row, 1, 1, 5).setValues([rec]);
  else sh.appendRow(rec);

  var result = { ok: true, store: store, month: monthKey, done: !!done, mailed: false };
  if (done && sendMail) {
    var det = sd_detect_();
    var ext = sd_extConfig_();
    var ms = sd_mailSettings_(det, store);
    if (!ms || !ms.to) throw new Error('メール設定シートに「' + store + '」の宛先(To)がありません（振込済みには登録済み）');
    var d = sd_monthKeyToDate_(monthKey);
    var mLabel = (d.getMonth() + 1) + '月';
    // 振込金額を計算して本文に載せる
    var cfg = sd_config_(sd_masterStores_(det), det);
    var st = null;
    cfg.forEach(function (s) { if (s.name === store) st = s; });
    var amountLine = '';
    if (st && st.db) {
      var settle = sd_settle_(sd_readRows_(st.db), monthKey, st.rate, st.fixed);
      if (settle.hasSales) amountLine = '■振込金額（税込）：' + sd_yen_(settle.transfer) + '\n';
    }
    var sender = ext['メール送信者名'] || '株式会社N-Style';
    var subject = '【お知らせ】' + mLabel + '分業務委託料 お振込完了のご連絡（' + store + '）';
    var body = 'ご担当者様\n\nいつも大変お世話になっております。\n' + sender + 'です。\n\n'
      + mLabel + '分の業務委託料につきまして、お振込が完了いたしましたのでご連絡申し上げます。\n\n'
      + '■対象店舗：' + store + '\n'
      + amountLine
      + '\nご査収のほど、よろしくお願い申し上げます。';
    if (ext['ダッシュボードURL']) {
      body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + ext['ダッシュボードURL'];
    }
    var opts = { name: sender };
    if (ms.cc) opts.cc = ms.cc;
    GmailApp.sendEmail(ms.to, subject, body, opts);
    sd_log_('振込完了メール', store, monthKey, subject, '', '', user.name, ms.to);
    result.mailed = true;
    result.to = ms.to;
  }
  return result;
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
    ['売上スプレッドシートID', '1OuaAQBeXHxJZtDXEbQx-V7w56fCWW5jpDmZvBpkfIbQ'],
    ['売上シート名', '分析_日別店舗'],
    ['売上_日付列', 'A'],
    ['売上_店舗名列', 'J'],
    ['売上_現金列', 'T'],
    ['添付親フォルダID', '1PZU4slLx2LmZLIDpX4yihv9rlkDrPsiG'],
    ['メール送信者名', '株式会社N-Style'],
    ['発行元_会社名', '株式会社N-style'],
    ['発行元_郵便番号', '153-0051'],
    ['発行元_住所', '東京都目黒区上目黒1-16-12鈴房ビル202A'],
    ['発行元_電話', '080-5379-7126'],
    ['発行元_登録番号', 'T5011001118040'],
    ['発行元_振込先', ''],
    ['リマインド送信先', 'info@ns0314.com'],
    ['ダッシュボードURL', 'https://script.google.com/macros/s/AKfycbzwYN9uSEtcJHSKSVQCoQOrllhO7G6gR-E4dvP-V4o_VdGXr9VQx2mbYYPNyNEFSQCiKg/exec']
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
    sh.getRange(1, 1, 1, 6).setValues([['ログインID', 'パスワード', '表示名', '権限（本部/委託先）', '担当店舗（カンマ区切り／全店）', '有効（TRUE/FALSE）']]);
    sh.getRange(2, 1, 2, 6).setValues([
      ['honbu', 'ns0314', '本部', '本部', '全店', 'TRUE'],
      ['fam', 'fam2026', 'FAM Dining様', '委託先', '秋葉原 肉寿司', 'FALSE']
    ]);
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, 6);
  }
  return sh;
}

function sd_findAccount_(id) {
  var sh = sd_authSheet_();
  var lastR = sh.getLastRow();
  if (lastR < 2) return null;
  var vals = sh.getRange(2, 1, lastR - 1, 6).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === String(id).trim()) {
      return {
        id: String(vals[i][0]).trim(),
        pw: String(vals[i][1]),
        name: String(vals[i][2]).trim() || String(vals[i][0]).trim(),
        role: sd_norm_(vals[i][3]) === '本部' ? '本部' : '委託先',
        storesRaw: String(vals[i][4]).trim(),
        enabled: sd_norm_(vals[i][5]).toUpperCase() !== 'FALSE'
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

function sd_auth_(token, needHonbu) {
  var raw = token ? CacheService.getScriptCache().get('sdtk_' + token) : null;
  if (!raw) throw new Error('AUTH'); // クライアント側で再ログイン誘導
  var user = JSON.parse(raw);
  if (needHonbu && user.role !== '本部') throw new Error('この操作は本部アカウントのみ実行できます');
  return user;
}

function sd_allowedStores_(user, cfg) {
  if (user.role === '本部' || sd_norm_(user.storesRaw) === '全店' || !user.storesRaw) return cfg;
  var names = user.storesRaw.split(/[,、，]/).map(function (s) { return sd_norm_(s); }).filter(String);
  return cfg.filter(function (st) { return names.indexOf(sd_norm_(st.name)) > -1; });
}

/* ---------- DB読み取り／入力漏れ判定（v1と同じ） ---------- */

/* DB読み取りのキャッシュ版（月切替の高速化用・3分）。
 * 明細を変更したら sd_clearRowsCache_ で必ずクリアすること。 */
function sd_readRowsCached_(db) {
  var cache = CacheService.getScriptCache();
  var key = 'sdrows_' + db.sheet;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 壊れていたら読み直す */ } }
  var rows = sd_readRows_(db);
  try {
    var s = JSON.stringify(rows);
    if (s.length < 95000) cache.put(key, s, 180); // CacheServiceの100KB上限に余裕を持たせる
  } catch (e) { /* キャッシュ失敗は無視 */ }
  return rows;
}
function sd_clearRowsCache_(sheetName) {
  try { CacheService.getScriptCache().remove('sdrows_' + sheetName); } catch (e) { /* 無視 */ }
}
function sd_clearAllRowsCache_(det) {
  try {
    (det || sd_detect_()).dbs.forEach(function (db) { CacheService.getScriptCache().remove('sdrows_' + db.sheet); });
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
      edited: cm.edited ? String(d[cm.edited - 1] || '') : ''
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
  var user = sd_auth_(token, false);
  var ss = SpreadsheetApp.getActive();
  var det = sd_detect_();
  var master = sd_masterStores_(det);
  var cfg = sd_allowedStores_(user, sd_config_(master, det));
  var issued = sd_issuedMap_(det);
  var sentLog = sd_sentMap_();

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

  var stores = cfg.map(function (st) {
    var rows = st.db ? sd_readRowsCached_(st.db) : [];
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

    var paidByMonth = paidAll[sd_norm_(st.name)] || {};
    var matrix = {};
    months.forEach(function (mk) {
      var s = settleFor(mk);
      var sent = (sentLog[sd_norm_(st.name)] || {})[mk];
      matrix[mk] = {
        count: s.count, cost: s.varCost + s.royF,
        sales: s.sales, transfer: s.hasSales ? s.transfer : null,
        ns: s.hasSales ? s.ns : null,
        sent: !!sent, paid: !!(paidByMonth[mk] && paidByMonth[mk].done)
      };
    });
    var chk = st.db ? sd_missing_(byMonth, monthKey, st.required) : { missing: [], catWarn: ['DBシート未検出'] };
    var curRows = (byMonth[monthKey] || []).map(function (r) {
      return { row: r.row, kubun: r.kubun, item: r.item, amount: r.amount, tax: r.tax, note: r.note, editor: r.editor, at: r.at, edited: r.edited };
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
        paid: paidByMonth[monthKey] || null // {done, date, by} or null
      }
    };
  });

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
    sheetUrl: user.role === '本部' ? ss.getUrl() : '',
    updatedAt: Utilities.formatDate(new Date(), SD_TZ, 'yyyy-MM-dd HH:mm')
  };
}

/* ---------- API: 明細追加（本部のみ） ---------- */

function sd_addRows(token, payload) {
  var user = sd_auth_(token, true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var det = sd_detect_();
    var master = sd_masterStores_(det);
    var cfg = sd_config_(master, det);
    var st = null;
    cfg.forEach(function (s) { if (s.name === payload.store) st = s; });
    if (!st) throw new Error('店舗が見つかりません: ' + payload.store);
    if (!st.db) throw new Error('店舗「' + payload.store + '」のDBシートが見つかりません。「' + SD_CONFIG_SHEET + '」で指定してください。');

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
      var dups = [];
      rows.forEach(function (r) {
        var hit = existing.some(function (e) {
          return sd_norm_(e.item) === sd_norm_(r.item) && Number(e.amount) === Number(r.amount);
        });
        if (hit) dups.push(r.item + '（¥' + Number(r.amount).toLocaleString() + '）');
      });
      if (dups.length) return { ok: false, dup: dups };
    }

    var added = sd_appendRows_(st.db, ymDate, rows, payload.editor || user.name);
    sd_clearRowsCache_(st.db.sheet);
    return { ok: true, added: added, sheet: st.db.sheet, month: payload.month };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- API: 明細修正（本部のみ） ----------
 * 誤修正防止のため、元の費目名・金額が一致するかをサーバー側でも検証してから上書きする。
 * 修正日はDBの「修正日」列（無ければ自動作成）に記録される。 */
function sd_updateRow(token, payload) {
  // payload = { store, row, orig:{item, amount}, kubun, item, amount, tax, note }
  var user = sd_auth_(token, true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
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

    // 元データの一致確認（他の人が同時に編集した場合の誤上書き防止）
    var curItem = String(sh.getRange(row, cm.item).getDisplayValue()).trim();
    var curAmtRaw = sh.getRange(row, cm.amount).getValue();
    var curAmt = (typeof curAmtRaw === 'number') ? curAmtRaw
      : Number(String(curAmtRaw).replace(/[¥￥,，\s]/g, '')) || 0;
    if (sd_norm_(curItem) !== sd_norm_(payload.orig.item) || Math.round(curAmt) !== Math.round(Number(payload.orig.amount))) {
      throw new Error('この行は別の場所で変更されています。再読込してからもう一度修正してください（現在: ' + curItem + ' ¥' + curAmt.toLocaleString() + '）');
    }
    var newItem = String(payload.item || '').trim();
    if (!newItem) throw new Error('費目名が空です');
    var newAmt = Number(String(payload.amount).replace(/[¥￥,，\s]/g, ''));
    if (isNaN(newAmt)) throw new Error('金額が数値ではありません');

    // 修正日列が無ければヘッダー行に自動作成
    if (!cm.edited) {
      var width = 0;
      Object.keys(cm).forEach(function (k) { if (cm[k] > width) width = cm[k]; });
      sh.getRange(st.db.headerRow, width + 1).setValue('修正日');
      cm.edited = width + 1;
    }
    sh.getRange(row, cm.kubun).setValue(payload.kubun || '変動費');
    sh.getRange(row, cm.item).setValue(newItem);
    sh.getRange(row, cm.amount).setValue(newAmt);
    if (cm.tax) sh.getRange(row, cm.tax).setValue(payload.tax || '10%');
    if (cm.note) sh.getRange(row, cm.note).setValue(String(payload.note || ''));
    sh.getRange(row, cm.edited).setValue(Utilities.formatDate(new Date(), SD_TZ, 'M/d') + ' ' + user.name);
    sd_clearRowsCache_(st.db.sheet);
    return { ok: true, row: row, item: newItem };
  } finally {
    lock.releaseLock();
  }
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
      if (storeNames.indexOf(st.name) < 0) return;
      if (!st.db) { results.push(st.name + ': DBシート未検出'); return; }
      var amt = sums[sd_norm_(st.salesName)];
      if (amt == null) { results.push(st.name + ': 売上シートにデータなし'); return; }
      var item = (d.getMonth() + 1) + '月現金売上';
      sd_appendRows_(st.db, d, [{
        kubun: '売上', item: item, amount: amt, tax: '10%',
        note: '分析_日別店舗より自動取込'
      }], user.name);
      sd_clearRowsCache_(st.db.sheet);
      results.push(st.name + ': ¥' + amt.toLocaleString() + ' を登録');
    });
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
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
        body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + ext['ダッシュボードURL'];
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
    return sd_prepareMonthCore_(monthKey, user.name);
  } finally {
    lock.releaseLock();
  }
}

function sd_prepareMonthCore_(monthKey, editorName) {
  var det = sd_detect_();
  var cfg = sd_config_(sd_masterStores_(det), det);
  var recur = sd_recurRows_();
  var d = sd_monthKeyToDate_(monthKey);
  var prevKey = sd_addMonths_(monthKey, -1);
  var results = [];
  cfg.forEach(function (st) {
    if (!st.db) return;
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
    // 定期費目シート
    recur.forEach(function (rc) {
      if (sd_norm_(rc.store) !== sd_norm_(st.name)) return;
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

function sd_recurRows_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SD_RECUR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SD_RECUR_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['店舗名', '区分', '費目名', '金額（税込）', '税率', '備考']]);
    sh.setFrozenRows(1);
    sh.getRange(2, 1, 1, 6).setValues([['（例）秋葉原 肉寿司', '固定ロイヤリティ', '固定ロイヤリティ', 440000, '10%', '新契約に伴う委託料　※行頭の（例）を消すと有効']]);
    sh.autoResizeColumns(1, 6);
    return [];
  }
  var lastR = sh.getLastRow();
  if (lastR < 2) return [];
  var out = [];
  sh.getRange(2, 1, lastR - 1, 6).getDisplayValues().forEach(function (r) {
    var store = String(r[0]).trim();
    if (!store || store.indexOf('（例）') === 0) return;
    out.push({
      store: store, kubun: String(r[1]).trim() || '変動費', item: String(r[2]).trim(),
      amount: Number(String(r[3]).replace(/[¥￥,，\s]/g, '')) || 0,
      tax: sd_norm_(r[4]) || '10%', note: String(r[5]).trim()
    });
  });
  return out.filter(function (r) { return r.item; });
}

/* 自動処理のセットアップ:
 *  - 毎月1日 9時: 精算対象月（＝前月）の定期費目を自動セット
 *  - 毎月18日 9時: 振込期限（20日）前のリマインドを本部メールへ送信 */
function sd_setupAutoPrep(token) {
  sd_auth_(token, true);
  var triggers = ScriptApp.getProjectTriggers();
  var hasPrep = triggers.some(function (t) { return t.getHandlerFunction() === 'sd_autoPrepTick'; });
  var hasRemind = triggers.some(function (t) { return t.getHandlerFunction() === 'sd_remindTick'; });
  var made = [];
  if (!hasPrep) {
    ScriptApp.newTrigger('sd_autoPrepTick').timeBased().onMonthDay(1).atHour(9).create();
    made.push('毎月1日9時 定期費目セット');
  }
  if (!hasRemind) {
    ScriptApp.newTrigger('sd_remindTick').timeBased().onMonthDay(18).atHour(9).create();
    made.push('毎月18日9時 振込期限リマインド');
  }
  return { ok: true, message: made.length ? made.join('＋') + ' を設定しました' : '自動処理は設定済みです（毎月1日 定期費目セット／毎月18日 リマインド）' };
}

function sd_autoPrepTick() {
  var now = new Date();
  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  var res = sd_prepareMonthCore_(monthKey, '自動(毎月1日)');
  sd_log_('定期費目自動セット', '全店舗', monthKey, res.results.join(' / '), '', '', '自動', '');
}

/* 毎月18日: 振込期限（20日）前のリマインド。入力漏れ疑い・未発行の店舗をまとめて本部へ送信 */
function sd_remindTick() {
  var now = new Date();
  var monthKey = sd_fmtMonth_(new Date(now.getFullYear(), now.getMonth() - 1, 1)); // 精算対象月＝前月
  var det = sd_detect_();
  var ext = sd_extConfig_();
  var to = ext['リマインド送信先'] || 'info@ns0314.com';
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
    var isPaid = !!((paid[sd_norm_(st.name)] || {})[monthKey] && paid[sd_norm_(st.name)][monthKey].done);
    var status = isPaid ? '💰振込済み' : (isSent ? '✅発行済み（振込待ち）' : (s.count > 0 ? '🟡入力中 ' + s.count + '件' : '❌未入力'));
    var warns = chk.catWarn.concat(chk.missing);
    if (isPaid && !warns.length) return; // 完了店舗は省略
    var line = '■ ' + st.name + '：' + status;
    if (s.hasSales) line += '　振込金額(税込) ' + sd_yen_(s.transfer);
    if (warns.length) { line += '\n　└ 入力漏れの疑い: ' + warns.join('、'); }
    if (!isPaid) needCount++;
    lines.push(line);
  });

  var subject = '【リマインド】' + mLabel + '分 業務委託料の振込期限が近づいています（20日期限）';
  var body = '本部ご担当者様\n\n'
    + mLabel + '分の業務委託料の振込期限（毎月20日）が近づいています。\n'
    + '現在の状況をお知らせします（対応が必要: ' + needCount + '店舗）。\n\n'
    + (lines.length ? lines.join('\n\n') : 'すべての店舗が振込済みです。')
    + '\n\n※このメールは精算ダッシュボードから毎月18日に自動送信されています。';
  GmailApp.sendEmail(to, subject, body, { name: ext['メール送信者名'] || '精算ダッシュボード' });
  sd_log_('期限リマインド', '全店舗', monthKey, subject, '', '', '自動', to);
  return { ok: true, to: to };
}

/* ---------- ③ 添付ファイル ---------- */

function sd_folderFor_(ext, monthKey, store) {
  var parent;
  try {
    parent = DriveApp.getFolderById(ext['添付親フォルダID']);
  } catch (e) {
    throw new Error('添付親フォルダにアクセスできません。「' + SD_EXT_SHEET + '」シートの添付親フォルダIDを確認してください');
  }
  var mName = sd_monthLabel_(monthKey); // 例: 2026年6月
  var mFolder = sd_childFolder_(parent, mName);
  return sd_childFolder_(mFolder, store);
}

function sd_childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sd_uploadAttachment(token, payload) {
  // payload = { store, month, kind, fileName, mimeType, b64, revised }
  // revised=true のときは、同名ファイルが既にあれば上書きせず「【再】費目名_…」で保存する
  var user = sd_auth_(token, true);
  var ext = sd_extConfig_();
  var kind = String(payload.kind || '').trim();
  if (!kind) throw new Error('何の書類か（例: カード売上）を入力してください');
  var extMatch = String(payload.fileName || '').match(/\.[A-Za-z0-9]+$/);
  var extension = extMatch ? extMatch[0] : '';
  var folder = sd_folderFor_(ext, payload.month, payload.store);

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
  var bytes = Utilities.base64Decode(payload.b64);
  var blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', newName);
  var file = folder.createFile(blob);
  sd_log_(payload.revised ? '添付（修正版）' : '添付アップロード', payload.store, payload.month, newName, file.getId(), file.getUrl(), user.name, '');
  return { ok: true, name: newName, url: file.getUrl(), folder: sd_monthLabel_(payload.month) + '／' + payload.store };
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

    var row = { kubun: payload.kubun || '変動費', item: item, amount: amt, tax: payload.tax || '10%', note: payload.note || '一括計上' };
    months.forEach(function (mk) {
      sd_appendRows_(st.db, sd_monthKeyToDate_(mk), [row], user.name);
    });
    sd_clearRowsCache_(st.db.sheet);
    sd_log_('一括計上', payload.store, months[0] + '〜' + months[months.length - 1], item + ' ¥' + amt + ' ×' + months.length + 'ヶ月', '', '', user.name, '');
    return { ok: true, months: months, item: item, amount: amt, store: payload.store };
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
    accSh.getRange(2, 1, lastR - 1, 6).getDisplayValues().forEach(function (r) {
      if (String(r[0]).trim()) accounts.push({
        id: String(r[0]).trim(), pw: String(r[1]), name: String(r[2]).trim(),
        role: sd_norm_(r[3]) === '本部' ? '本部' : '委託先',
        stores: String(r[4]).trim(), enabled: sd_norm_(r[5]).toUpperCase() !== 'FALSE'
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
  return {
    accounts: accounts,
    corps: corpList,
    stores: cfg.map(function (s) { return { name: s.name, client: s.client, rate: s.rate, hasDb: !!s.db }; }),
    masterSheetUrl: SpreadsheetApp.getActive().getUrl()
  };
}

function sd_saveAccount(token, acc) {
  var user = sd_auth_(token, true);
  if (!acc || !String(acc.id || '').trim()) throw new Error('ログインIDを入力してください');
  if (!String(acc.pw || '').trim()) throw new Error('パスワードを入力してください');
  var sh = sd_authSheet_();
  var lastR = sh.getLastRow();
  var row = 0;
  if (lastR > 1) {
    var ids = sh.getRange(2, 1, lastR - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === String(acc.id).trim()) { row = i + 2; break; }
    }
  }
  var rec = [
    String(acc.id).trim(), String(acc.pw), String(acc.name || acc.id).trim(),
    acc.role === '本部' ? '本部' : '委託先',
    String(acc.stores || '').trim() || (acc.role === '本部' ? '全店' : ''),
    acc.enabled === false ? 'FALSE' : 'TRUE'
  ];
  if (row) sh.getRange(row, 1, 1, 6).setValues([rec]);
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
