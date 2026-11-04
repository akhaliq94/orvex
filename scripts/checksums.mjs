import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const dir = path.resolve(process.argv[2] || 'release');
const targets = fs.existsSync(dir)
  ? fs
      .readdirSync(dir)
      .filter((name) => /^ORVEX-(Setup|Portable)-.+\.exe$/i.test(name))
      .sort()
  : [];

if (!targets.length) {
  console.error(`No ORVEX installer artifacts found in ${dir}. Run "npm run dist" first.`);
  process.exit(1);
}

const lines = [];
for (const name of targets) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(path.join(dir, name)), hash);
  lines.push(`${hash.digest('hex')}  ${name}`);
}

const file = path.join(dir, 'SHA256SUMS.txt');
fs.writeFileSync(file, `${lines.join('\n')}\n`);
console.log(`Wrote ${file}`);
for (const line of lines) console.log(line);
