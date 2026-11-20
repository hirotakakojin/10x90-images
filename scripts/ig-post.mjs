// 10×90 のインスタ予約投稿（GitHub Actions で動く。PCの電源が切れていても投稿される）
//   node scripts/ig-post.mjs          → 時間が来ていて、まだ出していない投稿を出す
//   node scripts/ig-post.mjs --check  → 確認だけ（投稿しない）
// 予約のしかた: reel-MMDD-vN/ に reel-vN.mp4 と post.json（{"at": "...+09:00", "video": "reel-vN.mp4", "caption": "..."}）を置く
// 止めかた: 同じフォルダに stop というファイルを置く（投稿の直前に確認する）
// 出したら posted.json を置く（二重投稿よけ）。予定から3時間を過ぎたものは出さない
// 決まり: トークンはログに出さない（URLに入れずヘッダーで送る）。@10x90_j1 以外には投稿しない。お金は使わない
import fs from "fs"; import path from "path";
const TOKEN = process.env.IG_ACCESS_TOKEN, UID = process.env.IG_USER_ID;
const EXPECTED = "10x90_j1", REPO_RAW = "https://raw.githubusercontent.com/hirotakakojin/10x90-images/main/";
const GRAPH = "https://graph.facebook.com/v23.0", LATE = 3 * 3600e3;
const check = process.argv.includes("--check"), ROOT = process.cwd();
const log = s => console.log(`[${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}] ${s}`);
const die = s => { console.error("✖ " + s); process.exit(1); };
if (!TOKEN || !UID) die("IG_ACCESS_TOKEN / IG_USER_ID がありません（GitHub の Secrets に入れる）");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, params = {}) {
  const u = new URL(GRAPH + url), body = new URLSearchParams(params), headers = { Authorization: `Bearer ${TOKEN}` };
  let res;
  if (method === "GET") { body.forEach((v, k) => u.searchParams.set(k, v)); res = await fetch(u, { headers }); }
  else res = await fetch(u, { method, body, headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error ? `${j.error.message} (code ${j.error.code}${j.error.error_subcode ? "/" + j.error.error_subcode : ""})` : `HTTP ${res.status}`);
  return j;
}
async function retry(name, fn) {
  for (let k = 1; ; k++) {
    try { return await fn(); }
    catch (e) { if (k >= 3 || !/fetch failed|timeout|ECONNRESET|code (1|2|4|17|100\/33)\b/i.test(e.message)) throw e; log(`${name}: 一時的なエラー、1分後にやり直し（${k}/2）: ${e.message}`); await sleep(60000); }
  }
}
const dirs = fs.readdirSync(ROOT).filter(d => /^reel-\d{4}-v\d$/.test(d) && fs.existsSync(path.join(ROOT, d, "post.json"))).sort();
const now = Date.now(), todo = [];
for (const d of dirs) {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, d, "post.json"), "utf8")), at = Date.parse(p.at);
  const state = fs.existsSync(path.join(ROOT, d, "posted.json")) ? "投稿ずみ" : fs.existsSync(path.join(ROOT, d, "stop")) ? "止めてある" : now < at ? "まだ時間前" : now > at + LATE ? "時間を過ぎすぎ（出さない）" : "出す";
  if (state !== "投稿ずみ" && now < at + 2 * 86400e3) log(`${d} ${p.at} → ${state}`);
  if (state === "出す" || (check && state === "まだ時間前")) todo.push({ d, p });
}
if (!todo.length) { log("いま出すものはありません"); process.exit(0); }
const me = await retry("アカウント確認", () => api("GET", `/${UID}`, { fields: "id,username" }));
if (String(me.username).toLowerCase() !== EXPECTED) die(`このトークンは @${me.username} のものです。@${EXPECTED} 以外には投稿しません`);
log(`アカウント確認OK: @${me.username}`);
let bad = 0;
for (const { d, p } of todo) {
  const cap = p.caption || "", tags = cap.match(/#\S+/g) || [], url = REPO_RAW + d + "/" + p.video;
  try {
    if (!cap.trim()) throw new Error("キャプションが空です");
    if ([...cap].length > 2200) throw new Error("キャプションが2,200文字を超えています");
    if (tags.length > 5) throw new Error("ハッシュタグは5個までです");
    const h = await fetch(url, { method: "HEAD" });
    if (!h.ok) throw new Error(`動画が開けません ${h.status} ${url}`);
    log(`${d}: 動画OK / キャプション ${[...cap].length}文字 / ハッシュタグ ${tags.length}個`);
    if (check) continue;
    if (fs.existsSync(path.join(ROOT, d, "stop"))) { log(`${d}: 止めてあるので出しません`); continue; }
    const c = await retry("動画の受付", () => api("POST", `/${me.id}/media`, { media_type: "REELS", video_url: url, caption: cap, share_to_feed: "true", thumb_offset: "3600" }));
    for (let t = 0; ; t++) {
      const s = await retry("処理の確認", () => api("GET", `/${c.id}`, { fields: "status_code,status" }));
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`動画の処理に失敗: ${s.status_code} ${s.status || ""}`);
      if (t > 60) throw new Error("動画の処理が終わりません（タイムアウト）");
      await sleep(5000);
    }
    const pub = await api("POST", `/${me.id}/media_publish`, { creation_id: c.id });
    const info = await api("GET", `/${pub.id}`, { fields: "permalink" }).catch(() => ({}));
    fs.writeFileSync(path.join(ROOT, d, "posted.json"), JSON.stringify({ at: new Date().toISOString(), url: info.permalink || pub.id }, null, 2) + "\n");
    log(`${d}: 投稿しました ${info.permalink || pub.id}`);
  } catch (e) { bad++; log(`${d}: 失敗 ${e.message}`); }
}
process.exit(bad ? 1 : 0);
