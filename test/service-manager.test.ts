/**
 * ServiceManager tests — focused on cell→service translation rules.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ServiceManager } from '../src/service-manager.js';
import type { QuiltCell, QuiltRow, QuiltSheet } from '../src/types.js';

function cell(ref: string, kind: QuiltCell['kind'], value: string, raw: string = value): QuiltCell {
  return { ref, kind, value, raw };
}

function row(cells: QuiltCell[]): QuiltRow {
  const out: QuiltRow = {};
  for (const c of cells) out[c.ref] = c;
  return out;
}

function sheet(name: string, rows: QuiltRow[]): QuiltSheet {
  return { name, rows, cells: rows.flatMap((r) => Object.values(r)) };
}

describe('ServiceManager', () => {
  it('maps a value cell to an environment variable', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([cell('A1', 'text', 'demo-svc'), cell('C1', 'value', '3000')]));
    assert.ok(spec);
    assert.equal(spec?.env?.['C1'], '3000');
  });

  it('maps a formula cell to a config (sidecar reads it)', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([cell('A1', 'text', 'demo-svc'), cell('D1', 'formula', '=1+1')]));
    assert.ok(spec);
    assert.ok((spec?.configs ?? []).length >= 1);
  });

  it('maps an image cell to the container image', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([cell('A1', 'text', 'demo-svc'), cell('A2', 'image', 'nginx:1.27')]));
    assert.equal(spec?.image, 'nginx:1.27');
    assert.equal(spec?.labels?.['quilt.image.source'], 'A2');
  });

  it('maps a vault cell to a Docker secret', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([
      cell('A1', 'text', 'demo-svc'),
      cell('A2', 'image', 'nginx:1.27'),
      cell('E1', 'vault', 'database-url'),
    ]));
    assert.ok((spec?.secrets ?? []).includes('database-url'));
    assert.equal(spec?.env?.['E1_VAULT_REF'], 'database-url');
  });

  it('maps a network cell to a network attachment', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([
      cell('A1', 'text', 'demo-svc'),
      cell('A2', 'image', 'nginx:1.27'),
      cell('F1', 'network', 'quilt-mesh'),
    ]));
    assert.ok((spec?.networks ?? []).includes('quilt-mesh'));
  });

  it('builds a sidecar spec for a formula cell', () => {
    const m = new ServiceManager();
    const spec = m.ingestRow('demo', 0, row([cell('A1', 'text', 'demo-svc'), cell('D1', 'formula', '=sha256(now)')]));
    assert.ok(spec);
    const sidecar = m.buildFormulaSidecar(spec!, cell('D1', 'formula', '=sha256(now)'));
    assert.equal(sidecar.labels?.['quilt.role'], 'formula-sidecar');
    assert.equal(sidecar.env?.['QUILT_CELL'], 'D1');
  });

  it('skips empty rows', () => {
    const m = new ServiceManager();
    const r = m.ingestRow('demo', 0, {});
    assert.equal(r, null);
  });

  it('ingests a full sheet into multiple services', () => {
    const m = new ServiceManager();
    const s = sheet('web', [
      row([cell('A1', 'text', 'frontend'), cell('A2', 'image', 'nginx:1.27')]),
      row([cell('A1', 'text', 'backend'), cell('A2', 'image', 'my/api:1.0')]),
    ]);
    const services = m.ingestSheet(s);
    assert.equal(services.length, 2);
    const names = services.map((svc) => svc.name).sort();
    assert.deepEqual(names, ['quilt-backend', 'quilt-frontend']);
  });

  it('lists all cell kinds', () => {
    const m = new ServiceManager();
    const kinds = m.kinds();
    assert.deepEqual(kinds, ['value', 'formula', 'text', 'image', 'vault', 'network']);
  });
});
