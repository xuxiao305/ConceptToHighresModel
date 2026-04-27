// Reproduce the client multiview call in Node, hitting the running Vite proxy.
// Usage: node scripts/test_multiview_call.mjs <tpose.png>

import fs from 'node:fs/promises';
import path from 'node:path';

const PROXY = 'http://127.0.0.1:5173/leihuo';
const TOKEN = 'sk-kA46IfJa9q6HVcHPJYhfp0qh0MVpYAsWistSCIbl0cSESdyH';
const MODEL = 'gemini-3-pro-image-preview';

const SYSTEM_PROMPT =
  'You are an expert image-generation engine. You must ALWAYS produce an image.\n' +
  'Interpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\n' +
  'If a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\n' +
  'Prioritize generating the visual representation above any text, formatting, or conversational requests.';

const MULTIVIEW_PROMPT =
  'Change the character to T-Pose, arm fully stretched horizontally, and create a professional character reference sheet based strictly on the uploaded reference image. ' +
  'Use a clean, neutral plain background and present the sheet as a technical model turnaround while matching the exact visual style of the reference (same realism level, rendering approach, texture, color treatment, and overall aesthetic). ' +
  'Arrange the composition into two horizontal rows.\n' +
  'Top row column 1: front view full body\n' +
  'Top row column 2: left profile character facing left\n' +
  'Bottom row columan 1: right profile character facing right\n' +
  'Bottom row column 2: back view\n' +
  'Maintain perfect identity consistency across every panel. Keep the subject in a relaxed A-pose and with consistent scale and alignment between views, accurate anatomy, and clear silhouette; ensure even spacing and clean panel separation, with uniform framing and consistent head height across the full-body lineup and consistent facial scale across the portraits. ' +
  'Lighting should be consistent across all panels (same direction, intensity, and softness), with natural, controlled shadows that preserve detail without dramatic mood shifts.';

async function main() {
  const file = process.argv[2] ?? 'Projects/GirlOrangeJacket/page1_concept_to_rough/02_tpose/20260427_221129_075.png';
  const buf = await fs.readFile(file);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  console.log(`[test] file=${file} sizeKB=${(buf.length / 1024).toFixed(1)}`);

  const seed = Math.floor(Math.random() * 2 ** 31);
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: MULTIVIEW_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    modalities: ['text', 'image'],
    seed,
  };

  console.log(`[test] POST ${PROXY}/v1/chat/completions seed=${seed}`);
  const t0 = Date.now();
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[test] HTTP ${res.status} (${dt}s)`);
  if (!res.ok) {
    const txt = await res.text();
    console.log('[test] body:', txt.slice(0, 1000));
    process.exit(1);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '';
  console.log(`[test] content length=${content.length}, head: ${content.slice(0, 200)}`);
  const m = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(content);
  if (!m) {
    console.log('[test] NO IMAGE in response');
    console.log(content.slice(0, 2000));
    process.exit(1);
  }
  const out = path.join('Data', `multiview_test_${Date.now()}.png`);
  await fs.mkdir('Data', { recursive: true });
  await fs.writeFile(out, Buffer.from(m[1], 'base64'));
  console.log(`[test] saved ${out} (${(Buffer.from(m[1], 'base64').length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('[test] ERROR:', e);
  process.exit(1);
});
