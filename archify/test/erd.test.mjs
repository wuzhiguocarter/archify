// Focused coverage for the erd renderer: schema shape, crow's-foot marker
// output, and the hand-written layout rules. Public behavior is exercised
// through the CLI/render seams, per the repository test contract.
//
//   node --test test/erd.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin', 'archify.mjs');
const renderer = path.join(skillRoot, 'renderers/erd/render-erd.mjs');
const example = path.join(skillRoot, 'examples/subscription-commerce.erd.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-erd-'));

function baseDoc() {
  return {
    schema_version: 1,
    diagram_type: 'erd',
    meta: { title: 'Erd Test', viewBox: [1010, 620] },
    entities: [
      { id: 'customers', name: 'customers', kind: 'core', column: 0, row: 0, attributes: [
        { name: 'id', type: 'uuid', key: 'pk' },
        { name: 'email', type: 'varchar(255)' },
      ] },
      { id: 'orders', name: 'orders', kind: 'core', column: 1, row: 0, attributes: [
        { name: 'id', type: 'uuid', key: 'pk' },
        { name: 'customer_id', type: 'uuid', key: 'fk' },
      ] },
    ],
    relationships: [
      { from: 'customers', to: 'orders', fromCardinality: 'exactly-one', toCardinality: 'zero-or-many', toField: 'customer_id' },
    ],
  };
}

let sequence = 0;

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: skillRoot,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function render(doc, command = 'render') {
  const id = sequence += 1;
  const input = path.join(tmp, `erd-${id}.json`);
  const output = path.join(tmp, `erd-${id}.html`);
  fs.writeFileSync(input, JSON.stringify(doc));
  const args = command === 'render'
    ? ['render', 'erd', input, output]
    : ['validate', 'erd', input, '--json'];
  const result = run(args);
  return { ...result, output };
}

function schemaFailure(doc) {
  const result = render(doc, 'validate');
  assert.notEqual(result.code, 0);
  return JSON.parse(result.stdout);
}

test('erd: schema rejects an unknown cardinality with a path-prefixed error', () => {
  const doc = baseDoc();
  doc.relationships[0].fromCardinality = 'two-or-three';
  const failure = schemaFailure(doc);
  assert.ok(failure.diagnostics.some((entry) => entry.subject.path.startsWith('/relationships/0/fromCardinality')));
});

test('erd: schema rejects an attribute without a type', () => {
  const doc = baseDoc();
  doc.entities[0].attributes.push({ name: 'legacy' });
  const failure = schemaFailure(doc);
  assert.ok(failure.diagnostics.some((entry) => entry.subject.path.startsWith('/entities/0/attributes')));
});

test('erd: schema rejects an out-of-range column', () => {
  const doc = baseDoc();
  doc.entities[0].column = 4;
  const failure = schemaFailure(doc);
  assert.ok(failure.diagnostics.some((entry) => entry.subject.path.startsWith('/entities/0/column')));
});

test('erd: schema rejects a single-entity document', () => {
  const doc = baseDoc();
  doc.entities = [doc.entities[0]];
  doc.relationships = [];
  const failure = schemaFailure(doc);
  assert.ok(failure.diagnostics.some((entry) => entry.subject.path === '/entities'));
});

test('erd: overlapping entities fail layout validation', () => {
  const doc = baseDoc();
  doc.entities[1].column = 0;
  doc.entities[1].row = 0;
  const result = render(doc);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /less than 10px apart/);
});

test('erd: an over-wide entity name fails with a width message', () => {
  const doc = baseDoc();
  doc.entities[0].name = 'An Extremely Long Entity Name That Overflows';
  const result = render(doc);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /wider than/);
});

test('erd: a fromField anchor must name a real attribute', () => {
  const doc = baseDoc();
  doc.relationships[0].toField = 'not_a_column';
  const result = render(doc);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not define/);
});

test('erd: attribute anchors cannot pair with top or bottom ports', () => {
  const doc = baseDoc();
  doc.entities.push({ id: 'audit', name: 'audit_log', kind: 'core', column: 1, row: 1, attributes: [
    { name: 'id', type: 'uuid', key: 'pk' },
  ] });
  doc.relationships.push({ from: 'orders', to: 'audit', fromCardinality: 'exactly-one', toCardinality: 'zero-or-many', toField: 'id' });
  const result = render(doc);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /attribute anchors need fromSide\/toSide left or right/);
});

test('erd: a relationship crossing an unrelated entity fails clean-flow', () => {
  const doc = baseDoc();
  doc.entities = ['a', 'b', 'c'].map((id, column) => ({
    id,
    name: id,
    kind: 'core',
    column,
    row: 0,
    attributes: [{ name: 'id', type: 'uuid', key: 'pk' }],
  }));
  doc.relationships = [
    { from: 'a', to: 'c', fromCardinality: 'exactly-one', toCardinality: 'zero-or-many', route: 'straight' },
  ];
  const result = render(doc);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /edge-through-node|crosses entity/);
});

test('erd: renders crow\'s-foot markers on both ends of every relationship', () => {
  const output = path.join(tmp, 'erd-positive.html');
  execFileSync(process.execPath, [renderer, example, output], { cwd: skillRoot });
  const svg = fs.readFileSync(output, 'utf8').match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
  const relationships = JSON.parse(fs.readFileSync(example, 'utf8')).relationships;
  for (const relationship of relationships) {
    const variant = relationship.variant || 'default';
    assert.ok(svg.includes(`id="erd-${relationship.fromCardinality}-${variant}"`), `marker def for ${relationship.fromCardinality}`);
    assert.ok(svg.includes(`id="erd-${relationship.toCardinality}-${variant}"`), `marker def for ${relationship.toCardinality}`);
  }
  // Legend cardinality swatches reuse the same markers, so scope the endpoint
  // count to relationship paths.
  const relationshipPaths = [...svg.matchAll(/<path\b[^>]*data-composition-points=[^>]*>/g)].map((match) => match[0]);
  assert.equal(relationshipPaths.length, relationships.length);
  for (const path of relationshipPaths) {
    assert.match(path, /marker-start="url\(#erd-/);
    assert.match(path, /marker-end="url\(#erd-/);
  }
});

test('erd: every entity card exposes the semantic node hooks', () => {
  const output = path.join(tmp, 'erd-hooks.html');
  execFileSync(process.execPath, [renderer, example, output], { cwd: skillRoot });
  const svg = fs.readFileSync(output, 'utf8').match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
  const entities = JSON.parse(fs.readFileSync(example, 'utf8')).entities;
  assert.equal((svg.match(/data-node-id=/g) || []).length, entities.length);
  assert.equal((svg.match(/data-node-label=/g) || []).length, entities.length);
  for (const entity of entities) {
    assert.ok(svg.includes(`data-node-id="${entity.id}"`), `node hook for ${entity.id}`);
  }
});

test('erd: the bundled example validates at showcase and renders through the CLI', () => {
  const validated = run(['validate', 'erd', example, '--quality', 'showcase', '--json']);
  assert.equal(validated.code, 0, validated.stderr);
  const receipt = JSON.parse(validated.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.checks.length, 9);
  assert.deepEqual(receipt.composition.summary, { errors: 0, warnings: 0 });

  const output = path.join(tmp, 'erd-cli-render.html');
  const rendered = run(['render', 'erd', example, output]);
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.ok(fs.statSync(output).size > 0);
});
