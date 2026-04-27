// 直接命令行测试 Tripo (走雷火网关) — 上传图片 → createTask → 轮询 → 下载 GLB
// 用法：node scripts/test_tripo.mjs <imagePath>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 .env.local 里的 token / base
const envPath = path.resolve(__dirname, '..', '.env.local');
const envText = fs.readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE = env.VITE_TRIPO_BASE || 'https://ai.leihuo.netease.com';
const TOKEN = env.VITE_TRIPO_TOKEN;
const MODEL = env.VITE_TRIPO_MODEL || 'tripo-v3.1-20260211';

if (!TOKEN) {
  console.error('VITE_TRIPO_TOKEN 未设置');
  process.exit(1);
}

const imagePath =
  process.argv[2] ||
  path.resolve(
    __dirname,
    '..',
    'Projects/GirlOrangeJacket/page1_concept_to_rough/01_concept/20260427_172536_907.png'
  );

if (!fs.existsSync(imagePath)) {
  console.error('找不到图片:', imagePath);
  process.exit(1);
}

const imageBuf = fs.readFileSync(imagePath);
const imageName = path.basename(imagePath);
const ext = path.extname(imageName).slice(1).toLowerCase() || 'png';
const mime =
  ext === 'jpg' || ext === 'jpeg'
    ? 'image/jpeg'
    : ext === 'png'
    ? 'image/png'
    : 'application/octet-stream';

console.log('[setup]');
console.log('  BASE =', BASE);
console.log('  TOKEN =', TOKEN.slice(0, 10) + '…');
console.log('  MODEL =', MODEL);
console.log('  image =', imagePath, `(${(imageBuf.length / 1024).toFixed(1)} KB, ${mime})`);

// ----- 1) upload --------------------------------------------------------------
async function upload() {
  const form = new FormData();
  form.append('file', new Blob([imageBuf], { type: mime }), imageName);
  console.log('\n[1/4] POST /v2/openapi/upload …');
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v2/openapi/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const text = await r.text();
  console.log(`     HTTP ${r.status} in ${Date.now() - t0}ms`);
  console.log('     body:', text.slice(0, 800));
  if (!r.ok) throw new Error('upload failed');
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error('upload code != 0: ' + json.message);
  return json.data.image_token;
}

// ----- 2) create task --------------------------------------------------------
async function createTask(imageToken) {
  const payload = {
    type: 'image_to_model',
    model_version: MODEL,
    file: { type: ext === 'png' ? 'png' : 'jpg', file_token: imageToken },
    texture: true,
    pbr: true,
    texture_quality: 'standard',
    texture_alignment: 'original_image',
    auto_size: false,
    orientation: 'default',
    quad: false,
    smart_low_poly: false,
    export_uv: true,
    enable_image_autofix: false,
  };
  console.log('\n[2/4] POST /v2/openapi/task …');
  console.log('     payload:', JSON.stringify(payload));
  const r = await fetch(`${BASE}/v2/openapi/task`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  console.log(`     HTTP ${r.status}`);
  console.log('     body:', text.slice(0, 800));
  if (!r.ok) throw new Error('createTask failed');
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error('createTask code != 0: ' + json.message);
  return json.data.task_id;
}

// ----- 3) poll ---------------------------------------------------------------
async function poll(taskId) {
  console.log(`\n[3/4] GET /v2/openapi/task/${taskId} (轮询，每 5s)`);
  let last = -1;
  for (let i = 0; i < 240; i++) {
    const r = await fetch(`${BASE}/v2/openapi/task/${taskId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const text = await r.text();
    if (!r.ok) {
      console.log(`     HTTP ${r.status}: ${text.slice(0, 300)}`);
      throw new Error('poll failed');
    }
    const json = JSON.parse(text);
    const td = json.data ?? json;
    const status = td.status ?? 'unknown';
    const progress = td.progress ?? 0;
    if (progress !== last || i % 6 === 0) {
      last = progress;
      console.log(`     [${new Date().toLocaleTimeString()}] status=${status} progress=${progress}%`);
    }
    if (status === 'success') {
      console.log('     final body:', JSON.stringify(td).slice(0, 1000));
      return td;
    }
    if (['failed', 'cancelled'].includes(status)) {
      console.log('     final body:', JSON.stringify(td));
      throw new Error('task ' + status);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('poll timeout');
}

// ----- 4) download -----------------------------------------------------------
async function download(td) {
  const pickUrl = (obj, key) => {
    const v = obj?.[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof v.url === 'string') return v.url;
    return '';
  };
  const url =
    pickUrl(td.output, 'model') ||
    pickUrl(td.output, 'base_model') ||
    pickUrl(td.output, 'pbr_model');
  if (!url) throw new Error('no model url in output');
  console.log('\n[4/4] downloading', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const out = path.resolve(__dirname, '..', `tripo_test_${td.task_id ?? 'out'}.glb`);
  fs.writeFileSync(out, buf);
  console.log(`     saved ${(buf.length / 1024 / 1024).toFixed(2)} MB → ${out}`);
}

(async () => {
  const t0 = Date.now();
  try {
    const imageToken = await upload();
    const taskId = await createTask(imageToken);
    const td = await poll(taskId);
    await download(td);
    console.log(`\n✅ 全部完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error('\n❌ 失败:', e.message);
    process.exit(1);
  }
})();
