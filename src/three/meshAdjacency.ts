/**
 * Mesh adjacency builder — Phase 1 of the semi-automatic alignment plan.
 *
 * See `Document/Design/半自动对齐方案.md` for the design rationale.
 *
 * Responsibility:
 *   - Build vertex-to-vertex (1-ring) adjacency
 *   - Build vertex-to-face index (for normals / area weighting later)
 *   - Compute per-vertex normals (averaged from face normals)
 *   - Optionally weld coincident vertices into canonical indices
 *     (only for analysis — does NOT mutate the original arrays)
 *
 * Performance: O(F·3 + V) build, ~1 ms for 100k faces in V8.
 */

import type { Vec3, Face3, MeshAdjacency } from './types';

/**
 * Build the full adjacency cache for a mesh.
 *
 * @param vertices  Vertex positions, length = V
 * @param faces     Triangle indices, length = F
 * @param weldEpsilon
 *   When > 0, vertices whose Euclidean distance is below this threshold
 *   are unified into a single canonical index for adjacency / normal /
 *   region-grow purposes.  Original `vertices` and `faces` arrays are
 *   untouched.  Pass 0 to skip welding (identity mapping).
 */
export function buildMeshAdjacency(
  vertices: Vec3[],
  faces: Face3[],
  weldEpsilon = 0,
): MeshAdjacency {
  const weldedIndex = weldEpsilon > 0
    ? buildWeldedIndex(vertices, weldEpsilon)
    : identityIndex(vertices.length);

  const vertexNeighbors = new Map<number, Set<number>>();
  const vertexFaces = new Map<number, number[]>();

  for (let f = 0; f < faces.length; f++) {
    const [ra, rb, rc] = faces[f];
    const a = weldedIndex[ra];
    const b = weldedIndex[rb];
    const c = weldedIndex[rc];

    addNeighbor(vertexNeighbors, a, b);
    addNeighbor(vertexNeighbors, a, c);
    addNeighbor(vertexNeighbors, b, a);
    addNeighbor(vertexNeighbors, b, c);
    addNeighbor(vertexNeighbors, c, a);
    addNeighbor(vertexNeighbors, c, b);

    pushFace(vertexFaces, a, f);
    pushFace(vertexFaces, b, f);
    pushFace(vertexFaces, c, f);
  }

  const vertexNormals = computeVertexNormals(vertices, faces, weldedIndex);

  return { vertexNeighbors, vertexFaces, vertexNormals, weldedIndex };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function identityIndex(n: number): Int32Array {
  const arr = new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  return arr;
}

function addNeighbor(map: Map<number, Set<number>>, a: number, b: number) {
  if (a === b) return;
  let set = map.get(a);
  if (!set) {
    set = new Set();
    map.set(a, set);
  }
  set.add(b);
}

function pushFace(map: Map<number, number[]>, v: number, f: number) {
  let list = map.get(v);
  if (!list) {
    list = [];
    map.set(v, list);
  }
  list.push(f);
}

/**
 * Spatial-hash welding — group vertices into uniform-grid cells of size
 * `epsilon` and unify those within true distance ≤ epsilon.
 *
 * Output: `welded[i]` = canonical (lowest) original index of i's cluster.
 */
function buildWeldedIndex(vertices: Vec3[], epsilon: number): Int32Array {
  const n = vertices.length;
  const inv = 1 / Math.max(epsilon, 1e-9);
  const eps2 = epsilon * epsilon;

  const buckets = new Map<string, number[]>();
  const welded = new Int32Array(n);
  for (let i = 0; i < n; i++) welded[i] = i;

  for (let i = 0; i < n; i++) {
    const [x, y, z] = vertices[i];
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);

    let canonical = -1;
    // search 27 neighbouring cells
    for (let dx = -1; dx <= 1 && canonical < 0; dx++) {
      for (let dy = -1; dy <= 1 && canonical < 0; dy++) {
        for (let dz = -1; dz <= 1 && canonical < 0; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const list = buckets.get(key);
          if (!list) continue;
          for (const j of list) {
            const [vx, vy, vz] = vertices[j];
            const ddx = vx - x;
            const ddy = vy - y;
            const ddz = vz - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) {
              canonical = welded[j];
              break;
            }
          }
        }
      }
    }

    if (canonical >= 0) {
      welded[i] = canonical;
    } else {
      const key = `${cx},${cy},${cz}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(i);
    }
  }

  return welded;
}

/**
 * Per-vertex normal averaged from incident face normals.
 *
 * Normals are written for both the canonical (welded) index and every
 * original index that maps to it, so callers using either representation
 * see consistent values.
 */
function computeVertexNormals(
  vertices: Vec3[],
  faces: Face3[],
  weldedIndex: Int32Array,
): Vec3[] {
  const accum = new Float64Array(vertices.length * 3);

  for (const [ra, rb, rc] of faces) {
    const a = weldedIndex[ra];
    const b = weldedIndex[rb];
    const c = weldedIndex[rc];
    const [ax, ay, az] = vertices[a];
    const [bx, by, bz] = vertices[b];
    const [cx, cy, cz] = vertices[c];

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;

    // Cross product u × v (face normal, area-weighted)
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    accum[a * 3] += nx; accum[a * 3 + 1] += ny; accum[a * 3 + 2] += nz;
    accum[b * 3] += nx; accum[b * 3 + 1] += ny; accum[b * 3 + 2] += nz;
    accum[c * 3] += nx; accum[c * 3 + 1] += ny; accum[c * 3 + 2] += nz;
  }

  const normals: Vec3[] = new Array(vertices.length);
  // First, normalize canonical indices
  for (let i = 0; i < vertices.length; i++) {
    const canon = weldedIndex[i];
    if (canon !== i) continue; // fill in second pass
    const x = accum[canon * 3];
    const y = accum[canon * 3 + 1];
    const z = accum[canon * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    normals[canon] = [x / len, y / len, z / len];
  }
  // Propagate canonical normal to every original index that welded to it
  for (let i = 0; i < vertices.length; i++) {
    const canon = weldedIndex[i];
    if (canon !== i) normals[i] = normals[canon];
  }

  return normals;
}
