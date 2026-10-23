import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJSON } from './lib.mjs';

const key = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM;
const file = path.join(ROOT, 'out', 'email', 'latest.html');

const subs = (await readJSON(path.join(ROOT, 'data', 'subscribers.json'), []) ?? [])
  .filter((s) => s && s.email && s.active !== false);

if (!key || !from) {
  console.log(`skip send: no RESEND_API_KEY/RESEND_FROM (${subs.length} subscribers waiting)`);
  process.exit(0);
}
if (!subs.length) {
  console.log('skip send: no subscribers');
  process.exit(0);
}

const html = await fs.readFile(file, 'utf8');
const subject = (await fs.readFile(path.join(ROOT, 'out', 'email', 'subject.txt'), 'utf8')).trim();

for (let i = 0; i < subs.length; i += 100) {
  const chunk = subs.slice(i, i + 100);
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(chunk.map((s) => ({
      from,
      to: [s.email],
      subject,
      html: html.replace('回复本邮件可退订。', `回复本邮件可退订（${s.email}）。`),
    }))),
  });
  if (!res.ok) {
    console.error(`batch ${i / 100 + 1} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  await res.json().catch(() => ({}));
  console.log(`batch ${i / 100 + 1}: ${chunk.length} sent`);
}
