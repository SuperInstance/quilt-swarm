/**
 * SecretManager tests — focuses on rotation and idempotent upserts.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { SecretManager } from '../src/secret-manager.js';
import { createFakeDocker } from './_fixtures.js';

describe('SecretManager', () => {
  let docker: ReturnType<typeof createFakeDocker>['docker'];
  let state: ReturnType<typeof createFakeDocker>['state'];
  let mgr: SecretManager;

  beforeEach(() => {
    const fake = createFakeDocker();
    docker = fake.docker;
    state = fake.state;
    mgr = new SecretManager({ docker, namespace: 'q_' });
  });

  it('creates a new secret on first upsert', async () => {
    const r = await mgr.upsert({ ref: 'B1', name: 'database-url', data: 'postgres://example' });
    assert.equal(r.name, 'q_database_url');
    assert.equal(r.version, '1');
    assert.equal(state.secrets.size, 1);
  });

  it('updates an existing secret on subsequent upserts without changing id', async () => {
    const r1 = await mgr.upsert({ ref: 'B1', name: 'database-url', data: 'first' });
    const r2 = await mgr.upsert({ ref: 'B1', name: 'database-url', data: 'second' });
    assert.equal(r1.id, r2.id);
    assert.equal(r2.rotatedAt !== null, true);
    assert.equal(state.secrets.size, 1);
  });

  it('rotates a secret in place and bumps the version', async () => {
    await mgr.upsert({ ref: 'B1', name: 'database-url', data: 'first' });
    const r = await mgr.rotate('q_database_url', 'rotated');
    assert.equal(r.version, '2');
  });

  it('removes a managed secret', async () => {
    await mgr.upsert({ ref: 'B1', name: 'api-key', data: 'k1' });
    await mgr.remove('q_api_key');
    assert.equal(state.secrets.size, 0);
  });

  it('throws when rotating an unknown secret', async () => {
    await assert.rejects(() => mgr.rotate('does_not_exist', 'x'));
  });

  it('lists only Quilt-managed secrets', async () => {
    await mgr.upsert({ ref: 'B1', name: 'a', data: '1' });
    await mgr.upsert({ ref: 'B2', name: 'b', data: '2' });
    const list = await mgr.list();
    assert.equal(list.length, 2);
    for (const r of list) {
      assert.equal(r.labels['quilt.managed-by'], 'quilt-swarm');
    }
  });
});
