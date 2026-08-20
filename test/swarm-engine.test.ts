/**
 * SwarmEngine end-to-end tests using the in-memory dockerode fake.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { SwarmEngine } from '../src/swarm-engine.js';
import { createFakeDocker } from './_fixtures.js';

describe('SwarmEngine', () => {
  let docker: ReturnType<typeof createFakeDocker>['docker'];
  let state: ReturnType<typeof createFakeDocker>['state'];
  let engine: SwarmEngine;

  beforeEach(() => {
    const fake = createFakeDocker();
    docker = fake.docker;
    state = fake.state;
    engine = new SwarmEngine({ docker });
  });

  it('initialises a swarm cluster and returns an id', async () => {
    const result = await engine.init({ advertiseAddr: '192.0.2.10:2377' });
    assert.equal(typeof result.swarmId, 'string');
    assert.equal(state.swarms.initialised, true);
  });

  it('joins an existing swarm', async () => {
    await engine.join({
      joinToken: 'SWMTKN-1-test',
      remoteAddrs: ['192.0.2.20:2377'],
      advertiseAddr: '192.0.2.10:2377',
    });
    assert.equal(state.swarms.initialised, true);
  });

  it('leaves the swarm', async () => {
    await engine.init({ advertiseAddr: '192.0.2.10:2377' });
    await engine.leave();
    assert.equal(state.swarms.initialised, false);
  });

  it('inspects the swarm', async () => {
    await engine.init({ advertiseAddr: '192.0.2.10:2377' });
    const info = await engine.inspect();
    assert.ok(info);
    assert.equal(info?.name, 'default');
  });

  it('returns cluster status with services', async () => {
    await engine.deploy({ name: 'web', image: 'nginx:1.27', replicas: 2 });
    state.tasks.push({ ID: 't1', ServiceID: 'svc-1', Status: { State: 'running' } });
    state.tasks.push({ ID: 't2', ServiceID: 'svc-1', Status: { State: 'running' } });
    const status = await engine.status();
    assert.equal(status.managers, 1);
    assert.equal(status.workers, 0);
    assert.equal(status.services.length, 1);
    assert.equal(status.services[0]?.name, 'web');
    assert.equal(status.services[0]?.running, 2);
  });

  it('deploys a service from an inline image', async () => {
    const r = await engine.deploy({ name: 'api', image: 'my/api:1.0', replicas: 3 });
    assert.equal(r.service, 'api');
    assert.equal(r.replicas, 3);
    assert.equal(r.image, 'my/api:1.0');
    assert.equal(state.services.size, 1);
  });

  it('scales a service', async () => {
    await engine.deploy({ name: 'web', image: 'nginx:1.27', replicas: 1 });
    const r = await engine.scale({ service: 'web', replicas: 5 });
    assert.equal(r.replicas, 5);
  });

  it('removes a service', async () => {
    await engine.deploy({ name: 'web', image: 'nginx:1.27' });
    await engine.rm('web');
    assert.equal(state.services.size, 0);
  });

  it('lists services', async () => {
    await engine.deploy({ name: 'web', image: 'nginx:1.27' });
    await engine.deploy({ name: 'api', image: 'my/api:1.0' });
    const list = await engine.ps();
    assert.equal(list.length, 2);
    const names = list.map((s) => s.name).sort();
    assert.deepEqual(names, ['api', 'web']);
  });

  it('deploys from a parsed sheet', async () => {
    const sheet = engine.parseSheet(`
name: hello
rows:
  - A1: greeting-service
    A2: nginx:1.27
    B1: "Hello, world"
    C1: "3000"
`);
    const r = await engine.deploy({ sheet });
    assert.ok(r);
    assert.equal(state.services.size, 1);
  });

  it('rotates a secret in place', async () => {
    const created = await engine.upsertSecret('db', 's3cr3t-1');
    const rotated = await engine.rotateSecret('db', 's3cr3t-2');
    assert.equal(created.id, rotated.id);
    assert.equal(rotated.version, '2');
  });

  it('ensures an encrypted overlay network', async () => {
    const r = await engine.ensureNetwork('quilt-overlay');
    assert.ok(r.id);
    assert.equal(r.encrypted, true);
  });

  it('fetches logs without throwing when log stream is empty', async () => {
    await engine.deploy({ name: 'web', image: 'nginx:1.27' });
    const lines = await engine.logs('web', { tail: 10 });
    assert.ok(Array.isArray(lines));
  });
});
