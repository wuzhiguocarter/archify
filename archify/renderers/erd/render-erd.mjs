import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import { animateAttr, focusEdgeAttrs, focusNodeAttrs, focusNodeTitle, loadDiagramWithBrandMarks, writeDiagram, svgAccessibleText, svgRootAttrs } from '../shared/cli.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import { availableNodeTextWidth, fittedNodeFontSize, minimumNodeTextWidth } from '../shared/text-fit.mjs';
import {
  asArray,
  isFinitePoint,
  rectsOverlap,
  segmentIntersectsRect,
  routeHonorsEndpointSides,
  cleanEndpointSideProblems,
  cleanFlowProblems,
  cleanCrossingProblems,
  cleanAmbiguousCorridorProblems,
  cleanRouteRhythmProblems,
  cleanLabelRouteClearanceProblems,
  suggestLabelObstacleFix,
  suggestLabelPairFix,
  anchor,
  defaultFromSide,
  defaultToSide,
  chosenSide,
  polylinePath,
  routePointsValue,
  labelPoint,
  componentFill,
  componentText,
  arrowClassMap,
  variantAccent
} from '../shared/geometry.mjs';

// Crow's-foot cardinality vocabulary. One enum per relationship end keeps the
// authored fact identical to the drawn symbol and maps 1:1 onto Mermaid's
// erDiagram operators: || -> exactly-one, o| -> zero-or-one, }| -> one-or-many,
// }o -> zero-or-many.
const CARDINALITIES = ['exactly-one', 'zero-or-one', 'one-or-many', 'zero-or-many'];
const VARIANTS = ['default', 'emphasis', 'security', 'dashed'];

const ENTITY_KINDS = {
  core: { componentType: 'backend', fill: 'c-backend' },
  reference: { componentType: 'cloud', fill: 'c-cloud' },
  junction: { componentType: 'database', fill: 'c-database' },
  external: { componentType: 'external', fill: 'c-external' },
};

const SIDE_VECTORS = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { diagram: erd, template, outPath } = await loadDiagramWithBrandMarks({
  rendererDir: __dirname,
  diagramType: 'erd',
  defaultExample: 'subscription-commerce.erd.json'
});

const viewBox = erd.meta?.viewBox || [1120, 860];

const layout = {
  leftX: 130,
  colGap: 250,
  topY: 48,
  headerH: 24,
  headerPadTop: 4,
  rowH: 14,
  rowPadBottom: 6,
  rowGap: 54,
  entityW: 150,
  namePreferred: 10,
  nameMinimum: 8,
  attrFont: 7,
  typeFont: 6.5,
  keyFont: 5.5,
  keyColumnW: 14,
  attrPadX: 6,
  attrTypeGap: 8,
  minPortGap: 8,
  minRelationshipLength: 40,
  legendBaselineOffset: 36,
  legendLineGap: 22,
  legendTitleBand: 30,
  legendEntityGap: 24,
};

function entityHeight(entity) {
  return layout.headerH + layout.headerPadTop + asArray(entity.attributes).length * layout.rowH + layout.rowPadBottom;
}

// Two deterministic passes: attribute counts decide card heights, row tops
// then accumulate the tallest measured card per row.
function computeRowYs(entities) {
  const rowHeights = [];
  for (const entity of entities) {
    rowHeights[entity.row] = Math.max(rowHeights[entity.row] || 0, entityHeight(entity));
  }
  const rowYs = [];
  let top = layout.topY;
  for (let row = 0; row <= 3; row += 1) {
    rowYs[row] = top;
    if (rowHeights[row]) top += rowHeights[row] + layout.rowGap;
  }
  return rowYs;
}

function measureEntity(entity, rowYs) {
  const width = entity.width || layout.entityW;
  const height = entityHeight(entity);
  const cx = layout.leftX + entity.column * layout.colGap;
  const y = rowYs[entity.row] + (entity.yOffset || 0);
  return {
    ...entity,
    width,
    height,
    cx,
    cy: y + height / 2,
    x: cx - width / 2,
    y,
  };
}

const rowYs = computeRowYs(asArray(erd.entities));
const entities = new Map(asArray(erd.entities).map((entity) => [entity.id, measureEntity(entity, rowYs)]));

const entitySteps = new Map();
for (const [index, relationship] of asArray(erd.relationships).entries()) {
  if (!entitySteps.has(relationship.from)) entitySteps.set(relationship.from, index);
  if (!entitySteps.has(relationship.to)) entitySteps.set(relationship.to, index + 1);
}
for (const [index, entity] of asArray(erd.entities).entries()) {
  if (!entitySteps.has(entity.id)) entitySteps.set(entity.id, index);
}

function fieldRowIndex(entity, fieldName) {
  return asArray(entity.attributes).findIndex((attribute) => attribute.name === fieldName);
}

function fieldRowCenterY(entity, rowIndex) {
  return entity.y + layout.headerH + layout.headerPadTop + rowIndex * layout.rowH + layout.rowH / 2;
}

function relationshipSides(relationship) {
  const from = entities.get(relationship.from);
  const to = entities.get(relationship.to);
  return {
    fromSide: chosenSide(relationship.fromSide, defaultFromSide(from, to)),
    toSide: chosenSide(relationship.toSide, defaultToSide(from, to)),
  };
}

// Field-aware ports: left/right anchors can sit on the attribute row carrying
// the key; ports sharing one entity side spread apart with a minimum gap.
function resolvePorts() {
  const groups = new Map();
  const ports = new Map();

  const basePort = (relationship, endpoint) => {
    const { fromSide, toSide } = relationshipSides(relationship);
    const side = endpoint === 'from' ? fromSide : toSide;
    const entity = entities.get(endpoint === 'from' ? relationship.from : relationship.to);
    const point = anchor(entity, side);
    const fieldName = endpoint === 'from' ? relationship.fromField : relationship.toField;
    if (fieldName && (side === 'left' || side === 'right')) {
      const rowIndex = fieldRowIndex(entity, fieldName);
      if (rowIndex >= 0) point[1] = fieldRowCenterY(entity, rowIndex);
    }
    return point;
  };

  for (const relationship of asArray(erd.relationships)) {
    if (!entities.has(relationship.from) || !entities.has(relationship.to)) continue;
    ports.set(relationship, { from: basePort(relationship, 'from'), to: basePort(relationship, 'to') });
    if (relationship.route && relationship.route !== 'auto') continue;
    if (relationship.via) continue;
    const { fromSide, toSide } = relationshipSides(relationship);
    for (const [endpoint, side, entityId] of [
      ['from', fromSide, relationship.from],
      ['to', toSide, relationship.to],
    ]) {
      const key = `${entityId} ${side}`;
      const items = groups.get(key) || [];
      items.push({ relationship, endpoint, entityId, side });
      groups.set(key, items);
    }
  }

  for (const items of groups.values()) {
    if (items.length < 2) continue;
    const vertical = items[0].side === 'left' || items[0].side === 'right';
    const axis = vertical ? 1 : 0;
    const entity = entities.get(items[0].entityId);
    const min = (vertical ? entity.y : entity.x) + 9;
    const max = (vertical ? entity.y + entity.height : entity.x + entity.width) - 9;
    const coordinates = items.map((item) => ports.get(item.relationship)[item.endpoint][axis]);
    const lowest = Math.max(...coordinates);
    const highest = Math.min(...coordinates);
    const spread = (lowest - highest) >= layout.minPortGap * (items.length - 1);
    if (spread && lowest <= max && highest >= min) continue;
    // Push forward to honor the gap, then pull the tail back inside the edge.
    let cursor = highest;
    const adjusted = items.map((item) => {
      const value = Math.max(cursor, min);
      cursor = value + layout.minPortGap;
      return value;
    });
    let ceiling = max;
    for (let index = adjusted.length - 1; index >= 0; index -= 1) {
      adjusted[index] = Math.min(adjusted[index], ceiling);
      ceiling = adjusted[index] - layout.minPortGap;
    }
    for (const [index, item] of items.entries()) {
      ports.get(item.relationship)[item.endpoint][axis] = adjusted[index];
    }
  }
  return ports;
}

const automaticPorts = resolvePorts();

function routeSegments(points) {
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({ start: points[index], end: points[index + 1] });
  }
  return segments;
}

// Side-honoring orthogonal candidates, ordered cheap-to-expensive. The first
// route that keeps its endpoint contracts, clears unrelated entities, and
// respects the micro-segment floor wins; the fallback stays diagnosable.
function routeCandidates(start, end, fromSide, toSide) {
  const horizontalFrom = fromSide === 'left' || fromSide === 'right';
  const horizontalTo = toSide === 'left' || toSide === 'right';
  const stubs = [30, 48, 66];
  const list = [];

  if (horizontalFrom === horizontalTo) {
    if (horizontalFrom) {
      if (Math.abs(start[1] - end[1]) < 0.01) return [[]];
      const midX = (start[0] + end[0]) / 2;
      list.push([[midX, start[1]], [midX, end[1]]]);
      for (const stub of stubs) {
        for (const channelX of [Math.max(start[0], end[0]) + stub, Math.min(start[0], end[0]) - stub]) {
          list.push([[channelX, start[1]], [channelX, end[1]]]);
        }
      }
    } else {
      if (Math.abs(start[0] - end[0]) < 0.01) return [[]];
      const midY = (start[1] + end[1]) / 2;
      list.push([[start[0], midY], [end[0], midY]]);
      for (const stub of stubs) {
        for (const channelY of [Math.max(start[1], end[1]) + stub, Math.min(start[1], end[1]) - stub]) {
          list.push([[start[0], channelY], [end[0], channelY]]);
        }
      }
    }
    return list;
  }

  if (horizontalFrom) {
    const outward = SIDE_VECTORS[fromSide][0];
    const inward = SIDE_VECTORS[toSide][1];
    list.push([[end[0], start[1]]]);
    for (const stub of stubs) {
      const channelX = start[0] + outward * stub;
      const joinY = end[1] + inward * stub;
      list.push([[channelX, start[1]], [channelX, joinY], [end[0], joinY]]);
    }
  } else {
    const outward = SIDE_VECTORS[fromSide][1];
    const inward = SIDE_VECTORS[toSide][0];
    list.push([[start[0], end[1]]]);
    for (const stub of stubs) {
      const channelY = start[1] + outward * stub;
      const joinX = end[0] + inward * stub;
      list.push([[start[0], channelY], [joinX, channelY], [joinX, end[1]]]);
    }
  }
  return list;
}

function routeVia(relationship, from, to, start, end, fromSide, toSide) {
  if (relationship.via) return relationship.via;
  switch (relationship.route || 'auto') {
    case 'straight':
      return [];
    case 'orthogonal-h':
      return [[end[0], start[1]]];
    case 'orthogonal-v':
      return [[start[0], end[1]]];
    case 'auto':
    default: {
      const obstacles = [...entities.values()].filter((entity) => entity !== from && entity !== to);
      const candidates = routeCandidates(start, end, fromSide, toSide);
      for (const candidate of candidates) {
        const points = [start, ...candidate, end];
        const clearsObstacles = obstacles.every((obstacle) => routeSegments(points).every(
          (segment) => !segmentIntersectsRect(segment, obstacle, 2)
        ));
        const noMicroSegments = routeSegments(points).every((segment) => (
          Math.hypot(segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]) >= 8
        ));
        if (routeHonorsEndpointSides(points, fromSide, toSide) && clearsObstacles && noMicroSegments) {
          return candidate;
        }
      }
      return candidates[0] || [];
    }
  }
}

const pathCache = new Map();

function pathFor(relationship) {
  if (pathCache.has(relationship)) return pathCache.get(relationship);
  const from = entities.get(relationship.from);
  const to = entities.get(relationship.to);
  const ports = automaticPorts.get(relationship);
  const { fromSide, toSide } = relationshipSides(relationship);
  const start = ports?.from || anchor(from, fromSide);
  const end = ports?.to || anchor(to, toSide);
  const points = [start, ...routeVia(relationship, from, to, start, end, fromSide, toSide), end];
  const routed = { d: polylinePath(points), points };
  pathCache.set(relationship, routed);
  return routed;
}

function relationshipLabelSize(relationship) {
  return {
    width: Math.round(Math.max(34, textUnits(relationship.label || '') * 4.9 + 12) * 10) / 10,
    height: layout.rowH + 2,
  };
}

// The shared labelPoint floats labels above horizontal segments; vertical
// segments need the mask centered on the line instead, or the label lands
// inside the source card.
function erdLabelPoint(relationship, points) {
  if (relationship.labelAt) return relationship.labelAt;
  const segmentIndex = Math.min(points.length - 2, Math.max(0, relationship.labelSegment ?? (points.length === 2 ? 0 : 1)));
  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  const vertical = Math.abs(a[0] - b[0]) <= Math.abs(a[1] - b[1]);
  if (vertical) {
    return [(a[0] + b[0]) / 2 + (relationship.labelDx || 0), (a[1] + b[1]) / 2 + (relationship.labelDy || 0)];
  }
  return [(a[0] + b[0]) / 2 + (relationship.labelDx || 0), (a[1] + b[1]) / 2 - 10 + (relationship.labelDy || 0)];
}

const LEGEND_CATALOG = [
  { kind: 'core', label: 'core entity', interactive: false },
  { kind: 'reference', label: 'lookup table', interactive: false },
  { kind: 'junction', label: 'junction table', interactive: false },
  { kind: 'external', label: 'external system', interactive: false },
  { kind: 'emphasis', label: 'primary relation', className: 'a-emphasis', swatchWidth: 34, strokeWidth: 1.8, interactive: false },
  { kind: 'security', label: 'restricted join', className: 'a-security', swatchWidth: 34, interactive: false },
  { kind: 'dashed', label: 'implied relation', className: 'a-dashed', swatchWidth: 34, interactive: false },
  { kind: 'default', label: 'relation', className: 'a-default', swatchWidth: 34, interactive: false },
  { kind: 'exactly-one', label: 'exactly one', className: 'a-default', swatchWidth: 34, interactive: false },
  { kind: 'zero-or-one', label: 'zero or one', className: 'a-default', swatchWidth: 34, interactive: false },
  { kind: 'one-or-many', label: 'one or many', className: 'a-default', swatchWidth: 34, interactive: false },
  { kind: 'zero-or-many', label: 'zero or many', className: 'a-default', swatchWidth: 34, interactive: false },
];

function presentLegendKinds() {
  const kinds = new Set();
  for (const entity of asArray(erd.entities)) kinds.add(entity.kind || 'core');
  for (const relationship of asArray(erd.relationships)) {
    kinds.add(relationship.variant || 'default');
    kinds.add(relationship.fromCardinality);
    kinds.add(relationship.toCardinality);
  }
  return kinds;
}

function resolvedLegendEntries() {
  return resolveLegend(erd.meta?.legend, LEGEND_CATALOG, presentLegendKinds());
}

// Mirror the shared footprint's row wrapping (font 8, gaps 22/8, no
// interactive allowance) so validation and final placement agree.
function legendRowCount() {
  const width = viewBox[0] - 80;
  let rowCount = 1;
  let cursor = 0;
  for (const entry of resolvedLegendEntries()) {
    const entryWidth = Math.ceil((entry.swatchWidth ?? 14) + 8 + textUnits(entry.label) * 8 * 0.62);
    const required = (cursor > 0 ? 22 : 0) + entryWidth;
    if (cursor > 0 && cursor + required > width) {
      rowCount += 1;
      cursor = entryWidth;
    } else {
      cursor += required;
    }
  }
  return rowCount;
}

function validateErd() {
  const problems = [];
  if (erd.schema_version !== 1) problems.push('Entity-relationship files must set "schema_version": 1.');
  if (erd.diagram_type !== 'erd') problems.push('Entity-relationship files must set "diagram_type": "erd".');
  if (!erd.meta?.title) problems.push('Entity-relationship files must include meta.title.');
  if (!Array.isArray(erd.entities) || erd.entities.length < 2) {
    problems.push('Entity-relationship diagrams need at least two entities.');
  }
  if (!Array.isArray(erd.relationships)) problems.push('Entity-relationship diagrams must include a relationships array.');
  if (erd.cards !== undefined && !Array.isArray(erd.cards)) problems.push('Entity-relationship "cards" must be an array.');
  if (entities.size !== asArray(erd.entities).length) problems.push('Entity ids must be unique.');

  const legendRows = legendRowCount();
  const entityBottomBound = viewBox[1] - layout.legendBaselineOffset
    - (legendRows - 1) * layout.legendLineGap - layout.legendTitleBand - layout.legendEntityGap;

  for (const entity of entities.values()) {
    if (!isFinitePoint(entity.x, entity.y, entity.cx, entity.cy)) {
      problems.push(`Entity "${entity.id}" produced non-finite coordinates — check column, row, width, and yOffset are numbers.`);
      continue;
    }
    if (entity.x < 24 || entity.x + entity.width > viewBox[0] - 24) {
      problems.push(`Entity "${entity.id}" exceeds the horizontal bounds of the viewBox — reduce entity.width or increase meta.viewBox[0].`);
    }
    if (entity.y < layout.topY || entity.y + entity.height > entityBottomBound) {
      problems.push(`Entity "${entity.id}" exceeds the readable diagram area — keep the card bottom above ${Math.round(entityBottomBound)} (adjust row/yOffset or increase meta.viewBox[1]).`);
    }
    const minimumNameWidth = minimumNodeTextWidth(entity.name, layout.nameMinimum);
    if (minimumNameWidth > availableNodeTextWidth(entity.width)) {
      problems.push(`Name "${entity.name}" (~${Math.ceil(minimumNameWidth)}px) is wider than entity "${entity.id}" (${Math.round(availableNodeTextWidth(entity.width))}px available) — shorten the name or increase entity.width.`);
    }
    for (const attribute of asArray(entity.attributes)) {
      const keyUnits = attribute.key ? textUnits(attribute.key.toUpperCase()) * layout.keyFont * 0.62 + 4 : 0;
      const rowWidth = keyUnits
        + textUnits(attribute.name) * layout.attrFont * 0.62
        + layout.attrTypeGap
        + textUnits(attribute.type) * layout.typeFont * 0.62;
      if (rowWidth > entity.width - layout.attrPadX * 2) {
        problems.push(`Attribute row "${attribute.name} ${attribute.type}" (~${Math.ceil(rowWidth)}px) is wider than entity "${entity.id}" (${entity.width}px) — shorten the attribute or increase entity.width.`);
      }
    }
  }

  const entityList = asArray(erd.entities);
  for (let i = 0; i < entityList.length; i += 1) {
    for (let j = i + 1; j < entityList.length; j += 1) {
      const a = entities.get(entityList[i].id);
      const b = entities.get(entityList[j].id);
      if (rectsOverlap(a, b, 10)) {
        problems.push(`Entities "${a.id}" and "${b.id}" are less than 10px apart — move one to another column/row or adjust yOffset.`);
      }
    }
  }

  for (const relationship of asArray(erd.relationships)) {
    const from = entities.get(relationship.from);
    const to = entities.get(relationship.to);
    if (!from) problems.push(`Relationship "${relationship.label || relationship.from}" references unknown source "${relationship.from}".`);
    if (!to) problems.push(`Relationship "${relationship.label || relationship.to}" references unknown target "${relationship.to}".`);
    for (const [fieldName, entity] of [['fromField', from], ['toField', to]]) {
      if (!relationship[fieldName] || !entity) continue;
      if (fieldRowIndex(entity, relationship[fieldName]) < 0) {
        problems.push(`Relationship "${relationship.label || relationship.from}" anchors ${fieldName} "${relationship[fieldName]}" to an attribute that entity "${entity.id}" does not define.`);
      }
    }
    if (from && to) {
      const { fromSide, toSide } = relationshipSides(relationship);
      for (const [fieldName, side] of [['fromField', fromSide], ['toField', toSide]]) {
        if (relationship[fieldName] && (side === 'top' || side === 'bottom')) {
          problems.push(`Relationship "${relationship.label || relationship.from}" combines ${fieldName} with a ${side} port — attribute anchors need fromSide/toSide left or right.`);
        }
      }
      const routed = pathFor(relationship);
      const [start, end] = [routed.points[0], routed.points[routed.points.length - 1]];
      const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (distance < layout.minRelationshipLength) {
        problems.push(`Relationship "${relationship.label || relationship.from}" is too short (${Math.round(distance)}px; minimum ${layout.minRelationshipLength}px) — spread its entities or reroute.`);
      }
      if (Array.isArray(relationship.via)) {
        for (let segmentIndex = 0; segmentIndex < routed.points.length - 1; segmentIndex += 1) {
          const segmentStart = routed.points[segmentIndex];
          const segmentEnd = routed.points[segmentIndex + 1];
          const isDiagonal = Math.abs(segmentStart[0] - segmentEnd[0]) > 0.01
            && Math.abs(segmentStart[1] - segmentEnd[1]) > 0.01;
          if (!isDiagonal) continue;
          const viaIndex = Math.min(segmentIndex, relationship.via.length - 1);
          problems.push(`Relationship "${relationship.label}" has a diagonal segment from (${segmentStart.join(', ')}) to (${segmentEnd.join(', ')}) — align via[${viaIndex}] with its adjacent point by sharing the same x or y coordinate.`);
        }
      }
    }
  }

  problems.push(...cleanEndpointSideProblems({
    relations: erd.relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    fromSideFor: (relationship) => relationshipSides(relationship).fromSide,
    toSideFor: (relationship) => relationshipSides(relationship).toSide,
    routeHint: 'keep automatic routing, or choose fromSide/toSide and via points whose first and final segments cross entity borders perpendicularly'
  }));
  problems.push(...cleanFlowProblems({
    relations: erd.relationships,
    endpointIds: new Set(entities.keys()),
    obstacles: entities.values(),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    obstacleKind: 'entity',
    profile: erd.meta?.quality_profile,
    routeHint: 'adjust fromSide/toSide, set route/via, or move the entity to another column/row'
  }));
  problems.push(...cleanCrossingProblems({
    relations: erd.relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: erd.meta?.quality_profile,
    routeHint: 'adjust route/via so unrelated relationships cross at most once and clearly'
  }));
  problems.push(...cleanAmbiguousCorridorProblems({
    relations: erd.relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: erd.meta?.quality_profile,
    routeHint: 'adjust route/via so unrelated relationships do not visually merge'
  }));
  problems.push(...cleanRouteRhythmProblems({
    relations: erd.relationships,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: erd.meta?.quality_profile,
    routeHint: 'adjust route/via so each turn uses a clear corridor between entities'
  }));

  const labelRects = [];
  for (const [relationshipIndex, relationship] of asArray(erd.relationships).entries()) {
    if (!relationship.label) continue;
    if (!entities.has(relationship.from) || !entities.has(relationship.to)) continue;
    const [lx, ly] = erdLabelPoint(relationship, pathFor(relationship).points);
    const { width, height } = relationshipLabelSize(relationship);
    labelRects.push({ relation: relationship, relationIndex: relationshipIndex, label: relationship.label, x: lx - width / 2, y: ly - 11, width, height, lx, ly });
  }
  for (const rect of labelRects) {
    for (const entity of entities.values()) {
      if (rectsOverlap(rect, entity, -2)) {
        problems.push(`Label "${rect.label}" overlaps entity "${entity.id}" — adjust labelDx/labelDy/labelSegment or set labelAt.\n${suggestLabelObstacleFix(rect, rect.lx, rect.ly, entity, 'entity')}`);
      }
    }
  }
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      if (rectsOverlap(labelRects[i], labelRects[j], -2)) {
        problems.push(`Labels "${labelRects[i].label}" and "${labelRects[j].label}" overlap — adjust labelDx/labelDy.\n${suggestLabelPairFix(labelRects[i], labelRects[j])}`);
      }
    }
  }
  problems.push(...cleanLabelRouteClearanceProblems({
    relations: erd.relationships,
    labels: labelRects,
    endpointIds: new Set(entities.keys()),
    pathFor,
    diagramType: 'erd',
    relationCollection: 'relationships',
    profile: erd.meta?.quality_profile,
    routeHint: 'adjust labelAt, labelDx, labelDy, or labelSegment; otherwise adjust the other relationship route/via'
  }));

  if (problems.length) {
    throwDiagnosticProblems('Entity-relationship layout validation failed', problems, {
      subject: { diagramType: 'erd' },
    });
  }
}

// Marker geometry lives in a 20x14 box whose x=19 edge sits on the entity
// border; prongs and rings extend outward along the relationship line.
function cardinalitySymbol(cardinality, className) {
  switch (cardinality) {
    case 'exactly-one':
      return `<path d="M 19 2 V 12 M 12.5 2 V 12" class="${className}" stroke-width="1.2"/>`;
    case 'zero-or-one':
      return `<path d="M 12.5 2 V 12" class="${className}" stroke-width="1.2"/><circle cx="16.2" cy="7" r="2.7" class="${className}" stroke-width="1.2"/>`;
    case 'one-or-many':
      return `<path d="M 4.5 2 V 12" class="${className}" stroke-width="1.2"/><path d="M 19 1.5 L 8.5 7 L 19 12.5 M 19 7 L 8.5 7" class="${className}" stroke-width="1.2"/>`;
    case 'zero-or-many':
    default:
      return `<path d="M 19 1.5 L 8.5 7 L 19 12.5 M 19 7 L 8.5 7" class="${className}" stroke-width="1.2"/><circle cx="4.8" cy="7" r="2.7" class="${className}" stroke-width="1.2"/>`;
  }
}

function renderErdDefs() {
  const defs = [];
  for (const cardinality of CARDINALITIES) {
    for (const variant of VARIANTS) {
      const [className] = arrowClassMap[variant] || arrowClassMap.default;
      defs.push(`        <marker id="erd-${cardinality}-${variant}" markerWidth="20" markerHeight="14" refX="19" refY="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">${cardinalitySymbol(cardinality, className)}</marker>`);
    }
  }
  return defs.join('\n');
}

function markerId(cardinality, variant) {
  return `erd-${cardinality}-${variant || 'default'}`;
}

const KEY_BADGES = { pk: 'PK', fk: 'FK', unique: 'UQ' };

function renderEntity(entity) {
  const kind = ENTITY_KINDS[entity.kind || 'core'] || ENTITY_KINDS.core;
  const fill = componentFill[kind.componentType] || 'c-external';
  const accent = componentText[kind.componentType] || 't-muted';
  const nameFontSize = fittedNodeFontSize(entity.name, entity.width, layout.namePreferred, layout.nameMinimum);
  const rows = asArray(entity.attributes).map((attribute, index) => {
    const centerY = fieldRowCenterY(entity, index) + 2;
    const key = attribute.key
      ? `<text data-detail="fine" x="${entity.x + layout.attrPadX}" y="${centerY}" class="${accent}" font-size="${layout.keyFont}" font-weight="700">${KEY_BADGES[attribute.key] || ''}</text>`
      : '';
    const note = attribute.note ? `<title>${esc(attribute.name)}: ${esc(attribute.note)}</title>` : '';
    return `          <g data-attribute-row="${index}">${note}
            ${key}<text data-detail="fine" x="${entity.x + layout.attrPadX + layout.keyColumnW}" y="${centerY}" class="t-secondary" font-size="${layout.attrFont}">${esc(attribute.name)}</text><text data-detail="fine" x="${entity.x + entity.width - layout.attrPadX}" y="${centerY}" class="t-dim" font-size="${layout.typeFont}" text-anchor="end">${esc(attribute.type)}</text>
          </g>`;
  }).join('\n');
  const passport = {
    kind: entity.kind || 'core',
    sublabel: `${asArray(entity.attributes).length} attributes`,
    context: `${entity.kind || 'core'} entity`,
  };
  return `        <g ${focusNodeAttrs(entity.id, entity.name, passport)}>
          ${focusNodeTitle(entity.name, passport)}
          <rect x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.height}" rx="6" class="c-mask"/>
          <rect x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.height}" rx="6" class="${fill}"${animateAttr(erd.meta, 'node', entitySteps.get(entity.id))} stroke-width="1.5"/>
          <path d="M ${entity.x + 1} ${entity.y + layout.headerH} h ${entity.width - 2}" class="c-lane" stroke-width="1" fill="none"/>
          ${renderSemanticSigil(kind.sigil || kind.componentType, { x: entity.x + 5, y: entity.y + 4 })}
          <text data-node-label x="${entity.cx}" y="${entity.y + 15}" class="t-primary" font-size="${nameFontSize}" font-weight="650" text-anchor="middle">${esc(entity.name)}</text>
${rows}
        </g>`;
}

function renderRelationshipPath(relationship, index) {
  const variant = relationship.variant || 'default';
  const [cls] = arrowClassMap[variant] || arrowClassMap.default;
  const routed = pathFor(relationship);
  const strokeWidth = relationship.width || (variant === 'emphasis' ? 1.8 : 1.4);
  return `        <path ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)} data-composition-points="${routePointsValue(routed.points)}" d="${routed.d}" class="${cls}"${animateAttr(erd.meta, 'edge', index)} stroke-width="${strokeWidth}" marker-start="url(#${markerId(relationship.fromCardinality, variant)})" marker-end="url(#${markerId(relationship.toCardinality, variant)})"/>`;
}

function renderRelationshipLabel(relationship, index) {
  if (!relationship.label) return '';
  const routed = pathFor(relationship);
  const [lx, ly] = erdLabelPoint(relationship, routed.points);
  const { width: labelW, height: labelH } = relationshipLabelSize(relationship);
  return `        <g data-detail="context" ${focusEdgeAttrs(relationship.from, relationship.to, relationship.label, index, relationship.id)}>
          <rect x="${lx - labelW / 2}" y="${ly - 11}" width="${labelW}" height="${labelH}" rx="4" class="c-mask"/>
          <text x="${lx}" y="${ly}" class="${variantAccent(relationship.variant)}" font-size="8" text-anchor="middle">${esc(relationship.label)}</text>
        </g>`;
}

function renderLegend() {
  const extraHeight = (legendRowCount() - 1) * layout.legendLineGap;
  return renderResolvedLegend({
    entries: resolvedLegendEntries(),
    layout: {
      x: 40,
      baselineY: viewBox[1] - layout.legendBaselineOffset,
      width: viewBox[0] - 80,
      minTitleY: viewBox[1] - layout.legendBaselineOffset - extraHeight - layout.legendTitleBand,
      unfit: erd.meta?.legend === undefined ? 'hide' : 'error',
      diagramType: 'erd',
    },
    renderSwatch: (entry) => {
      if (ENTITY_KINDS[entry.kind]) {
        return `<rect x="${entry.x}" y="${entry.baseline - 8}" width="14" height="9" rx="2" class="${ENTITY_KINDS[entry.kind].fill}" stroke-width="1"/>`;
      }
      const marker = CARDINALITIES.includes(entry.kind) ? markerId(entry.kind, 'default') : 'arrowhead';
      return `<path d="M ${entry.x} ${entry.baseline - 3} L ${entry.x + 34} ${entry.baseline - 3}" class="${entry.className || 'a-default'}" stroke-width="${entry.strokeWidth || 1.4}" marker-end="url(#${marker})"/>`;
    },
  });
}

function renderSvg() {
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(erd.meta, 'entity-relationship diagram')}>
${svgAccessibleText(erd.meta, 'entity-relationship diagram')}
${renderDefinitions()}
${renderErdDefs()}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Relationship paths -->
${asArray(erd.relationships).map(renderRelationshipPath).join('\n')}

        <!-- Entities -->
${[...entities.values()].map(renderEntity).join('\n\n')}

        <!-- Relationship labels -->
${asArray(erd.relationships).map(renderRelationshipLabel).join('\n')}

        <!-- Legend -->
${renderLegend()}
      </svg>`;
}

validateErd();
writeDiagram({
  outPath,
  template,
  diagramType: 'erd',
  meta: erd.meta,
  svg: renderSvg(),
  cards: erd.cards,
});
