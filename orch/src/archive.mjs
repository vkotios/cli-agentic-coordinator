// Read-only compact evidence. Collector journals and live writers stay separate.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { samePath } from './git.mjs';

export const ARCHIVE_LIMIT = 256 * 1024;
export const DOCUMENT_LIMIT = 2 * 1024 * 1024;
export const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const identity = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
export const stamp = (file) => identity(fs.lstatSync(file, { bigint: true }));
export function checkedId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new OrchError('invalid evidence id', 'bad-id');
  return id;
}
function real(file) {
  try { return fs.realpathSync.native(file); }
  catch (e) { if (e.code !== 'ENOENT' || path.dirname(file) === file) throw e; return path.join(real(path.dirname(file)), path.basename(file)); }
}
export function safe(file) {
  file = path.resolve(file);
  if (!samePath(file, real(file))) throw new OrchError('evidence path traverses a link', 'archive-path-unsafe');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new OrchError('evidence path is linked', 'archive-path-unsafe');
  return file;
}
export async function safeAsync(file) {
  file = path.resolve(file);
  let resolved;
  try { resolved = await fsp.realpath(file); }
  catch (e) { if (e.code !== 'ENOENT' || path.dirname(file) === file) throw e; resolved = path.join(await safeAsync(path.dirname(file)), path.basename(file)); }
  if (!samePath(file, resolved)) throw new OrchError('evidence path traverses a link', 'archive-path-unsafe');
  return file;
}
export function evidencePath(cfg, area, kind, id) {
  if (!['run', 'review'].includes(kind)) throw new OrchError('invalid evidence kind', 'bad-kind');
  return path.join(cfg.stateRoot, 'retention', area, kind, `${checkedId(id)}.json`);
}
export function readDocument(file, limit = DOCUMENT_LIMIT) {
  let fd;
  try {
    fd = fs.openSync(safe(file), 'r');
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > limit) throw new OrchError('evidence document exceeds its read limit', 'archive-oversized');
    const b = Buffer.alloc(limit + 1); let n = 0;
    while (n <= limit) { const got = fs.readSync(fd, b, n, b.length - n, null); if (!got) break; n += got; }
    if (n > limit) throw new OrchError('evidence document grew beyond its read limit', 'archive-oversized');
    return JSON.parse(b.subarray(0, n).toString('utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; if (e instanceof OrchError) throw e; throw new OrchError(`evidence unreadable: ${file}`, 'archive-unreadable'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export async function readDocumentAsync(file, limit = DOCUMENT_LIMIT) {
  let fd;
  try {
    fd = await fsp.open(await safeAsync(file), 'r');
    const s = await fd.stat();
    if (!s.isFile() || s.size > limit) throw new OrchError('evidence document exceeds its read limit', 'archive-oversized');
    const b = Buffer.alloc(limit + 1); let n = 0;
    while (n <= limit) { const { bytesRead } = await fd.read(b, n, b.length - n, null); if (!bytesRead) break; n += bytesRead; }
    if (n > limit) throw new OrchError('evidence document grew beyond its read limit', 'archive-oversized');
    return JSON.parse(b.subarray(0, n).toString('utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; if (e instanceof OrchError) throw e; throw new OrchError(`evidence unreadable: ${file}`, 'archive-unreadable'); }
  finally { if (fd) await fd.close(); }
}
function validate(entry, journal, cfg, kind, id, rootIdentity) {
  if (!entry || !journal || entry.version !== 1 || journal.version !== 1 || entry.kind !== kind || journal.kind !== kind || entry.id !== id || journal.id !== id || entry.state_root !== path.resolve(cfg.stateRoot) || entry.state_identity !== rootIdentity || !entry.data || !entry.data.record || entry.sha256 !== digest(JSON.stringify(entry.data)) || journal.archive_sha256 !== digest(JSON.stringify(entry)) || !['prepared', 'partial', 'complete'].includes(journal.state) || !journal.files || !entry.original || entry.original.path !== (kind === 'run' ? path.join(cfg.runsDir, id) : path.join(cfg.stateRoot, 'reviews', `${id}.json`)) || entry.data.record.id !== id) throw new OrchError('compact evidence or retirement journal is invalid', 'archive-unreadable');
  const rec = entry.data.record;
  for (const [source, current] of [[entry.data.source_files, journal.files], [entry.data.control_files, journal.controls]]) {
    if (!source || !current || Object.keys(source).sort().join('\0') !== Object.keys(current).sort().join('\0') || Object.entries(source).some(([name, f]) => !current[name] || f.identity !== current[name].identity || f.sha256 !== current[name].sha256 || f.bytes !== current[name].bytes || !['planned', 'deleting', 'removed'].includes(current[name].state)) || journal.state === 'complete' && Object.values(current).some((f) => f.state !== 'removed')) throw new OrchError('retirement file evidence is invalid', 'archive-unreadable');
  }
  if (kind === 'run' && journal.state === 'complete' && journal.directory_state !== 'removed') throw new OrchError('retirement directory evidence is invalid', 'archive-unreadable');
  if (kind === 'run' && (!['completed', 'failed', 'cancelled', 'interrupted', 'blocked', 'blocked-quota', 'turn-cap'].includes(rec.status) || entry.data.quiescent !== true || !entry.data.facts || !entry.data.transcripts) || kind === 'review' && !rec.finished_at) throw new OrchError('compact evidence is not finalized', 'archive-unreadable');
}
function checkOriginal(entry, journal, present, originalIdentity, record) {
  if (present) {
    if (originalIdentity !== entry.original.identity) throw new OrchError('original evidence identity changed', 'archive-changed');
    if (record) {
      if (digest(JSON.stringify(record)) !== entry.data.record_sha256) throw new OrchError('original record conflicts with compact evidence', 'archive-changed');
    } else if (!['deleting', 'removed'].includes((journal.files['run.json'] || {}).state)) throw new OrchError('original record unexpectedly missing', 'archive-changed');
  } else if (entry.kind === 'run' ? !['deleting', 'removed'].includes(journal.directory_state) : !['deleting', 'removed'].includes((journal.files[`${entry.id}.json`] || {}).state)) throw new OrchError('original evidence unexpectedly missing', 'archive-changed');
}
export function readArchived(cfg, kind, id) {
  checkedId(id);
  let entry = readDocument(evidencePath(cfg, 'archive', kind, id), ARCHIVE_LIMIT);
  const journal = readDocument(evidencePath(cfg, 'retired', kind, id));
  if (!entry && !journal) {
    const sealed = readDocument(evidencePath(cfg, 'sealed', kind, id));
    if (sealed && !fs.existsSync(safe(kind === 'run' ? path.join(cfg.runsDir, id, 'run.json') : path.join(cfg.stateRoot, 'reviews', id + '.json')))) throw new OrchError('compact evidence unexpectedly missing for a sealed record', 'archive-unreadable');
    return null;
  }
  if (!entry && journal?.state === 'prepared' && Object.values(journal.files || {}).every((f) => f.state === 'planned')) entry = journal.entry;
  validate(entry, journal, cfg, kind, id, stamp(safe(cfg.stateRoot)));
  const original = safe(entry.original.path), present = fs.existsSync(original);
  const record = present ? readDocument(kind === 'run' ? path.join(original, 'run.json') : original) : null;
  checkOriginal(entry, journal, present, present ? stamp(original) : null, record);
  return { ...entry.data, metadata: { state: journal.state === 'complete' ? 'retired' : 'retirement-pending', kind, retired_at: journal.completed_at || null }, journal };
}
export async function readArchivedAsync(cfg, kind, id) {
  checkedId(id);
  let entry = await readDocumentAsync(evidencePath(cfg, 'archive', kind, id), ARCHIVE_LIMIT);
  const journal = await readDocumentAsync(evidencePath(cfg, 'retired', kind, id));
  if (!entry && !journal) {
    const sealed = await readDocumentAsync(evidencePath(cfg, 'sealed', kind, id));
    if (sealed) { try { await fsp.stat(await safeAsync(kind === 'run' ? path.join(cfg.runsDir, id, 'run.json') : path.join(cfg.stateRoot, 'reviews', id + '.json'))); } catch (e) { if (e.code === 'ENOENT') throw new OrchError('compact evidence unexpectedly missing for a sealed record', 'archive-unreadable'); throw e; } }
    return null;
  }
  if (!entry && journal?.state === 'prepared' && Object.values(journal.files || {}).every((f) => f.state === 'planned')) entry = journal.entry;
  validate(entry, journal, cfg, kind, id, identity(await fsp.lstat(await safeAsync(cfg.stateRoot), { bigint: true })));
  const original = await safeAsync(entry.original.path);
  let s; try { s = await fsp.lstat(original, { bigint: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const record = s ? await readDocumentAsync(kind === 'run' ? path.join(original, 'run.json') : original) : null;
  checkOriginal(entry, journal, !!s, s ? identity(s) : null, record);
  return { ...entry.data, metadata: { state: journal.state === 'complete' ? 'retired' : 'retirement-pending', kind, retired_at: journal.completed_at || null }, journal };
}
export function readEvidence(cfg, kind, id) {
  const archived = readArchived(cfg, kind, id);
  if (archived) return archived;
  const file = kind === 'run' ? path.join(cfg.runsDir, checkedId(id), 'run.json') : path.join(cfg.stateRoot, 'reviews', `${checkedId(id)}.json`);
  const record = readDocument(file);
  return record ? { record, metadata: { state: 'available', kind } } : null;
}
export async function readEvidenceAsync(cfg, kind, id) {
  const archived = await readArchivedAsync(cfg, kind, id);
  if (archived) return archived;
  const file = kind === 'run' ? path.join(cfg.runsDir, checkedId(id), 'run.json') : path.join(cfg.stateRoot, 'reviews', `${checkedId(id)}.json`);
  const record = await readDocumentAsync(file);
  return record ? { record, metadata: { state: 'available', kind } } : null;
}
export function evidenceIds(cfg, kind) {
  const ids = new Set();
  const dirs = [[kind === 'run' ? cfg.runsDir : path.join(cfg.stateRoot, 'reviews'), true], ...['archive', 'retired', 'sealed'].map((area) => [path.join(cfg.stateRoot, 'retention', area, kind), false])];
  for (const [dir, live] of dirs) {
    if (!fs.existsSync(safe(dir))) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (live && kind === 'run' && (e.isDirectory() || e.isSymbolicLink())) ids.add(e.name);
      else if (e.name.endsWith('.json') && !e.name.startsWith('.')) ids.add(e.name.slice(0, -5));
    }
  }
  return [...ids].sort();
}
export async function evidenceIdsAsync(cfg, kind) {
  const ids = new Set();
  for (const [dir, live] of [[kind === 'run' ? cfg.runsDir : path.join(cfg.stateRoot, 'reviews'), true], ...['archive', 'retired', 'sealed'].map((area) => [path.join(cfg.stateRoot, 'retention', area, kind), false])]) {
    let entries; try { entries = await fsp.readdir(await safeAsync(dir), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const e of entries) {
      if (live && kind === 'run' && (e.isDirectory() || e.isSymbolicLink())) ids.add(e.name);
      else if (e.name.endsWith('.json') && !e.name.startsWith('.')) ids.add(e.name.slice(0, -5));
    }
  }
  return [...ids].sort();
}
export const listReviewEvidence = (cfg) => evidenceIds(cfg, 'review').map((id) => readEvidence(cfg, 'review', id)).map((e) => { if (!e) throw new OrchError('review inventory unreadable', 'archive-unreadable'); return e.record; });
export const listRunEvidence = (cfg) => evidenceIds(cfg, 'run').map((id) => readEvidence(cfg, 'run', id)).map((e) => { if (!e) throw new OrchError('run inventory unreadable', 'archive-unreadable'); return e.record; });
export const readScopeEvidence = (cfg, id) => readArchived(cfg, 'run', id)?.scope || readDocument(path.join(cfg.runsDir, checkedId(id), 'scope.json'));
export function assertLive(cfg, kind, id) {
  if (readArchived(cfg, kind, id)) throw new OrchError('record retired or retirement pending; use preserved evidence', 'record-retired');
}
