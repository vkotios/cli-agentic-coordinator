// Role delivery comes from the installed kit, never an ignored file in a worker worktree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.mjs';

const TEMPLATES = path.resolve(fileURLToPath(new URL('../../templates/instructions/', import.meta.url)));
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function rolePrompt(handoff, role) {
  const name = role === 'implement' ? 'implementer' : role === 'review' ? 'reviewer' : null;
  if (!name) throw new OrchError('invalid launch role', 'bad-role');
  const common = fs.readFileSync(path.join(TEMPLATES, 'common.md'));
  const assigned = fs.readFileSync(path.join(TEMPLATES, `${name}.md`));
  const packet = Buffer.concat([
    Buffer.from(`# Orch launch contract (v1)\nRole: ${name}\n\n`), common,
    Buffer.from('\n'), assigned, Buffer.from('\n# Supplied handoff (original bytes follow)\n\n'),
  ]);
  return {
    prompt: Buffer.concat([packet, handoff]),
    provenance: { schema: 1, role: name, bytes: packet.length, sha256: hash(packet),
      sources: ['templates/instructions/common.md', `templates/instructions/${name}.md`] },
  };
}
